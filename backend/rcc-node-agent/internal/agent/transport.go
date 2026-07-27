// Package agent implements the outbound-only reporting loop.
package agent

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"opensphere.io/rcc/node-agent/internal/config"
	"opensphere.io/rcc/node-agent/internal/protocol"
	"opensphere.io/rcc/node-agent/internal/snapshot"
)

// HeartbeatPath renders the signed request path for a host binding.
func HeartbeatPath(controlCenterID, hostID string) string {
	return "/api/control-centers/" + controlCenterID + "/hosts/" + hostID + "/heartbeat"
}

// ErrRedirectNotPermitted guards against a redirect replaying signed headers to
// a host that the signature was never bound to.
var ErrRedirectNotPermitted = errors.New("redirects are not permitted for signed agent requests")

// ErrPayloadTooLarge means the snapshot exceeded the protocol body bound.
var ErrPayloadTooLarge = errors.New("snapshot payload exceeds the protocol limit")

// Doer is the minimal HTTP surface used by the reporter, injectable in tests.
type Doer interface {
	Do(req *http.Request) (*http.Response, error)
}

// NewHTTPClient builds the outbound-only TLS client.
func NewHTTPClient(cfg *config.Config) (*http.Client, error) {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.CACertificateFile != "" {
		pem, err := os.ReadFile(cfg.CACertificateFile)
		if err != nil {
			return nil, fmt.Errorf("read caCertificateFile: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("caCertificateFile contains no usable certificate")
		}
		tlsConfig.RootCAs = pool
	}
	return &http.Client{
		Timeout: cfg.RequestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return ErrRedirectNotPermitted
		},
		Transport: &http.Transport{
			TLSClientConfig:     tlsConfig,
			DisableKeepAlives:   false,
			MaxIdleConns:        2,
			MaxIdleConnsPerHost: 2,
			IdleConnTimeout:     90 * time.Second,
			ForceAttemptHTTP2:   true,
		},
	}, nil
}

// Reporter signs and delivers snapshots to the control center.
type Reporter struct {
	cfg    *config.Config
	client Doer
	now    func() time.Time
	nonce  func() (string, error)
}

// NewReporter wires a reporter with production defaults.
func NewReporter(cfg *config.Config, client Doer) *Reporter {
	return &Reporter{cfg: cfg, client: client, now: time.Now, nonce: protocol.NewNonce}
}

// Result summarises one delivery attempt for logging and backoff decisions.
type Result struct {
	StatusCode int
	Retryable  bool
}

// Send signs and posts a snapshot. It never emits the secret or a bearer token.
func (r *Reporter) Send(ctx context.Context, snap snapshot.Snapshot) (Result, error) {
	body, err := json.Marshal(snap)
	if err != nil {
		return Result{}, fmt.Errorf("encode snapshot: %w", err)
	}
	if len(body) > protocol.MaxBodyBytes {
		return Result{}, ErrPayloadTooLarge
	}
	nonce, err := r.nonce()
	if err != nil {
		return Result{}, fmt.Errorf("generate nonce: %w", err)
	}

	path := HeartbeatPath(r.cfg.ControlCenterID, r.cfg.HostID)
	signed := protocol.Request{
		Method:          http.MethodPost,
		Path:            path,
		KeyID:           r.cfg.KeyID,
		Timestamp:       strconv.FormatInt(r.now().UTC().Unix(), 10),
		Nonce:           nonce,
		ControlCenterID: r.cfg.ControlCenterID,
		HostID:          r.cfg.HostID,
		BodySHA256:      protocol.BodyDigest(body),
	}
	signature, err := protocol.Sign(r.cfg.Secret, signed)
	if err != nil {
		return Result{}, fmt.Errorf("sign request: %w", err)
	}

	endpoint := r.cfg.ControlCenterURL.String() + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return Result{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json")
	req.Header.Set("user-agent", "rcc-node-agent/"+snap.AgentVersion)
	req.Header.Set(protocol.HeaderKeyID, signed.KeyID)
	req.Header.Set(protocol.HeaderTimestamp, signed.Timestamp)
	req.Header.Set(protocol.HeaderNonce, signed.Nonce)
	req.Header.Set(protocol.HeaderControlCenter, signed.ControlCenterID)
	req.Header.Set(protocol.HeaderHost, signed.HostID)
	req.Header.Set(protocol.HeaderAgentVersion, snap.AgentVersion)
	req.Header.Set(protocol.HeaderSignature, signature)

	res, err := r.client.Do(req)
	if err != nil {
		return Result{Retryable: true}, err
	}
	defer res.Body.Close()
	// Drain a bounded amount so the connection can be reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 8*1024))

	result := Result{StatusCode: res.StatusCode, Retryable: isRetryable(res.StatusCode)}
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return result, nil
	}
	return result, fmt.Errorf("control center rejected heartbeat with status %d", res.StatusCode)
}

// Reachable proves the control center is still reachable over the agent's own
// outbound path.
//
// This is the positive confirmation a network change is kept or rolled back on.
// It deliberately sends no signature and consumes no work: what has to be shown
// is that DNS resolves, the route holds, and a TLS session to *this* control
// center completes. Any HTTP status is success, because an authentication
// refusal is still proof that the control center answered — and TLS validation
// means a captive portal or an interception proxy cannot forge that answer.
func (r *Reporter) Reachable(ctx context.Context) error {
	endpoint := r.cfg.ControlCenterURL.String() + HeartbeatPath(r.cfg.ControlCenterID, r.cfg.HostID)
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, endpoint, nil)
	if err != nil {
		return fmt.Errorf("build reachability request: %w", err)
	}
	req.Header.Set("user-agent", "rcc-node-agent/reachability")
	res, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("the control center is not reachable: %w", err)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4*1024))
	if res.StatusCode >= 500 {
		// The control center is up but broken. That is not proof this host's
		// network is fine, so it does not count as confirmation.
		return fmt.Errorf("the control center answered with status %d", res.StatusCode)
	}
	return nil
}

func isRetryable(status int) bool {
	switch {
	case status == http.StatusRequestTimeout, status == http.StatusTooManyRequests:
		return true
	case status >= 500:
		return true
	default:
		// 401/403/404/409/413/422 are configuration or authority faults; retrying
		// them only produces audit noise until an operator fixes the binding.
		return false
	}
}
