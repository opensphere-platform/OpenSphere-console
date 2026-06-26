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
