package registry

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/opensphere/registry/internal/catalog"
)

// console==cli: 입력 순서가 달라도 출력 바이트 동일(byte-identical, ADR-0001 DoD).
func TestBuildDeterministic(t *testing.T) {
	a := append(catalog.SeedTemplates(), catalog.SeedCapabilities()...)
	b := append(catalog.SeedCapabilities(), catalog.SeedTemplates()...)
	ra, _ := Build(a)
	rb, _ := Build(b)
	ja, _ := json.Marshal(ra)
	jb, _ := json.Marshal(rb)
	if !bytes.Equal(ja, jb) {
		t.Fatalf("입력 순서별 출력 불일치 — byte-identical 위반\n a=%s\n b=%s", ja, jb)
	}
}

// 3 표현 분리 + 빈 배열 보장(누락 키 없음).
func TestBuildPartitions(t *testing.T) {
	resp, _ := Build(catalog.SeedCapabilities())
	if len(resp.Capabilities) == 0 {
		t.Fatal("capabilities 비어있음")
	}
	if resp.Plugins == nil || resp.Templates == nil {
		t.Fatal("plugins/templates 가 nil — 빈 배열이어야 함")
	}
}

func TestBuildPreservesBrowserTrustContract(t *testing.T) {
	item := catalog.Item{
		Kind: catalog.KindPlugin, ID: "manual", Name: "manual", ImageDigest: "sha256:abc",
		Manifest:       "/api/plugins/manual/plugins/ui-shell.manifest.json",
		ManifestSHA256: "012345", Signature: "/api/plugins/manual/plugins/ui-shell.manifest.json.sig",
		KeyID: "opensphere-plugins-v1", ComponentKind: "subShell", HostRef: "main",
		HostApiVersion: "1.0.0", HostCompat: ">=1.0.0 <2.0.0", Available: true,
	}
	resp, rejected := Build([]catalog.Item{item})
	if len(rejected) != 0 || len(resp.Plugins) != 1 {
		t.Fatalf("plugin projection failed: rejected=%v plugins=%d", rejected, len(resp.Plugins))
	}
	got := resp.Plugins[0]
	if got.ID != item.ID || got.ManifestSHA256 != item.ManifestSHA256 || got.ComponentKind != item.ComponentKind || !got.Available {
		t.Fatalf("browser trust contract was not preserved: %#v", got)
	}
}
