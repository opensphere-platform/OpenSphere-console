package protocol

import (
	"strings"
	"testing"
	"time"
)

var respNow = time.Unix(1785000000, 0).UTC()

func binding() ResponseBinding {
	return ResponseBinding{
		KeyID:           "cc2-node-a-2026a",
		ControlCenterID: "cc2",
		HostID:          "node-a",
		OperationID:     "2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f",
		Attempt:         1,
		IssuedAt:        "1785000000",
		Nonce:           "abcdef0123456789abcdef0123456789",
		BodySHA256:      BodyDigest([]byte(`{"a":1}`)),
	}
}

var respSecret = []byte("0123456789abcdef0123456789abcdef")

func TestValidResponseSignatureVerifies(t *testing.T) {
	b := binding()
	signature, err := SignResponse(respSecret, b)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyResponse(respSecret, b, signature, respNow); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
}

func TestMissingSignatureIsRefused(t *testing.T) {
	if err := VerifyResponse(respSecret, binding(), "", respNow); err == nil {
		t.Fatal("an unsigned plan response must be refused")
	}
}

// Every field is part of the binding, so changing any one must invalidate it.
func TestEveryBoundFieldInvalidatesTheSignature(t *testing.T) {
	original := binding()
	signature, err := SignResponse(respSecret, original)
	if err != nil {
		t.Fatal(err)
	}
	mutations := map[string]func(*ResponseBinding){
		"key id":         func(b *ResponseBinding) { b.KeyID = "cc2-node-b-2026a" },
		"control center": func(b *ResponseBinding) { b.ControlCenterID = "cc3" },
		"host":           func(b *ResponseBinding) { b.HostID = "node-b" },
		"operation id":   func(b *ResponseBinding) { b.OperationID = "9c4e1a2b-3d5f-4a6b-8c7d-0e1f2a3b4c5d" },
		"attempt":        func(b *ResponseBinding) { b.Attempt = 2 },
		"issued at":      func(b *ResponseBinding) { b.IssuedAt = "1785000001" },
		"nonce":          func(b *ResponseBinding) { b.Nonce = "00000000000000000000000000000000" },
		"body":           func(b *ResponseBinding) { b.BodySHA256 = BodyDigest([]byte(`{"a":2}`)) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			mutated := original
			mutate(&mutated)
			if err := VerifyResponse(respSecret, mutated, signature, respNow); err == nil {
				t.Fatalf("changing the %s must invalidate the signature", name)
			}
		})
	}
}

func TestWrongKeyIsRefused(t *testing.T) {
	signature, err := SignResponse(respSecret, binding())
	if err != nil {
		t.Fatal(err)
	}
	other := []byte("fedcba9876543210fedcba9876543210")
	if err := VerifyResponse(other, binding(), signature, respNow); err == nil {
		t.Fatal("a signature made with another key must be refused")
	}
}

func TestStaleAndFutureResponsesAreRefused(t *testing.T) {
	b := binding()
	signature, err := SignResponse(respSecret, b)
	if err != nil {
		t.Fatal(err)
	}
	stale := respNow.Add(time.Duration(MaxResponseAgeSeconds+10) * time.Second)
	if err := VerifyResponse(respSecret, b, signature, stale); err == nil {
		t.Fatal("a stale plan response must be refused")
	}
	future := respNow.Add(-time.Duration(DefaultSkewSeconds+60) * time.Second)
	if err := VerifyResponse(respSecret, b, signature, future); err == nil {
		t.Fatal("a plan response from the future must be refused")
	}
}

func TestMalformedSignatureNeverPanics(t *testing.T) {
	for _, presented := range []string{"not base64!!", "AAAA", strings.Repeat("A", 5000), "="} {
		if err := VerifyResponse(respSecret, binding(), presented, respNow); err == nil {
			t.Fatalf("%q must be refused", presented[:min(len(presented), 12)])
		}
	}
}

func TestMalformedBindingIsRefusedRatherThanSigned(t *testing.T) {
	for name, mutate := range map[string]func(*ResponseBinding){
		"bad host":      func(b *ResponseBinding) { b.HostID = "NODE-A" },
		"bad uuid":      func(b *ResponseBinding) { b.OperationID = "nope" },
		"bad nonce":     func(b *ResponseBinding) { b.Nonce = "short" },
		"bad digest":    func(b *ResponseBinding) { b.BodySHA256 = "xyz" },
		"attempt zero":  func(b *ResponseBinding) { b.Attempt = 0 },
		"attempt huge":  func(b *ResponseBinding) { b.Attempt = 1000 },
		"bad issued at": func(b *ResponseBinding) { b.IssuedAt = "later" },
	} {
		t.Run(name, func(t *testing.T) {
			b := binding()
			mutate(&b)
			if _, err := SignResponse(respSecret, b); err == nil {
				t.Fatalf("%s must not be signable", name)
			}
		})
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
