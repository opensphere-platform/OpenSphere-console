package protocol

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"regexp"
	"strconv"
	"time"
)

// Response signing.
//
// The agent already proves who it is to the control center. Nothing proved the
// reverse: TLS authenticates the *server name*, but a plan is an instruction to
// change a production host, and it should be verifiable independently of the
// transport. Anyone who can terminate TLS — a mis-issued certificate, a
// terminating proxy, a compromised ingress — could otherwise inject a plan.
//
// So the plan body is signed with the same host-bound key. The signature binds
// the body digest, the key id, the control center, the host, the operation id,
// the attempt, an issue time and a nonce, so a captured plan cannot be replayed
// against a different host, a different attempt, or later in time.
//
// This is defence in depth, not a replacement: HTTPS is still required and the
// agent still refuses plaintext.
const (
	ResponseScheme = "RCC-PLAN-V1"

	HeaderResponseKeyID     = "X-RCC-Response-Key-Id"
	HeaderResponseNonce     = "X-RCC-Response-Nonce"
	HeaderResponseIssuedAt  = "X-RCC-Response-Issued-At"
	HeaderResponseSignature = "X-RCC-Response-Signature"

	// Plans are consumed immediately; a wide window would only widen replay.
	MaxResponseAgeSeconds = 120

	// minResponseSecretBytes mirrors the request-signing floor.
	minResponseSecretBytes = 32
)

var (
	responseNonceRe = regexp.MustCompile(`^[A-Za-z0-9]{16,64}$`)
	uuidRe          = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// ResponseBinding is everything a signed plan response commits to.
type ResponseBinding struct {
	KeyID           string
	ControlCenterID string
	HostID          string
	OperationID     string
	Attempt         int
	IssuedAt        string // unix seconds, as sent
	Nonce           string
	BodySHA256      string
}

// CanonicalResponseString builds the signing payload, rejecting any malformed
// field rather than signing or verifying something ambiguous.
func CanonicalResponseString(b ResponseBinding) (string, error) {
	checks := []struct {
		name  string
		value string
		re    *regexp.Regexp
	}{
		{"keyId", b.KeyID, keyIDRe},
		{"controlCenterId", b.ControlCenterID, dnsLabelRe},
		{"hostId", b.HostID, dnsLabelRe},
		{"operationId", b.OperationID, uuidRe},
		{"issuedAt", b.IssuedAt, timestampRe},
		{"nonce", b.Nonce, responseNonceRe},
		{"bodySha256", b.BodySHA256, digestRe},
	}
	for _, check := range checks {
		if !check.re.MatchString(check.value) {
			return "", fmt.Errorf("invalid plan response field: %s", check.name)
		}
	}
	if b.Attempt < 1 || b.Attempt > 100 {
		return "", fmt.Errorf("invalid plan response field: attempt")
	}
	return ResponseScheme + "\n" +
		b.KeyID + "\n" +
		b.ControlCenterID + "\n" +
		b.HostID + "\n" +
		b.OperationID + "\n" +
		strconv.Itoa(b.Attempt) + "\n" +
		b.IssuedAt + "\n" +
		b.Nonce + "\n" +
		b.BodySHA256, nil
}

// SignResponse produces the standard-base64 HMAC of the canonical string.
func SignResponse(secret []byte, b ResponseBinding) (string, error) {
	if len(secret) < minResponseSecretBytes {
		return "", fmt.Errorf("response signing key is too short")
	}
	canonical, err := CanonicalResponseString(b)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(canonical))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil)), nil
}

// VerifyResponse checks the signature in constant time and enforces freshness.
//
// It never reports *why* a signature failed beyond the category, so a caller
// cannot use it as an oracle.
func VerifyResponse(secret []byte, b ResponseBinding, presented string, now time.Time) error {
	if presented == "" {
		return fmt.Errorf("plan response is not signed")
	}
	expected, err := SignResponse(secret, b)
	if err != nil {
		return fmt.Errorf("plan response binding is malformed: %w", err)
	}
	left, err := base64.StdEncoding.DecodeString(expected)
	if err != nil {
		return fmt.Errorf("plan response signature is unusable")
	}
	right, err := base64.StdEncoding.DecodeString(presented)
	if err != nil {
		return fmt.Errorf("plan response signature is not base64")
	}
	if len(left) != len(right) || !hmac.Equal(left, right) {
		return fmt.Errorf("plan response signature does not verify")
	}

	issued, err := strconv.ParseInt(b.IssuedAt, 10, 64)
	if err != nil {
		return fmt.Errorf("plan response issue time is malformed")
	}
	age := now.Unix() - issued
	if age > MaxResponseAgeSeconds {
		return fmt.Errorf("plan response is %d seconds old, above the %d second limit", age, MaxResponseAgeSeconds)
	}
	if age < -int64(DefaultSkewSeconds) {
		return fmt.Errorf("plan response was issued in the future")
	}
	return nil
}
