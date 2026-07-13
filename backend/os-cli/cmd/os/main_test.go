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
)

func TestHelpDeclaresNativeAdminBoundary(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"help"}, strings.NewReader(""), &out, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"Console native 관리자 CLI", "admin(Kanidm/BFF PAT)", "workforce", "CLI Binding", "--pat-stdin", "extensions install"} {
		if !strings.Contains(out.String(), expected) {
			t.Fatalf("help missing %q", expected)
		}
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
	if emptyErr == nil || !strings.Contains(emptyErr.Error(), "PAT가 필요합니다") {
		t.Fatalf("empty stdin should require a PAT, got: %v", emptyErr)
	}
	filledErr := run([]string{"login", "--pat-stdin", "--console", "http://127.0.0.1:1"}, strings.NewReader("stdin-token\n"), &out, &errOut)
	if filledErr == nil || strings.Contains(filledErr.Error(), "PAT가 필요합니다") {
		t.Fatalf("non-empty stdin must be accepted as the PAT then fail at whoami, got: %v", filledErr)
	}
	if strings.Contains(errOut.String(), "--pat는 프로세스 목록") {
		t.Fatal("--pat-stdin path must not emit the --pat deprecation warning")
	}
}

// F-9: --web은 콘솔 발급 페이지를 브라우저로 열고 붙여넣은 토큰을 stdin에서 읽는다.
// 실제 브라우저 실행은 browserOpener를 no-op으로 대체해 회피하고, 열린 URL만 검증한다.
func TestLoginWebOpensConsoleAndReadsPastedToken(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OS_CONFIG", filepath.Join(dir, "config.json"))
	var opened string
	orig := browserOpener
	browserOpener = func(target string) error { opened = target; return nil }
	defer func() { browserOpener = orig }()

	var out, errOut bytes.Buffer
	err := run([]string{"login", "--web", "--console", "http://127.0.0.1:1"}, strings.NewReader("pasted-token\n"), &out, &errOut)
	if opened != "http://127.0.0.1:1/manage/cli" {
		t.Fatalf("browser should open the console /manage/cli page, opened=%q", opened)
	}
	// 붙여넣은 토큰으로 진행하므로 "PAT가 필요합니다"가 아니라 whoami 검증 실패로 끝나야 한다.
	if err == nil || strings.Contains(err.Error(), "PAT가 필요합니다") {
		t.Fatalf("pasted token must be accepted then fail at whoami, got: %v", err)
	}
	if !strings.Contains(out.String(), "/manage/cli") {
		t.Fatalf("stdout should print the issuance URL, got: %q", out.String())
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
	cfg.APIURL = server.URL + "/api/proxy"
	err := getResource(cfg, []string{"uipluginpackage"}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "instead of JSON") {
		t.Fatalf("SPA fallback must be rejected, got %v", err)
	}
	if !strings.Contains(requested, "/namespaces/opensphere-console/uipluginpackages") {
		t.Fatalf("resource request used the wrong namespace: %s", requested)
	}
}
