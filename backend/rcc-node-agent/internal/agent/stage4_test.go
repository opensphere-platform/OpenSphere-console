package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"opensphere.io/rcc/node-agent/internal/execute"
	"opensphere.io/rcc/node-agent/internal/plan"
	"opensphere.io/rcc/node-agent/internal/state"
)

// queuedRunner answers each invocation from a queue and records the argv.
type queuedRunner struct {
	calls   [][]string
	results []execute.Result
}

func (q *queuedRunner) Run(_ context.Context, argv []string, _ int) (execute.Result, error) {
	index := len(q.calls)
	q.calls = append(q.calls, append([]string(nil), argv...))
	if index < len(q.results) {
		return q.results[index], nil
	}
	return execute.Result{}, nil
}

func (q *queuedRunner) joined() string {
	parts := make([]string, 0, len(q.calls))
	for _, call := range q.calls {
		parts = append(parts, strings.Join(call, " "))
	}
	return strings.Join(parts, " | ")
}

const profileBefore = "connection.interface-name:eth1\n" +
	"connection.type:802-3-ethernet\n" +
	"ipv4.method:auto\n" +
	"ipv4.addresses:\n" +
	"ipv4.gateway:\n" +
	"ipv4.dns:\n" +
	"ipv4.dns-search:\n" +
	"802-3-ethernet.mtu:1500\n"

func routeRoot(t *testing.T, iface string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "net"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
		iface + "\t00000000\t0102000A\t0003\t0\t0\t100\t00000000\t0\t0\t0\n"
	if err := os.WriteFile(filepath.Join(root, "net", "route"), []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	return root
}

// networkPlanJSON builds a signed-shape network.configure plan with a digest
// derived from its own arguments.
func networkPlanJSON(t *testing.T) []byte {
	t.Helper()
	doc := map[string]any{
		"schemaVersion":   plan.SchemaVersion,
		"operationId":     "2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f",
		"attempt":         1,
		"controlCenterId": "cc2",
		"hostId":          "node-a",
		"operation":       plan.OpNetworkConfigure,
		"contentDigest":   "sha256:" + strings.Repeat("0", 64),
		"issuedAt":        testNow.Format(time.RFC3339),
		"notBefore":       testNow.Format(time.RFC3339),
		"expiresAt":       testNow.Add(10 * time.Minute).Format(time.RFC3339),
		"leaseExpiresAt":  testNow.Add(9 * time.Minute).Format(time.RFC3339),
		"network": map[string]any{
			"adapter":         plan.SupportedNetworkAdapter,
			"connection":      "lab-data",
			"interface":       "eth1",
			"method":          "manual",
			"addresses":       []string{"192.168.50.10/24"},
			"gateway":         "",
			"dns":             []string{},
			"searchDomains":   []string{},
			"mtu":             0,
			"rollbackSeconds": 60,
			"preState": map[string]any{
				"method":                "auto",
				"addresses":             []string{},
				"gateway":               "",
				"mtu":                   1500,
				"defaultRouteInterface": "eth0",
			},
		},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var parsed plan.Plan
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	digest, err := parsed.CanonicalContentDigest()
	if err != nil {
		t.Fatal(err)
	}
	doc["contentDigest"] = digest
	raw, err = json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func stage4Runner(t *testing.T, source PlanSource, netRunner execute.Runner,
	confirm func(context.Context) error) (*OperationRunner, *state.Store) {
	t.Helper()
	store, err := state.Open(t.TempDir(), func() time.Time { return testNow })
	if err != nil {
		t.Fatal(err)
	}
	return &OperationRunner{
		Source: source,
		Store:  store,
		Executor: &execute.Executor{
			Runner:         &countingRunner{},
			BootID:         func() (string, error) { return "boot-one", nil },
			Now:            func() time.Time { return testNow },
			JournalctlPath: "/fake/journalctl",
			SystemctlPath:  "/fake/systemctl",
		},
		Network: &execute.NetworkExecutor{
			Runner:          netRunner,
			Enabled:         true,
			Allowlist:       []string{"lab-data"},
			Confirm:         confirm,
			ProcRoot:        routeRoot(t, "eth0"),
			NmcliPath:       "/fake/nmcli",
			ConfirmInterval: time.Millisecond,
			Now:             func() time.Time { return time.Now() },
		},
		Identity: plan.Identity{ControlCenterID: "cc2", HostID: "node-a"},
		Now:      func() time.Time { return testNow },
	}, store
}

func TestTheUndoRecordIsDurableBeforeTheChangeIsMade(t *testing.T) {
	// This is what makes the rollback survive the process that armed it. If the
	// record were written after the change, an agent killed in between would
	// leave a host on settings nobody proved work, with nothing on disk saying
	// what they used to be.
	//
	// Reading the record after the operation finishes would not distinguish the
	// two orderings: the receipt carries the same keys and merges them on
	// completion. So it is read from inside the confirmation callback, which
	// runs after the change has been applied and before any receipt exists.
	source := &fakeSource{plans: [][]byte{networkPlanJSON(t)}}
	netRunner := &queuedRunner{results: []execute.Result{{Stdout: profileBefore}}}

	var atConfirmTime *state.Record
	var store *state.Store
	runner, storeRef := stage4Runner(t, source, netRunner, func(context.Context) error {
		loaded, err := store.Load("2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f")
		if err == nil {
			atConfirmTime = loaded
		}
		return nil
	})
	store = storeRef

	if _, err := runner.PollOnce(context.Background()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if atConfirmTime == nil {
		t.Fatal("the confirmation never ran, so the ordering was never observed")
	}
	for _, key := range []string{"rollbackConnection", "rollbackMethod", "rollbackAddresses"} {
		if _, ok := atConfirmTime.Evidence[key]; !ok {
			t.Errorf("the undo record was not durable before the change: missing %s", key)
		}
	}
	if atConfirmTime.Evidence["rollbackConnection"] != "lab-data" {
		t.Errorf("the record names %q", atConfirmTime.Evidence["rollbackConnection"])
	}
}

func TestAnInterruptedNetworkChangeIsRestoredOnTheNextStart(t *testing.T) {
	// A crash between applying and confirming leaves the host on settings
	// nobody ever proved reachable. The next start puts them back rather than
	// waiting for somebody to notice.
	source := &fakeSource{}
	netRunner := &queuedRunner{}
	runner, store := stage4Runner(t, source, netRunner, func(context.Context) error { return nil })

	if _, _, err := store.Claim("2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f", 1,
		plan.OpNetworkConfigure, "sha256:"+strings.Repeat("0", 64)); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := store.SetEvidence("2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f", map[string]string{
		"rollbackConnection": "lab-data",
		"rollbackMethod":     "auto",
		"rollbackAddresses":  "",
		"rollbackGateway":    "",
		"rollbackDns":        "",
		"rollbackSearch":     "",
	}); err != nil {
		t.Fatalf("evidence: %v", err)
	}

	if err := runner.RecoverPending(context.Background()); err != nil {
		t.Fatalf("recover: %v", err)
	}
	joined := netRunner.joined()
	if !strings.Contains(joined, "ipv4.method auto") {
		t.Errorf("the previous settings must be restored, calls: %s", joined)
	}
	if !strings.Contains(joined, "connection up") {
		t.Errorf("the restored profile must be reactivated, calls: %s", joined)
	}
	if len(source.receipts) != 1 {
		t.Fatalf("expected one receipt, got %d", len(source.receipts))
	}
	var receipt plan.Receipt
	if err := json.Unmarshal(source.receipts[0], &receipt); err != nil {
		t.Fatalf("receipt: %v", err)
	}
	if receipt.Outcome != plan.OutcomeFailed {
		t.Error("an interrupted change is a failure, not a success")
	}
	if receipt.Evidence["rollbackState"] != "rolled-back" {
		t.Errorf("rollbackState = %q, want rolled-back", receipt.Evidence["rollbackState"])
	}
}

func TestAnInterruptedChangeWithNoRecordSaysSoRatherThanGuessing(t *testing.T) {
	source := &fakeSource{}
	netRunner := &queuedRunner{}
	runner, store := stage4Runner(t, source, netRunner, func(context.Context) error { return nil })
	if _, _, err := store.Claim("2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f", 1,
		plan.OpNetworkConfigure, "sha256:"+strings.Repeat("0", 64)); err != nil {
		t.Fatalf("claim: %v", err)
	}

	if err := runner.RecoverPending(context.Background()); err != nil {
		t.Fatalf("recover: %v", err)
	}
	if len(netRunner.calls) != 0 {
		t.Errorf("with no record there is nothing to restore, got %s", netRunner.joined())
	}
	var receipt plan.Receipt
	if err := json.Unmarshal(source.receipts[0], &receipt); err != nil {
		t.Fatalf("receipt: %v", err)
	}
	if receipt.Evidence["rollbackState"] != "not-recorded" {
		t.Errorf("rollbackState = %q, want not-recorded", receipt.Evidence["rollbackState"])
	}
	if !strings.Contains(receipt.Message, "left as it was found") {
		t.Errorf("the receipt must say what was and was not done, got %q", receipt.Message)
	}
}

func TestAPlanForAnAdapterThisHostLacksIsRefusedNotSubstituted(t *testing.T) {
	// A host that was never given storage authority must refuse a mount rather
	// than have it silently ignored or run through a neighbouring adapter.
	source := &fakeSource{plans: [][]byte{networkPlanJSON(t)}}
	runner, _ := stage4Runner(t, source, &queuedRunner{}, func(context.Context) error { return nil })
	runner.Network = nil

	if _, err := runner.PollOnce(context.Background()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	var receipt plan.Receipt
	if err := json.Unmarshal(source.receipts[0], &receipt); err != nil {
		t.Fatalf("receipt: %v", err)
	}
	if receipt.Outcome != plan.OutcomeFailed {
		t.Fatal("an operation with no adapter must fail")
	}
	if !strings.Contains(receipt.Message, "not configured") {
		t.Errorf("the failure must say why, got %q", receipt.Message)
	}
}

func TestAPreflightRefusalNeverReachesTheApplyStep(t *testing.T) {
	// The route moved since review. Nothing may be modified, and the failure
	// must carry the preflight evidence rather than an empty map.
	source := &fakeSource{plans: [][]byte{networkPlanJSON(t)}}
	netRunner := &queuedRunner{results: []execute.Result{{Stdout: profileBefore}}}
	runner, store := stage4Runner(t, source, netRunner, func(context.Context) error { return nil })
	runner.Network.ProcRoot = routeRoot(t, "eth7")

	if _, err := runner.PollOnce(context.Background()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(netRunner.calls) != 0 {
		t.Errorf("nothing may run after a preflight refusal, got %s", netRunner.joined())
	}
	record, err := store.Load("2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if _, armed := record.Evidence["rollbackConnection"]; armed {
		t.Error("a refused preflight must not arm a rollback for a change that never happened")
	}
	var receipt plan.Receipt
	if err := json.Unmarshal(source.receipts[0], &receipt); err != nil {
		t.Fatalf("receipt: %v", err)
	}
	if receipt.Evidence["rollbackState"] != "none" {
		t.Errorf("rollbackState = %q, want none", receipt.Evidence["rollbackState"])
	}
}

func TestAConfirmedNetworkChangeReportsItAsSuch(t *testing.T) {
	source := &fakeSource{plans: [][]byte{networkPlanJSON(t)}}
	netRunner := &queuedRunner{results: []execute.Result{{Stdout: profileBefore}}}
	runner, _ := stage4Runner(t, source, netRunner, func(context.Context) error { return nil })

	if _, err := runner.PollOnce(context.Background()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	var receipt plan.Receipt
	if err := json.Unmarshal(source.receipts[0], &receipt); err != nil {
		t.Fatalf("receipt: %v", err)
	}
	if receipt.Outcome != plan.OutcomeSucceeded {
		t.Fatalf("a confirmed change must succeed, got %q: %s", receipt.Outcome, receipt.Message)
	}
	if receipt.Evidence["rollbackState"] != "confirmed" {
		t.Errorf("rollbackState = %q, want confirmed", receipt.Evidence["rollbackState"])
	}
	if !strings.Contains(receipt.Message, "reachable") {
		t.Errorf("the message must say what was proven, got %q", receipt.Message)
	}
}
