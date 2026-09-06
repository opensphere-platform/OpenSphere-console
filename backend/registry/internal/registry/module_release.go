package registry

import (
	bytespkg "bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Discovery is a signed, expiry-bounded cache. A failed registry observation
// blocks new admission but does not revoke an already verified running module.
func verifyOfficialModule(pkg unstructured.Unstructured, keys map[string]string, now time.Time) error {
	fail := errors.New("official module release is unverified, expired or unavailable")
	if pkg.GetName() != "cluster-manager" || pkg.GetLabels()["app.kubernetes.io/managed-by"] != "opensphere-module-discovery" || pkg.GetAnnotations()["opensphere.io/discovery-state"] != "Verified" {
		return fail
	}
	raw := pkg.GetAnnotations()["opensphere.io/module-release"]
	if len(raw) == 0 || len(raw) > 96*1024 {
		return fail
	}
	var envelope struct {
		Schema    string
		KeyID     string
		Payload   string
		Signature string
	}
	if json.Unmarshal([]byte(raw), &envelope) != nil || envelope.Schema != "opensphere.module-release-envelope/v1" {
		return fail
	}
	bytes, err := base64.StdEncoding.DecodeString(envelope.Payload)
	if err != nil {
		return fail
	}
	signature, err := base64.StdEncoding.DecodeString(envelope.Signature)
	if err != nil || len(signature) != 64 {
		return fail
	}
	der, err := base64.StdEncoding.DecodeString(keys[envelope.KeyID])
	if err != nil {
		return fail
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return fail
	}
	key, ok := parsed.(*ecdsa.PublicKey)
	if !ok || key.Curve != elliptic.P256() {
		return fail
	}
	hash := sha256.Sum256(bytes)
	if !ecdsa.Verify(key, hash[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) {
		return fail
	}
	var release struct {
		Schema    string
		ID        string
		Channel   string
		IssuedAt  time.Time
		ExpiresAt time.Time
		Spec      map[string]interface{}
	}
	if json.Unmarshal(bytes, &release) != nil || release.Schema != "opensphere.module-release/v1" || release.ID != "cluster-manager" || release.Channel != "edge" || release.IssuedAt.After(now.Add(time.Minute)) || !release.ExpiresAt.After(now) || !release.ExpiresAt.After(release.IssuedAt) || release.ExpiresAt.Sub(release.IssuedAt) > 90*24*time.Hour {
		return fail
	}
	signedSpec, _ := json.Marshal(release.Spec)
	actualSpec, _ := json.Marshal(nestedMap(pkg.Object, "spec"))
	// CON-FR-007: same closed profile set as C_EXT. This admits only metadata
	// signed for the official Cluster Manager; it does not grant Kubernetes RBAC.
	profile := nestedString(pkg.Object, "spec", "permissionProfile")
	if !bytespkg.Equal(signedSpec, actualSpec) || nestedString(pkg.Object, "spec", "trust", "keyId") != envelope.KeyID || (profile != "cluster-read" && profile != "cluster-infrastructure-manager-v1") || nestedString(pkg.Object, "spec", "hostRef") != "main" {
		return fail
	}
	return nil
}
