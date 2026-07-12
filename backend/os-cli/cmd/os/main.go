package main

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var version = "0.2.0"

type Config struct {
	Profile     string `json:"profile"`
	PAT         string `json:"pat,omitempty"`
	IDToken     string `json:"idToken,omitempty"`
	RegistryURL string `json:"registryUrl"`
	APIURL      string `json:"apiUrl"`
	BFFURL      string `json:"bffUrl"`
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
	Capabilities []map[string]any `json:"capabilities"`
	Plugins      []RegistryItem   `json:"plugins"`
	Templates    []map[string]any `json:"templates"`
}

type Tool struct {
	Command     string `json:"command"`
	Method      string `json:"method"`
	Path        string `json:"path"`
	Description string `json:"description"`
	Risk        string `json:"risk"`
	Scope       string `json:"scope"`
}

type ToolManifest struct {
	Kind  string `json:"kind"`
	Tools []Tool `json:"tools"`
}

func defaults() Config {
	console := env("OS_CONSOLE", "http://localhost:8090")
	return Config{
		Profile:     "admin",
		PAT:         os.Getenv("OS_PAT"),
		IDToken:     os.Getenv("OS_ID_TOKEN"),
		RegistryURL: env("OS_REGISTRY", console+"/api/v1/registry"),
		APIURL:      env("OS_API", console+"/api/proxy"),
		BFFURL:      env("OS_BFF", console),
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
	return cfg, nil
}

func saveConfig(cfg Config) error {
	if cfg.Profile != "admin" {
		return errors.New("현재 native os CLI는 admin 프로파일만 허용합니다; workforce는 승인된 Binding으로 추가해야 합니다")
	}
	for _, raw := range []string{cfg.RegistryURL, cfg.APIURL, cfg.BFFURL, cfg.ConsoleURL} {
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
	if err := validateURL(rawURL); err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequest(method, rawURL, body)
	if err != nil {
		return nil, 0, err
	}
	if cfg.PAT != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.PAT)
	}
	if cfg.IDToken != "" {
		req.Header.Set("X-OS-Id-Token", cfg.IDToken)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-OS-Correlation-ID", operationID())
	resp, err := client().Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return b, resp.StatusCode, err
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

func run(args []string, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		printHelp(out)
		return nil
	}
	if args[0] == "version" || args[0] == "--version" {
		fmt.Fprintf(out, "os %s\n", version)
		return nil
	}
	if args[0] == "login" {
		return login(args[1:], out)
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	switch args[0] {
	case "whoami":
		return whoami(cfg, out)
	case "registry":
		return registry(cfg, args[1:], out)
	case "get":
		return getResource(cfg, args[1:], out)
	case "role":
		return role(cfg, args[1:], out)
	default:
		return dynamic(cfg, args, out, errOut)
	}
}

func login(args []string, out io.Writer) error {
	cfg, _ := loadConfig()
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	pat := fs.String("pat", cfg.PAT, "admin PAT")
	idToken := fs.String("id-token", cfg.IDToken, "Kanidm/OIDC id_token")
	registryURL := fs.String("registry", cfg.RegistryURL, "Registry URL")
	apiURL := fs.String("api", cfg.APIURL, "API proxy URL")
	bffURL := fs.String("bff", cfg.BFFURL, "BFF URL")
	consoleURL := fs.String("console", cfg.ConsoleURL, "Console URL")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*pat) == "" {
		return errors.New("--pat 또는 OS_PAT가 필요합니다")
	}
	cfg = Config{Profile: "admin", PAT: *pat, IDToken: *idToken, RegistryURL: *registryURL, APIURL: *apiURL, BFFURL: *bffURL, ConsoleURL: *consoleURL}
	if err := whoami(cfg, io.Discard); err != nil {
		return fmt.Errorf("PAT 검증 실패(설정은 저장하지 않음): %w", err)
	}
	if err := saveConfig(cfg); err != nil {
		return err
	}
	fmt.Fprintln(out, "admin 프로파일이 저장되고 검증되었습니다")
	return nil
}

func whoami(cfg Config, out io.Writer) error {
	if cfg.PAT == "" {
		return errors.New("PAT가 없습니다; os login --pat <TOKEN>을 실행하세요")
	}
	form := url.Values{"token": {cfg.PAT}}.Encode()
	b, status, err := request(cfg, http.MethodPost, join(cfg.BFFURL, "/bff/pat/introspect"), strings.NewReader(form), "application/x-www-form-urlencoded")
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
		return errors.New("PAT가 비활성 또는 폐기 상태입니다")
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
	b, status, err := request(cfg, http.MethodGet, cfg.RegistryURL, nil, "")
	if err != nil {
		return err
	}
	if err := requireOK(b, status); err != nil {
		return err
	}
	if *kind == "" || *output == "json" && *kind == "" {
		return pretty(out, b)
	}
	var reg map[string]json.RawMessage
	if err := json.Unmarshal(b, &reg); err != nil {
		return err
	}
	key := map[string]string{"capability": "capabilities", "plugin": "plugins", "template": "templates"}[*kind]
	if key == "" {
		return fmt.Errorf("알 수 없는 kind: %s", *kind)
	}
	return pretty(out, reg[key])
}

var resourcePaths = map[string]string{
	"platformconfig":        "/apis/config.opensphere.io/v1alpha1/platformconfigs",
	"platformconfigs":       "/apis/config.opensphere.io/v1alpha1/platformconfigs",
	"platformversion":       "/apis/platform.opensphere.io/v1alpha1/platformversions",
	"platformversions":      "/apis/platform.opensphere.io/v1alpha1/platformversions",
	"backboneclaim":         "/apis/backbone.opensphere.io/v1alpha1/backboneclaims",
	"backboneclaims":        "/apis/backbone.opensphere.io/v1alpha1/backboneclaims",
	"uipluginpackage":       "/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-system/uipluginpackages",
	"uipluginpackages":      "/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-system/uipluginpackages",
	"uipluginregistration":  "/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-system/uipluginregistrations",
	"uipluginregistrations": "/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-system/uipluginregistrations",
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
	b, status, err := request(cfg, http.MethodGet, join(cfg.APIURL, path), nil, "")
	if err != nil {
		return err
	}
	if err := requireOK(b, status); err != nil {
		return err
	}
	return pretty(out, b)
}

func role(cfg Config, args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("사용법: os role list | grant <user> <role> | revoke <user> <role>")
	}
	method, path := http.MethodGet, "/bff/roles"
	var body io.Reader
	contentType := ""
	switch args[0] {
	case "list":
	case "grant", "revoke":
		if len(args) != 3 {
			return fmt.Errorf("사용법: os role %s <user> <role>", args[0])
		}
		method, path = http.MethodPost, "/bff/roles/"+args[0]
		body = strings.NewReader(url.Values{"user": {args[1]}, "role": {args[2]}}.Encode())
		contentType = "application/x-www-form-urlencoded"
	default:
		return fmt.Errorf("알 수 없는 role 동작: %s", args[0])
	}
	b, status, err := request(cfg, method, join(cfg.BFFURL, path), body, contentType)
	if err != nil {
		return err
	}
	if err := requireOK(b, status); err != nil {
		return err
	}
	return pretty(out, b)
}

func dynamic(cfg Config, args []string, out, errOut io.Writer) error {
	ns := args[0]
	b, status, err := request(cfg, http.MethodGet, cfg.RegistryURL, nil, "")
	if err != nil {
		return err
	}
	if err := requireOK(b, status); err != nil {
		return err
	}
	var reg Registry
	if err := json.Unmarshal(b, &reg); err != nil {
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
	manifestBytes, status, err := request(cfg, http.MethodGet, manifestURL, nil, "")
	if err != nil {
		return err
	}
	if err := requireOK(manifestBytes, status); err != nil {
		return err
	}
	if len(args) == 1 || args[1] == "manifest" {
		return pretty(out, manifestBytes)
	}
	var manifest ToolManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return err
	}
	commandWords := nonFlagArgs(args[1:])
	var selected *Tool
	for i := range manifest.Tools {
		words := strings.Fields(manifest.Tools[i].Command)
		if len(words) >= 2 && words[0] == "os" && words[1] == ns {
			words = words[2:]
		}
		if strings.Join(words, " ") == strings.Join(commandWords, " ") {
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
	method := strings.ToUpper(selected.Method)
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && !hasArg(args, "--preview") && !hasArg(args, "--apply") {
		return errors.New("write 명령은 --preview 또는 --apply를 명시해야 합니다")
	}
	flags := parseLongFlags(args[1:])
	target := join(base, selected.Path)
	var body io.Reader
	contentType := ""
	if method == http.MethodGet {
		u, _ := url.Parse(target)
		q := u.Query()
		for k, v := range flags {
			q.Set(k, v)
		}
		u.RawQuery = q.Encode()
		target = u.String()
	} else {
		payload, _ := json.Marshal(flags)
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
	fmt.Fprintln(out, `os — OpenSphere Console native 관리자 CLI. console==cli: 동일 Registry·API·Kanidm PAT 소비.

  os login --pat <TOKEN> [--id-token <JWT>] [--registry URL] [--api URL] [--bff URL] [--console URL]
  os whoami
  os registry [--kind capability|plugin|template] [-o json]
  os get <resource> [name] [-o json]
  os role list | grant <user> <role> | revoke <user> <role>
  os <namespace> [명령...] [-o json]
  os version | help

현재 native 프로파일은 admin(Kanidm/BFF PAT)만 소유한다.
향후 workforce 인증·권한·명령은 승인된 CLI Binding으로 별도 프로파일에 추가하며 admin PAT와 혼용하지 않는다.
설정 ~/.os/config.json · env OS_PAT/OS_ID_TOKEN/OS_REGISTRY/OS_API/OS_BFF/OS_CONSOLE.`)
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "오류:", err)
		os.Exit(1)
	}
}
