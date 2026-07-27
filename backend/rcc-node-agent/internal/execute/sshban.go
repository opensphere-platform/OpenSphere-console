package execute

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"opensphere.io/rcc/node-agent/internal/plan"
	"opensphere.io/rcc/node-agent/internal/sshprotection"
)

const (
	sshBanTimeout               = 30 * time.Second
	sshProtectionInstallTimeout = 20 * time.Minute
	maxSSHBanOutput             = 16 * 1024
)

var fail2banClientPaths = []string{
	"/usr/bin/fail2ban-client",
	"/usr/local/bin/fail2ban-client",
	"/bin/fail2ban-client",
}

var dpkgQueryPaths = []string{"/usr/bin/dpkg-query", "/bin/dpkg-query"}

type fail2banServiceState struct {
	Loaded  bool
	Active  bool
	Enabled bool
}

// SSHBanExecutor is the only adapter allowed to change an SSH ban. It drives
// one fixed Fail2ban jail and one exact IP address; there is no shell or raw
// command surface.
type SSHBanExecutor struct {
	Runner             Runner
	Enabled            bool
	ProtectedAddresses []string
	Fail2banClientPath string
	AptGetPath         string
	SystemctlPath      string
	ConfigPath         string
	InstalledVersion   func(context.Context) (string, error)
	ServiceState       func(context.Context) (fail2banServiceState, error)
	Now                func() time.Time
}

func (e *SSHBanExecutor) client() (string, error) {
	if e.Fail2banClientPath != "" {
		return e.Fail2banClientPath, nil
	}
	for _, candidate := range fail2banClientPaths {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", errors.New("fail2ban-client is not installed")
}

func (e *SSHBanExecutor) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *SSHBanExecutor) aptGet() (string, error) {
	if e.AptGetPath != "" {
		return e.AptGetPath, nil
	}
	return resolveBinary(aptGetPaths)
}

func (e *SSHBanExecutor) systemctl() (string, error) {
	if e.SystemctlPath != "" {
		return e.SystemctlPath, nil
	}
	return resolveBinary(systemctlPaths)
}

func (e *SSHBanExecutor) configPath() string {
	if e.ConfigPath != "" {
		return e.ConfigPath
	}
	return sshprotection.ConfigPath
}

func (e *SSHBanExecutor) protected(address string) bool {
	for _, protected := range e.ProtectedAddresses {
		if protected == address {
			return true
		}
	}
	return false
}

// writeSSHProtectionConfig atomically writes the one RCC-owned jail drop-in.
// Callers inspect the existing file first and permit replacement only when its
// exact reviewed digest and RCC ownership header are present.
func (e *SSHBanExecutor) writeSSHProtectionConfig(content []byte, mode os.FileMode) error {
	path := e.configPath()
	if mode == 0 {
		mode = 0o644
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create Fail2ban configuration directory: %w", err)
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".rcc-sshd-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary Fail2ban profile: %w", err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(mode.Perm()); err != nil {
		temp.Close()
		return fmt.Errorf("set Fail2ban profile permissions: %w", err)
	}
	if _, err := temp.Write(content); err != nil {
		temp.Close()
		return fmt.Errorf("write Fail2ban profile: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("sync Fail2ban profile: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close Fail2ban profile: %w", err)
	}
	if err := os.Rename(tempName, path); err != nil {
		return fmt.Errorf("activate Fail2ban profile: %w", err)
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("open Fail2ban configuration directory for sync: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync Fail2ban configuration directory: %w", err)
	}
	return nil
}

func (e *SSHBanExecutor) installedPackageVersion(ctx context.Context) (string, error) {
	if e.InstalledVersion != nil {
		return e.InstalledVersion(ctx)
	}
	binary, err := resolveBinary(dpkgQueryPaths)
	if err != nil {
		return "", err
	}
	probeCtx, cancel := context.WithTimeout(ctx, sshBanTimeout)
	defer cancel()
	result, err := e.Runner.Run(
		probeCtx,
		[]string{binary, "-W", "-f=${db:Status-Abbrev}\t${Version}\n", "fail2ban"},
		2048,
	)
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 {
		return "", nil
	}
	fields := strings.Fields(result.Stdout)
	if len(fields) < 2 || !strings.HasPrefix(fields[0], "ii") {
		return "", nil
	}
	if !plan.ValidPackageVersion(fields[1]) {
		return "", errors.New("dpkg reported a malformed Fail2ban package version")
	}
	return fields[1], nil
}

func (e *SSHBanExecutor) fail2banServiceState(ctx context.Context) (fail2banServiceState, error) {
	if e.ServiceState != nil {
		return e.ServiceState(ctx)
	}
	systemctl, err := e.systemctl()
	if err != nil {
		return fail2banServiceState{}, err
	}
	probeCtx, cancel := context.WithTimeout(ctx, sshBanTimeout)
	defer cancel()
	result, err := e.Runner.Run(
		probeCtx,
		[]string{
			systemctl, "show",
			"--property=LoadState",
			"--property=ActiveState",
			"--property=UnitFileState",
			"--", "fail2ban.service",
		},
		2048,
	)
	if err != nil {
		return fail2banServiceState{}, err
	}
	if result.ExitCode != 0 {
		return fail2banServiceState{}, fmt.Errorf(
			"could not read Fail2ban service state (exit code %d)", result.ExitCode)
	}
	values := map[string]string{}
	for _, line := range strings.Split(result.Stdout, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) == 2 {
			values[parts[0]] = parts[1]
		}
	}
	if values["LoadState"] == "not-found" {
		return fail2banServiceState{}, nil
	}
	if values["LoadState"] != "loaded" {
		return fail2banServiceState{}, fmt.Errorf(
			"Fail2ban service has unsupported load state %q", values["LoadState"])
	}
	enabled := false
	switch values["UnitFileState"] {
	case "enabled":
		enabled = true
	case "disabled":
	default:
		return fail2banServiceState{}, fmt.Errorf(
			"Fail2ban service has unsupported unit-file state %q", values["UnitFileState"])
	}
	return fail2banServiceState{
		Loaded:  true,
		Active:  values["ActiveState"] == "active",
		Enabled: enabled,
	}, nil
}

func (e *SSHBanExecutor) runServiceCommand(ctx context.Context, argv ...string) (Result, error) {
	runCtx, cancel := context.WithTimeout(ctx, sshBanTimeout)
	defer cancel()
	result, err := e.Runner.Run(runCtx, argv, maxSSHBanOutput)
	if err != nil {
		return result, err
	}
	if result.ExitCode != 0 {
		return result, fmt.Errorf("%s failed with exit code %d",
			strings.Join(argv[1:], " "), result.ExitCode)
	}
	return result, nil
}

func (e *SSHBanExecutor) restoreProfile(before sshprotection.State) error {
	if before.Exists {
		return e.writeSSHProtectionConfig(before.Content, before.Mode)
	}
	if err := os.Remove(e.configPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	directory, err := os.Open(filepath.Dir(e.configPath()))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

// rollbackProtectionSetup restores the exact pre-operation profile and service
// active/enabled state. It intentionally uses a fresh bounded context: the
// operation context commonly reaches its deadline on the failure path, and a
// rollback that inherits a cancelled context is no rollback at all.
func (e *SSHBanExecutor) rollbackProtectionSetup(
	beforeProfile sshprotection.State,
	beforeService fail2banServiceState,
) string {
	rollbackCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	issues := []string{}
	if err := e.restoreProfile(beforeProfile); err != nil {
		issues = append(issues, "profile: "+err.Error())
	}
	systemctl, err := e.systemctl()
	if err != nil {
		issues = append(issues, "systemctl: "+err.Error())
	} else {
		current, stateErr := e.fail2banServiceState(rollbackCtx)
		if stateErr != nil {
			issues = append(issues, "service state: "+stateErr.Error())
		} else {
			switch {
			case beforeService.Active && !current.Active:
				if _, err := e.runServiceCommand(
					rollbackCtx, systemctl, "start", "fail2ban.service"); err != nil {
					issues = append(issues, "restart previous service: "+err.Error())
				}
			case !beforeService.Active && current.Active:
				if _, err := e.runServiceCommand(
					rollbackCtx, systemctl, "stop", "fail2ban.service"); err != nil {
					issues = append(issues, "stop activated service: "+err.Error())
				}
			case beforeService.Active && current.Active:
				if client, clientErr := e.client(); clientErr == nil {
					if _, err := e.runServiceCommand(
						rollbackCtx, client, "reload"); err != nil {
						issues = append(issues, "reload previous profile: "+err.Error())
					}
				} else {
					issues = append(issues, "reload previous profile: "+clientErr.Error())
				}
			}
			if beforeService.Enabled != current.Enabled {
				action := "disable"
				if beforeService.Enabled {
					action = "enable"
				}
				if _, err := e.runServiceCommand(
					rollbackCtx, systemctl, action, "fail2ban.service"); err != nil {
					issues = append(issues, "restore enablement: "+err.Error())
				}
			}
		}
	}
	if len(issues) > 0 {
		return "incomplete: " + strings.Join(issues, "; ")
	}
	return "restored"
}

// EnableProtection installs the pinned distribution package when needed,
// creates or reconciles one fixed RCC-owned profile, activates the service and
// proves that the sshd jail is readable. External policy is never overwritten.
func (e *SSHBanExecutor) EnableProtection(
	ctx context.Context,
	args *plan.SSHProtectionArgs,
) (Result, map[string]string, error) {
	evidence := map[string]string{
		"provider": "fail2ban",
		"jail":     "sshd",
		"profile":  plan.SSHProtectionProfile,
	}
	if args == nil {
		return Result{}, evidence, errors.New("SSH protection arguments are required")
	}
	if !e.Enabled {
		return Result{}, evidence, errors.New("SSH protection operations are not enabled on this host")
	}
	if e.Runner == nil {
		return Result{}, evidence, errors.New("SSH protection command runner is not configured")
	}
	if args.Provider != "fail2ban" || args.Jail != "sshd" ||
		args.Profile != plan.SSHProtectionProfile {
		return Result{}, evidence, errors.New("the request is not the fixed Fail2ban sshd baseline")
	}
	if !plan.ValidPackageVersion(args.PackageVersion) {
		return Result{}, evidence, errors.New("the reviewed Fail2ban package version is malformed")
	}
	configured, err := sshprotection.CanonicalAddresses(e.ProtectedAddresses)
	if err != nil || len(configured) == 0 {
		return Result{}, evidence, errors.New("the host has no valid protected management addresses")
	}
	reviewed, err := sshprotection.CanonicalAddresses(args.ProtectedAddresses)
	if err != nil || strings.Join(configured, "\n") != strings.Join(reviewed, "\n") {
		return Result{}, evidence, errors.New("protected management addresses changed after review")
	}
	evidence["protectedAddressCount"] = fmt.Sprintf("%d", len(configured))
	evidence["packageVersion"] = args.PackageVersion

	installedVersion, err := e.installedPackageVersion(ctx)
	if err != nil {
		return Result{}, evidence, err
	}
	installedNow := installedVersion != ""
	if installedNow != args.ExpectedInstalled {
		return Result{}, evidence, errors.New("Fail2ban installation state changed after review")
	}
	if installedNow && installedVersion != args.PackageVersion {
		return Result{}, evidence, errors.New("the installed Fail2ban version changed after review")
	}
	serviceBefore, err := e.fail2banServiceState(ctx)
	if err != nil {
		return Result{}, evidence, err
	}
	if installedNow && !serviceBefore.Loaded {
		return Result{}, evidence, errors.New("Fail2ban is installed but its fixed systemd service is unavailable")
	}
	profileBefore, err := sshprotection.Inspect(e.configPath(), configured)
	if err != nil {
		return Result{}, evidence, err
	}
	if profileBefore.Kind == sshprotection.External {
		return Result{}, evidence, errors.New(
			"the fixed RCC Fail2ban profile path contains external policy and will not be overwritten")
	}
	if profileBefore.Digest != args.ExpectedProfileDigest {
		return Result{}, evidence, errors.New("the RCC Fail2ban profile changed after review")
	}

	if installedNow {
		client, clientErr := e.client()
		if clientErr != nil {
			return Result{}, evidence, clientErr
		}
		_, _, statusErr := e.status(ctx, client)
		if (statusErr == nil) != args.ExpectedActive {
			return Result{}, evidence, errors.New("the Fail2ban sshd jail activation state changed after review")
		}
	}

	installedByOperation := false
	if !installedNow {
		aptGet, err := e.aptGet()
		if err != nil {
			return Result{}, evidence, err
		}
		target := "fail2ban=" + args.PackageVersion
		installArgs := baseArgv("install", "--", target)
		simulateCtx, cancel := context.WithTimeout(ctx, simulateTimeout)
		simulation, runErr := e.Runner.Run(
			simulateCtx,
			append([]string{aptGet, "-s"}, installArgs...),
			maxPackageOutputBytes,
		)
		cancel()
		if runErr != nil {
			return simulation, evidence, fmt.Errorf("could not simulate Fail2ban installation: %w", runErr)
		}
		if simulation.ExitCode != 0 {
			return simulation, evidence, fmt.Errorf(
				"apt refused the pinned Fail2ban installation (exit code %d)", simulation.ExitCode)
		}
		verdict := parseSimulation(simulation.Stdout)
		if err := checkTransactionSafe(verdict, map[string]bool{"fail2ban": true}); err != nil {
			return simulation, evidence, err
		}
		changes := append(append([]string{}, verdict.Install...), verdict.Upgrade...)
		if len(changes) == 0 || !containsString(changes, "fail2ban") {
			return simulation, evidence, errors.New("the apt simulation did not include the reviewed Fail2ban package")
		}
		if len(changes) > 32 {
			return simulation, evidence, errors.New("the Fail2ban transaction exceeds the 32-package review bound")
		}
		evidence["wouldChange"] = strings.Join(bounded(changes, 32), " ")

		installCtx, cancelInstall := context.WithTimeout(ctx, sshProtectionInstallTimeout)
		result, runErr := e.Runner.Run(
			installCtx,
			append([]string{aptGet, "-y"}, installArgs...),
			maxPackageOutputBytes,
		)
		cancelInstall()
		if runErr != nil {
			return result, evidence, runErr
		}
		if result.ExitCode != 0 {
			return result, evidence, fmt.Errorf(
				"Fail2ban package installation failed with exit code %d", result.ExitCode)
		}
		installedByOperation = true
		actualVersion, versionErr := e.installedPackageVersion(ctx)
		if versionErr != nil || actualVersion != args.PackageVersion {
			evidence["rollback"] = e.rollbackProtectionSetup(profileBefore, serviceBefore)
			if versionErr != nil {
				return result, evidence, fmt.Errorf(
					"could not verify installed Fail2ban version: %w", versionErr)
			}
			return result, evidence, errors.New(
				"apt did not install the exact reviewed Fail2ban version")
		}
	}

	content := sshprotection.Config(configured)
	evidence["profileDigest"] = sshprotection.Digest(content)
	profileChanged := profileBefore.Digest != evidence["profileDigest"]
	if profileChanged {
		if err := e.writeSSHProtectionConfig(content, 0o644); err != nil {
			evidence["rollback"] = e.rollbackProtectionSetup(profileBefore, serviceBefore)
			return Result{}, evidence, err
		}
	}
	fail := func(result Result, cause error) (Result, map[string]string, error) {
		evidence["rollback"] = e.rollbackProtectionSetup(profileBefore, serviceBefore)
		return result, evidence, cause
	}
	client, err := e.client()
	if err != nil {
		return fail(Result{}, err)
	}
	testCtx, cancelTest := context.WithTimeout(ctx, sshBanTimeout)
	testResult, err := e.Runner.Run(testCtx, []string{client, "-t"}, maxSSHBanOutput)
	cancelTest()
	if err != nil {
		return fail(testResult, fmt.Errorf("Fail2ban configuration validation failed: %w", err))
	}
	if testResult.ExitCode != 0 {
		return fail(testResult, fmt.Errorf(
			"Fail2ban configuration validation failed with exit code %d", testResult.ExitCode))
	}
	systemctl, err := e.systemctl()
	if err != nil {
		return fail(Result{}, err)
	}
	currentService, err := e.fail2banServiceState(ctx)
	if err != nil {
		return fail(Result{}, err)
	}
	if !currentService.Enabled {
		if result, commandErr := e.runServiceCommand(
			ctx, systemctl, "enable", "fail2ban.service"); commandErr != nil {
			return fail(result, commandErr)
		}
	}
	var activation Result
	if currentService.Active {
		activation, err = e.runServiceCommand(ctx, client, "reload")
	} else {
		activation, err = e.runServiceCommand(ctx, systemctl, "start", "fail2ban.service")
	}
	if err != nil {
		return fail(activation, err)
	}
	statusResult, _, err := e.status(ctx, client)
	if err != nil {
		return fail(statusResult, errors.New(
			"Fail2ban was activated but the sshd jail could not be verified: "+err.Error()))
	}
	evidence["verifiedAt"] = e.now().UTC().Format(time.RFC3339)
	evidence["installedByOperation"] = fmt.Sprintf("%t", installedByOperation)
	evidence["profileChanged"] = fmt.Sprintf("%t", profileChanged)
	evidence["active"] = "true"
	return statusResult, evidence, nil
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func (e *SSHBanExecutor) status(ctx context.Context, binary string) (Result, map[string]bool, error) {
	runCtx, cancel := context.WithTimeout(ctx, sshBanTimeout)
	defer cancel()
	result, err := e.Runner.Run(runCtx, []string{binary, "status", "sshd"}, maxSSHBanOutput)
	if err != nil {
		return result, nil, err
	}
	if result.ExitCode != 0 {
		return result, nil, fmt.Errorf("fail2ban sshd status failed with exit code %d", result.ExitCode)
	}
	if result.Truncated {
		return result, nil, errors.New("fail2ban sshd status exceeded the verification bound")
	}
	banned := map[string]bool{}
	seenJail := false
	seenBannedList := false
	for _, line := range strings.Split(result.Stdout, "\n") {
		if strings.Contains(line, "Status for the jail:") {
			parts := strings.SplitN(line, ":", 2)
			seenJail = len(parts) == 2 && strings.TrimSpace(parts[1]) == "sshd"
		}
		if !strings.Contains(line, "Banned IP list:") {
			continue
		}
		seenBannedList = true
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		for _, raw := range strings.Fields(parts[1]) {
			ip := net.ParseIP(raw)
			if ip == nil {
				return result, nil, fmt.Errorf("fail2ban returned malformed banned address %q", raw)
			}
			banned[ip.String()] = true
		}
	}
	if !seenJail || !seenBannedList {
		return result, nil, errors.New("fail2ban returned an unrecognised sshd jail status")
	}
	return result, banned, nil
}

// Apply re-checks the live state, performs one fixed action, then proves the
// resulting state. A stale administrator view is refused without mutation.
func (e *SSHBanExecutor) Apply(ctx context.Context, operation string, args *plan.SSHBanArgs) (Result, map[string]string, error) {
	if args == nil {
		return Result{}, nil, errors.New("SSH ban arguments are required")
	}
	evidence := map[string]string{
		"provider": "fail2ban",
		"jail":     "sshd",
		"address":  args.Address,
	}
	if !e.Enabled {
		return Result{}, evidence, errors.New("SSH ban operations are not enabled on this host")
	}
	if e.Runner == nil {
		return Result{}, evidence, errors.New("SSH ban command runner is not configured")
	}
	if args.Jail != "sshd" {
		return Result{}, evidence, errors.New("SSH ban operations are restricted to the sshd jail")
	}
	if operation == plan.OpSSHBan && args.ExpectedBanned {
		return Result{}, evidence, errors.New("SSH ban review state must show the address as not banned")
	}
	if operation == plan.OpSSHUnban && !args.ExpectedBanned {
		return Result{}, evidence, errors.New("SSH unban review state must show the address as banned")
	}
	ip := net.ParseIP(args.Address)
	if ip == nil || ip.String() != args.Address {
		return Result{}, evidence, errors.New("SSH ban target must be one canonical exact IP address")
	}
	if operation == plan.OpSSHBan && e.protected(args.Address) {
		return Result{}, evidence, errors.New("the address is protected by this host and cannot be banned")
	}
	if operation == plan.OpSSHBan && (ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()) {
		return Result{}, evidence, errors.New("unspecified, loopback, multicast and link-local addresses cannot be banned")
	}

	binary, err := e.client()
	if err != nil {
		return Result{}, evidence, err
	}
	beforeResult, before, err := e.status(ctx, binary)
	if err != nil {
		return beforeResult, evidence, err
	}
	wasBanned := before[args.Address]
	evidence["beforeBanned"] = fmt.Sprintf("%t", wasBanned)
	if wasBanned != args.ExpectedBanned {
		return beforeResult, evidence, errors.New("the live ban state changed after review; refresh and submit again")
	}

	action := ""
	wantBanned := false
	switch operation {
	case plan.OpSSHBan:
		action, wantBanned = "banip", true
	case plan.OpSSHUnban:
		action, wantBanned = "unbanip", false
	default:
		return Result{}, evidence, fmt.Errorf("unsupported SSH ban operation %q", operation)
	}

	runCtx, cancel := context.WithTimeout(ctx, sshBanTimeout)
	defer cancel()
	result, err := e.Runner.Run(runCtx,
		[]string{binary, "set", "sshd", action, args.Address}, maxSSHBanOutput)
	if err != nil {
		return result, evidence, err
	}
	if result.ExitCode != 0 {
		return result, evidence, fmt.Errorf("fail2ban %s failed with exit code %d", action, result.ExitCode)
	}

	afterResult, after, err := e.status(ctx, binary)
	if err != nil {
		return afterResult, evidence, errors.New("the action returned success but its resulting state could not be verified: " + err.Error())
	}
	isBanned := after[args.Address]
	evidence["afterBanned"] = fmt.Sprintf("%t", isBanned)
	evidence["verifiedAt"] = e.now().UTC().Format(time.RFC3339)
	if isBanned != wantBanned {
		return afterResult, evidence, errors.New("fail2ban did not reach the requested verified state")
	}
	addresses := make([]string, 0, len(after))
	for address := range after {
		addresses = append(addresses, address)
	}
	sort.Strings(addresses)
	evidence["currentBanCount"] = fmt.Sprintf("%d", len(addresses))
	result.Stdout, result.Truncated = Sanitize(result.Stdout, maxSSHBanOutput)
	return result, evidence, nil
}
