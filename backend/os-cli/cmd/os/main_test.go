package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestHelpDeclaresNativeAdminBoundary(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"help"}, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"Console native 관리자 CLI", "Supabase RBAC", "admin 디바이스 신뢰", "workforce", "CLI Binding", "extensions install", "15분 서명 세션"} {
		if !strings.Contains(out.String(), expected) {
			t.Fatalf("help missing %q", expected)
		}
	}
}

func TestNativeCommandContractRejectsUnknownFlagsAndUnexpectedArguments(t *testing.T) {
	t.Setenv("OS_CONFIG", filepath.Join(t.TempDir(), "config.json"))
	for _, args := range [][]string{
		{"whoami", "--nonsense-flag", "value"},
		{"whoami", "unexpected"},
		{"status", "--strict"},
		{"token", "create", "unexpected", "--label", "test", "--reason", "eight chars"},
		{"events", "--limit", "0"},
		{"events", "--filter", "missing-equals"},
		{"operation", "watch", "request-id", "--timeout", "never"},
		{"registry", "--kind", "unknown"},
		{"events", "--limit", "10", "--limit", "20"},
		{"login", "--console", "http://console.example.test"},
		{"apply", "not-a-plan-id"},
		{"rollback", "bad-id", "--consumer", "manual", "--file", "desired.json", "--reason", "eight chars"},
	} {
		err := run(args, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{})
		var usageErr *UsageError
		if !errors.As(err, &usageErr) || exitCode(err) != 2 {
			t.Fatalf("%v must fail as typed usage error with exit 2, got %T %v exit=%d", args, err, err, exitCode(err))
		}
	}
}

func TestSubcommandHelpIsLocalAndCompletionUsesSameCatalog(t *testing.T) {
	for _, command := range []string{"status", "get", "token", "update"} {
		var out bytes.Buffer
		if err := run([]string{command, "--help"}, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
			t.Fatalf("%s --help failed: %v", command, err)
		}
		if !strings.Contains(out.String(), "사용법:") || !strings.Contains(out.String(), "os "+command) {
			t.Fatalf("%s --help was not command-specific: %q", command, out.String())
		}
	}
	var help, completionOut bytes.Buffer
	printHelp(&help)
	if err := completion([]string{"bash"}, &completionOut); err != nil {
		t.Fatal(err)
	}
	for _, command := range completionCommandNames() {
		if command != "help" && !strings.Contains(help.String(), command) {
			t.Fatalf("completion command %q is absent from root help", command)
		}
		if !strings.Contains(completionOut.String(), command) {
			t.Fatalf("command %q is absent from completion", command)
		}
	}
}

func TestCommandSpecificTableProjectionAvoidsNestedJSONCells(t *testing.T) {
	value := map[string]any{"items": []any{map[string]any{
		"kind":     "Component",
		"metadata": map[string]any{"name": "console", "namespace": "opensphere-console", "annotations": map[string]any{"large": "blob"}},
		"spec":     map[string]any{"owner": "platform", "lifecycle": "production", "system": "opensphere", "nested": map[string]any{"large": "blob"}},
	}}}
	var out bytes.Buffer
	if err := writeTableForCommand(&out, value, "catalog list"); err != nil {
		t.Fatal(err)
	}
	result := out.String()
	for _, expected := range []string{"NAME", "KIND", "OWNER", "console", "platform", "production"} {
		if !strings.Contains(result, expected) {
			t.Fatalf("catalog table missing %q: %s", expected, result)
		}
	}
	if strings.Contains(result, "annotations") || strings.Contains(result, "nested") || strings.Contains(result, "{\"") {
		t.Fatalf("catalog table leaked nested JSON cell: %s", result)
	}
}

func TestDynamicModuleCommandsIgnoreManifestFlagsAndNormalizePayloadKeys(t *testing.T) {
	if got := strings.Join(toolCommandPrefix("os ai vector query --namespace <ns> --collection <name>", "ai"), " "); got != "vector query" {
		t.Fatalf("unexpected dynamic command prefix: %q", got)
	}
	if got := strings.Join(toolCommandPrefix("os ai gpu bridge <health|capabilities> --apply", "ai"), " "); got != "gpu bridge" {
		t.Fatalf("unexpected operation command prefix: %q", got)
	}
	payload := jsonFlagPayload(map[string]string{"credential-secret": "gpu-token", "max-concurrency": "2", "apply": "true"})
	if payload["credentialSecret"] != "gpu-token" || payload["maxConcurrency"] != "2" || payload["apply"] != "true" {
		t.Fatalf("flag payload was not normalized: %#v", payload)
	}
}

func TestLongFlagsAcceptEqualsSyntax(t *testing.T) {
	flags := parseLongFlags([]string{"--reason=reviewed-change", "--wait", "--timeout", "5m"})
	if flags["reason"] != "reviewed-change" || flags["wait"] != "true" || flags["timeout"] != "5m" {
		t.Fatalf("long flags were parsed incorrectly: %#v", flags)
	}
}

func TestJSONCallRejectsSuccessfulHTMLFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("<!doctype html><title>SPA fallback</title>"))
	}))
	defer server.Close()
	cfg := defaults()
	cfg.PAT = "test-token"
	var out bytes.Buffer
	err := jsonCall(cfg, http.MethodGet, server.URL+"/api/catalog/entities", nil, &out)
	if err == nil || !strings.Contains(err.Error(), "JSON 대신 text/html") {
		t.Fatalf("HTML fallback must fail closed, got err=%v out=%q", err, out.String())
	}
}

func TestRequireOKNeverEchoesHTML(t *testing.T) {
	err := requireOK([]byte("<html><body><h1>405 Not Allowed</h1></body></html>"), http.StatusMethodNotAllowed)
	if err == nil {
		t.Fatal("non-JSON API error must fail")
	}
	if strings.Contains(strings.ToLower(err.Error()), "<html") || !strings.Contains(err.Error(), "JSON이 아닌 응답") {
		t.Fatalf("HTML must not be echoed to the terminal: %v", err)
	}
}

func TestRequireOKUsesJSONErrorMessage(t *testing.T) {
	err := requireOK([]byte(`{"error":"method_not_allowed","message":"GET 또는 HEAD만 허용됩니다"}`), http.StatusMethodNotAllowed)
	if err == nil || !strings.Contains(err.Error(), "GET 또는 HEAD만 허용됩니다") {
		t.Fatalf("structured JSON error must remain useful: %v", err)
	}
}

func TestGlobalOutputRenderingAndExitCodes(t *testing.T) {
	args, output, err := extractGlobalOptions([]string{"catalog", "list", "--output=table"})
	if err != nil || output != "table" || strings.Join(args, " ") != "catalog list" {
		t.Fatalf("global output parsing failed: args=%v output=%q err=%v", args, output, err)
	}
	var table bytes.Buffer
	if err := renderOutput(Config{Output: "table"}, &table, []byte(`[{"name":"console","status":"Ready"}]`)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(table.String(), "NAME") || !strings.Contains(table.String(), "Ready") {
		t.Fatalf("table output is not useful: %q", table.String())
	}
	var yaml bytes.Buffer
	if err := renderOutput(Config{Output: "yaml"}, &yaml, []byte(`{"status":"Ready","count":2}`)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(yaml.String(), `"status": "Ready"`) {
		t.Fatalf("yaml output missing value: %q", yaml.String())
	}
	if got := exitCode(&CLIError{Status: http.StatusForbidden}); got != 4 {
		t.Fatalf("forbidden exit code=%d want 4", got)
	}
	if got := exitCode(&CLIError{Status: http.StatusServiceUnavailable}); got != 7 {
		t.Fatalf("unavailable exit code=%d want 7", got)
	}
}

func TestListTransformFiltersSortsAndLimits(t *testing.T) {
	raw := []byte(`[{"name":"b","status":"Ready"},{"name":"a","status":"Blocked"},{"name":"c","status":"Ready"}]`)
	transformed, err := transformJSONList(raw, map[string]string{"filter": "status=ready", "sort-by": "name", "desc": "true", "limit": "1"})
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	if json.Unmarshal(transformed, &rows) != nil || len(rows) != 1 || rows[0]["name"] != "c" {
		t.Fatalf("list controls produced wrong result: %s", transformed)
	}
	if _, err := transformJSONList(raw, map[string]string{"limit": "0"}); err == nil {
		t.Fatal("invalid limit must fail")
	}
}

func TestBackboneCompatibilityAliasUsesCurrentAuthorities(t *testing.T) {
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "Ready"})
	}))
	defer server.Close()
	cfg := defaults()
	cfg.PAT, cfg.ConsoleURL = "test-token", server.URL
	var out, errOut bytes.Buffer
	if err := backbone(cfg, []string{"status"}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 1 || requests[0] != "/api/admin/platform-readiness/status" {
		t.Fatalf("backbone alias called retired route: %v", requests)
	}
	if !strings.Contains(errOut.String(), "호환 alias") {
		t.Fatalf("deprecation warning missing: %q", errOut.String())
	}
	requests = nil
	if err := backbone(cfg, []string{"detail", "--component", "gitea"}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 1 || requests[0] != "/api/platform/gitea/status" {
		t.Fatalf("gitea detail called wrong authority: %v", requests)
	}
}

func TestRetiredBackboneClaimCannotRegress(t *testing.T) {
	err := getResource(defaults(), []string{"backboneclaims"}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "폐기된 CBS/Backbone") || !strings.Contains(err.Error(), "consumercontracts") {
		t.Fatalf("retired resource must point to current contract authority: %v", err)
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Status != http.StatusGone {
		t.Fatalf("retired resource must be structured HTTP 410: %#v", err)
	}
}

func TestDoctorReportsOptionalMissingCRDsWithoutHidingThem(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "/apis/config.opensphere.io/") || strings.Contains(r.URL.Path, "/apis/platform.opensphere.io/") {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not found"}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"Ready","version":3,"capabilities":[],"plugins":[],"templates":[],"trustedKeys":{}}`))
	}))
	defer server.Close()
	cfg := defaults()
	cfg.PAT, cfg.ConsoleURL, cfg.IdentityURL, cfg.RegistryURL, cfg.APIURL = "test-token", server.URL, server.URL+"/api/identity/cli", server.URL+"/api/v1/registry", server.URL+"/api/proxy"
	var out bytes.Buffer
	if err := doctor(cfg, nil, &out); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Overall string        `json:"overall"`
		Checks  []doctorCheck `json:"checks"`
	}
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Overall != "Attention" || len(result.Checks) != 8 {
		t.Fatalf("doctor result=%#v", result)
	}
	failed := 0
	for _, check := range result.Checks {
		if check.Status == "Failed" && !check.Critical {
			failed++
		}
	}
	if failed != 2 {
		t.Fatalf("missing CRDs must remain visible as two optional failures, got %d", failed)
	}
}

func TestGovernedPlanIsTamperEvidentAndApplyIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OS_PLAN_DIR", filepath.Join(dir, "plans"))
	desiredPath := filepath.Join(dir, "desired.json")
	if err := os.WriteFile(desiredPath, []byte(`{"replicas":2,"databaseSecretRef":"console-db"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var submitted map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/platform/changes" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&submitted)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"accepted":true,"requestId":"11111111-1111-4111-8111-111111111111","status":"authorized"}`))
	}))
	defer server.Close()
	cfg := defaults()
	cfg.PAT, cfg.ConsoleURL = "test-token", server.URL
	plan, path, err := createPlan(cfg, []string{"--consumer", "console.core", "--action", "configure", "--target", "console", "--file", desiredPath, "--reason", "scale console safely", "--offline"}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := loadPlan(plan.ID); err != nil {
		t.Fatalf("fresh plan must verify: %v", err)
	}
	var out bytes.Buffer
	if err := applyPlan(cfg, []string{plan.ID}, &out); err != nil {
		t.Fatal(err)
	}
	key, _ := submitted["idempotencyKey"].(string)
	if !strings.HasPrefix(key, "os-plan:") || submitted["consumerId"] != "console.core" {
		t.Fatalf("governed submission contract is wrong: %#v", submitted)
	}
	raw, _ := os.ReadFile(path)
	var changed map[string]any
	_ = json.Unmarshal(raw, &changed)
	changed["target"] = "tampered"
	tampered, _ := json.Marshal(changed)
	if err := os.WriteFile(path, tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadPlan(plan.ID); err == nil || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("tampered plan must be rejected: %v", err)
	}
}

func TestGovernedPlanRejectsSecretMaterial(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OS_PLAN_DIR", filepath.Join(dir, "plans"))
	desiredPath := filepath.Join(dir, "desired.json")
	if err := os.WriteFile(desiredPath, []byte(`{"apiToken":"must-not-pass"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := createPlan(defaults(), []string{"--consumer", "console.core", "--file", desiredPath, "--reason", "safe declarative change"}, "", "")
	if err == nil || !strings.Contains(err.Error(), "비밀 원문") {
		t.Fatalf("secret-like declaration must fail closed: %v", err)
	}
}

func TestGovernedPlanPreflightRejectsUnknownConsumerUnlessOffline(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OS_PLAN_DIR", filepath.Join(dir, "plans"))
	desiredPath := filepath.Join(dir, "desired.json")
	if err := os.WriteFile(desiredPath, []byte(`{"replicas":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[{"consumer_id":"console.core","status":"active"}]}`))
	}))
	defer server.Close()
	cfg := defaults()
	cfg.PAT, cfg.ConsoleURL = "test-token", server.URL
	base := []string{"--consumer", "bogus-eval", "--file", desiredPath, "--reason", "validate consumer contract"}
	if _, _, err := createPlan(cfg, base, "", ""); err == nil || !strings.Contains(err.Error(), "consumer contract") {
		t.Fatalf("unknown online consumer must fail during planning: %v", err)
	}
	if _, _, err := createPlan(cfg, append(base, "--offline"), "", ""); err != nil {
		t.Fatalf("explicit offline planning must remain available: %v", err)
	}
}

func TestPlanLifecycleListShowDelete(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OS_PLAN_DIR", filepath.Join(dir, "plans"))
	desiredPath := filepath.Join(dir, "desired.json")
	if err := os.WriteFile(desiredPath, []byte(`{"replicas":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := defaults()
	plan, _, err := createPlan(cfg, []string{"--consumer", "console.core", "--file", desiredPath, "--reason", "lifecycle verification", "--offline"}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := planChange(cfg, []string{"list"}, &out); err != nil || !strings.Contains(out.String(), plan.ID) {
		t.Fatalf("plan list failed: out=%q err=%v", out.String(), err)
	}
	out.Reset()
	if err := planChange(cfg, []string{"show", plan.ID}, &out); err != nil || !strings.Contains(out.String(), plan.Digest) {
		t.Fatalf("plan show failed: out=%q err=%v", out.String(), err)
	}
	out.Reset()
	if err := planChange(cfg, []string{"delete", plan.ID, "--yes"}, &out); err != nil || !strings.Contains(out.String(), `"deleted": true`) {
		t.Fatalf("plan delete failed: out=%q err=%v", out.String(), err)
	}
	if _, err := loadPlan(plan.ID); err == nil {
		t.Fatal("deleted plan must no longer load")
	}
}

func TestCredentialExchangeRetriesOnlyTransientGatewayFailure(t *testing.T) {
	privateDER, _, err := generateDeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	originalLoad, originalSleep := deviceKeyLoad, sleepFn
	deviceKeyLoad = func(string) ([]byte, error) { return privateDER, nil }
	sleepFn = func(time.Duration) {}
	defer func() { deviceKeyLoad, sleepFn = originalLoad, originalSleep }()
	challenges := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/challenge":
			challenges++
			if challenges == 1 {
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(`{"error":"temporary gateway failure"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"challengeId": strings.Repeat("c", 32), "nonce": "fresh-nonce"})
		case "/session":
			_ = json.NewEncoder(w).Encode(map[string]string{"accessToken": "short-session"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	token, err := credentialToken(Config{DeviceID: strings.Repeat("d", 32), IdentityURL: server.URL})
	if err != nil || token != "short-session" || challenges != 2 {
		t.Fatalf("transient exchange did not recover: token=%q challenges=%d err=%v", token, challenges, err)
	}
}

func TestOperationWatchReusesSessionAndStopsAtApplied(t *testing.T) {
	requestID := "11111111-1111-4111-8111-111111111111"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		status := "authorized"
		if requests > 1 {
			status = "applied"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"changes": []any{map[string]any{"request_id": requestID, "status": status}}})
	}))
	defer server.Close()
	cfg := defaults()
	cfg.PAT, cfg.ConsoleURL = "one-process-session", server.URL
	originalSleep := sleepFn
	sleepFn = func(time.Duration) {}
	defer func() { sleepFn = originalSleep }()
	operation, err := watchOperation(cfg, requestID, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if operation["status"] != "applied" || requests != 2 {
		t.Fatalf("watch did not stop at applied: operation=%#v requests=%d", operation, requests)
	}
}

func TestRollbackCreatesLinkedPlanWithoutSubmitting(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OS_PLAN_DIR", filepath.Join(dir, "plans"))
	desiredPath := filepath.Join(dir, "previous.json")
	if err := os.WriteFile(desiredPath, []byte(`{"replicas":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	requestID := "11111111-1111-4111-8111-111111111111"
	var out bytes.Buffer
	err := rollbackChange(defaults(), []string{requestID, "--consumer", "console.core", "--target", "console", "--file", desiredPath, "--reason", "restore verified revision", "--offline"}, &out)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		PlanID     string `json:"planId"`
		RollbackOf string `json:"rollbackOf"`
	}
	if json.Unmarshal(out.Bytes(), &result) != nil || result.PlanID == "" || result.RollbackOf != requestID {
		t.Fatalf("rollback plan did not retain source request: %q", out.String())
	}
	plan, err := loadPlan(result.PlanID)
	if err != nil || plan.Action != "rollback" || plan.RollbackOf != requestID {
		t.Fatalf("linked rollback plan invalid: plan=%#v err=%v", plan, err)
	}
}

func TestNamedContextsPersistNoAutomationSecret(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OS_CONFIG", filepath.Join(dir, "config.json"))
	cfg := defaults()
	cfg.PAT = "process-only-token"
	var out bytes.Buffer
	if err := contexts(cfg, []string{"save", "local-admin"}, &out); err != nil {
		t.Fatal(err)
	}
	storedPath := filepath.Join(dir, "contexts", "local-admin.json")
	raw, err := os.ReadFile(storedPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "process-only-token") || strings.Contains(string(raw), `"pat"`) {
		t.Fatalf("context persisted an automation credential: %s", raw)
	}
	loaded, err := loadContext("local-admin")
	if err != nil || loaded.Context != "local-admin" || loaded.ConsoleURL != cfg.ConsoleURL {
		t.Fatalf("saved context did not round-trip: cfg=%#v err=%v", loaded, err)
	}
	out.Reset()
	if err := contexts(loaded, []string{"list"}, &out); err != nil || !strings.Contains(out.String(), "local-admin") {
		t.Fatalf("context list failed: out=%q err=%v", out.String(), err)
	}
	if err := contexts(loaded, []string{"delete", "local-admin", "--yes"}, &bytes.Buffer{}); err == nil {
		t.Fatal("active context deletion must fail closed")
	}
}

func TestContextSaveCreatesCopyWithoutActivatingIt(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OS_CONFIG", filepath.Join(dir, "config.json"))
	cfg := defaults()
	cfg.Context = "default"
	if err := saveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := contexts(cfg, []string{"save", "staging-copy"}, &out); err != nil {
		t.Fatal(err)
	}
	active, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if active.Context != "default" || !strings.Contains(out.String(), `"activated": false`) {
		t.Fatalf("context save unexpectedly switched active context: active=%q out=%q", active.Context, out.String())
	}
	stored, err := loadContext("staging-copy")
	if err != nil || stored.Context != "staging-copy" {
		t.Fatalf("context copy was not stored: %#v err=%v", stored, err)
	}
}

func TestSupportBundleRedactsCredentialLikeFieldsAndRefusesOverwrite(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ready":true,"accessToken":"must-not-leak","nested":{"api_token":"also-secret","secretRef":"safe-reference"}}`))
	}))
	defer server.Close()
	cfg := defaults()
	cfg.PAT, cfg.ConsoleURL, cfg.RegistryURL, cfg.APIURL, cfg.IdentityURL = "process-only", server.URL, server.URL+"/registry", server.URL+"/proxy", server.URL+"/identity"
	path := filepath.Join(t.TempDir(), "support.json")
	var out bytes.Buffer
	if err := supportBundle(cfg, []string{"--file", path}, &out); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "must-not-leak") || strings.Contains(string(raw), "also-secret") || strings.Contains(string(raw), "process-only") {
		t.Fatalf("support bundle leaked a credential: %s", raw)
	}
	if !strings.Contains(string(raw), "[REDACTED]") || !strings.Contains(string(raw), "safe-reference") {
		t.Fatalf("support bundle redaction lost safe evidence: %s", raw)
	}
	err = supportBundle(cfg, []string{"--file", path}, &bytes.Buffer{})
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Status != http.StatusConflict {
		t.Fatalf("support bundle overwrite must require --force: %v", err)
	}
}

func TestSelfUpdateCheckAndApplyVerifyManifestArtifact(t *testing.T) {
	dir := t.TempDir()
	currentPath := filepath.Join(dir, "os-current")
	if runtime.GOOS == "windows" {
		currentPath += ".exe"
	}
	if err := os.WriteFile(currentPath, []byte("old-cli"), 0o755); err != nil {
		t.Fatal(err)
	}
	expectedTarget, err := filepath.EvalSymlinks(currentPath)
	if err != nil {
		t.Fatal(err)
	}
	expectedTarget, err = filepath.Abs(expectedTarget)
	if err != nil {
		t.Fatal(err)
	}
	artifact := []byte("new-verified-cli")
	digest := sha256.Sum256(artifact)
	manifest := signTestUpdateManifest(t, updateManifest{
		Name: "os", Version: "1.2.4",
		Links: []updateLink{{OS: runtime.GOOS, Arch: runtime.GOARCH, Href: "/api/cli/os-test", Size: int64(len(artifact)), SHA256: hex.EncodeToString(digest[:])}},
	})
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cli/index.json":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(manifest)
		case "/api/cli/os-test":
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Length", strconv.Itoa(len(artifact)))
			_, _ = w.Write(artifact)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	originalVersion, originalExecutable, originalInstall := version, executablePathFn, installDownloadedUpdateFn
	version = "1.2.3"
	executablePathFn = func() (string, error) { return currentPath, nil }
	installCalls := 0
	installDownloadedUpdateFn = func(staged, target, backup string) (bool, error) {
		installCalls++
		got, err := os.ReadFile(staged)
		if err != nil {
			return false, err
		}
		if !bytes.Equal(got, artifact) || target != expectedTarget || backup != expectedTarget+".previous" {
			return false, fmt.Errorf(
				"unexpected staged update: artifact=%t target=%q backup=%q",
				bytes.Equal(got, artifact), target, backup,
			)
		}
		_ = os.Remove(staged)
		return false, nil
	}
	defer func() {
		version, executablePathFn, installDownloadedUpdateFn = originalVersion, originalExecutable, originalInstall
	}()
	cfg := defaults()
	cfg.ConsoleURL = server.URL
	var out bytes.Buffer
	if err := selfUpdate(cfg, []string{"--check"}, &out); err != nil {
		t.Fatal(err)
	}
	if installCalls != 0 || !strings.Contains(out.String(), `"state": "UpdateAvailable"`) {
		t.Fatalf("update check mutated state or missed update: calls=%d out=%q", installCalls, out.String())
	}
	out.Reset()
	if err := selfUpdate(cfg, nil, &out); err != nil {
		t.Fatal(err)
	}
	if installCalls != 1 || !strings.Contains(out.String(), `"state": "Updated"`) {
		t.Fatalf("verified update was not installed: calls=%d out=%q", installCalls, out.String())
	}
}

func signTestUpdateManifest(t *testing.T, manifest updateManifest) updateManifest {
	t.Helper()
	privateDER, err := base64.StdEncoding.DecodeString("MC4CAQAwBQYDK2VwBCIEIPKEGYePJEuX0e4DDJ+Gqkb0t9BYrRcGIoiBOSKAztNC")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(privateDER)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		t.Fatal("test update private key is not Ed25519")
	}
	payload, err := canonicalUpdateManifestPayload(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifest.Signature = updateSignature{Algorithm: "Ed25519", KeyID: localUpdateKeyID, Value: base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, []byte(payload)))}
	return manifest
}

func TestSelfUpdateManifestSignatureRejectsTamperingAndRemoteDevKey(t *testing.T) {
	manifest := signTestUpdateManifest(t, updateManifest{
		Name: "os", Version: "1.2.4",
		Links: []updateLink{{OS: "windows", Arch: "amd64", Href: "/api/cli/os.exe", Size: 42, SHA256: strings.Repeat("a", 64)}},
	})
	if err := verifyUpdateManifestSignature(manifest, "https://localhost:8090"); err != nil {
		t.Fatalf("valid local manifest signature rejected: %v", err)
	}
	manifest.Links[0].Size++
	if err := verifyUpdateManifestSignature(manifest, "https://localhost:8090"); err == nil {
		t.Fatal("tampered manifest must be rejected")
	}
	manifest.Links[0].Size--
	if err := verifyUpdateManifestSignature(manifest, "https://console.example.test"); err == nil {
		t.Fatal("local development signing key must be rejected by remote Consoles")
	}
}

func TestSelfUpdateRejectsCrossOriginAndRepublishedVersion(t *testing.T) {
	if _, err := resolveUpdateArtifactURL("https://localhost:8090", "https://evil.example/api/cli/os"); err == nil {
		t.Fatal("absolute cross-origin update URL must be rejected")
	}
	if _, err := resolveUpdateArtifactURL("https://localhost:8090", "/api/other/os"); err == nil {
		t.Fatal("artifact outside /api/cli must be rejected")
	}
	for _, test := range []struct {
		available, current string
		want               int
	}{
		{"1.2.4", "1.2.3", 1}, {"1.2.3", "1.2.3", 0}, {"1.2.2", "1.2.3", -1}, {"2.0.0", "1.99.99", 1},
	} {
		got, err := compareReleaseVersions(test.available, test.current)
		if err != nil || got != test.want {
			t.Fatalf("compare %s %s = %d, %v; want %d", test.available, test.current, got, err, test.want)
		}
	}
	if _, err := parseReleaseVersion("1.2.3-beta"); err == nil {
		t.Fatal("prerelease version must not enter the stable self-update channel")
	}
}

func TestSelfUpdateRejectsAmbiguousOrUnknownFlagsBeforeMutation(t *testing.T) {
	for _, args := range [][]string{
		{"--check=false"},
		{"--unknown"},
		{"--check", "--status"},
		{"--status", "--force"},
	} {
		if err := selfUpdate(defaults(), args, &bytes.Buffer{}); err == nil {
			t.Fatalf("unsafe update flags must fail before any network or filesystem mutation: %v", args)
		}
	}
}

func TestDeviceChallengeSignatureUsesServerV2Contract(t *testing.T) {
	privateDER, _, err := generateDeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	signature, err := signDeviceChallenge(privateDER, "device-id", "challenge-id", "nonce")
	if err != nil {
		t.Fatal(err)
	}
	key, err := x509.ParseECPrivateKey(privateDER)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		t.Fatal(err)
	}
	v2 := sha256.Sum256([]byte("opensphere-cli-session-v2\ndevice-id\nchallenge-id\nnonce"))
	if !ecdsa.VerifyASN1(&key.PublicKey, v2[:], decoded) {
		t.Fatal("signature must verify against the server v2 challenge contract")
	}
	v1 := sha256.Sum256([]byte("opensphere-cli-session-v1\ndevice-id\nchallenge-id\nnonce"))
	if ecdsa.VerifyASN1(&key.PublicKey, v1[:], decoded) {
		t.Fatal("retired v1 challenge contract must not verify")
	}
}

func TestRegistryDiscoveryRejectsHTMLAndInvalidSchema(t *testing.T) {
	for _, response := range []struct {
		contentType string
		body        string
	}{
		{"text/html", "<!doctype html>"},
		{"application/json", `{"version":2,"plugins":[]}`},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", response.contentType)
			_, _ = w.Write([]byte(response.body))
		}))
		cfg := defaults()
		cfg.PAT, cfg.RegistryURL = "test-token", server.URL
		var out bytes.Buffer
		if err := registry(cfg, nil, &out); err == nil {
			t.Fatalf("registry discovery must fail closed for %s", response.contentType)
		}
		server.Close()
	}
}

func TestLoginRejectsRetiredBootstrapFlags(t *testing.T) {
	err := run([]string{"login", "--pat-stdin"}, strings.NewReader("token\n"), &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil {
		t.Fatal("retired PAT bootstrap must not be accepted")
	}
}

// 브라우저 login은 PAT를 복사하지 않는다. one-time enrollment 승인 후 P-256 device가
// OS 보안 저장소에 들어가고, 서버 challenge/session으로 최종 검증된다.
func TestLoginWebRegistersDeviceWithoutPersistingBearer(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OS_CONFIG", filepath.Join(dir, "config.json"))
	var privateKey []byte
	origStore, origLoad, origDelete := deviceKeyStore, deviceKeyLoad, deviceKeyDelete
	deviceKeyStore = func(id string, value []byte) error { privateKey = append([]byte(nil), value...); return nil }
	deviceKeyLoad = func(id string) ([]byte, error) { return append([]byte(nil), privateKey...), nil }
	deviceKeyDelete = func(id string) error { privateKey = nil; return nil }
	defer func() { deviceKeyStore, deviceKeyLoad, deviceKeyDelete = origStore, origLoad, origDelete }()

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/identity/cli/enrollments":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"enrollmentId": strings.Repeat("a", 32), "pollToken": "poll-secret", "userCode": "A1B2C3D4",
				"verificationUriComplete": server.URL + "/me?tab=credentials", "expiresAt": time.Now().Add(time.Minute).UTC().Format(time.RFC3339), "pollInterval": 1,
			})
		case "/api/identity/cli/enrollments/" + strings.Repeat("a", 32) + "/poll":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "approved", "deviceId": strings.Repeat("d", 32), "label": "test-device", "fingerprint": "aa:bb"})
		case "/api/identity/cli/challenge":
			_ = json.NewEncoder(w).Encode(map[string]string{"challengeId": strings.Repeat("c", 32), "nonce": "nonce"})
		case "/api/identity/cli/session":
			_ = json.NewEncoder(w).Encode(map[string]any{"accessToken": "short-session", "expiresIn": 900})
		case "/api/identity/cli/introspect":
			_ = json.NewEncoder(w).Encode(map[string]any{"active": true, "type": "cli_session"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	var opened string
	orig := browserOpener
	browserOpener = func(target string) error { opened = target; return nil }
	defer func() { browserOpener = orig }()

	var out, errOut bytes.Buffer
	err := run([]string{"login", "--web", "--console", server.URL}, strings.NewReader(""), &out, &errOut)
	if opened != server.URL+"/me?tab=credentials" {
		t.Fatalf("browser should open the profile enrollment page, opened=%q", opened)
	}
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "확인 코드") || !strings.Contains(out.String(), "등록되고 검증") {
		t.Fatalf("stdout should explain and confirm device enrollment, got: %q", out.String())
	}
	b, readErr := os.ReadFile(filepath.Join(dir, "config.json"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if strings.Contains(string(b), "short-session") || strings.Contains(string(b), "poll-secret") || strings.Contains(string(b), "pat") {
		t.Fatalf("config must not persist bearer credentials: %s", b)
	}
	var saved Config
	if json.Unmarshal(b, &saved) != nil || saved.DeviceID != strings.Repeat("d", 32) {
		t.Fatalf("device identity was not saved: %s", b)
	}
}

func TestConfigIsAdminOnlyAndPrivate(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("OS_CONFIG", p)
	cfg := defaults()
	cfg.PAT = "not-a-real-secret"
	if err := saveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode=%o want 600", info.Mode().Perm())
	}
	b, _ := os.ReadFile(p)
	if strings.Contains(string(b), "not-a-real-secret") || strings.Contains(string(b), "\"pat\"") {
		t.Fatalf("config must not persist PAT: %s", b)
	}
	var saved Config
	if err := json.Unmarshal(b, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Profile != "admin" {
		t.Fatalf("profile=%q", saved.Profile)
	}
	saved.Profile = "workforce"
	if err := saveConfig(saved); err == nil {
		t.Fatal("workforce profile must require an approved Binding")
	}
}

func TestLoadConfigScrubsLegacyBearerFields(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("OS_CONFIG", p)
	t.Setenv("OS_PAT", "")
	legacy := `{"profile":"admin","pat":"legacy-secret","idToken":"legacy-id","registryUrl":"https://localhost:8090/api/v1/registry","apiUrl":"https://localhost:8090/api/proxy","bffUrl":"https://localhost:8090","consoleUrl":"https://localhost:8090"}`
	if err := os.WriteFile(p, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PAT != "" {
		t.Fatal("legacy bearer values must never be loaded")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "legacy-secret") || strings.Contains(string(b), "idToken") || strings.Contains(string(b), "\"pat\"") {
		t.Fatalf("legacy bearer fields were not scrubbed: %s", b)
	}
}

func TestRejectsCredentialBearingNonHTTPAndRemotePlaintextURLs(t *testing.T) {
	for _, raw := range []string{"file:///tmp/a", "https://user:pass@example.test", "javascript:alert(1)", "http://console.example.test"} {
		if validateURL(raw) == nil {
			t.Fatalf("URL must be rejected: %s", raw)
		}
	}
	for _, raw := range []string{"http://localhost:8090", "http://127.0.0.1:8090", "https://console.example.test"} {
		if validateURL(raw) != nil {
			t.Fatalf("URL must be accepted: %s", raw)
		}
	}
}

func TestLongFlagParsing(t *testing.T) {
	got := parseLongFlags([]string{"status", "--namespace", "demo", "--apply"})
	if got["namespace"] != "demo" || got["apply"] != "true" {
		t.Fatalf("unexpected flags: %#v", got)
	}
}

func TestExtensionInstallRequiresApprovalReasonBeforeNetwork(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OS_CONFIG", filepath.Join(dir, "config.json"))
	err := run([]string{"extensions", "install", "ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:" + strings.Repeat("a", 64)}, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "--reason") {
		t.Fatalf("missing approval reason must fail locally, got %v", err)
	}
	if !validResourceName("cluster-manager") || validResourceName("Cluster Manager") || validResourceName("cluster-manager-") {
		t.Fatal("module id validation mismatch")
	}
}

func TestSensitiveNativeMutationsRequireReasonBeforeNetwork(t *testing.T) {
	t.Setenv("OS_CONFIG", filepath.Join(t.TempDir(), "config.json"))
	for _, args := range [][]string{
		{"role", "grant", "alice", "opensphere-console-admins"},
		{"token", "create", "--label", "automation"},
		{"admin", "disable", "00000000-0000-0000-0000-000000000000"},
		{"device", "revoke", "00000000000000000000000000000000"},
	} {
		err := run(args, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{})
		if err == nil || !strings.Contains(err.Error(), "reason") {
			t.Fatalf("%v must fail locally without reason, got %v", args, err)
		}
	}
}

func TestGetResourceRejectsSPAHTMLAndUsesConsoleNamespace(t *testing.T) {
	t.Setenv("OS_INSECURE_SKIP_TLS_VERIFY", "0")
	var requested string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = r.URL.Path
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("<!doctype html><title>Console</title>"))
	}))
	defer server.Close()
	cfg := defaults()
	cfg.PAT = "test-only-token"
	cfg.APIURL = server.URL + "/api/proxy"
	err := getResource(cfg, []string{"uipluginpackage"}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "instead of JSON") {
		t.Fatalf("SPA fallback must be rejected, got %v", err)
	}
	if !strings.Contains(requested, "/namespaces/opensphere-console/uipluginpackages") {
		t.Fatalf("resource request used the wrong namespace: %s", requested)
	}
}
