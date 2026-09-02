package main

import "encoding/json"

const (
	maxControlMessage = 64 << 10
	maxAgentMessage   = 12 << 20
	maxProxyBody      = 1 << 20
	maxProxyResponse  = 8 << 20
	maxPTYFrame       = 72 << 10
	maxPTYData        = 64 << 10
	maxPTYBytesPerSec = 64 << 10
)

type agentRequest struct {
	Contract  string            `json:"contract"`
	Operation string            `json:"operation"`
	Request   *agentHTTPRequest `json:"request,omitempty"`
}

type agentResponse struct {
	Contract   string             `json:"contract"`
	ContextJWS string             `json:"contextJws"`
	Response   *agentHTTPResponse `json:"response,omitempty"`
	Error      string             `json:"error,omitempty"`
}

type agentHTTPRequest struct {
	Method         string `json:"method"`
	Path           string `json:"path"`
	ContentType    string `json:"contentType,omitempty"`
	Body           string `json:"body,omitempty"`
	CorrelationID  string `json:"correlationId"`
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
}

type agentHTTPResponse struct {
	Status      int    `json:"status"`
	ContentType string `json:"contentType,omitempty"`
	RetryAfter  string `json:"retryAfter,omitempty"`
	Body        string `json:"body,omitempty"`
}

type ptyFrame struct {
	Type          string `json:"type"`
	Sequence      uint64 `json:"seq"`
	SessionID     string `json:"sessionId,omitempty"`
	RuntimeUID    string `json:"runtimeUid,omitempty"`
	Generation    int64  `json:"generation,omitempty"`
	FencingEpoch  int64  `json:"fencingEpoch,omitempty"`
	Ticket        string `json:"ticket,omitempty"`
	InternalToken string `json:"internalToken,omitempty"`
	ContextJWS    string `json:"contextJws,omitempty"`
	Nonce         string `json:"nonce,omitempty"`
	Data          string `json:"data,omitempty"`
	Columns       uint16 `json:"columns,omitempty"`
	Rows          uint16 `json:"rows,omitempty"`
	Code          int    `json:"code,omitempty"`
	Message       string `json:"message,omitempty"`
}

type registrationRequest struct {
	Contract              string         `json:"contract"`
	Binding               runtimeBinding `json:"binding"`
	KeyID                 string         `json:"keyId"`
	PublicKeyPEM          string         `json:"publicKeyPem"`
	TLSCertificateSHA256  string         `json:"tlsCertificateSha256"`
	RuntimeCredentialHash string         `json:"runtimeCredentialHash"`
	RuntimeVersion        string         `json:"runtimeVersion"`
	AttachEndpoint        string         `json:"attachEndpoint"`
}

type registrationResponse struct {
	Contract                string         `json:"contract"`
	Binding                 runtimeBinding `json:"binding"`
	RuntimeCredentialHash   string         `json:"runtimeCredentialHash"`
	RuntimeCredentialExpiry string         `json:"runtimeCredentialExpiresAt"`
}

type credentialRequest struct {
	Contract   string `json:"contract"`
	Operation  string `json:"operation"`
	ContextJWS string `json:"contextJws"`
}

type credentialResponse struct {
	Contract       string `json:"contract"`
	AccessToken    string `json:"accessToken"`
	TokenExpiresAt string `json:"tokenExpiresAt"`
}

type attachAuthorizeRequest struct {
	Contract string          `json:"contract"`
	Binding  runtimeBinding  `json:"binding"`
	Attach   json.RawMessage `json:"attach"`
}

type attachAuthorizeResponse struct {
	Contract   string `json:"contract"`
	Authorized bool   `json:"authorized"`
	State      string `json:"state"`
}
