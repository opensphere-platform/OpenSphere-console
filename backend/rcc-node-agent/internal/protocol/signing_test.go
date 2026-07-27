package protocol

import (
	"strings"
	"testing"
)

func sampleRequest() Request {
	return Request{
		Method:          "POST",
		Path:            "/api/control-centers/cc2/hosts/node-a/heartbeat",
		KeyID:           "cc2-node-a-2026a",
		Timestamp:       "1774483200",
		Nonce:           "0123456789abcdef0123456789abcdef",
		ControlCenterID: "cc2",
		HostID:          "node-a",
		BodySHA256:      BodyDigest([]byte(`{"schemaVersion":"rcc.host.snapshot/v1"}`)),
	}
}

var testSecret = []byte("0123456789abcdef0123456789abcdef")

func TestCanonicalStringIsStableAndOrdered(t *testing.T) {
	got, err := CanonicalString(sampleRequest())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	lines := strings.Split(got, "\n")
	if len(lines) != 9 {
		t.Fatalf("expected 9 canonical lines, got %d", len(lines))
	}
	want := []string{
		"RCC-AGENT-V1",
		"POST",
		"/api/control-centers/cc2/hosts/node-a/heartbeat",
		"cc2-node-a-2026a",
		"1774483200",
		"0123456789abcdef0123456789abcdef",
		"cc2",
		"node-a",
	}
	for i, w := range want {
		if lines[i] != w {
			t.Fatalf("canonical line %d = %q, want %q", i, lines[i], w)
		}
	}
	if !digestRe.MatchString(lines[8]) {
		t.Fatalf("canonical body digest line malformed: %q", lines[8])
	}
}

func TestCanonicalStringFailsClosedOnMalformedFields(t *testing.T) {
	cases := map[string]func(*Request){
		"lowercase method":  func(r *Request) { r.Method = "post" },
		"query in path":     func(r *Request) { r.Path = "/api/hosts?secret=x" },
		"relative path":     func(r *Request) { r.Path = "api/hosts" },
		"newline in path":   func(r *Request) { r.Path = "/api\n/hosts" },
		"short nonce":       func(r *Request) { r.Nonce = "abc" },
		"empty key id":      func(r *Request) { r.KeyID = "" },
		"uppercase host":    func(r *Request) { r.HostID = "Node-A" },
		"uppercase cc":      func(r *Request) { r.ControlCenterID = "CC2" },
		"non numeric ts":    func(r *Request) { r.Timestamp = "not-a-time" },
		"uppercase digest":  func(r *Request) { r.BodySHA256 = strings.ToUpper(r.BodySHA256) },
		"truncated digest":  func(r *Request) { r.BodySHA256 = "abc123" },
		"key id with space": func(r *Request) { r.KeyID = "key id" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := sampleRequest()
			mutate(&r)
			if _, err := CanonicalString(r); err == nil {
				t.Fatalf("expected canonical string to fail closed for %s", name)
			}
		})
	}
}

func TestSignRejectsWeakSecret(t *testing.T) {
	if _, err := Sign([]byte("short"), sampleRequest()); err == nil {
		t.Fatal("expected short secret to be rejected")
	}
}

func TestVerifyAcceptsMatchingSignature(t *testing.T) {
	r := sampleRequest()
	sig, err := Sign(testSecret, r)
	if err != nil {
		t.Fatalf("sign failed: %v", err)
	}
	if !Verify(testSecret, r, sig) {
		t.Fatal("expected signature to verify")
	}
}

func TestVerifyRejectsTamperedFields(t *testing.T) {
	base := sampleRequest()
	sig, err := Sign(testSecret, base)
	if err != nil {
		t.Fatalf("sign failed: %v", err)
	}
	mutations := map[string]func(*Request){
		"method":          func(r *Request) { r.Method = "GET" },
		"path":            func(r *Request) { r.Path = "/api/control-centers/cc2/hosts/node-b/heartbeat" },
		"keyId":           func(r *Request) { r.KeyID = "cc2-node-a-2026b" },
		"timestamp":       func(r *Request) { r.Timestamp = "1774483201" },
		"nonce":           func(r *Request) { r.Nonce = "fedcba9876543210fedcba9876543210" },
		"controlCenterId": func(r *Request) { r.ControlCenterID = "cc3" },
		"hostId":          func(r *Request) { r.HostID = "node-b" },
		"body":            func(r *Request) { r.BodySHA256 = BodyDigest([]byte("{}")) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			r := base
			mutate(&r)
			if Verify(testSecret, r, sig) {
				t.Fatalf("signature must not survive %s mutation", name)
			}
		})
	}
}

func TestVerifyRejectsWrongSecretAndGarbage(t *testing.T) {
	r := sampleRequest()
	sig, err := Sign(testSecret, r)
	if err != nil {
		t.Fatalf("sign failed: %v", err)
	}
	if Verify([]byte("ffffffffffffffffffffffffffffffff"), r, sig) {
		t.Fatal("signature must not verify under a different key")
	}
	if Verify(testSecret, r, "not-base64!!") {
		t.Fatal("garbage signature must not verify")
	}
	if Verify(testSecret, r, "") {
		t.Fatal("empty signature must not verify")
	}
}

func TestNewNonceIsUniqueAndWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		n, err := NewNonce()
		if err != nil {
			t.Fatalf("nonce error: %v", err)
		}
		if !nonceRe.MatchString(n) {
			t.Fatalf("nonce %q does not match contract", n)
		}
		if seen[n] {
			t.Fatalf("duplicate nonce %q", n)
		}
		seen[n] = true
	}
}

// Locks the wire format against the Node verifier fixture.
func TestKnownAnswerSignature(t *testing.T) {
	r := Request{
		Method:          "POST",
		Path:            "/api/control-centers/cc2/hosts/node-a/heartbeat",
		KeyID:           "cc2-node-a-2026a",
		Timestamp:       "1774483200",
		Nonce:           "0123456789abcdef0123456789abcdef",
		ControlCenterID: "cc2",
		HostID:          "node-a",
		BodySHA256:      BodyDigest([]byte("{}")),
	}
	sig, err := Sign(testSecret, r)
	if err != nil {
		t.Fatalf("sign failed: %v", err)
	}
	const want = "gahlzCZgpXSuYq8mz8/dMEdwb806H23+MPKdgokRPNI="
	if sig != want {
		t.Fatalf("known-answer signature drifted: got %q want %q", sig, want)
	}
}
