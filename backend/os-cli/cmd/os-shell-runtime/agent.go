package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	agentSocketPath      = "/run/opensphere-shell/channel/agent.sock"
	agentPublicKeyPath   = "/run/opensphere-shell/channel/agent-public-key.pem"
	internalPTYTokenPath = "/run/opensphere-shell-internal/channel/pty-token"
	internalPTYAddr      = "127.0.0.1:8081"
	publicPTYSubprotocol = "opensphere.pty.v1"
)

var (
	configuredAgentSocketPath      = agentSocketPath
	configuredPublicKeyPath        = agentPublicKeyPath
	configuredAgentListenAddr      = defaultAgentListenAddr
	configuredPTYAddr              = internalPTYAddr
	configuredInternalPTYTokenPath = internalPTYTokenPath
)

type agentServer struct {
	binding       runtimeBinding
	identity      *signingIdentity
	control       *controlClient
	consoleAPIURL string
	internalToken []byte
	attachActive  atomic.Bool
	connections   sync.WaitGroup
	proxyOnce     sync.Once
	proxySlots    chan struct{}
	proxyRateMu   sync.Mutex
	proxyWindow   time.Time
	proxyRequests int
	proxyBytes    int
}

func runAgent(ctx context.Context, binding runtimeBinding) error {
	if os.Geteuid() == 0 {
		return errors.New("credential agent refuses to run as root")
	}
	identity, err := newSigningIdentity(now().UTC())
	if err != nil {
		return err
	}
	defer identity.close()
	control, err := newControlClient()
	if err != nil {
		return err
	}
	defer control.close()
	consoleAPIURL, err := loadConsoleAPIURL()
	if err != nil {
		return err
	}
	if err := publishPublicKey(identity.publicPEM); err != nil {
		return err
	}
	internalToken, err := readInternalPTYToken(ctx)
	if err != nil {
		return err
	}
	defer wipe(internalToken)
	if err := control.register(ctx, binding, identity); err != nil {
		return err
	}
	server := &agentServer{binding: binding, identity: identity, control: control, consoleAPIURL: consoleAPIURL, internalToken: internalToken}
	unixListener, err := listenAgentUnixSocket()
	if err != nil {
		return err
	}
	defer func() {
		_ = unixListener.Close()
		_ = os.Remove(configuredAgentSocketPath)
	}()
	tcpListener, err := net.Listen("tcp", configuredAgentListenAddr)
	if err != nil {
		return err
	}
	tlsConfig := &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{identity.tlsCertificate},
		NextProtos:   []string{"http/1.1"},
	}
	tlsListener := tls.NewListener(tcpListener, tlsConfig)
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if control.ensureCurrent() != nil {
			http.Error(w, "runtime credential unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/v1/runtime/attach", server.handleAttach)
	httpServer := &http.Server{
		Handler: mux, ReadHeaderTimeout: 3 * time.Second, IdleTimeout: 15 * time.Second,
		MaxHeaderBytes: 16 << 10, TLSConfig: tlsConfig,
	}
	errorsCh := make(chan error, 2)
	go func() { errorsCh <- server.serveAgentSocket(ctx, unixListener) }()
	go func() {
		err := httpServer.Serve(tlsListener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		errorsCh <- err
	}()
	select {
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownContext)
		_ = unixListener.Close()
		return nil
	case err := <-errorsCh:
		return err
	}
}

func publishPublicKey(publicPEM []byte) error {
	directory := filepath.Dir(configuredPublicKeyPath)
	if err := prepareRuntimeDirectory(directory); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".agent-public-key-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(publicPEM); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryName, configuredPublicKeyPath); err != nil {
		return err
	}
	return os.Chmod(configuredPublicKeyPath, 0o444)
}

func listenAgentUnixSocket() (net.Listener, error) {
	directory := filepath.Dir(configuredAgentSocketPath)
	if err := prepareRuntimeDirectory(directory); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(configuredAgentSocketPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("refusing to replace a non-socket agent path")
		}
		if err := os.Remove(configuredAgentSocketPath); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.Listen("unix", configuredAgentSocketPath)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(configuredAgentSocketPath, 0o660); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}

func readInternalPTYToken(ctx context.Context) ([]byte, error) {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(10 * time.Second)
	defer timeout.Stop()
	for {
		info, err := os.Lstat(configuredInternalPTYTokenPath)
		if err == nil {
			if !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 || info.Size() < 32 || info.Size() > 512 {
				return nil, errors.New("internal PTY token has unsafe metadata")
			}
			raw, readErr := os.ReadFile(configuredInternalPTYTokenPath)
			if readErr != nil {
				return nil, readErr
			}
			raw = bytes.TrimSpace(raw)
			if len(raw) < 32 || bytes.IndexAny(raw, "\r\n\x00") >= 0 {
				wipe(raw)
				return nil, errors.New("internal PTY token is malformed")
			}
			if removeErr := os.Remove(configuredInternalPTYTokenPath); removeErr != nil {
				wipe(raw)
				return nil, removeErr
			}
			return raw, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timeout.C:
			return nil, errors.New("internal PTY token was not published")
		case <-ticker.C:
		}
	}
}

func (server *agentServer) serveAgentSocket(ctx context.Context, listener net.Listener) error {
	defer server.connections.Wait()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		server.connections.Add(1)
		go func() {
			defer server.connections.Done()
			server.handleAgentConnection(ctx, connection)
		}()
	}
}

func (server *agentServer) handleAgentConnection(parent context.Context, connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(now().Add(35 * time.Second))
	line, err := bufio.NewReader(io.LimitReader(connection, maxAgentMessage+1)).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return
	}
	response := agentResponse{Contract: agentContract}
	if len(line) == 0 || len(line) > maxAgentMessage {
		response.Error = "InvalidRequest"
		_ = json.NewEncoder(connection).Encode(response)
		return
	}
	var request agentRequest
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(&struct{}{}) != io.EOF || request.Contract != agentContract ||
		(request.Operation != "context" && request.Operation != "request") ||
		(request.Operation == "context" && request.Request != nil) ||
		(request.Operation == "request" && request.Request == nil) {
		response.Error = "InvalidRequest"
		_ = json.NewEncoder(connection).Encode(response)
		return
	}
	contextJWS, err := server.identity.signContext(server.binding, cliAudience, "", now().UTC())
	if err != nil {
		response.Error = "ExecutionContextUnavailable"
		_ = json.NewEncoder(connection).Encode(response)
		return
	}
	response.ContextJWS = contextJWS
	if request.Operation == "request" {
		ctx, cancel := context.WithTimeout(parent, 30*time.Second)
		defer cancel()
		proxied, err := server.proxyConsoleRequest(ctx, contextJWS, *request.Request)
		if err != nil {
			response.ContextJWS = ""
			response.Error = "ConsoleRequestRejected"
		} else {
			response.Response = &proxied
		}
	}
	_ = json.NewEncoder(connection).Encode(response)
}

func (server *agentServer) handleAttach(w http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || request.TLS == nil || request.Header.Get("Origin") != "" {
		http.Error(w, "runtime attach requires an internal TLS gateway", http.StatusForbidden)
		return
	}
	if !server.attachActive.CompareAndSwap(false, true) {
		http.Error(w, "runtime already has an active attachment", http.StatusConflict)
		return
	}
	defer server.attachActive.Store(false)
	connection, err := websocket.Accept(w, request, &websocket.AcceptOptions{
		Subprotocols: []string{publicPTYSubprotocol}, CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	defer connection.Close(websocket.StatusNormalClosure, "runtime attachment closed")
	if connection.Subprotocol() != publicPTYSubprotocol {
		_ = connection.Close(websocket.StatusPolicyViolation, "required PTY subprotocol missing")
		return
	}
	connection.SetReadLimit(maxPTYFrame)
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	firstFrameContext, firstFrameCancel := context.WithTimeout(ctx, 3*time.Second)
	defer firstFrameCancel()
	var attach ptyFrame
	if wsjson.Read(firstFrameContext, connection, &attach) != nil || !validAttachFrame(attach, server.binding) {
		_ = connection.Close(websocket.StatusPolicyViolation, "invalid attach frame")
		return
	}
	authorizeContext, authorizeCancel := context.WithTimeout(ctx, 4*time.Second)
	err = server.control.authorizeAttach(authorizeContext, server.binding, attach)
	authorizeCancel()
	if err != nil {
		_ = connection.Close(websocket.StatusPolicyViolation, "attach authorization failed")
		return
	}
	ptyConnection, err := server.bindPTY(ctx)
	if err != nil {
		_ = connection.Close(websocket.StatusInternalError, "PTY unavailable")
		return
	}
	defer ptyConnection.Close(websocket.StatusNormalClosure, "agent bridge closed")
	server.bridgePTY(ctx, cancel, connection, ptyConnection, attach.Sequence)
}

func validAttachFrame(frame ptyFrame, binding runtimeBinding) bool {
	return frame.Type == "attach" && frame.Sequence == 1 && len(frame.Ticket) >= 32 && len(frame.Ticket) <= 4096 &&
		frame.SessionID == binding.SessionID && frame.RuntimeUID == binding.RuntimeUID &&
		frame.Generation == binding.Generation && frame.FencingEpoch == binding.FencingEpoch
}

func (server *agentServer) bindPTY(ctx context.Context) (*websocket.Conn, error) {
	connection, _, err := websocket.Dial(ctx, "ws://"+configuredPTYAddr+"/v1/pty/attach", &websocket.DialOptions{
		Subprotocols: []string{"opensphere.pty.internal.v1"},
	})
	if err != nil {
		return nil, err
	}
	connection.SetReadLimit(maxPTYFrame)
	bind := ptyFrame{
		Type: "bind", Sequence: 1, SessionID: server.binding.SessionID,
		RuntimeUID: server.binding.RuntimeUID, Generation: server.binding.Generation,
		FencingEpoch: server.binding.FencingEpoch, InternalToken: string(server.internalToken),
	}
	bindContext, bindCancel := context.WithTimeout(ctx, 3*time.Second)
	defer bindCancel()
	if err := wsjson.Write(bindContext, connection, bind); err != nil {
		connection.Close(websocket.StatusInternalError, "bind failed")
		return nil, err
	}
	var response ptyFrame
	if err := wsjson.Read(bindContext, connection, &response); err != nil || response.Type != "attached" {
		connection.Close(websocket.StatusPolicyViolation, "bind rejected")
		return nil, errors.New("PTY rejected runtime agent binding")
	}
	return connection, nil
}

func (server *agentServer) bridgePTY(ctx context.Context, cancel context.CancelFunc, websocketConnection *websocket.Conn, ptyConnection *websocket.Conn, initialSequence uint64) {
	ctx, bridgeCancel := context.WithCancel(ctx)
	defer bridgeCancel()
	outbound := make(chan ptyFrame, 64)
	outbound <- ptyFrame{Type: "attached", Sequence: initialSequence}
	var wait sync.WaitGroup
	wait.Add(4)
	go func() {
		defer wait.Done()
		sequence := initialSequence - 1
		for {
			select {
			case <-ctx.Done():
				return
			case frame := <-outbound:
				frame = sequenceOutboundFrame(frame, &sequence)
				writeContext, writeCancel := context.WithTimeout(ctx, 2*time.Second)
				err := wsjson.Write(writeContext, websocketConnection, frame)
				writeCancel()
				if err != nil {
					bridgeCancel()
					return
				}
			}
		}
	}()
	go func() {
		defer wait.Done()
		for {
			var frame ptyFrame
			if err := wsjson.Read(ctx, ptyConnection, &frame); err != nil {
				bridgeCancel()
				return
			}
			select {
			case outbound <- frame:
			case <-ctx.Done():
				return
			default:
				bridgeCancel()
				return
			}
		}
	}()
	go func() {
		defer wait.Done()
		sequence := initialSequence
		limiter := newFrameLimiter(now())
		for {
			var frame ptyFrame
			if err := wsjson.Read(ctx, websocketConnection, &frame); err != nil {
				bridgeCancel()
				return
			}
			if !validClientFrame(frame, sequence, limiter) {
				select {
				case outbound <- ptyFrame{Type: "error", Message: "invalid or excessive PTY frame"}:
				default:
				}
				bridgeCancel()
				return
			}
			sequence = frame.Sequence
			writeContext, writeCancel := context.WithTimeout(ctx, 2*time.Second)
			err := wsjson.Write(writeContext, ptyConnection, frame)
			writeCancel()
			if err != nil {
				bridgeCancel()
				return
			}
			if frame.Type == "detach" {
				bridgeCancel()
				return
			}
		}
	}()
	go func() {
		defer wait.Done()
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				revalidateContext, revalidateCancel := context.WithTimeout(ctx, 2*time.Second)
				err := server.control.revalidate(revalidateContext, server.binding)
				revalidateCancel()
				if err != nil {
					select {
					case outbound <- ptyFrame{Type: "revoked", Message: "runtime authorization revoked"}:
					default:
					}
					bridgeCancel()
					return
				}
			}
		}
	}()
	<-ctx.Done()
	_ = ptyConnection.Close(websocket.StatusNormalClosure, "bridge closed")
	cancel()
	wait.Wait()
}

func sequenceOutboundFrame(frame ptyFrame, sequence *uint64) ptyFrame {
	*sequence++
	frame.Sequence = *sequence
	return frame
}

type frameLimiter struct {
	window time.Time
	frames int
	bytes  int
}

func newFrameLimiter(timestamp time.Time) *frameLimiter { return &frameLimiter{window: timestamp} }

func validClientFrame(frame ptyFrame, previous uint64, limiter *frameLimiter) bool {
	if frame.Sequence <= previous || (frame.Type != "stdin" && frame.Type != "resize" && frame.Type != "ping" && frame.Type != "detach") {
		return false
	}
	dataBytes := 0
	switch frame.Type {
	case "stdin":
		decoded, err := base64.RawStdEncoding.DecodeString(frame.Data)
		if err != nil || len(decoded) > maxPTYData || frame.Columns != 0 || frame.Rows != 0 {
			return false
		}
		dataBytes = len(decoded)
	case "resize":
		if frame.Data != "" || frame.Columns < 2 || frame.Columns > 500 || frame.Rows < 2 || frame.Rows > 300 {
			return false
		}
	case "ping", "detach":
		if frame.Data != "" || frame.Columns != 0 || frame.Rows != 0 {
			return false
		}
	}
	nowValue := now()
	if nowValue.Sub(limiter.window) >= time.Second {
		limiter.window, limiter.frames, limiter.bytes = nowValue, 0, 0
	}
	limiter.frames++
	limiter.bytes += dataBytes
	if limiter.frames > 60 || limiter.bytes > maxPTYBytesPerSec {
		return false
	}
	return true
}

func init() {
	// Never let the standard logger serialize request/header objects containing
	// bootstrap, runtime or delegated bearer material.
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
}
