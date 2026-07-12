# OpenSphere Console native CLI 보안 개선·배포 감사요청서

- 요청일: 2026-07-12
- 대상: `os — OpenSphere CLI` v0.2.0 및 이를 지지하는 Console 코어(controller·auth·console)
- 기준: base 커밋 `c368012`(`main`) 위의 **미커밋 워킹 트리 변경** + kind 클러스터 라이브 롤아웃
- 입력 근거: `AUDIT-REPORT-CONSOLE-NATIVE-CLI-2026-07-12.md`(F-1~F-8), `IMPROVEMENT-PLAN-CONSOLE-NATIVE-CLI-OCI-2026-07-12.md`(WP-1~11), 본 세션 구현·빌드·배포·런타임 검증
- 요청 상태: 구현·재빌드·배포·런타임 검증 완료, 독립 감사 대기
- 민감정보: 실제 PAT·토큰·비밀 값은 본 문서에 기록하지 않는다(체크섬·이미지 ID·엔드포인트 상태만).

## 1. 감사 목적

1차 감사(F-1~F-8)와 이후 사용자 지적(F-9: CLI 토큰 발행 절차 부재)에 대한 **개선 구현과 실제 배포**가 (a) 코드에 정확히 반영됐고, (b) 라이브 클러스터에 무결하게 롤아웃됐으며, (c) 미구현 항목의 보류 사유가 타당한지를 독립적으로 판정받는 것이 목적이다.

## 2. 이번 세션 작업 범위 (작업 내역)

계획서 WP 중 **코드로 완결 가능한 항목**을 구현하고, 4개 컴포넌트 이미지를 재빌드해 전면 배포했다. OCI 테넌시(WP-8~11)·Backbone restore(WP-7)·아티팩트 서명(WP-4)은 인프라/콘솔/CI 조작 영역이라 이번 범위에서 제외했다.

### 2.1 구현한 발견사항

| F | WP | 구현 내용 | 변경 파일 |
|---|---|---|---|
| F-2 | WP-1(부분) | `os login --pat-stdin`(argv 노출 제거), `--pat` deprecated 경고, `run/login` 시그니처에 `in io.Reader` | `backend/os-cli/cmd/os/main.go` |
| F-3 | WP-2 | `RESERVED_PROXY_SERVICE_IDS={'os-cli'}` — 재도입 가드를 바인딩 '이름'에서 native '서비스 id'로 교정 + `proxy-authz` 상태무관 403 이중 방어 | `backend/dupa-control/controller.js` |
| F-5 | WP-3(부분) | role grant/revoke 구조화 감사(`console_role_change`: actor/subject/role/action/result, intent→result) | `backend/identity/opensphere-auth/server.mjs` |
| F-6 | WP-5 | Deployment 하드닝: `seccompProfile: RuntimeDefault`, 고정 UID/GID 101(pod+container), `automountServiceAccountToken: false`, `topologySpreadConstraints`, `PodDisruptionBudget(minAvailable:1)` | `backend/os-cli/deploy.yaml` |
| F-8 | WP-6(부분) | `registry()` 중복·dead 조건 제거 | `backend/os-cli/cmd/os/main.go` |
| F-9 | (감사 추가) | **콘솔 발급 UI**: `/manage/cli`에 PAT 발급/목록/폐기, 1회 표시·`os login --pat-stdin` 명령 복사 | `src/app/pages/admin-cli.ts` |
| F-9 | (감사 추가) | **CLI 브라우저 로그인**: `os login --web` — 콘솔 발급 페이지를 열고 토큰 stdin 입력 | `backend/os-cli/cmd/os/main.go` |

### 2.2 회귀 방지 테스트 추가

- Go: `TestLoginReadsPatFromStdin`, `TestLoginWarnsOnArgvPat`, `TestLoginWebOpensConsoleAndReadsPastedToken`, help의 `--pat-stdin` 단언 (`backend/os-cli/cmd/os/main_test.go`)
- Node: F-3 예약 id·이중 방어, F-6 하드닝, F-2 stdin 계약 회귀 (`backend/dupa-control/main-shell-base.test.js`)

## 3. 검증 증거 (근거)

| 구분 | 결과 | 증거 |
|---|---:|---|
| Go CLI 테스트 | PASS | `go test ./...` 8/8, `go vet` clean (pinned golang digest 컨테이너) |
| Go cross-build | PASS | linux/amd64·darwin/arm64·windows/amd64, **CGO_ENABLED=0 정적**(재현성 유지) |
| Node 계약·보안 테스트 | PASS | main-shell-base 10/10, security 12/12, fail 0 |
| Angular production build | PASS | `ng build --configuration production` 성공(사전 존재 번들 예산 경고만) |
| os-cli 아티팩트 재현성 | PASS | 인-이미지 3-플랫폼 sha256 = `index.json` = 라이브 다운로드 (linux `efde91fb…`, darwin `4e95d7e7…`, windows `56afa51d…`) |
| 4개 이미지 재빌드 | PASS | 아래 §4 이미지 ID |
| 전체 롤아웃 | PASS | os-cli·controller·auth·console 각 2/2 Running, 신규 Pod restart 0 |
| 라이브 native API | PASS | `GET /api/cli/index.json` 200(새 체크섬), 다운로드 Windows 바이너리 size 6,252,032·sha256 `56afa51d…` 일치, `os login --web` 동작 |
| 라이브 발급 UI | PASS | 서빙 번들 `main-OGDPMWVS.js`(새 해시)에 `pat-stdin --console`·`/bff/pat/`·`manage/cli` 포함 |
| 라이브 스모크 | PASS | `/readyz` 200 · `/api/v1/registry` 200 · `/bff/healthz` 200 · `/api/cli/index.json` 200 · 구 `/api/plugins/os-cli/*` 403 |
| F-6 하드닝 실적용 | PASS | pod securityContext `runAsUser/runAsGroup:101`·`seccompProfile:RuntimeDefault`·`automountServiceAccountToken:false`, PDB `minAvailable:1`·ALLOWED DISRUPTIONS 1 |

## 4. 배포 아티팩트 (provenance)

| 컴포넌트 | 새 태그 | 빌드 이미지 ID(config digest) | 이전 digest |
|---|---|---|---|
| os-cli | `os-cli:cli-hardening-20260712` | `sha256:89b0a8aad8c2…dcd2` | `a2edd2ee…` |
| dupa-registry-controller | `dupa-registry-controller:cli-hardening-20260712` | `sha256:5ba97b2b5f07…ad77` | `d1247ab8…` |
| opensphere-auth | `opensphere-auth:cli-hardening-20260712` | `sha256:4a91e011277b…4e79` | `d263557e…` |
| opensphere-console | `opensphere-console:cli-hardening-20260712` | `sha256:de02f513ceb0…1867` | `11e877b6…` |

이미지는 `docker save | ctr -n k8s.io images import`로 두 kind 노드(desktop-control-plane/worker)에 로드했다.

### 4.1 이미지 참조 방식 변경 — 감사 대상

재빌드 이미지를 `@sha256:<digest>`로 참조하면 kind에서 pull 해석 실패("failed to resolve reference … not found")가 발생한다(로컬 로드 이미지는 digest-pull 불가). 따라서 4개 매니페스트를 **태그 + `imagePullPolicy: IfNotPresent`**로 전환하고 주석으로 명시했다. **CI/레지스트리 배포에서는 `@sha256:<digest>` 고정으로 되돌려야 한다**(공급망 provenance). 아티팩트 자체 provenance는 os-cli 바이너리 SHA-256(인-이미지=manifest=라이브)로 독립 검증된다.

## 5. 미구현·보류 항목과 사유

| 항목 | 사유 |
|---|---|
| F-1 (Windows secure store) | DPAPI/Keychain 접근이 현재 `CGO_ENABLED=0` 정적 교차빌드(재현성 근거)와 충돌 → cgo-free 방식 ADR 결정 후 구현. 이번엔 F-2(argv)만 축소 |
| F-4 (artifact 서명) | 릴리스/CI 파이프라인(build→sign→verify) + digest 참조 복원과 함께 처리 |
| F-7 (OAA 테스트) | `oaa-gateway-tier.test.js`가 누락 `os-oaa-agent.ts` 참조로 실패, base-shell 테스트는 OAA 부재를 요구 → 정본 상태 모순, **제품 판단** 필요(CLI 스위트는 전부 통과) |
| F-9 완전 자동 로그인 | Kanidm이 `grant_types_supported:["authorization_code"]`만 광고(device-code 없음). loopback PKCE redirect_uri 등록은 IdP 변경 필요. `--web`는 IdP 변경 없이 동작하는 콘솔-assisted 방식 |
| WP-7 / WP-8~11 | Backbone restore drill(운영), OCI IAM/DR/FinOps(테넌시 콘솔 조작·자격증명 입력 필요 — 수행 불가) |

## 6. 감사 요청 항목

감사자는 최소한 다음을 독립적으로 확인해 주기 바란다.

1. F-2/F-3/F-5/F-6/F-8/F-9가 코드에 정확·일관되게 반영됐는가.
2. F-3에서 임의 이름의 CLIDownload가 `href=/api/plugins/os-cli/…`로 native 서비스를 프록시 allowlist에 태울 수 없는가(서비스 id 기준 차단 + proxy-authz 이중 방어).
3. os-cli 아티팩트 재현성 체인(인-이미지 바이너리 = `index.json` = 라이브 다운로드 SHA-256)이 성립하는가.
4. F-6 하드닝이 라이브 Pod spec에 실제 적용됐고 무중단 롤아웃됐는가.
5. F-9 발급 UI가 서빙 번들에 포함되고 `/bff/pat`(mint/list/revoke) 계약 및 1회 표시·argv 비노출을 지키는가.
6. F-5 role 감사가 grant/revoke의 성공·실패·거부에서 실제 구조화 이벤트로 발생하는가.
7. §4.1 태그 참조 전환의 provenance 영향과 CI digest 복원 필요성이 적절히 문서화됐는가.
8. §5 미구현 항목의 보류 사유(특히 F-1 cgo 충돌, F-9 IdP 제약)가 기술적으로 타당한가.
9. 배포한 4개 이미지 외 부수 효과(다른 워크로드 회귀)가 없는가.

## 7. 알려진 잔여 위험

- 태그 참조는 로컬 kind 한정 편의이며, digest 고정 복원 전까지 공급망 provenance가 약화된 상태다(F-4와 함께 해소).
- 새 CLI 바이너리·발급 UI는 서명되지 않았다(F-4 미구현).
- role 감사는 로그 스택(Loki) 수집 기반이며, PostgreSQL append-only durable + DB 미연결 시 fail-closed는 WP-3 후속이다.
- 워킹 트리에는 **본 세션과 무관한 동시 변경**(`backend/oaa-gateway/manual-seeds/*`, `…/scripts/build-manual-seed.js`, `docs/AUDIT-REQUEST-CONSOLE-NATIVE-CLI-2026-07-12.md`, `docs/MAIN-SHELL-BASELINE.md` 삭제, `docs/BACKBONE-ARCHITECTURE.md`, `docs/OBSERVABILITY-ARCHITECTURE.md`)이 존재한다. 이는 본 작업이 아니며 커밋하지 않았다.

## 8. 변경 파일 목록 (감사 기준 코드)

```text
backend/os-cli/cmd/os/main.go            # F-2, F-8, F-9(--web)
backend/os-cli/cmd/os/main_test.go       # F-2, F-9 테스트
backend/os-cli/index.json                # 재빌드 바이너리 체크섬
backend/os-cli/deploy.yaml               # F-6 하드닝 + 태그 참조
backend/dupa-control/controller.js       # F-3
backend/dupa-control/dupa-registry-controller.yaml  # 태그 참조
backend/dupa-control/main-shell-base.test.js        # F-2/F-3/F-6 회귀
backend/identity/opensphere-auth/server.mjs         # F-5
backend/identity/opensphere-auth/deploy.yaml        # 태그 참조
deploy/opensphere-console.yaml           # 태그 참조
src/app/pages/admin-cli.ts               # F-9 발급 UI
docs/IMPLEMENTATION-REPORT-CONSOLE-NATIVE-CLI-2026-07-12.md  # 작업 내역 상세
```

## 9. 요청 판정 형식

최종 감사 결과는 다음 두 줄을 분리해 보고해 주기 바란다.

```text
Console-native CLI hardening (F-2/F-3/F-5/F-6/F-8/F-9): ACCEPT | ACCEPT WITH CONDITIONS | REJECT
Deployment integrity (4-image rollout, tag-ref tradeoff): ACCEPT | ACCEPT WITH CONDITIONS | REJECT
```
