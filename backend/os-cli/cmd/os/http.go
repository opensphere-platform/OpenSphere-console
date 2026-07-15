package main

import (
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

func validateURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return fmt.Errorf("허용되지 않은 URL: %q", raw)
	}
	if u.Scheme == "http" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
		return fmt.Errorf("원격 endpoint는 HTTPS가 필요합니다: %q", raw)
	}
	return nil
}

func client(caBundle string) (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if caBundle != "" {
		pem, err := os.ReadFile(caBundle)
		if err != nil {
			return nil, fmt.Errorf("CA bundle 읽기 실패 %q: %w", caBundle, err)
		}
		roots, err := x509.SystemCertPool()
		if err != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("CA bundle %q에 유효한 PEM 인증서가 없습니다", caBundle)
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: roots}
	}
	if os.Getenv("OS_INSECURE_SKIP_TLS_VERIFY") == "1" {
		if transport.TLSClientConfig == nil {
			transport.TLSClientConfig = &tls.Config{}
		}
		transport.TLSClientConfig.InsecureSkipVerify = true // #nosec G402: explicit local-development opt-in only.
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: transport}, nil
}

func request(cfg Config, method, rawURL string, body io.Reader, contentType string) ([]byte, int, error) {
	b, status, _, err := requestWithContentType(cfg, method, rawURL, body, contentType)
	return b, status, err
}

func requestWithContentType(cfg Config, method, rawURL string, body io.Reader, contentType string) ([]byte, int, string, error) {
	accessToken, err := credentialToken(cfg)
	if err != nil {
		var typed *exitError
		if errors.As(err, &typed) {
			return nil, 0, "", err
		}
		return nil, 0, "", cliError(exitAuth, err.Error(), err)
	}
	return rawRequestCA(method, rawURL, body, contentType, accessToken, cfg.IDToken, cfg.CABundle)
}

func rawRequest(method, rawURL string, body io.Reader, contentType, accessToken, idToken string) ([]byte, int, string, error) {
	return rawRequestCA(method, rawURL, body, contentType, accessToken, idToken, strings.TrimSpace(os.Getenv("OS_CACERT")))
}

func rawRequestCA(method, rawURL string, body io.Reader, contentType, accessToken, idToken, caBundle string) ([]byte, int, string, error) {
	if err := validateURL(rawURL); err != nil {
		return nil, 0, "", err
	}
	req, err := http.NewRequest(method, rawURL, body)
	if err != nil {
		return nil, 0, "", err
	}
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	if idToken != "" {
		req.Header.Set("X-OS-Id-Token", idToken)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-OS-Correlation-ID", operationID())
	httpClient, err := client(caBundle)
	if err != nil {
		return nil, 0, "", cliError(exitNetwork, err.Error(), err)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		var unknownAuthority x509.UnknownAuthorityError
		var certificateInvalid x509.CertificateInvalidError
		var hostnameError x509.HostnameError
		if errors.As(err, &unknownAuthority) || errors.As(err, &certificateInvalid) || errors.As(err, &hostnameError) || strings.Contains(strings.ToLower(err.Error()), "certificate signed by unknown authority") {
			message := fmt.Sprintf("TLS 인증서를 신뢰할 수 없습니다; --ca-bundle <file> 또는 os setup ca <file>로 CA를 설정하세요: %v", err)
			return nil, 0, "", cliError(exitNetwork, message, err)
		}
		message := fmt.Sprintf("서버에 연결할 수 없습니다: %v", err)
		return nil, 0, "", cliError(exitNetwork, message, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		message := fmt.Sprintf("서버 응답을 읽을 수 없습니다: %v", err)
		return b, resp.StatusCode, resp.Header.Get("Content-Type"), cliError(exitNetwork, message, err)
	}
	if err == nil && (resp.StatusCode < 200 || resp.StatusCode >= 300) {
		err = statusError(b, resp.StatusCode, resp.Header.Get("X-OS-Correlation-Id"))
	}
	return b, resp.StatusCode, resp.Header.Get("Content-Type"), err
}

func statusError(b []byte, status int, correlationID string) error {
	msg := strings.TrimSpace(string(b))
	if len(msg) > 500 {
		msg = msg[:500]
	}
	invalidSession := strings.Contains(strings.ToLower(msg), "invalid-session") || strings.Contains(strings.ToLower(msg), "invalid session")
	switch {
	case status == http.StatusUnauthorized || invalidSession:
		msg = "인증 또는 세션이 유효하지 않습니다; os login을 실행하세요"
	case status == http.StatusForbidden:
		msg = "요청을 수행할 권한이 부족합니다"
	case status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout:
		msg = "OpenSphere 백엔드를 사용할 수 없습니다; 잠시 후 다시 시도하세요"
	}
	if correlationID != "" {
		msg += " (correlation ID: " + correlationID + ")"
	}
	code := exitServer
	if status == http.StatusUnauthorized || invalidSession {
		code = exitAuth
	}
	return &exitError{code: code, message: fmt.Sprintf("HTTP %d: %s", status, msg), correlationID: correlationID}
}

func operationID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("os-%d", time.Now().UnixNano())
	}
	return "os-" + hex.EncodeToString(b)
}

func join(base, path string) string {
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}

func requireOK(b []byte, status int) error {
	if status >= 200 && status < 300 {
		return nil
	}
	return statusError(b, status, "")
}
