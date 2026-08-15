package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	webShellAgentContract   = "opensphere-web-shell-agent/v1"
	webShellContextContract = "opensphere-web-shell-context/v2"
	webShellAgentTransport  = "__opensphere_web_shell_agent_transport__"
	webShellAgentMaxMessage = 12 << 20
	webShellProxyMaxBody    = 1 << 20
	webShellProxyMaxReply   = 8 << 20
)

// These fixed, non-environment paths are part of the operator-interactive
// runtime template. Tests replace them in-process; users cannot select a
// different authority with argv, environment variables, or ~/.os/config.json.
var webShellAgentSocketPath = "/run/opensphere-shell/agent.sock"
var webShellAgentPublicKeyPath = "/run/opensphere-shell/agent-public-key.pem"
var webShellAgentNow = time.Now
var webShellConsoleAPIURL = "https://opensphere-shell-console-api.opensphere-console.svc.cluster.local:8445"

type webShellAgentRequest struct {
	Contract  string                    `json:"contract"`
	Operation string                    `json:"operation"`
	Request   *webShellAgentHTTPRequest `json:"request,omitempty"`
}

type webShellAgentResponse struct {
	Contract   string                     `json:"contract"`
	ContextJWS string                     `json:"contextJws"`
	Response   *webShellAgentHTTPResponse `json:"response,omitempty"`
	Error      string                     `json:"error,omitempty"`
}

type webShellAgentHTTPRequest struct {
	Method         string `json:"method"`
	Path           string `json:"path"`
	ContentType    string `json:"contentType,omitempty"`
	Body           string `json:"body,omitempty"`
	CorrelationID  string `json:"correlationId"`
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
}

type webShellAgentHTTPResponse struct {
	Status      int    `json:"status"`
	ContentType string `json:"contentType,omitempty"`
	RetryAfter  string `json:"retryAfter,omitempty"`
	Body        string `json:"body,omitempty"`
}

type webShellJWSHeader struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
	KeyID     string `json:"kid"`
}

type webShellContextClaims struct {
	Contract           string          `json:"contract"`
	Issuer             string          `json:"iss"`
	Audience           json.RawMessage `json:"aud"`
	AttestationID      string          `json:"jti"`
	Profile            string          `json:"profile"`
	Authority          string          `json:"authority"`
	ActorID            string          `json:"actorId"`
	SessionID          string          `json:"sessionId"`
	SessionClass       string          `json:"sessionClass"`
	RuntimeAdapterID   string          `json:"runtimeAdapterId"`
	RuntimeUID         string          `json:"runtimeUid"`
	Origin             string          `json:"origin"`
	PermissionRevision string          `json:"permissionRevision"`
	AssuranceLevel     string          `json:"aal"`
	ReleaseEvidenceRef string          `json:"releaseEvidenceRef"`
	Generation         int64           `json:"generation"`
	FencingEpoch       int64           `json:"fencingEpoch"`
	IssuedAt           int64           `json:"iat"`
	NotBefore          int64           `json:"nbf"`
	ExpiresAt          int64           `json:"exp"`
}

func readAttestedExecutionContextFromAgent(ctx context.Context) (*AttestedExecutionContext, error) {
	response, present, err := callWebShellAgent(ctx, "context")
	if err != nil || !present {
		return nil, err
	}
	return verifyWebShellContextJWS(response.ContextJWS)
}

func callWebShellAgent(ctx context.Context, operation string) (webShellAgentResponse, bool, error) {
	return invokeWebShellAgent(ctx, webShellAgentRequest{Contract: webShellAgentContract, Operation: operation})
}

func invokeWebShellAgent(ctx context.Context, request webShellAgentRequest) (webShellAgentResponse, bool, error) {
	var response webShellAgentResponse
	info, err := os.Lstat(webShellAgentSocketPath)
	if errors.Is(err, os.ErrNotExist) {
		return response, false, nil
	}
	if err != nil {
		return response, true, executionContextUnavailable(err)
	}
	if info.Mode()&os.ModeSocket == 0 || info.Mode().Perm()&0o002 != 0 {
		return response, true, &CLIError{Code: "InvalidExecutionContext", Message: "Web Shell credential agent socket 권한이 올바르지 않습니다"}
	}
	dialer := net.Dialer{Timeout: 500 * time.Millisecond}
	conn, err := dialer.DialContext(ctx, "unix", webShellAgentSocketPath)
	if err != nil {
		return response, true, executionContextUnavailable(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(webShellAgentNow().Add(35 * time.Second))
	requestBytes, _ := json.Marshal(request)
	if len(requestBytes) > webShellAgentMaxMessage {
		return response, true, &CLIError{Code: "InvalidExecutionContext", Message: "Web Shell agent 요청이 허용 크기를 초과했습니다"}
	}
	if _, err := conn.Write(append(requestBytes, '\n')); err != nil {
		return response, true, executionContextUnavailable(err)
	}
	line, err := bufio.NewReader(io.LimitReader(conn, webShellAgentMaxMessage+1)).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return response, true, executionContextUnavailable(err)
	}
	if len(line) == 0 || len(line) > webShellAgentMaxMessage {
		return response, true, &CLIError{Code: "InvalidExecutionContext", Message: "Web Shell credential agent 응답 크기가 올바르지 않습니다"}
	}
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&response); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return response, true, &CLIError{Code: "InvalidExecutionContext", Message: "Web Shell credential agent 응답이 올바른 JSON이 아닙니다"}
	}
	if response.Contract != webShellAgentContract || response.Error != "" || strings.TrimSpace(response.ContextJWS) == "" {
		return response, true, &CLIError{Code: "InvalidExecutionContext", Message: "Web Shell credential agent 계약이 일치하지 않습니다"}
	}
	return response, true, nil
}

func proxyWebShellRequest(ctx context.Context, method, rawURL string, body io.Reader, contentType string) ([]byte, int, string, string, bool, error) {
	info, err := os.Lstat(webShellAgentSocketPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, 0, "", "", false, nil
	}
	if err != nil {
		return nil, 0, "", "", true, executionContextUnavailable(err)
	}
	if info.Mode()&os.ModeSocket == 0 || info.Mode().Perm()&0o002 != 0 {
		return nil, 0, "", "", true, &CLIError{Code: "InvalidExecutionContext", Message: "Web Shell credential agent socket 권한이 올바르지 않습니다"}
	}
	target, err := url.Parse(rawURL)
	base, baseErr := url.Parse(webShellConsoleAPIURL)
	if err != nil || baseErr != nil || target.Scheme != base.Scheme || target.Host != base.Host || target.User != nil || target.Fragment != "" {
		return nil, 0, "", "", true, &CLIError{Code: "UnsupportedInWebShell", Message: "Web Shell은 고정된 내부 Console API만 사용할 수 있습니다"}
	}
	var requestBody []byte
	if body != nil {
		requestBody, err = io.ReadAll(io.LimitReader(body, webShellProxyMaxBody+1))
		if err != nil || len(requestBody) > webShellProxyMaxBody {
			return nil, 0, "", "", true, &CLIError{Code: "InvalidExecutionContext", Message: "Web Shell 요청 본문이 허용 크기를 초과했습니다"}
		}
	}
	requestID := operationID()
	request := webShellAgentHTTPRequest{
		Method: method, Path: target.RequestURI(), ContentType: contentType,
		Body: base64.RawStdEncoding.EncodeToString(requestBody), CorrelationID: requestID,
	}
	if method != http.MethodGet && method != http.MethodHead {
		request.IdempotencyKey = requestID
	}
	response, present, err := invokeWebShellAgent(ctx, webShellAgentRequest{
		Contract: webShellAgentContract, Operation: "request", Request: &request,
	})
	if err != nil || !present {
		return nil, 0, "", "", present, err
	}
	if _, err := verifyWebShellContextJWS(response.ContextJWS); err != nil {
		return nil, 0, "", "", true, err
	}
	if response.Response == nil || response.Response.Status < 100 || response.Response.Status > 599 ||
		strings.ContainsAny(response.Response.ContentType, "\r\n") || strings.ContainsAny(response.Response.RetryAfter, "\r\n") {
		return nil, 0, "", "", true, &CLIError{Code: "InvalidExecutionContext", Message: "Web Shell agent HTTP 응답 계약이 올바르지 않습니다"}
	}
	decoded, err := base64.RawStdEncoding.DecodeString(response.Response.Body)
	if err != nil || len(decoded) > webShellProxyMaxReply {
		return nil, 0, "", "", true, &CLIError{Code: "InvalidExecutionContext", Message: "Web Shell agent HTTP 응답 본문이 올바르지 않습니다"}
	}
	return decoded, response.Response.Status, response.Response.ContentType, response.Response.RetryAfter, true, nil
}

func executionContextUnavailable(err error) error {
	return &CLIError{Code: "ExecutionContextUnavailable", Message: "검증된 Web Shell 실행 context를 읽을 수 없습니다", Hint: err.Error()}
}

func verifyWebShellContextJWS(compact string) (*AttestedExecutionContext, error) {
	parts := strings.Split(compact, ".")
	if len(parts) != 3 {
		return nil, &CLIError{Code: "InvalidExecutionContext", Message: "Web Shell 실행 context JWS 형식이 올바르지 않습니다"}
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, invalidWebShellContext("JWS header encoding")
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, invalidWebShellContext("JWS payload encoding")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, invalidWebShellContext("JWS signature encoding")
	}
	var header webShellJWSHeader
	if err := json.Unmarshal(headerBytes, &header); err != nil || header.Algorithm != "EdDSA" || header.Type != "JWT" || header.KeyID == "" {
		return nil, invalidWebShellContext("JWS protected header")
	}
	publicKey, keyID, err := loadPinnedWebShellAgentPublicKey()
	if err != nil {
		return nil, err
	}
	if header.KeyID != keyID || !ed25519.Verify(publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		return nil, invalidWebShellContext("JWS signature or key binding")
	}
	var claims webShellContextClaims
	if err := json.Unmarshal(payloadBytes, &claims); err != nil {
		return nil, invalidWebShellContext("JWS claims")
	}
	audience, ok := singleAudience(claims.Audience)
	if !ok || audience != "opensphere-os-cli" {
		return nil, invalidWebShellContext("JWS audience")
	}
	now := webShellAgentNow().UTC()
	issued := time.Unix(claims.IssuedAt, 0)
	notBefore := time.Unix(claims.NotBefore, 0)
	expires := time.Unix(claims.ExpiresAt, 0)
	if claims.Contract != webShellContextContract || claims.Issuer != "opensphere-shell-credential-agent" ||
		claims.Profile != "web-shell" || claims.Authority != "delegated-credential-agent" ||
		claims.SessionClass != "operator-interactive" || claims.RuntimeAdapterID != "cbss.kubernetes-pod" ||
		claims.Generation < 1 || claims.FencingEpoch < 1 ||
		strings.TrimSpace(claims.AttestationID) == "" || strings.TrimSpace(claims.ActorID) == "" ||
		strings.TrimSpace(claims.SessionID) == "" || strings.TrimSpace(claims.PermissionRevision) == "" ||
		strings.TrimSpace(claims.RuntimeUID) == "" ||
		strings.TrimSpace(claims.AssuranceLevel) == "" || strings.TrimSpace(claims.ReleaseEvidenceRef) == "" ||
		!validWebShellOrigin(claims.Origin) || issued.After(now.Add(5*time.Second)) || issued.Before(now.Add(-60*time.Second)) ||
		notBefore.After(now.Add(5*time.Second)) || !expires.After(now) || expires.After(now.Add(5*time.Minute)) {
		return nil, invalidWebShellContext("JWS claim binding or lifetime")
	}
	return &AttestedExecutionContext{
		Profile: claims.Profile, Authority: claims.Authority, AttestationID: claims.AttestationID,
		ActorID: claims.ActorID, SessionID: claims.SessionID, SessionClass: claims.SessionClass,
		RuntimeAdapterID: claims.RuntimeAdapterID, RuntimeUID: claims.RuntimeUID, Origin: claims.Origin, Audience: audience,
		PermissionRevision: claims.PermissionRevision, AssuranceLevel: claims.AssuranceLevel,
		ReleaseEvidenceRef: claims.ReleaseEvidenceRef, Generation: claims.Generation,
		FencingEpoch: claims.FencingEpoch, KeyID: keyID,
	}, nil
}

func loadPinnedWebShellAgentPublicKey() (ed25519.PublicKey, string, error) {
	info, err := os.Lstat(webShellAgentPublicKeyPath)
	if err != nil {
		return nil, "", executionContextUnavailable(err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 {
		return nil, "", invalidWebShellContext("credential agent public key permissions")
	}
	raw, err := os.ReadFile(webShellAgentPublicKeyPath)
	if err != nil {
		return nil, "", executionContextUnavailable(err)
	}
	block, rest := pem.Decode(raw)
	if block == nil || len(strings.TrimSpace(string(rest))) != 0 || block.Type != "PUBLIC KEY" {
		return nil, "", invalidWebShellContext("credential agent public key PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, "", invalidWebShellContext("credential agent public key")
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return nil, "", invalidWebShellContext("credential agent Ed25519 public key")
	}
	digest := sha256.Sum256(publicKey)
	return publicKey, base64.RawURLEncoding.EncodeToString(digest[:]), nil
}

func singleAudience(raw json.RawMessage) (string, bool) {
	var value string
	if json.Unmarshal(raw, &value) == nil && value != "" {
		return value, true
	}
	var values []string
	if json.Unmarshal(raw, &values) == nil && len(values) == 1 && values[0] != "" {
		return values[0], true
	}
	return "", false
}

func validWebShellOrigin(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && parsed.Path == "" && parsed.RawQuery == "" && parsed.Fragment == ""
}

func invalidWebShellContext(detail string) error {
	return &CLIError{Code: "InvalidExecutionContext", Message: "검증되지 않은 Web Shell 실행 context입니다", Hint: fmt.Sprintf("invalid %s", detail)}
}
