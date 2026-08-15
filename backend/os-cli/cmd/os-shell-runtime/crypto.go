package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"time"
)

type signingIdentity struct {
	publicKey            ed25519.PublicKey
	privateKey           ed25519.PrivateKey
	keyID                string
	publicPEM            []byte
	tlsCertificate       tls.Certificate
	tlsCertificateSHA256 string
}

func (identity *signingIdentity) close() {
	if identity == nil {
		return
	}
	wipe(identity.privateKey)
	identity.privateKey = nil
	identity.tlsCertificate.PrivateKey = nil
}

func newSigningIdentity(now time.Time) (*signingIdentity, error) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(publicKey)
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return nil, err
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "opensphere-shell-runtime"},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(65 * time.Minute),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"opensphere-shell-runtime"},
	}
	certificateDER, err := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if err != nil {
		return nil, err
	}
	certificateDigest := sha256.Sum256(certificateDER)
	return &signingIdentity{
		publicKey:            publicKey,
		privateKey:           privateKey,
		keyID:                base64.RawURLEncoding.EncodeToString(digest[:]),
		publicPEM:            pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}),
		tlsCertificate:       tls.Certificate{Certificate: [][]byte{certificateDER}, PrivateKey: privateKey},
		tlsCertificateSHA256: "sha256:" + hex.EncodeToString(certificateDigest[:]),
	}, nil
}

type webShellClaims struct {
	Contract           string `json:"contract"`
	Issuer             string `json:"iss"`
	Audience           string `json:"aud"`
	AttestationID      string `json:"jti"`
	Profile            string `json:"profile"`
	ExecutionProfile   string `json:"executionProfile"`
	Authority          string `json:"authority"`
	ActorID            string `json:"actorId"`
	SessionID          string `json:"sessionId"`
	SessionClass       string `json:"sessionClass"`
	RuntimeAdapterID   string `json:"runtimeAdapterId"`
	RuntimeUID         string `json:"runtimeUid"`
	Origin             string `json:"origin"`
	PermissionRevision string `json:"permissionRevision"`
	AssuranceLevel     string `json:"aal"`
	ReleaseEvidenceRef string `json:"releaseEvidenceRef"`
	Generation         int64  `json:"generation"`
	FencingEpoch       int64  `json:"fencingEpoch"`
	IssuedAt           int64  `json:"iat"`
	NotBefore          int64  `json:"nbf"`
	ExpiresAt          int64  `json:"exp"`
	Nonce              string `json:"nonce,omitempty"`
}

func (identity *signingIdentity) signContext(binding runtimeBinding, audience, nonce string, now time.Time) (string, error) {
	identifier := make([]byte, 24)
	if _, err := rand.Read(identifier); err != nil {
		return "", err
	}
	header := map[string]string{"alg": "EdDSA", "typ": "JWT", "kid": identity.keyID}
	claims := webShellClaims{
		Contract: contextContract, Issuer: "opensphere-shell-credential-agent", Audience: audience,
		AttestationID: base64.RawURLEncoding.EncodeToString(identifier),
		Profile:       "web-shell", ExecutionProfile: "web-shell", Authority: "delegated-credential-agent",
		ActorID: binding.ActorID, SessionID: binding.SessionID, SessionClass: binding.SessionClass,
		RuntimeAdapterID: binding.RuntimeAdapterID, RuntimeUID: binding.RuntimeUID, Origin: binding.Origin,
		PermissionRevision: binding.PermissionRevision, AssuranceLevel: binding.AssuranceLevel,
		ReleaseEvidenceRef: binding.ReleaseEvidenceRef, Generation: binding.Generation,
		FencingEpoch: binding.FencingEpoch, IssuedAt: now.Unix(), NotBefore: now.Add(-time.Second).Unix(),
		ExpiresAt: now.Add(time.Minute).Unix(), Nonce: nonce,
	}
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encodedHeader := base64.RawURLEncoding.EncodeToString(headerJSON)
	encodedClaims := base64.RawURLEncoding.EncodeToString(claimsJSON)
	signingInput := encodedHeader + "." + encodedClaims
	signature := ed25519.Sign(identity.privateKey, []byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func verifyInternalContext(compact string, publicKey ed25519.PublicKey, expectedKeyID string, binding runtimeBinding, nonce string, now time.Time) error {
	parts := splitCompactJWS(compact)
	if parts == nil {
		return fmt.Errorf("invalid compact JWS")
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return fmt.Errorf("invalid JWS header")
	}
	var header map[string]string
	if json.Unmarshal(headerBytes, &header) != nil || header["alg"] != "EdDSA" || header["typ"] != "JWT" || header["kid"] != expectedKeyID {
		return fmt.Errorf("invalid JWS protected header")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(publicKey, []byte(parts[0]+"."+parts[1]), signature) {
		return fmt.Errorf("invalid JWS signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return fmt.Errorf("invalid JWS payload")
	}
	var claims webShellClaims
	if json.Unmarshal(payload, &claims) != nil {
		return fmt.Errorf("invalid JWS claims")
	}
	if claims.Contract != contextContract || claims.Issuer != "opensphere-shell-credential-agent" || claims.Audience != internalPTYAudience ||
		claims.Profile != "web-shell" || claims.ExecutionProfile != "web-shell" || claims.Authority != "delegated-credential-agent" ||
		claims.SessionID != binding.SessionID || claims.ActorID != binding.ActorID || claims.Origin != binding.Origin ||
		claims.SessionClass != binding.SessionClass || claims.RuntimeAdapterID != binding.RuntimeAdapterID ||
		claims.RuntimeUID != binding.RuntimeUID || claims.PermissionRevision != binding.PermissionRevision ||
		claims.AssuranceLevel != binding.AssuranceLevel || claims.ReleaseEvidenceRef != binding.ReleaseEvidenceRef ||
		claims.Generation != binding.Generation || claims.FencingEpoch != binding.FencingEpoch || claims.Nonce != nonce ||
		claims.IssuedAt > now.Add(5*time.Second).Unix() || claims.IssuedAt < now.Add(-60*time.Second).Unix() ||
		claims.NotBefore > now.Add(5*time.Second).Unix() || claims.ExpiresAt <= now.Unix() || claims.ExpiresAt > now.Add(2*time.Minute).Unix() {
		return fmt.Errorf("JWS does not match the current runtime binding")
	}
	return nil
}

func splitCompactJWS(compact string) []string {
	var result [3]string
	start := 0
	for i := 0; i < 2; i++ {
		index := -1
		for j := start; j < len(compact); j++ {
			if compact[j] == '.' {
				index = j
				break
			}
		}
		if index < 0 {
			return nil
		}
		result[i] = compact[start:index]
		start = index + 1
	}
	result[2] = compact[start:]
	if result[0] == "" || result[1] == "" || result[2] == "" {
		return nil
	}
	return result[:]
}
