package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"opensphere.io/rcc/node-agent/internal/execute"
	"opensphere.io/rcc/node-agent/internal/plan"
	"opensphere.io/rcc/node-agent/internal/state"
)

const testOpID = "2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f"

var testNow = time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)

// fakeSource records every control-center interaction.
type fakeSource struct {
	plans         [][]byte
	polls         int
	starts        []string
	startBindings []startBinding
	receipts      [][]byte
	startErr      error
	receiptErr    error
}

func (f *fakeSource) Poll(context.Context) ([]byte, error) {
	f.polls++
	if len(f.plans) == 0 {
		return nil, nil
	}
	next := f.plans[0]
	f.plans = f.plans[1:]
	return next, nil
}

func (f *fakeSource) Start(_ context.Context, p *plan.Plan) error {
	f.starts = append(f.starts, p.OperationID)
	// A start must restate the whole identity of the work, so record it and let
	// the tests assert on what the control center would have received.
	f.startBindings = append(f.startBindings, startBinding{
		OperationID:     p.OperationID,
		Attempt:         p.Attempt,
		ControlCenterID: p.ControlCenterID,
		HostID:          p.HostID,
		Operation:       p.Operation,
		ContentDigest:   p.ContentDigest,
	})
	return f.startErr
}

func (f *fakeSource) Receipt(_ context.Context, _ string, body []byte) error {
	f.receipts = append(f.receipts, append([]byte(nil), body...))
	return f.receiptErr
}

type startBinding struct {
	OperationID     string
	Attempt         int
	ControlCenterID string
	HostID          string
	Operation       string
	ContentDigest   string
}

type countingRunner struct {
	runs   int
	result execute.Result
}

func (c *countingRunner) Run(context.Context, []string, int) (execute.Result, error) {
	c.runs++
	return c.result, nil
}

type countingRebooter struct{ calls int }

func (c *countingRebooter) Reboot(context.Context) error { c.calls++; return nil }

func planJSON(t *testing.T, operation string, extra map[string]any) []byte {
	t.Helper()
	doc := map[string]any{
		"schemaVersion":   plan.SchemaVersion,
		"operationId":     testOpID,
		"attempt":         1,
		"controlCenterId": "cc2",
		"hostId":          "node-a",
		"operation":       operation,
		"contentDigest":   "sha256:" + strings.Repeat("a", 64),
		"issuedAt":        testNow.Add(-time.Minute),
		"notBefore":       testNow.Add(-time.Minute),
		"expiresAt":       testNow.Add(10 * time.Minute),
		"leaseExpiresAt":  testNow.Add(5 * time.Minute),
	}
	for k, v := range extra {
		doc[k] = v
	}
	// The agent now recomputes the digest from the parameters it receives, so a
	// fixture must carry the digest its own arguments imply.
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var parsed plan.Plan
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if digest, derr := parsed.CanonicalContentDigest(); derr == nil {
		doc["contentDigest"] = digest
		raw, err = json.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
	}
	return raw
}

func newRunner(t *testing.T, source PlanSource, runner execute.Runner, allowlist []string) (*OperationRunner, *state.Store) {
	t.Helper()
	store, err := state.Open(t.TempDir(), func() time.Time { return testNow })
	if err != nil {
		t.Fatal(err)
	}
	return &OperationRunner{
		Source: source,
		Store:  store,
		Executor: &execute.Executor{
			Runner:           runner,
			Rebooter:         &countingRebooter{},
			RestartAllowlist: allowlist,
			BootID:           func() (string, error) { return "boot-one", nil },
			Now:              func() time.Time { return testNow },
			JournalctlPath:   "/fake/journalctl",
			SystemctlPath:    "/fake/systemctl",
		},
		Identity: plan.Identity{ControlCenterID: "cc2", HostID: "node-a"},
		Now:      func() time.Time { return testNow },
	}, store
}

func TestJournalOperationRunsAndReports(t *testing.T) {
	source := &fakeSource{plans: [][]byte{
		planJSON(t, plan.OpJournalQuery, map[string]any{"journal": map[string]any{"lines": 10}}),
	}}
	runner := &countingRunner{result: execute.Result{ExitCode: 0, Stdout: "hello\n"}}
	ops, _ := newRunner(t, source, runner, nil)

	worked, err := ops.PollOnce(context.Background())
	if err != nil || !worked {
		t.Fatalf("expected work: %v %v", worked, err)
	}
	if len(source.starts) != 1 {
		t.Fatalf("start not reported: %v", source.starts)
	}
	if len(source.receipts) != 1 {
		t.Fatalf("receipt not reported: %d", len(source.receipts))
	}
	var receipt plan.Receipt
	if err := json.Unmarshal(source.receipts[0], &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Outcome != plan.OutcomeSucceeded || receipt.Output != "hello\n" {
		t.Fatalf("unexpected receipt: %#v", receipt)
	}
}

// The central Stage 2 guarantee.
func TestRedeliveredOperationNeverExecutesTwice(t *testing.T) {
	body := planJSON(t, plan.OpServiceRestart, map[string]any{"service": map[string]any{"unit": "chronyd.service"}})
	source := &fakeSource{plans: [][]byte{body, body, body}}
	runner := &countingRunner{result: execute.Result{ExitCode: 0}}
	ops, _ := newRunner(t, source, runner, []string{"chronyd.service"})

	for i := 0; i < 3; i++ {
		if _, err := ops.PollOnce(context.Background()); err != nil {
			t.Fatalf("poll %d: %v", i, err)
		}
	}
	// restart + is-active before + is-active after == 3 runs for ONE execution.
	if runner.runs != 3 {
		t.Fatalf("expected exactly one execution (3 runner calls), got %d", runner.runs)
	}
	if len(source.starts) != 1 {
		t.Fatalf("start must be reported once, got %d", len(source.starts))
	}
	// Every redelivery replays the identical stored receipt.
	if len(source.receipts) != 3 {
		t.Fatalf("expected a receipt per delivery, got %d", len(source.receipts))
	}
	if string(source.receipts[0]) != string(source.receipts[1]) ||
		string(source.receipts[1]) != string(source.receipts[2]) {
		t.Fatal("replayed receipts must be byte-identical")
	}
}

func TestReceiptSurvivesDeliveryFailureAndReplays(t *testing.T) {
	body := planJSON(t, plan.OpJournalQuery, map[string]any{"journal": map[string]any{}})
	source := &fakeSource{plans: [][]byte{body}, receiptErr: errors.New("network down")}
	runner := &countingRunner{}
	ops, store := newRunner(t, source, runner, nil)

	if _, err := ops.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Even though delivery failed, the receipt is durable.
	record, err := store.Load(testOpID)
	if err != nil || record == nil || record.Status != state.StatusComplete {
		t.Fatalf("receipt must be durable despite delivery failure: %v %#v", err, record)
	}

	// A later redelivery replays it without re-running anything.
	before := runner.runs
	source.plans = [][]byte{body}
	source.receiptErr = nil
	if _, err := ops.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runner.runs != before {
		t.Fatalf("replay must not execute again: %d -> %d", before, runner.runs)
	}
}

func TestDefiniteStartRefusalClosesTheOperationOut(t *testing.T) {
	body := planJSON(t, plan.OpServiceRestart, map[string]any{"service": map[string]any{"unit": "chronyd.service"}})
	// A definite answer from the control center: this attempt may not proceed.
	source := &fakeSource{plans: [][]byte{body}, startErr: errors.New("start rejected with HTTP 409")}
	runner := &countingRunner{}
	ops, _ := newRunner(t, source, runner, []string{"chronyd.service"})

	if _, err := ops.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runner.runs != 0 {
		t.Fatalf("a refused start must not execute anything, ran %d", runner.runs)
	}
	if len(source.receipts) != 1 {
		t.Fatalf("a definite refusal must be reported: %d", len(source.receipts))
	}
	var receipt plan.Receipt
	_ = json.Unmarshal(source.receipts[0], &receipt)
	if receipt.Outcome != plan.OutcomeFailed {
		t.Fatalf("expected failure, got %#v", receipt)
	}
}

func TestAmbiguousStartIsRetriedRatherThanFailed(t *testing.T) {
	// A network error is not evidence that the operation did not start. Closing
	// it out would report a failure for work the control center may consider
	// running, so the claim is kept and retried instead.
	body := planJSON(t, plan.OpServiceRestart, map[string]any{"service": map[string]any{"unit": "chronyd.service"}})
	source := &fakeSource{plans: [][]byte{body}, startErr: errors.New("connection reset by peer")}
	runner := &countingRunner{}
	ops, store := newRunner(t, source, runner, []string{"chronyd.service"})

	worked, err := ops.PollOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if worked {
		t.Fatal("an inconclusive start is not completed work")
	}
	if runner.runs != 0 {
		t.Fatalf("nothing may execute before a confirmed start, ran %d", runner.runs)
	}
	if len(source.receipts) != 0 {
		t.Fatalf("an ambiguous start must not report a result: %d", len(source.receipts))
	}
	// The claim is retained, so a later delivery cannot start it twice.
	record, err := store.Load(testOpID)
	if err != nil || record == nil || record.Status == "complete" {
		t.Fatalf("the claim must be retained for a later retry: %v %#v", err, record)
	}
	// Start was attempted more than once within the single poll.
	if len(source.starts) < 2 {
		t.Fatalf("an ambiguous start should be retried, saw %d attempts", len(source.starts))
	}
}

func TestRedeliveryWithDifferentContentIsRefused(t *testing.T) {
	// Reusing an operation id with different content must never replay the
	// stored receipt: that would answer a question nobody asked.
	first := planJSON(t, plan.OpServiceRestart, map[string]any{"service": map[string]any{"unit": "chronyd.service"}})
	second := planJSON(t, plan.OpServiceRestart, map[string]any{"service": map[string]any{"unit": "sshd.service"}})
	source := &fakeSource{plans: [][]byte{first, second}}
	runner := &countingRunner{result: execute.Result{ExitCode: 0}}
	ops, _ := newRunner(t, source, runner, []string{"chronyd.service", "sshd.service"})

	if _, err := ops.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	receiptsAfterFirst := len(source.receipts)
	runsAfterFirst := runner.runs

	if _, err := ops.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runner.runs != runsAfterFirst {
		t.Fatal("a mismatched redelivery must not execute")
	}
	if len(source.receipts) != receiptsAfterFirst {
		t.Fatal("a mismatched redelivery must not replay the stored receipt")
	}
}

func TestRebootReachesTerminalFailureAtItsDeadline(t *testing.T) {
	// A reboot that never happens must not linger forever: once the deadline
	// passes, reconciliation produces a terminal failure receipt.
	source := &fakeSource{}
	ops, store := newRunner(t, source, &countingRunner{}, nil)
	if _, _, err := store.Claim(testOpID, 1, plan.OpHostReboot, "sha256:"+strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEvidence(testOpID, map[string]string{
		"bootIdBefore": "boot-one",
		"deadline":     testNow.Add(-time.Minute).Format(time.RFC3339),
	}); err != nil {
		t.Fatal(err)
	}
	// Same boot id, deadline already passed.
	ops.Executor.BootID = func() (string, error) { return "boot-one", nil }

	if err := ops.ReconcilePending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(source.receipts) != 1 {
		t.Fatalf("a stuck reboot must terminate at its deadline, got %d receipts", len(source.receipts))
	}
	var receipt plan.Receipt
	_ = json.Unmarshal(source.receipts[0], &receipt)
	if receipt.Outcome != plan.OutcomeFailed || !strings.Contains(receipt.Message, "deadline") {
		t.Fatalf("expected a deadline failure, got %#v", receipt)
	}
}

func TestPollReconcilesPendingRebootsEveryTime(t *testing.T) {
	source := &fakeSource{}
	ops, store := newRunner(t, source, &countingRunner{}, nil)
	if _, _, err := store.Claim(testOpID, 1, plan.OpHostReboot, "sha256:"+strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEvidence(testOpID, map[string]string{"bootIdBefore": "boot-one"}); err != nil {
		t.Fatal(err)
	}
	// The machine has come back with a new boot id; the next poll must notice
	// without waiting for a restart of the agent.
	ops.Executor.BootID = func() (string, error) { return "boot-two", nil }
	if _, err := ops.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(source.receipts) != 1 {
		t.Fatalf("poll must reconcile pending reboots, got %d receipts", len(source.receipts))
	}
	var receipt plan.Receipt
	if err := json.Unmarshal(source.receipts[0], &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Evidence["bootIdBeforeHash"] == "" || receipt.Evidence["bootIdAfterHash"] == "" {
		t.Fatalf("reboot proof must carry both bounded boot hashes: %#v", receipt.Evidence)
	}
	if receipt.Evidence["bootIdBeforeHash"] == receipt.Evidence["bootIdAfterHash"] {
		t.Fatalf("a successful reboot must prove a changed boot identity: %#v", receipt.Evidence)
	}
	encoded := string(source.receipts[0])
	if strings.Contains(encoded, "boot-one") || strings.Contains(encoded, "boot-two") {
		t.Fatalf("raw boot identifiers must never leave the host: %s", encoded)
	}
}

func TestInterruptedWorkIsClosedOutNotRetried(t *testing.T) {
	source := &fakeSource{}
	runner := &countingRunner{}
	ops, store := newRunner(t, source, runner, []string{"chronyd.service"})

	// Simulate a crash: intent recorded, no receipt.
	if _, _, err := store.Claim(testOpID, 1, plan.OpServiceRestart, "sha256:"+strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if err := ops.RecoverPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runner.runs != 0 {
		t.Fatalf("an interrupted operation must never be retried, ran %d", runner.runs)
	}
	if len(source.receipts) != 1 {
		t.Fatalf("recovery must report a result: %d", len(source.receipts))
	}
	var receipt plan.Receipt
	_ = json.Unmarshal(source.receipts[0], &receipt)
	if receipt.Outcome != plan.OutcomeFailed || !strings.Contains(receipt.Message, "not retried") {
		t.Fatalf("recovery receipt must be an explicit non-retry: %#v", receipt)
	}
}

func TestRebootPersistsEvidenceBeforeActing(t *testing.T) {
	body := planJSON(t, plan.OpHostReboot, map[string]any{
		"reboot": map[string]any{"drainConfirmed": true, "deadlineSeconds": 300},
	})
	source := &fakeSource{plans: [][]byte{body}}
	rebooter := &countingRebooter{}
	ops, store := newRunner(t, source, &countingRunner{}, nil)
	ops.Executor.Rebooter = rebooter

	if _, err := ops.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if rebooter.calls != 1 {
		t.Fatalf("reboot should be issued once, got %d", rebooter.calls)
	}
	// No receipt yet: the machine is going down.
	if len(source.receipts) != 0 {
		t.Fatalf("a reboot must not report before restarting: %d", len(source.receipts))
	}
	record, err := store.Load(testOpID)
	if err != nil || record == nil {
		t.Fatal("reboot record missing")
	}
	if record.Evidence["bootIdBefore"] != "boot-one" {
		t.Fatalf("pre-reboot boot id must be durable before acting: %#v", record.Evidence)
	}
}

func TestRebootIsConfirmedByBootIdChangeAfterRestart(t *testing.T) {
	source := &fakeSource{}
	ops, store := newRunner(t, source, &countingRunner{}, nil)

	if _, _, err := store.Claim(testOpID, 1, plan.OpHostReboot, "sha256:"+strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEvidence(testOpID, map[string]string{"bootIdBefore": "boot-one"}); err != nil {
		t.Fatal(err)
	}
	// The machine came back with a different boot id.
	ops.Executor.BootID = func() (string, error) { return "boot-two", nil }

	if err := ops.RecoverPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(source.receipts) != 1 {
		t.Fatalf("expected a reboot receipt, got %d", len(source.receipts))
	}
	var receipt plan.Receipt
	_ = json.Unmarshal(source.receipts[0], &receipt)
	if receipt.Outcome != plan.OutcomeSucceeded {
		t.Fatalf("a real reboot must be reported as success: %#v", receipt)
	}
}

func TestRebootThatNeverHappenedStaysPending(t *testing.T) {
	source := &fakeSource{}
	ops, store := newRunner(t, source, &countingRunner{}, nil)

	if _, _, err := store.Claim(testOpID, 1, plan.OpHostReboot, "sha256:"+strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	// Same boot id and the deadline has not passed: still waiting.
	if err := store.SetEvidence(testOpID, map[string]string{
		"bootIdBefore": "boot-one",
		"deadline":     testNow.Add(time.Hour).Format(time.RFC3339),
	}); err != nil {
		t.Fatal(err)
	}
	if err := ops.RecoverPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(source.receipts) != 0 {
		t.Fatalf("an unfinished reboot must not report yet: %d", len(source.receipts))
	}
}

func TestPlanForAnotherHostIsIgnoredWithoutClaiming(t *testing.T) {
	doc := map[string]any{"hostId": "node-b"}
	body := planJSON(t, plan.OpJournalQuery, map[string]any{"journal": map[string]any{}})
	var parsed map[string]any
	_ = json.Unmarshal(body, &parsed)
	for k, v := range doc {
		parsed[k] = v
	}
	hostile, _ := json.Marshal(parsed)

	source := &fakeSource{plans: [][]byte{hostile}}
	runner := &countingRunner{}
	ops, store := newRunner(t, source, runner, nil)

	worked, err := ops.PollOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if worked || runner.runs != 0 || len(source.starts) != 0 {
		t.Fatal("a plan for another host must be ignored entirely")
	}
	if record, _ := store.Load(testOpID); record != nil {
		t.Fatal("a rejected plan must not create durable state")
	}
}

func TestDisallowedUnitFailsWithoutExecuting(t *testing.T) {
	body := planJSON(t, plan.OpServiceRestart, map[string]any{"service": map[string]any{"unit": "postgresql.service"}})
	source := &fakeSource{plans: [][]byte{body}}
	runner := &countingRunner{}
	ops, _ := newRunner(t, source, runner, []string{"chronyd.service"})

	if _, err := ops.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runner.runs != 0 {
		t.Fatalf("a non-allowlisted unit must not execute, ran %d", runner.runs)
	}
	var receipt plan.Receipt
	_ = json.Unmarshal(source.receipts[0], &receipt)
	if receipt.Outcome != plan.OutcomeFailed || !strings.Contains(receipt.Message, "allowlist") {
		t.Fatalf("expected an allowlist failure receipt: %#v", receipt)
	}
}

func TestEmptyPollIsNotWork(t *testing.T) {
	source := &fakeSource{}
	ops, _ := newRunner(t, source, &countingRunner{}, nil)
	worked, err := ops.PollOnce(context.Background())
	if err != nil || worked {
		t.Fatalf("an empty poll is not work: %v %v", worked, err)
	}
}

func TestOversizedReceiptIsShrunkNotDropped(t *testing.T) {
	// A journal query that produced far more than the transport allows must
	// still deliver its outcome; only the log tail is sacrificed.
	body := planJSON(t, plan.OpJournalQuery, map[string]any{"journal": map[string]any{"lines": 2000}})
	huge := strings.Repeat("x", plan.MaxReceiptBytes*2)
	source := &fakeSource{plans: [][]byte{body}}
	runner := &countingRunner{result: execute.Result{ExitCode: 0, Stdout: huge}}
	ops, _ := newRunner(t, source, runner, nil)

	if _, err := ops.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(source.receipts) != 1 {
		t.Fatalf("an oversized result must still be reported, got %d", len(source.receipts))
	}
	if len(source.receipts[0]) > plan.MaxReceiptBytes {
		t.Fatalf("submitted receipt is %d bytes, above the %d limit",
			len(source.receipts[0]), plan.MaxReceiptBytes)
	}
	var receipt plan.Receipt
	if err := json.Unmarshal(source.receipts[0], &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Outcome != plan.OutcomeSucceeded {
		t.Fatalf("the outcome must survive shrinking: %#v", receipt.Outcome)
	}
	if !receipt.Truncated {
		t.Fatal("a shrunk receipt must say so")
	}
}

// A start must restate the identity of the work, so the control center can
// confirm the agent holds the plan it believes it issued rather than a stale
// one that happens to share an operation id.
func TestStartRestatesTheWholeBinding(t *testing.T) {
	source := &fakeSource{plans: [][]byte{
		planJSON(t, plan.OpJournalQuery, map[string]any{"journal": map[string]any{"lines": 5}}),
	}}
	ops, _ := newRunner(t, source, &countingRunner{}, nil)

	if _, err := ops.PollOnce(context.Background()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(source.startBindings) != 1 {
		t.Fatalf("expected exactly one start, got %d", len(source.startBindings))
	}
	binding := source.startBindings[0]
	if binding.ControlCenterID != "cc2" || binding.HostID != "node-a" {
		t.Fatalf("start must name its own control center and host, got %+v", binding)
	}
	if binding.Operation != plan.OpJournalQuery {
		t.Fatalf("start must name the operation, got %q", binding.Operation)
	}
	if binding.OperationID != testOpID {
		t.Fatalf("start must name the operation id, got %q", binding.OperationID)
	}
	if binding.Attempt != 1 {
		t.Fatalf("start must carry the lease attempt, got %d", binding.Attempt)
	}
	if !strings.HasPrefix(binding.ContentDigest, "sha256:") {
		t.Fatalf("start must carry the approved content digest, got %q", binding.ContentDigest)
	}
}

// ── Stage 3: package and kernel maintenance ─────────────────────────────────

func stage3Runner(t *testing.T, source PlanSource, packages *execute.PackageExecutor) (*OperationRunner, *state.Store) {
	t.Helper()
	ops, store := newRunner(t, source, &countingRunner{}, nil)
	ops.Packages = packages
	return ops, store
}

func TestAPackagePlanOnAHostWithoutPackageSupportFailsClosed(t *testing.T) {
	body := planJSON(t, plan.OpPackageRefresh, map[string]any{
		"packageRefresh": map[string]any{"manager": "apt"},
	})
	source := &fakeSource{plans: [][]byte{body}}
	ops, _ := stage3Runner(t, source, nil)

	if _, err := ops.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	var receipt plan.Receipt
	if err := json.Unmarshal(source.receipts[0], &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Outcome != plan.OutcomeFailed {
		t.Fatal("a host without package support must refuse, not silently succeed")
	}
	if !strings.Contains(receipt.Message, "not configured") {
		t.Fatalf("the reason must be stated: %q", receipt.Message)
	}
}

func TestAKernelUpdateReportsThePendingRebootWithoutPerformingIt(t *testing.T) {
	dir := t.TempDir()
	marker := dir + "/reboot-required"
	if err := os.WriteFile(marker, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &scriptedPackageRunner{results: []execute.Result{
		{ExitCode: 0, Stdout: "Inst linux-image-6.8.0-51-generic (6.8.0-51.52 Ubuntu:24.04/noble-security [amd64])\n"},
		{ExitCode: 0},
	}}
	packages := &execute.PackageExecutor{
		Runner: runner, Enabled: true, AptGetPath: "/fake/apt-get", RebootRequiredPath: marker,
		Now: func() time.Time { return testNow },
	}
	body := planJSON(t, plan.OpKernelUpdate, map[string]any{
		"kernelUpdate": map[string]any{"manager": "apt", "targetRelease": "6.8.0-51-generic"},
	})
	source := &fakeSource{plans: [][]byte{body}}
	ops, _ := stage3Runner(t, source, packages)

	if _, err := ops.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	var receipt plan.Receipt
	if err := json.Unmarshal(source.receipts[0], &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Outcome != plan.OutcomeSucceeded {
		t.Fatalf("kernel update should have succeeded: %s", receipt.Message)
	}
	if receipt.Evidence["rebooted"] != "false" {
		t.Fatal("a kernel update never reboots")
	}
	if receipt.Evidence["rebootRequired"] != "true" {
		t.Fatalf("the pending reboot must reach the control center: %+v", receipt.Evidence)
	}
	if !strings.Contains(receipt.Message, "not performed") {
		t.Fatalf("the message must say the reboot did not happen: %q", receipt.Message)
	}
}

func TestAPackageOperationIsStillExactlyOnce(t *testing.T) {
	runner := &scriptedPackageRunner{results: []execute.Result{
		{ExitCode: 0, Stdout: "Inst curl [1] (2 Ubuntu:24.04/noble-updates [amd64])\n"},
		{ExitCode: 0},
	}}
	packages := &execute.PackageExecutor{
		Runner: runner, Enabled: true, PackageAllowlist: []string{"curl"},
		AptGetPath: "/fake/apt-get", RebootRequiredPath: t.TempDir() + "/absent",
		Now: func() time.Time { return testNow },
	}
	body := planJSON(t, plan.OpPackageUpdate, map[string]any{
		"packageUpdate": map[string]any{
			"manager":      "apt",
			"packages":     []any{map[string]any{"name": "curl", "version": ""}},
			"securityOnly": false,
		},
	})
	source := &fakeSource{plans: [][]byte{body, body, body}}
	ops, _ := stage3Runner(t, source, packages)

	for i := 0; i < 3; i++ {
		if _, err := ops.PollOnce(context.Background()); err != nil {
			t.Fatalf("poll %d: %v", i, err)
		}
	}
	// One simulation plus one install, for one execution, across three deliveries.
	if len(runner.calls) != 2 {
		t.Fatalf("a redelivered package update must not run apt again, saw %d calls", len(runner.calls))
	}
	if len(source.receipts) != 3 {
		t.Fatalf("every delivery is answered, got %d", len(source.receipts))
	}
	if string(source.receipts[0]) != string(source.receipts[2]) {
		t.Fatal("replayed receipts must be byte-identical")
	}
}

func TestAPackageRefusalIsDurableAndNotRetried(t *testing.T) {
	// A refusal is a definite answer. Retrying it on the next poll would turn a
	// clear "no" into a loop.
	packages := &execute.PackageExecutor{
		Runner: &scriptedPackageRunner{}, Enabled: true, PackageAllowlist: []string{},
		AptGetPath: "/fake/apt-get", RebootRequiredPath: t.TempDir() + "/absent",
		Now: func() time.Time { return testNow },
	}
	body := planJSON(t, plan.OpPackageUpdate, map[string]any{
		"packageUpdate": map[string]any{
			"manager":      "apt",
			"packages":     []any{map[string]any{"name": "curl", "version": ""}},
			"securityOnly": false,
		},
	})
	source := &fakeSource{plans: [][]byte{body, body}}
	ops, store := stage3Runner(t, source, packages)

	for i := 0; i < 2; i++ {
		if _, err := ops.PollOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	record, err := store.Load(testOpID)
	if err != nil || record == nil || record.Status != state.StatusComplete {
		t.Fatalf("the refusal must be durable: %v %#v", err, record)
	}
	var receipt plan.Receipt
	if err := json.Unmarshal(source.receipts[0], &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Outcome != plan.OutcomeFailed {
		t.Fatal("an un-allowlisted package is a failure")
	}
	if string(source.receipts[0]) != string(source.receipts[1]) {
		t.Fatal("the same refusal must be replayed, not recomputed")
	}
}

// scriptedPackageRunner is the agent-side counterpart of the executor's runner.
type scriptedPackageRunner struct {
	calls   [][]string
	results []execute.Result
	index   int
}

func (r *scriptedPackageRunner) Run(_ context.Context, argv []string, _ int) (execute.Result, error) {
	r.calls = append(r.calls, append([]string(nil), argv...))
	i := r.index
	r.index++
	if i < len(r.results) {
		return r.results[i], nil
	}
	return execute.Result{}, nil
}
