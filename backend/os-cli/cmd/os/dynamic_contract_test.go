package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
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
	planDigest := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	actionDigest := "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	actor := map[string]any{"id": "operator-1", "binding": "workforce-binding-1"}
	fencing := map[string]any{"token": "fence-7"}
	postcondition := map[string]any{"targetUid": "uid-1", "generation": 3, "resourceVersion": "42"}
	return map[string]any{
		"operationId": operationID, "phase": "Succeeded", "verificationState": "succeeded",
		"verifierId": "foundation-control-plane", "stage": "Ready", "operationPhase": "Succeeded",
		"contractVersion": "pfss-postgres-owner/v1", "sourceRevision": "owner-source-revision",
		"capabilityId": "data.sql.postgres", "requestType": "Instance",
		"planDigest": planDigest, "actionDigest": actionDigest, "actor": actor,
		"fencing": fencing, "postcondition": postcondition,
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
				"planDigest": planDigest, "actionDigest": actionDigest, "actor": actor,
				"fencing": fencing, "postcondition": postcondition,
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
		{name: "plan digest omitted", mutate: func(operation map[string]any) {
			delete(operation["completion"].(map[string]any)["receipt"].(map[string]any), "planDigest")
		}},
		{name: "action digest mismatch", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"].(map[string]any)["actionDigest"] = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
		}},
		{name: "actor binding omitted", mutate: func(operation map[string]any) {
			delete(operation["completion"].(map[string]any)["receipt"].(map[string]any)["actor"].(map[string]any), "binding")
		}},
		{name: "fencing token mismatch", mutate: func(operation map[string]any) {
			operation["completion"].(map[string]any)["receipt"].(map[string]any)["fencing"].(map[string]any)["token"] = "other-fence"
		}},
		{name: "postcondition version omitted", mutate: func(operation map[string]any) {
			delete(operation["completion"].(map[string]any)["receipt"].(map[string]any)["postcondition"].(map[string]any), "resourceVersion")
		}},
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
			_ = json.NewEncoder(w).Encode(Registry{Version: 3, Capabilities: []map[string]any{}, Templates: []map[string]any{}, TrustedKeys: map[string]any{"foundation-key": true}, Plugins: []RegistryItem{{
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

func frozenPFSSOwnerManifest() ToolManifest {
	denyAdditional := false
	sourceRevision := strings.Repeat("a", 40)
	emptyInput := func() *ToolInputSchema {
		return &ToolInputSchema{Type: "object", AdditionalProperties: &denyAdditional, Properties: map[string]*ToolInputSchema{}}
	}
	pathParams := func(values []string) []any {
		result := make([]any, 0, len(values))
		for _, value := range values {
			result = append(result, value)
		}
		return result
	}
	tool := func(id, actionID, command, method, path string, params []string, input *ToolInputSchema, approval string) Tool {
		binding := map[string]any{"method": method, "path": path}
		if len(params) > 0 {
			binding["pathParams"] = pathParams(params)
		}
		if approval != "" {
			binding["approval"] = approval
		}
		scope := ""
		if actionID == "cluster.plan" {
			scope = "write-plan"
		}
		risk := "R0"
		if actionID == "cluster.plan" || actionID == "cluster.create" {
			risk = "R2"
		}
		return Tool{
			ID: id, ActionID: actionID, CapabilityID: "data.sql.postgres", Command: command,
			Method: method, Path: path, PathParams: params, RequestType: "Instance", ContractVersion: "v1", SourceRevision: sourceRevision, Risk: risk,
			InputSchema: input, ExecutionClass: executionClassConsoleAPI, Scope: scope, ExplicitAction: actionID == "cluster.create",
			SemanticIdentity: &ToolSemanticIdentity{ActionID: actionID, CapabilityID: "data.sql.postgres", RequestType: "Instance", ToolID: id},
			ActionBinding:    binding,
		}
	}
	planInput := emptyInput()
	planInput.Required = []string{"name"}
	planInput.Properties["name"] = &ToolInputSchema{Type: "string"}
	planInput.Properties["settings"] = &ToolInputSchema{Type: "object", AdditionalProperties: &denyAdditional, Properties: map[string]*ToolInputSchema{
		"engine": {Type: "string"},
	}}
	planInput.Properties["extensions"] = &ToolInputSchema{Type: "array", Items: &ToolInputSchema{Type: "object", AdditionalProperties: &denyAdditional, Properties: map[string]*ToolInputSchema{
		"name": {Type: "string"},
	}}}
	applyInput := emptyInput()
	applyInput.Required = []string{"confirmation"}
	applyInput.Properties["confirmation"] = &ToolInputSchema{Type: "string"}
	return ToolManifest{
		Kind: "OpenSphereCLICommandManifest", SchemaVersion: "v1", CapabilityID: "data.sql.postgres", ContractVersion: "v1", SourceRevision: sourceRevision,
		Tools: []Tool{
			tool("foundation.capabilities", "capability.read", "os foundation capabilities", http.MethodGet, "/api/foundation/oaa/postgres/capabilities", nil, emptyInput(), ""),
			tool("foundation.readiness", "readiness.read", "os foundation readiness", http.MethodGet, "/api/foundation/oaa/postgres/readiness", nil, emptyInput(), ""),
			tool("foundation.postgres.catalog", "catalog.read", "os foundation postgres catalog", http.MethodGet, "/api/foundation/oaa/postgres/catalog", nil, emptyInput(), ""),
			tool("foundation.postgres.status", "cluster.status", "os foundation postgres status <namespace> <name>", http.MethodGet, "/api/foundation/oaa/postgres/claims/{namespace}/{name}", []string{"namespace", "name"}, emptyInput(), ""),
			tool("foundation.postgres.plan.create", "cluster.plan", "os foundation postgres plan create", http.MethodPost, "/api/foundation/oaa/postgres/durable-plan", nil, planInput, ""),
			tool("foundation.postgres.apply", "cluster.create", "os foundation postgres apply <planId>", http.MethodPost, "/api/foundation/oaa/postgres/durable-apply/{planId}", []string{"planId"}, applyInput, "exact-confirmation"),
			tool("foundation.operation.watch", "operation.watch", "os foundation operation watch <operationId>", http.MethodGet, "/api/foundation/oaa/operations/{operationId}", []string{"operationId"}, emptyInput(), ""),
		},
	}
}

func frozenPFSSRegistryReleaseBinding(manifest ToolManifest) *pfssRegistryReleaseBinding {
	return &pfssRegistryReleaseBinding{
		PluginID: "foundation", KeyID: "foundation-key", ManifestSHA256: strings.Repeat("b", 64),
		InstalledDigest: "sha256:" + strings.Repeat("c", 64), SourceRevision: manifest.SourceRevision,
	}
}

func TestPFSSOwnerManifestRequiresExactVerifiedRegistryReleaseBinding(t *testing.T) {
	manifest := frozenPFSSOwnerManifest()
	if err := validateToolManifest(manifest); err == nil {
		t.Fatal("PFSS manifest without a verified Registry release binding must fail closed")
	}
	binding := frozenPFSSRegistryReleaseBinding(manifest)
	if err := validateToolManifestWithPFSSReleaseBinding(manifest, binding); err != nil {
		t.Fatalf("exact verified Registry release binding must validate: %v", err)
	}
	for _, test := range []struct {
		name   string
		mutate func(*ToolManifest)
	}{
		{name: "source revision", mutate: func(value *ToolManifest) { value.SourceRevision = strings.Repeat("b", 40) }},
		{name: "descriptor digest", mutate: func(value *ToolManifest) { value.DescriptorDigest = "sha256:" + strings.Repeat("e", 64) }},
		{name: "release digest", mutate: func(value *ToolManifest) { value.ReleaseDigest = "sha256:" + strings.Repeat("f", 64) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate := frozenPFSSOwnerManifest()
			test.mutate(&candidate)
			err := validateToolManifestWithPFSSReleaseBinding(candidate, binding)
			var cliErr *CLIError
			if !errors.As(err, &cliErr) || cliErr.Code != "CommandContractInvalid" || exitCode(err) != 2 {
				t.Fatalf("format-valid unverified release value must fail closed: %T %v", err, err)
			}
		})
	}
}

func TestPFSSRegistryReleaseBindingRejectsUnverifiedOrReusedPluginIdentity(t *testing.T) {
	manifestDigest := strings.Repeat("d", 64)
	item := RegistryItem{
		ID: "foundation", Name: "Foundation", Available: true, ManifestSHA256: manifestDigest,
		KeyID: "foundation-key", InstalledDigest: "sha256:" + strings.Repeat("e", 64), SourceRevision: strings.Repeat("a", 40),
		CLI: &CLIContribution{Namespace: "foundation", APIBase: "/", ManifestPath: "/manifest"},
	}
	registry := Registry{TrustedKeys: map[string]any{"foundation-key": true}}
	if _, err := expectedPFSSRegistryReleaseBinding(registry, item, manifestDigest); err != nil {
		t.Fatalf("verified Foundation Registry identity must bind: %v", err)
	}
	duplicate := Registry{Version: 3, Capabilities: []map[string]any{}, Templates: []map[string]any{}, TrustedKeys: registry.TrustedKeys, Plugins: []RegistryItem{item, {
		ID: "other-plugin", Name: "Other", Available: true, CLI: &CLIContribution{Namespace: "foundation", APIBase: "/other", ManifestPath: "/manifest"},
	}}}
	if err := validateRegistry(duplicate); err == nil {
		t.Fatal("duplicate available Foundation CLI namespace must fail closed before item selection")
	}
	for _, test := range []struct {
		name   string
		mutate func(*RegistryItem, *Registry, *string)
	}{
		{name: "manifest digest mismatch", mutate: func(value *RegistryItem, _ *Registry, actual *string) { *actual = strings.Repeat("f", 64) }},
		{name: "installed digest malformed", mutate: func(value *RegistryItem, _ *Registry, _ *string) { value.InstalledDigest = "sha256:not-a-digest" }},
		{name: "untrusted key", mutate: func(value *RegistryItem, _ *Registry, _ *string) { value.KeyID = "other-key" }},
		{name: "other plugin reuse", mutate: func(value *RegistryItem, _ *Registry, _ *string) { value.ID = "other-plugin" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate := item
			candidateRegistry := registry
			actual := manifestDigest
			test.mutate(&candidate, &candidateRegistry, &actual)
			err := func() error {
				_, err := expectedPFSSRegistryReleaseBinding(candidateRegistry, candidate, actual)
				return err
			}()
			var cliErr *CLIError
			if !errors.As(err, &cliErr) || cliErr.Code != "CommandContractInvalid" || exitCode(err) != 2 {
				t.Fatalf("unverified Registry release identity must fail closed: %T %v", err, err)
			}
		})
	}
}

func TestPFSSOwnerManifestRejectsMutationWithoutClosedInputSchema(t *testing.T) {
	manifest := frozenPFSSOwnerManifest()
	binding := frozenPFSSRegistryReleaseBinding(manifest)
	for index := range manifest.Tools {
		if manifest.Tools[index].ActionID == "cluster.create" {
			manifest.Tools[index].InputSchema = nil
		}
	}
	err := validateToolManifestWithPFSSReleaseBinding(manifest, binding)
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != "CommandContractInvalid" || exitCode(err) != 2 {
		t.Fatalf("PFSS mutation without a closed schema must fail closed: %T %v", err, err)
	}
}

func TestPFSSOwnerManifestRejectsPublishedSevenBypass(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*ToolManifest)
	}{
		{name: "unpublished lifecycle", mutate: func(manifest *ToolManifest) {
			manifest.Tools[4].ActionID = "cluster.update"
		}},
		{name: "arbitrary route", mutate: func(manifest *ToolManifest) {
			manifest.Tools[4].Path = "/api/foundation/oaa/postgres/durable-update"
			manifest.Tools[4].ActionBinding["path"] = manifest.Tools[4].Path
		}},
		{name: "risk downgrade", mutate: func(manifest *ToolManifest) {
			manifest.Tools[5].Risk = "R0"
		}},
		{name: "explicit action injection", mutate: func(manifest *ToolManifest) {
			manifest.Tools[4].ExplicitAction = true
		}},
		{name: "extra lifecycle", mutate: func(manifest *ToolManifest) {
			denyAdditional := false
			manifest.Tools = append(manifest.Tools, Tool{ID: "foundation.postgres.delete", ActionID: "cluster.delete", CapabilityID: "data.sql.postgres", Command: "os foundation postgres delete <name>", Method: http.MethodPost, Path: "/api/foundation/oaa/postgres/durable-delete/{name}", RequestType: "Instance", ContractVersion: "v1", SourceRevision: manifest.SourceRevision, Risk: "R2", ExplicitAction: true, PathParams: []string{"name"}, SemanticIdentity: &ToolSemanticIdentity{ActionID: "cluster.delete", CapabilityID: "data.sql.postgres", RequestType: "Instance", ToolID: "foundation.postgres.delete"}, ActionBinding: map[string]any{"method": http.MethodPost, "path": "/api/foundation/oaa/postgres/durable-delete/{name}", "pathParams": []any{"name"}}, InputSchema: &ToolInputSchema{Type: "object", AdditionalProperties: &denyAdditional}})
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := frozenPFSSOwnerManifest()
			binding := frozenPFSSRegistryReleaseBinding(manifest)
			test.mutate(&manifest)
			err := validateToolManifestWithPFSSReleaseBinding(manifest, binding)
			var cliErr *CLIError
			if !errors.As(err, &cliErr) || cliErr.Code != "CommandContractInvalid" || exitCode(err) != 2 {
				t.Fatalf("published-seven bypass must fail closed: %T %v", err, err)
			}
		})
	}
}

func TestPFSSOwnerManifestRejectsNestedLooseSchemasAndPayloadExtras(t *testing.T) {
	for _, property := range []string{"settings", "extensions"} {
		t.Run(property+" closure", func(t *testing.T) {
			manifest := frozenPFSSOwnerManifest()
			binding := frozenPFSSRegistryReleaseBinding(manifest)
			for index := range manifest.Tools {
				if manifest.Tools[index].ActionID == "cluster.plan" {
					schema := manifest.Tools[index].InputSchema.Properties[property]
					if schema.Type == "array" {
						schema = schema.Items
					}
					schema.AdditionalProperties = nil
				}
			}
			if err := validateToolManifestWithPFSSReleaseBinding(manifest, binding); err == nil {
				t.Fatalf("nested PFSS %s without additionalProperties:false must be rejected", property)
			}
		})
	}

	manifest := frozenPFSSOwnerManifest()
	var plan Tool
	for _, tool := range manifest.Tools {
		if tool.ActionID == "cluster.plan" {
			plan = tool
		}
	}
	plan.SupportsFile = true
	_, err := dynamicPayload(plan, map[string]string{"file": "-"}, strings.NewReader(`{"name":"orders","extensions":[{"name":"pgvector","unexpected":true}]}`))
	if err == nil || exitCode(err) != 2 || !strings.Contains(err.Error(), "manifest schema에 없는 입력 필드") {
		t.Fatalf("nested PFSS payload extra field must fail closed: %T %v", err, err)
	}
}

func TestManifestRejectsDuplicateNormalizedCommandPrefix(t *testing.T) {
	manifest := ToolManifest{Kind: "OpenSphereCLICommandManifest", Tools: []Tool{
		{ID: "data.plan", Command: "os data plan", Method: http.MethodGet, Path: "/plan"},
		{ID: "data.plan.alias", Command: "OS data PLAN <ignored>", Method: http.MethodGet, Path: "/plan-alias"},
	}}
	err := validateToolManifest(manifest)
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != "CommandContractInvalid" || exitCode(err) != 2 {
		t.Fatalf("duplicate normalized command prefix must fail closed: %T %v", err, err)
	}
}

func TestDynamicDispatchRejectsAmbiguousMaximalPrefix(t *testing.T) {
	_, err := selectDynamicTool([]Tool{
		{ID: "data.plan.a", Command: "os data plan"},
		{ID: "data.plan.b", Command: "os data plan <ignored>"},
	}, "data", []string{"plan"})
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != "CommandContractInvalid" || exitCode(err) != 2 {
		t.Fatalf("ambiguous maximal prefix must fail closed: %T %v", err, err)
	}
}

func TestPFSSReceiptRejectsUnpublishedLifecycleAction(t *testing.T) {
	manifest := frozenPFSSOwnerManifest()
	binding := frozenPFSSRegistryReleaseBinding(manifest)
	actions, err := ownerReceiptActions(manifest, binding)
	if err != nil {
		t.Fatal(err)
	}
	operation := foundationCompletionFixture("op-unpublished")
	receipt := operation["completion"].(map[string]any)["receipt"].(map[string]any)
	receipt["semanticIdentity"].(map[string]any)["actionId"] = "cluster.update"
	receipt["actionBinding"].(map[string]any)["path"] = "/api/foundation/oaa/postgres/durable-update/{planId}"
	completed, err := canonicalOperationCompletedForActions(operation, actions)
	var cliErr *CLIError
	if completed || !errors.As(err, &cliErr) || cliErr.Code != "OperationEvidenceIncomplete" || exitCode(err) != 6 {
		t.Fatalf("unpublished lifecycle receipt must remain unavailable: completed=%t err=%T %v", completed, err, err)
	}
}

func TestDynamicPFSSPublishedLifecycleUsesLongestPrefixAndPreservesEvidence(t *testing.T) {
	manifest := frozenPFSSOwnerManifest()
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestDigest := sha256.Sum256(manifestBytes)
	requested := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		requested[r.Method+" "+r.URL.Path]++
		if r.Method == http.MethodPost {
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode owner request: %v", err)
			}
			if r.URL.Path == "/api/foundation/oaa/postgres/durable-plan" && payload["name"] != "orders" {
				t.Fatalf("plan payload=%#v", payload)
			}
			if r.URL.Path == "/api/foundation/oaa/postgres/durable-apply/plan-1" && payload["confirmation"] != "apply orders" {
				t.Fatalf("apply payload=%#v", payload)
			}
		}
		switch r.URL.Path {
		case "/registry":
			_ = json.NewEncoder(w).Encode(Registry{Version: 3, Capabilities: []map[string]any{}, Templates: []map[string]any{}, TrustedKeys: map[string]any{"foundation-key": true}, Plugins: []RegistryItem{{
				ID: "foundation", Name: "Foundation", Available: true, ManifestSHA256: fmt.Sprintf("%x", manifestDigest), KeyID: "foundation-key",
				InstalledDigest: "sha256:" + strings.Repeat("c", 64), SourceRevision: manifest.SourceRevision,
				CLI: &CLIContribution{Namespace: "foundation", APIBase: "/", ManifestPath: "/manifest"},
			}}})
		case "/manifest":
			_, _ = w.Write(manifestBytes)
		case "/api/foundation/oaa/operations/op-1":
			operation := foundationCompletionFixture("op-1")
			operation["z"] = "last"
			operation["a"] = "first"
			_ = json.NewEncoder(w).Encode(operation)
		default:
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer server.Close()
	t.Setenv("OS_CONFIG", filepath.Join(t.TempDir(), "missing-config.json"))
	t.Setenv("OS_CONSOLE", server.URL)
	t.Setenv("OS_REGISTRY", server.URL+"/registry")
	t.Setenv("OS_PAT", "test")
	commands := [][]string{
		{"foundation", "capabilities"}, {"foundation", "readiness"}, {"foundation", "postgres", "catalog"},
		{"foundation", "postgres", "status", "opensphere-foundation", "orders"},
		{"foundation", "postgres", "plan", "create", "--name", "orders"},
		{"foundation", "postgres", "apply", "plan-1", "--confirmation", "apply orders"},
	}
	for _, command := range commands {
		if err := run(command, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}); err != nil {
			t.Fatalf("%v: %v", command, err)
		}
	}
	var output bytes.Buffer
	if err := run([]string{"foundation", "operation", "watch", "op-1", "--interval", "10ms", "--timeout", "1s", "--output", "json"}, strings.NewReader(""), &output, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{
		"GET /api/foundation/oaa/postgres/capabilities", "GET /api/foundation/oaa/postgres/readiness", "GET /api/foundation/oaa/postgres/catalog", "GET /api/foundation/oaa/postgres/claims/opensphere-foundation/orders",
		"POST /api/foundation/oaa/postgres/durable-plan", "POST /api/foundation/oaa/postgres/durable-apply/plan-1", "GET /api/foundation/oaa/operations/op-1",
	} {
		if requested[route] != 1 {
			t.Fatalf("owner route %q count=%d", route, requested[route])
		}
	}
	text := output.String()
	for _, field := range []string{"planDigest", "actionDigest", "actor", "operationId", "fencing", "postcondition", "receipt"} {
		if !strings.Contains(text, `"`+field+`"`) {
			t.Fatalf("canonical output lost %s: %s", field, text)
		}
	}
	if strings.Index(text, `"a"`) > strings.Index(text, `"z"`) {
		t.Fatalf("canonical JSON keys were not sorted: %s", text)
	}
}

func TestDynamicDispatchSelectsLongestManifestPrefix(t *testing.T) {
	manifest := ToolManifest{Kind: "OpenSphereCLICommandManifest", Tools: []Tool{
		{ID: "data.plan", Command: "os data plan", Method: http.MethodGet, Path: "/plan"},
		{ID: "data.plan.create", Command: "os data plan create", Method: http.MethodGet, Path: "/plan/create"},
	}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/registry":
			_ = json.NewEncoder(w).Encode(Registry{Version: 3, Capabilities: []map[string]any{}, Templates: []map[string]any{}, TrustedKeys: map[string]any{}, Plugins: []RegistryItem{{
				ID: "data", Name: "Data", Available: true, CLI: &CLIContribution{Namespace: "data", APIBase: "/api", ManifestPath: "/manifest"},
			}}})
		case "/api/manifest":
			_ = json.NewEncoder(w).Encode(manifest)
		case "/api/plan/create":
			_, _ = w.Write([]byte(`{"selected":"child"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("OS_CONFIG", filepath.Join(t.TempDir(), "missing-config.json"))
	t.Setenv("OS_CONSOLE", server.URL)
	t.Setenv("OS_REGISTRY", server.URL+"/registry")
	t.Setenv("OS_PAT", "test")
	var output bytes.Buffer
	if err := run([]string{"data", "plan", "create"}, strings.NewReader(""), &output, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"selected": "child"`) {
		t.Fatalf("longest nested command was not selected: %s", output.String())
	}
}
