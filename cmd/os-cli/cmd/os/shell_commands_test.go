package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestShellCommandUsesCommonEndpointAndPreservesRequestID(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "POST" || r.URL.Path != "/api/os-shell/commands" || r.Header.Get("Authorization") != "Bearer test-only" {
			t.Errorf("unexpected command boundary")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["command"] != "hiss.install" || body["requestId"] != "11111111-1111-4111-8111-111111111111" {
			t.Fatalf("bad request %#v", body)
		}
		if body["arguments"].(map[string]any)["id"] != "cert-manager" {
			t.Fatal("module lost")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"schema": "opensphere.shell-command/v1", "controlPlane": "OS-Shell", "command": body["command"], "requestId": body["requestId"], "data": map[string]any{"operation": map[string]any{"phase": "Queued"}}})
	}))
	defer server.Close()
	cfg := defaults()
	cfg.testBearer = "test-only"
	cfg.ConsoleURL = server.URL
	var out bytes.Buffer
	err := shellCommands(cfg, []string{"execute", "hiss.install", "--id", "cert-manager", "--reason", "approved lifecycle test", "--request-id", "11111111-1111-4111-8111-111111111111"}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || !strings.Contains(out.String(), "Queued") {
		t.Fatalf("unexpected outcome %s", out.String())
	}
}

func TestShellCommandFailureIsNotRetriedAndPrintsRecoveryID(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		w.Write([]byte(`{"code":"OwnerUnavailable","message":"unknown outcome","sideEffect":"unknown"}`))
	}))
	defer server.Close()
	cfg := defaults()
	cfg.testBearer = "test-only"
	cfg.ConsoleURL = server.URL
	err := shellCommands(cfg, []string{"execute", "hiss.install", "--id", "cert-manager", "--reason", "approved lifecycle test", "--request-id", "11111111-1111-4111-8111-111111111111"}, strings.NewReader(""), &bytes.Buffer{})
	if err == nil || calls != 1 || !strings.Contains(err.Error(), "11111111-1111-4111-8111-111111111111") {
		t.Fatalf("unsafe failure: %v; calls=%d", err, calls)
	}
}

func TestShellCommandDefaultRequestIDCanExecuteAndIsUnique(t *testing.T) {
	seen := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		id, _ := body["requestId"].(string)
		if !installationOperationPattern.MatchString(id) || seen[id] {
			t.Fatalf("invalid or reused request ID: %s", id)
		}
		seen[id] = true
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"schema": "opensphere.shell-command/v1", "controlPlane": "OS-Shell", "command": body["command"], "requestId": id, "data": map[string]any{"id": "cert-manager"}})
	}))
	defer server.Close()
	cfg := defaults()
	cfg.testBearer = "test-only"
	cfg.ConsoleURL = server.URL
	for i := 0; i < 2; i++ {
		if err := shellCommands(cfg, []string{"execute", "hiss.inspect", "--id", "cert-manager"}, strings.NewReader(""), &bytes.Buffer{}); err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != 2 {
		t.Fatalf("default invocation did not reach OS Shell: %d requests", len(seen))
	}
}
