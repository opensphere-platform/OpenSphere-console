package main

import (
	"bytes"
	"encoding/json"
	"encoding/pem"
	"errors"
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
	for _, expected := range []string{"Console native 관리자 CLI", "admin 디바이스 신뢰", "workforce", "CLI Binding", "--pat-stdin", "extensions install", "15분 서명 세션", "종료 코드:", "네트워크 또는 TLS 실패"} {
		if !strings.Contains(out.String(), expected) {
			t.Fatalf("help missing %q", expected)
		}
	}
}

func TestCommandHelpIsDetailedAndLocal(t *testing.T) {
	commands := []string{"login", "logout", "whoami", "device", "token", "auth-policy", "admin", "registry", "catalog", "backbone", "observability", "audit", "get", "role", "extensions", "setup"}
	dir := t.TempDir()
	brokenConfig := filepath.Join(dir, "config.json")
	if err := os.WriteFile(brokenConfig, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OS_CONFIG", brokenConfig)
	for _, command := range commands {
		for _, args := range [][]string{{command, "--help"}, {command, "-h"}, {"help", command}} {
			var out bytes.Buffer
			if err := run(args, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
				t.Fatalf("%v should succeed without config or network: %v", args, err)
			}
			for _, section := range []string{"사용법:", "하위명령:", "플래그:", "예:"} {
				if !strings.Contains(out.String(), section) {
					t.Fatalf("%v help missing %q: %s", args, section, out.String())
				}
			}
		}
	}
}

func TestStableExitCodeMapping(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{"usage", cliError(exitUsage, "bad usage", nil), exitUsage},
		{"auth", statusError([]byte("denied"), http.StatusUnauthorized, ""), exitAuth},
		{"network", cliError(exitNetwork, "offline", errors.New("dial failed")), exitNetwork},
		{"server", statusError([]byte("failed"), http.StatusInternalServerError, ""), exitServer},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, _ := exitDetails(tc.err)
			if got != tc.want {
				t.Fatalf("exit code=%d want %d", got, tc.want)
			}
		})
	}
}

func TestJSONErrorShape(t *testing.T) {
	var errOut bytes.Buffer
	code := execute([]string{"help", "not-a-command", "--output", "json"}, strings.NewReader(""), &bytes.Buffer{}, &errOut)
	if code != exitUsage {
		t.Fatalf("exit code=%d want %d", code, exitUsage)
	}
	var payload map[string]any
	if err := json.Unmarshal(errOut.Bytes(), &payload); err != nil {
		t.Fatalf("stderr is not JSON: %v: %s", err, errOut.String())
	}
	if payload["code"] != float64(exitUsage) || payload["error"] == "" {
		t.Fatalf("unexpected JSON error: %#v", payload)
	}
	if _, ok := payload["correlationId"]; !ok {
		t.Fatalf("JSON error missing correlationId: %#v", payload)
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

func TestConfigIsPrivateAndAllowsWorkforceGroundwork(t *testing.T) {
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
	saved.Kind = "workforce"
	if err := saveConfig(saved); err != nil {
		t.Fatalf("workforce profile should be storable groundwork: %v", err)
	}
}

func TestLegacyFlatConfigMigratesToDefaultInMemory(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("OS_CONFIG", p)
	legacy := `{"profile":"admin","consoleUrl":"https://legacy.example.test","registryUrl":"https://legacy.example.test/registry","apiUrl":"https://legacy.example.test/api","bffUrl":"https://legacy.example.test"}`
	if err := os.WriteFile(p, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.profileName != "default" || cfg.Kind != "admin" || cfg.ConsoleURL != "https://legacy.example.test" {
		t.Fatalf("legacy migration mismatch: %#v", cfg)
	}
	b, _ := os.ReadFile(p)
	if string(b) != legacy {
		t.Fatal("loading legacy config must not rewrite it")
	}
}

func TestProfileFlagOverridesEnvironmentSelection(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("OS_CONFIG", p)
	file := ConfigFile{CurrentProfile: "default", Profiles: map[string]Config{
		"default": {Profile: "admin", Kind: "admin", ConsoleURL: "https://default.example.test"},
		"env":     {Profile: "admin", Kind: "admin", ConsoleURL: "https://env.example.test"},
		"flag":    {Profile: "admin", Kind: "admin", ConsoleURL: "https://flag.example.test"},
	}}
	b, _ := json.Marshal(file)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OS_PROFILE", "env")
	var out bytes.Buffer
	if err := run([]string{"config", "get", "consoleUrl"}, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != "https://env.example.test" {
		t.Fatalf("env selection=%q", out.String())
	}
	out.Reset()
	if err := run([]string{"--profile", "flag", "config", "get", "consoleUrl"}, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != "https://flag.example.test" {
		t.Fatalf("flag selection=%q", out.String())
	}
}

func TestConfigProfilesUseAndScopedGetSet(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("OS_CONFIG", p)
	var out bytes.Buffer
	if err := run([]string{"config", "--profile", "work", "set", "consoleUrl", "https://work.example.test"}, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"config", "use-profile", "work"}, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := run([]string{"config", "profiles"}, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "  default") || !strings.Contains(out.String(), "* work") {
		t.Fatalf("profiles output=%q", out.String())
	}
	out.Reset()
	if err := run([]string{"config", "get", "consoleUrl"}, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != "https://work.example.test" {
		t.Fatalf("active scoped get=%q", out.String())
	}
}

func TestWorkforceProfileStoredButLiveCallRejected(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("OS_CONFIG", p)
	for _, pair := range [][]string{{"kind", "workforce"}, {"consoleUrl", "https://workforce.example.test"}} {
		if err := run([]string{"config", "--profile", "workforce", "set", pair[0], pair[1]}, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}); err != nil {
			t.Fatal(err)
		}
	}
	cfg, err := loadConfigFor("workforce")
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = request(cfg, http.MethodGet, cfg.ConsoleURL, nil, "")
	if err == nil || !strings.Contains(err.Error(), "workforce 프로파일 인증은 아직 지원되지 않습니다") {
		t.Fatalf("workforce live call error=%v", err)
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

func TestCABundleTrustsPrivateCAWithoutDisablingVerification(t *testing.T) {
	t.Setenv("OS_INSECURE_SKIP_TLS_VERIFY", "0")
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	caPath := filepath.Join(t.TempDir(), "ca.pem")
	cert := server.Certificate()
	if err := os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	_, status, _, err := rawRequestCA(http.MethodGet, server.URL, nil, "", "", "", caPath)
	if err != nil || status != http.StatusOK {
		t.Fatalf("private CA request failed: status=%d err=%v", status, err)
	}
	if _, _, _, err := rawRequestCA(http.MethodGet, server.URL, nil, "", "", "", ""); err == nil || !strings.Contains(err.Error(), "--ca-bundle") {
		t.Fatalf("untrusted certificate should provide CA guidance, got %v", err)
	}
}

func TestUnknownCommandUsesDynamicRegistryLookupAndReturnsActionableError(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/registry":
			_, _ = w.Write([]byte(`{"plugins":[{"available":true,"cli":{"namespace":"catalog","apiBase":"/catalog-api","manifestPath":"manifest"}}]}`))
		case "/catalog-api/manifest":
			_, _ = w.Write([]byte(`{"tools":[{"command":"os catalog list","method":"GET","path":"/items"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	config := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("OS_CONFIG", config)
	cfg := defaults()
	cfg.RegistryURL = server.URL + "/registry"
	cfg.ConsoleURL = server.URL
	// PAT is json:"-" (process-memory only), so it must come from OS_PAT, not saveConfig.
	t.Setenv("OS_PAT", "test-only")
	if err := saveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	err := run([]string{"catalog", "bogus"}, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || err.Error() != `unknown command "catalog bogus"; run os help` {
		t.Fatalf("unknown command should return actionable error, got %v", err)
	}
	if calls != 2 {
		t.Fatalf("unknown command should perform registry and manifest lookups, got %d calls", calls)
	}
}

func TestStatusErrorMappingIncludesCorrelationID(t *testing.T) {
	tests := []struct {
		status int
		want   string
	}{
		{http.StatusUnauthorized, "os login"},
		{http.StatusForbidden, "권한이 부족"},
		{http.StatusBadGateway, "백엔드를 사용할 수 없"},
	}
	for _, tc := range tests {
		err := statusError([]byte("server detail"), tc.status, "corr-123")
		if !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), "corr-123") {
			t.Fatalf("status %d mapping mismatch: %v", tc.status, err)
		}
	}
}
