package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Retain the owner receipt fixtures while exercising the actual common wire
// contract. Any direct C_API request fails before reaching the owner fixture.
func installationShellTestServer(t *testing.T, owner http.Handler) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/os-shell/commands" {
			t.Errorf("CLI bypassed OS Shell: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(400)
			return
		}
		var input struct {
			Command   string         `json:"command"`
			RequestID string         `json:"requestId"`
			Arguments map[string]any `json:"arguments"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || !installationOperationPattern.MatchString(input.RequestID) {
			t.Error("missing command identity")
			w.WriteHeader(400)
			return
		}
		path, method := "", http.MethodGet
		switch input.Command {
		case "console.modules.catalog":
			path = "/api/admin/extensions/catalog"
		case "console.modules.inspect":
			path, method = "/api/admin/extensions/inspect", http.MethodPost
		case "console.modules.install":
			path, method = "/api/admin/extensions/install", http.MethodPost
		case "console.modules.operation":
			id, _ := input.Arguments["operationId"].(string)
			path = "/api/platform/operations/" + id
		default:
			t.Errorf("unknown native command %s", input.Command)
			w.WriteHeader(400)
			return
		}
		raw, _ := json.Marshal(input.Arguments)
		request := httptest.NewRequest(method, path, bytes.NewReader(raw))
		request.Header.Set("X-OS-Idempotency-Key", input.RequestID)
		result := httptest.NewRecorder()
		owner.ServeHTTP(result, request)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(result.Code)
		if result.Code >= 400 {
			_, _ = w.Write(result.Body.Bytes())
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"schema": "opensphere.shell-command/v1", "controlPlane": "OS-Shell", "owner": "console", "command": input.Command, "requestId": input.RequestID, "data": json.RawMessage(result.Body.Bytes())})
	}))
}
