package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// This is the non-mutating PLAN-011 reconnect fixture. It uses the production
// PTY handler and exact runtime binding twice; no Console/PFSS API is called.
// Detach must release the one-attachment fence without terminating the runtime
// server so a fresh one-time gateway ticket can reconnect the same session.
func TestPLAN011SameSessionDetachThenReconnect(t *testing.T) {
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skip("runtime image provides the fixed /bin/bash contract")
	}
	binding := testBinding()
	server := &ptyServer{
		binding: binding, consoleAPIURL: fixedConsoleAPIURL,
		internalToken: []byte(strings.Repeat("t", 64)),
	}
	httpServer := httptest.NewServer(http.HandlerFunc(server.handleAttach))
	defer httpServer.Close()

	first := dialAndBindPLAN011(t, httpServer.URL, binding, string(server.internalToken))
	if err := wsjson.Write(context.Background(), first, ptyFrame{Type: "detach", Sequence: 2}); err != nil {
		t.Fatal(err)
	}
	readContext, readCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer readCancel()
	var closed ptyFrame
	if err := wsjson.Read(readContext, first, &closed); err == nil {
		t.Fatalf("detach must close the first PTY stream, got %#v", closed)
	}
	_ = first.CloseNow()
	deadline := time.Now().Add(2 * time.Second)
	for server.active.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if server.active.Load() {
		t.Fatal("detach did not release the one-attachment fence")
	}

	second := dialAndBindPLAN011(t, httpServer.URL, binding, string(server.internalToken))
	defer second.CloseNow()
	input := base64.RawStdEncoding.EncodeToString([]byte("printf 'same-session-reconnected\\n'; exit\n"))
	if err := wsjson.Write(context.Background(), second, ptyFrame{Type: "stdin", Sequence: 2, Data: input}); err != nil {
		t.Fatal(err)
	}
	outputContext, outputCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer outputCancel()
	var output strings.Builder
	for !strings.Contains(output.String(), "same-session-reconnected") {
		var frame ptyFrame
		if err := wsjson.Read(outputContext, second, &frame); err != nil {
			t.Fatalf("reconnected PTY output missing: %q err=%v", output.String(), err)
		}
		if frame.Type == "stdout" {
			decoded, _ := base64.RawStdEncoding.DecodeString(frame.Data)
			output.Write(decoded)
		}
	}
}

func TestPLAN011AgentWSSDetachThenReconnectsSameRuntimeBinding(t *testing.T) {
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skip("runtime image provides the fixed /bin/bash contract")
	}
	binding := testBinding()
	identity, err := newSigningIdentity(time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	defer identity.close()
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
	target := "wss" + strings.TrimPrefix(tlsServer.URL, "https") + "/v1/runtime/attach"
	pinnedClient := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion: tls.VersionTLS13, InsecureSkipVerify: true, // Exact leaf digest is verified below.
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) != 1 {
				return fmt.Errorf("unexpected certificate chain")
			}
			digest := sha256.Sum256(state.PeerCertificates[0].Raw)
			if fmt.Sprintf("sha256:%x", digest[:]) != identity.tlsCertificateSHA256 {
				return fmt.Errorf("runtime certificate fingerprint mismatch")
			}
			return nil
		},
	}}}

	first := dialAndAttachAgentPLAN011(t, target, pinnedClient, binding, strings.Repeat("a", 48))
	if err := wsjson.Write(context.Background(), first, ptyFrame{Type: "detach", Sequence: 2}); err != nil {
		t.Fatal(err)
	}
	firstRead, firstCancel := context.WithTimeout(context.Background(), 2*time.Second)
	var closed ptyFrame
	if err := wsjson.Read(firstRead, first, &closed); err == nil {
		firstCancel()
		t.Fatalf("detach must close the first public WSS stream, got %#v", closed)
	}
	firstCancel()
	_ = first.CloseNow()
	deadline := time.Now().Add(2 * time.Second)
	for (agent.attachActive.Load() || ptyRuntime.active.Load()) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if agent.attachActive.Load() || ptyRuntime.active.Load() {
		t.Fatal("detach did not release the agent and PTY one-attachment fences")
	}

	second := dialAndAttachAgentPLAN011(t, target, pinnedClient, binding, strings.Repeat("b", 48))
	defer second.CloseNow()
	input := base64.RawStdEncoding.EncodeToString([]byte("printf 'agent-same-session-reconnected\\n'; exit\n"))
	if err := wsjson.Write(context.Background(), second, ptyFrame{Type: "stdin", Sequence: 2, Data: input}); err != nil {
		t.Fatal(err)
	}
	outputContext, outputCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer outputCancel()
	var output strings.Builder
	for !strings.Contains(output.String(), "agent-same-session-reconnected") {
		var frame ptyFrame
		if err := wsjson.Read(outputContext, second, &frame); err != nil {
			t.Fatalf("reconnected agent WSS output missing: %q err=%v", output.String(), err)
		}
		if frame.Type == "stdout" {
			decoded, _ := base64.RawStdEncoding.DecodeString(frame.Data)
			output.Write(decoded)
		}
	}
}

// PLAN011_OS_BINARY may point at /usr/local/bin/os copied from the exact
// deployed runtime digest. Without it, the test builds the workspace CLI so
// the contract remains part of the normal source gate.
func osCLISourcePath() string {
	if configured := strings.TrimSpace(os.Getenv("OPENSPHERE_OS_CLI_SOURCE")); configured != "" {
		return configured
	}
	return filepath.Clean(filepath.Join("..", "..", "..", "cmd", "os-cli", "cmd", "os"))
}

func TestPLAN011OSRejectsLocalAndExternalToolsInAttestedRuntime(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("Unix credential-agent contract")
	}
	temporary := t.TempDir()
	binaryPath := strings.TrimSpace(os.Getenv("PLAN011_OS_BINARY"))
	agentSocketPath := filepath.Join(temporary, "agent.sock")
	agentKeyPath := filepath.Join(temporary, "agent-public-key.pem")
	if binaryPath == "" {
		binaryPath = filepath.Join(temporary, "os")
		build := exec.Command("go", "build", "-trimpath", "-ldflags", fmt.Sprintf(
			"-X main.webShellAgentSocketPath=%s -X main.webShellAgentPublicKeyPath=%s",
			agentSocketPath, agentKeyPath,
		), "-o", binaryPath, osCLISourcePath())
		if output, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build os CLI fixture: %v\n%s", err, output)
		}
	} else {
		// The released Runtime image linker-pins these private tmpfs paths.
		agentSocketPath = "/run/opensphere-shell/channel/agent.sock"
		agentKeyPath = "/run/opensphere-shell/channel/agent-public-key.pem"
	}
	if info, err := os.Stat(binaryPath); err != nil || info.Mode()&0o111 == 0 {
		t.Fatalf("PLAN011 os binary is not executable: %s err=%v", binaryPath, err)
	}

	originalSocket, originalKey := configuredAgentSocketPath, configuredPublicKeyPath
	configuredAgentSocketPath, configuredPublicKeyPath = agentSocketPath, agentKeyPath
	defer func() { configuredAgentSocketPath, configuredPublicKeyPath = originalSocket, originalKey }()
	identity, err := newSigningIdentity(time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	defer identity.close()
	if err := publishPublicKey(identity.publicPEM); err != nil {
		t.Fatal(err)
	}
	listener, err := listenAgentUnixSocket()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	server := &agentServer{binding: testBinding(), identity: identity}
	go func() { done <- server.serveAgentSocket(ctx, listener) }()
	defer func() {
		cancel()
		_ = listener.Close()
		<-done
	}()

	commands := []struct {
		name string
		args []string
	}{
		{name: "local-host", args: []string{"context", "list", "-o", "json"}},
		{name: "external-tool", args: []string{"platform", "update", "check", "--lock", filepath.Join(temporary, "not-read.json"), "--channel", "edge", "-o", "json"}},
	}
	for _, fixture := range commands {
		t.Run(fixture.name, func(t *testing.T) {
			command := exec.Command(binaryPath, fixture.args...)
			command.Env = append(withoutEnvironment(os.Environ(), "OS_CONFIG"),
				"OS_CONFIG="+filepath.Join(temporary, "missing-config.json"))
			output, runErr := command.CombinedOutput()
			if runErr == nil || command.ProcessState.ExitCode() != 2 {
				t.Fatalf("%s command must fail RC=2: err=%v output=%s", fixture.name, runErr, output)
			}
			if !strings.Contains(string(output), `"code": "UnsupportedInWebShell"`) {
				t.Fatalf("%s command lost stable error code: %s", fixture.name, output)
			}
		})
	}
}

func dialAndBindPLAN011(t *testing.T, serverURL string, binding runtimeBinding, internalToken string) *websocket.Conn {
	t.Helper()
	connection := dialTestPTY(t, serverURL)
	if err := wsjson.Write(context.Background(), connection, validBindForTest(binding, internalToken)); err != nil {
		connection.CloseNow()
		t.Fatal(err)
	}
	readContext, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var attached ptyFrame
	if err := wsjson.Read(readContext, connection, &attached); err != nil || attached.Type != "attached" {
		connection.CloseNow()
		t.Fatalf("PTY attach failed: %#v err=%v", attached, err)
	}
	return connection
}

func dialAndAttachAgentPLAN011(t *testing.T, target string, client *http.Client, binding runtimeBinding, ticket string) *websocket.Conn {
	t.Helper()
	connection, _, err := websocket.Dial(context.Background(), target, &websocket.DialOptions{
		HTTPClient: client, Subprotocols: []string{publicPTYSubprotocol},
	})
	if err != nil {
		t.Fatal(err)
	}
	attach := ptyFrame{
		Type: "attach", Sequence: 1, Ticket: ticket, SessionID: binding.SessionID,
		RuntimeUID: binding.RuntimeUID, Generation: binding.Generation, FencingEpoch: binding.FencingEpoch,
	}
	if err := wsjson.Write(context.Background(), connection, attach); err != nil {
		connection.CloseNow()
		t.Fatal(err)
	}
	readContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var attached ptyFrame
	if err := wsjson.Read(readContext, connection, &attached); err != nil || attached.Type != "attached" {
		connection.CloseNow()
		t.Fatalf("agent WSS attach failed: %#v err=%v", attached, err)
	}
	return connection
}
