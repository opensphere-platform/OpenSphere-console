package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func testBinding() runtimeBinding {
	return runtimeBinding{
		SessionID: "session-1", ActorID: "operator-1", Origin: "https://localhost:1114",
		SessionClass: fixedSessionClass, RuntimeAdapterID: fixedRuntimeAdapterID,
		NetworkProfile: fixedNetworkProfile, RuntimeUID: "pod-uid-1",
		PermissionRevision: "permission-1", AssuranceLevel: "aal2",
		ReleaseEvidenceRef: "release-1", Generation: 3, FencingEpoch: 7,
	}
}

func setBindingEnvironment(t *testing.T, binding runtimeBinding) {
	t.Helper()
	values := map[string]string{
		"OPENSPHERE_SHELL_SESSION_ID":           binding.SessionID,
		"OPENSPHERE_SHELL_ACTOR_ID":             binding.ActorID,
		"OPENSPHERE_SHELL_ORIGIN":               binding.Origin,
		"OPENSPHERE_SHELL_SESSION_CLASS":        binding.SessionClass,
		"OPENSPHERE_SHELL_RUNTIME_ADAPTER_ID":   binding.RuntimeAdapterID,
		"OPENSPHERE_SHELL_NETWORK_PROFILE":      binding.NetworkProfile,
		"OPENSPHERE_SHELL_RUNTIME_UID":          binding.RuntimeUID,
		"OPENSPHERE_SHELL_PERMISSION_REVISION":  binding.PermissionRevision,
		"OPENSPHERE_SHELL_AAL":                  binding.AssuranceLevel,
		"OPENSPHERE_SHELL_RELEASE_EVIDENCE_REF": binding.ReleaseEvidenceRef,
		"OPENSPHERE_SHELL_GENERATION":           fmt.Sprint(binding.Generation),
		"OPENSPHERE_SHELL_FENCING_EPOCH":        fmt.Sprint(binding.FencingEpoch),
	}
	for name, value := range values {
		t.Setenv(name, value)
	}
}

func TestRuntimeBindingIsClosedAndRejectsKubeVirt(t *testing.T) {
	binding := testBinding()
	setBindingEnvironment(t, binding)
	loaded, err := loadRuntimeBinding()
	if err != nil || loaded != binding {
		t.Fatalf("unexpected binding: %#v err=%v", loaded, err)
	}
	t.Setenv("OPENSPHERE_SHELL_RUNTIME_ADAPTER_ID", "cbss.kubevirt-vmi")
	if _, err := loadRuntimeBinding(); err == nil || !strings.Contains(err.Error(), "KubeVirt") {
		t.Fatalf("KubeVirt must fail closed: %v", err)
	}
	t.Setenv("OPENSPHERE_SHELL_RUNTIME_ADAPTER_ID", fixedRuntimeAdapterID)
	t.Setenv("OPENSPHERE_SHELL_COMMAND", "/bin/sh")
	if _, err := loadRuntimeBinding(); err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("arbitrary command must fail closed: %v", err)
	}
}

func TestConsoleAPIExecutionEndpointIsNotTheBrowserOrigin(t *testing.T) {
	t.Setenv("OPENSPHERE_SHELL_CONSOLE_API_URL", fixedConsoleAPIURL)
	endpoint, err := loadConsoleAPIURL()
	if err != nil || endpoint != fixedConsoleAPIURL {
		t.Fatalf("closed Console API endpoint rejected: %q err=%v", endpoint, err)
	}
	for _, invalid := range []string{"https://localhost:1114", "http://opensphere-shell-console-api.opensphere-console.svc.cluster.local:8445", "https://other.example:8445"} {
		t.Setenv("OPENSPHERE_SHELL_CONSOLE_API_URL", invalid)
		if _, err := loadConsoleAPIURL(); err == nil {
			t.Fatalf("browser/user-selected execution endpoint must be rejected: %s", invalid)
		}
	}
}

func TestEd25519ContextMatchesCLIAndRejectsStaleEpoch(t *testing.T) {
	fixedNow := time.Date(2026, 8, 15, 8, 0, 0, 0, time.UTC)
	identity, err := newSigningIdentity(fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	binding := testBinding()
	contextJWS, err := identity.signContext(binding, internalPTYAudience, "nonce-1", fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyInternalContext(contextJWS, identity.publicKey, identity.keyID, binding, "nonce-1", fixedNow); err != nil {
		t.Fatal(err)
	}
	stale := binding
	stale.FencingEpoch++
	if err := verifyInternalContext(contextJWS, identity.publicKey, identity.keyID, stale, "nonce-1", fixedNow); err == nil {
		t.Fatal("stale fencing epoch must be rejected")
	}
	cliJWS, err := identity.signContext(binding, cliAudience, "", fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	parts := splitCompactJWS(cliJWS)
	payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var claims webShellClaims
	if json.Unmarshal(payload, &claims) != nil || claims.Contract != contextContract || claims.Profile != "web-shell" || claims.Authority != "delegated-credential-agent" || claims.Audience != cliAudience {
		t.Fatalf("CLI wire contract mismatch: %s", payload)
	}
}

func TestProjectedBootstrapRegistrationAndCredentialExchange(t *testing.T) {
	fixedNow := time.Date(2026, 8, 15, 8, 0, 0, 0, time.UTC)
	originalNow, originalClient, originalBootstrap, originalSleep := now, controlHTTPClient, bootstrapTokenPath, registrationSleep
	now = func() time.Time { return fixedNow }
	registrationSleep = func(context.Context, time.Duration) error { return nil }
	defer func() {
		now, controlHTTPClient, bootstrapTokenPath, registrationSleep = originalNow, originalClient, originalBootstrap, originalSleep
	}()
	binding := testBinding()
	identity, _ := newSigningIdentity(fixedNow)
	bootstrap := "projected-bound-service-account-token-1234567890"
	var runtimeCredentialHash string
	registrationAttempts := 0
	bootstrapTokenPath = filepath.Join(t.TempDir(), "bootstrap-token")
	if err := os.WriteFile(bootstrapTokenPath, []byte(bootstrap), 0o400); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/internal/runtime/register":
			registrationAttempts++
			if request.Header.Get("Authorization") != "Bearer "+bootstrap {
				t.Errorf("registration did not use projected token")
			}
			var registration registrationRequest
			_ = json.NewDecoder(io.LimitReader(request.Body, maxControlMessage)).Decode(&registration)
			fingerprint := strings.TrimPrefix(registration.TLSCertificateSHA256, "sha256:")
			credentialHash := strings.TrimPrefix(registration.RuntimeCredentialHash, "sha256:")
			if registration.Binding != binding || len(fingerprint) != sha256.Size*2 ||
				len(credentialHash) != sha256.Size*2 || registration.TLSCertificateSHA256 != identity.tlsCertificateSHA256 ||
				registration.PublicKeyPEM == "" {
				t.Errorf("invalid registration: %#v", registration)
			}
			if registrationAttempts == 1 {
				w.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "RuntimeRegistrationNotReady"})
				return
			}
			runtimeCredentialHash = registration.RuntimeCredentialHash
			_ = json.NewEncoder(w).Encode(registrationResponse{
				Contract: runtimeContract, Binding: binding, RuntimeCredentialHash: runtimeCredentialHash,
				RuntimeCredentialExpiry: fixedNow.Add(time.Hour).Format(time.RFC3339),
			})
		case "/api/os-shell/runtime/credential":
			credential := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
			digest := sha256.Sum256([]byte(credential))
			if fmt.Sprintf("sha256:%x", digest[:]) != runtimeCredentialHash {
				t.Errorf("credential exchange did not use memory runtime credential")
			}
			_ = json.NewEncoder(w).Encode(credentialResponse{
				Contract: controlContract, AccessToken: "short-delegated-token",
				TokenExpiresAt: fixedNow.Add(time.Minute).Format(time.RFC3339),
			})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()
	controlHTTPClient = server.Client()
	t.Setenv("OPENSPHERE_SHELL_REGISTRATION_URL", server.URL+"/internal/runtime/register")
	t.Setenv("OPENSPHERE_SHELL_CONTROL_URL", server.URL+"/api/os-shell/runtime")
	client, err := newControlClient()
	if err != nil {
		t.Fatal(err)
	}
	defer client.close()
	if err := client.register(context.Background(), binding, identity); err != nil {
		t.Fatal(err)
	}
	if registrationAttempts != 2 {
		t.Fatalf("registration should retry the one closed readiness code once, got %d attempts", registrationAttempts)
	}
	contextJWS, _ := identity.signContext(binding, cliAudience, "", fixedNow)
	credential, err := client.credential(context.Background(), contextJWS)
	if err != nil || credential.AccessToken != "short-delegated-token" {
		t.Fatalf("unexpected credential: %#v err=%v", credential, err)
	}
}

func TestAgentOwnedConsoleTransportNeverReturnsBearer(t *testing.T) {
	fixedNow := time.Date(2026, 8, 15, 8, 0, 0, 0, time.UTC)
	originalNow, originalControlClient, originalProxyClient := now, controlHTTPClient, runtimeProxyHTTPClient
	now = func() time.Time { return fixedNow }
	defer func() {
		now, controlHTTPClient, runtimeProxyHTTPClient = originalNow, originalControlClient, originalProxyClient
	}()

	binding := testBinding()
	identity, _ := newSigningIdentity(fixedNow)
	contextJWS, _ := identity.signContext(binding, cliAudience, "", fixedNow)
	mintedBearer := "agent-memory-only-bearer"
	var revoked atomic.Bool
	controlServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/os-shell/runtime/credential" || request.Header.Get("Authorization") != "Bearer runtime-credential" {
			t.Errorf("unexpected credential exchange: %s %q", request.URL.Path, request.Header.Get("Authorization"))
		}
		if revoked.Load() {
			http.Error(w, "revoked", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(credentialResponse{
			Contract: controlContract, AccessToken: mintedBearer,
			TokenExpiresAt: fixedNow.Add(time.Minute).Format(time.RFC3339),
		})
	}))
	defer controlServer.Close()
	controlHTTPClient = controlServer.Client()
	controlURL, _ := validatedHTTPSURL(controlServer.URL + "/api/os-shell/runtime")

	consoleRequests := 0
	var consoleServer *httptest.Server
	consoleServer = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		consoleRequests++
		if request.Header.Get("Authorization") != "Bearer "+mintedBearer {
			t.Errorf("unexpected proxied request: %s %s %#v", request.Method, request.URL.RequestURI(), request.Header)
		}
		if request.URL.Path == "/api/redirect" {
			http.Redirect(w, request, consoleServer.URL+"/api/should-not-follow", http.StatusFound)
			return
		}
		if request.URL.Path == "/api/too-large" {
			_, _ = w.Write(make([]byte, maxProxyResponse+1))
			return
		}
		if request.Method != http.MethodPost || request.URL.RequestURI() != "/api/status?detail=1" ||
			request.Header.Get("X-OS-Idempotency-Key") != "request-1" {
			t.Errorf("unexpected proxied request target: %s %s %#v", request.Method, request.URL.RequestURI(), request.Header)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "3")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer consoleServer.Close()
	runtimeProxyHTTPClient = &http.Client{
		Transport: consoleServer.Client().Transport, Timeout: 30 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}

	server := &agentServer{
		binding: binding, identity: identity, consoleAPIURL: consoleServer.URL,
		control: &controlClient{controlURL: controlURL, runtimeCredential: []byte("runtime-credential"), runtimeCredentialExpiry: fixedNow.Add(time.Hour)},
	}
	input := agentHTTPRequest{
		Method: http.MethodPost, Path: "/api/status?detail=1", ContentType: "application/json",
		Body:          base64.RawStdEncoding.EncodeToString([]byte(`{"check":true}`)),
		CorrelationID: "request-1", IdempotencyKey: "request-1",
	}
	response, err := server.proxyConsoleRequest(context.Background(), contextJWS, input)
	if err != nil || response.Status != http.StatusAccepted || response.ContentType != "application/json" || response.RetryAfter != "3" {
		t.Fatalf("unexpected proxy response: %#v err=%v", response, err)
	}
	decoded, _ := base64.RawStdEncoding.DecodeString(response.Body)
	if string(decoded) != `{"accepted":true}` || strings.Contains(string(decoded), mintedBearer) {
		t.Fatalf("proxy response leaked credential or changed body: %q", decoded)
	}
	wire, _ := json.Marshal(agentResponse{Contract: agentContract, ContextJWS: contextJWS, Response: &response})
	if strings.Contains(string(wire), mintedBearer) || strings.Contains(string(wire), "accessToken") || strings.Contains(string(wire), "tokenExpiresAt") {
		t.Fatalf("Unix agent response leaked credential material: %s", wire)
	}
	if consoleRequests != 1 {
		t.Fatalf("expected one Console request, got %d", consoleRequests)
	}
	redirect := input
	redirect.Method, redirect.Path, redirect.ContentType, redirect.Body, redirect.IdempotencyKey = http.MethodGet, "/api/redirect", "", "", ""
	redirectResponse, err := server.proxyConsoleRequest(context.Background(), contextJWS, redirect)
	if err != nil || redirectResponse.Status != http.StatusFound || consoleRequests != 2 {
		t.Fatalf("redirect must be returned without following: response=%#v requests=%d err=%v", redirectResponse, consoleRequests, err)
	}
	tooLarge := redirect
	tooLarge.Path = "/api/too-large"
	if _, err := server.proxyConsoleRequest(context.Background(), contextJWS, tooLarge); err == nil {
		t.Fatal("oversized Console response must be rejected")
	}
	if consoleRequests != 3 {
		t.Fatalf("oversized response must make exactly one request, got %d", consoleRequests)
	}

	revoked.Store(true)
	if _, err := server.proxyConsoleRequest(context.Background(), contextJWS, redirect); err == nil {
		t.Fatal("revoked delegated authority must reject the Console proxy")
	}
	if consoleRequests != 3 {
		t.Fatal("revoked authority must fail before reaching Console")
	}
	revoked.Store(false)
	server.control.runtimeCredentialExpiry = fixedNow.Add(-time.Second)
	if _, err := server.proxyConsoleRequest(context.Background(), contextJWS, input); err == nil {
		t.Fatal("expired runtime authority must reject the Console proxy")
	}
	if consoleRequests != 3 {
		t.Fatal("expired authority must fail before reaching Console")
	}
}

func TestAgentConsoleTransportRejectsUnclosedRequestsAndBoundsRate(t *testing.T) {
	valid := agentHTTPRequest{Method: http.MethodGet, Path: "/api/status", CorrelationID: "request-1"}
	if _, _, err := validateAgentHTTPRequest(valid); err != nil {
		t.Fatal(err)
	}
	invalid := []agentHTTPRequest{
		{Method: http.MethodPatch, Path: "/api/status", CorrelationID: "request-1", IdempotencyKey: "request-1"},
		{Method: http.MethodGet, Path: "/api/internal/os-shell/credential", CorrelationID: "request-1"},
		{Method: http.MethodPost, Path: "/api/identity/cli/session", CorrelationID: "request-1", IdempotencyKey: "request-1"},
		{Method: http.MethodGet, Path: "/api/%2e%2e/internal", CorrelationID: "request-1"},
		{Method: http.MethodGet, Path: "/api/status", Body: base64.RawStdEncoding.EncodeToString([]byte("not-empty")), CorrelationID: "request-1"},
		{Method: http.MethodPost, Path: "/api/status", CorrelationID: "request-1"},
	}
	for _, request := range invalid {
		if _, _, err := validateAgentHTTPRequest(request); err == nil {
			t.Fatalf("unclosed Console request must be rejected: %#v", request)
		}
	}
	server := &agentServer{}
	for index := 0; index < 20; index++ {
		if !server.admitProxyRequest(1) {
			t.Fatalf("bounded request %d was rejected too early", index)
		}
	}
	if server.admitProxyRequest(1) {
		t.Fatal("twenty-first request in one second must be rate limited")
	}
	concurrency := &agentServer{}
	releases := make([]func(), 0, 4)
	for index := 0; index < 4; index++ {
		release, err := concurrency.acquireProxySlot(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, release)
	}
	blocked, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := concurrency.acquireProxySlot(blocked); err == nil {
		t.Fatal("fifth concurrent Console request must remain blocked")
	}
	for _, release := range releases {
		release()
	}
}

func TestRegistrationResponseLossRetriesSameAgentCredential(t *testing.T) {
	fixedNow := time.Date(2026, 8, 15, 8, 0, 0, 0, time.UTC)
	originalNow, originalClient, originalBootstrap, originalSleep := now, controlHTTPClient, bootstrapTokenPath, registrationSleep
	now = func() time.Time { return fixedNow }
	registrationSleep = func(context.Context, time.Duration) error { return nil }
	defer func() {
		now, controlHTTPClient, bootstrapTokenPath, registrationSleep = originalNow, originalClient, originalBootstrap, originalSleep
	}()
	binding := testBinding()
	identity, _ := newSigningIdentity(fixedNow)
	bootstrapTokenPath = filepath.Join(t.TempDir(), "bootstrap-token")
	if err := os.WriteFile(bootstrapTokenPath, []byte("projected-bound-service-account-token-1234567890"), 0o400); err != nil {
		t.Fatal(err)
	}
	registrationAttempts := 0
	registeredHash := ""
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var registration registrationRequest
		_ = json.NewDecoder(io.LimitReader(request.Body, maxControlMessage)).Decode(&registration)
		registrationAttempts++
		if registrationAttempts == 1 {
			registeredHash = registration.RuntimeCredentialHash
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Error("test server cannot simulate a lost response")
				return
			}
			connection, _, err := hijacker.Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			_ = connection.Close()
			return
		}
		if registration.RuntimeCredentialHash != registeredHash {
			t.Errorf("response-loss retry changed the credential proof: %s != %s", registration.RuntimeCredentialHash, registeredHash)
		}
		_ = json.NewEncoder(w).Encode(registrationResponse{
			Contract: runtimeContract, Binding: binding, RuntimeCredentialHash: registeredHash,
			RuntimeCredentialExpiry: fixedNow.Add(time.Hour).Format(time.RFC3339),
		})
	}))
	defer server.Close()
	controlHTTPClient = server.Client()
	t.Setenv("OPENSPHERE_SHELL_REGISTRATION_URL", server.URL+"/internal/runtime/register")
	t.Setenv("OPENSPHERE_SHELL_CONTROL_URL", server.URL+"/api/os-shell/runtime")
	client, err := newControlClient()
	if err != nil {
		t.Fatal(err)
	}
	defer client.close()
	if err := client.register(context.Background(), binding, identity); err != nil {
		t.Fatal(err)
	}
	if registrationAttempts != 2 || registeredHash == "" || len(client.runtimeCredential) != 64 {
		t.Fatalf("lost registration response was not recovered safely: attempts=%d hash=%q credentialLength=%d", registrationAttempts, registeredHash, len(client.runtimeCredential))
	}
}

func TestRegistrationAuthorizationFailureDoesNotRetry(t *testing.T) {
	originalClient, originalBootstrap, originalSleep := controlHTTPClient, bootstrapTokenPath, registrationSleep
	registrationSleep = func(context.Context, time.Duration) error { return nil }
	defer func() {
		controlHTTPClient, bootstrapTokenPath, registrationSleep = originalClient, originalBootstrap, originalSleep
	}()
	binding := testBinding()
	identity, _ := newSigningIdentity(time.Now().UTC())
	bootstrapTokenPath = filepath.Join(t.TempDir(), "bootstrap-token")
	if err := os.WriteFile(bootstrapTokenPath, []byte("projected-bound-service-account-token-1234567890"), 0o400); err != nil {
		t.Fatal(err)
	}
	attempts := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "RuntimeRegistrationNotReady"})
	}))
	defer server.Close()
	controlHTTPClient = server.Client()
	t.Setenv("OPENSPHERE_SHELL_REGISTRATION_URL", server.URL+"/internal/runtime/register")
	t.Setenv("OPENSPHERE_SHELL_CONTROL_URL", server.URL+"/api/os-shell/runtime")
	client, err := newControlClient()
	if err != nil {
		t.Fatal(err)
	}
	if err := client.register(context.Background(), binding, identity); err == nil {
		t.Fatal("403 registration must fail closed")
	}
	if attempts != 1 {
		t.Fatalf("403 registration must not retry, got %d attempts", attempts)
	}
}

func TestInternalPTYTokenIsTmpfsStyleAndConsumedOnce(t *testing.T) {
	original := configuredInternalPTYTokenPath
	configuredInternalPTYTokenPath = filepath.Join(t.TempDir(), "shared", "pty-token")
	defer func() { configuredInternalPTYTokenPath = original }()
	published, err := publishInternalPTYToken()
	if err != nil {
		t.Fatal(err)
	}
	read, err := readInternalPTYToken(context.Background())
	if err != nil || string(read) != string(published) {
		t.Fatalf("unexpected token handoff: err=%v", err)
	}
	if _, err := os.Stat(configuredInternalPTYTokenPath); !os.IsNotExist(err) {
		t.Fatal("internal token file must be consumed and removed")
	}
	wipe(published)
	wipe(read)
}

func TestPrepareRuntimeDirectoryCreatesPrivateDirectory(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "runtime")
	if err := prepareRuntimeDirectory(directory); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(directory)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o007 != 0 {
		t.Fatalf("runtime directory must not be accessible to other users: %s", info.Mode().Perm())
	}
}

func TestPrepareRuntimeDirectoryAcceptsSecureFSGroupMountAfterChmodEPERM(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "fs-group")
	if err := os.MkdirAll(directory, 0o770); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0o770); err != nil {
		t.Fatal(err)
	}
	original := runtimeDirectoryChmod
	runtimeDirectoryChmod = func(string, os.FileMode) error { return os.ErrPermission }
	t.Cleanup(func() { runtimeDirectoryChmod = original })
	if err := prepareRuntimeDirectory(directory); err != nil {
		t.Fatalf("secure fsGroup directory must be accepted after chmod EPERM: %v", err)
	}
}

func TestPrepareRuntimeDirectoryRejectsUnsafeFSGroupMountAfterChmodEPERM(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "unsafe")
	if err := os.MkdirAll(directory, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0o777); err != nil {
		t.Fatal(err)
	}
	original := runtimeDirectoryChmod
	runtimeDirectoryChmod = func(string, os.FileMode) error { return os.ErrPermission }
	t.Cleanup(func() { runtimeDirectoryChmod = original })
	if err := prepareRuntimeDirectory(directory); err == nil {
		t.Fatal("world-accessible fsGroup directory must be rejected")
	}
}

func TestPrepareRuntimeDirectoryRejectsNonDirectoryAfterChmodEPERM(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	originalMkdirAll, originalChmod := runtimeDirectoryMkdirAll, runtimeDirectoryChmod
	runtimeDirectoryMkdirAll = func(string, os.FileMode) error { return nil }
	runtimeDirectoryChmod = func(string, os.FileMode) error { return os.ErrPermission }
	t.Cleanup(func() {
		runtimeDirectoryMkdirAll = originalMkdirAll
		runtimeDirectoryChmod = originalChmod
	})
	if err := prepareRuntimeDirectory(path); err == nil {
		t.Fatal("non-directory fsGroup mount must be rejected")
	}
}

func TestSensitiveRuntimeArtifactsUseOwnedChildDirectories(t *testing.T) {
	for name, path := range map[string]string{
		"agent socket": agentSocketPath, "agent public key": agentPublicKeyPath, "PTY token": internalPTYTokenPath,
	} {
		if filepath.Base(filepath.Dir(path)) != "channel" {
			t.Fatalf("%s must live below the runtime-owned channel directory: %s", name, path)
		}
	}
}

func TestProjectedBootstrapTokenAcceptsInVolumeSymlinkAndGroupRead(t *testing.T) {
	original := bootstrapTokenPath
	root := t.TempDir()
	dataDirectory := filepath.Join(root, "..2026_08_15")
	if err := os.Mkdir(dataDirectory, 0o750); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dataDirectory, "token")
	expected := []byte("projected-bound-service-account-token-1234567890")
	if err := os.WriteFile(target, expected, 0o440); err != nil {
		t.Fatal(err)
	}
	bootstrapTokenPath = filepath.Join(root, "opensphere-shell-runtime-bootstrap")
	if err := os.Symlink(filepath.Join("..2026_08_15", "token"), bootstrapTokenPath); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bootstrapTokenPath = original })
	actual, err := readProjectedBootstrapToken()
	if err != nil || string(actual) != string(expected) {
		t.Fatalf("projected in-volume symlink must be accepted: err=%v", err)
	}
	wipe(actual)
}

func TestProjectedBootstrapTokenAcceptsCanonicalizedVolumeRoot(t *testing.T) {
	original := bootstrapTokenPath
	parent := t.TempDir()
	realRoot := filepath.Join(parent, "real-volume")
	if err := os.Mkdir(realRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	aliasRoot := filepath.Join(parent, "mounted-volume")
	if err := os.Symlink(realRoot, aliasRoot); err != nil {
		t.Fatal(err)
	}
	bootstrapTokenPath = filepath.Join(aliasRoot, "token")
	expected := []byte("projected-bound-service-account-token-1234567890")
	if err := os.WriteFile(filepath.Join(realRoot, "token"), expected, 0o440); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bootstrapTokenPath = original })
	actual, err := readProjectedBootstrapToken()
	if err != nil || string(actual) != string(expected) {
		t.Fatalf("canonicalized projected volume root must be accepted: err=%v", err)
	}
	wipe(actual)
}

func TestProjectedBootstrapTokenRejectsSymlinkEscapeAndWritableToken(t *testing.T) {
	original := bootstrapTokenPath
	t.Cleanup(func() { bootstrapTokenPath = original })
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside-token")
	if err := os.WriteFile(outside, []byte("projected-bound-service-account-token-1234567890"), 0o400); err != nil {
		t.Fatal(err)
	}
	bootstrapTokenPath = filepath.Join(root, "escape")
	if err := os.Symlink(outside, bootstrapTokenPath); err != nil {
		t.Fatal(err)
	}
	if _, err := readProjectedBootstrapToken(); err == nil {
		t.Fatal("projected token symlink escape must be rejected")
	}
	if err := os.Remove(bootstrapTokenPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bootstrapTokenPath, []byte("projected-bound-service-account-token-1234567890"), 0o660); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(bootstrapTokenPath, 0o660); err != nil {
		t.Fatal(err)
	}
	if _, err := readProjectedBootstrapToken(); err == nil {
		t.Fatal("group-writable projected token must be rejected")
	}
}

func TestPTYRejectsStaleEpochAndInvalidToken(t *testing.T) {
	binding := testBinding()
	for name, mutate := range map[string]func(*ptyFrame){
		"stale epoch":   func(frame *ptyFrame) { frame.FencingEpoch++ },
		"invalid token": func(frame *ptyFrame) { frame.InternalToken = strings.Repeat("x", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			server := &ptyServer{binding: binding, consoleAPIURL: fixedConsoleAPIURL, internalToken: []byte(strings.Repeat("t", 64))}
			httpServer := httptest.NewServer(http.HandlerFunc(server.handleAttach))
			defer httpServer.Close()
			connection := dialTestPTY(t, httpServer.URL)
			defer connection.CloseNow()
			frame := validBindForTest(binding, string(server.internalToken))
			mutate(&frame)
			if err := wsjson.Write(context.Background(), connection, frame); err != nil {
				t.Fatal(err)
			}
			var response ptyFrame
			readContext, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := wsjson.Read(readContext, connection, &response); err == nil {
				t.Fatalf("invalid binding must close before attach: %#v", response)
			}
		})
	}
}

func TestPTYRunsOnlyFixedBashAndRelaysBoundedFrames(t *testing.T) {
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skip("runtime build stage installs the fixed /bin/bash contract")
	}
	binding := testBinding()
	server := &ptyServer{binding: binding, consoleAPIURL: fixedConsoleAPIURL, internalToken: []byte(strings.Repeat("t", 64))}
	httpServer := httptest.NewServer(http.HandlerFunc(server.handleAttach))
	defer httpServer.Close()
	connection := dialTestPTY(t, httpServer.URL)
	defer connection.CloseNow()
	if err := wsjson.Write(context.Background(), connection, validBindForTest(binding, string(server.internalToken))); err != nil {
		t.Fatal(err)
	}
	var attached ptyFrame
	if err := wsjson.Read(context.Background(), connection, &attached); err != nil || attached.Type != "attached" {
		t.Fatalf("PTY did not attach: %#v err=%v", attached, err)
	}
	input := base64.RawStdEncoding.EncodeToString([]byte("printf 'runtime-ok %s\\n' \"$OS_CONSOLE\"; sleep 0.2; exit\n"))
	if err := wsjson.Write(context.Background(), connection, ptyFrame{Type: "stdin", Sequence: 2, Data: input}); err != nil {
		t.Fatal(err)
	}
	readContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var output strings.Builder
	for !strings.Contains(output.String(), "runtime-ok "+fixedConsoleAPIURL) {
		var frame ptyFrame
		if err := wsjson.Read(readContext, connection, &frame); err != nil {
			t.Fatalf("runtime output missing: %q err=%v", output.String(), err)
		}
		if frame.Type == "stdout" {
			decoded, _ := base64.RawStdEncoding.DecodeString(frame.Data)
			output.Write(decoded)
		}
	}
}

func TestAgentAttachRejectsPlainHTTP(t *testing.T) {
	server := &agentServer{binding: testBinding()}
	request := httptest.NewRequest(http.MethodGet, "http://runtime/v1/runtime/attach", nil)
	request.RemoteAddr = "127.0.0.1:12345"
	recorder := httptest.NewRecorder()
	server.handleAttach(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("plain HTTP must be rejected, got %d", recorder.Code)
	}
}

func TestAgentWSSPinsEphemeralCertificateAndBridgesLoopbackPTY(t *testing.T) {
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skip("runtime build stage installs the fixed /bin/bash contract")
	}
	binding := testBinding()
	identity, err := newSigningIdentity(time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	internalToken := []byte(strings.Repeat("t", 64))
	ptyRuntime := &ptyServer{binding: binding, consoleAPIURL: fixedConsoleAPIURL, internalToken: internalToken}
	ptyHTTP := httptest.NewServer(http.HandlerFunc(ptyRuntime.handleAttach))
	defer ptyHTTP.Close()
	originalPTYAddr, originalClient := configuredPTYAddr, controlHTTPClient
	configuredPTYAddr = strings.TrimPrefix(ptyHTTP.URL, "http://")
	defer func() { configuredPTYAddr, controlHTTPClient = originalPTYAddr, originalClient }()
	runtimeCredential := []byte(strings.Repeat("r", 64))
	controlHTTP := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if request.Header.Get("Authorization") != "Bearer "+string(runtimeCredential) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch request.URL.Path {
		case "/api/os-shell/runtime/attach-authorize", "/api/os-shell/runtime/revalidate":
			_ = json.NewEncoder(w).Encode(attachAuthorizeResponse{Contract: controlContract, Authorized: true, State: "Active"})
		default:
			http.NotFound(w, request)
		}
	}))
	defer controlHTTP.Close()
	controlHTTPClient = controlHTTP.Client()
	controlURL, _ := validatedHTTPSURL(controlHTTP.URL + "/api/os-shell/runtime")
	agent := &agentServer{
		binding: binding, identity: identity, internalToken: internalToken,
		control: &controlClient{controlURL: controlURL, runtimeCredential: runtimeCredential, runtimeCredentialExpiry: time.Now().Add(time.Hour)},
	}
	tlsServer := httptest.NewUnstartedServer(http.HandlerFunc(agent.handleAttach))
	tlsServer.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{identity.tlsCertificate}}
	tlsServer.StartTLS()
	defer tlsServer.Close()
	digest := sha256.Sum256(tlsServer.Certificate().Raw)
	if fmt.Sprintf("sha256:%x", digest[:]) != identity.tlsCertificateSHA256 {
		t.Fatal("registered TLS fingerprint does not match the WSS certificate")
	}
	target := "wss" + strings.TrimPrefix(tlsServer.URL, "https") + "/v1/runtime/attach"
	pinnedClient := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion:         tls.VersionTLS13,
		InsecureSkipVerify: true, // Test models gateway exact-fingerprint pinning, not public PKI.
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) != 1 {
				return fmt.Errorf("unexpected certificate chain")
			}
			peerDigest := sha256.Sum256(state.PeerCertificates[0].Raw)
			if fmt.Sprintf("sha256:%x", peerDigest[:]) != identity.tlsCertificateSHA256 {
				return fmt.Errorf("runtime certificate fingerprint mismatch")
			}
			return nil
		},
	}}}
	connection, _, err := websocket.Dial(context.Background(), target, &websocket.DialOptions{
		HTTPClient: pinnedClient, Subprotocols: []string{publicPTYSubprotocol},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	attach := ptyFrame{
		Type: "attach", Sequence: 1, Ticket: strings.Repeat("a", 48), SessionID: binding.SessionID,
		RuntimeUID: binding.RuntimeUID, Generation: binding.Generation, FencingEpoch: binding.FencingEpoch,
	}
	if err := wsjson.Write(context.Background(), connection, attach); err != nil {
		t.Fatal(err)
	}
	readContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var attached ptyFrame
	if err := wsjson.Read(readContext, connection, &attached); err != nil || attached.Type != "attached" {
		t.Fatalf("agent did not bridge the PTY: %#v err=%v", attached, err)
	}
	if err := wsjson.Write(context.Background(), connection, ptyFrame{Type: "ping", Sequence: 2}); err != nil {
		t.Fatal(err)
	}
	var pong ptyFrame
	if err := wsjson.Read(readContext, connection, &pong); err != nil || pong.Type != "pong" {
		t.Fatalf("agent did not relay bounded frames: %#v err=%v", pong, err)
	}
}

func TestAgentUnixProtocolReturnsCLIV2Context(t *testing.T) {
	fixedNow := time.Date(2026, 8, 15, 8, 0, 0, 0, time.UTC)
	originalNow := now
	now = func() time.Time { return fixedNow }
	defer func() { now = originalNow }()
	identity, _ := newSigningIdentity(fixedNow)
	server := &agentServer{binding: testBinding(), identity: identity}
	serverSide, clientSide := net.Pipe()
	defer clientSide.Close()
	go server.handleAgentConnection(context.Background(), serverSide)
	_ = json.NewEncoder(clientSide).Encode(agentRequest{Contract: agentContract, Operation: "context"})
	var response agentResponse
	if err := json.NewDecoder(bufio.NewReader(clientSide)).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Contract != agentContract || response.ContextJWS == "" || response.Error != "" {
		t.Fatalf("unexpected agent response: %#v", response)
	}
}

func TestAgentCredentialFailurePreservesSignedContextAndStage(t *testing.T) {
	current := time.Now().UTC().Truncate(time.Second)
	originalNow, originalControlClient := now, controlHTTPClient
	now = func() time.Time { return current }
	defer func() { now, controlHTTPClient = originalNow, originalControlClient }()

	authority := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/os-shell/runtime/credential" {
			t.Fatalf("unexpected credential authority path: %s", request.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"delegated credential exchange rejected"}`))
	}))
	defer authority.Close()
	controlHTTPClient = authority.Client()
	controlURL, _ := url.Parse(authority.URL + "/api/os-shell/runtime")
	identity, err := newSigningIdentity(current)
	if err != nil {
		t.Fatal(err)
	}
	defer identity.close()
	server := &agentServer{binding: testBinding(), identity: identity, control: &controlClient{
		controlURL: controlURL, runtimeCredential: []byte("runtime-credential"), runtimeCredentialExpiry: current.Add(time.Hour),
	}}
	serverSide, clientSide := net.Pipe()
	defer clientSide.Close()
	go server.handleAgentConnection(context.Background(), serverSide)
	_ = json.NewEncoder(clientSide).Encode(agentRequest{Contract: agentContract, Operation: "request", Request: &agentHTTPRequest{
		Method: http.MethodGet, Path: "/api/identity/cli/introspect", CorrelationID: "os-contract-test",
	}})
	var response agentResponse
	if err := json.NewDecoder(bufio.NewReader(clientSide)).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Contract != agentContract || response.ContextJWS == "" || response.Error != "" || response.Response == nil {
		t.Fatalf("credential failure must preserve the valid agent contract: %#v", response)
	}
	if response.Response.Status != http.StatusServiceUnavailable || response.Response.ContentType != "application/json" {
		t.Fatalf("unexpected closed credential failure: %#v", response.Response)
	}
	body, err := base64.RawStdEncoding.DecodeString(response.Response.Body)
	if err != nil {
		t.Fatal(err)
	}
	var failure map[string]any
	if json.Unmarshal(body, &failure) != nil || failure["code"] != "ShellCredentialUnavailable" || failure["stage"] != "credential-exchange" {
		t.Fatalf("credential failure lost its safe stage/code: %s", body)
	}
	if strings.Contains(string(body), "delegated credential exchange rejected") {
		t.Fatal("upstream authority details must not cross the Unix agent boundary")
	}
}

func TestReleasedOSWhoamiCrossesRuntimeAgentContract(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix credential-agent contract")
	}
	temporary := t.TempDir()
	socketPath := filepath.Join(temporary, "agent.sock")
	publicKeyPath := filepath.Join(temporary, "agent-public-key.pem")
	binaryPath := filepath.Join(temporary, "os")
	build := exec.Command("go", "build", "-trimpath", "-ldflags", fmt.Sprintf(
		"-X main.webShellAgentSocketPath=%s -X main.webShellAgentPublicKeyPath=%s", socketPath, publicKeyPath,
	), "-o", binaryPath, "../os")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build released os CLI fixture: %v\n%s", err, output)
	}

	originalSocket, originalKey := configuredAgentSocketPath, configuredPublicKeyPath
	originalControlClient, originalProxyClient := controlHTTPClient, runtimeProxyHTTPClient
	configuredAgentSocketPath, configuredPublicKeyPath = socketPath, publicKeyPath
	defer func() {
		configuredAgentSocketPath, configuredPublicKeyPath = originalSocket, originalKey
		controlHTTPClient, runtimeProxyHTTPClient = originalControlClient, originalProxyClient
	}()
	current := time.Now().UTC()
	identity, err := newSigningIdentity(current)
	if err != nil {
		t.Fatal(err)
	}
	defer identity.close()
	if err := publishPublicKey(identity.publicPEM); err != nil {
		t.Fatal(err)
	}

	var credentialCalls, consoleCalls atomic.Int32
	authorities := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/os-shell/runtime/credential":
			credentialCalls.Add(1)
			if request.Method != http.MethodPost || request.Header.Get("Authorization") != "Bearer runtime-credential" {
				t.Errorf("unexpected credential request: %s %#v", request.Method, request.Header)
			}
			_ = json.NewEncoder(w).Encode(credentialResponse{
				Contract: controlContract, AccessToken: "agent-memory-only-token",
				TokenExpiresAt: current.Add(4 * time.Minute).Format(time.RFC3339),
			})
		case "/api/identity/cli/introspect":
			consoleCalls.Add(1)
			if request.Method != http.MethodGet || request.Header.Get("Authorization") != "Bearer agent-memory-only-token" {
				t.Errorf("unexpected Console request: %s %#v", request.Method, request.Header)
			}
			_, _ = w.Write([]byte(`{"active":true,"sub":"operator-1"}`))
		default:
			http.NotFound(w, request)
		}
	}))
	defer authorities.Close()
	controlHTTPClient = authorities.Client()
	runtimeProxyHTTPClient = &http.Client{Transport: authorities.Client().Transport, Timeout: 30 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	controlURL, _ := url.Parse(authorities.URL + "/api/os-shell/runtime")
	server := &agentServer{
		binding: testBinding(), identity: identity, consoleAPIURL: authorities.URL,
		control: &controlClient{controlURL: controlURL, runtimeCredential: []byte("runtime-credential"), runtimeCredentialExpiry: current.Add(time.Hour)},
	}
	listener, err := listenAgentUnixSocket()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.serveAgentSocket(ctx, listener) }()
	defer func() {
		cancel()
		_ = listener.Close()
		<-done
	}()

	command := exec.Command(binaryPath, "whoami")
	command.Env = append(withoutEnvironment(os.Environ(), "OS_CONSOLE", "OS_IDENTITY", "OS_CONFIG", "OS_PAT"),
		"OS_CONSOLE="+fixedConsoleAPIURL, "OS_CONFIG="+filepath.Join(temporary, "missing-config.json"), "OS_PAT=")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("released os whoami rejected the Runtime contract: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), `"active": true`) || credentialCalls.Load() != 1 || consoleCalls.Load() != 1 {
		t.Fatalf("unexpected whoami result=%q credentialCalls=%d consoleCalls=%d", output, credentialCalls.Load(), consoleCalls.Load())
	}
}

func withoutEnvironment(values []string, names ...string) []string {
	blocked := make(map[string]struct{}, len(names))
	for _, name := range names {
		blocked[name] = struct{}{}
	}
	filtered := make([]string, 0, len(values))
	for _, value := range values {
		name, _, _ := strings.Cut(value, "=")
		if _, found := blocked[name]; !found {
			filtered = append(filtered, value)
		}
	}
	return filtered
}

func TestRuntimePTYInputRateMatchesGatewayCeiling(t *testing.T) {
	limiter := newFrameLimiter(now())
	exact := base64.RawStdEncoding.EncodeToString(bytes.Repeat([]byte{'x'}, maxPTYBytesPerSec))
	if !validClientFrame(ptyFrame{Type: "stdin", Sequence: 1, Data: exact}, 0, limiter) {
		t.Fatal("runtime must accept exactly the shared 64 KiB/s input ceiling")
	}
	over := base64.RawStdEncoding.EncodeToString([]byte{'y'})
	if validClientFrame(ptyFrame{Type: "stdin", Sequence: 2, Data: over}, 1, limiter) {
		t.Fatal("runtime must reject input above the gateway 64 KiB/s ceiling")
	}
}

func TestAgentGeneratedFramesReceiveMonotonicWireSequence(t *testing.T) {
	// The bridge writer owns the public WSS sequence. PTY-originated frames and
	// agent-originated revoked/error frames therefore share one monotonic stream.
	sequence := uint64(0)
	frames := []ptyFrame{{Type: "attached", Sequence: 99}, {Type: "stdout", Sequence: 12}, {Type: "revoked"}}
	for index := range frames {
		frames[index] = sequenceOutboundFrame(frames[index], &sequence)
	}
	if frames[0].Sequence != 1 || frames[1].Sequence != 2 || frames[2].Sequence != 3 {
		t.Fatalf("public WSS frames must be monotonic, got %#v", frames)
	}
}

func dialTestPTY(t *testing.T, serverURL string) *websocket.Conn {
	t.Helper()
	target := "ws" + strings.TrimPrefix(serverURL, "http") + "/v1/pty/attach"
	connection, _, err := websocket.Dial(context.Background(), target, &websocket.DialOptions{Subprotocols: []string{internalPTYSubprotocol}})
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

func validBindForTest(binding runtimeBinding, token string) ptyFrame {
	return ptyFrame{
		Type: "bind", Sequence: 1, InternalToken: token, SessionID: binding.SessionID,
		RuntimeUID: binding.RuntimeUID, Generation: binding.Generation, FencingEpoch: binding.FencingEpoch,
	}
}
