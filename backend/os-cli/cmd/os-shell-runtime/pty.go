package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/creack/pty"
)

const internalPTYSubprotocol = "opensphere.pty.internal.v1"

var configuredPTYListenAddr = defaultPTYListenAddr

type ptyServer struct {
	binding       runtimeBinding
	consoleAPIURL string
	internalToken []byte
	active        atomic.Bool
}

func runPTY(ctx context.Context, binding runtimeBinding) error {
	if os.Geteuid() == 0 {
		return errors.New("PTY runtime refuses to run as root")
	}
	if err := requireLoopbackAddress(configuredPTYListenAddr); err != nil {
		return err
	}
	consoleAPIURL, err := loadConsoleAPIURL()
	if err != nil {
		return err
	}
	internalToken, err := publishInternalPTYToken()
	if err != nil {
		return err
	}
	defer wipe(internalToken)
	listener, err := net.Listen("tcp", configuredPTYListenAddr)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	server := &ptyServer{binding: binding, consoleAPIURL: consoleAPIURL, internalToken: internalToken}
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, request *http.Request) {
		if !requestIsLoopback(request) {
			http.NotFound(w, request)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/v1/pty/attach", server.handleAttach)
	httpServer := &http.Server{Handler: mux, ReadHeaderTimeout: 2 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 8 << 10}
	go func() {
		<-ctx.Done()
		shutdownContext, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownContext)
	}()
	err = httpServer.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func requireLoopbackAddress(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid PTY listen address: %w", err)
	}
	parsed := net.ParseIP(host)
	if parsed == nil || !parsed.IsLoopback() {
		return errors.New("PTY server must be bound to an explicit loopback address")
	}
	return nil
}

func publishInternalPTYToken() ([]byte, error) {
	randomBytes := make([]byte, 48)
	if _, err := rand.Read(randomBytes); err != nil {
		return nil, err
	}
	token := []byte(base64.RawURLEncoding.EncodeToString(randomBytes))
	wipe(randomBytes)
	directory := filepath.Dir(configuredInternalPTYTokenPath)
	if err := prepareRuntimeDirectory(directory); err != nil {
		wipe(token)
		return nil, err
	}
	temporary, err := os.CreateTemp(directory, ".pty-token-*")
	if err != nil {
		wipe(token)
		return nil, err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o400); err != nil {
		_ = temporary.Close()
		wipe(token)
		return nil, err
	}
	if _, err := temporary.Write(append(token, '\n')); err != nil {
		_ = temporary.Close()
		wipe(token)
		return nil, err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		wipe(token)
		return nil, err
	}
	if err := temporary.Close(); err != nil {
		wipe(token)
		return nil, err
	}
	if err := os.Rename(temporaryName, configuredInternalPTYTokenPath); err != nil {
		wipe(token)
		return nil, err
	}
	return token, nil
}

func requestIsLoopback(request *http.Request) bool {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	parsed := net.ParseIP(host)
	return err == nil && parsed != nil && parsed.IsLoopback()
}

func (server *ptyServer) handleAttach(w http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || request.TLS != nil || request.Header.Get("Origin") != "" || !requestIsLoopback(request) {
		http.NotFound(w, request)
		return
	}
	if !server.active.CompareAndSwap(false, true) {
		http.Error(w, "PTY already attached", http.StatusConflict)
		return
	}
	defer server.active.Store(false)
	connection, err := websocket.Accept(w, request, &websocket.AcceptOptions{Subprotocols: []string{internalPTYSubprotocol}, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer connection.Close(websocket.StatusNormalClosure, "PTY closed")
	if connection.Subprotocol() != internalPTYSubprotocol {
		_ = connection.Close(websocket.StatusPolicyViolation, "internal PTY subprotocol missing")
		return
	}
	connection.SetReadLimit(maxPTYFrame)
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	bindContext, bindCancel := context.WithTimeout(ctx, 3*time.Second)
	defer bindCancel()
	var bind ptyFrame
	if wsjson.Read(bindContext, connection, &bind) != nil || !server.validBind(bind) {
		_ = connection.Close(websocket.StatusPolicyViolation, "invalid runtime binding")
		return
	}
	bind.InternalToken = ""
	command := exec.CommandContext(ctx, "/bin/bash", "--noprofile", "--norc")
	command.Env = []string{
		"HOME=/home/opensphere", "PATH=/usr/local/bin:/usr/bin:/bin", "TERM=xterm-256color",
		"LANG=C.UTF-8", "LC_ALL=C.UTF-8", "SHELL=/bin/bash", "OS_CONSOLE=" + server.consoleAPIURL,
	}
	if info, err := os.Stat("/home/opensphere"); err == nil && info.IsDir() {
		command.Dir = "/home/opensphere"
	} else {
		command.Dir = "/"
	}
	terminal, err := pty.StartWithSize(command, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		_ = wsjson.Write(bindContext, connection, ptyFrame{Type: "error", Message: "fixed shell unavailable"})
		return
	}
	defer func() {
		_ = terminal.Close()
		if command.Process != nil {
			_ = command.Process.Kill()
		}
	}()
	if err := wsjson.Write(bindContext, connection, ptyFrame{Type: "attached", Sequence: 1}); err != nil {
		return
	}
	server.runShell(ctx, cancel, connection, terminal, command)
}

func (server *ptyServer) validBind(frame ptyFrame) bool {
	return frame.Type == "bind" && frame.Sequence == 1 && len(frame.InternalToken) == len(server.internalToken) &&
		subtle.ConstantTimeCompare([]byte(frame.InternalToken), server.internalToken) == 1 &&
		frame.SessionID == server.binding.SessionID && frame.RuntimeUID == server.binding.RuntimeUID &&
		frame.Generation == server.binding.Generation && frame.FencingEpoch == server.binding.FencingEpoch
}

func (server *ptyServer) runShell(ctx context.Context, cancel context.CancelFunc, connection *websocket.Conn, terminal *os.File, command *exec.Cmd) {
	outbound := make(chan ptyFrame, 64)
	var wait sync.WaitGroup
	wait.Add(4)
	go func() {
		defer wait.Done()
		var sequence uint64 = 1
		for {
			select {
			case <-ctx.Done():
				return
			case frame := <-outbound:
				sequence++
				frame.Sequence = sequence
				writeContext, writeCancel := context.WithTimeout(ctx, 2*time.Second)
				err := wsjson.Write(writeContext, connection, frame)
				writeCancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	go func() {
		defer wait.Done()
		buffer := make([]byte, 32<<10)
		for {
			count, err := terminal.Read(buffer)
			if count > 0 {
				frame := ptyFrame{Type: "stdout", Data: base64.RawStdEncoding.EncodeToString(buffer[:count])}
				select {
				case outbound <- frame:
				case <-ctx.Done():
					return
				default:
					cancel()
					return
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					select {
					case outbound <- ptyFrame{Type: "error", Message: "PTY output failed"}:
					default:
					}
				}
				return
			}
		}
	}()
	go func() {
		defer wait.Done()
		var previous uint64 = 1
		limiter := newFrameLimiter(now())
		for {
			var frame ptyFrame
			if err := wsjson.Read(ctx, connection, &frame); err != nil || !validClientFrame(frame, previous, limiter) {
				cancel()
				return
			}
			previous = frame.Sequence
			switch frame.Type {
			case "stdin":
				data, _ := base64.RawStdEncoding.DecodeString(frame.Data)
				if _, err := terminal.Write(data); err != nil {
					cancel()
					return
				}
			case "resize":
				if err := pty.Setsize(terminal, &pty.Winsize{Rows: frame.Rows, Cols: frame.Columns}); err != nil {
					cancel()
					return
				}
			case "ping":
				select {
				case outbound <- ptyFrame{Type: "pong"}:
				default:
					cancel()
					return
				}
			case "detach":
				cancel()
				return
			}
		}
	}()
	go func() {
		defer wait.Done()
		err := command.Wait()
		code := 0
		if err != nil {
			var exitError *exec.ExitError
			if errors.As(err, &exitError) {
				code = exitError.ExitCode()
			} else {
				code = 1
			}
		}
		select {
		case outbound <- ptyFrame{Type: "exit", Code: code}:
		case <-ctx.Done():
		}
		cancel()
	}()
	<-ctx.Done()
	_ = terminal.Close()
	if command.Process != nil {
		terminateProcessGroup(command.Process.Pid)
	}
	wait.Wait()
}

func terminateProcessGroup(processID int) {
	if processID < 2 {
		return
	}
	if err := syscall.Kill(-processID, syscall.SIGTERM); err != nil {
		return
	}
	timer := time.NewTimer(250 * time.Millisecond)
	defer timer.Stop()
	<-timer.C
	_ = syscall.Kill(-processID, syscall.SIGKILL)
}

func init() {
	_ = syscall.Setrlimit(syscall.RLIMIT_CORE, &syscall.Rlimit{Cur: 0, Max: 0})
}
