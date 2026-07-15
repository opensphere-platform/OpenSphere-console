// Setup bootstrap E2E integration: port-forward the console-ext service and set
// OS_E2E_CONSOLE to its HTTPS base URL, write the auth-ca secret's Installation
// CA PEM to a file and set OS_E2E_CACERT to that path, mint a fresh admin
// automation PAT and set OS_E2E_PAT, then run: go test ./cmd/os -run Console

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestConsoleAuthenticatedCommandsAndVerifiedTLS(t *testing.T) {
	console := strings.TrimRight(strings.TrimSpace(os.Getenv("OS_E2E_CONSOLE")), "/")
	caCert := strings.TrimSpace(os.Getenv("OS_E2E_CACERT"))
	pat := strings.TrimSpace(os.Getenv("OS_E2E_PAT"))
	if console == "" || caCert == "" || pat == "" {
		t.Skip("real console E2E skipped: OS_E2E_CONSOLE, OS_E2E_CACERT, and OS_E2E_PAT must all be set")
	}

	t.Setenv("OS_PAT", pat)
	t.Setenv("OS_CONFIG", filepath.Join(t.TempDir(), "config.json"))
	t.Setenv("OS_CONSOLE", console)
	t.Setenv("OS_BFF", console)
	t.Setenv("OS_API", console+"/api/proxy")
	t.Setenv("OS_REGISTRY", console+"/api/v1/registry")
	unsetConsoleE2EEnv(t, "OS_CACERT")
	unsetConsoleE2EEnv(t, "OS_INSECURE_SKIP_TLS_VERIFY")

	registry := runConsoleE2EJSON(t, caCert, "registry", "-o", "json")
	registryObject, ok := registry.(map[string]any)
	if !ok {
		t.Fatalf("registry output must be a JSON object, got %T", registry)
	}
	for _, field := range []string{"capabilities", "plugins", "templates"} {
		if _, ok := registryObject[field].([]any); !ok {
			t.Fatalf("registry.%s must be an array, got %T", field, registryObject[field])
		}
	}

	for _, command := range [][]string{
		{"catalog", "list", "-o", "json"},
		{"api", "list", "-o", "json"},
		{"device", "list", "-o", "json"},
	} {
		value := runConsoleE2EJSON(t, caCert, command...)
		if _, ok := value.([]any); !ok {
			t.Fatalf("os %s output must be a JSON array, got %T", strings.Join(command[:2], " "), value)
		}
	}
	if audit := runConsoleE2EJSON(t, caCert, "audit", "list", "-o", "json"); audit == nil {
		t.Fatal("os audit list returned JSON null")
	}

	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	label, reason := "e2e-"+suffix, "e2e-"+suffix
	var jti string
	t.Cleanup(func() {
		if jti != "" {
			_ = runConsoleE2E(caCert, "token", "revoke", jti, "--reason", "e2e cleanup", "--apply")
		}
	})

	created := runConsoleE2EJSON(t, caCert, "token", "create", "--label", label, "--reason", reason, "--apply", "-o", "json")
	jti = findConsoleE2EString(created, "jti")
	if jti == "" {
		t.Fatalf("token create response does not contain a non-empty jti: %v", created)
	}
	listed := runConsoleE2EJSON(t, caCert, "token", "list", "-o", "json")
	if !consoleE2ETokenActive(listed, jti) {
		t.Fatalf("token list does not show jti %q active: %v", jti, listed)
	}
	if err := runConsoleE2E(caCert, "token", "revoke", jti, "--reason", "e2e cleanup", "--apply"); err != nil {
		t.Fatalf("os token revoke failed: %v", err)
	}
	listed = runConsoleE2EJSON(t, caCert, "token", "list", "-o", "json")
	if consoleE2ETokenActive(listed, jti) {
		t.Fatalf("revoked token jti %q is still active: %v", jti, listed)
	}

	var out, errOut bytes.Buffer
	err := run([]string{"registry", "-o", "json"}, strings.NewReader(""), &out, &errOut)
	if err == nil || !strings.Contains(err.Error(), "TLS 인증서를 신뢰할 수 없습니다") ||
		!strings.Contains(err.Error(), "--ca-bundle") {
		t.Fatalf("registry without the Installation CA must fail with untrusted-certificate guidance, got err=%v output=%q", err, out.String())
	}
}

func runConsoleE2EJSON(t *testing.T, caCert string, args ...string) any {
	t.Helper()
	var out, errOut bytes.Buffer
	withCA := append(append([]string{}, args...), "--ca-bundle", caCert)
	if err := run(withCA, strings.NewReader(""), &out, &errOut); err != nil {
		t.Fatalf("os %s failed: %v; stderr=%q; stdout=%q", strings.Join(args, " "), err, errOut.String(), out.String())
	}
	var value any
	if err := json.Unmarshal(out.Bytes(), &value); err != nil {
		t.Fatalf("os %s did not return valid JSON: %v; output=%q", strings.Join(args, " "), err, out.String())
	}
	return value
}

func runConsoleE2E(caCert string, args ...string) error {
	withCA := append(append([]string{}, args...), "--ca-bundle", caCert)
	return run(withCA, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{})
}

func findConsoleE2EString(value any, key string) string {
	switch value := value.(type) {
	case map[string]any:
		if found, ok := value[key].(string); ok && found != "" {
			return found
		}
		for _, child := range value {
			if found := findConsoleE2EString(child, key); found != "" {
				return found
			}
		}
	case []any:
		for _, child := range value {
			if found := findConsoleE2EString(child, key); found != "" {
				return found
			}
		}
	}
	return ""
}

func consoleE2ETokenActive(value any, jti string) bool {
	switch value := value.(type) {
	case map[string]any:
		if valueJTI, _ := value["jti"].(string); valueJTI == jti {
			active, _ := value["active"].(bool)
			return active
		}
		for _, child := range value {
			if consoleE2ETokenActive(child, jti) {
				return true
			}
		}
	case []any:
		for _, child := range value {
			if consoleE2ETokenActive(child, jti) {
				return true
			}
		}
	}
	return false
}

func unsetConsoleE2EEnv(t *testing.T, name string) {
	t.Helper()
	old, existed := os.LookupEnv(name)
	if err := os.Unsetenv(name); err != nil {
		t.Fatal(fmt.Errorf("unset %s: %w", name, err))
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv(name, old)
		} else {
			_ = os.Unsetenv(name)
		}
	})
}
