package execute

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"opensphere.io/rcc/node-agent/internal/plan"
)

// nmcliPaths is a fixed allowlist. The binary is never taken from PATH and
// never from a plan.
var nmcliPaths = []string{"/usr/bin/nmcli", "/bin/nmcli"}

const (
	nmcliReadTimeout   = 20 * time.Second
	nmcliModifyTimeout = 60 * time.Second
	// Bringing a connection up can involve DHCP, so it gets its own budget.
	nmcliActivateTimeout = 120 * time.Second
	maxNetworkOutput     = 16 * 1024
	// How often the agent re-tests the control path while the rollback timer
	// runs. Frequent enough that a working change is confirmed quickly, spaced
	// enough that a broken one is not hammered.
	confirmInterval = 5 * time.Second
)

var (
	// ErrNetworkNotEnabled is returned when the host was never given network
	// authority.
	ErrNetworkNotEnabled = errors.New("network operations are not enabled on this host")
	// ErrConnectionNotAllowed is returned when a profile is outside the host
	// allowlist.
	ErrConnectionNotAllowed = errors.New("connection is not in the agent network allowlist")
	// ErrNetworkManagerUnsupported is returned when the host has no nmcli.
	ErrNetworkManagerUnsupported = errors.New("this agent drives NetworkManager only and nmcli was not found")
)

// NetworkExecutor applies one reviewed change to one NetworkManager profile.
//
// The shape of the operation is: prove the host is in the state that was
// reviewed, write down how to undo the change, make it, prove the control
// center is still reachable, and put everything back if it is not. Every step
// is a fixed argv; there is no string anywhere in this file that becomes a
// command line.
type NetworkExecutor struct {
	Runner Runner
	// Enabled is the host's own switch. Installing a build that can reconfigure
	// a network must not by itself make a host reconfigurable.
	Enabled bool
	// Allowlist names the connection profiles this host permits. Empty means
	// this agent reconfigures nothing, which is the safe default.
	Allowlist []string
	// Confirm proves the control path still works. Returning nil is the only
	// thing that stops the rollback, so a probe that cannot fail would defeat
	// the entire operation; the production wiring reaches the control center.
	Confirm func(ctx context.Context) error
	Now     func() time.Time
	// ProcRoot is a test seam for reading the live routing table.
	ProcRoot string
	// NmcliPath is a test seam. Production leaves it empty.
	NmcliPath string
	// ConfirmInterval is how long to wait between reachability attempts.
	// Production leaves it zero and the declared interval is used.
	ConfirmInterval time.Duration
}

func (e *NetworkExecutor) confirmInterval() time.Duration {
	if e.ConfirmInterval > 0 {
		return e.ConfirmInterval
	}
	return confirmInterval
}

func (e *NetworkExecutor) nmcli() (string, error) {
	if e.NmcliPath != "" {
		return e.NmcliPath, nil
	}
	for _, candidate := range nmcliPaths {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", ErrNetworkManagerUnsupported
}

func (e *NetworkExecutor) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *NetworkExecutor) procRoot() string {
	if e.ProcRoot != "" {
		return e.ProcRoot
	}
	return "/proc"
}

// ConnectionAllowed reports whether this host will reconfigure a profile.
func (e *NetworkExecutor) ConnectionAllowed(name string) error {
	if !e.Enabled {
		return ErrNetworkNotEnabled
	}
	for _, allowed := range e.Allowlist {
		if allowed == name {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrConnectionNotAllowed, name)
}

// liveSettings is the subset of a profile this agent reads and writes.
type liveSettings struct {
	Interface string
	Type      string
	Method    string
	Addresses []string
	Gateway   string
	DNS       []string
	Search    []string
	MTU       int
}

// readSettingsArgv is compile-time fixed. No wireless, VPN or 802.1X setting is
// ever requested, so no secret can be returned in the first place.
var readSettingsFields = "connection.interface-name,connection.type,ipv4.method,ipv4.addresses," +
	"ipv4.gateway,ipv4.dns,ipv4.dns-search,802-3-ethernet.mtu"

// readSettings reads the current profile.
func (e *NetworkExecutor) readSettings(ctx context.Context, binary, connection string) (liveSettings, error) {
	runCtx, cancel := context.WithTimeout(ctx, nmcliReadTimeout)
	defer cancel()
	result, err := e.Runner.Run(runCtx, []string{
		binary, "-t", "-f", readSettingsFields, "connection", "show", "--", connection,
	}, maxNetworkOutput)
	if err != nil {
		return liveSettings{}, fmt.Errorf("could not read connection %q: %w", connection, err)
	}
	if result.ExitCode != 0 {
		return liveSettings{}, fmt.Errorf("NetworkManager does not know a connection named %q", connection)
	}
	return parseSettings(result.Stdout), nil
}

// parseSettings turns nmcli's terse key:value output into typed settings.
func parseSettings(output string) liveSettings {
	settings := liveSettings{Addresses: []string{}, DNS: []string{}, Search: []string{}}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimRight(strings.TrimSpace(line), "\r")
		if line == "" {
			continue
		}
		// Split on the first colon only: a value may legitimately contain one.
		idx := strings.Index(line, ":")
		if idx <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		value := strings.TrimSpace(unescapeTerse(line[idx+1:]))
		if value == "--" {
			value = ""
		}
		switch key {
		case "connection.interface-name":
			settings.Interface = value
		case "connection.type":
			settings.Type = value
		case "ipv4.method":
			settings.Method = value
		case "ipv4.addresses":
			settings.Addresses = splitList(value)
		case "ipv4.gateway":
			settings.Gateway = value
		case "ipv4.dns":
			settings.DNS = splitList(value)
		case "ipv4.dns-search":
			settings.Search = splitList(value)
		case "802-3-ethernet.mtu":
			if n, err := strconv.Atoi(value); err == nil {
				settings.MTU = n
			}
		}
	}
	return settings
}

func unescapeTerse(value string) string {
	return strings.ReplaceAll(value, `\:`, ":")
}

func splitList(value string) []string {
	out := []string{}
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// defaultRouteInterface reads the live routing table.
//
// This is deliberately read from /proc rather than from a snapshot: the
// snapshot describes the host as it was when it last reported, and the question
// being asked here is "is this the interface my control center is reached
// through *right now*".
func defaultRouteInterface(procRoot string) string {
	data, err := os.ReadFile(procRoot + "/net/route")
	if err != nil {
		return ""
	}
	if len(data) > 256*1024 {
		data = data[:256*1024]
	}
	best := ""
	bestMetric := int64(1<<62 - 1)
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 8 || fields[0] == "Iface" {
			continue
		}
		// A default route is the one whose destination is 0.0.0.0.
		if !isZeroHex(fields[1]) {
			continue
		}
		metric, err := strconv.ParseInt(fields[6], 10, 64)
		if err != nil {
			metric = 0
		}
		if metric < bestMetric {
			bestMetric = metric
			best = fields[0]
		}
	}
	return best
}

func isZeroHex(value string) bool {
	raw, err := hex.DecodeString(value)
	if err != nil {
		return false
	}
	for _, b := range raw {
		if b != 0 {
			return false
		}
	}
	return len(raw) > 0
}

// modifyArgv builds the settings assignment for one profile.
//
// Every value has already been validated against a closed grammar by the plan
// parser, and every one is passed as its own argv element after `--`, so
// nothing can be read as an additional flag or as a second command.
func modifyArgv(binary, connection string, settings liveSettings, withMTU bool) []string {
	argv := []string{binary, "connection", "modify", "--", connection,
		"ipv4.method", settings.Method,
		"ipv4.addresses", strings.Join(settings.Addresses, ","),
		"ipv4.gateway", settings.Gateway,
		"ipv4.dns", strings.Join(settings.DNS, ","),
		"ipv4.dns-search", strings.Join(settings.Search, ","),
	}
	if withMTU {
		argv = append(argv, "802-3-ethernet.mtu", strconv.Itoa(settings.MTU))
	}
	return argv
}

// PreparedChange is what preflight established, and everything Apply needs.
//
// It is returned separately from Apply so the caller can make the rollback
// record durable *before* the change happens. An agent killed between applying
// and confirming would otherwise leave a host on settings nobody proved work,
// with nothing on disk saying what they used to be.
type PreparedChange struct {
	Binary   string
	Before   liveSettings
	After    liveSettings
	WithMTU  bool
	Deadline time.Time
	// Rollback is the durable undo record. It is written to the operation state
	// store by the caller and read back by RestoreFromEvidence after a crash.
	Rollback map[string]string
	Evidence map[string]string
}

// Preflight proves the host is in the state that was reviewed, and works out
// how to undo the change. It writes nothing and changes nothing.
func (e *NetworkExecutor) Preflight(ctx context.Context, args *plan.NetworkConfigureArgs) (*PreparedChange, map[string]string, error) {
	evidence := map[string]string{
		"adapter":       plan.SupportedNetworkAdapter,
		"connection":    args.Connection,
		"interface":     args.Interface,
		"rollbackArmed": "false",
		"rollbackState": "none",
	}
	if err := e.ConnectionAllowed(args.Connection); err != nil {
		return nil, evidence, err
	}
	if e.Confirm == nil {
		// Without a way to prove the host is still reachable there is no way to
		// decide whether to keep the change. Refusing is the only safe answer.
		return nil, evidence,
			errors.New("no connectivity confirmation is configured; a network change that cannot be verified is not made")
	}
	binary, err := e.nmcli()
	if err != nil {
		return nil, evidence, err
	}

	// The management interface is decided from the live routing table, not from
	// the plan. A plan that claimed a different one would be refused here.
	management := defaultRouteInterface(e.procRoot())
	evidence["defaultRouteInterface"] = management
	if management != "" && management == args.Interface {
		return nil, evidence, fmt.Errorf(
			"%s carries the default route to this control center and is never reconfigured by this platform",
			args.Interface)
	}
	if args.PreState != nil && args.PreState.DefaultRouteInterface != "" &&
		management != "" && args.PreState.DefaultRouteInterface != management {
		// The route moved between review and execution. Whether the new layout
		// would also have been safe is beside the point: nobody looked at it.
		return nil, evidence, fmt.Errorf(
			"the default route has moved from %s to %s since this was reviewed; request it again",
			args.PreState.DefaultRouteInterface, management)
	}

	before, err := e.readSettings(ctx, binary, args.Connection)
	if err != nil {
		return nil, evidence, err
	}
	if before.Interface != "" && before.Interface != args.Interface {
		return nil, evidence, fmt.Errorf(
			"connection %q is bound to %s, not %s", args.Connection, before.Interface, args.Interface)
	}
	if err := matchesPreState(before, args.PreState); err != nil {
		return nil, evidence, err
	}
	withMTU := args.MTU != 0
	if withMTU && before.Type != "802-3-ethernet" {
		return nil, evidence, fmt.Errorf(
			"connection %q is a %s profile; this agent sets an MTU on wired profiles only",
			args.Connection, before.Type)
	}
	evidence["before"] = describeSettings(before)

	after := liveSettings{
		Method:    args.Method,
		Addresses: append([]string{}, args.Addresses...),
		Gateway:   args.Gateway,
		DNS:       append([]string{}, args.DNS...),
		Search:    append([]string{}, args.SearchDomains...),
		MTU:       args.MTU,
	}
	evidence["after"] = describeSettings(after)

	deadline := e.now().Add(time.Duration(args.RollbackSeconds) * time.Second)
	evidence["rollbackArmed"] = "true"
	evidence["rollbackState"] = "armed"
	evidence["rollbackDeadline"] = deadline.UTC().Format(time.RFC3339)
	rollback := rollbackEvidence(args.Connection, before, withMTU)
	for key, value := range rollback {
		evidence[key] = value
	}

	return &PreparedChange{
		Binary:   binary,
		Before:   before,
		After:    after,
		WithMTU:  withMTU,
		Deadline: deadline,
		Rollback: rollback,
		Evidence: evidence,
	}, evidence, nil
}

// Apply makes the change, proves the control center is still reachable, and
// puts everything back if it is not.
func (e *NetworkExecutor) Apply(ctx context.Context, prepared *PreparedChange, args *plan.NetworkConfigureArgs) (Result, map[string]string, error) {
	if prepared == nil {
		return Result{ExitCode: -1}, map[string]string{}, errors.New("no preflight result; the change was not made")
	}
	evidence := prepared.Evidence
	binary := prepared.Binary
	before := prepared.Before
	after := prepared.After
	withMTU := prepared.WithMTU
	deadline := prepared.Deadline

	modifyCtx, cancelModify := context.WithTimeout(ctx, nmcliModifyTimeout)
	result, err := e.Runner.Run(modifyCtx, modifyArgv(binary, args.Connection, after, withMTU), maxNetworkOutput)
	cancelModify()
	if err != nil || result.ExitCode != 0 {
		// Nothing was activated, so there is nothing to undo; the stored profile
		// may have been half-written, so it is restored anyway.
		restoreErr := e.restore(ctx, binary, args.Connection, before, withMTU)
		evidence["rollbackState"] = rollbackOutcome(restoreErr)
		if err == nil {
			err = fmt.Errorf("nmcli refused the change (exit code %d)", result.ExitCode)
		}
		return result, evidence, err
	}

	activateCtx, cancelActivate := context.WithTimeout(ctx, nmcliActivateTimeout)
	activation, activateErr := e.Runner.Run(activateCtx,
		[]string{binary, "connection", "up", "--", args.Connection}, maxNetworkOutput)
	cancelActivate()
	result.Stdout = joinOutput(result.Stdout, activation.Stdout)
	if activateErr != nil || activation.ExitCode != 0 {
		restoreErr := e.restore(ctx, binary, args.Connection, before, withMTU)
		evidence["rollbackState"] = rollbackOutcome(restoreErr)
		if activateErr == nil {
			activateErr = fmt.Errorf("the connection would not come up (exit code %d)", activation.ExitCode)
		}
		return result, evidence, activateErr
	}

	// Positive confirmation. Nothing about a successful nmcli invocation proves
	// the host can still be reached; only reaching the control center does.
	confirmErr := e.confirmUntil(ctx, deadline)
	if confirmErr != nil {
		restoreErr := e.restore(ctx, binary, args.Connection, before, withMTU)
		evidence["rollbackState"] = rollbackOutcome(restoreErr)
		evidence["confirmationError"] = boundEvidence(confirmErr.Error())
		return result, evidence, fmt.Errorf(
			"the control center was not reachable after the change, so it was rolled back: %w", confirmErr)
	}
	evidence["rollbackState"] = "confirmed"
	evidence["confirmedAt"] = e.now().UTC().Format(time.RFC3339)
	return result, evidence, nil
}

// confirmUntil re-tests the control path until it works or the deadline passes.
//
// The attempt count is bounded as well as the deadline. A clock that does not
// advance — a frozen test clock, or a host whose time source has stopped —
// would otherwise leave this retrying forever, and a rollback that never fires
// is the one failure mode this whole mechanism exists to prevent.
func (e *NetworkExecutor) confirmUntil(ctx context.Context, deadline time.Time) error {
	interval := e.confirmInterval()
	// Enough attempts to fill the longest window a plan may ask for, and no
	// more. Below a one-second interval the count is fixed, because that only
	// happens under test.
	maxAttempts := 8
	if interval >= time.Second {
		maxAttempts = int(plan.MaxRollbackSeconds*int(time.Second)/int(interval)) + 2
	}

	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, interval)
		lastErr = e.Confirm(attemptCtx)
		cancel()
		if lastErr == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !e.now().Before(deadline) {
			return lastErr
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
	if lastErr == nil {
		lastErr = errors.New("the rollback deadline passed without a successful check")
	}
	return lastErr
}

// restore puts the previous settings back and reactivates the profile.
func (e *NetworkExecutor) restore(ctx context.Context, binary, connection string, before liveSettings, withMTU bool) error {
	// A fresh context: the operation's own context may already be cancelled,
	// and a rollback that is skipped because the caller gave up is the worst
	// possible outcome of a network change.
	restoreCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), nmcliModifyTimeout+nmcliActivateTimeout)
	defer cancel()

	result, err := e.Runner.Run(restoreCtx, modifyArgv(binary, connection, before, withMTU), maxNetworkOutput)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("restoring the previous settings failed (exit code %d)", result.ExitCode)
	}
	activation, err := e.Runner.Run(restoreCtx,
		[]string{binary, "connection", "up", "--", connection}, maxNetworkOutput)
	if err != nil {
		return err
	}
	if activation.ExitCode != 0 {
		return fmt.Errorf("the previous settings were restored but the connection would not come back up (exit code %d)",
			activation.ExitCode)
	}
	return nil
}

// RestoreFromEvidence undoes a change after the agent was interrupted.
//
// This is what makes the rollback survive the process that armed it. The record
// is written durably before the change is made, so an agent that is killed
// between applying and confirming puts the network back on its next start
// rather than leaving a host on settings nobody ever confirmed.
func (e *NetworkExecutor) RestoreFromEvidence(ctx context.Context, evidence map[string]string) (string, error) {
	connection := evidence["rollbackConnection"]
	if connection == "" {
		return "", errors.New("no rollback record was written, so nothing can be restored")
	}
	if err := e.ConnectionAllowed(connection); err != nil {
		return "", err
	}
	binary, err := e.nmcli()
	if err != nil {
		return "", err
	}
	before := liveSettings{
		Method:    evidence["rollbackMethod"],
		Addresses: splitList(evidence["rollbackAddresses"]),
		Gateway:   evidence["rollbackGateway"],
		DNS:       splitList(evidence["rollbackDns"]),
		Search:    splitList(evidence["rollbackSearch"]),
	}
	withMTU := evidence["rollbackMtu"] != ""
	if withMTU {
		before.MTU, _ = strconv.Atoi(evidence["rollbackMtu"])
	}
	if err := e.restore(ctx, binary, connection, before, withMTU); err != nil {
		return "", err
	}
	return "the previous network settings were restored after an interrupted change", nil
}

// rollbackEvidence records exactly what is needed to undo the change.
func rollbackEvidence(connection string, before liveSettings, withMTU bool) map[string]string {
	record := map[string]string{
		"rollbackConnection": connection,
		"rollbackMethod":     before.Method,
		"rollbackAddresses":  strings.Join(before.Addresses, ","),
		"rollbackGateway":    before.Gateway,
		"rollbackDns":        strings.Join(before.DNS, ","),
		"rollbackSearch":     strings.Join(before.Search, ","),
	}
	if withMTU {
		record["rollbackMtu"] = strconv.Itoa(before.MTU)
	}
	return record
}

func rollbackOutcome(err error) string {
	if err == nil {
		return "rolled-back"
	}
	return "rollback-failed"
}

// matchesPreState refuses a change whose starting point is not the one that was
// reviewed.
func matchesPreState(live liveSettings, expected *plan.NetworkPreState) error {
	if expected == nil {
		return errors.New("the plan carries no reviewed state to check against")
	}
	if expected.Method != "" && live.Method != expected.Method {
		return fmt.Errorf("this interface is now %s, not %s as reviewed; request the change again",
			orUnknown(live.Method), expected.Method)
	}
	if !sameSet(live.Addresses, expected.Addresses) {
		return fmt.Errorf("the addresses on this interface have changed since it was reviewed (now %s)",
			orUnknown(strings.Join(live.Addresses, ", ")))
	}
	if expected.Gateway != "" && live.Gateway != expected.Gateway {
		return fmt.Errorf("the gateway on this interface has changed since it was reviewed (now %s)",
			orUnknown(live.Gateway))
	}
	return nil
}

func sameSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	a := append([]string{}, left...)
	b := append([]string{}, right...)
	sort.Strings(a)
	sort.Strings(b)
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func orUnknown(value string) string {
	if strings.TrimSpace(value) == "" {
		return "unset"
	}
	return value
}

func describeSettings(settings liveSettings) string {
	parts := []string{"method=" + orUnknown(settings.Method)}
	if len(settings.Addresses) > 0 {
		parts = append(parts, "addresses="+strings.Join(settings.Addresses, " "))
	}
	if settings.Gateway != "" {
		parts = append(parts, "gateway="+settings.Gateway)
	}
	if len(settings.DNS) > 0 {
		parts = append(parts, "dns="+strings.Join(settings.DNS, " "))
	}
	if settings.MTU != 0 {
		parts = append(parts, "mtu="+strconv.Itoa(settings.MTU))
	}
	return boundEvidence(strings.Join(parts, " "))
}

func joinOutput(left, right string) string {
	if left == "" {
		return right
	}
	if right == "" {
		return left
	}
	return left + "\n" + right
}

func boundEvidence(value string) string {
	cleaned, _ := Sanitize(value, 480)
	return cleaned
}
