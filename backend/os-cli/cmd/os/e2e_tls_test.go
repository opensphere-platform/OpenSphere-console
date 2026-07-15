package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type e2ePKI struct {
	root *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
}

func newE2EPKI(t *testing.T, name string) *e2ePKI {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: e2eSerial(t), Subject: pkix.Name{CommonName: name},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
		BasicConstraintsValid: true, IsCA: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &e2ePKI{cert, key, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

func (p *e2ePKI) mintLeaf(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: e2eSerial(t), Subject: pkix.Name{CommonName: "localhost"},
		DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(12 * time.Hour),
		BasicConstraintsValid: true, IsCA: false,
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, p.root, &key.PublicKey, p.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func e2eSerial(t *testing.T) *big.Int {
	t.Helper()
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func startE2ETLS(t *testing.T, cert tls.Certificate, requests *int) *httptest.Server {
	t.Helper()
	s := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/registry" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer real-tls-test-pat" {
			t.Errorf("Authorization header = %q", got)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		*requests = *requests + 1
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"capabilities":[],"plugins":[],"templates":[],"tls":"verified"}`))
	}))
	s.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	s.StartTLS()
	t.Cleanup(s.Close)
	return s
}

func runE2ERegistry(t *testing.T, serverURL, caBundle string) (string, error) {
	t.Helper()
	t.Setenv("OS_PAT", "real-tls-test-pat")
	t.Setenv("OS_CONFIG", filepath.Join(t.TempDir(), "config.json"))
	t.Setenv("OS_CONSOLE", serverURL)
	t.Setenv("OS_BFF", serverURL)
	t.Setenv("OS_API", serverURL+"/api/proxy")
	t.Setenv("OS_REGISTRY", serverURL+"/api/v1/registry")
	t.Setenv("OS_CACERT", "")
	unsetE2EEnv(t, "OS_INSECURE_SKIP_TLS_VERIFY")
	args := []string{"registry", "-o", "json"}
	if caBundle != "" {
		args = append(args, "--ca-bundle", caBundle)
	}
	var out bytes.Buffer
	err := run(args, strings.NewReader(""), &out, &bytes.Buffer{})
	return out.String(), err
}

func unsetE2EEnv(t *testing.T, name string) {
	t.Helper()
	old, existed := os.LookupEnv(name)
	if err := os.Unsetenv(name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv(name, old)
		} else {
			_ = os.Unsetenv(name)
		}
	})
}

func TestRealTLSCABundleTrustAndLeafRotation(t *testing.T) {
	trusted := newE2EPKI(t, "OpenSphere Installation CA")
	caPath := filepath.Join(t.TempDir(), "installation-ca.pem")
	if err := os.WriteFile(caPath, trusted.pem, 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("trusted installation CA succeeds", func(t *testing.T) {
		requests := 0
		server := startE2ETLS(t, trusted.mintLeaf(t), &requests)
		out, err := runE2ERegistry(t, server.URL, caPath)
		if err != nil {
			t.Fatalf("registry over trusted TLS failed: %v", err)
		}
		var response map[string]any
		if err := json.Unmarshal([]byte(out), &response); err != nil {
			t.Fatalf("registry output is not JSON: %v; output=%q", err, out)
		}
		if response["tls"] != "verified" || requests != 1 {
			t.Fatalf("real TLS round-trip was not observed: response=%v requests=%d", response, requests)
		}
	})

	t.Run("same CA survives leaf rotation", func(t *testing.T) {
		requests := 0
		server := startE2ETLS(t, trusted.mintLeaf(t), &requests)
		out, err := runE2ERegistry(t, server.URL, caPath)
		if err != nil {
			t.Fatalf("registry with rotated leaf failed: %v", err)
		}
		if !strings.Contains(out, `"tls": "verified"`) || requests != 1 {
			t.Fatalf("rotated-leaf round-trip was not observed: output=%q requests=%d", out, requests)
		}
	})

	t.Run("unrelated CA is rejected", func(t *testing.T) {
		untrusted := newE2EPKI(t, "Unrelated Test CA")
		requests := 0
		server := startE2ETLS(t, untrusted.mintLeaf(t), &requests)
		_, err := runE2ERegistry(t, server.URL, caPath)
		assertE2ETrustFailure(t, err, requests)
	})

	t.Run("no CA bundle is rejected", func(t *testing.T) {
		requests := 0
		server := startE2ETLS(t, trusted.mintLeaf(t), &requests)
		_, err := runE2ERegistry(t, server.URL, "")
		assertE2ETrustFailure(t, err, requests)
	})
}

func assertE2ETrustFailure(t *testing.T, err error, requests int) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), "TLS 인증서를 신뢰할 수 없습니다") ||
		!strings.Contains(err.Error(), "--ca-bundle") {
		t.Fatalf("untrusted certificate must be rejected with CA guidance, got %v", err)
	}
	if requests != 0 {
		t.Fatalf("HTTP handler ran despite failed TLS verification: requests=%d", requests)
	}
}
