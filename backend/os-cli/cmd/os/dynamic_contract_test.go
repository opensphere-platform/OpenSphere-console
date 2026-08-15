package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDynamicManifestPreservesAdditiveOwnerFieldsWithoutInventingMissingValues(t *testing.T) {
	raw := []byte(`{
  "kind":"OpenSphereCLICommandManifest","schemaVersion":"v1","contractVersion":"owner-v7","sourceRevision":"rev-42",
  "tools":[{"id":"data.plan","command":"os data plan","method":"POST","path":"/plan",
    "contractVersion":"tool-v3","sourceRevision":"tool-rev","requestType":"Instance","executionClass":"console-api",
    "availability":{"webShell":true,"reason":"owner-declared"},"webShell":{"available":true,"reason":"same-owner-declaration"},
    "actionBinding":{"id":"create","action":"Create","capability":"data.sql","operation":"plan"}}]}`)
	var manifest ToolManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if err := validateToolManifest(manifest); err != nil {
		t.Fatal(err)
	}
	tool := manifest.Tools[0]
	if manifest.ContractVersion != "owner-v7" || manifest.SourceRevision != "rev-42" || tool.ID != "data.plan" || tool.RequestType != "Instance" || tool.ExecutionClass != "console-api" {
		t.Fatalf("additive owner fields were not preserved: %#v %#v", manifest, tool)
	}
	if tool.Availability == nil || tool.Availability.WebShell == nil || !*tool.Availability.WebShell || tool.WebShell == nil || tool.WebShell.Available == nil || !*tool.WebShell.Available || tool.ActionBinding == nil || tool.ActionBinding["id"] != "create" {
		t.Fatalf("availability/action binding were not preserved: %#v", tool)
	}

	missingOwnerFields := ToolManifest{Kind: "OpenSphereCLICommandManifest", Tools: []Tool{{Command: "os data status", Method: "GET", Path: "/status"}}}
	if err := validateToolManifest(missingOwnerFields); err != nil {
		t.Fatalf("optional owner fields must remain additive: %v", err)
	}
	missingTool := missingOwnerFields.Tools[0]
	if missingOwnerFields.ContractVersion != "" || missingOwnerFields.SourceRevision != "" || missingTool.ID != "" || missingTool.ExecutionClass != "" || missingTool.ActionBinding != nil {
		t.Fatalf("CLI invented missing owner fields: %#v %#v", missingOwnerFields, missingTool)
	}

	unknown := missingOwnerFields
	unknown.Tools[0].ExecutionClass = "shell-anything"
	err := validateToolManifest(unknown)
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != "CommandContractInvalid" || exitCode(err) != 2 {
		t.Fatalf("unknown executionClass must be a stable contract error: %T %v", err, err)
	}
}

func TestDynamicPayloadReturnsEveryMissingInputWithEquivalentOutputs(t *testing.T) {
	denyAdditional := false
	tool := Tool{
		ID: "owner.instance.plan", Command: "os owner instance plan", SupportsFile: true,
		ActionBinding: map[string]any{"id": "instance-plan", "action": "Plan"},
		InputSchema: &ToolInputSchema{Type: "object", AdditionalProperties: &denyAdditional,
			Required: []string{"name", "namespace", "storage"},
			Properties: map[string]*ToolInputSchema{
				"name": {Type: "string"}, "namespace": {Type: "string"},
				"storage": {Type: "object", AdditionalProperties: &denyAdditional, Required: []string{"size", "storageClass"}, Properties: map[string]*ToolInputSchema{
					"size": {Type: "string"}, "storageClass": {Type: "string"},
				}},
				"extensions": {Type: "array", Items: &ToolInputSchema{Type: "object", AdditionalProperties: &denyAdditional,
					Required: []string{"name"}, Properties: map[string]*ToolInputSchema{"name": {Type: "string"}}}},
			},
		},
	}
	_, err := dynamicPayload(tool, map[string]string{"file": "-"}, strings.NewReader(`{"storage":{},"extensions":[{}]}`))
	missing := missingInputsFromError(err)
	if missing == nil || exitCode(err) != 2 {
		t.Fatalf("expected MissingInputs exit 2, got %T %v exit=%d", err, err, exitCode(err))
	}
	wantPaths := []string{"request.name", "request.namespace", "request.extensions[0].name", "request.storage.size", "request.storage.storageClass"}
	gotPaths := make([]string, 0, len(missing.MissingInputs))
	for _, input := range missing.MissingInputs {
		gotPaths = append(gotPaths, input.Path)
	}
	if strings.Join(gotPaths, ",") != strings.Join(wantPaths, ",") {
		t.Fatalf("missing paths=%v want=%v", gotPaths, wantPaths)
	}
	if missing.ToolID != tool.ID || missing.Command != tool.Command || missing.ActionBinding == nil || missing.ActionBinding["id"] != "instance-plan" {
		t.Fatalf("missing input action context was lost: %#v", missing)
	}
	if len(missing.NextActions) != 1 || strings.Join(missing.NextActions[0].MissingPaths, ",") != strings.Join(wantPaths, ",") {
		t.Fatalf("nextActions do not bind all inputs: %#v", missing.NextActions)
	}

	var jsonOut, yamlOut, humanOut bytes.Buffer
	writeCLIError(&jsonOut, []string{"owner", "--output", "json"}, err)
	writeCLIError(&yamlOut, []string{"owner", "--output", "yaml"}, err)
	writeCLIError(&humanOut, []string{"owner", "--output", "table"}, err)
	var envelope map[string]any
	if unmarshalErr := json.Unmarshal(jsonOut.Bytes(), &envelope); unmarshalErr != nil {
		t.Fatal(unmarshalErr)
	}
	errorValue := envelope["error"].(map[string]any)
	if errorValue["code"] != "MissingInputs" || int(errorValue["exitCode"].(float64)) != 2 || len(errorValue["missingInputs"].([]any)) != len(wantPaths) {
		t.Fatalf("unexpected JSON error envelope: %s", jsonOut.String())
	}
	for _, output := range []string{yamlOut.String(), humanOut.String()} {
		if !strings.Contains(output, "MissingInputs") {
			t.Fatalf("output lost stable code: %s", output)
		}
		for _, path := range wantPaths {
			if !strings.Contains(output, path) {
				t.Fatalf("output lost %s: %s", path, output)
			}
		}
	}
}

func TestAttestedWebShellPolicyIsClosedAndFailClosed(t *testing.T) {
	original := attestedExecutionContextProvider
	defer func() { attestedExecutionContextProvider = original }()

	t.Setenv("OS_EXECUTION_PROFILE", "web-shell")
	t.Setenv("OS_WEB_SHELL_ATTESTED", "true")
	attestedExecutionContextProvider = func(context.Context) (*AttestedExecutionContext, error) { return nil, nil }
	if err := enforceExecutionPolicy(context.Background(), "os platform update", executionClassExternalTool, nil); err != nil {
		t.Fatalf("user-forged env must not create an attested context: %v", err)
	}

	attestedExecutionContextProvider = func(context.Context) (*AttestedExecutionContext, error) {
		return &AttestedExecutionContext{Profile: "web-shell", Authority: "user-env", AttestationID: "forged"}, nil
	}
	err := enforceExecutionPolicy(context.Background(), "os status", executionClassConsoleAPI, nil)
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != "InvalidExecutionContext" || exitCode(err) != 2 {
		t.Fatalf("forged provider context must fail closed: %T %v", err, err)
	}

	attestedExecutionContextProvider = func(context.Context) (*AttestedExecutionContext, error) {
		return &AttestedExecutionContext{
			Profile: "web-shell", Authority: "delegated-credential-agent", AttestationID: "session-attestation",
			ActorID: "operator-1", SessionID: "session-1", SessionClass: "operator-interactive",
			RuntimeAdapterID: "cbss.kubernetes-pod", RuntimeUID: "runtime-uid-1", Origin: "https://localhost:1114",
			Audience: "opensphere-os-cli", PermissionRevision: "permission-revision-1",
			AssuranceLevel: "aal2", ReleaseEvidenceRef: "release-evidence-1",
			Generation: 1, FencingEpoch: 1, KeyID: "agent-key-1",
		}, nil
	}
	if err := enforceExecutionPolicy(context.Background(), "os status", executionClassConsoleAPI, nil); err != nil {
		t.Fatalf("console-api must be available in attested Web Shell: %v", err)
	}
	for _, class := range []string{"", executionClassLocalHost, executionClassExternalTool} {
		err := enforceExecutionPolicy(context.Background(), "os unsafe", class, nil)
		if !errors.As(err, &cliErr) || cliErr.Code != "UnsupportedInWebShell" || exitCode(err) != 2 {
			t.Fatalf("class %q must fail UnsupportedInWebShell: %T %v", class, err, err)
		}
	}
	for _, definition := range commandDefinitions {
		if _, ok := nativeExecutionClasses[definition.Name]; !ok {
			t.Fatalf("native command %q has no closed executionClass", definition.Name)
		}
	}
}

func foundationCompletionFixture(operationID string) map[string]any {
	evidenceRevision := "owner-evidence-revision-42"
	return map[string]any{
		"operationId": operationID, "phase": "Succeeded", "verificationState": "succeeded",
		"verifierId": "foundation-control-plane", "stage": "Ready", "operationPhase": "Succeeded",
		"contractVersion": "pfss-postgres-owner/v1", "sourceRevision": "owner-source-revision",
		"capabilityId": "data.sql.postgres", "requestType": "Instance",
		"semanticIdentity": map[string]any{
			"capabilityId": "data.sql.postgres", "requestType": "Instance",
			"actionId": "operation.watch", "toolId": "foundation.operation.watch",
		},
		"actionBinding": map[string]any{"method": "GET", "path": "/api/foundation/oaa/operations/{operationId}", "pathParams": []any{"operationId"}},
		"completion": map[string]any{
			"terminal": true, "success": true, "verified": true, "state": "Succeeded",
			"stale": false, "evidenceRevision": evidenceRevision,
			"receipt": map[string]any{
				"operationId": operationID, "verifierId": "foundation-control-plane",
				"verificationState": "succeeded", "verifiedAt": "2026-08-14T09:30:00.123Z", "updatedAt": "2026-08-14T09:30:00.123Z",
				"semanticIdentity": map[string]any{
					"capabilityId": "data.sql.postgres", "requestType": "Instance",
					"actionId": "cluster.create", "toolId": "foundation.postgres.apply",
				},
				"actionBinding": map[string]any{
					"method": "POST", "path": "/api/foundation/oaa/postgres/durable-apply/{planId}",
					"pathParams": []any{"planId"}, "approval": "exact-confirmation",
				},
				"ownerEvidenceRevision": evidenceRevision,
				"futureReceiptField":    map[string]any{"preserved": true},
			},
			"futureCompletionField": map[string]any{"preserved": true},
		},
	}
}

func cloneOperationFixture(source map[string]any) map[string]any {
	raw, _ := json.Marshal(source)
	var cloned map[string]any
	_ = json.Unmarshal(raw, &cloned)
	return cloned
}

func TestDynamicOperationWatchPollsUntilFreshReady(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		count := requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		operation := map[string]any{"stage": "Ready", "stale": false, "operationId": "op-1"}
		if count == 2 {
			operation["stage"] = "Succeeded"
			operation["completion"] = map[string]any{"terminal": false, "success": true, "verified": false, "stale": false}
		}
		if count > 2 {
			operation = foundationCompletionFixture("op-1")
			operation["futureOwnerField"] = map[string]any{"preserved": true}
		}
		_ = json.NewEncoder(w).Encode(operation)
	}))
	defer server.Close()
	var out bytes.Buffer
	err := watchDynamicOperation(context.Background(), Config{PAT: "test", Output: "json"}, Tool{ID: "owner.operation.watch"}, server.URL, map[string]string{"interval": "10ms", "timeout": "1s"}, &out)
	if err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 3 || !strings.Contains(out.String(), `"owner-evidence-revision-42"`) || !strings.Contains(out.String(), `"futureReceiptField"`) || !strings.Contains(out.String(), `"futureOwnerField"`) {
		t.Fatalf("watch accepted resource stage before verified completion or lost additive fields: requests=%d output=%s", requests.Load(), out.String())
	}
}

func TestDynamicOperationWatchStableNegativeStates(t *testing.T) {
	staleReceipt := foundationCompletionFixture("op-stale")
	staleReceipt["completion"].(map[string]any)["stale"] = true
	tests := []struct {
		name       string
		status     int
		body       map[string]any
		wantCode   string
		wantExit   int
		wantCancel bool
	}{
		{name: "unknown", status: http.StatusNotFound, body: map[string]any{"error": "missing"}, wantCode: "OperationNotFound", wantExit: 5},
		{name: "stale receipt", status: http.StatusOK, body: staleReceipt, wantCode: "OperationEvidenceStale", wantExit: 6},
		{name: "terminal failure", status: http.StatusOK, body: map[string]any{"stage": "Reconciling", "completion": map[string]any{"terminal": true, "success": false, "verified": true, "stale": false}}, wantCode: "OperationFailed", wantExit: 6},
		{name: "terminal unknown", status: http.StatusOK, body: map[string]any{"stage": "Unknown", "completion": map[string]any{"terminal": true, "success": true, "verified": true, "stale": false, "receipt": "receipt-unknown"}}, wantCode: "OperationStateUnknown", wantExit: 6},
		{name: "terminal incomplete", status: http.StatusOK, body: map[string]any{"stage": "Ready", "completion": map[string]any{"terminal": true, "success": true, "verified": false, "stale": false, "receipt": map[string]any{}}}, wantCode: "OperationEvidenceIncomplete", wantExit: 6},
		{name: "cancel", status: http.StatusOK, body: map[string]any{"stage": "Accepted"}, wantCode: "OperationCanceled", wantExit: 130, wantCancel: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				_ = json.NewEncoder(w).Encode(test.body)
			}))
			defer server.Close()
			ctx := context.Background()
			if test.wantCancel {
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			}
			err := watchDynamicOperation(ctx, Config{PAT: "test", Output: "json"}, Tool{ID: "owner.operation.watch"}, server.URL, map[string]string{"interval": "10ms", "timeout": "1s"}, &bytes.Buffer{})
			var cliErr *CLIError
			if !errors.As(err, &cliErr) || cliErr.Code != test.wantCode || exitCode(err) != test.wantExit {
				t.Fatalf("got %T %#v exit=%d want code=%s exit=%d", err, cliErr, exitCode(err), test.wantCode, test.wantExit)
			}
		})
	}
}

func TestCanonicalFoundationCompletionReceiptRejectsMissingOrMismatchedEvidence(t *testing.T) {
	valid := foundationCompletionFixture("op-canonical")
	if completed, err := canonicalOperationCompleted(valid); err != nil || !completed {
		t.Fatalf("current Foundation success envelope must verify: completed=%t err=%v", completed, err)
	}
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "receipt must be object", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"] = "non-empty-but-not-object"
		}},
		{name: "operation id mismatch", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"].(map[string]any)["operationId"] = "different-operation"
		}},
		{name: "verifier missing", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"].(map[string]any)["verifierId"] = ""
		}},
		{name: "verification pending", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"].(map[string]any)["verificationState"] = "pending"
		}},
		{name: "verified at invalid", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"].(map[string]any)["verifiedAt"] = "not-iso"
		}},
		{name: "capability mismatch", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"].(map[string]any)["semanticIdentity"].(map[string]any)["capabilityId"] = "other.capability"
		}},
		{name: "action mismatch", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"].(map[string]any)["semanticIdentity"].(map[string]any)["actionId"] = "cluster.plan"
		}},
		{name: "tool mismatch", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"].(map[string]any)["semanticIdentity"].(map[string]any)["toolId"] = "foundation.postgres.plan.create"
		}},
		{name: "binding method mismatch", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"].(map[string]any)["actionBinding"].(map[string]any)["method"] = "GET"
		}},
		{name: "binding path mismatch", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"].(map[string]any)["actionBinding"].(map[string]any)["path"] = "/api/foundation/oaa/postgres/durable-plan"
		}},
		{name: "evidence revision mismatch", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"].(map[string]any)["ownerEvidenceRevision"] = "older-revision"
		}},
		{name: "evidence revision missing", mutate: func(operation map[string]any) { delete(operation["completion"].(map[string]any), "evidenceRevision") }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			operation := cloneOperationFixture(valid)
			test.mutate(operation)
			completed, err := canonicalOperationCompleted(operation)
			var cliErr *CLIError
			if completed || !errors.As(err, &cliErr) || cliErr.Code != "OperationEvidenceIncomplete" || exitCode(err) != 6 {
				t.Fatalf("invalid receipt must fail closed: completed=%t err=%T %#v exit=%d", completed, err, cliErr, exitCode(err))
			}
		})
	}
}

func TestDynamicOperationWatchTimeoutIsStable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"stage": "Reconciling", "stale": false})
	}))
	defer server.Close()
	err := watchDynamicOperation(context.Background(), Config{PAT: "test", Output: "json"}, Tool{ID: "owner.operation.watch"}, server.URL, map[string]string{"interval": "10ms", "timeout": "35ms"}, &bytes.Buffer{})
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != "OperationTimeout" || exitCode(err) != 7 {
		t.Fatalf("timeout must be stable: %T %#v exit=%d", err, cliErr, exitCode(err))
	}
}

func TestDynamicOperationWatchDispatchesPollingFromManifest(t *testing.T) {
	var operationRequests atomic.Int32
	manifest := ToolManifest{Kind: "OpenSphereCLICommandManifest", Tools: []Tool{{
		ID: "owner.operation.watch", Command: "os owner operation watch <operationId>", Method: "GET", Path: "/operations/{operationId}",
		Description: "Watch owner operation", ExecutionClass: executionClassConsoleAPI, PathParams: []string{"operationId"},
		InputSchema: &ToolInputSchema{Type: "object", Properties: map[string]*ToolInputSchema{}},
	}}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/registry":
			_ = json.NewEncoder(w).Encode(Registry{Version: 3, Capabilities: []map[string]any{}, Templates: []map[string]any{}, TrustedKeys: map[string]any{}, Plugins: []RegistryItem{{
				ID: "owner", Name: "Owner", Available: true,
				CLI: &CLIContribution{Namespace: "owner", APIBase: "/api", ManifestPath: "/manifest"},
			}}})
		case "/api/manifest":
			_ = json.NewEncoder(w).Encode(manifest)
		case "/api/operations/op-1":
			stage := "Reconciling"
			operation := map[string]any{"operationId": "op-1", "stage": stage, "stale": false}
			if operationRequests.Add(1) > 1 {
				operation = foundationCompletionFixture("op-1")
			}
			_ = json.NewEncoder(w).Encode(operation)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("OS_CONFIG", filepath.Join(t.TempDir(), "missing-config.json"))
	t.Setenv("OS_CONSOLE", server.URL)
	t.Setenv("OS_REGISTRY", server.URL+"/registry")
	t.Setenv("OS_PAT", "test")
	var out bytes.Buffer
	err := run([]string{"owner", "operation", "watch", "op-1", "--interval", "10ms", "--timeout", "1s", "--output", "json"}, strings.NewReader(""), &out, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if operationRequests.Load() != 2 || !strings.Contains(out.String(), `"foundation.postgres.apply"`) {
		t.Fatalf("dynamic dispatch did not poll to Ready: requests=%d output=%s", operationRequests.Load(), out.String())
	}
}

func TestDynamicNamespaceHelpUsesOwnerManifest(t *testing.T) {
	manifest := ToolManifest{Kind: "OpenSphereCLICommandManifest", Tools: []Tool{
		{ID: "foundation.readiness", Command: "os foundation readiness", Method: "GET", Path: "/readiness", Description: "Owner readiness", ExecutionClass: executionClassConsoleAPI},
		{ID: "foundation.plan", Command: "os foundation plan create", Method: "POST", Path: "/plan", Description: "Owner plan", ExecutionClass: executionClassConsoleAPI,
			InputSchema: &ToolInputSchema{Type: "object", Required: []string{"name"}, Properties: map[string]*ToolInputSchema{"name": {Type: "string"}}}},
	}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/registry":
			_ = json.NewEncoder(w).Encode(Registry{Version: 3, Capabilities: []map[string]any{}, Templates: []map[string]any{}, TrustedKeys: map[string]any{}, Plugins: []RegistryItem{{
				ID: "foundation", Name: "Foundation", Available: true,
				CLI: &CLIContribution{Namespace: "foundation", APIBase: "/owner", ManifestPath: "/manifest"},
			}}})
		case "/owner/manifest":
			_ = json.NewEncoder(w).Encode(manifest)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("OS_CONFIG", filepath.Join(t.TempDir(), "missing-config.json"))
	t.Setenv("OS_CONSOLE", server.URL)
	t.Setenv("OS_REGISTRY", server.URL+"/registry")
	t.Setenv("OS_PAT", "test")
	var namespaceHelp bytes.Buffer
	if err := run([]string{"foundation", "--help"}, strings.NewReader(""), &namespaceHelp, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(namespaceHelp.String(), "os foundation readiness") || !strings.Contains(namespaceHelp.String(), "os foundation plan create") {
		t.Fatalf("namespace help did not use owner manifest: %s", namespaceHelp.String())
	}
	var commandHelp bytes.Buffer
	if err := run([]string{"foundation", "plan", "create", "--help"}, strings.NewReader(""), &commandHelp, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(commandHelp.String(), "--name") || !strings.Contains(commandHelp.String(), "required") {
		t.Fatalf("command help did not project owner schema: %s", commandHelp.String())
	}
}
