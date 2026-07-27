// Package protocol defines the RCC agent request signing contract.
//
// The canonical string built here MUST stay byte-identical to the Node
// implementation in backend/opensphere-console-backend/agent-signature.js.
package protocol

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

const (
	// Scheme is the first canonical line. Changing it invalidates every signature.
	Scheme = "RCC-AGENT-V1"

	HeaderKeyID         = "X-RCC-Key-Id"
	HeaderTimestamp     = "X-RCC-Timestamp"
	HeaderNonce         = "X-RCC-Nonce"
	HeaderSignature     = "X-RCC-Signature"
	HeaderControlCenter = "X-RCC-Control-Center"
	HeaderHost          = "X-RCC-Host"
	HeaderAgentVersion  = "X-RCC-Agent-Version"

	// MaxBodyBytes bounds an agent request body. Enforced on both sides.
	MaxBodyBytes = 64 * 1024

	// DefaultSkewSeconds is the replay window half-width.
	DefaultSkewSeconds = 300
)

var (
	keyIDRe     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	nonceRe     = regexp.MustCompile(`^[A-Za-z0-9]{16,64}$`)
	dnsLabelRe  = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	timestampRe = regexp.MustCompile(`^[0-9]{1,12}$`)
	digestRe    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	methodRe    = regexp.MustCompile(`^[A-Z]{3,10}$`)
	pathRe      = regexp.MustCompile(`^/[A-Za-z0-9/._~-]{0,255}$`)
)

// ErrInvalidRequest is returned when any signing field fails validation.
var ErrInvalidRequest = errors.New("invalid signing request")

// Request is the tuple bound by a signature. Every field participates.
type Request struct {
	Method          string
	Path            string
	KeyID           string
	Timestamp       string
	Nonce           string
	ControlCenterID string
	HostID          string
	BodySHA256      string
}

// BodyDigest returns the lowercase hex SHA-256 of the raw request body.
func BodyDigest(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// NewNonce returns a fresh 32-character hex nonce.
func NewNonce() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// CanonicalString renders the signing payload, failing closed on any malformed field.
func CanonicalString(r Request) (string, error) {
	checks := []struct {
		name  string
		value string
		re    *regexp.Regexp
	}{
		{"method", r.Method, methodRe},
		{"path", r.Path, pathRe},
		{"keyId", r.KeyID, keyIDRe},
		{"timestamp", r.Timestamp, timestampRe},
		{"nonce", r.Nonce, nonceRe},
		{"controlCenterId", r.ControlCenterID, dnsLabelRe},
		{"hostId", r.HostID, dnsLabelRe},
		{"bodySha256", r.BodySHA256, digestRe},
	}
	for _, c := range checks {
		if !c.re.MatchString(c.value) {
			return "", fmt.Errorf("%w: %s", ErrInvalidRequest, c.name)
		}
	}
	return strings.Join([]string{
		Scheme,
		r.Method,
		r.Path,
		r.KeyID,
		r.Timestamp,
		r.Nonce,
		r.ControlCenterID,
		r.HostID,
		r.BodySHA256,
	}, "\n"), nil
}

// Sign returns the standard-base64 HMAC-SHA256 signature for the request.
func Sign(secret []byte, r Request) (string, error) {
	if len(secret) < 32 {
		return "", fmt.Errorf("%w: secret too short", ErrInvalidRequest)
	}
	canonical, err := CanonicalString(r)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(canonical))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil)), nil
}

// Verify performs a constant-time signature comparison. Any error yields false.
func Verify(secret []byte, r Request, signature string) bool {
	expected, err := Sign(secret, r)
	if err != nil {
		return false
	}
	got, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return false
	}
	want, err := base64.StdEncoding.DecodeString(expected)
	if err != nil {
		return false
	}
	return hmac.Equal(want, got)
}
