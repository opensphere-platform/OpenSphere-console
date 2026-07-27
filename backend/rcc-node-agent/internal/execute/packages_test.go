package execute

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"opensphere.io/rcc/node-agent/internal/plan"
)

// scriptedRunner answers each invocation from a queue and records the exact
// argv it was given, so a test can assert on what would really have run.
type scriptedRunner struct {
	calls   [][]string
	results []Result
	errs    []error
	index   int
}

func (r *scriptedRunner) Run(_ context.Context, argv []string, _ int) (Result, error) {
	r.calls = append(r.calls, append([]string(nil), argv...))
	i := r.index
	r.index++
	var result Result
	var err error
	if i < len(r.results) {
		result = r.results[i]
	}
	if i < len(r.errs) {
		err = r.errs[i]
	}
	return result, err
}

func (r *scriptedRunner) lastArgv() []string {
	if len(r.calls) == 0 {
		return nil
	}
	return r.calls[len(r.calls)-1]
}

func packageExecutor(t *testing.T, runner Runner, allowlist ...string) *PackageExecutor {
	t.Helper()
	return &PackageExecutor{
		Runner:             runner,
		PackageAllowlist:   allowlist,
		Enabled:            true,
		AptGetPath:         "/fake/apt-get",
		RebootRequiredPath: filepath.Join(t.TempDir(), "reboot-required"),
		Now:                func() time.Time { return time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC) },
	}
}

func simulationOutput(lines ...string) Result {
	return Result{ExitCode: 0, Stdout: strings.Join(lines, "\n") + "\n"}
}

// ── the allowlist is two gates, and neither is optional ─────────────────────

func TestAPackageOutsideTheAllowlistIsRefused(t *testing.T) {
	runner := &scriptedRunner{}
	executor := packageExecutor(t, runner, "curl")
	_, _, err := executor.Update(context.Background(), &plan.PackageUpdateArgs{
		Manager:  "apt",
		Packages: []plan.PackageTarget{{Name: "openssl"}},
	})
	if !errors.Is(err, ErrPackageNotAllowed) {
		t.Fatalf("expected an allowlist refusal, got %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatal("a refused package must not reach apt at all")
	}
}

func TestAnEmptyAllowlistUpdatesNothing(t *testing.T) {
	runner := &scriptedRunner{}
	executor := packageExecutor(t, runner)
	_, _, err := executor.Update(context.Background(), &plan.PackageUpdateArgs{
		Manager:  "apt",
		Packages: []plan.PackageTarget{{Name: "curl"}},
	})
	if err == nil {
		t.Fatal("a newly enrolled host with no allowlist must update nothing")
	}
	if len(runner.calls) != 0 {
		t.Fatal("nothing may run")
	}
}

func TestCriticalPackagesAreRefusedEvenWhenAllowlisted(t *testing.T) {
	// The denylist is in code precisely so a mistaken allowlist entry cannot
	// re-enable it. This is the test that keeps it that way.
	for _, name := range []string{
		"k3s", "kubelet", "containerd", "containerd.io", "runc", "docker-ce",
		"etcd", "openssh-server", "systemd", "udev", "dbus", "lvm2",
		"network-manager", "ceph-common", "rcc-node-agent",
	} {
		runner := &scriptedRunner{}
		executor := packageExecutor(t, runner, name)
		_, _, err := executor.Update(context.Background(), &plan.PackageUpdateArgs{
			Manager:  "apt",
			Packages: []plan.PackageTarget{{Name: name}},
		})
		if err == nil {
			t.Fatalf("%s must never be updated by this agent", name)
		}
		if !strings.Contains(err.Error(), "critical") {
			t.Fatalf("%s: the refusal must say why: %v", name, err)
		}
		if len(runner.calls) != 0 {
			t.Fatalf("%s must not reach apt", name)
		}
	}
}

func TestPackageOperationsAreOffUntilTheHostEnablesThem(t *testing.T) {
	runner := &scriptedRunner{}
	executor := packageExecutor(t, runner, "curl")
	executor.Enabled = false
	for _, run := range []func() error{
		func() error {
			_, _, err := executor.Refresh(context.Background(), &plan.PackageRefreshArgs{Manager: "apt"})
			return err
		},
		func() error {
			_, _, err := executor.Update(context.Background(), &plan.PackageUpdateArgs{
				Manager: "apt", Packages: []plan.PackageTarget{{Name: "curl"}},
			})
			return err
		},
		func() error {
			_, _, err := executor.KernelUpdate(context.Background(), &plan.KernelUpdateArgs{Manager: "apt"})
			return err
		},
	} {
		if err := run(); err == nil {
			t.Fatal("installing the binary must not by itself make a host updatable")
		}
	}
	if len(runner.calls) != 0 {
		t.Fatal("nothing may run on a host that has not opted in")
	}
}

// ── argv construction ───────────────────────────────────────────────────────

func TestUpdateArgvIsFixedAndSeparatedFromItsOperands(t *testing.T) {
	runner := &scriptedRunner{results: []Result{
		simulationOutput("Inst curl [8.5.0-1] (8.5.0-2 Ubuntu:24.04/noble-updates [amd64])"),
		{ExitCode: 0},
	}}
	executor := packageExecutor(t, runner, "curl", "openssl")
	_, _, err := executor.Update(context.Background(), &plan.PackageUpdateArgs{
		Manager: "apt",
		Packages: []plan.PackageTarget{
			{Name: "curl", Version: "8.5.0-2ubuntu10.6"},
			{Name: "openssl"},
		},
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}

	argv := runner.lastArgv()
	joined := strings.Join(argv, " ")
	if argv[0] != "/fake/apt-get" {
		t.Fatalf("the binary must be the fixed path, got %q", argv[0])
	}
	if !strings.Contains(joined, "--only-upgrade") {
		t.Fatal("an update must never install a package that is not already present")
	}
	// The `--` boundary is what stops a package name that begins with a dash
	// from being read as a flag. The grammar already forbids it; this is the
	// second lock on the same door.
	separator := -1
	for i, arg := range argv {
		if arg == "--" {
			separator = i
		}
	}
	if separator == -1 {
		t.Fatal("operands must be separated from options by --")
	}
	for _, operand := range argv[separator+1:] {
		if strings.HasPrefix(operand, "-") {
			t.Fatalf("operand %q looks like a flag", operand)
		}
	}
	if argv[separator+1] != "curl=8.5.0-2ubuntu10.6" {
		t.Fatalf("a pinned version must be passed as name=version, got %q", argv[separator+1])
	}
	if argv[separator+2] != "openssl" {
		t.Fatalf("an unpinned package must be passed bare, got %q", argv[separator+2])
	}
	if strings.Contains(joined, "--force-yes") || strings.Contains(joined, "--allow-downgrades") {
		t.Fatal("no forcing flags may ever appear")
	}
}

func TestEveryAptRunWaitsForTheLockRatherThanFailingInstantly(t *testing.T) {
	// unattended-upgrades holds the dpkg lock routinely. Failing the moment it
	// is busy would make scheduled maintenance unreliable for no safety gain.
	runner := &scriptedRunner{results: []Result{{ExitCode: 0}}}
	executor := packageExecutor(t, runner, "curl")
	if _, _, err := executor.Refresh(context.Background(), &plan.PackageRefreshArgs{Manager: "apt"}); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(runner.lastArgv(), " ")
	if !strings.Contains(joined, "DPkg::Lock::Timeout=") {
		t.Fatalf("apt must be told to wait for the lock: %s", joined)
	}
	// The subcommand is the last argument; checking substrings would match
	// `--no-install-recommends`, which is an option rather than an action.
	argv := runner.lastArgv()
	subcommand := argv[len(argv)-1]
	if subcommand != "update" {
		t.Fatalf("refresh must run apt-get update, got subcommand %q", subcommand)
	}
	for _, arg := range argv {
		if arg == "upgrade" || arg == "dist-upgrade" || arg == "install" {
			t.Fatalf("a metadata refresh must install nothing, saw %q", arg)
		}
	}
}

// ── the simulation gate ─────────────────────────────────────────────────────

func TestAnUpdateThatWouldRemoveAnythingIsRefused(t *testing.T) {
	runner := &scriptedRunner{results: []Result{
		simulationOutput(
			"Inst curl [8.5.0-1] (8.5.0-2 Ubuntu:24.04/noble-updates [amd64])",
			"Remv libcurl4 [8.5.0-1]",
		),
	}}
	executor := packageExecutor(t, runner, "curl")
	_, _, err := executor.Update(context.Background(), &plan.PackageUpdateArgs{
		Manager: "apt", Packages: []plan.PackageTarget{{Name: "curl"}},
	})
	if err == nil || !strings.Contains(err.Error(), "would remove") {
		t.Fatalf("a removing transaction must be refused: %v", err)
	}
	if len(runner.calls) != 1 {
		t.Fatal("the refusal must happen after the simulation and before the install")
	}
}

func TestAnUpdateThatWouldTouchTheClusterIsRefused(t *testing.T) {
	// The named package is innocuous; the dependency graph is not. This is the
	// case the allowlist alone cannot catch.
	runner := &scriptedRunner{results: []Result{
		simulationOutput(
			"Inst curl [8.5.0-1] (8.5.0-2 Ubuntu:24.04/noble-updates [amd64])",
			"Inst containerd [1.7.0-1] (1.7.2-1 Ubuntu:24.04/noble-updates [amd64])",
		),
	}}
	executor := packageExecutor(t, runner, "curl")
	_, _, err := executor.Update(context.Background(), &plan.PackageUpdateArgs{
		Manager: "apt", Packages: []plan.PackageTarget{{Name: "curl"}},
	})
	if err == nil || !strings.Contains(err.Error(), "containerd") {
		t.Fatalf("a transaction reaching the container runtime must be refused: %v", err)
	}
	if len(runner.calls) != 1 {
		t.Fatal("nothing may be installed after the refusal")
	}
}

func TestAPinnedVersionThatNoLongerExistsFailsClearly(t *testing.T) {
	runner := &scriptedRunner{results: []Result{{ExitCode: 100, Stdout: "E: Version '9.9.9' for 'curl' was not found"}}}
	executor := packageExecutor(t, runner, "curl")
	_, _, err := executor.Update(context.Background(), &plan.PackageUpdateArgs{
		Manager: "apt", Packages: []plan.PackageTarget{{Name: "curl", Version: "9.9.9"}},
	})
	if err == nil || !strings.Contains(err.Error(), "no longer be available") {
		t.Fatalf("a vanished pin must be reported plainly: %v", err)
	}
	if len(runner.calls) != 1 {
		t.Fatal("a failed simulation must not be followed by an install")
	}
}

func TestAnAlreadyCurrentHostDoesNotRunAnInstall(t *testing.T) {
	runner := &scriptedRunner{results: []Result{simulationOutput("Reading package lists...")}}
	executor := packageExecutor(t, runner, "curl")
	_, evidence, err := executor.Update(context.Background(), &plan.PackageUpdateArgs{
		Manager: "apt", Packages: []plan.PackageTarget{{Name: "curl"}},
	})
	if err != nil {
		t.Fatalf("being current is not a failure: %v", err)
	}
	if evidence["outcome"] != "already-current" {
		t.Fatalf("outcome = %q", evidence["outcome"])
	}
	if len(runner.calls) != 1 {
		t.Fatal("there is nothing to install")
	}
}

func TestAFailedInstallIsReportedRatherThanSwallowed(t *testing.T) {
	runner := &scriptedRunner{results: []Result{
		simulationOutput("Inst curl [8.5.0-1] (8.5.0-2 Ubuntu:24.04/noble-updates [amd64])"),
		{ExitCode: 100, Stdout: "E: dpkg was interrupted"},
	}}
	executor := packageExecutor(t, runner, "curl")
	_, _, err := executor.Update(context.Background(), &plan.PackageUpdateArgs{
		Manager: "apt", Packages: []plan.PackageTarget{{Name: "curl"}},
	})
	if err == nil || !strings.Contains(err.Error(), "exit code 100") {
		t.Fatalf("a failed install must fail the operation: %v", err)
	}
}

func TestARunnerErrorPropagates(t *testing.T) {
	runner := &scriptedRunner{errs: []error{errors.New("context deadline exceeded")}}
	executor := packageExecutor(t, runner, "curl")
	_, _, err := executor.Update(context.Background(), &plan.PackageUpdateArgs{
		Manager: "apt", Packages: []plan.PackageTarget{{Name: "curl"}},
	})
	if err == nil || !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("a timeout must surface: %v", err)
	}
}

// ── the kernel never reboots ────────────────────────────────────────────────

func TestKernelUpdateInstallsAndStops(t *testing.T) {
	runner := &scriptedRunner{results: []Result{
		simulationOutput("Inst linux-image-6.8.0-51-generic (6.8.0-51.52 Ubuntu:24.04/noble-security [amd64])"),
		{ExitCode: 0},
	}}
	executor := packageExecutor(t, runner)
	executor.Enabled = true

	// The reboot-required marker the distribution writes after a kernel lands.
	if err := os.WriteFile(executor.RebootRequiredPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executor.RebootRequiredPath+".pkgs", []byte("linux-base\nlinux-image-6.8.0-51-generic\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, evidence, err := executor.KernelUpdate(context.Background(), &plan.KernelUpdateArgs{
		Manager: "apt", TargetRelease: "6.8.0-51-generic",
	})
	if err != nil {
		t.Fatalf("kernel update: %v", err)
	}
	if evidence["rebooted"] != "false" {
		t.Fatal("a kernel update never reboots")
	}
	if evidence["rebootRequired"] != "true" {
		t.Fatalf("the pending reboot must be reported: %+v", evidence)
	}
	if !strings.Contains(evidence["rebootRequiredNote"], "host.reboot") {
		t.Fatal("the evidence must say what actually changes the running kernel")
	}
	if !strings.Contains(evidence["rebootRequiredPackages"], "linux-image-6.8.0-51-generic") {
		t.Fatalf("packages awaiting a restart must be listed: %q", evidence["rebootRequiredPackages"])
	}

	for _, call := range runner.calls {
		for _, arg := range call {
			for _, forbidden := range []string{"reboot", "shutdown", "poweroff", "halt", "kexec"} {
				if strings.Contains(strings.ToLower(arg), forbidden) {
					t.Fatalf("a kernel update ran %q", arg)
				}
			}
		}
	}
}

func TestKernelUpdateRefusesToRebootEvenIfAsked(t *testing.T) {
	runner := &scriptedRunner{}
	executor := packageExecutor(t, runner)
	_, _, err := executor.KernelUpdate(context.Background(), &plan.KernelUpdateArgs{
		Manager: "apt", RebootAfter: true,
	})
	if err == nil || !strings.Contains(err.Error(), "never reboots") {
		t.Fatalf("expected a refusal, got %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatal("nothing may run")
	}
}

func TestKernelTargetIsBoundedByTheGrammarNotByTheCaller(t *testing.T) {
	if got := kernelTarget(&plan.KernelUpdateArgs{}); got != "linux-image-generic" {
		t.Fatalf("an unspecified release must use the meta-package, got %q", got)
	}
	if got := kernelTarget(&plan.KernelUpdateArgs{TargetRelease: "6.8.0-51-generic"}); got != "linux-image-6.8.0-51-generic" {
		t.Fatalf("target = %q", got)
	}
}

func TestNoRebootMarkerMeansNoPendingReboot(t *testing.T) {
	runner := &scriptedRunner{results: []Result{
		simulationOutput("Inst linux-image-generic [1] (2 Ubuntu:24.04/noble-updates [amd64])"),
		{ExitCode: 0},
	}}
	executor := packageExecutor(t, runner)
	_, evidence, err := executor.KernelUpdate(context.Background(), &plan.KernelUpdateArgs{Manager: "apt"})
	if err != nil {
		t.Fatal(err)
	}
	if evidence["rebootRequired"] != "false" {
		t.Fatalf("without the marker there is nothing pending: %+v", evidence)
	}
}

// ── unsupported managers ────────────────────────────────────────────────────

func TestAnUnsupportedManagerIsRefusedAtExecutionToo(t *testing.T) {
	runner := &scriptedRunner{}
	executor := packageExecutor(t, runner, "curl")
	for _, run := range []func() error{
		func() error {
			_, _, err := executor.Refresh(context.Background(), &plan.PackageRefreshArgs{Manager: "dnf"})
			return err
		},
		func() error {
			_, _, err := executor.Update(context.Background(), &plan.PackageUpdateArgs{
				Manager: "dnf", Packages: []plan.PackageTarget{{Name: "curl"}},
			})
			return err
		},
		func() error {
			_, _, err := executor.KernelUpdate(context.Background(), &plan.KernelUpdateArgs{Manager: "dnf"})
			return err
		},
	} {
		if err := run(); !errors.Is(err, ErrManagerUnsupported) {
			t.Fatalf("an unsupported manager must be refused, got %v", err)
		}
	}
	if len(runner.calls) != 0 {
		t.Fatal("nothing may run for a manager this build does not drive")
	}
}

func TestAHostWithoutAptIsUnsupportedRatherThanBroken(t *testing.T) {
	executor := packageExecutor(t, &scriptedRunner{}, "curl")
	executor.AptGetPath = ""
	// The fixed allowlist will not find apt-get on a machine running these
	// tests, which is exactly the unsupported-host case.
	if _, _, err := executor.Refresh(context.Background(), &plan.PackageRefreshArgs{Manager: "apt"}); err == nil {
		t.Fatal("a host without apt must be reported unsupported")
	}
}

// ── the implementation shape stays honest ───────────────────────────────────

func TestThePackageExecutorHasNoShellAndNoPathLookup(t *testing.T) {
	data, err := os.ReadFile("packages.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	for _, forbidden := range []string{
		"exec.Command", "exec.LookPath", "/bin/sh", "sh -c", "os.Getenv(\"PATH\")",
		"--force-yes", "--allow-downgrades", "--allow-remove-essential", "dist-upgrade",
	} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("%q must not appear in the package executor", forbidden)
		}
	}
	// Everything runs through the injected Runner, which owns the argv bound:
	// one refresh, and a simulate-then-install pair for each of update and
	// kernel update.
	if got := strings.Count(source, "e.Runner.Run("); got != 5 {
		t.Fatalf("every execution must go through the injected runner, found %d call sites", got)
	}
}

// ── security-only means security-only ───────────────────────────────────────

func TestASecurityOnlyUpdateRefusesANonSecurityCandidate(t *testing.T) {
	// The flag reaches the receipt and the approval record. If it does not also
	// reach the transaction, an approver ticking "security only" gets a receipt
	// that says so while a feature update installs.
	simulation := "Inst curl [8.5.0-2ubuntu10.5] (8.5.0-2ubuntu10.6 Ubuntu:24.04/noble-updates [amd64])\n"
	runner := &scriptedRunner{results: []Result{{Stdout: simulation}}}
	executor := packageExecutor(t, runner, "curl", "libssl3")

	args := &plan.PackageUpdateArgs{
		Manager:      plan.SupportedManager,
		Packages:     []plan.PackageTarget{{Name: "curl"}},
		SecurityOnly: true,
	}
	_, _, err := executor.Update(context.Background(), args)
	if err == nil {
		t.Fatal("a candidate from noble-updates must be refused under security-only")
	}
	if !strings.Contains(err.Error(), "non-security") {
		t.Errorf("the refusal must say why, got %q", err)
	}
	if len(runner.calls) != 1 {
		t.Errorf("nothing may be installed after the refusal, ran %v", runner.calls)
	}
}

func TestASecurityOnlyUpdateAllowsASecurityCandidate(t *testing.T) {
	simulation := "Inst curl [8.5.0-2ubuntu10.5] (8.5.0-2ubuntu10.6 Ubuntu:24.04/noble-security [amd64])\n"
	runner := &scriptedRunner{results: []Result{{Stdout: simulation}, {ExitCode: 0}}}
	executor := packageExecutor(t, runner, "curl", "libssl3")

	args := &plan.PackageUpdateArgs{
		Manager:      plan.SupportedManager,
		Packages:     []plan.PackageTarget{{Name: "curl"}},
		SecurityOnly: true,
	}
	_, evidence, err := executor.Update(context.Background(), args)
	if err != nil {
		t.Fatalf("a security candidate must be allowed: %v", err)
	}
	if evidence["outcome"] != "updated" {
		t.Errorf("outcome = %q, want updated", evidence["outcome"])
	}
}

func TestWithoutTheFlagAnyAllowedCandidateStillInstalls(t *testing.T) {
	// The check must be a narrowing of an approved update, not a new refusal
	// applied to every update.
	simulation := "Inst curl [8.5.0-2ubuntu10.5] (8.5.0-2ubuntu10.6 Ubuntu:24.04/noble-updates [amd64])\n"
	runner := &scriptedRunner{results: []Result{{Stdout: simulation}, {ExitCode: 0}}}
	executor := packageExecutor(t, runner, "curl", "libssl3")

	args := &plan.PackageUpdateArgs{
		Manager:  plan.SupportedManager,
		Packages: []plan.PackageTarget{{Name: "curl"}},
	}
	if _, _, err := executor.Update(context.Background(), args); err != nil {
		t.Fatalf("an ordinary update must not be affected: %v", err)
	}
}

func TestADependencyPulledInFromANonSecuritySuiteIsCaught(t *testing.T) {
	// The named package can be a genuine security update while apt satisfies it
	// with a feature update of something else. The check reads the transaction,
	// not the request.
	simulation := "Inst curl [8.5.0-1] (8.5.0-2 Ubuntu:24.04/noble-security [amd64])\n" +
		"Inst libssl3 [3.0.1] (3.1.0 Ubuntu:24.04/noble-updates [amd64])\n"
	runner := &scriptedRunner{results: []Result{{Stdout: simulation}}}
	executor := packageExecutor(t, runner, "curl", "libssl3")

	args := &plan.PackageUpdateArgs{
		Manager:      plan.SupportedManager,
		Packages:     []plan.PackageTarget{{Name: "curl"}},
		SecurityOnly: true,
	}
	_, _, err := executor.Update(context.Background(), args)
	if err == nil {
		t.Fatal("a non-security dependency must be refused under security-only")
	}
	if !strings.Contains(err.Error(), "libssl3") {
		t.Errorf("the refusal must name the offending package, got %q", err)
	}
}
