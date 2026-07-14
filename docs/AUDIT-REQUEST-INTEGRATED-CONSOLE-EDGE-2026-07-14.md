# OpenSphere Console `edge` 통합 기술감사 요청서

- 요청일: 2026-07-14
- 감사 대상: OpenSphere 기본 Main Shell, Console-native `os` CLI, CBS, 인증·권한·감사, Setup 기반 `edge` 설치
- 제품 채널: `edge`
- 구현 코드 기준선: `7996d93d4cfd5081b34f85ebc4a4a232e94e0111`
- 구현 증거 기준선: `11a8cc5cf7ff6001441eb734b7358b98789a5bd6`
- Setup 코드 기준선: `52deaf99f47f6142884b4203eecce18744ecb71b`
- 설치 릴리스 잠금: `sha256:c31d0f0351cea07ebee08b6f0631efb7455d151a53995b13a314de066e2d2ecc`
- CI 증거: [GitHub Actions run 29295112016](https://github.com/opensphere-platform/OpenSphere-console/actions/runs/29295112016)
- 요청 상태: 구현 동결, 독립 감사 대기
- 승격 상태: 감사 판정 전 `candidate`·`stable` 승격 금지

## 1. 감사 요청 목적

현재 `edge` 구현이 단순히 화면이 열리고 Pod가 `Running`인 상태인지가 아니라, OpenSphere의 헌법·설계 정책·보안 경계·설치 계약을 실제로 만족하는지 독립 검증을 요청한다.

이번 감사는 다음 네 질문에 각각 답해야 한다.

1. 기본 Main Shell이 어떤 subShell·plugin에도 의존하지 않고 관리 표면으로 독립적으로 서 있는가?
2. Console과 `os`가 동일한 신원·권한·API·영구 감사 경계를 사용하며 우회 관리 경로를 만들지 않았는가?
3. Setup이 깨끗한 Kubernetes 환경에 동일한 `edge` 결과를 사후 수동 수정 없이 재현하고 실패 시 복구할 수 있는가?
4. 현재 구현을 `candidate`로 승격해도 되는가, 아니면 선행 시정이 필요한가?

감사자는 완료 보고서의 결론을 전제로 삼지 말고 코드, 릴리스 잠금, 실제 클러스터, 브라우저, CLI, PostgreSQL 감사 데이터를 독립적으로 대조해야 한다.

## 2. 감사 기준선과 변경 통제

### 2.1 고정 기준선

| 구분 | 고정 값 | 의미 |
|---|---|---|
| Console 구현 | `7996d93d4cfd5081b34f85ebc4a4a232e94e0111` | 감사 대상 애플리케이션 코드 |
| 증거 패킷 | `11a8cc5cf7ff6001441eb734b7358b98789a5bd6` | 완료 보고서와 디자인 QA 증거 |
| Setup 구현 | `52deaf99f47f6142884b4203eecce18744ecb71b` | 설치·검증·업그레이드·롤백 구현 |
| 설치 산출물 | `sha256:c31d0f0351cea07ebee08b6f0631efb7455d151a53995b13a314de066e2d2ecc` | 실제 설치된 `edge` 릴리스 잠금 |
| 이미지 게시 | GitHub Actions `29295112016` | 9개 제품 이미지 빌드·게시 증거 |

이 요청서가 추가되는 문서 전용 커밋은 런타임 구현 기준선을 변경하지 않는다. 감사 도중 기능 추가, 임의 이미지 재태깅, 클러스터 사후 패치, 설치 manifest 직접 수정은 금지한다. 결함 수정이 필요하면 새 기준선을 발행하고 영향 범위를 재감사한다.

### 2.2 감사에서 제외되는 작업 상태

감사는 로컬 작업 트리의 미커밋 문서·시각 자료를 입력으로 사용하지 않는다. 위 커밋과 릴리스 잠금으로 추적 가능한 자료만 정본으로 인정한다. 감사자가 직접 생성한 명령 출력, 스크린샷, 네트워크 기록, 데이터베이스 조회 결과는 별도 증거로 보존한다.

## 3. 정본 문서와 우선순위

충돌 시 아래 순서로 판정한다.

1. [CONSTITUTION-0000 — OpenSphere Constitution](../../_DOCS_/01-CONSTITUTION/CONSTITUTION-0000-OPENSPHERE-CONSTITUTION.md)
2. [CONSTITUTION-0003 — Shell Hosting Integration](../../_DOCS_/01-CONSTITUTION/CONSTITUTION-0003-SHELL-HOSTING-INTEGRATION.md)
3. [CONSTITUTION-0004 — Platform Bootstrap, Support, Foundation Lifecycle](../../_DOCS_/01-CONSTITUTION/CONSTITUTION-0004-PLATFORM-BOOTSTRAP-SUPPORT-FOUNDATION-LIFECYCLE.md)
4. [CONSTITUTION-0005 — OCI Image Channel, Promotion, Installation Policy](../../_DOCS_/01-CONSTITUTION/CONSTITUTION-0005-OCI-IMAGE-CHANNEL-PROMOTION-INSTALLATION-POLICY.md)
5. [DESIGN-GUIDE — 최상위 통합 디자인 정책](../DESIGN-GUIDE.md)
6. [NAMING-STANDARD — 서비스 스택·이미지 명명 기준](NAMING-STANDARD.md)
7. [Setup Release Distribution and Version Selection](../../OpenSphere-Setup-CLI/RELEASE-DISTRIBUTION-AND-VERSION-SELECTION.md)
8. 본 요청서에 고정된 구현 코드와 릴리스 잠금

완료 보고서와 QA 문서는 주장과 기존 검증 기록을 제공하지만 정본 정책보다 우선하지 않는다.

## 4. 감사 대상 아키텍처 불변 조건

다음 조건은 구현 편의에 따라 완화할 수 없는 제품 경계다.

### 4.1 초기 설치와 Main Shell

- OpenSphere는 기존 Kubernetes 위에 설치되는 통합 운영 제품이다.
- 초기 bootstrap은 전문 Kubernetes 지식 없이 실행 가능해야 한다.
- HIS, Cluster Manager, Observability 및 기타 subShell·plugin의 부재가 기본 Console 기동을 막아서는 안 된다.
- 기본 Main Shell 설치 직후 subShell·plugin이 0건인 상태는 의도된 정상 상태다.
- Developer Catalog, APIs, Console CLI, Extensions, 관리자, 역할, Backbone, 알림, 감사는 Console 자체 관리 기능이다.

### 4.2 필수 기반인 CBS

- Console은 CBS(Backbone Service Stack)를 기반으로 선다.
- PostgreSQL은 영구 감사와 Console 상태, RustFS는 오브젝트, Gitea는 config-as-code 경계를 담당한다.
- 영구 감사 저장이 불가능할 때 ConfigMap·메모리로 조용히 대체하거나 성공으로 위장해서는 안 된다.
- CBS 장애는 사용자에게 명확한 degraded 또는 fail-closed 상태로 드러나야 한다.

### 4.3 신원과 CLI

- Console 운영자 신원은 Kanidm이 담당하며 향후 workforce 신원과 구분한다.
- 웹 Console과 `os`는 동일한 신원, RBAC, 관리 API, 감사 경로를 사용한다.
- `os`는 Binding이 아니라 Main Shell이 직접 소유하는 Console-native 기능이다.
- 사람의 CLI 사용은 장치 신뢰와 단기 세션을 사용한다. 반복 PAT 발급을 정상 로그인으로 간주하지 않는다.
- PAT는 비대화형 자동화 전용이며 원문은 생성 직후 한 번만 보여야 한다.

### 4.4 Extension Host

- Console은 미래에 설치될 모든 모듈을 사전 열거하지 않는다.
- `/manage/extensions`와 `os`는 동일한 검증·승인·설치 API를 사용해야 한다.
- 설치 대상은 digest로 고정되고 SDK 계약, 서명, 권한 프로필, 종류, host 관계를 설치 전에 검증해야 한다.
- 검증 실패 모듈은 클러스터에 적용되거나 메뉴에 활성화되어서는 안 된다.

### 4.5 UI와 채널

- 화면 구성요소는 Clarity Design System v18을 기본으로 사용한다.
- Carbon 아이콘은 승인된 예외이고, 제품 로고는 지정된 Open Logos 자원을 사용한다.
- `edge`, `candidate`, `stable`은 의도 기반 설치 채널이며 실제 배포는 서명된 BOM·digest 잠금으로 재현되어야 한다.
- 채널 tag 자체를 실행 정본으로 신뢰해서는 안 된다.

## 5. 현재 구현 범위

### 5.1 Setup과 런타임

- 채널 선택, 서명 릴리스 잠금 해석, 9개 이미지 digest 고정
- 사전 manifest 검증, 적용, rollout·서비스·이미지 잠금 검증
- 실패 시 직전 릴리스 복원 계약
- Console, 인증, backend, DUPA controller, gateway, Kanidm, CBS PostgreSQL·RustFS·Gitea 설치
- `os 0.4.0` 설치 산출물 제공

### 5.2 Main Shell 관리 표면

- `/manage/catalog`: Developer Catalog
- `/manage/apis`: API 목록
- `/manage/cli`: Console-native CLI 정보와 관리 진입
- `/manage/extensions`: OCI digest 검증과 Extension lifecycle
- `/manage/console-admins`: Console 관리자와 사용자별 자동화 토큰 통제
- `/manage/roles`: Console 역할
- `/manage/backbone`: CBS 상태와 세부 기능
- `/manage/observability`: 선택 관측 스택 상태
- `/manage/notifications`: 알림과 우측 상세 패널
- `/manage/audit`: PostgreSQL 영구 감사 조회
- `/me`: 사용자 상세, 그룹·역할, 요청, 리소스, 자격 증명, 보안, 활동

### 5.3 자격 증명과 CLI 신뢰

- Kanidm OIDC PKCE 기반 웹 세션
- P-256 장치 키, 브라우저 승인, challenge 서명, 15분 단기 CLI 세션
- Windows DPAPI, macOS Keychain, Linux Secret Service 개인키 저장 계약
- 사용자별 신뢰 장치 조회·해제
- 자동화 토큰 생성·조회·자기 폐기
- 관리자 사용자별 토큰 메타데이터 조회·사유 기반 강제 폐기
- 토큰 원문 1회 노출, 서버 hash 저장, JTI·만료·상태·최근 사용 관리

### 5.4 영구 감사

- 관리 쓰기는 CBS PostgreSQL `audit_log` 기록 성공과 함께 완료
- 감사 조회는 PostgreSQL 정본 사용
- PostgreSQL 사용 불가 시 `503`으로 실패
- UPDATE·DELETE를 막는 append-only trigger

## 6. 제출된 구현 증거

아래 값은 구현팀의 제출 결과이며 감사자가 독립적으로 재현해야 한다.

| 검증 항목 | 제출 결과 |
|---|---|
| Console 계약 테스트 | 82/82 통과 |
| Production UI build | 성공; bundle·일부 component style budget 경고 존재 |
| Edge 이미지 게시 | 9/9 성공, Actions run `29295112016` |
| Setup upgrade | 직전 잠금에서 `sha256:c31d0f03...`로 성공 |
| Setup verify | 14 Pods / 12 Services / runtime images locked |
| Kubernetes runtime | 14/14 containers Ready, restart 0 |
| CBS | PostgreSQL, RustFS, Gitea Ready |
| `os` | `0.4.0`, 기존 신뢰 장치로 업그레이드 후 `whoami` 성공 |
| 자동화 토큰 | 발급·자기 폐기·관리자 강제 폐기 성공, QA 후 활성 PAT 0건 |
| Catalog/API | Catalog 11건, API 3건 JSON 조회 성공 |
| 영구 감사 | 장치·토큰 이벤트를 PostgreSQL에서 조회 |
| Browser E2E | `/me` 자격 증명 검색·empty·복원·발급·폐기, 관리자별 토큰 통제 성공 |
| 반응형 | 2032×1608, 1024×900, 390×844 확인 |
| 브라우저 오류 | 검증 흐름에서 page error·console error 0건 |

세부 제출 자료:

- [Console Native CLI 구현 완료 보고서](IMPLEMENTATION-REPORT-CONSOLE-NATIVE-CLI-OCI-PARITY-2026-07-14.md)
- [Design QA 기록](../design-qa.md)
- [통합 디자인 정책](../DESIGN-GUIDE.md)

## 7. 필수 감사 영역과 질문

### A. 아키텍처와 소유권

1. Main Shell이 subShell·plugin 0건에서도 인증, 관리, 설치, 감사를 완결하는가?
2. Console 네이티브 기능과 Extension 기능의 소유권이 코드·라우트·API에서 일치하는가?
3. CBS, Foundation Service Stack, Base Service Stack의 명명과 lifecycle 경계가 문서와 구현에서 일관적인가?
4. 미설치 기능을 빈 정상 데이터나 성공 상태로 위장하지 않는가?

### B. 인증·권한·자격 증명 보안

1. OIDC issuer·audience·signature·PKCE·state·nonce 검증이 적절한가?
2. 장치 등록 challenge가 사용자·장치 공개키·만료·1회 사용에 결박되어 replay를 막는가?
3. OS별 개인키 저장소가 실제 구현과 배포 산출물에서 사용되고 평문 fallback이 없는가?
4. 단기 세션 탈취, 신뢰 장치 해제, 사용자 비활성화, 역할 변경이 즉시 또는 허용된 지연 안에 반영되는가?
5. PAT 원문, hash, JTI, 범위, 만료, 폐기, 최근 사용 처리가 로그·UI·API에서 비밀을 노출하지 않는가?
6. 관리자에게 타 사용자 토큰 원문 조회나 대리 발급 우회가 없는가?
7. 개발 TOTP 비활성 정책이 운영 배포로 누출되지 않도록 release gate가 존재하는가?
8. 모든 관리 API가 대상 단위 RBAC와 사유 정책을 서버에서 강제하는가?

### C. CBS와 영구 감사

1. PostgreSQL 장애 시 관리 쓰기가 실제로 fail-closed 되는가?
2. ConfigMap·메모리·브라우저 상태가 감사 정본으로 재등장한 경로가 없는가?
3. actor, source, action, target, reason, result, timestamp, correlation 정보가 사후 추적에 충분한가?
4. append-only 제약을 애플리케이션 계정이나 migration 계정이 우회할 수 없는가?
5. PostgreSQL·RustFS·Gitea의 백업, 복원, 보존, 암호화, 비밀 회전 경계가 제품 요구에 충분한가?

### D. Setup과 릴리스 공급망

1. 완전히 새로운 지원 Kubernetes 환경에서 `edge` bootstrap이 수동 수정 없이 재현되는가?
2. 채널 tag가 아니라 검증된 릴리스 잠금과 digest로 실제 이미지가 결정되는가?
3. BOM 서명자 신뢰, provenance, SBOM, 취약점 검사, 재현성 검증이 변조·rollback 공격을 막는가?
4. 9개 이미지의 이름·registry·digest·architecture가 약속된 단일 제품 namespace 정책을 따르는가?
5. 중간 rollout 실패, API server 단절, 노드 재시작, 부분 적용에서 직전 일관 상태로 복구되는가?
6. 최초 관리자 생성 방식이 안전하면서도 비전문 사용자의 초기 접속을 완결하는가?
7. 운영 환경에서 신뢰 CA와 TOTP 강제가 설치 프로파일로 확실히 전환되는가?

### E. Console과 `os`의 관리 동등성

1. 같은 작업이 GUI와 CLI에서 같은 API, 권한, 검증, 감사를 거치는가?
2. CLI만 사용할 수 있는 비감사 우회 명령이나 클러스터 직접 변경 경로가 없는가?
3. 장치 신뢰가 Console upgrade 후 유지되고 서버 폐기 후에는 다시 사용할 수 없는가?
4. 사람용 device session과 자동화용 PAT의 정책·저장·수명·감사가 분리되어 있는가?
5. `os` command discovery와 server manifest가 HTML fallback·502·구버전 응답을 성공으로 오인하지 않는가?

### F. Extension Host와 설치 필터

1. `/manage/extensions`와 `os` 설치가 동일한 서버 검증 파이프라인을 사용하는가?
2. digest 미고정, 서명 불일치, SDK 계약 불일치, 과도한 권한, 잘못된 kind·hostRef를 적용 전에 거부하는가?
3. 설치, 활성화, 비활성화, 제거, rollback이 원자적이고 영구 감사되는가?
4. Extension 실패가 Main Shell의 로그인·내비게이션·관리 API를 손상하지 않는가?
5. `/p/<id>` 호스팅과 deep link가 네이티브 route namespace와 충돌하지 않는가?
6. 현재 Extension 0건이 정상으로 표현되고 Catalog 인증 실패를 빈 목록으로 위장하지 않는가?

### G. UI·접근성·오류 상태

1. Clarity v18 우선, Carbon 아이콘 예외, 로고 출처 정책이 실제 bundle과 DOM에서 지켜지는가?
2. `/me` 자격 증명 화면과 `/manage/console-admins` 통제가 keyboard, focus, screen reader, 확대, 고대비에서 사용 가능한가?
3. loading, empty, unauthorized, forbidden, backend unavailable, degraded 상태를 서로 구분하는가?
4. 모바일·태블릿·데스크톱에서 표, tab, action, 우측 패널의 정보 손실이나 가로 overflow가 없는가?
5. bundle 4.31 MB 경고와 component style budget 경고가 성능·유지보수 기준에 수용 가능한가?

### H. 운영 준비도

1. readiness가 단순 프로세스 생존이 아니라 인증, CBS, 필수 API 의존성을 반영하는가?
2. 장애 탐지, SLO, 로그·metric·trace, 운영 runbook이 필수 기반과 선택 Observability stack의 경계를 올바르게 다루는가?
3. local-path RWO 환경에서 노드 손실·볼륨 손상·재설치 복구가 어느 수준까지 보장되는가?
4. 비밀 회전, 인증서 만료, 관리자 잠금, 토큰 유출, 감사 저장 장애 대응 절차가 실행 가능한가?

## 8. 알려진 위험과 미검증 항목

아래 항목은 완료로 간주하지 않으며 감사자가 위험도와 승격 조건을 판정해야 한다.

| 항목 | 현재 상태 | 감사 요구 |
|---|---|---|
| TLS | 로컬 자체 서명 인증서, CLI E2E에 개발용 TLS 예외 사용 | 운영 CA 전환과 예외 차단 검증 |
| TOTP | 개발 프로파일에서 비활성 | 운영 프로파일 강제와 우회 불가 검증 |
| 저장소 HA | local-path 단일 replica 제약 | 노드 손실 위험, 외부 백업·복원 및 운영 허용 조건 판정 |
| 최초 관리자 | 설계 요구는 존재하나 최초 admin wizard 전체 브라우저 E2E 증거는 본 패킷에 없음 | 깨끗한 클러스터에서 독립 재현 |
| CLI 다중 OS | Windows 실제 흐름 중심으로 검증 | macOS·Linux key store와 배포 산출물 검증 |
| Observability | 선택 스택 미설치 | 미설치 상태 표현과 설치 후 연동 계약 검증 |
| Extension | 기본 설치 0건 | 악성·불일치 이미지 거부와 정상 표본 lifecycle 독립 시험 |
| UI budgets | build 성공, bundle·style 경고 존재 | 성능 허용 여부와 시정 기준 결정 |
| 채널 | `edge`만 설치 | `candidate` 승격 금지 조건 확인 |
| 운영 복구 | 정상 upgrade·verify 증거 보유 | 중단·부분 실패·rollback·backup restore chaos 시험 |

Cluster Manager, HIS, AI subShell 및 기타 업무 모듈 자체의 기능 품질은 이번 감사 범위가 아니다. 다만 이들을 안전하게 설치할 Extension Host 계약은 감사 범위다.

## 9. 독립 재현 절차

감사자는 최소한 다음 절차를 별도 환경에서 실행하고 원본 출력을 보존한다.

### 9.1 코드·계약 검증

```powershell
git clone https://github.com/opensphere-platform/OpenSphere-console.git
Set-Location OpenSphere-console
git checkout 7996d93d4cfd5081b34f85ebc4a4a232e94e0111
npm ci
npm test
npm run build -- --configuration production
```

- 테스트 개수만 확인하지 말고 보안 실패 경로, RBAC, 영구 감사, device challenge, PAT lifecycle의 assertion을 검토한다.
- frontend가 401·403·502·HTML fallback을 정상 empty state로 바꾸지 않는지 확인한다.

### 9.2 깨끗한 클러스터 설치

1. 지원 버전의 새 Kubernetes cluster와 기본 StorageClass만 준비한다.
2. Setup CLI의 `bootstrap -r edge`를 사용한다.
3. manifest 또는 Deployment를 수동 수정하지 않는다.
4. 설치 릴리스 잠금이 본 요청서의 digest와 일치하는지 확인한다.
5. Setup `verify`, Pod·Service·image digest, rollout history를 수집한다.
6. 중간 실패를 주입해 자동 rollback과 재실행 멱등성을 확인한다.

### 9.3 브라우저 검증

최초 admin 생성부터 로그인한 뒤 최소 다음 route를 실제 브라우저로 검사한다.

- `/me?tab=credentials`
- `/manage/catalog`
- `/manage/apis`
- `/manage/cli`
- `/manage/extensions`
- `/manage/console-admins`
- `/manage/roles`
- `/manage/backbone`
- `/manage/observability`
- `/manage/notifications`
- `/manage/audit`

Desktop, tablet, mobile viewport에서 keyboard-only, focus order, 확대, 오류·권한·장애 상태를 포함해 검사한다. 자체 서명 인증서 경고를 통과했다는 사실과 애플리케이션 정상 동작을 혼동하지 않는다.

### 9.4 CLI와 API 검증

```powershell
os --version
os login
os whoami
os device list
os token list
os catalog list
os api list
os backbone status
os audit list
```

- 최초 장치 승인 이후 새 PAT 없이 session을 갱신할 수 있는지 확인한다.
- 서버에서 장치를 해제한 뒤 기존 개인키로 session 발급이 거부되는지 확인한다.
- 자동화 토큰은 생성 직후 원문 1회 표시, API 호출, 최근 사용 갱신, 폐기 후 거부까지 확인한다.
- GUI와 CLI가 생성한 행위를 PostgreSQL 감사에서 correlation한다.

### 9.5 장애·복구 검증

- PostgreSQL 중단 중 관리 쓰기와 감사 조회
- RustFS·Gitea 중단 중 영향 범위
- Kanidm·gateway·backend 재시작과 session 처리
- 부분 image pull 실패와 Setup rollback
- 노드 재시작과 local-path volume 재부착
- backup에서 새 환경으로 복원 후 감사 연속성

## 10. 감사 결과물 형식

감사 보고서는 각 발견을 다음 형식으로 제출해야 한다.

| 필드 | 필수 내용 |
|---|---|
| ID | 예: `INT-AUD-001` |
| 심각도 | `P0` 치명 / `P1` 높음 / `P2` 중간 / `P3` 낮음 |
| 영역 | Architecture, Identity, CBS, Setup, CLI, Extension, UI, Operations |
| 위반 기준 | 헌법·정책·계약의 정확한 절 또는 코드 경계 |
| 증거 | 명령 출력, HTTP trace, DB row, screenshot, 코드 위치 |
| 영향 | 보안·데이터·복구·운영·사용자 영향 |
| 재현 | 독립 재현 가능한 최소 절차 |
| 시정안 | 소유자, 변경 범위, 완료 조건 |
| 승격 영향 | Block / Conditional / Non-blocking |

다음 판정을 반드시 각각 제시한다.

1. 기본 Main Shell 아키텍처: `ACCEPT / CONDITIONAL / REJECT`
2. 신원·자격 증명·CLI 신뢰 모델: `ACCEPT / CONDITIONAL / REJECT`
3. CBS·영구 감사 모델: `ACCEPT / CONDITIONAL / REJECT`
4. Setup·릴리스 재현성: `ACCEPT / CONDITIONAL / REJECT`
5. Extension Host 준비도: `ACCEPT / CONDITIONAL / REJECT`
6. UI·접근성·오류 표현: `ACCEPT / CONDITIONAL / REJECT`
7. `candidate` 승격: `APPROVE / HOLD / REJECT`
8. 운영 환경 사용: `APPROVE / APPROVE WITH CONDITIONS / REJECT`

`Running`, 단일 happy path, 구현팀 문서 인용만으로 `ACCEPT`하지 않는다. 판정은 독립 실행 증거와 실패 경로 검증을 포함해야 한다.

## 11. 승격 게이트

### 11.1 `candidate` 승격 최소 조건

- 미해결 `P0`·`P1` 0건
- `P2`는 시정 완료 또는 책임자·기한·위험 수용이 승인됨
- 깨끗한 cluster bootstrap, verify, upgrade, rollback 독립 재현 성공
- 인증·RBAC·device trust·PAT·영구 감사 실패 경로 통과
- Extension 설치 필터의 정상·거부·rollback 검증 통과
- 릴리스 잠금, 서명, 9개 이미지 digest 일치
- 활성 QA 토큰·평문 비밀·수동 patch 0건
- 감사 결과와 재현 증거가 버전 관리됨

### 11.2 `stable` 승격 추가 조건

- 신뢰 CA와 운영 TOTP 정책 강제
- 지원 OS별 `os` 설치·장치 key store E2E
- CBS backup·restore와 노드 손실 복구 시험
- 운영 SLO·경보·runbook·비밀 회전 절차 승인
- 성능·접근성·bundle budget 판정 완료
- `candidate` 관찰 기간의 무결성·장애 지표 충족

## 12. 감사 중 운영 원칙

- 신규 subShell·plugin 설치와 기능 확장은 보류한다.
- `edge`의 channel tag를 임의로 이동하거나 동일 tag에 다른 산출물을 덮어쓰지 않는다.
- 감사 발견을 수정하면 새 이미지, 새 릴리스 잠금, 새 증거 기준선을 발행한다.
- 치명 보안 결함 외에는 현 기준선을 보존해 감사 재현성을 유지한다.
- 수정 후에는 영향 영역뿐 아니라 Setup 재현성, 인증, CBS 감사, 핵심 브라우저 흐름을 회귀 검증한다.

## 13. 요청 결론

현재 구현은 기본 Console을 먼저 세우고 그 위에 향후 모듈이 올라선다는 제품 순서를 기준으로 동결되었다. 이번 감사의 목적은 기능 수를 늘리는 것이 아니라, 이 기반이 실제로 안전하고 내구적이며 재현 가능하다는 것을 독립 증거로 확인하는 것이다.

통합 감사가 `candidate` 승격을 승인하기 전까지 현재 결과는 `edge` 구현 완료 후보로만 취급한다. 감사자는 문서상 의도와 실제 코드·클러스터·데이터 경로가 다르면 실제 결과를 우선해 발견으로 기록해야 한다.
