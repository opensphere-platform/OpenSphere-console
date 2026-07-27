package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"opensphere.io/rcc/node-agent/internal/config"
	"opensphere.io/rcc/node-agent/internal/plan"
	"opensphere.io/rcc/node-agent/internal/protocol"
)

// Operation endpoint paths. All are outbound POSTs from the agent; the host
// never listens, so there is no inbound port to protect.
func operationsPollPath(controlCenterID, hostID string) string {
	return "/api/control-centers/" + controlCenterID + "/hosts/" + hostID + "/operations/poll"
}

func operationsStartPath(controlCenterID, hostID string) string {
	return "/api/control-centers/" + controlCenterID + "/hosts/" + hostID + "/operations/start"
}

func operationsReceiptPath(controlCenterID, hostID string) string {
	return "/api/control-centers/" + controlCenterID + "/hosts/" + hostID + "/operations/receipt"
}

// HTTPPlanSource implements PlanSource over the signed outbound channel.
type HTTPPlanSource struct {
	cfg          *config.Config
	client       Doer
	agentVersion string
	now          func() time.Time
	nonce        func() (string, error)
	nonces       *nonceWindow
	// WaitSeconds asks the control center to hold the poll open. Zero disables
	// long polling.
	WaitSeconds int
}

// NewPlanSource builds the operation transport from the same config and client
// as the heartbeat reporter, so both share TLS, timeouts and key material.
func NewPlanSource(cfg *config.Config, client Doer, agentVersion string) *HTTPPlanSource {
	return &HTTPPlanSource{
		cfg:          cfg,
		client:       client,
		agentVersion: agentVersion,
		now:          time.Now,
		nonce:        protocol.NewNonce,
		nonces:       newNonceWindow(),
	}
}

// post signs and sends one outbound request, returning the bounded body.
func (s *HTTPPlanSource) post(ctx context.Context, path string, payload []byte, maxResponse int) (int, []byte, http.Header, error) {
	if len(payload) > protocol.MaxBodyBytes {
		return 0, nil, nil, fmt.Errorf("payload exceeds %d bytes", protocol.MaxBodyBytes)
	}
	timestamp := s.now().UTC().Unix()
	nonce, err := s.nonce()
	if err != nil {
		return 0, nil, nil, err
	}
	request := protocol.Request{
		Method:          http.MethodPost,
		Path:            path,
		KeyID:           s.cfg.KeyID,
		Timestamp:       fmt.Sprintf("%d", timestamp),
		Nonce:           nonce,
		ControlCenterID: s.cfg.ControlCenterID,
		HostID:          s.cfg.HostID,
		BodySHA256:      protocol.BodyDigest(payload),
	}
	signature, err := protocol.Sign(s.cfg.Secret, request)
	if err != nil {
		return 0, nil, nil, err
	}

	endpoint := *s.cfg.ControlCenterURL
	endpoint.Path = path
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return 0, nil, nil, err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("accept", "application/json")
	httpReq.Header.Set(protocol.HeaderKeyID, request.KeyID)
	httpReq.Header.Set(protocol.HeaderTimestamp, request.Timestamp)
	httpReq.Header.Set(protocol.HeaderNonce, request.Nonce)
	httpReq.Header.Set(protocol.HeaderSignature, signature)
	httpReq.Header.Set(protocol.HeaderControlCenter, request.ControlCenterID)
	httpReq.Header.Set(protocol.HeaderHost, request.HostID)
	httpReq.Header.Set(protocol.HeaderAgentVersion, s.agentVersion)

	response, err := s.client.Do(httpReq)
	if err != nil {
		return 0, nil, nil, err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
		_ = response.Body.Close()
	}()
	body, err := io.ReadAll(io.LimitReader(response.Body, int64(maxResponse)+1))
	if err != nil {
		return response.StatusCode, nil, nil, err
	}
	if len(body) > maxResponse {
		return response.StatusCode, nil, nil, fmt.Errorf("response exceeds %d bytes", maxResponse)
	}
	return response.StatusCode, body, response.Header, nil
}

// seenResponseNonces bounds replay memory for signed plan responses. A plan is
// consumed immediately, so the window only needs to cover the freshness bound.
type nonceWindow struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

func newNonceWindow() *nonceWindow { return &nonceWindow{seen: map[string]time.Time{}} }

// claim returns false when this nonce was already accepted inside the window.
func (w *nonceWindow) claim(nonce string, now time.Time) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	cutoff := now.Add(-time.Duration(protocol.MaxResponseAgeSeconds) * time.Second)
	for value, at := range w.seen {
		if at.Before(cutoff) {
			delete(w.seen, value)
		}
	}
	if _, exists := w.seen[nonce]; exists {
		return false
	}
	// Bounded: a hostile server cannot grow agent memory without bound.
	if len(w.seen) >= 4096 {
		return false
	}
	w.seen[nonce] = now
	return true
}

// Poll asks for the next operation. An empty result means nothing to do.
func (s *HTTPPlanSource) Poll(ctx context.Context) ([]byte, error) {
	payload := []byte(fmt.Sprintf(`{"schemaVersion":%q,"waitSeconds":%d}`, plan.SchemaVersion, s.WaitSeconds))
	status, body, header, err := s.post(ctx, operationsPollPath(s.cfg.ControlCenterID, s.cfg.HostID), payload, plan.MaxPlanBytes)
	if err != nil {
		return nil, err
	}
	switch status {
	case http.StatusNoContent:
		return nil, nil
	case http.StatusOK:
		// A plan is an instruction to change this host. Verify the control
		// center signed it with our own host-bound key before parsing it.
		if err := s.verifyPlanResponse(body, header); err != nil {
			return nil, err
		}
		return body, nil
	default:
		return nil, fmt.Errorf("poll rejected with HTTP %d", status)
	}
}

// verifyPlanResponse authenticates the plan body itself.
//
// Failing this is fatal for the poll: an unsigned or mis-signed plan is treated
// exactly like no plan at all, so nothing is claimed or executed.
func (s *HTTPPlanSource) verifyPlanResponse(body []byte, header http.Header) error {
	binding := protocol.ResponseBinding{
		KeyID:           header.Get(protocol.HeaderResponseKeyID),
		ControlCenterID: s.cfg.ControlCenterID,
		HostID:          s.cfg.HostID,
		IssuedAt:        header.Get(protocol.HeaderResponseIssuedAt),
		Nonce:           header.Get(protocol.HeaderResponseNonce),
		BodySHA256:      protocol.BodyDigest(body),
	}
	// The operation id and attempt come from the body, so the signature binds
	// the plan to exactly the work it describes.
	var envelope struct {
		OperationID string `json:"operationId"`
		Attempt     int    `json:"attempt"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return fmt.Errorf("plan response is not decodable: %w", err)
	}
	binding.OperationID = envelope.OperationID
	binding.Attempt = envelope.Attempt

	// Key rotation: the response must be signed with the key this agent holds.
	if binding.KeyID != s.cfg.KeyID {
		return fmt.Errorf("plan response was signed with key %q, not this host's key", binding.KeyID)
	}
	if err := protocol.VerifyResponse(s.cfg.Secret, binding, header.Get(protocol.HeaderResponseSignature), s.now()); err != nil {
		return err
	}
	if !s.nonces.claim(binding.Nonce, s.now()) {
		return fmt.Errorf("plan response nonce was already used")
	}
	return nil
}

// Start marks the operation as running. Anything other than 200 means the agent
// must not proceed.
//
// The body restates the whole identity of the work, not just its id, so the
// control center can confirm that the plan this agent holds is the plan it
// believes it issued. A start that only carried an id would be accepted even
// when the agent was about to run something the approval never covered.
func (s *HTTPPlanSource) Start(ctx context.Context, p *plan.Plan) error {
	payload, err := json.Marshal(struct {
		SchemaVersion   string `json:"schemaVersion"`
		OperationID     string `json:"operationId"`
		Attempt         int    `json:"attempt"`
		ControlCenterID string `json:"controlCenterId"`
		HostID          string `json:"hostId"`
		Operation       string `json:"operation"`
		ContentDigest   string `json:"contentDigest"`
	}{
		SchemaVersion:   plan.SchemaVersion,
		OperationID:     p.OperationID,
		Attempt:         p.Attempt,
		ControlCenterID: p.ControlCenterID,
		HostID:          p.HostID,
		Operation:       p.Operation,
		ContentDigest:   p.ContentDigest,
	})
	if err != nil {
		return fmt.Errorf("start payload is not encodable: %w", err)
	}
	status, _, _, err := s.post(ctx, operationsStartPath(s.cfg.ControlCenterID, s.cfg.HostID), payload, 4096)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("start rejected with HTTP %d", status)
	}
	return nil
}

// Receipt submits the immutable result. 200 and 409 are both success: 409 means
// the control center already stored this receipt, which is the idempotent
// answer to a replay.
func (s *HTTPPlanSource) Receipt(ctx context.Context, operationID string, body []byte) error {
	if len(body) > plan.MaxReceiptBytes {
		return errors.New("receipt exceeds the maximum size")
	}
	status, responseBody, _, err := s.post(ctx, operationsReceiptPath(s.cfg.ControlCenterID, s.cfg.HostID), body, 4096)
	if err != nil {
		return err
	}

	var ack struct {
		Accepted        bool   `json:"accepted"`
		AlreadyRecorded bool   `json:"alreadyRecorded"`
		ReceiptDigest   string `json:"receiptDigest"`
		OperationID     string `json:"operationId"`
		Attempt         int    `json:"attempt"`
		Status          string `json:"status"`
	}
	if len(responseBody) > 0 {
		// A malformed acknowledgement is not evidence of anything.
		if err := json.Unmarshal(responseBody, &ack); err != nil {
			return fmt.Errorf("receipt acknowledgement is not decodable: %w", err)
		}
	}

	if status == http.StatusOK {
		if !ack.Accepted {
			return fmt.Errorf("receipt was not acknowledged as accepted")
		}
		return nil
	}

	// A conflict is only success when the server proves it already holds THIS
	// receipt. Treating any 409 as success would let a server that stored a
	// different result silence the agent, and the divergence would never
	// surface. Anything short of an exact match is fatal for this delivery.
	if status == http.StatusConflict {
		if !ack.AlreadyRecorded {
			return fmt.Errorf("receipt conflicted without an already-recorded proof")
		}
		if ack.OperationID != operationID {
			return fmt.Errorf("receipt conflict names operation %q, not %q", ack.OperationID, operationID)
		}
		expected := plan.Digest(body)
		if ack.ReceiptDigest != expected {
			return fmt.Errorf("control center holds a different receipt for %s: it has %s, this agent sent %s",
				operationID, ack.ReceiptDigest, expected)
		}
		return nil
	}
	return fmt.Errorf("receipt rejected with HTTP %d", status)
}
