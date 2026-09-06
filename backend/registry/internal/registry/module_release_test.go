package registry

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestOfficialModuleAdmission(t *testing.T) {
	now := time.Now().UTC()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	keys := map[string]string{"test": base64.StdEncoding.EncodeToString(der)}
	spec := map[string]interface{}{"hostRef": "main", "permissionProfile": "cluster-read", "trust": map[string]interface{}{"keyId": "test"}}
	seal := func(expires time.Time) string {
		bytes, _ := json.Marshal(map[string]interface{}{"schema": "opensphere.module-release/v1", "id": "cluster-manager", "channel": "edge", "issuedAt": now, "expiresAt": expires, "spec": spec})
		hash := sha256.Sum256(bytes)
		r, s, _ := ecdsa.Sign(rand.Reader, key, hash[:])
		sig := append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
		raw, _ := json.Marshal(map[string]string{"schema": "opensphere.module-release-envelope/v1", "keyId": "test", "payload": base64.StdEncoding.EncodeToString(bytes), "signature": base64.StdEncoding.EncodeToString(sig)})
		return string(raw)
	}
	pkg := unstructured.Unstructured{Object: map[string]interface{}{"spec": spec}}
	pkg.SetName("cluster-manager")
	pkg.SetLabels(map[string]string{"app.kubernetes.io/managed-by": "opensphere-module-discovery"})
	pkg.SetAnnotations(map[string]string{"opensphere.io/discovery-state": "Verified", "opensphere.io/module-release": seal(now.Add(time.Hour))})
	if err := verifyOfficialModule(pkg, keys, now); err != nil {
		t.Fatal(err)
	}
	if verifyOfficialModule(pkg, map[string]string{}, now) == nil {
		t.Fatal("untrusted key admitted")
	}
	drift := pkg.DeepCopy()
	drift.Object["spec"].(map[string]interface{})["permissionProfile"] = "admin"
	if verifyOfficialModule(*drift, keys, now) == nil {
		t.Fatal("privilege substitution admitted")
	}
	drift = pkg.DeepCopy()
	drift.SetAnnotations(map[string]string{"opensphere.io/discovery-state": "ModuleCatalogUnavailable", "opensphere.io/module-release": seal(now.Add(time.Hour))})
	if verifyOfficialModule(*drift, keys, now) == nil {
		t.Fatal("unavailable discovery admitted")
	}
	if verifyOfficialModule(pkg, keys, now.Add(2*time.Hour)) == nil {
		t.Fatal("expired signature admitted")
	}
	for _, profile := range []string{"cluster-read", "cluster-infrastructure-manager-v1", "cluster-admin"} {
		spec["permissionProfile"] = profile
		pkg.SetAnnotations(map[string]string{"opensphere.io/discovery-state": "Verified", "opensphere.io/module-release": seal(now.Add(time.Hour))})
		err := verifyOfficialModule(pkg, keys, now)
		if (profile != "cluster-admin") != (err == nil) {
			t.Fatalf("signed profile %s admitted incorrectly: %v", profile, err)
		}
	}
	spec["permissionProfile"] = "cluster-infrastructure-manager-v1"
	pkg.SetAnnotations(map[string]string{"opensphere.io/discovery-state": "Verified", "opensphere.io/module-release": seal(now.Add(time.Hour))})
	drift = pkg.DeepCopy()
	drift.SetName("another-module")
	if _, rejected := installableExtensionFromPackage(*drift, keys); rejected == nil || rejected.Code != "ModuleReleaseInvalid" {
		t.Fatal("infrastructure profile escaped the official Cluster Manager signature boundary")
	}
	drift = pkg.DeepCopy()
	drift.Object["spec"].(map[string]interface{})["permissionProfile"] = "cluster-read"
	if verifyOfficialModule(*drift, keys, now) == nil {
		t.Fatal("signed infrastructure profile was silently downgraded")
	}
}
