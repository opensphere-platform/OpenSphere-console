package catalog

import "testing"

// ImageDigest 빈값 게시거부 게이트(ADR-0001).
func TestGateRejectsEmptyDigest(t *testing.T) {
	items := []Item{
		{Kind: KindCapability, Name: "ok", ImageDigest: "1.0.0"},
		{Kind: KindCapability, Name: "bad", ImageDigest: ""},
	}
	kept, rejected := Gate(items)
	if len(kept) != 1 || kept[0].Name != "ok" {
		t.Fatalf("게이트 통과 기대 [ok], 실제 %d개", len(kept))
	}
	if len(rejected) != 1 || rejected[0] != "capability/bad" {
		t.Fatalf("게시거부 기대 [capability/bad], 실제 %v", rejected)
	}
}

// seed 카탈로그는 빈 digest 0(게시거부 대상 없음).
func TestSeedHasNoEmptyDigest(t *testing.T) {
	items := append(SeedCapabilities(), SeedTemplates()...)
	if _, rejected := Gate(items); len(rejected) != 0 {
		t.Fatalf("seed 에 빈 digest 존재(게시거부): %v", rejected)
	}
}
