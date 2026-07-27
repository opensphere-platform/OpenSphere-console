package execute

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"opensphere.io/rcc/node-agent/internal/plan"
)

// fakeRunner records every argv it is asked to run and never touches the host.
type fakeRunner struct {
	calls  [][]string
	result Result
	err    error
}

func (f *fakeRunner) Run(_ context.Context, argv []string, _ int) (Result, error) {
	f.calls = append(f.calls, append([]string(nil), argv...))
	return f.result, f.err
}

type fakeRebooter struct {
	called int
	err    error
}

func (f *fakeRebooter) Reboot(context.Context) error {
	f.called++
	return f.err
}

func newExecutor(runner Runner, allowlist []string) *Executor {
	clock := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	return &Executor{
		Runner:           runner,
		Rebooter:         &fakeRebooter{},
		RestartAllowlist: allowlist,
		BootID:           func() (string, error) { return "boot-one", nil },
		Now:              func() time.Time { return clock },
	}
}

func TestJournalArgvPassesEveryValueAsItsOwnArgument(t *testing.T) {
	args := &plan.JournalArgs{
		Units:    []string{"chronyd.service", "sshd.service"},
		Priority: "err",
		Since:    "2026-08-01 10:00",
		Until:    "now",
		Cursor:   "s=abc;i=1",
		Lines:    50,
	}
	argv := JournalArgv(args)
	joined := strings.Join(argv, " ")

	// No shell metacharacter can matter because there is no shell, but each
	// value must still be its own element or a value could be read as a flag.
	for _, want := range []string{"--unit", "chronyd.service", "--priority", "err", "--after-cursor"} {
		if !contains(argv, want) {
			t.Fatalf("argv %v is missing %q", argv, want)
		}
	}
	if !strings.Contains(joined, "--lines 50") {
		t.Fatalf("lines not applied: %v", argv)
	}
	// journalctl must never be asked to follow or run a pager.
	for _, forbidden := range []string{"--follow", "-f", "--pager"} {
		if contains(argv, forbidden) {
			t.Fatalf("argv must not contain %q: %v", forbidden, argv)
		}
	}
}

func TestJournalDefaultsAreApplied(t *testing.T) {
	argv := JournalArgv(&plan.JournalArgs{})
	if !contains(argv, "--lines") {
		t.Fatalf("default lines missing: %v", argv)
	}
	idx := indexOf(argv, "--lines")
	if argv[idx+1] != "200" {
		t.Fatalf("expected default 200 lines, got %s", argv[idx+1])
	}
}

func TestRestartRefusesUnitsOutsideTheAllowlist(t *testing.T) {
	runner := &fakeRunner{}
	exec := newExecutor(runner, []string{"chronyd.service"})

	_, _, err := exec.RestartService(context.Background(), "postgresql.service")
	if !errors.Is(err, ErrUnitNotAllowed) {
		t.Fatalf("expected allowlist refusal, got %v", err)
	}
	// Nothing may run on the host when the unit is refused.
	if len(runner.calls) != 0 {
		t.Fatalf("a refused unit must not execute anything: %v", runner.calls)
	}
}

func TestRestartRefusesProtectedUnitsEvenIfAllowlisted(t *testing.T) {
	// A mistaken allowlist entry must not be able to re-enable a unit whose
	// restart would sever the control path or break the cluster.
	protected := []string{
		"rcc-node-agent.service",
		"k3s.service",
		"kubelet.service",
		"containerd.service",
		"sshd.service",
		"NetworkManager.service",
		"firewalld.service",
		"systemd-journald.service",
		"etcd.service",
		"multipathd.service",
	}
	for _, unit := range protected {
		t.Run(unit, func(t *testing.T) {
			runner := &fakeRunner{}
			exec := newExecutor(runner, []string{unit}) // deliberately allowlisted
			_, _, err := exec.RestartService(context.Background(), unit)
			if !errors.Is(err, ErrUnitNotAllowed) {
				t.Fatalf("%s must be refused even when allowlisted, got %v", unit, err)
			}
			if len(runner.calls) != 0 {
				t.Fatalf("%s must not execute anything", unit)
			}
		})
	}
}

func TestEmptyAllowlistRestartsNothing(t *testing.T) {
	runner := &fakeRunner{}
	exec := newExecutor(runner, nil)
	if _, _, err := exec.RestartService(context.Background(), "chronyd.service"); !errors.Is(err, ErrUnitNotAllowed) {
		t.Fatalf("an empty allowlist must refuse everything, got %v", err)
	}
}

func TestSanitizeStripsControlCharactersAndBounds(t *testing.T) {
	dirty := "line one\x00\x1b[31mred\x07\nline two\n"
	cleaned, truncated := Sanitize(dirty, 0)
	if strings.ContainsAny(cleaned, "\x00\x1b\x07") {
		t.Fatalf("control characters survived: %q", cleaned)
	}
	if truncated {
		t.Fatal("short input must not report truncation")
	}
	// Newlines and tabs are legitimate log content and must survive.
	if !strings.Contains(cleaned, "line one") || !strings.Contains(cleaned, "\n") {
		t.Fatalf("legitimate content lost: %q", cleaned)
	}

	long := strings.Repeat("abcdefghij\n", 500)
	bounded, wasTruncated := Sanitize(long, 100)
	if !wasTruncated || len(bounded) > 100 {
		t.Fatalf("bounding failed: len=%d truncated=%v", len(bounded), wasTruncated)
	}

	multibyte := strings.Repeat("보호", 10)
	boundedUTF8, wasTruncated := Sanitize(multibyte, 10)
	if !wasTruncated || len(boundedUTF8) > 10 || !utf8.ValidString(boundedUTF8) {
		t.Fatalf("UTF-8 boundary was not preserved: %q len=%d truncated=%v", boundedUTF8, len(boundedUTF8), wasTruncated)
	}
}

func TestPrepareRebootCapturesBootIdBeforeActing(t *testing.T) {
	exec := newExecutor(&fakeRunner{}, nil)
	evidence, err := exec.PrepareReboot(300)
	if err != nil {
		t.Fatal(err)
	}
	if evidence["bootIdBefore"] != "boot-one" {
		t.Fatalf("pre-reboot boot id not captured: %#v", evidence)
	}
	if evidence["deadline"] == "" {
		t.Fatal("deadline must be recorded so a stuck reboot can fail")
	}
}

func TestPrepareRebootRefusesWithoutABootId(t *testing.T) {
	exec := newExecutor(&fakeRunner{}, nil)
	exec.BootID = func() (string, error) { return "", nil }
	if _, err := exec.PrepareReboot(300); err == nil {
		t.Fatal("a reboot with no provable outcome must be refused")
	}
}

func TestConfirmRebootDistinguishesRealRebootFromNone(t *testing.T) {
	exec := newExecutor(&fakeRunner{}, nil)

	// Boot id unchanged: the machine never went down.
	exec.BootID = func() (string, error) { return "boot-one", nil }
	rebooted, detail, err := exec.ConfirmReboot(map[string]string{"bootIdBefore": "boot-one"})
	if err != nil || rebooted {
		t.Fatalf("unchanged boot id must not count as a reboot: %v %v", rebooted, err)
	}
	if !strings.Contains(detail, "not rebooted") {
		t.Fatalf("unexpected detail %q", detail)
	}

	// Boot id changed: the reboot really happened.
	exec.BootID = func() (string, error) { return "boot-two", nil }
	rebooted, detail, err = exec.ConfirmReboot(map[string]string{"bootIdBefore": "boot-one"})
	if err != nil || !rebooted {
		t.Fatalf("changed boot id must prove a reboot: %v %v", rebooted, err)
	}
	if !strings.Contains(detail, "boot id changed") {
		t.Fatalf("unexpected detail %q", detail)
	}
}

func TestConfirmRebootFailsAfterTheDeadline(t *testing.T) {
	clock := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	exec := newExecutor(&fakeRunner{}, nil)
	exec.Now = func() time.Time { return clock }
	exec.BootID = func() (string, error) { return "boot-one", nil }

	past := clock.Add(-time.Hour).Format(time.RFC3339)
	_, detail, err := exec.ConfirmReboot(map[string]string{"bootIdBefore": "boot-one", "deadline": past})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(detail, "deadline passed") {
		t.Fatalf("a stuck reboot must fail after its deadline, got %q", detail)
	}
}

func TestConfirmRebootWithoutEvidenceIsInconclusive(t *testing.T) {
	exec := newExecutor(&fakeRunner{}, nil)
	rebooted, detail, err := exec.ConfirmReboot(map[string]string{})
	if err != nil || rebooted {
		t.Fatalf("missing evidence must not report success: %v %v", rebooted, err)
	}
	if !strings.Contains(detail, "no pre-reboot boot id") {
		t.Fatalf("unexpected detail %q", detail)
	}
}

func TestPackageHasNoShutdownOrShellPath(t *testing.T) {
	// Read the real source rather than asserting against a constant: the point
	// is that these strings appear nowhere in the shipped implementation.
	source, err := os.ReadFile("execute.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, forbidden := range []string{
		`"poweroff"`, `"shutdown"`, `"halt"`, `"kexec"`,
		`"/bin/sh"`, `"/bin/bash"`, `"-c"`,
		"exec.Command(\"sh\"", "exec.Command(\"bash\"",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("execute.go must never contain %s", forbidden)
		}
	}
	// The only systemctl verbs allowed.
	for _, verb := range []string{`"restart"`, `"is-active"`, `"reboot"`} {
		if !strings.Contains(text, verb) {
			t.Fatalf("expected systemctl verb %s to be present", verb)
		}
	}
	// A shell would have to come from exec; confirm every exec call is argv form.
	if strings.Contains(text, "sh -c") || strings.Contains(text, "bash -c") {
		t.Fatal("no shell invocation may exist")
	}
}

func TestAllCommandsUseNonInteractiveLocaleStableEnvironment(t *testing.T) {
	joined := strings.Join(commandEnvironment, "\n")
	for _, required := range []string{
		"DEBIAN_FRONTEND=noninteractive",
		"LC_ALL=C",
		"LANG=C",
		"PATH=/usr/sbin:/usr/bin:/sbin:/bin",
		"SYSTEMD_COLORS=0",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("command environment misses %q: %q", required, joined)
		}
	}
}

func TestRebooterIsInvokedExactlyOnce(t *testing.T) {
	rebooter := &fakeRebooter{}
	exec := newExecutor(&fakeRunner{}, nil)
	exec.Rebooter = rebooter
	if err := exec.Reboot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if rebooter.called != 1 {
		t.Fatalf("reboot called %d times", rebooter.called)
	}
}

func TestRebootWithoutARebooterFailsClosed(t *testing.T) {
	exec := newExecutor(&fakeRunner{}, nil)
	exec.Rebooter = nil
	if err := exec.Reboot(context.Background()); err == nil {
		t.Fatal("a missing rebooter must fail rather than silently succeed")
	}
}

func contains(list []string, want string) bool { return indexOf(list, want) >= 0 }

func indexOf(list []string, want string) int {
	for i, item := range list {
		if item == want {
			return i
		}
	}
	return -1
}
