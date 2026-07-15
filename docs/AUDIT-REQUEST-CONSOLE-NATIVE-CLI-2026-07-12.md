# OpenSphere Console native CLI 통합 감사요청서

- 요청일: 2026-07-12
- 대상: OpenSphere Console Main Shell 및 `os — OpenSphere CLI` v0.2.0
- 감사 기준: 이 문서를 포함하는 `main` 커밋(최종 작업 보고서에 commit hash 기재)
- 요청 상태: 구현·빌드·배포·런타임 검증 완료, 독립 감사 대기

## 1. 감사 목적

이번 변경은 `os`를 별도 `CLIDownload` Binding 또는 Consumer로 취급하던 구조를 폐기하고, Console이 직접 소유하는 native 관리 기능으로 재정의한다. 감사자는 다음 두 판정을 분리해 내려야 한다.

1. Console-native CLI 통합이 소유권·인증 경계·배포·보안·UI 계약을 충족하는가.
2. 전체 Console이 프로덕션 완결 상태인가. 이 판정에는 Backbone 필수 게이트가 적용된다.

## 2. 정본 아키텍처 판정

### 2.1 Console과 Backbone

Backbone은 Console의 선택적 플러그인이 아니라 상태저장 기반이다. PostgreSQL, object storage, config-as-code가 Console의 감사 내구성·아티팩트·설정 이력을 지지하고, 그 기둥 위에 Console 세부 기능이 구성되며 subShell과 Plugin이 연결된다.

따라서 다음 등식이 감사 기준이다.

```text
Backbone 기반 + Main Shell core = Console의 필수 토대
Console의 토대 + 승인된 Host Contract = subShell / Plugin / Binding 확장
```

`Backbone` 없이 화면과 인증이 기동된다는 사실은 degraded boot 가능성일 뿐, 프로덕션 완결을 의미하지 않는다. 특히 ConfigMap 또는 memory 감사 저장은 영구 감사 저장소를 대체할 수 없다.

### 2.2 Console native CLI

현재 `os`는 Kanidm/BFF 관리자 PAT, Console Registry, same-origin API, RBAC 및 감사 계약을 Console과 공유하는 관리 제어 표면이다. 따라서 다음 자산은 Main Shell core가 직접 소유한다.

- Go 소스, 테스트 및 Linux/macOS/Windows 교차 빌드
- `/manage/cli` 관리 화면
- 고정 native 경로 `/api/cli/*`
- 플랫폼별 배포 아티팩트, 크기 및 SHA-256 manifest
- Kubernetes `os-cli` Deployment/Service

`os`를 `/api/plugins/os-cli/*`, `CLIDownload/os` 또는 Binding allowlist로 재도입하는 것은 금지한다.

### 2.3 향후 workforce CLI

직원·AD 연계 사용자를 위한 workforce 인증·권한·명령은 별도 프로파일과 승인된 Binding으로 확장한다. 관리자 PAT를 workforce 토큰으로 재사용하지 않는다. 이번 변경은 Binding 프레임워크 자체를 삭제하지 않고 그 audience를 `workforce | external`로 제한했다.

## 3. 구현 범위

### 3.1 신규 native CLI

- `backend/os-cli/cmd/os/main.go`: login, whoami, registry, get, role 및 Registry-discovered namespace 명령
- `backend/os-cli/cmd/os/main_test.go`: 경계·설정 권한·URL 검증·동적 flag 파싱
- `backend/os-cli/Dockerfile`: Go 1.25.11, 테스트 포함 재현 가능한 3-platform build
- `backend/os-cli/index.json`: `console-native`, `admin`, artifact size/SHA-256, workforce 경계
- `backend/os-cli/deploy.yaml`: 2 replicas, digest 고정, non-root, read-only root, capability drop

### 3.2 Console native UI/API

- `/manage/cli`를 Console 관리 tree의 `자산 및 확장` 아래 추가
- Clarity v18 `clr-datagrid`, `clr-alert`, button과 공용 `os-page-header`만 사용
- Carbon Terminal icon은 승인된 아이콘 자산으로 사용
- `/api/cli/*`를 read-only 고정 upstream으로 제공하고 POST 등 비-GET 차단
- manifest 소유권과 admin profile을 UI에서 검증

### 3.3 Binding 정리

- 기존 `backend/cli-download`와 `CLIDownload/os` 삭제
- `/api/plugins/os-cli/*` 호환 redirect를 만들지 않고 403으로 차단
- 컨트롤러가 이름 `os`를 Binding 목록·allowlist에서 제외하고 enable/disable 요청을 409로 거부
- `backend/cli-bindings/crd.yaml`은 향후 workforce/external 확장 계약으로만 유지

### 3.4 문서 및 회귀 방지

- 최상위 `DESIGN-GUIDE.md`와 `../../_DOCS_/01-CONSTITUTION/CONSTITUTION-0004-PLATFORM-BOOTSTRAP-SUPPORT-FOUNDATION-LIFECYCLE.md`에 native CLI 및 workforce 경계 반영 (`MAIN-SHELL-BASELINE.md`는 0004로 흡수·삭제)
- Main Shell 계약 테스트에 route/menu/Clarity/native API/native ownership/no-Binding 조건 추가

## 4. 검증 증거

| 구분 | 결과 | 증거 |
|---|---:|---|
| Console 계약·보안 테스트 | PASS | Node test 53/53, fail 0 |
| Go CLI 테스트 | PASS | `go test ./...` |
| Angular production build | PASS | 산출물 생성 완료 |
| CLI cross build | PASS | Linux amd64, macOS arm64, Windows amd64 |
| Console 이미지 | PASS | `sha256:11e877b63a5b79c83f7b75dc4812ffc5c047e1c4c7e2d11067051c8ce238ba3e` |
| CLI 이미지 | PASS | `sha256:a2edd2ee25c8e0b676d7d7f9a1d1612f3646df9b216539cd6bd58fdc1101a1df` |
| Controller 이미지 | PASS | `sha256:d1247ab8087fefd4097f1ea88e006cbb897c22cb2249b90c24fb8b78eba17632` |
| 이미지 취약점 | PASS | 세 이미지 모두 Docker Scout 0 Critical / 0 High |
| Deployment | PASS | 세 Deployment 모두 2/2 Ready, 새 Pod restart 0 |
| native API | PASS | `GET /api/cli/index.json` 200, `POST /api/cli/index.json` 403 |
| 구 Binding 경로 | PASS | `GET /api/plugins/os-cli/index.json` 403 |
| Binding/Consumer 객체 | PASS | `CLIDownload`, `BackboneClaim`, `UIPluginPackage`, `UIPluginRegistration` items 0; Registry `plugins: []` |
| Backbone 세 기둥 | PASS | PostgreSQL, RustFS, Gitea 각각 1/1 Ready; 3개 PVC Bound |
| Backbone 연결 | PASS | controller가 PostgreSQL `audit_log` 연결·500건 hydration 및 RustFS 연결을 기록 |
| 실제 다운로드 | PASS | Windows artifact 6,155,776 bytes, manifest SHA-256 일치 |
| 실행 검증 | PASS | 다운로드한 binary가 `os 0.2.0`과 admin/workforce 경계를 출력 |
| 브라우저 UI | PASS(범위 제한) | `/manage/cli` tree, datagrid, alerts, 3 artifacts, checksum 렌더링; console/page error 0 |

브라우저 UI 검증은 비밀정보를 사용하지 않은 합성 유효기간 세션으로 route guard만 통과시킨 렌더링 검사다. 실제 OIDC 로그인 성공을 증명하는 테스트로 간주하지 않는다. native API와 binary 다운로드·실행은 배포된 HTTPS endpoint에 직접 수행했다.

## 5. 구현 중 발견·교정한 결함

1. 최초 Go 1.24 build에서 표준 라이브러리 High 취약점 10건이 검출됐다. Go 1.25.11 digest로 올리고 재빌드하여 0 Critical / 0 High를 확인했다.
2. 최초 CLI Pod가 read-only root filesystem에서 nginx `/tmp/proxy_temp`를 만들지 못해 CrashLoop했다. root filesystem을 쓰기 가능하게 되돌리지 않고, 크기가 제한된 `/tmp` 전용 `emptyDir`를 추가해 해결했다.
3. 최초 artifact manifest에는 checksum과 size가 없었다. 세 binary의 SHA-256과 byte size를 manifest 및 관리 UI에 추가하고 실제 HTTPS 다운로드 결과와 대조했다.

## 6. 감사 요청 항목

감사자는 최소한 다음을 독립적으로 확인해 주기 바란다.

1. `os`의 Main Shell 소유권이 코드·route·API·배포 전 구간에서 일관적인가.
2. `os`를 Binding 또는 generic plugin proxy로 되돌릴 우회 경로가 남아 있지 않은가.
3. admin Kanidm/BFF PAT와 향후 workforce 신원·토큰이 명확히 분리되는가.
4. CLI가 Console과 동일 Registry·인가·감사 의미론을 소비하며 별도 권한 체계를 만들지 않는가.
5. URL 검증, credential-bearing URL 거부, config mode 0600 및 TLS opt-in이 충분한가.
6. 동적 namespace 명령이 Registry의 `Available` 상태와 closed-set 계약을 정확히 따르는가.
7. cross-build와 artifact checksum이 재현성·provenance 요구를 충족하는가.
8. Deployment의 non-root, read-only root, drop ALL, resource/probe 설정이 적절한가.
9. `/manage/cli`가 Clarity v18 정책과 관리 tree 정보구조를 준수하는가.
10. Backbone 미연결 상태에서 Console이 완결 또는 안전하다고 오인될 표시·fallback이 남아 있지 않은가.

## 7. 알려진 잔여 위험 및 감사 게이트

### Backbone 운영 내구성

감사 환경에는 Backbone PostgreSQL·RustFS·Gitea가 모두 Ready이며 controller도 PostgreSQL 영구 감사 저장소와 RustFS에 연결돼 있다. `BackboneClaim` 0건은 현재 Consumer/subShell을 설치하지 않은 기본 Console 상태와 일치하며 Backbone 부재를 의미하지 않는다.

다만 현재 storage class가 local-path RWO이므로 노드 소실에 대한 HA를 제공하지 않는다. 논리 백업의 오프노드 반출과 실제 restore 훈련은 이번 CLI 범위에서 재검증하지 않았으므로 전체 Console 운영 승인 시 별도 증거를 요구한다.

### 향후 범위

- workforce Binding 구현은 이번 범위가 아니다.
- `CLIDownload`는 아직 v1alpha1 미래 확장 계약이다.
- `OS_INSECURE_SKIP_TLS_VERIFY=1`은 로컬 개발의 명시적 opt-in으로만 남아 있다.
- Angular initial bundle은 4.22MB로 3MB budget을 1.22MB 초과하고, `admin-plugins` style은 4KB budget을 597 bytes 초과한다. build 실패는 아니지만 성능 부채로 감사 기록이 필요하다.

## 8. 요청 판정 형식

최종 감사 결과는 다음 두 줄을 분리해 보고해 주기 바란다.

```text
Console-native CLI integration: ACCEPT | ACCEPT WITH CONDITIONS | REJECT
Console production completeness: ACCEPT | ACCEPT WITH CONDITIONS | REJECT
```
