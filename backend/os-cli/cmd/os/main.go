package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

var version = "0.5.0"

type Config struct {
	Profile     string `json:"profile"`
	PAT         string `json:"-"` // process-memory only: OS_PAT automation token
	DeviceID    string `json:"deviceId,omitempty"`
	DeviceLabel string `json:"deviceLabel,omitempty"`
	RegistryURL string `json:"registryUrl"`
	APIURL      string `json:"apiUrl"`
	IdentityURL string `json:"identityUrl"`
	ConsoleURL  string `json:"consoleUrl"`
}

type CLIContribution struct {
	Namespace    string `json:"namespace"`
	ManifestPath string `json:"manifestPath"`
	APIBase      string `json:"apiBase"`
}

type RegistryItem struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Available bool             `json:"available"`
	CLI       *CLIContribution `json:"cli,omitempty"`
}

type Registry struct {
	Version      int              `json:"version"`
	Capabilities []map[string]any `json:"capabilities"`
	Plugins      []RegistryItem   `json:"plugins"`
	Templates    []map[string]any `json:"templates"`
	TrustedKeys  map[string]any   `json:"trustedKeys"`
}

type Tool struct {
	Command     string `json:"command"`
	Method      string `json:"method"`
	Path        string `json:"path"`
	Components  map[string]ToolRoute `json:"components"`
	Operations  map[string]ToolRoute `json:"operations"`
	Description string `json:"description"`
	Risk        string `json:"risk"`
	Scope       string `json:"scope"`
}

type ToolRoute struct {
	Path        string `json:"path"`
	PreviewPath string `json:"previewPath"`
	ApplyPath   string `json:"applyPath"`
}

type ToolManifest struct {
	Kind  string `json:"kind"`
	Tools []Tool `json:"tools"`
}

func defaults() Config {
	console := env("OS_CONSOLE", "https://localhost:8090")
	return Config{
		Profile:     "admin",
		PAT:         os.Getenv("OS_PAT"),
		RegistryURL: env("OS_REGISTRY", console+"/api/v1/registry"),
		APIURL:      env("OS_API", console+"/api/proxy"),
		IdentityURL: env("OS_IDENTITY", console+"/api/identity/cli"),
		ConsoleURL:  console,
	}
}

func env(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

func configPath() (string, error) {
	if p := strings.TrimSpace(os.Getenv("OS_CONFIG")); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".os", "config.json"), nil
}

func loadConfig() (Config, error) {
	cfg := defaults()
	p, err := configPath()
	if err != nil {
		return cfg, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, fmt.Errorf("설정 파싱 실패: %w", err)
	}
	if cfg.Profile == "" {
		cfg.Profile = "admin"
	}
	// Legacy config could contain year-long PAT/idToken fields. They are deliberately
	// ignored rather than loaded back into memory; `os login` performs one-time device pairing.
	// 읽기만 해도 오래된 bearer 필드는 즉시 제거해 디스크에 비밀이 남지 않게 한다.
	var legacy map[string]json.RawMessage
	if json.Unmarshal(b, &legacy) == nil {
		_, hasPAT := legacy["pat"]
		_, hasIDToken := legacy["idToken"]
		if hasPAT || hasIDToken {
			if err := saveConfig(cfg); err != nil {
				return cfg, fmt.Errorf("레거시 bearer 설정 제거 실패: %w", err)
			}
		}
	}
	return cfg, nil
}

func saveConfig(cfg Config) error {
	if cfg.Profile != "admin" {
		return errors.New("현재 native os CLI는 admin 프로파일만 허용합니다; workforce는 승인된 Binding으로 추가해야 합니다")
	}
	for _, raw := range []string{cfg.RegistryURL, cfg.APIURL, cfg.IdentityURL, cfg.ConsoleURL} {
		if err := validateURL(raw); err != nil {
			return err
		}
	}
	p, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(p, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Chmod(p, 0o600)
}

func validateURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return fmt.Errorf("허용되지 않은 URL: %q", raw)
	}
	if u.Scheme == "http" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
		return fmt.Errorf("원격 endpoint는 HTTPS가 필요합니다: %q", raw)
	}
	return nil
}

func client() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if os.Getenv("OS_INSECURE_SKIP_TLS_VERIFY") == "1" {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // #nosec G402: explicit local-development opt-in only.
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: transport}
}

func request(cfg Config, method, rawURL string, body io.Reader, contentType string) ([]byte, int, error) {
	b, status, _, err := requestWithContentType(cfg, method, rawURL, body, contentType)
	return b, status, err
}

func requestWithContentType(cfg Config, method, rawURL string, body io.Reader, contentType string) ([]byte, int, string, error) {
	accessToken, err := credentialToken(cfg)
	if err != nil {
		return nil, 0, "", err
	}
	return rawRequest(method, rawURL, body, contentType, accessToken)
}

func rawRequest(method, rawURL string, body io.Reader, contentType, accessToken string) ([]byte, int, string, error) {
	if err := validateURL(rawURL); err != nil {
		return nil, 0, "", err
	}
	req, err := http.NewRequest(method, rawURL, body)
	if err != nil {
		return nil, 0, "", err
	}
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-OS-Correlation-ID", operationID())
	if method != http.MethodGet && method != http.MethodHead {
		req.Header.Set("X-OS-Idempotency-Key", operationID())
	}
	resp, err := client().Do(req)
	if err != nil {
		return nil, 0, "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return b, resp.StatusCode, resp.Header.Get("Content-Type"), err
}

type devicePublicJWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

func generateDeviceKey() ([]byte, devicePublicJWK, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, devicePublicJWK{}, err
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, devicePublicJWK{}, err
	}
	pad := func(value []byte) []byte {
		out := make([]byte, 32)
		copy(out[32-len(value):], value)
		return out
	}
	return der, devicePublicJWK{
		Kty: "EC", Crv: "P-256",
		X: base64.RawURLEncoding.EncodeToString(pad(key.X.Bytes())),
		Y: base64.RawURLEncoding.EncodeToString(pad(key.Y.Bytes())),
	}, nil
}

func signDeviceChallenge(privateDER []byte, deviceID, challengeID, nonce string) (string, error) {
	key, err := x509.ParseECPrivateKey(privateDER)
	if err != nil {
		return "", fmt.Errorf("디바이스 개인키 파싱 실패: %w", err)
	}
	message := fmt.Sprintf("opensphere-cli-session-v1\n%s\n%s\n%s", deviceID, challengeID, nonce)
	digest := sha256.Sum256([]byte(message))
	signature, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(signature), nil
}

func credentialToken(cfg Config) (string, error) {
	if strings.TrimSpace(cfg.PAT) != "" {
		return strings.TrimSpace(cfg.PAT), nil
	}
	// Supabase access tokens are short-lived, MFA-bound bearer credentials.  They
	// are deliberately process-only (OS_ID_TOKEN) and must never be persisted in
	// config.json or the device key store.  This also preserves the existing
	// Kanidm device challenge as the default when no explicit session is supplied.
	if strings.TrimSpace(cfg.IDToken) != "" {
		return strings.TrimSpace(cfg.IDToken), nil
	}
	if cfg.DeviceID == "" {
		return "", errors.New("등록된 CLI 디바이스가 없습니다; os login을 실행하세요")
	}
	privateDER, err := deviceKeyLoad(cfg.DeviceID)
	if err != nil {
		return "", fmt.Errorf("OS 보안 저장소에서 디바이스 키를 읽지 못했습니다: %w", err)
	}
	challengeBody, _ := json.Marshal(map[string]string{"deviceId": cfg.DeviceID})
	b, status, _, err := rawRequest(http.MethodPost, join(cfg.IdentityURL, "/challenge"), bytes.NewReader(challengeBody), "application/json", "")
	if err != nil {
		return "", err
	}
	if err := requireOK(b, status); err != nil {
		return "", err
	}
	var challenge struct {
		ChallengeID string `json:"challengeId"`
		Nonce       string `json:"nonce"`
	}
	if err := json.Unmarshal(b, &challenge); err != nil || challenge.ChallengeID == "" || challenge.Nonce == "" {
		return "", errors.New("CLI challenge 응답이 올바르지 않습니다")
	}
	signature, err := signDeviceChallenge(privateDER, cfg.DeviceID, challenge.ChallengeID, challenge.Nonce)
	if err != nil {
		return "", err
	}
	sessionBody, _ := json.Marshal(map[string]string{
		"deviceId": cfg.DeviceID, "challengeId": challenge.ChallengeID, "nonce": challenge.Nonce, "signature": signature,
	})
	b, status, _, err = rawRequest(http.MethodPost, join(cfg.IdentityURL, "/session"), bytes.NewReader(sessionBody), "application/json", "")
	if err != nil {
		return "", err
	}
	if err := requireOK(b, status); err != nil {
		return "", err
	}
	var session struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.Unmarshal(b, &session); err != nil || session.AccessToken == "" {
		return "", errors.New("CLI 단기 세션 응답이 올바르지 않습니다")
	}
	return session.AccessToken, nil
}

func operationID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("os-%d", time.Now().UnixNano())
	}
	return "os-" + hex.EncodeToString(b)
}

func join(base, path string) string {
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}

func pretty(out io.Writer, b []byte) error {
	var dst bytes.Buffer
	if json.Indent(&dst, b, "", "  ") == nil {
		_, err := fmt.Fprintln(out, dst.String())
		return err
	}
	_, err := out.Write(append(b, '\n'))
	return err
}

func requireOK(b []byte, status int) error {
	if status >= 200 && status < 300 {
		return nil
	}
	msg := strings.TrimSpace(string(b))
	if len(msg) > 500 {
		msg = msg[:500]
	}
	return fmt.Errorf("HTTP %d: %s", status, msg)
}

func run(args []string, in io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		printHelp(out)
		return nil
	}
	if args[0] == "version" || args[0] == "--version" {
		fmt.Fprintf(out, "os %s\n", version)
		return nil
	}
	if args[0] == "login" {
		return login(args[1:], in, out, errOut)
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	switch args[0] {
	case "whoami":
		return whoami(cfg, out)
	case "logout":
		return logout(cfg, out)
	case "device":
		return devices(cfg, args[1:], out)
	case "registry":
		return registry(cfg, args[1:], out)
	case "get":
		return getResource(cfg, args[1:], out)
	case "role":
		return role(cfg, args[1:], out)
	case "token":
		return tokens(cfg, args[1:], out)
	case "admin":
		return admins(cfg, args[1:], out)
	case "backbone":
		return backbone(cfg, args[1:], out)
	case "observability":
		return observability(cfg, args[1:], out)
	case "audit":
		return auditLog(cfg, args[1:], out)
	case "catalog":
		return catalog(cfg, args[1:], out)
	case "extensions":
		return extensions(cfg, args[1:], out)
	default:
		return dynamic(cfg, args, out, errOut)
	}
}

func logout(cfg Config, out io.Writer) error {
	if cfg.DeviceID == "" {
		return errors.New("등록된 CLI 디바이스가 없습니다")
	}
	body, _ := json.Marshal(map[string]string{"reason": "Interactive CLI logout"})
	b, status, err := request(cfg, http.MethodDelete, join(cfg.IdentityURL, "/devices/"+url.PathEscape(cfg.DeviceID)), bytes.NewReader(body), "application/json")
	if err != nil {
		return err
	}
	if status != http.StatusNotFound {
		if err := requireOK(b, status); err != nil {
			return err
		}
	}
	if err := deviceKeyDelete(cfg.DeviceID); err != nil {
		return err
	}
	cfg.DeviceID, cfg.DeviceLabel, cfg.PAT = "", "", ""
	if err := saveConfig(cfg); err != nil {
		return err
	}
	fmt.Fprintln(out, "서버 디바이스 신뢰와 로컬 보안 키를 폐기했습니다")
	return nil
}

func devices(cfg Config, args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "list" {
		b, status, err := request(cfg, http.MethodGet, join(cfg.IdentityURL, "/devices"), nil, "")
		if err != nil {
			return err
		}
		if err := requireOK(b, status); err != nil {
			return err
		}
		return pretty(out, b)
	}
	if args[0] == "revoke" {
		if len(args) < 2 {
			return errors.New("사용법: os device revoke <device-id> --reason <사유>")
		}
		id := strings.TrimSpace(args[1])
		flags := parseLongFlags(args[2:])
		reason := strings.TrimSpace(flags["reason"])
		if len(reason) < 8 {
			return errors.New("--reason은 8자 이상의 장치 폐기 사유여야 합니다")
		}
		body, _ := json.Marshal(map[string]string{"reason": reason})
		b, status, err := request(cfg, http.MethodDelete, join(cfg.IdentityURL, "/devices/"+url.PathEscape(id)), bytes.NewReader(body), "application/json")
		if err != nil {
			return err
		}
		if err := requireOK(b, status); err != nil {
			return err
		}
		if id == cfg.DeviceID {
			if err := deviceKeyDelete(id); err != nil {
				return err
			}
			cfg.DeviceID, cfg.DeviceLabel = "", ""
			if err := saveConfig(cfg); err != nil {
				return err
			}
		}
		return pretty(out, b)
	}
	return fmt.Errorf("알 수 없는 device 하위명령: %s", args[0])
}

func login(args []string, in io.Reader, out, errOut io.Writer) error {
	cfg, _ := loadConfig()
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	web := fs.Bool("web", false, "브라우저 디바이스 승인(기본 동작)")
	host, _ := os.Hostname()
	label := fs.String("label", strings.TrimSpace(host), "등록할 CLI 디바이스 이름")
	registryURL := fs.String("registry", cfg.RegistryURL, "Registry URL")
	apiURL := fs.String("api", cfg.APIURL, "API proxy URL")
	identityURL := fs.String("identity", cfg.IdentityURL, "Supabase Console identity URL")
	consoleURL := fs.String("console", cfg.ConsoleURL, "Console URL")
	if err := fs.Parse(args); err != nil {
		return err
	}
	_ = web // 브라우저 승인이 기본이며 --web은 명시적 alias로 수용한다.
	if hasArg(args, "--console") {
		if !hasArg(args, "--registry") {
			*registryURL = join(*consoleURL, "/api/v1/registry")
		}
		if !hasArg(args, "--api") {
			*apiURL = join(*consoleURL, "/api/proxy")
		}
		if !hasArg(args, "--identity") {
			*identityURL = join(*consoleURL, "/api/identity/cli")
		}
	}
	if err := validateURL(*consoleURL); err != nil {
		return err
	}
	privateDER, publicJwk, err := generateDeviceKey()
	if err != nil {
		return fmt.Errorf("디바이스 키 생성 실패: %w", err)
	}
	var device struct {
		ID          string `json:"id"`
		Label       string `json:"label"`
		Fingerprint string `json:"fingerprint"`
	}
	registered, enrollErr := browserDeviceEnrollment(*identityURL, *label, publicJwk, out, errOut)
	if enrollErr != nil {
		return enrollErr
	}
	device = registered
	if err := deviceKeyStore(device.ID, privateDER); err != nil {
		return fmt.Errorf("OS 보안 저장소에 디바이스 키 저장 실패: %w", err)
	}
	cfg = Config{Profile: "admin", DeviceID: device.ID, DeviceLabel: device.Label, RegistryURL: *registryURL, APIURL: *apiURL, IdentityURL: *identityURL, ConsoleURL: *consoleURL}
	if err := whoami(cfg, io.Discard); err != nil {
		_ = deviceKeyDelete(device.ID)
		return fmt.Errorf("등록 디바이스 세션 검증 실패(설정은 저장하지 않음): %w", err)
	}
	if err := saveConfig(cfg); err != nil {
		_ = deviceKeyDelete(device.ID)
		return err
	}
	fmt.Fprintf(out, "admin 디바이스가 등록되고 검증되었습니다: %s (%s)\n", device.Label, device.Fingerprint)
	return nil
}

var sleepFn = time.Sleep

func browserDeviceEnrollment(identityURL, label string, publicJwk devicePublicJWK, out, errOut io.Writer) (struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Fingerprint string `json:"fingerprint"`
}, error) {
	var device struct {
		ID          string `json:"id"`
		Label       string `json:"label"`
		Fingerprint string `json:"fingerprint"`
	}
	requestBody, _ := json.Marshal(map[string]any{"label": label, "publicJwk": publicJwk})
	b, status, _, err := rawRequest(http.MethodPost, join(identityURL, "/enrollments"), bytes.NewReader(requestBody), "application/json", "")
	if err != nil {
		return device, err
	}
	if err := requireOK(b, status); err != nil {
		return device, fmt.Errorf("디바이스 등록 시작 실패: %w", err)
	}
	var enrollment struct {
		EnrollmentID            string `json:"enrollmentId"`
		PollToken               string `json:"pollToken"`
		UserCode                string `json:"userCode"`
		VerificationURIComplete string `json:"verificationUriComplete"`
		ExpiresAt               string `json:"expiresAt"`
		PollInterval            int    `json:"pollInterval"`
	}
	if json.Unmarshal(b, &enrollment) != nil || enrollment.EnrollmentID == "" || enrollment.PollToken == "" || enrollment.VerificationURIComplete == "" {
		return device, errors.New("디바이스 등록 시작 응답이 올바르지 않습니다")
	}
	fmt.Fprintf(out, "브라우저에서 OpenSphere CLI 디바이스를 승인하세요: %s\n", enrollment.VerificationURIComplete)
	fmt.Fprintf(out, "확인 코드: %s\n", enrollment.UserCode)
	if err := browserOpener(enrollment.VerificationURIComplete); err != nil {
		fmt.Fprintf(errOut, "브라우저 자동 실행 실패(%v) — 위 URL을 직접 여세요.\n", err)
	}
	deadline, parseErr := time.Parse(time.RFC3339, enrollment.ExpiresAt)
	if parseErr != nil {
		deadline = time.Now().Add(5 * time.Minute)
	}
	interval := time.Duration(enrollment.PollInterval) * time.Second
	if interval < time.Second {
		interval = 2 * time.Second
	}
	for time.Now().Before(deadline) {
		pollBody, _ := json.Marshal(map[string]string{"pollToken": enrollment.PollToken})
		b, status, _, err = rawRequest(http.MethodPost, join(identityURL, "/enrollments/"+enrollment.EnrollmentID+"/poll"), bytes.NewReader(pollBody), "application/json", "")
		if err != nil {
			return device, err
		}
		if status == http.StatusAccepted {
			sleepFn(interval)
			continue
		}
		if err := requireOK(b, status); err != nil {
			return device, err
		}
		var approved struct {
			DeviceID    string `json:"deviceId"`
			Label       string `json:"label"`
			Fingerprint string `json:"fingerprint"`
		}
		if json.Unmarshal(b, &approved) != nil || approved.DeviceID == "" {
			return device, errors.New("디바이스 승인 응답이 올바르지 않습니다")
		}
		device.ID, device.Label, device.Fingerprint = approved.DeviceID, approved.Label, approved.Fingerprint
		return device, nil
	}
	return device, errors.New("디바이스 승인 시간이 만료되었습니다; os login을 다시 실행하세요")
}

// browserOpener는 테스트에서 대체 가능하도록 변수로 둔다(실제 브라우저 실행 회피).
var browserOpener = openBrowser

func openBrowser(target string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start()
	case "darwin":
		return exec.Command("open", target).Start()
	default:
		return exec.Command("xdg-open", target).Start()
	}
}

func whoami(cfg Config, out io.Writer) error {
	token, err := credentialToken(cfg)
	if err != nil {
		return err
	}
	b, status, _, err := rawRequest(http.MethodGet, join(cfg.IdentityURL, "/introspect"), nil, "", token)
	if err != nil {
		return err
	}
	if err := requireOK(b, status); err != nil {
		return err
	}
	var result struct {
		Active bool `json:"active"`
	}
	if json.Unmarshal(b, &result) != nil || !result.Active {
		return errors.New("CLI 디바이스 또는 API token이 비활성·폐기 상태입니다")
	}
	if out != io.Discard {
		return pretty(out, b)
	}
	return nil
}

func registry(cfg Config, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("registry", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	kind := fs.String("kind", "", "capability|plugin|template")
	output := fs.String("o", "json", "json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	b, status, contentType, err := requestWithContentType(cfg, http.MethodGet, cfg.RegistryURL, nil, "")
	if err != nil {
		return err
	}
	if err := requireOK(b, status); err != nil {
		return err
	}
	if err := requireJSONResponse(contentType, "Console Registry"); err != nil {
		return err
	}
	var reg Registry
	if err := json.Unmarshal(b, &reg); err != nil {
		return fmt.Errorf("Console Registry JSON is invalid: %w", err)
	}
	if err := validateRegistry(reg); err != nil {
		return err
	}
	if *kind == "" {
		return pretty(out, b)
	}
	_ = output // -o는 하위호환을 위해 수용하되 현재 출력은 항상 JSON이다.
	key := map[string]string{"capability": "capabilities", "plugin": "plugins", "template": "templates"}[*kind]
	if key == "" {
		return fmt.Errorf("알 수 없는 kind: %s", *kind)
	}
	selected, err := json.Marshal(map[string]any{"capabilities": reg.Capabilities, "plugins": reg.Plugins, "templates": reg.Templates}[key])
	if err != nil {
		return fmt.Errorf("Registry subset could not be encoded: %w", err)
	}
	return pretty(out, selected)
}

func requireJSONResponse(contentType, subject string) error {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || (mediaType != "application/json" && !strings.HasSuffix(mediaType, "+json")) {
		return fmt.Errorf("%s returned %q instead of JSON", subject, contentType)
	}
	return nil
}

func validateRegistry(reg Registry) error {
	if reg.Version != 3 || reg.Capabilities == nil || reg.Plugins == nil || reg.Templates == nil || reg.TrustedKeys == nil {
		return errors.New("Console Registry schema is invalid or unsupported")
	}
	for _, plugin := range reg.Plugins {
		if plugin.ID == "" || plugin.Name == "" {
			return errors.New("Console Registry contains an invalid plugin entry")
		}
		if plugin.CLI != nil && (plugin.CLI.Namespace == "" || plugin.CLI.ManifestPath == "" || plugin.CLI.APIBase == "") {
			return errors.New("Console Registry contains an invalid CLI contribution")
		}
	}
	return nil
}

var resourcePaths = map[string]string{
	"platformconfig":        "/apis/config.opensphere.io/v1alpha1/platformconfigs",
	"platformconfigs":       "/apis/config.opensphere.io/v1alpha1/platformconfigs",
	"platformversion":       "/apis/platform.opensphere.io/v1alpha1/platformversions",
	"platformversions":      "/apis/platform.opensphere.io/v1alpha1/platformversions",
	"backboneclaim":         "/apis/backbone.opensphere.io/v1alpha1/backboneclaims",
	"backboneclaims":        "/apis/backbone.opensphere.io/v1alpha1/backboneclaims",
	"uipluginpackage":       "/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-console/uipluginpackages",
	"uipluginpackages":      "/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-console/uipluginpackages",
	"uipluginregistration":  "/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-console/uipluginregistrations",
	"uipluginregistrations": "/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-console/uipluginregistrations",
}

func getResource(cfg Config, args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("사용법: os get <resource> [name] [-o json]")
	}
	path := resourcePaths[strings.ToLower(args[0])]
	if path == "" {
		return fmt.Errorf("지원하지 않는 resource %q; platformconfig, platformversion, backboneclaim, uipluginpackage를 사용하세요", args[0])
	}
	if len(args) > 1 && !strings.HasPrefix(args[1], "-") {
		path += "/" + url.PathEscape(args[1])
	}
	b, status, contentType, err := requestWithContentType(cfg, http.MethodGet, join(cfg.APIURL, path), nil, "")
	if err != nil {
		return err
	}
	if err := requireOK(b, status); err != nil {
		return err
	}
	mediaType, _, parseErr := mime.ParseMediaType(contentType)
	if parseErr != nil || (mediaType != "application/json" && !strings.HasSuffix(mediaType, "+json")) {
		return fmt.Errorf("resource API returned %q instead of JSON", contentType)
	}
	var document json.RawMessage
	if err := json.Unmarshal(b, &document); err != nil {
		return fmt.Errorf("resource API returned invalid JSON: %w", err)
	}
	return pretty(out, b)
}

func role(cfg Config, args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("사용법: os role list | grant <user> <role> --reason <사유> | revoke <user> <role> --reason <사유>")
	}
	switch args[0] {
	case "list":
		return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/identity"), nil, out)
	case "grant", "revoke":
		if len(args) < 3 {
			return fmt.Errorf("사용법: os role %s <user> <role> --reason <사유>", args[0])
		}
		flags := parseLongFlags(args[3:])
		reason := strings.TrimSpace(flags["reason"])
		if len(reason) < 8 {
			return errors.New("--reason은 8자 이상의 권한 변경 사유여야 합니다")
		}
		operation := "add"
		if args[0] == "revoke" {
			operation = "remove"
		}
		return jsonCall(cfg, http.MethodPost, join(cfg.ConsoleURL, "/api/identity/users/"+url.PathEscape(args[1])+"/group"), map[string]string{"group": args[2], "op": operation, "reason": reason}, out)
	default:
		return fmt.Errorf("알 수 없는 role 동작: %s", args[0])
	}
}

func jsonCall(cfg Config, method, rawURL string, payload any, out io.Writer) error {
	var body io.Reader
	contentType := ""
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body, contentType = bytes.NewReader(encoded), "application/json"
	}
	b, status, responseContentType, err := requestWithContentType(cfg, method, rawURL, body, contentType)
	if err != nil {
		return err
	}
	if err := requireOK(b, status); err != nil {
		return err
	}
	if status == http.StatusNoContent || len(bytes.TrimSpace(b)) == 0 {
		fmt.Fprintln(out, "{}")
		return nil
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(responseContentType, ";")[0]))
	if mediaType != "application/json" && !strings.HasSuffix(mediaType, "+json") {
		return fmt.Errorf("서버가 JSON 대신 %s 응답을 반환했습니다: %s", responseContentType, rawURL)
	}
	return pretty(out, b)
}

func tokens(cfg Config, args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("사용법: os token list | create --label <이름> --reason <사유> | revoke <jti> --reason <사유>")
	}
	switch args[0] {
	case "list":
		return jsonCall(cfg, http.MethodGet, join(cfg.IdentityURL, "/tokens"), nil, out)
	case "create":
		flags := parseLongFlags(args[1:])
		label, reason := strings.TrimSpace(flags["label"]), strings.TrimSpace(flags["reason"])
		if label == "" || len(reason) < 8 {
			return errors.New("token create에는 --label과 8자 이상의 --reason이 필요합니다")
		}
		return jsonCall(cfg, http.MethodPost, join(cfg.IdentityURL, "/tokens"), map[string]string{"label": label, "reason": reason}, out)
	case "revoke":
		reason := strings.TrimSpace(parseLongFlags(args[2:])["reason"])
		if len(args) < 2 || len(reason) < 8 {
			return errors.New("사용법: os token revoke <jti> --reason <8자 이상 사유>")
		}
		return jsonCall(cfg, http.MethodDelete, join(cfg.IdentityURL, "/tokens/"+url.PathEscape(args[1])), map[string]string{"reason": reason}, out)
	default:
		return fmt.Errorf("알 수 없는 token 동작: %s", args[0])
	}
}

func admins(cfg Config, args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "list" {
		return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/identity"), nil, out)
	}
	flags := parseLongFlags(args[1:])
	reason := strings.TrimSpace(flags["reason"])
	if len(reason) < 8 {
		return errors.New("관리 쓰기에는 8자 이상의 --reason이 필요합니다")
	}
	switch args[0] {
	case "create":
		username := strings.TrimSpace(flags["username"])
		displayName := strings.TrimSpace(flags["display-name"])
		if username == "" || displayName == "" {
			return errors.New("사용법: os admin create --username <id> --display-name <이름> [--email <주소>] [--roles a,b] --reason <사유>")
		}
		roles := []string{}
		for _, value := range strings.Split(flags["roles"], ",") {
			if value = strings.TrimSpace(value); value != "" {
				roles = append(roles, value)
			}
		}
		return jsonCall(cfg, http.MethodPost, join(cfg.ConsoleURL, "/api/identity/users"), map[string]any{
			"username": username, "displayName": displayName, "email": strings.TrimSpace(flags["email"]), "roles": roles, "reason": reason,
		}, out)
	case "enable", "disable":
		if len(args) < 2 || strings.HasPrefix(args[1], "--") {
			return fmt.Errorf("사용법: os admin %s <user-uuid> --reason <사유>", args[0])
		}
		return jsonCall(cfg, http.MethodPost, join(cfg.ConsoleURL, "/api/identity/users/"+url.PathEscape(args[1])+"/enabled"), map[string]any{"enabled": args[0] == "enable", "reason": reason}, out)
	case "onboard":
		if len(args) < 2 || strings.HasPrefix(args[1], "--") {
			return errors.New("사용법: os admin onboard <user-uuid> --reason <사유>")
		}
		return jsonCall(cfg, http.MethodPost, join(cfg.ConsoleURL, "/api/identity/users/"+url.PathEscape(args[1])+"/onboarding"), map[string]any{"reason": reason}, out)
	default:
		return fmt.Errorf("알 수 없는 admin 동작: %s", args[0])
	}
}

func backbone(cfg Config, args []string, out io.Writer) error {
	path := "/api/admin/backbone/status"
	if len(args) > 0 && args[0] == "detail" {
		flags := parseLongFlags(args[1:])
		component := strings.TrimSpace(flags["component"])
		if component == "" {
			return errors.New("사용법: os backbone detail --component postgres|rustfs|gitea")
		}
		path = "/api/admin/backbone/detail?component=" + url.QueryEscape(component)
	} else if len(args) > 0 && args[0] != "status" {
		return errors.New("사용법: os backbone status | detail --component <이름>")
	}
	return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, path), nil, out)
}

func observability(cfg Config, args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "status" {
		return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/admin/observability/status"), nil, out)
	}
	if args[0] == "targets" {
		return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/admin/observability/targets"), nil, out)
	}
	if args[0] == "query" {
		expr := strings.TrimSpace(parseLongFlags(args[1:])["expr"])
		if expr == "" {
			return errors.New("사용법: os observability query --expr <PromQL>")
		}
		return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/admin/observability/query?expr="+url.QueryEscape(expr)), nil, out)
	}
	return errors.New("사용법: os observability status|targets|query")
}

func auditLog(cfg Config, args []string, out io.Writer) error {
	if len(args) > 0 && args[0] != "list" {
		return errors.New("사용법: os audit list")
	}
	return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/admin/plugins/events"), nil, out)
}

func catalog(cfg Config, args []string, out io.Writer) error {
	path := "/api/catalog/entities"
	if len(args) > 0 && args[0] == "apis" {
		path += "?filter=kind=API"
	}
	if len(args) > 0 && args[0] != "list" && args[0] != "apis" {
		return errors.New("사용법: os catalog list|apis")
	}
	return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, path), nil, out)
}

func extensions(cfg Config, args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("사용법: os extensions inspect|install|activate|disable|uninstall|rollback|list|bindings|registry|revocations|revoke-image")
	}
	action := strings.ToLower(args[0])
	var method, path string
	var payload map[string]string
	switch action {
	case "inspect":
		if len(args) != 2 {
			return errors.New("사용법: os extensions inspect <ghcr-image:edge|candidate|stable|@sha256:digest>")
		}
		method, path, payload = http.MethodPost, "/api/admin/extensions/inspect", map[string]string{"image": args[1]}
	case "install":
		if len(args) < 2 || strings.HasPrefix(args[1], "--") {
			return errors.New("사용법: os extensions install <ghcr-image:edge|candidate|stable|@sha256:digest> --reason <승인 사유>")
		}
		flags := parseLongFlags(args[2:])
		reason := strings.TrimSpace(flags["reason"])
		if len(reason) < 8 {
			return errors.New("--reason은 8자 이상의 설치 승인 사유여야 합니다")
		}
		method, path, payload = http.MethodPost, "/api/admin/extensions/install", map[string]string{"image": args[1], "reason": reason}
	case "activate", "disable", "uninstall", "rollback":
		if len(args) != 2 || !validResourceName(args[1]) {
			return fmt.Errorf("사용법: os extensions %s <module-id>", action)
		}
		serverAction := map[string]string{"activate": "enable", "disable": "disable", "uninstall": "uninstall", "rollback": "rollback"}[action]
		method, path, payload = http.MethodPost, "/api/admin/plugins/registrations/"+url.PathEscape(args[1])+"/"+serverAction, map[string]string{}
	case "list":
		if len(args) != 1 {
			return errors.New("사용법: os extensions list")
		}
		method, path = http.MethodGet, "/api/admin/plugins/registrations"
	case "bindings":
		if len(args) == 1 || args[1] == "list" {
			method, path = http.MethodGet, "/api/admin/bindings"
		} else if len(args) == 3 && (args[1] == "enable" || args[1] == "disable") && validResourceName(args[2]) {
			method, path, payload = http.MethodPost, "/api/admin/bindings/"+url.PathEscape(args[2])+"/"+args[1], map[string]string{}
		} else {
			return errors.New("사용법: os extensions bindings list | enable|disable <binding-id>")
		}
	case "registry":
		if len(args) == 1 || args[1] == "status" {
			method, path = http.MethodGet, "/api/admin/extensions/registry-credentials"
		} else if args[1] == "login" {
			flags := parseLongFlags(args[2:])
			username, reason := strings.TrimSpace(flags["username"]), strings.TrimSpace(flags["reason"])
			if username == "" || !hasArg(args[2:], "--token-stdin") || len(reason) < 8 {
				return errors.New("사용법: os extensions registry login --username <GitHub 사용자> --token-stdin --reason <8자 이상 사유>")
			}
			secret, err := io.ReadAll(io.LimitReader(os.Stdin, 2049))
			if err != nil {
				return fmt.Errorf("registry token stdin 읽기 실패: %w", err)
			}
			tokenValue := strings.TrimSpace(string(secret))
			if len(tokenValue) < 20 || len(tokenValue) > 1024 || strings.ContainsAny(tokenValue, " \t\r\n") {
				return errors.New("유효한 package read token을 stdin으로 입력하세요")
			}
			method, path, payload = http.MethodPut, "/api/admin/extensions/registry-credentials", map[string]string{"username": username, "token": tokenValue, "reason": reason}
		} else if args[1] == "logout" {
			reason := strings.TrimSpace(parseLongFlags(args[2:])["reason"])
			if len(reason) < 8 {
				return errors.New("사용법: os extensions registry logout --reason <8자 이상 사유>")
			}
			method, path, payload = http.MethodDelete, "/api/admin/extensions/registry-credentials", map[string]string{"reason": reason}
		} else {
			return errors.New("사용법: os extensions registry status | login --username <사용자> --token-stdin --reason <사유> | logout --reason <사유>")
		}
	case "revocations":
		if len(args) != 1 {
			return errors.New("사용법: os extensions revocations")
		}
		method, path = http.MethodGet, "/api/admin/extensions/revocations"
	case "revoke-image":
		if len(args) < 2 || !strings.Contains(args[1], "@sha256:") {
			return errors.New("사용법: os extensions revoke-image <repository@sha256:digest> [--replacement <repository@sha256:digest>] --reason <8자 이상 사유>")
		}
		flags := parseLongFlags(args[2:])
		reason := strings.TrimSpace(flags["reason"])
		if len(reason) < 8 {
			return errors.New("--reason은 8자 이상의 철회 사유여야 합니다")
		}
		method, path, payload = http.MethodPost, "/api/admin/extensions/revocations", map[string]string{"image": args[1], "replacementImage": strings.TrimSpace(flags["replacement"]), "reason": reason}
	default:
		return fmt.Errorf("알 수 없는 extensions 동작: %s", action)
	}
	var body io.Reader
	contentType := ""
	if payload != nil {
		encoded, _ := json.Marshal(payload)
		body, contentType = bytes.NewReader(encoded), "application/json"
	}
	b, status, err := request(cfg, method, join(cfg.ConsoleURL, path), body, contentType)
	if err != nil {
		return err
	}
	if err := requireOK(b, status); err != nil {
		return err
	}
	return pretty(out, b)
}

func validResourceName(value string) bool {
	if len(value) < 1 || len(value) > 63 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return value[len(value)-1] != '-'
}

func dynamic(cfg Config, args []string, out, errOut io.Writer) error {
	ns := args[0]
	b, status, contentType, err := requestWithContentType(cfg, http.MethodGet, cfg.RegistryURL, nil, "")
	if err != nil {
		return err
	}
	if err := requireOK(b, status); err != nil {
		return err
	}
	if err := requireJSONResponse(contentType, "Console Registry"); err != nil {
		return err
	}
	var reg Registry
	if err := json.Unmarshal(b, &reg); err != nil {
		return err
	}
	if err := validateRegistry(reg); err != nil {
		return err
	}
	var contribution *CLIContribution
	for _, item := range reg.Plugins {
		if item.Available && item.CLI != nil && item.CLI.Namespace == ns {
			contribution = item.CLI
			break
		}
	}
	if contribution == nil {
		return fmt.Errorf("등록되고 활성화된 CLI Binding namespace가 아닙니다: %s", ns)
	}
	base := join(cfg.ConsoleURL, contribution.APIBase)
	manifestURL := join(base, contribution.ManifestPath)
	manifestBytes, status, manifestContentType, err := requestWithContentType(cfg, http.MethodGet, manifestURL, nil, "")
	if err != nil {
		return err
	}
	if err := requireOK(manifestBytes, status); err != nil {
		return err
	}
	if err := requireJSONResponse(manifestContentType, "CLI contribution manifest"); err != nil {
		return err
	}
	if len(args) == 1 || args[1] == "manifest" {
		return pretty(out, manifestBytes)
	}
	var manifest ToolManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return err
	}
	if manifest.Kind == "" || len(manifest.Tools) == 0 {
		return errors.New("CLI contribution manifest schema is invalid")
	}
	commandWords := nonFlagArgs(args[1:])
	var selected *Tool
	for i := range manifest.Tools {
		words := toolCommandPrefix(manifest.Tools[i].Command, ns)
		if len(words) > 0 && len(commandWords) >= len(words) && strings.Join(words, " ") == strings.Join(commandWords[:len(words)], " ") {
			selected = &manifest.Tools[i]
			break
		}
	}
	if selected == nil {
		available := make([]string, 0, len(manifest.Tools))
		for _, tool := range manifest.Tools {
			available = append(available, tool.Command)
		}
		sort.Strings(available)
		return fmt.Errorf("명령을 찾을 수 없습니다; 사용 가능: %s", strings.Join(available, ", "))
	}
	flags := parseLongFlags(args[1:])
	method := strings.ToUpper(selected.Method)
	path := selected.Path
	if len(selected.Components) > 0 {
		component := strings.TrimSpace(flags["component"])
		route, ok := selected.Components[component]
		if !ok {
			return errors.New("지원 서비스 명령에는 유효한 --component 값이 필요합니다")
		}
		if hasArg(args, "--apply") {
			method, path = http.MethodPost, route.ApplyPath
		} else {
			method, path = http.MethodGet, route.PreviewPath
		}
	}
	if len(selected.Operations) > 0 {
		prefix := toolCommandPrefix(selected.Command, ns)
		if len(commandWords) <= len(prefix) {
			return errors.New("GPU bridge 명령에는 operation이 필요합니다")
		}
		route, ok := selected.Operations[commandWords[len(prefix)]]
		if !ok || route.Path == "" {
			return fmt.Errorf("지원하지 않는 GPU bridge operation: %s", commandWords[len(prefix)])
		}
		path = route.Path
	}
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && !hasArg(args, "--preview") && !hasArg(args, "--apply") {
		return errors.New("write 명령은 --preview 또는 --apply를 명시해야 합니다")
	}
	target := join(base, path)
	var body io.Reader
	contentType = ""
	if method == http.MethodGet {
		u, _ := url.Parse(target)
		q := u.Query()
		for k, v := range flags {
			q.Set(k, v)
		}
		u.RawQuery = q.Encode()
		target = u.String()
	} else {
		payload, _ := json.Marshal(jsonFlagPayload(flags))
		body, contentType = bytes.NewReader(payload), "application/json"
	}
	response, status, err := request(cfg, method, target, body, contentType)
	if err != nil {
		return err
	}
	if err := requireOK(response, status); err != nil {
		return err
	}
	_ = errOut
	return pretty(out, response)
}

func toolCommandPrefix(command, ns string) []string {
	words := strings.Fields(command)
	if len(words) >= 2 && words[0] == "os" && words[1] == ns {
		words = words[2:]
	}
	prefix := make([]string, 0, len(words))
	for _, word := range words {
		if strings.HasPrefix(word, "--") || strings.HasPrefix(word, "<") || strings.HasPrefix(word, "(") {
			break
		}
		prefix = append(prefix, word)
	}
	return prefix
}

func jsonFlagPayload(flags map[string]string) map[string]string {
	payload := make(map[string]string, len(flags))
	for key, value := range flags {
		parts := strings.Split(key, "-")
		for i := 1; i < len(parts); i++ {
			if len(parts[i]) > 0 {
				parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
			}
		}
		payload[strings.Join(parts, "")] = value
	}
	return payload
}

func nonFlagArgs(args []string) []string {
	var out []string
	for _, arg := range args {
		if strings.HasPrefix(arg, "--") {
			break
		}
		out = append(out, arg)
	}
	return out
}

func hasArg(args []string, expected string) bool {
	for _, arg := range args {
		if arg == expected {
			return true
		}
	}
	return false
}

func parseLongFlags(args []string) map[string]string {
	result := map[string]string{}
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "--") {
			continue
		}
		key := strings.TrimPrefix(args[i], "--")
		value := "true"
		if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
			value = args[i+1]
			i++
		}
		result[key] = value
	}
	return result
}

func printHelp(out io.Writer) {
	fmt.Fprintln(out, `os — OpenSphere Console native 관리자 CLI. console==cli: 동일 Registry·API·Supabase RBAC 소비.

  os login [--console URL] [--label DEVICE]   (Supabase 브라우저 세션에서 한 번 승인 → OS 보안 저장소에 디바이스 키 등록)
  os whoami
  os logout                                    (서버 디바이스 신뢰 + 로컬 키 동시 폐기)
  os device list | revoke <device-id> --reason <사유>
  os token list | create --label <이름> --reason <사유> | revoke <jti> --reason <사유>
  os admin list | create|enable|disable|onboard ... --reason <사유>
  os registry [--kind capability|plugin|template] [-o json]
  os catalog list | apis
  os backbone status | detail --component <이름>
  os observability status | targets | query --expr <PromQL>
  os audit list
  os extensions inspect <ghcr-image:edge|candidate|stable|@sha256:digest>
  os extensions install <ghcr-image:edge|candidate|stable|@sha256:digest> --reason <승인 사유>
  os extensions activate|disable|uninstall|rollback <module-id> | list
  os extensions bindings list | enable|disable <binding-id>
  os extensions registry status
  os extensions registry login --username <GitHub 사용자> --token-stdin --reason <승인 사유>
  os extensions registry logout --reason <승인 사유>
  os extensions revocations
  os extensions revoke-image <repository@sha256:digest> [--replacement <repository@sha256:digest>] --reason <철회 사유>
  os get <resource> [name] [-o json]
  os role list | grant|revoke <user> <role> --reason <사유>
  os <namespace> [명령...] [-o json]
  os version | help

현재 native 프로파일은 Supabase 사용자·역할을 매 요청 확인하는 admin 디바이스 신뢰 + 15분 서명 세션을 사용한다. 개인키는 config.json에 저장하지 않는다.
비대화형 자동화는 별도 Supabase 관리 API token(OS_PAT), 향후 workforce는 승인된 CLI Binding으로 분리한다.
설정 ~/.os/config.json(비밀 없음) · 보안키 Windows DPAPI/macOS Keychain/Linux Secret Service.`)
}

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "오류:", err)
		os.Exit(1)
	}
}
