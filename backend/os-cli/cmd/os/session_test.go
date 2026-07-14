package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func sessionFixture(t *testing.T) (Config, func()) {
	t.Helper()
	der, _, e := generateDeviceKey()
	if e != nil {
		t.Fatal(e)
	}
	old := deviceKeyLoad
	deviceKeyLoad = func(string) ([]byte, error) { return der, nil }
	exp := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC).Unix()
	payload, _ := json.Marshal(map[string]any{"exp": exp})
	token := "e30." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/bff/cli/challenge":
			json.NewEncoder(w).Encode(map[string]string{"challengeId": strings.Repeat("c", 32), "nonce": "n"})
		case "/bff/cli/session":
			json.NewEncoder(w).Encode(map[string]string{"accessToken": token})
		case "/bff/token/introspect":
			json.NewEncoder(w).Encode(map[string]any{"active": true, "username": "alice", "groups": []string{"admins", "ops"}})
		default:
			http.NotFound(w, r)
		}
	}))
	c := Config{Kind: "admin", Profile: "admin", DeviceID: strings.Repeat("d", 32), DeviceLabel: "laptop", BFFURL: srv.URL, profileName: "staging"}
	return c, func() { srv.Close(); deviceKeyLoad = old }
}
func TestWhoamiShowsProfileDeviceExpiryAndJSONShape(t *testing.T) {
	c, done := sessionFixture(t)
	defer done()
	var out bytes.Buffer
	if e := whoami(c, &formattedOutput{Writer: &out, options: outputOptions{Format: "json", Limit: -1, Explicit: true}}); e != nil {
		t.Fatal(e)
	}
	var v map[string]any
	if json.Unmarshal(out.Bytes(), &v) != nil {
		t.Fatalf("not json: %s", out.String())
	}
	if v["username"] != "alice" || v["trusted"] != true {
		t.Fatalf("identity/trust: %#v", v)
	}
	p := v["profile"].(map[string]any)
	d := v["device"].(map[string]any)
	s := v["session"].(map[string]any)
	if p["name"] != "staging" || p["kind"] != "admin" || d["label"] != "laptop" || d["deviceId"] != c.DeviceID || d["fingerprint"] == nil || s["expiresAt"] != "2030-01-02T03:04:05Z" {
		t.Fatalf("shape: %#v", v)
	}
}
func TestSessionStatusOKAndNoDevice(t *testing.T) {
	c, done := sessionFixture(t)
	defer done()
	var out bytes.Buffer
	if e := sessionCommand(c, []string{"status"}, &formattedOutput{Writer: &out, options: outputOptions{Format: "json", Limit: -1, Explicit: true}}); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(out.String(), "\"state\": \"ok\"") || !strings.Contains(out.String(), "2030-01-02T03:04:05Z") {
		t.Fatal(out.String())
	}
	out.Reset()
	c.DeviceID = ""
	if e := sessionCommand(c, []string{"status"}, &formattedOutput{Writer: &out, options: outputOptions{Format: "json", Limit: -1, Explicit: true}}); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(out.String(), "no_device") || !strings.Contains(out.String(), "os login") {
		t.Fatal(out.String())
	}
}
func TestSessionRefreshReturnsNewExpiry(t *testing.T) {
	c, done := sessionFixture(t)
	defer done()
	var out bytes.Buffer
	if e := sessionCommand(c, []string{"refresh"}, &formattedOutput{Writer: &out, options: outputOptions{Format: "json", Limit: -1, Explicit: true}}); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(out.String(), "2030-01-02T03:04:05Z") {
		t.Fatal(out.String())
	}
}
