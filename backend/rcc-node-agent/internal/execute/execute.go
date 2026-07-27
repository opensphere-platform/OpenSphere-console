// Package execute implements the three typed host operations.
//
// Every operation is built as an explicit argv slice and handed to exec without
// a shell. There is no string interpolation into a command line anywhere in
// this package, so there is nothing for an operator or a compromised control
// center to inject into. The binary itself is resolved from a fixed allowlist
// rather than from PATH.
//
// All side-effecting calls go through the Runner and Rebooter interfaces so
// tests exercise the real argv construction and output handling against fakes,
// and never restart or reboot the development host.
package execute

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"opensphere.io/rcc/node-agent/internal/plan"
)

// Runner executes a fixed argv with no shell and returns bounded output.
type Runner interface {
	Run(ctx context.Context, argv []string, maxBytes int) (Result, error)
}

// Rebooter performs the final, irreversible step of a reboot operation.
type Rebooter interface {
	Reboot(ctx context.Context) error
}

// Result is the bounded outcome of one command.
type Result struct {
	ExitCode  int
	Stdout    string
	Truncated bool
}

const (
	journalTimeout = 30 * time.Second
	serviceTimeout = 90 * time.Second
	statusTimeout  = 15 * time.Second
	maxStatusBytes = 8 * 1024
	// The command that asks systemd to reboot returns quickly; the machine
	// going down is observed separately through the boot id.
	rebootInvokeTimeout = 30 * time.Second
)

// Fixed binary allowlists. The agent never resolves these from PATH, so a
// writable PATH entry cannot substitute a different binary.
var (
	journalctlPaths = []string{"/usr/bin/journalctl", "/bin/journalctl"}
	systemctlPaths  = []string{"/usr/bin/systemctl", "/bin/systemctl", "/usr/sbin/systemctl"}
)

// deniedUnitPatterns are units this agent refuses to restart under any
// configuration.
//
// Restarting these would either sever the control path that governs the agent,
// break the cluster the maintenance coordinator depends on, or disable the
// operator's own way back into the machine. They are denied in code, not only
// in configuration, so a mistaken allowlist entry cannot re-enable them.
var deniedUnitPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^rcc-node-agent\.service$`),                                 // our own control path
	regexp.MustCompile(`^(k3s|k3s-agent|kubelet|containerd|crio|docker)\.service$`), // cluster + runtime
	regexp.MustCompile(`^(sshd|ssh)\.service$`),                                     // operator's way back in
	regexp.MustCompile(`^(systemd-networkd|NetworkManager|network|systemd-resolved)\.service$`),
	regexp.MustCompile(`^(firewalld|nftables|iptables|ufw)\.service$`),
	regexp.MustCompile(`^(systemd-udevd|systemd-journald|systemd-logind|dbus)\.service$`),
	regexp.MustCompile(`^(lvm2-.*|multipathd|iscsid|rbdmap|ceph-.*)\.service$`), // storage paths
	regexp.MustCompile(`^(etcd|kube-apiserver|kube-scheduler|kube-controller-manager)\.service$`),
	regexp.MustCompile(`^(init|systemd)\.service$`),
}

// ErrUnitNotAllowed is returned when a unit is outside the agent allowlist.
var ErrUnitNotAllowed = errors.New("unit is not in the agent restart allowlist")

// Executor holds the injectable seams and the host-local allowlist.
type Executor struct {
	Runner   Runner
	Rebooter Rebooter
	// RestartAllowlist is configured per host. An empty allowlist means the
	// agent restarts nothing, which is the safe default for a new host.
	RestartAllowlist []string
	// BootID reads the current boot identifier; used to prove a reboot happened.
	BootID func() (string, error)
	Now    func() time.Time
	// Binary resolution is a seam so tests exercise real argv construction
	// without requiring journalctl or systemctl to exist on the machine running
	// them. Production leaves these empty and the fixed allowlist is used.
	JournalctlPath string
	SystemctlPath  string
}

func (e *Executor) journalctl() (string, error) {
	if e.JournalctlPath != "" {
		return e.JournalctlPath, nil
	}
	return resolveBinary(journalctlPaths)
}

func (e *Executor) systemctl() (string, error) {
	if e.SystemctlPath != "" {
		return e.SystemctlPath, nil
	}
	return resolveBinary(systemctlPaths)
}

// UnitAllowed reports whether a unit may be restarted on this host.
//
// Both gates must pass: the built-in denylist (which configuration cannot
// override) and the host's own allowlist (which must name the unit exactly).
func (e *Executor) UnitAllowed(unit string) error {
	for _, denied := range deniedUnitPatterns {
		if denied.MatchString(unit) {
			return fmt.Errorf("%w: %s is a protected service", ErrUnitNotAllowed, unit)
		}
	}
	for _, allowed := range e.RestartAllowlist {
		if allowed == unit {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrUnitNotAllowed, unit)
}

func resolveBinary(candidates []string) (string, error) {
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("none of %v is present", candidates)
}

// JournalArgv builds the journalctl argv for a validated query.
//
// Exported so tests can assert the exact argv without executing anything. Every
// value has already been validated by the plan package; this function only
// assembles, and passes each value as its own argv element so nothing can be
// read as an additional flag.
func JournalArgv(args *plan.JournalArgs) []string {
	argv := []string{"--no-pager", "--output=short-iso", "--quiet"}
	for _, unit := range args.Units {
		argv = append(argv, "--unit", unit)
	}
	if args.Priority != "" {
		argv = append(argv, "--priority", args.Priority)
	}
	if args.Since != "" {
		argv = append(argv, "--since", args.Since)
	}
	if args.Until != "" {
		argv = append(argv, "--until", args.Until)
	}
	if args.Cursor != "" {
		argv = append(argv, "--after-cursor", args.Cursor)
	}
	argv = append(argv, "--lines", strconv.Itoa(args.EffectiveLines()))
	return argv
}

// controlChars are stripped from any host output before it leaves the agent.
var controlChars = regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`)

// Sanitize removes control characters and bounds the result.
//
// Journal lines are attacker-influenced: any process that can log can put
// terminal escapes or NUL bytes into them. Stripping here means neither the
// backend, the database, nor the browser ever handles them.
func Sanitize(value string, maxBytes int) (string, bool) {
	cleaned := controlChars.ReplaceAllString(value, "")
	if maxBytes > 0 && len(cleaned) > maxBytes {
		// Cut on a line boundary when one is close, so the last line is not
		// shown half-truncated.
		cutAt := maxBytes
		for cutAt > 0 && !utf8.RuneStart(cleaned[cutAt]) {
			cutAt--
		}
		cut := cleaned[:cutAt]
		if idx := strings.LastIndexByte(cut, '\n'); idx > maxBytes/2 {
			cut = cut[:idx]
		}
		return cut, true
	}
	return cleaned, false
}

// Journal runs a bounded, read-only journal query.
func (e *Executor) Journal(ctx context.Context, args *plan.JournalArgs) (Result, error) {
	binary, err := e.journalctl()
	if err != nil {
		return Result{}, fmt.Errorf("journalctl unavailable: %w", err)
	}
	runCtx, cancel := context.WithTimeout(ctx, journalTimeout)
	defer cancel()
	argv := append([]string{binary}, JournalArgv(args)...)
	result, err := e.Runner.Run(runCtx, argv, args.EffectiveMaxBytes())
	if err != nil {
		return result, err
	}
	cleaned, truncated := Sanitize(result.Stdout, args.EffectiveMaxBytes())
	result.Stdout = cleaned
	result.Truncated = result.Truncated || truncated
	return result, nil
}

// ServiceStatus captures a bounded `systemctl status` for evidence.
func (e *Executor) ServiceStatus(ctx context.Context, unit string) string {
	binary, err := e.systemctl()
	if err != nil {
		return ""
	}
	runCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	// `is-active` is a single word; `status` would include recent log lines.
	result, err := e.Runner.Run(runCtx, []string{binary, "is-active", "--", unit}, 128)
	// Sanitize on every path: the error path still carries host-controlled
	// output, and returning it raw would put control characters into evidence.
	cleaned, _ := Sanitize(result.Stdout, 128)
	if err != nil {
		return strings.TrimSpace(cleaned)
	}
	return strings.TrimSpace(cleaned)
}

// RestartService restarts one allowlisted unit and records before/after state.
func (e *Executor) RestartService(ctx context.Context, unit string) (Result, map[string]string, error) {
	evidence := map[string]string{}
	if err := e.UnitAllowed(unit); err != nil {
		// Fail closed before touching the host at all.
		return Result{ExitCode: -1}, evidence, err
	}
	binary, err := e.systemctl()
	if err != nil {
		return Result{}, evidence, fmt.Errorf("systemctl unavailable: %w", err)
	}

	evidence["unit"] = unit
	evidence["statusBefore"] = e.ServiceStatus(ctx, unit)

	runCtx, cancel := context.WithTimeout(ctx, serviceTimeout)
	defer cancel()
	// `--` ends option parsing, so a unit name can never be read as a flag even
	// if the grammar were ever relaxed. The name is already validated; this is
	// belt and braces at the exec boundary.
	result, runErr := e.Runner.Run(runCtx, []string{binary, "restart", "--", unit}, maxStatusBytes)

	evidence["statusAfter"] = e.ServiceStatus(ctx, unit)
	cleaned, truncated := Sanitize(result.Stdout, maxStatusBytes)
	result.Stdout = cleaned
	result.Truncated = result.Truncated || truncated
	return result, evidence, runErr
}

// PrepareReboot records the evidence that lets the agent decide, after it comes
// back, whether the reboot actually happened.
//
// This must be persisted *before* Reboot is called. Without the pre-reboot boot
// id there is no way to distinguish "rebooted successfully" from "never
// rebooted", and the operation would have to be reported as unknown.
func (e *Executor) PrepareReboot(deadlineSeconds int) (map[string]string, error) {
	bootID, err := e.BootID()
	if err != nil {
		return nil, fmt.Errorf("cannot read boot id: %w", err)
	}
	if bootID == "" {
		return nil, errors.New("boot id is empty; refusing to reboot without proof of change")
	}
	deadline := e.Now().Add(time.Duration(deadlineSeconds) * time.Second)
	return map[string]string{
		"bootIdBefore": bootID,
		"deadline":     deadline.UTC().Format(time.RFC3339),
	}, nil
}

// Reboot invokes the governed reboot. Only `systemctl reboot` is ever issued;
// shutdown, poweroff and halt are not implemented anywhere in this package.
func (e *Executor) Reboot(ctx context.Context) error {
	if e.Rebooter == nil {
		return errors.New("no rebooter configured")
	}
	return e.Rebooter.Reboot(ctx)
}

// ConfirmReboot decides the outcome of a reboot after the agent restarts.
func (e *Executor) ConfirmReboot(evidence map[string]string) (bool, string, error) {
	before := evidence["bootIdBefore"]
	if before == "" {
		return false, "no pre-reboot boot id was recorded", nil
	}
	current, err := e.BootID()
	if err != nil {
		return false, "", fmt.Errorf("cannot read boot id: %w", err)
	}
	if current == "" {
		return false, "current boot id is unavailable", nil
	}
	if current == before {
		// Same boot: the host never restarted.
		if deadline := evidence["deadline"]; deadline != "" {
			if parsed, perr := time.Parse(time.RFC3339, deadline); perr == nil && e.Now().After(parsed) {
				return false, "reboot deadline passed without a boot id change", nil
			}
		}
		return false, "host has not rebooted yet", nil
	}
	// The raw boot id is a host identifier and never leaves the node. The
	// caller records bounded hashes as evidence; this message deliberately
	// carries no prefix of either identifier.
	return true, "boot id changed", nil
}

// ── live implementations ─────────────────────────────────────────────────────

// boundedWriter keeps at most limit bytes and counts the rest.
//
// A plain bytes.Buffer grows to whatever the child process writes. A unit that
// logs a multi-megabyte stack trace on restart, or a journal query that matches
// far more than expected, would then be held entirely in agent memory on a node
// that is already unwell. This drains the pipe (so the child is never blocked)
// while retaining only the bounded prefix.
type boundedWriter struct {
	limit    int
	buffer   []byte
	overflow int
}

func newBoundedWriter(limit int) *boundedWriter {
	if limit <= 0 {
		limit = 64 * 1024
	}
	return &boundedWriter{limit: limit, buffer: make([]byte, 0, min(limit, 32*1024))}
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	remaining := w.limit - len(w.buffer)
	if remaining > 0 {
		take := len(p)
		if take > remaining {
			take = remaining
		}
		w.buffer = append(w.buffer, p[:take]...)
		w.overflow += len(p) - take
	} else {
		w.overflow += len(p)
	}
	// Always report a full write so the child is drained rather than blocked.
	return len(p), nil
}

func (w *boundedWriter) String() string  { return string(w.buffer) }
func (w *boundedWriter) Truncated() bool { return w.overflow > 0 }

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ExecRunner is the production Runner. It never uses a shell.
type ExecRunner struct{}

var commandEnvironment = []string{
	"DEBIAN_FRONTEND=noninteractive",
	"LC_ALL=C",
	"LANG=C",
	"PATH=/usr/sbin:/usr/bin:/sbin:/bin",
	"SYSTEMD_COLORS=0",
}

// Run executes argv directly with a bounded stdout buffer.
func (ExecRunner) Run(ctx context.Context, argv []string, maxBytes int) (Result, error) {
	if len(argv) == 0 {
		return Result{}, errors.New("empty argv")
	}
	if maxBytes <= 0 {
		maxBytes = 64 * 1024
	}
	// #nosec G204 -- argv[0] comes from a fixed allowlist and every argument
	// has been validated by the plan package. No shell is involved.
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = append([]string(nil), commandEnvironment...)
	cmd.Stdin = nil
	// Kill the whole process group if the child ignores SIGKILL on its own, so
	// a wedged systemctl cannot hold the agent forever.
	cmd.WaitDelay = 5 * time.Second
	out := newBoundedWriter(maxBytes)
	cmd.Stdout = out
	cmd.Stderr = out

	err := cmd.Run()
	exitCode := 0
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		exitCode = exitErr.ExitCode()
		err = nil
	}
	if ctx.Err() != nil {
		return Result{ExitCode: -1, Stdout: out.String(), Truncated: out.Truncated()}, ctx.Err()
	}
	return Result{ExitCode: exitCode, Stdout: out.String(), Truncated: out.Truncated()}, err
}

// SystemctlRebooter issues `systemctl reboot` and nothing else.
type SystemctlRebooter struct{}

// Reboot invokes the single permitted reboot command.
func (SystemctlRebooter) Reboot(ctx context.Context) error {
	binary, err := resolveBinary(systemctlPaths)
	if err != nil {
		return fmt.Errorf("systemctl unavailable: %w", err)
	}
	rebootCtx, cancel := context.WithTimeout(ctx, rebootInvokeTimeout)
	defer cancel()
	// #nosec G204 -- fixed binary, fixed single argument.
	cmd := exec.CommandContext(rebootCtx, binary, "reboot")
	cmd.Env = []string{"LC_ALL=C"}
	cmd.WaitDelay = 5 * time.Second
	return cmd.Run()
}

// LiveBootID reads the kernel boot identifier.
func LiveBootID(procRoot string) func() (string, error) {
	if procRoot == "" {
		procRoot = "/proc"
	}
	return func() (string, error) {
		raw, err := os.ReadFile(procRoot + "/sys/kernel/random/boot_id")
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(raw)), nil
	}
}
