# Console-native CLI 개선 구현 보고서

- 작성일: 2026-07-12
- 기준: `IMPROVEMENT-PLAN-CONSOLE-NATIVE-CLI-OCI-2026-07-12.md` WP-1~11, `AUDIT-REPORT-CONSOLE-NATIVE-CLI-2026-07-12.md` F-1~F-8
- 범위: **코드로 완결·검증 가능한 항목만 구현.** OCI 테넌시(WP-8~11)·Backbone restore drill(WP-7)·CI 재빌드/서명(WP-4)·라이브 배포 적용은 콘솔/인프라 조작이라 코드 대상 아님(사유 §3).
- 원칙: 각 변경은 테스트 또는 빌드/스키마 검증으로 확인 후에만 완료 처리.

## 1. 구현·검증 완료

| 감사 F | WP | 구현 내용 | 파일 | 검증 |
|---|---|---|---|---|
| F-2 | WP-1(부분) | `os login --pat-stdin` 추가(stdin에서 PAT 읽어 argv 노출 제거), `--pat`는 deprecated 경고 후 유지, help·시그니처(`run/login`에 `in io.Reader`) 갱신 | `backend/os-cli/cmd/os/main.go`, `main_test.go` | go test 6/6, vet, 3-플랫폼 정적 교차빌드, 바이너리 스모크 |
| F-3 | WP-2 | `RESERVED_PROXY_SERVICE_IDS={'os-cli'}` 도입. allowlist 조립 시 published·binding 양쪽에서 예약 id 제외 + `proxy-authz`가 예약 id를 상태 무관 403(이중 방어). 재도입 가드를 바인딩 '이름'에서 native '서비스 id' 기준으로 교정 | `backend/dupa-control/controller.js` | node 회귀 테스트, `node --check` |
| F-5 | WP-3(부분) | role grant/revoke에 구조화 감사(`console_role_change`: actor/subject/role/action/result, intent→result before/after) 추가. actor를 핸들러로 전달 | `backend/identity/opensphere-auth/server.mjs` | `node --check` |
| F-6 | WP-5 | os-cli Deployment 하드닝: `seccompProfile: RuntimeDefault`, `runAsUser/runAsGroup: 101`(pod+container), `automountServiceAccountToken: false`, `topologySpreadConstraints`, `PodDisruptionBudget(minAvailable:1)` | `backend/os-cli/deploy.yaml` | **라이브 적용 완료**: rollout 성공, 2/2 Running·restart 0, pod securityContext·automount:false·PDB 실적용 확인, `/api/cli/index.json` 200 |
| F-8 | WP-6(부분) | `registry()`의 중복·dead 조건 제거 | `backend/os-cli/cmd/os/main.go` | go test/vet |
| F-9 | (감사 추가) | **콘솔 토큰 발급 UI**: `/manage/cli`에 PAT 발급/목록/폐기 + 1회 표시·`os login --pat-stdin` 명령 복사 | `src/app/pages/admin-cli.ts` | ng build(production) green, 번들에 UI·`/bff/pat` 포함 |
| F-9 | (감사 추가) | **CLI 브라우저 로그인**: `os login --web` — 콘솔 발급 페이지를 브라우저로 열고 토큰 stdin 입력 | `backend/os-cli/cmd/os/main.go` | go test 8/8, 3-플랫폼 정적 교차빌드 |

### 검증 로그 요약

```
go test ./...            ok  (TestLoginReadsPatFromStdin, TestLoginWarnsOnArgvPat 신규 포함)
go vet ./...             clean
cross-build              linux/amd64 · darwin/arm64 · windows/amd64 (CGO_ENABLED=0 정적 — 재현성 유지)
node main-shell-base     10/10 (F-2·F-3·F-6 회귀 3건 신규)
node security            12/12
kubectl dry-run          deployment/os-cli configured · poddisruptionbudget/os-cli configured
```

## 1.5 배포 결과 (전체 롤아웃 완료)

4개 컴포넌트 이미지를 재빌드해 kind 클러스터(desktop-control-plane/worker)에 로드하고 롤아웃했다. 모두 성공, 8/8 Pod Running.

| 컴포넌트 | 새 이미지 태그 | 반영 변경 | 롤아웃 |
|---|---|---|---|
| os-cli | `os-cli:cli-hardening-20260712` | F-2/F-8/F-9(`--web`) 바이너리 + F-6 하드닝 + 새 index.json 체크섬 | 2/2 Running |
| dupa-registry-controller | `dupa-registry-controller:cli-hardening-20260712` | F-3 예약 서비스 id | 2/2 Running |
| opensphere-auth | `opensphere-auth:cli-hardening-20260712` | F-5 role 감사 | 2/2 Running |
| opensphere-console | `opensphere-console:cli-hardening-20260712` | F-9 발급 UI | 2/2 Running |

**배포 검증 증거:**
- os-cli: 라이브 `index.json` 새 체크섬(efde91fb/4e95d7e7/56afa51d), 다운로드 Windows 바이너리 sha256 일치, `os login --web` 동작. **인-이미지 바이너리 = index.json 재현성 확인.**
- console: 서빙 번들(`main-OGDPMWVS.js`, 새 해시)에 F-9 UI(`pat-stdin --console`·`/bff/pat/`·`manage/cli`) 포함.
- 라이브 스모크: `/readyz` 200, `/api/v1/registry` 200, `/bff/healthz` 200, `/api/cli/index.json` 200, 구 `/api/plugins/os-cli/*` 403.

**이미지 참조 방식 변경 (로컬 kind 한정):** 재빌드 이미지의 `@sha256:<digest>` 참조는 kind에서 pull 해석 실패("failed to resolve reference")가 발생한다(로컬 로드 이미지는 digest-pull이 안 됨). 그래서 4개 매니페스트를 **태그 + `imagePullPolicy: IfNotPresent`**로 전환하고 주석으로 명시했다. **CI/레지스트리 배포에서는 `@sha256:<digest>` 고정으로 되돌려야 한다(공급망 provenance).** 이는 F-4(서명 파이프라인)와 함께 처리한다.

## 2. 미구현 — 사유별

### 2.1 코드 밖(인프라/콘솔/CI 조작 필요)

- **WP-4 / F-4 (artifact 서명)**: manifest detached signature·keyId·CI build→sign→verify 파이프라인. 릴리스 엔지니어링·CI 인프라 작업. 코드 스캐폴딩은 가능하나 실제 서명 키·CI 실행은 범위 밖.
- **WP-7 (Backbone restore drill)**: 오프노드 백업 반출·실제 복구 훈련·RPO/RTO 측정. 운영 작업.
- **WP-8~11 (OCI IAM/DR/FinOps)**: OCI 테넌시 콘솔에서 compartment·group·policy·credential·MFA·DR 변경. 콘솔 로그인·조작 필요(자격증명 입력은 수행 불가).
- **CLI 이미지 재빌드**: `main.go` 변경(`--pat-stdin`, `--web` 등)은 소스에 반영됐으나, 배포된 `os-cli` 이미지 digest(`a2edd2ee…`)에는 미포함. 새 바이너리 반영은 CI 재빌드+재서명(WP-4) 후 digest 갱신 필요.
- **콘솔 이미지 재빌드**: `admin-cli.ts`의 발급 UI는 프로덕션 빌드에 컴파일됐으나, 배포된 콘솔 이미지에는 미포함. 콘솔 이미지 재빌드+롤아웃 필요.

> F-6은 §1 표대로 라이브 클러스터 적용까지 완료됨(승인 후 rollout 성공).

### 2.2 설계 결정 필요

- **F-1 (Windows secure store)**: PAT를 OS 자격증명 저장소(DPAPI/Keychain/libsecret)로 이전하는 근본 수정. **현재 `CGO_ENABLED=0` 정적 교차빌드(재현성 근거)와 충돌** — Keychain/Secret Service 접근은 통상 cgo/외부 바이너리 호출을 요구한다. cgo 없는 구현 방식(순수 Go DPAPI, `security`/`secret-tool` 셸아웃, OS-key 파생 암호화 등)을 **ADR로 확정한 뒤** 구현해야 한다. 이번에는 F-2(argv 노출)만 축소했고, config는 여전히 0600 평문(unix)이다.
- **F-7 (OAA 테스트)**: `oaa-gateway-tier.test.js`가 누락 파일 `src/app/os/os-oaa-agent.ts`를 참조해 실패. 한편 `main-shell-base.test.js`는 base shell에 OAA agent가 **없어야** 한다고 단언 → OAA 기능의 정본 상태(지원/제거)가 코드·테스트 간 모순. **제품 판단**이 필요하므로 임의 복구·삭제하지 않음. CLI 관련 스위트(main-shell-base·security)는 전부 통과.
- **F-9 (토큰 발행 절차) — 대부분 구현, 완전 자동 로그인만 잔여**: 콘솔 발급 UI(`/manage/cli`)와 CLI 브라우저 로그인(`os login --web`)을 구현했다(§1). 다만 **완전 자동 loopback PKCE 로그인**(OCI `session authenticate`처럼 토큰 붙여넣기 없이 브라우저 인증만으로 완료)은 미구현 — Kanidm이 `grant_types_supported: ["authorization_code"]`만 광고하고 device-code grant가 없으며, native/loopback `redirect_uri`(예: `http://127.0.0.1:<port>/callback`)를 OIDC 클라이언트 `opensphere-console`에 등록하는 **IdP 변경**이 필요하기 때문. 현재 `--web`는 IdP 변경 없이 동작하는 콘솔-assisted 방식이다. 또한 새 발급 UI의 **라이브 렌더/실제 mint 흐름**은 OIDC 로그인 뒤에서만 확인 가능하므로(감사 브라우저 검사와 동일 제약) 프로덕션 빌드 컴파일·번들 포함까지만 검증했다. 배포 반영은 콘솔 이미지 재빌드 필요.

## 3. 다음 액션 제안

1. **F-6 라이브 적용 승인**: `kubectl apply -f backend/os-cli/deploy.yaml` 승인 시 롤아웃 검증까지 완료 가능.
2. **F-1 ADR**: cgo 없는 secure-store 방식 결정 → WP-1 secure store 구현.
3. **F-9 UI**: `/manage/cli`에 PAT mint/list/revoke UI(백엔드 기존) + `os login` device-code 플로우 추가.
4. **F-4 서명 파이프라인 + CLI 이미지 재빌드**로 소스 변경을 배포 아티팩트에 반영.
5. **F-7 제품 판단**: OAA 정본 여부 확정 후 테스트/참조 정합.

## 4. 변경 파일 목록

- `backend/os-cli/cmd/os/main.go` — F-2, F-8, F-9(`--web`)
- `backend/os-cli/cmd/os/main_test.go` — F-2·F-9 테스트
- `backend/os-cli/deploy.yaml` — F-6 (라이브 클러스터 적용 완료: 2/2 Running, restart 0)
- `backend/dupa-control/controller.js` — F-3
- `backend/dupa-control/main-shell-base.test.js` — F-2·F-3·F-6 회귀 테스트
- `backend/identity/opensphere-auth/server.mjs` — F-5
- `src/app/pages/admin-cli.ts` — F-9 콘솔 토큰 발급/폐기 UI
