package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var runtimeProxyHTTPClient = &http.Client{
	Timeout:       30 * time.Second,
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
}

var proxyRequestID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

type consoleProxyFailure struct {
	status    int
	code      string
	stage     string
	retryable bool
}

func (failure *consoleProxyFailure) Error() string { return failure.code }

func newConsoleProxyFailure(status int, code, stage string, retryable bool) error {
	return &consoleProxyFailure{status: status, code: code, stage: stage, retryable: retryable}
}

func closedProxyFailureResponse(err error) agentHTTPResponse {
	failure := &consoleProxyFailure{
		status: http.StatusServiceUnavailable, code: "ShellRequestUnavailable",
		stage: "runtime-proxy", retryable: true,
	}
	var classified *consoleProxyFailure
	if errors.As(err, &classified) {
		failure = classified
	}
	body, _ := json.Marshal(map[string]any{
		"code": failure.code, "message": "Web Shell 요청을 현재 완료할 수 없습니다",
		"stage": failure.stage, "retryable": failure.retryable,
	})
	return agentHTTPResponse{
		Status: failure.status, ContentType: "application/json",
		Body: base64.RawStdEncoding.EncodeToString(body),
	}
}

func (server *agentServer) proxyConsoleRequest(ctx context.Context, contextJWS string, input agentHTTPRequest) (agentHTTPResponse, error) {
	var output agentHTTPResponse
	body, parsedPath, err := validateAgentHTTPRequest(input)
	if err != nil {
		return output, newConsoleProxyFailure(http.StatusBadRequest, "ConsoleRequestInvalid", "request-validation", false)
	}
	defer wipe(body)
	if !server.admitProxyRequest(len(body)) {
		return output, newConsoleProxyFailure(http.StatusTooManyRequests, "ConsoleRequestRateLimited", "request-admission", true)
	}
	release, err := server.acquireProxySlot(ctx)
	if err != nil {
		return output, newConsoleProxyFailure(http.StatusServiceUnavailable, "ConsoleRequestUnavailable", "request-admission", true)
	}
	defer release()
	credential, err := server.control.credential(ctx, contextJWS)
	if err != nil {
		var controlFailure *controlHTTPError
		if errors.As(err, &controlFailure) && (controlFailure.status == http.StatusUnauthorized || controlFailure.status == http.StatusForbidden) {
			return output, newConsoleProxyFailure(http.StatusForbidden, "ShellRuntimeAuthorizationRevoked", "credential-exchange", false)
		}
		return output, newConsoleProxyFailure(http.StatusServiceUnavailable, "ShellCredentialUnavailable", "credential-exchange", true)
	}
	token := []byte(credential.AccessToken)
	credential.AccessToken = ""
	defer wipe(token)
	base, err := url.Parse(server.consoleAPIURL)
	if err != nil || base.String() == "" {
		return output, newConsoleProxyFailure(http.StatusServiceUnavailable, "ShellConsoleAPIUnavailable", "console-api", true)
	}
	target := *base
	target.Path, target.RawPath, target.RawQuery = parsedPath.Path, parsedPath.RawPath, parsedPath.RawQuery
	request, err := http.NewRequestWithContext(ctx, input.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		return output, newConsoleProxyFailure(http.StatusBadRequest, "ConsoleRequestInvalid", "request-construction", false)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+string(token))
	request.Header.Set("X-OS-Correlation-ID", input.CorrelationID)
	if input.ContentType != "" {
		request.Header.Set("Content-Type", input.ContentType)
	}
	if input.IdempotencyKey != "" {
		request.Header.Set("X-OS-Idempotency-Key", input.IdempotencyKey)
	}
	response, err := runtimeProxyHTTPClient.Do(request)
	if err != nil {
		return output, newConsoleProxyFailure(http.StatusServiceUnavailable, "ShellConsoleAPIUnavailable", "console-api", true)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxProxyResponse+1))
	if err != nil {
		return output, newConsoleProxyFailure(http.StatusBadGateway, "ShellConsoleAPIResponseInvalid", "console-api", true)
	}
	defer wipe(responseBody)
	if len(responseBody) > maxProxyResponse {
		return output, newConsoleProxyFailure(http.StatusBadGateway, "ShellConsoleAPIResponseInvalid", "console-api", false)
	}
	contentType := response.Header.Get("Content-Type")
	retryAfter := response.Header.Get("Retry-After")
	if len(contentType) > 256 || len(retryAfter) > 128 {
		return output, newConsoleProxyFailure(http.StatusBadGateway, "ShellConsoleAPIResponseInvalid", "console-api", false)
	}
	return agentHTTPResponse{
		Status: response.StatusCode, ContentType: contentType, RetryAfter: retryAfter,
		Body: base64.RawStdEncoding.EncodeToString(responseBody),
	}, nil
}

func validateAgentHTTPRequest(input agentHTTPRequest) ([]byte, *url.URL, error) {
	if input.Method != http.MethodGet && input.Method != http.MethodHead && input.Method != http.MethodPost &&
		input.Method != http.MethodPut && input.Method != http.MethodDelete {
		return nil, nil, errors.New("Console API method is not allowed")
	}
	parsed, err := url.ParseRequestURI(input.Path)
	if err != nil || parsed.Scheme != "" || parsed.Host != "" || parsed.User != nil || parsed.Fragment != "" ||
		!strings.HasPrefix(parsed.Path, "/api/") {
		return nil, nil, errors.New("Console API path is not allowed")
	}
	unescaped, err := url.PathUnescape(parsed.EscapedPath())
	if err != nil {
		return nil, nil, errors.New("Console API path escaping is invalid")
	}
	for _, segment := range strings.Split(unescaped, "/") {
		if segment == "." || segment == ".." {
			return nil, nil, errors.New("Console API path traversal is forbidden")
		}
	}
	if strings.HasPrefix(unescaped, "/api/internal/") || unescaped == "/api/internal" {
		return nil, nil, errors.New("Console internal API paths are forbidden")
	}
	if unescaped == "/api/identity/cli" {
		return nil, nil, errors.New("credential identity root is forbidden")
	}
	if strings.HasPrefix(unescaped, "/api/identity/cli/") &&
		unescaped != "/api/identity/cli/introspect" &&
		unescaped != "/api/identity/cli/devices" &&
		!strings.HasPrefix(unescaped, "/api/identity/cli/devices/") {
		return nil, nil, errors.New("credential-minting identity routes are forbidden")
	}
	if unescaped == "/api/identity/cli/introspect" && input.Method != http.MethodGet {
		return nil, nil, errors.New("identity introspection is GET-only")
	}
	if (unescaped == "/api/identity/cli/devices" || strings.HasPrefix(unescaped, "/api/identity/cli/devices/")) &&
		input.Method != http.MethodGet && input.Method != http.MethodDelete {
		return nil, nil, errors.New("identity device route method is not allowed")
	}
	if !proxyRequestID.MatchString(input.CorrelationID) ||
		(input.Method != http.MethodGet && input.Method != http.MethodHead && !proxyRequestID.MatchString(input.IdempotencyKey)) ||
		((input.Method == http.MethodGet || input.Method == http.MethodHead) && input.IdempotencyKey != "") {
		return nil, nil, errors.New("Console API request identifiers are invalid")
	}
	if input.ContentType != "" && input.ContentType != "application/json" && !strings.HasSuffix(strings.ToLower(input.ContentType), "+json") {
		return nil, nil, errors.New("Console API content type is not allowed")
	}
	body, err := base64.RawStdEncoding.DecodeString(input.Body)
	if err != nil || len(body) > maxProxyBody || ((input.Method == http.MethodGet || input.Method == http.MethodHead) && len(body) != 0) {
		wipe(body)
		return nil, nil, errors.New("Console API request body is invalid")
	}
	return body, parsed, nil
}

func (server *agentServer) admitProxyRequest(bodyBytes int) bool {
	server.proxyOnce.Do(func() {
		server.proxySlots = make(chan struct{}, 4)
		server.proxyWindow = now()
	})
	server.proxyRateMu.Lock()
	defer server.proxyRateMu.Unlock()
	current := now()
	if current.Sub(server.proxyWindow) >= time.Second {
		server.proxyWindow, server.proxyRequests, server.proxyBytes = current, 0, 0
	}
	server.proxyRequests++
	server.proxyBytes += bodyBytes
	return server.proxyRequests <= 20 && server.proxyBytes <= maxProxyBody
}

func (server *agentServer) acquireProxySlot(ctx context.Context) (func(), error) {
	server.proxyOnce.Do(func() {
		server.proxySlots = make(chan struct{}, 4)
		server.proxyWindow = now()
	})
	select {
	case server.proxySlots <- struct{}{}:
		return func() { <-server.proxySlots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
