// Package catalog 은 Registry 단일창구(ADR-0001)의 단일 데이터셋과 게시 게이트다.
//
// 단일 데이터셋 → 3 표현(capability·plugin·template). Console 과 os CLI 는
// 이 동일 구조만 소비한다(console==cli). 쓰기경로 없음(read-only advertise).
package catalog

import (
	"fmt"
	"sort"
)

// Kind 는 카탈로그 항목의 표현 분류다.
type Kind string

const (
	KindCapability Kind = "capability" // 설치형 플랫폼 역량(operand)
	KindPlugin     Kind = "plugin"     // 콘솔 perspective(UIPluginPackage)
	KindTemplate   Kind = "template"   // 스캐폴딩 템플릿
)

// Item 은 단일 카탈로그 데이터셋의 한 항목이다(read-only 권위).
type Item struct {
	Kind        Kind     `json:"kind"`
	Name        string   `json:"name"`
	DisplayName string   `json:"displayName"`
	Version     string   `json:"version"`
	Channel     string   `json:"channel,omitempty"`
	Image       string   `json:"image"`       // repository
	ImageDigest string   `json:"imageDigest"` // 핀(sha256 또는 태그) — ⚠️빈값이면 게시거부
	Requires    []string `json:"requires,omitempty"`
	Description string   `json:"description,omitempty"`
	Source      string   `json:"source"` // "seed" | "live"
}

// Gate 는 ImageDigest 빈값 항목을 게시거부한다(ADR-0001, #4 digest-pin 공유).
// 통과 항목과 거부된 항목명(kind/name)을 분리해 반환한다.
func Gate(items []Item) (kept []Item, rejected []string) {
	for _, it := range items {
		if it.ImageDigest == "" {
			rejected = append(rejected, string(it.Kind)+"/"+it.Name)
			continue
		}
		kept = append(kept, it)
	}
	return kept, rejected
}

// Sort 은 결정적(byte-identical) 출력을 위해 kind→name 으로 안정 정렬한다.
func Sort(items []Item) {
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Kind != items[j].Kind {
			return items[i].Kind < items[j].Kind
		}
		return items[i].Name < items[j].Name
	})
}

// SeedCapabilities 는 설치형 플랫폼 역량(operand) 큐레이션 카탈로그다.
// 출처: foundation operands-catalog 의 실 operand. 모두 버전 핀(빈 digest 0).
func SeedCapabilities() []Item {
	return []Item{
		{Kind: KindCapability, Name: "kanidm", DisplayName: "Kanidm (콘솔 IdP)", Version: "1.4.6", Channel: "stable",
			Image: "docker.io/kanidm/server", ImageDigest: "1.4.6",
			Description: "🛡️ 콘솔/관리자 break-glass IdP(spine 전용)", Source: "seed"},
		{Kind: KindCapability, Name: "keycloak", DisplayName: "Keycloak IAM", Version: "24.0.5", Channel: "stable",
			Image: "quay.io/keycloak/keycloak", ImageDigest: "24.0.5",
			Requires: []string{"postgresql"}, Description: "👤 사원/사용자 IdP(Workspace)", Source: "seed"},
		{Kind: KindCapability, Name: "syncope", DisplayName: "Apache Syncope IGA", Version: "3.0.6", Channel: "stable",
			Image: "apache/syncope", ImageDigest: "3.0.6",
			Requires: []string{"keycloak", "postgresql"}, Description: "정체성 거버넌스/프로비저닝", Source: "seed"},
		{Kind: KindCapability, Name: "opa", DisplayName: "Open Policy Agent", Version: "0.65.0", Channel: "stable",
			Image: "openpolicyagent/opa", ImageDigest: "0.65.0",
			Description: "사용자 인가 정책(사원용 — 콘솔 RBAC와 별개)", Source: "seed"},
		{Kind: KindCapability, Name: "postgresql", DisplayName: "PostgreSQL (CloudNativePG)", Version: "16.3", Channel: "stable",
			Image: "ghcr.io/cloudnative-pg/postgresql", ImageDigest: "16.3",
			Description: "선언형 PostgreSQL operand", Source: "seed"},
		{Kind: KindCapability, Name: "opentelemetry", DisplayName: "OpenTelemetry Collector", Version: "0.103.1", Channel: "stable",
			Image: "otel/opentelemetry-collector", ImageDigest: "0.103.1",
			Description: "관측성 수집기", Source: "seed"},
	}
}

// SeedTemplates 는 스캐폴딩 템플릿 카탈로그다(번들 OCI 핀).
func SeedTemplates() []Item {
	return []Item{
		{Kind: KindTemplate, Name: "perspective-plugin", DisplayName: "Console Perspective Plugin", Version: "0.1.0",
			Image: "localhost:5000/templates/perspective-plugin", ImageDigest: "0.1.0",
			Description: "dupa UIPluginPackage subShell 스캐폴드", Source: "seed"},
		{Kind: KindTemplate, Name: "operand-postgres", DisplayName: "PostgreSQL Operand Claim", Version: "0.1.0",
			Image: "localhost:5000/templates/operand-postgres", ImageDigest: "0.1.0",
			Requires: []string{"postgresql"}, Description: "선언형 Postgres Claim 템플릿", Source: "seed"},
		{Kind: KindTemplate, Name: "workspace-bootstrap", DisplayName: "Workspace Bootstrap", Version: "0.1.0",
			Image: "localhost:5000/templates/workspace-bootstrap", ImageDigest: "0.1.0",
			Description: "소비자 Workspace(B/C) 초기 스캐폴드", Source: "seed"},
	}
}

// ImageString 은 repository 와 핀을 합쳐 정규 이미지 참조를 만든다.
// sha256: 으로 시작하면 digest(@), 아니면 태그(:)로 본다.
func (it Item) ImageString() string {
	if it.Image == "" || it.ImageDigest == "" {
		return ""
	}
	sep := ":"
	if len(it.ImageDigest) > 7 && it.ImageDigest[:7] == "sha256:" {
		sep = "@"
	}
	return fmt.Sprintf("%s%s%s", it.Image, sep, it.ImageDigest)
}
