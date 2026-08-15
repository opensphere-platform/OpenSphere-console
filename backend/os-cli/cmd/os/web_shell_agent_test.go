package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWebShellAgentArtifactsUseOwnedChildDirectory(t *testing.T) {
	for name, path := range map[string]string{"socket": webShellAgentSocketPath, "public key": webShellAgentPublicKeyPath} {
		if filepath.Base(filepath.Dir(path)) != "channel" {
			t.Fatalf("%s must live below the runtime-owned channel directory: %s", name, path)
		}
	}
}

func TestWebShellAgentVerifiesBoundJWSAndDelegatedCredential(t *testing.T) {
	now := time.Date(2026, 8, 15, 6, 0, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	socketPath := filepath.Join(directory, "agent.sock")
	publicKeyPath := filepath.Join(directory, "agent-public-key.pem")
	der, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(publicKeyPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o444); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(publicKey)
	keyID := base64.RawURLEncoding.EncodeToString(digest[:])
	jws := signedWebShellContextForTest(t, privateKey, keyID, now, nil)

	originalSocket, originalKey, originalNow, originalConsole := webShellAgentSocketPath, webShellAgentPublicKeyPath, webShellAgentNow, webShellConsoleAPIURL
	webShellAgentSocketPath, webShellAgentPublicKeyPath = socketPath, publicKeyPath
	webShellAgentNow = func() time.Time { return now }
	webShellConsoleAPIURL = "https://console.test"
	defer func() {
		webShellAgentSocketPath, webShellAgentPublicKeyPath, webShellAgentNow = originalSocket, originalKey, originalNow
		webShellConsoleAPIURL = originalConsole
	}()

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(socketPath, 0o660); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	requests := make(chan webShellAgentRequest, 2)
	go func() {
		defer close(done)
		for i := 0; i < 2; i++ {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			line, _ := bufio.NewReader(conn).ReadBytes('\n')
			var request webShellAgentRequest
			_ = json.Unmarshal(line, &request)
			requests <- request
			response := webShellAgentResponse{Contract: webShellAgentContract, ContextJWS: jws}
			if request.Operation == "request" {
				response.Response = &webShellAgentHTTPResponse{
					Status: http.StatusOK, ContentType: "application/json", RetryAfter: "2",
					Body: base64.RawStdEncoding.EncodeToString([]byte(`{"ready":true}`)),
				}
			}
			_ = json.NewEncoder(conn).Encode(response)
			_ = conn.Close()
		}
	}()

	attested, err := readAttestedExecutionContextFromAgent(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if attested == nil || attested.SessionID != "session-1" || attested.ActorID != "operator-1" || attested.RuntimeUID != "runtime-uid-1" || attested.KeyID != keyID || attested.FencingEpoch != 7 {
		t.Fatalf("unexpected attested context: %#v", attested)
	}
	body, status, contentType, retryAfter, present, err := proxyWebShellRequest(
		context.Background(), http.MethodGet, "https://console.test/api/status", nil, "",
	)
	if err != nil || !present || status != http.StatusOK || contentType != "application/json" || retryAfter != "2" || string(body) != `{"ready":true}` {
		t.Fatalf("unexpected agent-owned HTTP response: body=%q status=%d present=%t err=%v", body, status, present, err)
	}
	<-done
	close(requests)
	seen := make([]webShellAgentRequest, 0, 2)
	for request := range requests {
		seen = append(seen, request)
	}
	if len(seen) != 2 || seen[0].Operation != "context" || seen[1].Operation != "request" ||
		seen[1].Request == nil || seen[1].Request.Path != "/api/status" {
		t.Fatalf("unexpected agent operations: %#v", seen)
	}
	encoded, _ := json.Marshal(seen[1])
	if strings.Contains(string(encoded), "accessToken") || strings.Contains(string(encoded), "Bearer") {
		t.Fatalf("CLI Unix request must never carry a bearer: %s", encoded)
	}
}

func TestWebShellContextRejectsTamperExpiryAndEnvironmentAuthority(t *testing.T) {
	now := time.Date(2026, 8, 15, 6, 0, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	publicKeyPath := filepath.Join(directory, "agent-public-key.pem")
	der, _ := x509.MarshalPKIXPublicKey(publicKey)
	if err := os.WriteFile(publicKeyPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o444); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(publicKey)
	keyID := base64.RawURLEncoding.EncodeToString(digest[:])
	originalKey, originalNow := webShellAgentPublicKeyPath, webShellAgentNow
	webShellAgentPublicKeyPath = publicKeyPath
	webShellAgentNow = func() time.Time { return now }
	defer func() { webShellAgentPublicKeyPath, webShellAgentNow = originalKey, originalNow }()

	valid := signedWebShellContextForTest(t, privateKey, keyID, now, nil)
	parts := strings.Split(valid, ".")
	parts[1] = base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"attacker"}`))
	if _, err := verifyWebShellContextJWS(strings.Join(parts, ".")); err == nil {
		t.Fatal("tampered JWS must be rejected")
	}
	expired := signedWebShellContextForTest(t, privateKey, keyID, now, func(claims map[string]any) {
		claims["iat"] = now.Add(-2 * time.Minute).Unix()
		claims["nbf"] = now.Add(-2 * time.Minute).Unix()
		claims["exp"] = now.Add(-time.Minute).Unix()
	})
	if _, err := verifyWebShellContextJWS(expired); err == nil {
		t.Fatal("expired JWS must be rejected")
	}
	missingRuntimeUID := signedWebShellContextForTest(t, privateKey, keyID, now, func(claims map[string]any) {
		delete(claims, "runtimeUid")
	})
	if _, err := verifyWebShellContextJWS(missingRuntimeUID); err == nil {
		t.Fatal("context without the exact runtime UID binding must be rejected")
	}
	for name, contract := range map[string]*string{
		"missing":      nil,
		"v1 downgrade": func() *string { value := "opensphere-web-shell-context/v1"; return &value }(),
		"unknown":      func() *string { value := "opensphere-web-shell-context/future"; return &value }(),
	} {
		downgraded := signedWebShellContextForTest(t, privateKey, keyID, now, func(claims map[string]any) {
			if contract == nil {
				delete(claims, "contract")
			} else {
				claims["contract"] = *contract
			}
		})
		if _, err := verifyWebShellContextJWS(downgraded); err == nil {
			t.Fatalf("%s context contract must be rejected", name)
		}
	}
	t.Setenv("OS_EXECUTION_PROFILE", "web-shell")
	t.Setenv("OS_WEB_SHELL_AGENT_SOCKET", publicKeyPath)
	originalSocket := webShellAgentSocketPath
	webShellAgentSocketPath = filepath.Join(directory, "absent.sock")
	defer func() { webShellAgentSocketPath = originalSocket }()
	if attested, err := readAttestedExecutionContextFromAgent(context.Background()); err != nil || attested != nil {
		t.Fatalf("environment must not select an authority: attested=%#v err=%v", attested, err)
	}
}

func TestAttestedWebShellTransportLossFailsClosed(t *testing.T) {
	originalSocket := webShellAgentSocketPath
	webShellAgentSocketPath = filepath.Join(t.TempDir(), "agent-stopped.sock")
	defer func() { webShellAgentSocketPath = originalSocket }()
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	if _, _, _, err := rawRequest(http.MethodGet, server.URL+"/api/status", nil, "", webShellAgentTransport); err == nil {
		t.Fatal("attested Web Shell must not fall back to direct HTTP after agent loss")
	}
	if requests != 0 {
		t.Fatalf("agent-loss fallback reached direct HTTP %d times", requests)
	}
}

func signedWebShellContextForTest(t *testing.T, privateKey ed25519.PrivateKey, keyID string, now time.Time, mutate func(map[string]any)) string {
	t.Helper()
	header := map[string]any{"alg": "EdDSA", "typ": "JWT", "kid": keyID}
	claims := map[string]any{
		"contract": webShellContextContract,
		"iss":      "opensphere-shell-credential-agent", "aud": "opensphere-os-cli", "jti": "attestation-1",
		"profile": "web-shell", "authority": "delegated-credential-agent", "actorId": "operator-1",
		"sessionId": "session-1", "sessionClass": "operator-interactive", "runtimeAdapterId": "cbss.kubernetes-pod",
		"runtimeUid": "runtime-uid-1",
		"origin":     "https://localhost:1114", "permissionRevision": "permission-revision-1", "aal": "aal2",
		"releaseEvidenceRef": "release-evidence-1", "generation": int64(3), "fencingEpoch": int64(7),
		"iat": now.Add(-time.Second).Unix(), "nbf": now.Add(-time.Second).Unix(), "exp": now.Add(time.Minute).Unix(),
	}
	if mutate != nil {
		mutate(claims)
	}
	headerBytes, _ := json.Marshal(header)
	claimBytes, _ := json.Marshal(claims)
	encodedHeader := base64.RawURLEncoding.EncodeToString(headerBytes)
	encodedClaims := base64.RawURLEncoding.EncodeToString(claimBytes)
	signingInput := encodedHeader + "." + encodedClaims
	signature := ed25519.Sign(privateKey, []byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}
