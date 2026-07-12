# OpenSphere Console 명명·공급 표준 (Naming & Supply Standard) v2

Status: **정본 정책 · 필수 준수 (정책이 먼저)**
Authority: 워크로드/네임스페이스/이미지/태그 명명의 단일 기준(SSOT). 코드·매니페스트가 충돌하면 이 문서가 우선한다.

## 1. 원칙

- 콘솔 first-party 워크로드: `opensphere-console-<역할>`.
- Console Backbone Service(상태저장 데이터 티어): `opensphere-cbs-<엔진>`.
- **네임스페이스도 정렬한다**(v2): 콘솔 서비스는 `opensphere-console`, 데이터 티어는 `opensphere-cbs`.
- 소스 디렉터리 = 리소스 이름 = 이미지 이름을 일치시킨다.
- 하위 리소스(SA·Role·RoleBinding·ConfigMap·Secret·PVC·Service alias)는 소속 워크로드의 새 접두를 따른다.

## 2. 정본 매핑 (이름 · 네임스페이스 · 이미지 · 공급)

| 이전 (name/ns) | 정본 이름 | 정본 ns | GHCR 이미지 | 공급 방식 |
|---|---|---|---|---|
| opensphere-console / opensphere-console | opensphere-console | **opensphere-console** | `ghcr.io/opensphere-platform/opensphere-console` | OpenSphere 소스 빌드 |
| opensphere-auth / opensphere-console-auth | opensphere-console-auth | **opensphere-console** | `…/opensphere-console-auth` | OpenSphere 소스 빌드 |
| kanidm(StatefulSet) / opensphere-console-auth | opensphere-console-kanidm | **opensphere-console** | `…/opensphere-console-kanidm` | 검증 upstream(Kanidm 1.4.6) **byte-equivalent mirror** |
| console-backend / opensphere-system | opensphere-console-backend | **opensphere-console** | `…/opensphere-console-backend` | OpenSphere 소스 빌드 |
| dupa-registry-controller / opensphere-system | opensphere-console-dupa-controller | **opensphere-console** | `…/opensphere-console-dupa-controller` | OpenSphere 소스 빌드 |
| oaa-gateway / opensphere-backbone | opensphere-console-oaa-gateway | **opensphere-console** | `…/opensphere-console-oaa-gateway` | OpenSphere 소스 빌드 |
| backbone-postgres / opensphere-backbone | opensphere-cbs-postgresql | **opensphere-cbs** | `…/opensphere-cbs-postgresql` | curated build(PostgreSQL 19b1 + pgvector 0.8.5) |
| backbone-rustfs / opensphere-backbone | opensphere-cbs-rustfs | **opensphere-cbs** | `…/opensphere-cbs-rustfs` | curated build(RustFS) |
| backbone-gitea / opensphere-backbone | opensphere-cbs-gitea | **opensphere-cbs** | `…/opensphere-cbs-gitea` | curated build(Gitea) |

> os-cli·opensphere-registry·opensphere-fleet-*도 콘솔 first-party이므로 `opensphere-console` ns로 함께 이전한다(2차). 이전 후 `opensphere-system`·`opensphere-backbone` ns는 폐기.

## 3. 레지스트리·CI (하이브리드 — 확정)

- **소스 레포: Azure DevOps** (`dev.azure.com/OpenSphere-Platform/.../opensphere-console`).
- **이미지 레지스트리: GHCR** (`ghcr.io/opensphere-platform/*`).
- **CI: Azure Pipelines**(`azure-pipelines.yml`)가 빌드 후 **GHCR로 push**한다. GHCR 인증은 Azure service connection의 GHCR PAT(`packages:write` 범위)로 한다.
- 사용자가 제시한 GitHub Actions(`GITHUB_TOKEN`, `permissions: packages:write/id-token`) 블록은 **소스를 GitHub에 미러링할 때만** 직접 적용된다. 하이브리드에서는 Azure Pipelines가 정본 CI다.
- 릴리스 서명·검증(cosign/attestation)은 GHCR digest 기준으로 수행한다.

## 4. 태그·digest 정책

- First-party: semver — `…/opensphere-console:2.0.0-rc.1`, `:2.0.0`.
- Curated upstream: 제품버전+os버전 — `…/opensphere-cbs-postgresql:19beta1-pgvector0.8.5-os2.0.0`, `…/opensphere-console-kanidm:1.4.6-os2.0.0`.
- **금지 태그**: `latest`, `dev`, `final`, `secure`, 날짜단독(`20260712`). 날짜는 빌드 메타데이터로만.
- **Setup/BOM은 tag가 아니라 push 후 확정된 registry digest(`@sha256:…`)를 고정**한다. 로컬 Docker image ID ≠ GHCR digest — push 결과에서 digest를 다시 받는다.

## 5. 로컬(kind) vs 릴리스 — 공존 규칙 (명시)

- **릴리스/운영**: 매니페스트는 `ghcr.io/opensphere-platform/<img>@sha256:<digest>` 고정(BOM).
- **로컬 kind 개발**: GHCR digest-pull이 안 되므로 노드에 로드한 **로컬 태그 + `imagePullPolicy: IfNotPresent`**로 override한다(kustomize/patch). 정본 매니페스트를 로컬 태그로 덮어쓰지 않는다.

## 6. BOM 구조

```yaml
console:   { image: ghcr.io/opensphere-platform/opensphere-console@sha256:<digest> }
postgresql:
  productVersion: 19beta1
  extensions: { pgvector: 0.8.5 }
  image: ghcr.io/opensphere-platform/opensphere-cbs-postgresql@sha256:<digest>
```

## 7. 실행 순서(안전) — 데이터 손실 방지

1. **표준 확정**(이 문서). ← 지금.
2. **무상태 이름/디렉터리/파일 정렬**(auth·backend·dupa-controller·oaa-gateway): 이름·DNS·이미지·소스 dir. ← 1차 적용(진행 중).
3. **ns 정렬(코드/매니페스트)**: namespace 필드 + 모든 `<svc>.<ns>.svc` DNS 갱신. 라이브는 신규 ns 생성 후 컷오버.
4. **상태저장(cbs-*·kanidm) 마이그레이션**: StatefulSet 이름 변경은 `<pvc>-<sts>-<n>` 를 바꿔 데이터가 분리된다. **백업 → 신규 워크로드 → 복원 → 검증** 창을 확보한 뒤에만 수행. 비운 채 재생성 금지.

## 8. 현재 진행 상태(이 커밋)

- 적용: 무상태 4종 리소스 이름·DNS·소스 디렉터리/파일명 정렬. 관련 테스트 green.
- 미적용(후속): ns 정렬(§7-3), 상태저장 마이그레이션(§7-4), GHCR push·BOM digest 확정(§3·§6), os-cli/registry/fleet ns 이전(§2 주).
