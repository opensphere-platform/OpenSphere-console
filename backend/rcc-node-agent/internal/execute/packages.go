package execute

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"opensphere.io/rcc/node-agent/internal/plan"
	"opensphere.io/rcc/node-agent/internal/snapshot"
)

// aptGetPaths is a fixed allowlist. The binary is never taken from PATH and
// never from a plan.
var aptGetPaths = []string{"/usr/bin/apt-get"}

const (
	// A metadata refresh contacts every configured mirror. Slow, but bounded.
	refreshTimeout = 5 * time.Minute
	// Installing packages on a slow disk or a slow mirror is genuinely slow.
	// The bound exists so a hung transaction eventually becomes a failed
	// operation rather than a lease that never returns.
	installTimeout = 20 * time.Minute
	// A simulation resolves the dependency graph without touching anything.
	simulateTimeout = 3 * time.Minute

	maxPackageOutputBytes = 32 * 1024

	// How long apt itself will wait for the dpkg lock before giving up. Waiting
	// is better than failing immediately — unattended-upgrades holds the lock
	// routinely — but waiting forever would burn the whole lease on it.
	aptLockWaitSeconds = 120
)

// Packages whose removal or replacement would break the cluster, the control
// path, or the operator's way back into the machine.
//
// This is the package-level counterpart of the unit denylist: a package upgrade
// that removes containerd is not less disruptive than restarting it. Matching
// is on the exact package name apt reports.
var criticalPackagePatterns = []*regexp.Regexp{
	regexp.MustCompile(`^k3s(-agent|-server)?$`),
	regexp.MustCompile(`^(kubelet|kubeadm|kubectl|kube-apiserver|kube-scheduler|kube-controller-manager)$`),
	regexp.MustCompile(`^(containerd|containerd\.io|runc|cri-o|crio|docker|docker-ce|docker\.io)$`),
	regexp.MustCompile(`^etcd(-server|-client)?$`),
	regexp.MustCompile(`^(openssh-server|openssh-client)$`),
	regexp.MustCompile(`^(systemd|systemd-sysv|init|udev|dbus)$`),
	regexp.MustCompile(`^(ceph-common|ceph-osd|ceph-mon|ceph-mgr)$`),
	regexp.MustCompile(`^(lvm2|multipath-tools|open-iscsi)$`),
	regexp.MustCompile(`^(network-manager|systemd-resolved|netplan\.io)$`),
	regexp.MustCompile(`^rcc-node-agent$`),
}

// ErrPackageNotAllowed is returned when a package is outside the host allowlist.
var ErrPackageNotAllowed = errors.New("package is not in the agent update allowlist")

// ErrManagerUnsupported is returned when the host has no apt.
var ErrManagerUnsupported = errors.New("this agent drives apt only and apt-get was not found")

// PackageExecutor holds the package-side seams. It is separate from the unit
// executor so the two allowlists cannot be confused for one another.
type PackageExecutor struct {
	Runner Runner
	// PackageAllowlist is configured per host. Empty means this agent updates
	// nothing, which is the safe default for a newly enrolled host.
	PackageAllowlist []string
	// Enabled is the host's own switch. Installing the Stage 3 binary must not
	// by itself make a host updatable.
	Enabled bool
	Now     func() time.Time
	// AptGetPath is a test seam. Production leaves it empty and the fixed
	// allowlist is used.
	AptGetPath string
	// RebootRequiredPath is where the distribution records that something
	// installed needs a restart to take effect.
	RebootRequiredPath string
}

func (e *PackageExecutor) aptGet() (string, error) {
	if e.AptGetPath != "" {
		return e.AptGetPath, nil
	}
	for _, candidate := range aptGetPaths {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", ErrManagerUnsupported
}

func (e *PackageExecutor) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *PackageExecutor) rebootRequiredPath() string {
	if e.RebootRequiredPath != "" {
		return e.RebootRequiredPath
	}
	return "/var/run/reboot-required"
}

// PackageAllowed reports whether this host will update a package.
//
// Both gates must pass, exactly as they do for unit restarts: the built-in
// critical list, which configuration cannot override, and the host's own
// allowlist, which must name the package exactly.
func (e *PackageExecutor) PackageAllowed(name string) error {
	if !e.Enabled {
		return errors.New("package operations are not enabled on this host")
	}
	for _, critical := range criticalPackagePatterns {
		if critical.MatchString(name) {
			return fmt.Errorf("package %q is critical to the cluster or the control path and is never updated by this agent", name)
		}
	}
	for _, allowed := range e.PackageAllowlist {
		if allowed == name {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrPackageNotAllowed, name)
}

// baseArgv is the fixed prefix every apt invocation shares.
//
// `-o DPkg::Lock::Timeout` makes a busy lock a wait rather than an instant
// failure. `--no-install-recommends` keeps the transaction to what was asked
// for. Nothing here is templated and nothing comes from the plan.
func baseArgv(extra ...string) []string {
	argv := []string{
		"-q",
		"-o", fmt.Sprintf("DPkg::Lock::Timeout=%d", aptLockWaitSeconds),
		"-o", "Dpkg::Options::=--force-confold",
		"-o", "Dpkg::Options::=--force-confdef",
		"--no-install-recommends",
	}
	return append(argv, extra...)
}

// Refresh updates the local package index. It installs nothing.
func (e *PackageExecutor) Refresh(ctx context.Context, args *plan.PackageRefreshArgs) (Result, map[string]string, error) {
	if args.Manager != plan.SupportedManager {
		return Result{}, nil, ErrManagerUnsupported
	}
	if !e.Enabled {
		return Result{}, nil, errors.New("package operations are not enabled on this host")
	}
	binary, err := e.aptGet()
	if err != nil {
		return Result{}, nil, err
	}

	runCtx, cancel := context.WithTimeout(ctx, refreshTimeout)
	defer cancel()
	result, err := e.Runner.Run(runCtx, append([]string{binary}, baseArgv("update")...), maxPackageOutputBytes)
	evidence := map[string]string{
		"manager":   plan.SupportedManager,
		"refreshAt": e.now().UTC().Format(time.RFC3339),
	}
	if err != nil {
		return result, evidence, err
	}
	if result.ExitCode != 0 {
		// A partial refresh leaves some mirrors stale, and a pending-update
		// count derived from it would be wrong in the direction that matters.
		return result, evidence, fmt.Errorf("apt-get update failed with exit code %d", result.ExitCode)
	}
	evidence["indexRefreshed"] = "true"
	return result, evidence, nil
}

// simulationVerdict is what a dry run told us about a proposed transaction.
type simulationVerdict struct {
	Install []string
	Upgrade []string
	Remove  []string
	// Origins records the suite apt would take each candidate from, which is
	// the only evidence on the host of whether an update is a security update.
	Origins map[string]string
	Raw     string
}

var (
	instLineRe = regexp.MustCompile(`^Inst\s+(\S+)`)
	remvLineRe = regexp.MustCompile(`^(Remv|Purg)\s+(\S+)`)
)

// parseSimulation extracts what apt says it would actually do.
func parseSimulation(output string) simulationVerdict {
	verdict := simulationVerdict{Raw: output, Origins: map[string]string{}}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if match := instLineRe.FindStringSubmatch(line); match != nil {
			verdict.Origins[match[1]] = instOrigin(line)
			// `Inst pkg [current] (...)` means an upgrade; without `[` it is a
			// package that is not currently installed.
			if strings.Contains(line, "[") && strings.Index(line, "[") < strings.Index(line+"(", "(") {
				verdict.Upgrade = append(verdict.Upgrade, match[1])
			} else {
				verdict.Install = append(verdict.Install, match[1])
			}
			continue
		}
		if match := remvLineRe.FindStringSubmatch(line); match != nil {
			verdict.Remove = append(verdict.Remove, match[2])
		}
	}
	sort.Strings(verdict.Install)
	sort.Strings(verdict.Upgrade)
	sort.Strings(verdict.Remove)
	return verdict
}

// checkTransactionSafe refuses a transaction that would do more than upgrade
// the packages that were approved.
//
// apt is allowed to pull in dependencies, and usually that is fine. What is not
// fine is a transaction that removes anything, or that touches a package the
// cluster depends on. Either would turn an approved package update into an
// outage, so both are refused before a single byte is installed.
func checkTransactionSafe(verdict simulationVerdict, approved map[string]bool) error {
	if len(verdict.Remove) > 0 {
		return fmt.Errorf("this update would remove %s; a package update never removes packages",
			strings.Join(bounded(verdict.Remove, 10), ", "))
	}
	for _, name := range append(append([]string{}, verdict.Install...), verdict.Upgrade...) {
		for _, critical := range criticalPackagePatterns {
			if critical.MatchString(name) {
				return fmt.Errorf("this update would change %q, which the cluster or the control path depends on", name)
			}
		}
	}
	// A transaction that installs packages nobody named is still bounded by the
	// dependency graph, but it is worth reporting, so the caller records it.
	_ = approved
	return nil
}

// instOrigin pulls the suite out of an `Inst` line.
//
// The line reads `Inst curl [8.5.0-2ubuntu10.5] (8.5.0-2ubuntu10.6
// Ubuntu:24.04/noble-security [amd64])`; the candidate version is the first
// word inside the parentheses and the origin is what follows it.
func instOrigin(line string) string {
	open := strings.Index(line, "(")
	closeIdx := strings.LastIndex(line, ")")
	if open == -1 || closeIdx <= open {
		return ""
	}
	fields := strings.Fields(line[open+1 : closeIdx])
	if len(fields) < 2 {
		return ""
	}
	return strings.TrimSuffix(strings.Join(fields[1:], " "), "[]")
}

// checkSecurityOnly refuses a transaction that would install anything apt does
// not offer from a security suite.
//
// Without this the flag is a label on the approval record rather than a
// constraint on the host: an approver ticking "security only" would get a
// receipt saying so while a feature update installed.
func checkSecurityOnly(verdict simulationVerdict) error {
	offenders := []string{}
	for _, name := range append(append([]string{}, verdict.Install...), verdict.Upgrade...) {
		if !snapshot.SecurityOrigin(verdict.Origins[name]) {
			offenders = append(offenders, name)
		}
	}
	if len(offenders) == 0 {
		return nil
	}
	sort.Strings(offenders)
	return fmt.Errorf(
		"this update was approved as security-only, but apt would take %s from a non-security suite",
		strings.Join(bounded(offenders, 10), ", "))
}

func bounded(values []string, max int) []string {
	if len(values) <= max {
		return values
	}
	return append(append([]string{}, values[:max]...), "…")
}

// targetArgs turns approved package targets into apt arguments.
//
// A pinned version becomes `name=version`, which is the only place a version
// ever reaches the command line, and both halves have already been validated
// against a closed grammar by the plan parser.
func targetArgs(targets []plan.PackageTarget) []string {
	argv := make([]string, 0, len(targets))
	for _, target := range targets {
		if target.Version == "" {
			argv = append(argv, target.Name)
			continue
		}
		argv = append(argv, target.Name+"="+target.Version)
	}
	return argv
}

// Update upgrades an approved, bounded set of packages.
func (e *PackageExecutor) Update(ctx context.Context, args *plan.PackageUpdateArgs) (Result, map[string]string, error) {
	if args.Manager != plan.SupportedManager {
		return Result{}, nil, ErrManagerUnsupported
	}
	binary, err := e.aptGet()
	if err != nil {
		return Result{}, nil, err
	}
	names := make([]string, 0, len(args.Packages))
	approved := make(map[string]bool, len(args.Packages))
	for _, target := range args.Packages {
		if err := e.PackageAllowed(target.Name); err != nil {
			return Result{}, nil, err
		}
		names = append(names, target.Name)
		approved[target.Name] = true
	}

	evidence := map[string]string{
		"manager":      plan.SupportedManager,
		"requested":    strings.Join(names, " "),
		"securityOnly": fmt.Sprintf("%t", args.SecurityOnly),
	}

	// `--only-upgrade` is what makes this an update rather than an install: a
	// package that is not already present is not brought onto the host.
	install := baseArgv("install", "--only-upgrade", "--")
	install = append(install, targetArgs(args.Packages)...)

	// Simulate first. This is the gate that turns "apt would remove containerd"
	// from an outage into a refusal.
	simulateCtx, cancelSimulate := context.WithTimeout(ctx, simulateTimeout)
	simulation, err := e.Runner.Run(simulateCtx,
		append([]string{binary, "-s"}, install...), maxPackageOutputBytes)
	cancelSimulate()
	if err != nil {
		return simulation, evidence, fmt.Errorf("could not simulate the update: %w", err)
	}
	if simulation.ExitCode != 0 {
		// The most common cause is a pinned version that no longer exists.
		return simulation, evidence,
			fmt.Errorf("apt refused the proposed update (exit code %d); the requested versions may no longer be available",
				simulation.ExitCode)
	}
	verdict := parseSimulation(simulation.Stdout)
	evidence["wouldUpgrade"] = strings.Join(bounded(verdict.Upgrade, 20), " ")
	evidence["wouldInstall"] = strings.Join(bounded(verdict.Install, 20), " ")
	if err := checkTransactionSafe(verdict, approved); err != nil {
		return simulation, evidence, err
	}
	if args.SecurityOnly {
		if err := checkSecurityOnly(verdict); err != nil {
			return simulation, evidence, err
		}
	}
	if len(verdict.Upgrade) == 0 && len(verdict.Install) == 0 {
		evidence["outcome"] = "already-current"
		return simulation, evidence, nil
	}

	runCtx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()
	result, err := e.Runner.Run(runCtx, append([]string{binary, "-y"}, install...), maxPackageOutputBytes)
	if err != nil {
		return result, evidence, err
	}
	if result.ExitCode != 0 {
		return result, evidence, fmt.Errorf("apt-get install failed with exit code %d", result.ExitCode)
	}
	evidence["outcome"] = "updated"
	e.recordRebootEvidence(evidence)
	return result, evidence, nil
}

// kernelTarget resolves what package a kernel update should install.
func kernelTarget(args *plan.KernelUpdateArgs) string {
	if args.TargetRelease == "" {
		// The meta-package tracks whatever the release series currently offers,
		// which is what an operator means by "update the kernel".
		return "linux-image-generic"
	}
	return plan.KernelImagePrefix + args.TargetRelease
}

// KernelUpdate installs a kernel image and stops.
//
// It never reboots. The running kernel does not change until the machine is
// restarted, and restarting it is the separately approved host.reboot
// operation, which carries the Kubernetes drain gates this one deliberately
// does not have. What this produces is evidence that a reboot is now pending.
func (e *PackageExecutor) KernelUpdate(ctx context.Context, args *plan.KernelUpdateArgs) (Result, map[string]string, error) {
	if args.Manager != plan.SupportedManager {
		return Result{}, nil, ErrManagerUnsupported
	}
	if args.RebootAfter {
		// Unreachable through a validated plan. Kept because this is the last
		// place the guarantee can be enforced.
		return Result{}, nil, errors.New("kernel.update never reboots")
	}
	if !e.Enabled {
		return Result{}, nil, errors.New("package operations are not enabled on this host")
	}
	binary, err := e.aptGet()
	if err != nil {
		return Result{}, nil, err
	}

	target := kernelTarget(args)
	evidence := map[string]string{
		"manager":       plan.SupportedManager,
		"target":        target,
		"targetRelease": args.TargetRelease,
		"rebooted":      "false",
	}

	// A kernel is installed alongside the running one, so `--only-upgrade` is
	// wrong here: the new image is a new package. It is still bounded, because
	// the name is either the meta-package or a validated release.
	install := baseArgv("install", "--")
	install = append(install, target)

	simulateCtx, cancelSimulate := context.WithTimeout(ctx, simulateTimeout)
	simulation, err := e.Runner.Run(simulateCtx,
		append([]string{binary, "-s"}, install...), maxPackageOutputBytes)
	cancelSimulate()
	if err != nil {
		return simulation, evidence, fmt.Errorf("could not simulate the kernel update: %w", err)
	}
	if simulation.ExitCode != 0 {
		return simulation, evidence,
			fmt.Errorf("apt refused the proposed kernel update (exit code %d); the requested release may not exist",
				simulation.ExitCode)
	}
	verdict := parseSimulation(simulation.Stdout)
	evidence["wouldInstall"] = strings.Join(bounded(verdict.Install, 20), " ")
	evidence["wouldUpgrade"] = strings.Join(bounded(verdict.Upgrade, 20), " ")
	if err := checkTransactionSafe(verdict, map[string]bool{target: true}); err != nil {
		return simulation, evidence, err
	}
	if len(verdict.Install) == 0 && len(verdict.Upgrade) == 0 {
		evidence["outcome"] = "already-current"
		return simulation, evidence, nil
	}

	runCtx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()
	result, err := e.Runner.Run(runCtx, append([]string{binary, "-y"}, install...), maxPackageOutputBytes)
	if err != nil {
		return result, evidence, err
	}
	if result.ExitCode != 0 {
		return result, evidence, fmt.Errorf("kernel install failed with exit code %d", result.ExitCode)
	}
	evidence["outcome"] = "installed"
	e.recordRebootEvidence(evidence)
	return result, evidence, nil
}

// recordRebootEvidence reports whether the host now needs a restart.
//
// This is the whole output of a kernel update as far as the platform is
// concerned: the new kernel is on disk, the old one is still running, and
// somebody has to decide when that changes.
func (e *PackageExecutor) recordRebootEvidence(evidence map[string]string) {
	path := e.rebootRequiredPath()
	if _, err := os.Stat(path); err != nil {
		evidence["rebootRequired"] = "false"
		return
	}
	evidence["rebootRequired"] = "true"
	evidence["rebootRequiredNote"] = "the running kernel is unchanged until host.reboot is separately requested and approved"
	if data, err := os.ReadFile(path + ".pkgs"); err == nil {
		names := []string{}
		for _, line := range strings.Split(string(data), "\n") {
			name := strings.TrimSpace(line)
			if name != "" && len(names) < 20 {
				names = append(names, name)
			}
		}
		sort.Strings(names)
		evidence["rebootRequiredPackages"] = strings.Join(names, " ")
	}
}
