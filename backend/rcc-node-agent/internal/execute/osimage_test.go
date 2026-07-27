package execute

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"opensphere.io/rcc/node-agent/internal/plan"
)

const testImage = "registry.example.com/polyon/os@sha256:" +
	"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func newImageExecutor(runner Runner, adapter string) *OSImageExecutor {
	clock := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	executor := &OSImageExecutor{
		Runner:    runner,
		Enabled:   true,
		Allowlist: []string{testImage},
		Now:       func() time.Time { return clock },
	}
	switch adapter {
	case plan.AdapterBootc:
		executor.BootcPath = "/usr/bin/bootc"
	case plan.AdapterRPMOSTree:
		executor.RPMOSTreePath = "/usr/bin/rpm-ostree"
	}
	return executor
}

func imageArgs(adapter, image string) *plan.OSImageArgs {
	return &plan.OSImageArgs{
		Adapter:  adapter,
		Image:    image,
		PreState: &plan.OSImagePreState{Model: adapter, RollbackAvailable: true},
	}
}

// helpOutput is what a capability probe reads.
func helpOutput(subcommands ...string) Result {
	return Result{Stdout: "Usage:\n  " + strings.Join(subcommands, "\n  ") + "\n"}
}

func TestStagingNeverReboots(t *testing.T) {
	// The command line is the guarantee. `--apply`, `--reboot` and `-r` are the
	// flags that would restart the host, and none of them can appear because
	// nothing templates this argv.
	for adapter, want := range map[string][]string{
		plan.AdapterBootc:     {"/usr/bin/bootc", "switch", "--retain", "--", testImage},
		plan.AdapterRPMOSTree: {"/usr/bin/rpm-ostree", "rebase", "--bypass-driver", "ostree-unverified-registry:" + testImage},
	} {
		subcommand := "switch"
		if adapter == plan.AdapterRPMOSTree {
			subcommand = "rebase"
		}
		runner := &scriptedRunner{results: []Result{helpOutput(subcommand), {ExitCode: 0}}}
		executor := newImageExecutor(runner, adapter)
		_, evidence, err := executor.Stage(context.Background(), imageArgs(adapter, testImage))
		if err != nil {
			t.Fatalf("%s stage: %v", adapter, err)
		}
		argv := runner.lastArgv()
		if len(argv) != len(want) {
			t.Fatalf("%s argv = %v, want %v", adapter, argv, want)
		}
		for i := range want {
			if argv[i] != want[i] {
				t.Errorf("%s argv[%d] = %q, want %q", adapter, i, argv[i], want[i])
			}
		}
		for _, forbidden := range []string{"--apply", "--reboot", "-r", "--now"} {
			for _, arg := range argv {
				if arg == forbidden {
					t.Errorf("%s: staging must never carry %s", adapter, forbidden)
				}
			}
		}
		if evidence["rebooted"] != "false" || evidence["rebootRequired"] != "true" {
			t.Errorf("%s: staging must report that a reboot is pending and was not performed: %v", adapter, evidence)
		}
	}
}

func TestAnImageOutsideTheAllowlistIsRefused(t *testing.T) {
	runner := &scriptedRunner{}
	executor := newImageExecutor(runner, plan.AdapterBootc)
	other := "registry.example.com/other/os@sha256:" + strings.Repeat("c", 64)
	if _, _, err := executor.Stage(context.Background(), imageArgs(plan.AdapterBootc, other)); !errors.Is(err, ErrImageNotAllowed) {
		t.Fatalf("an unallowlisted image must be refused, got %v", err)
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run before the refusal, got %s", runner.joined())
	}
}

func TestImageAuthorityIsOffByDefault(t *testing.T) {
	runner := &scriptedRunner{}
	executor := newImageExecutor(runner, plan.AdapterBootc)
	executor.Enabled = false
	if _, _, err := executor.Stage(context.Background(), imageArgs(plan.AdapterBootc, testImage)); !errors.Is(err, ErrOSImageNotEnabled) {
		t.Errorf("a host without image authority must refuse staging, got %v", err)
	}
	if _, _, err := executor.Rollback(context.Background(), imageArgs(plan.AdapterBootc, "")); !errors.Is(err, ErrOSImageNotEnabled) {
		t.Errorf("a host without image authority must refuse a rollback, got %v", err)
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run before the refusal, got %s", runner.joined())
	}
}

func TestAnAdapterThatIsNotInstalledIsRefusedRatherThanSubstituted(t *testing.T) {
	// A bootc plan must never be carried out by rpm-ostree because it happened
	// to be present.
	runner := &scriptedRunner{}
	executor := &OSImageExecutor{
		Runner: runner, Enabled: true, Allowlist: []string{testImage},
		RPMOSTreePath: "/usr/bin/rpm-ostree",
	}
	_, _, err := executor.Stage(context.Background(), imageArgs(plan.AdapterBootc, testImage))
	if !errors.Is(err, ErrImageAdapterUnavailable) {
		t.Fatalf("a missing adapter must be refused, got %v", err)
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run before the refusal, got %s", runner.joined())
	}
}

func TestAnAdapterTooOldForTheSubcommandIsRefusedNotAttempted(t *testing.T) {
	// Attempting and failing halfway leaves a deployment somebody has to clean
	// up. The capability is probed from the installed binary.
	runner := &scriptedRunner{results: []Result{helpOutput("status", "upgrade")}}
	executor := newImageExecutor(runner, plan.AdapterBootc)
	_, _, err := executor.Stage(context.Background(), imageArgs(plan.AdapterBootc, testImage))
	if err == nil {
		t.Fatal("an adapter that does not expose switch must be refused")
	}
	if !strings.Contains(err.Error(), "does not expose") {
		t.Errorf("the refusal must say what is missing, got %q", err)
	}
	// Only the probe ran.
	if len(runner.calls) != 1 {
		t.Errorf("the staging command must not run, got %s", runner.joined())
	}
}

func TestRollbackNamesNoImageAndDoesNotReboot(t *testing.T) {
	runner := &scriptedRunner{results: []Result{helpOutput("rollback"), {ExitCode: 0}}}
	executor := newImageExecutor(runner, plan.AdapterBootc)
	_, evidence, err := executor.Rollback(context.Background(), imageArgs(plan.AdapterBootc, ""))
	if err != nil {
		t.Fatalf("rollback: %v", err)
	}
	argv := runner.lastArgv()
	if len(argv) != 2 || argv[1] != "rollback" {
		t.Fatalf("argv = %v, want a bare rollback", argv)
	}
	if evidence["rebooted"] != "false" || evidence["rebootRequired"] != "true" {
		t.Errorf("a rollback must report that a reboot is pending and was not performed: %v", evidence)
	}

	named := &scriptedRunner{}
	namedExecutor := newImageExecutor(named, plan.AdapterBootc)
	if _, _, err := namedExecutor.Rollback(context.Background(), imageArgs(plan.AdapterBootc, testImage)); err == nil {
		t.Error("a rollback that names an image must be refused")
	}
	if len(named.calls) != 0 {
		t.Errorf("nothing may run before the refusal, got %s", named.joined())
	}
}

func TestRebootAfterIsRefusedAtTheExecutorToo(t *testing.T) {
	// Unreachable through a validated plan. This is the last place the
	// guarantee can be enforced, and it is enforced.
	runner := &scriptedRunner{}
	executor := newImageExecutor(runner, plan.AdapterBootc)
	args := imageArgs(plan.AdapterBootc, testImage)
	args.RebootAfter = true
	if _, _, err := executor.Stage(context.Background(), args); err == nil {
		t.Fatal("rebootAfter must be refused by the executor as well as the parser")
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run before the refusal, got %s", runner.joined())
	}
}

func TestAFailedStagingIsReportedRatherThanSwallowed(t *testing.T) {
	runner := &scriptedRunner{results: []Result{helpOutput("switch"), {ExitCode: 125, Stdout: "pull failed"}}}
	executor := newImageExecutor(runner, plan.AdapterBootc)
	_, evidence, err := executor.Stage(context.Background(), imageArgs(plan.AdapterBootc, testImage))
	if err == nil {
		t.Fatal("a non-zero exit must fail the operation")
	}
	if evidence["staged"] == "true" {
		t.Error("a failed staging must not claim to have staged anything")
	}
}

func TestSnapIsNotAnAdapterAtAll(t *testing.T) {
	// Ubuntu Core governs its own refresh, and a second scheduler racing it
	// would be worse than none. It is detected and reported, never driven.
	runner := &scriptedRunner{}
	executor := newImageExecutor(runner, plan.AdapterBootc)
	args := imageArgs("snapd", testImage)
	if _, _, err := executor.Stage(context.Background(), args); err == nil {
		t.Fatal("snapd must not be an image adapter")
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run before the refusal, got %s", runner.joined())
	}
}
