package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHelpDeclaresNativeAdminBoundary(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"help"}, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"Console native 관리자 CLI", "admin 디바이스 신뢰", "workforce", "CLI Binding", "--pat-stdin", "extensions install", "15분 서명 세션"} {
		if !strings.Contains(out.String(), expected) {
			t.Fatalf("help missing %q", expected)
		}
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

func TestCredentialTokenUsesProcessOnlyIDTokenBeforeDeviceState(t *testing.T) {
	cfg := defaults()
	cfg.PAT = ""
	cfg.IDToken = "supabase-access-token"
	cfg.DeviceID = ""
	token, err := credentialToken(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if token != "supabase-access-token" {
		t.Fatalf("credentialToken()=%q", token)
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

// F-2: --pat-stdin은 stdin에서 PAT를 읽어 argv 노출을 없앤다. 원격 endpoint를 지정하면
// whoami 검증이 네트워크로 나가기 전에 stdin 파싱이 선행되므로, 여기서는 파싱 경계만 검증한다.
func TestLoginReadsPatFromStdin(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OS_CONFIG", filepath.Join(dir, "config.json"))
	var out, errOut bytes.Buffer
	// 존재하지 않는 로컬 포트로 향하게 해 whoami가 실패하도록 만든다. stdin이 비어 있으면
	// "PAT가 필요합니다"로, 채워져 있으면 whoami 검증 단계까지 진행됨을 구분한다.
	emptyErr := run([]string{"login", "--pat-stdin", "--console", "http://127.0.0.1:1"}, strings.NewReader("  \n"), &out, &errOut)
	if emptyErr == nil || !strings.Contains(emptyErr.Error(), "bootstrap API token") {
		t.Fatalf("empty stdin should require a bootstrap API token, got: %v", emptyErr)
	}
	filledErr := run([]string{"login", "--pat-stdin", "--console", "http://127.0.0.1:1"}, strings.NewReader("stdin-token\n"), &out, &errOut)
	if filledErr == nil || strings.Contains(filledErr.Error(), "bootstrap API token이 필요") {
		t.Fatalf("non-empty stdin must be accepted then fail at registration, got: %v", filledErr)
	}
	if strings.Contains(errOut.String(), "--pat는 프로세스 목록") {
		t.Fatal("--pat-stdin path must not emit the --pat deprecation warning")
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
		case "/bff/cli/enrollments":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"enrollmentId": strings.Repeat("a", 32), "pollToken": "poll-secret", "userCode": "A1B2C3D4",
				"verificationUriComplete": server.URL + "/me?tab=credentials", "expiresAt": time.Now().Add(time.Minute).UTC().Format(time.RFC3339), "pollInterval": 1,
			})
		case "/bff/cli/enrollments/" + strings.Repeat("a", 32) + "/poll":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "approved", "deviceId": strings.Repeat("d", 32), "label": "test-device", "fingerprint": "aa:bb"})
		case "/bff/cli/challenge":
			_ = json.NewEncoder(w).Encode(map[string]string{"challengeId": strings.Repeat("c", 32), "nonce": "nonce"})
		case "/bff/cli/session":
			_ = json.NewEncoder(w).Encode(map[string]any{"accessToken": "short-session", "expiresIn": 900})
		case "/bff/token/introspect":
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

// F-2: argv의 --pat는 하위호환으로 동작하되 노출 경고를 stderr로 낸다.
func TestLoginWarnsOnArgvPat(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OS_CONFIG", filepath.Join(dir, "config.json"))
	var out, errOut bytes.Buffer
	_ = run([]string{"login", "--pat", "argv-token", "--console", "http://127.0.0.1:1"}, strings.NewReader(""), &out, &errOut)
	if !strings.Contains(errOut.String(), "--pat는 프로세스 목록") {
		t.Fatalf("argv --pat must emit a deprecation/exposure warning, stderr=%q", errOut.String())
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
	t.Setenv("OS_ID_TOKEN", "")
	legacy := `{"profile":"admin","pat":"legacy-secret","idToken":"legacy-id","registryUrl":"http://localhost:8090/api/v1/registry","apiUrl":"http://localhost:8090/api/proxy","bffUrl":"http://localhost:8090","consoleUrl":"http://localhost:8090"}`
	if err := os.WriteFile(p, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PAT != "" || cfg.IDToken != "" {
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
		{"auth-policy", "set", "enabled"},
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
