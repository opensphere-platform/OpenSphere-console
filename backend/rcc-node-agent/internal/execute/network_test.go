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

// The scripted runner from packages_test.go answers each invocation from a
// queue, which is exactly what a preflight-apply-confirm-rollback sequence
// needs. These two helpers make the resulting call log readable in a failure.
func (s *scriptedRunner) argvAt(index int) []string {
	if index >= len(s.calls) {
		return nil
	}
	return s.calls[index]
}

func (s *scriptedRunner) joined() string {
	parts := make([]string, 0, len(s.calls))
	for _, call := range s.calls {
		parts = append(parts, strings.Join(call, " "))
	}
	return strings.Join(parts, " | ")
}

// procRootWithRoute writes a /proc/net/route the executor can read.
func procRootWithRoute(t *testing.T, defaultIface string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "net"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
	if defaultIface != "" {
		body += defaultIface + "\t00000000\t0102000A\t0003\t0\t0\t100\t00000000\t0\t0\t0\n"
	}
	// A more specific route on another interface must not be read as a default.
	body += "eth9\t0002000A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n"
	if err := os.WriteFile(filepath.Join(root, "net", "route"), []byte(body), 0o644); err != nil {
		t.Fatalf("write route: %v", err)
	}
	return root
}

// currentProfile is the terse nmcli output for a profile the tests start from.
const currentProfile = "connection.interface-name:eth1\n" +
	"connection.type:802-3-ethernet\n" +
	"ipv4.method:auto\n" +
	"ipv4.addresses:\n" +
	"ipv4.gateway:\n" +
	"ipv4.dns:\n" +
	"ipv4.dns-search:\n" +
	"802-3-ethernet.mtu:1500\n"

func networkArgs() *plan.NetworkConfigureArgs {
	return &plan.NetworkConfigureArgs{
		Adapter:         plan.SupportedNetworkAdapter,
		Connection:      "lab-data",
		Interface:       "eth1",
		Method:          "manual",
		Addresses:       []string{"192.168.50.10/24"},
		DNS:             []string{"192.168.50.1"},
		SearchDomains:   []string{"lab.internal"},
		MTU:             9000,
		RollbackSeconds: 60,
		PreState:        &plan.NetworkPreState{Method: "auto", DefaultRouteInterface: "eth0"},
	}
}

func newNetworkExecutor(t *testing.T, runner Runner, confirm func(context.Context) error) *NetworkExecutor {
	t.Helper()
	// An advancing clock, so the rollback deadline is actually reached rather
	// than the test hanging on a frozen one.
	clock := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	return &NetworkExecutor{
		Runner:    runner,
		Enabled:   true,
		Allowlist: []string{"lab-data"},
		Confirm:   confirm,
		ProcRoot:  procRootWithRoute(t, "eth0"),
		NmcliPath: "/usr/bin/nmcli",
		Now: func() time.Time {
			clock = clock.Add(20 * time.Second)
			return clock
		},
		ConfirmInterval: time.Millisecond,
	}
}

func TestNetworkChangeIsKeptOnlyWhenTheControlCenterIsReachable(t *testing.T) {
	runner := &scriptedRunner{results: []Result{{Stdout: currentProfile}}}
	confirmed := 0
	executor := newNetworkExecutor(t, runner, func(context.Context) error {
		confirmed++
		return nil
	})

	prepared, _, err := executor.Preflight(context.Background(), networkArgs())
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	result, evidence, err := executor.Apply(context.Background(), prepared, networkArgs())
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	_ = result

	if confirmed == 0 {
		t.Error("the change must be confirmed against the control center, not assumed")
	}
	if evidence["rollbackState"] != "confirmed" {
		t.Errorf("rollbackState = %q, want confirmed", evidence["rollbackState"])
	}
	// Read, modify, up — and nothing else. A restore would be a fourth call.
	if len(runner.calls) != 3 {
		t.Fatalf("expected read/modify/up, got %d calls: %s", len(runner.calls), runner.joined())
	}
	if !strings.Contains(strings.Join(runner.argvAt(2), " "), "connection up") {
		t.Errorf("the profile must be activated, got %v", runner.argvAt(2))
	}
}

func TestAnUnreachableControlCenterRollsTheChangeBack(t *testing.T) {
	// This is the whole point of the operation: a change that severs the path
	// used to check the change must undo itself.
	runner := &scriptedRunner{results: []Result{{Stdout: currentProfile}}}
	executor := newNetworkExecutor(t, runner, func(context.Context) error {
		return errors.New("no route to host")
	})

	prepared, _, err := executor.Preflight(context.Background(), networkArgs())
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	_, evidence, err := executor.Apply(context.Background(), prepared, networkArgs())
	if err == nil {
		t.Fatal("an unconfirmed change must fail the operation")
	}
	if evidence["rollbackState"] != "rolled-back" {
		t.Errorf("rollbackState = %q, want rolled-back", evidence["rollbackState"])
	}
	joined := runner.joined()
	if !strings.Contains(joined, "ipv4.method auto") {
		t.Errorf("the previous method must be restored, calls: %s", joined)
	}
	// Five calls: read, modify, up, restore-modify, restore-up.
	if len(runner.calls) != 5 {
		t.Fatalf("expected the change to be undone and reactivated, got %d calls: %s",
			len(runner.calls), joined)
	}
}

func TestNoConfirmationSeamMeansNoChange(t *testing.T) {
	// Without a way to prove the host is still reachable there is no way to
	// decide whether to keep the change, so it is not made at all.
	runner := &scriptedRunner{results: []Result{{Stdout: currentProfile}}}
	executor := newNetworkExecutor(t, runner, nil)
	if _, _, err := executor.Preflight(context.Background(), networkArgs()); err == nil {
		t.Fatal("a change that cannot be verified must be refused")
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run before the refusal, got %s", runner.joined())
	}
}

func TestTheManagementInterfaceIsRefusedAgainstTheLiveRoutingTable(t *testing.T) {
	// The plan grammar already refuses this, and the backend refuses it against
	// the reported inventory. This is the third check, against /proc, because
	// the route can move between the report and the execution.
	runner := &scriptedRunner{results: []Result{{Stdout: currentProfile}}}
	executor := newNetworkExecutor(t, runner, func(context.Context) error { return nil })
	executor.ProcRoot = procRootWithRoute(t, "eth1") // the target now carries it
	executor.Allowlist = []string{"lab-data"}

	_, _, err := executor.Preflight(context.Background(), networkArgs())
	if err == nil {
		t.Fatal("reconfiguring the live default-route interface must be refused")
	}
	if !strings.Contains(err.Error(), "default route") {
		t.Errorf("the refusal must name the reason, got %q", err)
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run before the refusal, got %s", runner.joined())
	}
}

func TestADefaultRouteThatMovedSinceReviewIsRefused(t *testing.T) {
	runner := &scriptedRunner{results: []Result{{Stdout: currentProfile}}}
	executor := newNetworkExecutor(t, runner, func(context.Context) error { return nil })
	executor.ProcRoot = procRootWithRoute(t, "eth7") // reviewed as eth0

	_, _, err := executor.Preflight(context.Background(), networkArgs())
	if err == nil {
		t.Fatal("a default route that moved since review must be refused")
	}
	if !strings.Contains(err.Error(), "moved") {
		t.Errorf("the refusal must say what changed, got %q", err)
	}
}

func TestAHostThatChangedSinceReviewIsRefused(t *testing.T) {
	// Applying a reviewed change on top of a state nobody looked at is exactly
	// what the pre-state exists to prevent.
	changed := strings.Replace(currentProfile, "ipv4.method:auto", "ipv4.method:manual", 1)
	runner := &scriptedRunner{results: []Result{{Stdout: changed}}}
	executor := newNetworkExecutor(t, runner, func(context.Context) error { return nil })

	_, _, err := executor.Preflight(context.Background(), networkArgs())
	if err == nil {
		t.Fatal("a host whose settings changed since review must be refused")
	}
	if !strings.Contains(err.Error(), "reviewed") {
		t.Errorf("the refusal must explain itself, got %q", err)
	}
	// Only the read happened; nothing was modified.
	if len(runner.calls) != 1 {
		t.Errorf("nothing may be changed after a pre-state mismatch, got %s", runner.joined())
	}
}

func TestAProfileOutsideTheAllowlistIsRefused(t *testing.T) {
	runner := &scriptedRunner{results: []Result{{Stdout: currentProfile}}}
	executor := newNetworkExecutor(t, runner, func(context.Context) error { return nil })
	executor.Allowlist = []string{"something-else"}
	if _, _, err := executor.Preflight(context.Background(), networkArgs()); !errors.Is(err, ErrConnectionNotAllowed) {
		t.Fatalf("an unallowlisted profile must be refused, got %v", err)
	}

	executor.Allowlist = []string{"lab-data"}
	executor.Enabled = false
	if _, _, err := executor.Preflight(context.Background(), networkArgs()); !errors.Is(err, ErrNetworkNotEnabled) {
		t.Fatalf("a host without network authority must refuse, got %v", err)
	}
}

func TestEveryValueReachesNmcliAsItsOwnArgument(t *testing.T) {
	runner := &scriptedRunner{results: []Result{{Stdout: currentProfile}}}
	executor := newNetworkExecutor(t, runner, func(context.Context) error { return nil })
	prepared, _, err := executor.Preflight(context.Background(), networkArgs())
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if _, _, err := executor.Apply(context.Background(), prepared, networkArgs()); err != nil {
		t.Fatalf("apply: %v", err)
	}

	modify := runner.argvAt(1)
	// `--` ends option parsing, so a profile name can never be read as a flag.
	dashdash := -1
	for i, arg := range modify {
		if arg == "--" {
			dashdash = i
			break
		}
	}
	if dashdash == -1 || modify[dashdash+1] != "lab-data" {
		t.Fatalf("the profile name must follow `--`, got %v", modify)
	}
	// No shell, and no element that concatenates two values.
	for _, arg := range modify {
		if strings.Contains(arg, ";") || strings.Contains(arg, "&&") || strings.Contains(arg, "|") {
			t.Errorf("argv element %q looks like a command line", arg)
		}
	}
	joined := strings.Join(modify, "\x00")
	for _, want := range []string{
		"ipv4.method\x00manual",
		"ipv4.addresses\x00192.168.50.10/24",
		"ipv4.dns\x00192.168.50.1",
		"ipv4.dns-search\x00lab.internal",
		"802-3-ethernet.mtu\x009000",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %v", strings.ReplaceAll(want, "\x00", " "), modify)
		}
	}
	if strings.Contains(joined, "sh\x00-c") {
		t.Error("no invocation may go through a shell")
	}
}

func TestAFailedActivationIsUndoneWithoutWaitingForTheDeadline(t *testing.T) {
	runner := &scriptedRunner{
		results: []Result{
			{Stdout: currentProfile}, // read
			{ExitCode: 0},            // modify
			{ExitCode: 4},            // up fails
		},
	}
	confirmed := 0
	executor := newNetworkExecutor(t, runner, func(context.Context) error {
		confirmed++
		return nil
	})
	prepared, _, err := executor.Preflight(context.Background(), networkArgs())
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	_, evidence, err := executor.Apply(context.Background(), prepared, networkArgs())
	if err == nil {
		t.Fatal("a profile that will not come up must fail the operation")
	}
	if confirmed != 0 {
		t.Error("a profile that never came up must not be confirmed as reachable")
	}
	if evidence["rollbackState"] != "rolled-back" {
		t.Errorf("rollbackState = %q, want rolled-back", evidence["rollbackState"])
	}
}

func TestARollbackThatFailsIsReportedAsSuch(t *testing.T) {
	// A host whose previous settings could not be restored needs a person, and
	// saying "rolled back" would be the most dangerous possible lie here.
	runner := &scriptedRunner{
		results: []Result{
			{Stdout: currentProfile}, // read
			{ExitCode: 0},            // modify
			{ExitCode: 0},            // up
			{ExitCode: 1},            // restore fails
		},
	}
	executor := newNetworkExecutor(t, runner, func(context.Context) error {
		return errors.New("unreachable")
	})
	prepared, _, err := executor.Preflight(context.Background(), networkArgs())
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	_, evidence, _ := executor.Apply(context.Background(), prepared, networkArgs())
	if evidence["rollbackState"] != "rollback-failed" {
		t.Errorf("rollbackState = %q, want rollback-failed", evidence["rollbackState"])
	}
}

func TestTheUndoRecordIsCompleteBeforeAnythingChanges(t *testing.T) {
	// The record is what makes the rollback survive the process that armed it,
	// so it has to carry every setting needed to put things back.
	runner := &scriptedRunner{results: []Result{{Stdout: currentProfile}}}
	executor := newNetworkExecutor(t, runner, func(context.Context) error { return nil })
	prepared, _, err := executor.Preflight(context.Background(), networkArgs())
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	for _, key := range []string{
		"rollbackConnection", "rollbackMethod", "rollbackAddresses",
		"rollbackGateway", "rollbackDns", "rollbackSearch", "rollbackMtu",
	} {
		if _, ok := prepared.Rollback[key]; !ok {
			t.Errorf("the undo record is missing %s", key)
		}
	}
	if prepared.Rollback["rollbackConnection"] != "lab-data" {
		t.Errorf("the undo record names %q", prepared.Rollback["rollbackConnection"])
	}
	// Only the read has happened at this point.
	if len(runner.calls) != 1 {
		t.Errorf("preflight must not change anything, got %s", runner.joined())
	}
}

func TestRestoreFromEvidenceRebuildsThePreviousSettings(t *testing.T) {
	runner := &scriptedRunner{}
	executor := newNetworkExecutor(t, runner, func(context.Context) error { return nil })
	detail, err := executor.RestoreFromEvidence(context.Background(), map[string]string{
		"rollbackConnection": "lab-data",
		"rollbackMethod":     "auto",
		"rollbackAddresses":  "",
		"rollbackGateway":    "",
		"rollbackDns":        "10.0.0.1,10.0.0.2",
		"rollbackSearch":     "old.internal",
		"rollbackMtu":        "1500",
	})
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if detail == "" {
		t.Error("a restore must say what it did")
	}
	joined := runner.joined()
	for _, want := range []string{"ipv4.method auto", "ipv4.dns 10.0.0.1,10.0.0.2", "802-3-ethernet.mtu 1500", "connection up"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %s", want, joined)
		}
	}
}

func TestRestoreWithNoRecordSaysSoRatherThanGuessing(t *testing.T) {
	runner := &scriptedRunner{}
	executor := newNetworkExecutor(t, runner, func(context.Context) error { return nil })
	if _, err := executor.RestoreFromEvidence(context.Background(), map[string]string{}); err == nil {
		t.Fatal("with no record there is nothing to restore and that must be said")
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run without a record, got %s", runner.joined())
	}
}

func TestDefaultRouteInterfaceReadsTheLowestMetric(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "net"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
		"eth1\t00000000\t0102000A\t0003\t0\t0\t600\t00000000\t0\t0\t0\n" +
		"eth0\t00000000\t0102000A\t0003\t0\t0\t100\t00000000\t0\t0\t0\n"
	if err := os.WriteFile(filepath.Join(root, "net", "route"), []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	// The kernel prefers the lowest metric, so that is the interface the
	// control center is actually reached through.
	if got := defaultRouteInterface(root); got != "eth0" {
		t.Errorf("defaultRouteInterface = %q, want eth0", got)
	}
	if got := defaultRouteInterface(t.TempDir()); got != "" {
		t.Errorf("an unreadable routing table must report nothing, got %q", got)
	}
}

func TestTerseParsingSurvivesColonsInValues(t *testing.T) {
	// nmcli escapes a literal colon as `\:`; a naive split would shift every
	// field after an IPv6 address or a profile name containing one.
	settings := parseSettings("connection.interface-name:eth1\n" +
		"ipv4.method:manual\n" +
		"ipv4.addresses:10.0.0.5/24,10.0.0.6/24\n" +
		"ipv4.gateway:--\n" +
		"802-3-ethernet.mtu:1500\n")
	if settings.Method != "manual" || settings.Interface != "eth1" {
		t.Fatalf("parsed %+v", settings)
	}
	if len(settings.Addresses) != 2 {
		t.Errorf("addresses = %v", settings.Addresses)
	}
	// nmcli prints `--` for an unset value; carrying that through as a literal
	// would make a restore set the gateway to the two-character string "--".
	if settings.Gateway != "" {
		t.Errorf("an unset gateway must parse as empty, got %q", settings.Gateway)
	}
	if settings.MTU != 1500 {
		t.Errorf("mtu = %d", settings.MTU)
	}
}

func TestAnMTUChangeOnANonEthernetProfileIsRefused(t *testing.T) {
	wifi := strings.Replace(currentProfile, "connection.type:802-3-ethernet", "connection.type:802-11-wireless", 1)
	runner := &scriptedRunner{results: []Result{{Stdout: wifi}}}
	executor := newNetworkExecutor(t, runner, func(context.Context) error { return nil })
	if _, _, err := executor.Preflight(context.Background(), networkArgs()); err == nil {
		t.Fatal("an MTU change on a non-wired profile must be refused rather than attempted")
	}
}

func TestAProfileBoundToAnotherInterfaceIsRefused(t *testing.T) {
	other := strings.Replace(currentProfile, "connection.interface-name:eth1", "connection.interface-name:eth2", 1)
	runner := &scriptedRunner{results: []Result{{Stdout: other}}}
	executor := newNetworkExecutor(t, runner, func(context.Context) error { return nil })
	if _, _, err := executor.Preflight(context.Background(), networkArgs()); err == nil {
		t.Fatal("a profile bound to a different interface must be refused")
	}
}

func TestTheLiveRoutingTableIsTheAuthorityOnItsOwn(t *testing.T) {
	// The route has not moved since review — the plan says eth1 carries it and
	// so does /proc. Only the live-route check can refuse this, so a mutation
	// that removes it has nowhere else to be caught.
	runner := &scriptedRunner{results: []Result{{Stdout: currentProfile}}}
	executor := newNetworkExecutor(t, runner, func(context.Context) error { return nil })
	executor.ProcRoot = procRootWithRoute(t, "eth1")

	args := networkArgs()
	args.PreState.DefaultRouteInterface = "eth1"

	_, _, err := executor.Preflight(context.Background(), args)
	if err == nil {
		t.Fatal("the interface carrying the live default route must be refused")
	}
	if !strings.Contains(err.Error(), "carries the default route to this control center") {
		t.Errorf("the refusal must come from the live-route check, got %q", err)
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run before the refusal, got %s", runner.joined())
	}
}
