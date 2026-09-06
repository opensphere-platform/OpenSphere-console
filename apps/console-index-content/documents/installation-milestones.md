# OpenSphere Setup · 설치와 제어 능력 확장

2026-09-06 사용자 채택 ADR-0015: L4 Platform Support와 L5 Platform Services의 독립 티어. 설계 채택·소스 구현·실행 수용을 구분하며 과거 시험 기록을 현재 Ready로 확대하지 않는다.

> 구현·설계 기록과 실시간 상태를 구분합니다.

## 기존 시험 관측

- at: 2026-09-06 21:10 KST
- context: docker-desktop
- runtime: Console 202609062010 · edge / Cluster Manager 202609061919
- result: 22의 삭제·재설치·중복 요청 시험은 cert-manager만 통과했습니다. Ingress·metrics 권한 오류, 검증 4건의 실패 후 대기 표시, 22 종합 응답 오류가 남습니다. Crossplane을 제외해도 전체 제어는 불가합니다.
- access: 로그인된 Console에서 22 실무 시험 수행. 다른 제품의 과거 TLS 상태는 이번 관측에 포함하지 않음.
- limitation: 실시간 상태판이 아닌 기준 시점의 시험·설계 기록. 다른 기능의 과거 관측을 최신 수용으로 확대하지 않음.

## 다음 단계

기능이 명령·설명·입출력·권한·완료·복구 기준을 제공해야 합니다. OS Shell은 검증·권한·기록을 공통 적용하고 기존 기능에 실행을 전달합니다. CLI·22는 같은 목록을 사용하며 갱신·제거 시 노출도 갱신됩니다.

M00 · 기존 Kubernetes: API·Ready 노드·CNI/DNS·StorageClass·ingress/LB 경로를 제공한다. Setup doctor는 이를 검사하며 클러스터를 임의 교체하지 않는다. 재부팅 복원 점검은 통과했지만 매 설치 직전에 재검사한다.

## 설치 단위와 작업

### M01 · OpenSphere-Setup-CLI

Console을 설치하는 최초 진입점

**기동 확인 · 수용 미완료** — 기존 Console과 Cluster Manager는 설치돼 있습니다. 공통 HISS 경로는 edge로 발행·배포됐지만 기능별 준비물의 Setup 반영과 수동 보완 없는 클린 재현은 미완료입니다.

- 범위: 일회성 실행; Windows 상시 설치·자동 시작 서비스가 아님
- 진입: 구조적으로 정상인 기존 Kubernetes + 설치 대상/버전/채널 선택
- 완료: G01: 고정한 배포본으로 Backbone과 네이티브 제어면이 기동하고, 소유권 목록·실패 상태·검증 receipt를 남긴다. 전체 완료는 G02까지 통과해야 한다.

| 작업 | 내용 | 통과 증거 | 관측 상태 |
|---|---|---|---|
| M01-01 · 공개 배포본 실행 | GitHub에서 독립 실행 파일/배포 archive를 받아 버전·채널을 선택한다. 다운로드 무결성을 검증한다. | 새 실행 환경에서 같은 고정 버전으로 시작; Windows 설치·상주 없음 | 실행 방식 구현; 최종 통합 배포본 수용 대기 |
| M01-02 · 환경 doctor | context, API, schedulable 노드, DNS/CNI, StorageClass, ingress/LB 및 포트 충돌을 검사한다. | 무변경 진단 결과 + 대상 context; 실패 원인과 조치 경계 | 재부팅 점검에서 기반 기동 확인; 다음 실행 시 재검사 |
| M01-03 · OAuth · GHCR 권한 인계 | 장치 인증으로 설치 이미지 접근을 검증하고 운영 중 필요한 최소 pull 권한의 저장·갱신·회수를 인계한다. | private 이미지 pull, 재기동 후 사용, 만료/회수 처리; 토큰 로그 노출 0 | 구현·인증 진행 이력 있음; 전체 수명주기 수용 필요 |
| M01-04 · Release · BOM 고정 | source revision, 공식 버전, 채널, digest, 서명/출처 및 migration 집합을 하나의 계획에 결속한다. | release lock + BOM + 호환성 검증; mutable tag를 실행 중 재해석하지 않음 | 운영 DB migration 32; 게시 배포본과 수정 결속 대기 |
| M01-05 · 설치 소유권 · 기반 자원 | 정확한 관리 namespace, RBAC, Secret, TLS, PVC와 installation lock을 생성한다. | 자원 inventory + idempotent 재실행; 타 설치/Developer/www 보존 | 자원 기동 확인; Console TLS 신뢰 실패 남음 |
| M01-06 · Supabase · Data & Identity | PostgreSQL, Auth, REST, Storage와 역할·schema·migration·Identity bootstrap을 준비한다. | migration checksum + 로그인 + 실제 데이터 읽기/쓰기 + 역할 경계 | DB 읽기·migration 32건 유지 확인; 전체 journey 수용 별도 |
| M01-07 · Gitea · 변경 권위 | 선언 저장소, 보호된 main, 서버 측 신원과 서명·검토·webhook 인계 기반을 준비한다. | repo 보호와 credential 경계; merge→실행→receipt는 M02에서 검증 | Gitea/DB 기동·repo 보존 확인; 변경 실행 인계 미완료 |
| M01-08 · Beszel · 기본 관측 | Hub와 대상 노드 agent를 설치하고 등록·연결·관측 freshness를 확인한다. | 노드별 최근 관측 + 재기동 후 재연결; 과거 데이터만으로 Ready 금지 | Hub/agent 6개 Ready; 전체 수집 freshness 수용 별도 |
| M01-09 · Console · 네이티브 제어면 | Web/API, Registry, CLI, Shell, OSAA/OSDST, Extension Controller와 Recovery 제어면을 release BOM대로 구성한다. | 컴포넌트 readiness + endpoint; 외부 연동 미설정은 설명 가능한 상태 | 기동 확인; 기능 완성/수용은 M02 진행 중 |
| M01-10 · 설치 상태 · 재개 · receipt | 단계별 진행·실패 원인·재개 지점을 기록한다. 모든 필수 postcondition 후에만 Ready를 선언한다. | Preparing/Installing/Ready 구분; 중단 후 재개·중복 부작용 0 | 부분 설치 복구 진행 이력; 최종 자동 수용 미완료 |

### M02 · OpenSphere-Console

설치 완료를 증명하는 수용 단계

**기반 운영 확인 · 최종 수용 진행** — 현재 목표는 공통 OS Shell 실행의 전체 기능 검증과, 각 기능이 제공하는 계약의 등록·발견입니다. HISS 공통 경로 배포와 cert-manager 시험은 통과했으나 자동 확장·전체 HISS·클린 재현은 미완료입니다. 아래 다른 기능의 과거 관측은 최신 수용으로 재사용하지 않습니다.

- 범위: Console 소유 네이티브 기능; 별도 제품으로 분리하지 않음
- 진입: M01으로 기동한 기존 설치를 보존하고 결함을 수정한다. 지금 클린 삭제하지 않는다.
- 완료: G02: 전체 필수 기능 수용 → 수정의 공식 배포본 결속 → 소유 자원만 정리한 클린 설치 → 같은 기능 수용 + 재부팅 검증 통과. 동일 바이너리/BOM/schema·설정 의미·결과로 비교하며 새 Secret 값까지 같을 필요는 없다.

| 작업 | 내용 | 통과 증거 | 관측 상태 |
|---|---|---|---|
| M02-01 · HTTPS · 로그인 · 화면 | 신뢰되는 HTTPS에서 로그인하고 필수 route·역할·오류/빈 상태·API를 확인한다. | 인증서 우회 없이 접속; 필수 화면의 예상 밖 5xx 없음 | 09-06 로그인된 Console에서 22 실무 시험 수행. 전체 화면·TLS 수용을 이번 부분 시험으로 대체하지 않음. |
| M02-02 · OS Shell · 공통 실행 기반 | 화면·CLI·22가 같은 명령, 현재 사용자 권한, MFA, 작업 기록과 멱등성 규칙을 사용한다. 기능별 실행은 기존 owner에 남긴다. | 같은 사용자·요청 ID의 동일 결과, 권한 회수·중복 요청·오류 처리 일치 | 공통 경로 배포 및 cert-manager 범위 통과. 새 기능 계약의 자동 등록은 미완료. |
| M02-03 · 22 · 계약 발견과 결과 전달 | 22는 OS Shell의 권한별 명령 설명·입력 계약을 읽어 도구를 선택한다. 응답 저장까지 성공해야 사용자 작업을 완료로 표시한다. | 기능 추가 후 22 코드 수정 없이 발견·실행; 응답 유실을 완료로 표시하지 않음 | DeepSeek 실요청으로 cert-manager 반복 제어 통과. 종합 조회 24,000자 오류와 고정 대상 목록은 개선 필요. |
| M02-04 · 기능 활성화 · 제어 계약 등록 | 서명된 기능 활성화에 제어 계약의 소유자·버전·호환성·권한 검증을 연결한다. 비활성화·제거 시 명령 노출을 회수한다. | 새 기능 설치·갱신·제거 후 화면·CLI·22 목록 일치; 기존 감사 기록 보존 | 기존 Cluster Manager Activated 확인. 범용 제어 계약 등록·갱신은 미완료. |
| M02-05 · Platform Release | 승인된 Gitea 변경이 정확한 Owner 실행과 release 상태·receipt로 이어지도록 완성한다. | merge/webhook→실행→postcondition→receipt; 실패·중복 요청 검증 | 이전 미완료 기록. 이번 HISS 시험에서 Platform Release 전체 실행은 재검증하지 않음. |
| M02-06 · Repair Runner | native operation/schema와 허용된 repair executor를 연결하고 영향·실패·재개를 표시한다. | 진단→허용 계획→승인→실행→복구 결과; 권한 우회 0 | 이전 미완료 기록. 이번 HISS 시험에서 Repair Runner 전체 경로는 재검증하지 않음. |
| M02-07 · Recovery · 복원 증거 | 백업 대상/운영 API·receipt를 연결하고 DB·Storage·Gitea 파일의 실제 복원 무결성을 검증한다. | DB 권한/데이터 + 파일 hash/object mapping + Git 무결성; 격리 복원 증거 | Supabase/Gitea DB 검증 통과; 파일 무결성·운영 경로 미완료 |
| M02-08 · 실패 · 재부팅 · 운영 인계 | 의존 서비스 장애, 권한 만료, 중단/재개, 재부팅 뒤 접근·상태·실행 결과를 확인한다. | UI·API·DB·관측·Secret 수명주기의 실패/복원 receipt | 재부팅 기동 점검 통과; TLS/전체 사용자 기능은 별도 |
| M02-09 · 검증한 수정의 배포본 결속 | 수정한 source·migration·installer·BOM을 정리하고 영향받는 이미지만 정책대로 발행한다. | source SHA→GHCR digest→Setup 검증 자료→실행 inventory 일치 | Console 202609062010 · edge의 공통 제어 경로 발행·배포 확인. 전체 기능·클린 재현 완료는 아님. |
| M02-10 · 클린 설치 재현 | 기능 수용 후 Console 설치 소유 자원만 정리하고 공개 Setup으로 다시 설치한다. | 같은 전체 수용 행렬 재통과; 수동 패치·source mount 없이 설치 완료 | 미실행; Developer/www/타 설치는 삭제 대상 아님 |

### M03 · OpenSphere-Cluster-Manager

기존 제품을 사용해 HISS·Ceph를 관리하고 제어 능력을 확장

**설치됨 · 전체 제어 미완료** — 설치된 원래 제품으로 22 시험을 진행했습니다. cert-manager는 삭제·재설치·중복 요청을 통과했지만 나머지는 권한·기록 결함이 있습니다. Crossplane과 공유 관측의 L4 책임은 기본 HISS와 구분합니다.

- 범위: 기존 Cluster Manager가 실행 owner; OS Shell은 공통 제어 중심
- 진입: 기존 Cluster Manager 202609061919와 Console 공통 제어 경로를 사용한다. 조회 전용 대체 제품을 새로 만들지 않는다. 기능별 권한·소유권·실패 복구를 검증한다.
- 완료: G03: 각 기능이 제공한 계약을 OS Shell에 등록하고 화면·CLI·22의 제어·권한·기록·오류·멱등성을 일치시킨다. HISS 항목별 실제 검증과 기능 갱신·제거 후 목록 갱신까지 통과해야 하며 cert-manager 하나의 성공으로 대체하지 않는다.

| 작업 | 내용 | 통과 증거 | 관측 상태 |
|---|---|---|---|
| M03-01 · HISS · 실제 제어 범위 | cert-manager는 반복 제어 통과. Ingress·metrics는 권한 오류, CNI·DNS·Storage·Snapshot 검증 4건은 기록 갱신 실패로 중단됐다. | 실패를 Failed로 수렴하고 재시도·설치·삭제·중복 요청을 대상별 검증; 외부 소유 자원 보존 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |
| M03-02 · 기능이 자기 제어 계약 제공 | 각 기능/adapter가 명령 ID·목적·입출력·사용자 권한·부작용·완료·복구·멱등성 규칙과 실행 핸들러를 제공한다. | 기능 패키지와 제어 계약의 버전·소유자 일치; 외부 제품은 OpenSphere adapter가 계약 제공 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |
| M03-03 · OS Shell · 검증과 등록 | 기능 활성화 시 계약의 신뢰·호환성·명령 충돌·실행 준비를 검사해 등록한다. 사용자 권한·MFA·기록은 공통 적용한다. | 신뢰된 계약만 등록; 기능이 자기 권한을 임의 부여하지 않음; 실행은 기존 owner로 전달 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |
| M03-04 · CLI · 22 · 화면이 같은 계약 사용 | CLI는 명령 목록·도움말·입력을, 22는 도구 설명·입력 형식을 받아 사용한다. 관리 화면도 같은 OS Shell 계약을 호출한다. | 공통 계약 지원 기능 추가 시 Console·CLI·22의 기능명별 코드 수정이나 재빌드 없이 제어 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |
| M03-05 · 갱신 · 회수 · 사용자 권한 | 기능 갱신·제거 시 명령과 도구 노출도 갱신한다. 22는 로그인 사용자 권한으로 실행하고 이전 작업·감사 기록은 보존한다. | 권한 회수·stale 계약·owner 장애를 정상으로 숨기지 않음; MFA는 HTTPS localhost·edge에서만 예외 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |
| M03-06 · Ceph · 기반 증거 · 다음 단계 | Storage/CSI와 실제 데이터 경로를 확인하고 필요한 Ceph 연결을 관리한다. Crossplane core는 선택 adapter가 요구할 때만 선행 준비한다. | 기반 증거 이후 L4 배포 기반 준비로 이동. Argo CD·Crossplane adapter 전체를 HISS에 포함하지 않음 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |

### L4-Platform-Support · OpenSphere-Platform-Support

배포·동기화 · 자원 adapter · 운영 통제

**구현 진행 · 배포 전** — 원본 Foundation의 Argo CD·Crossplane 화면을 독립 소스로 추출했고 로컬 빌드·경계 테스트를 통과했습니다. 신규 신뢰 키·권한 프로필은 보안 승인 대기입니다. 실제 L4 설치·22 운용·클린 재현은 아직 완료되지 않았습니다.

- 범위: C_SUPPORT · Foundation과 별도 repository·artifact·수명주기
- 진입: Console OS Shell + 선택 기능의 HISS·권한·설치 증거. L5 Foundation 없이 진입 가능. Crossplane core가 필요하면 기존 Cluster Manager가 준비한다.
- 완료: L4 자체 설치·재부팅·갱신·회수와 GUI·CLI·22의 동일 명령·권한·작업 기록을 검증한다. 선택 capability별 Ready 증거를 제공하며 L5 데이터·기존 CM을 변경하지 않는다.

| 작업 | 내용 | 통과 증거 | 관측 상태 |
|---|---|---|---|
| L4-01 · 독립 모듈 설치·발견 | 기존 Argo CD·Crossplane 기능을 독립 배포물로 제공한다. 서명·채널·버전·호환성을 확인하고 Console Registry에서 발견한다. | 검증된 artifact만 활성화; L5 없는 기동·제거와 별도 업그레이드 | 소스 분리·빌드 완료 / 신뢰 등록·설치 대기 |
| L4-02 · Argo CD · 배포 동기화 | 승인된 Gitea 선언과 고정 revision을 관측·동기화한다. L4가 서비스 요구나 버전을 임의 결정하지 않는다. | 실제 revision 비교, 중복 요청 기록, drift·실패 명시 | OS Shell 명령 구현 / 실제 환경 수용 전 |
| L4-03 · Crossplane · 선택적 adapter | provider 구성·상태는 L4. core 설치·제거는 기존 Cluster Manager. 기존 ProviderConfig를 임의 덮어쓰지 않는다. | 미선택이면 해당 없음; 동일 자원에 단일 writer, 충돌 차단 | 명령·멱등성 테스트 통과 / 실제 환경 수용 전 |
| L4-04 · 공통 제어 계약 · GUI·CLI·22 | 기능이 명령·입출력·위험·완료 조건을 제공한다. OS Shell은 사용자 권한·MFA·멱등성·기록을 집행하고 각 클라이언트가 같은 목록을 사용한다. | 등록·갱신·회수 반영, 세 경로의 같은 결과·기록 | 서명 계약 발견 코드 구현 / 통합 배포 전 |
| L4-05 · 관측·복구·정책 운영 | 기존 관측·복구·정책 owner와 연결해 선택 서비스의 운영 증거를 제공한다. 새 controller나 observability stack을 자동 도입하지 않는다. | fresh 상태, 복원 시험, 필수 capability와 해당 없음 구분 | 계약 설계 / 연결·복원 실증 미완료 |

### M04 · OpenSphere-Foundation

Platform Services · 요구한 공통 서비스를 제공

**필요 capability부터 상세 설계** — L5 제품은 기존 OpenSphere-Foundation을 유지합니다. 공통 서비스의 Claim·Instance·Binding·데이터 수명주기가 책임입니다. 기존 원본을 확보했으며, L4 분리 뒤 소비 계약과 실제 서비스 수용 시험은 남아 있습니다.

- 범위: C_FAPI / C_FCTL · 하나의 OpenSphere-Foundation repository
- 진입: Console 공통 제어 + 소비자가 선택한 서비스의 L4 capability·HISS 증거. 미선택 Crossplane이나 모든 provider의 설치를 강제하지 않는다.
- 완료: G04: 선택한 capability 하나의 plan→승인→Claim→Binding→소비자 연결과 실패/삭제/복원 정책을 검증한다. 모든 provider 설치를 완료 조건으로 삼지 않는다.

| 작업 | 내용 | 통과 증거 | 관측 상태 |
|---|---|---|---|
| M04-01 · 소비자 요구 고정 | 후속 제품이 요구하는 DB·object storage·identity 등 capability, 용량, 격리, 복구 기준을 정한다. | 요구→기존 자원 재사용/새 provider 비교; 필요 없는 provider는 제외 | 미착수 · 완료 증거 없음 |
| M04-02 · 서비스 Owner · Plan·Claim·Binding | 서비스 요구·자격·용량·데이터 정책을 검증해 Plan·Claim·Instance·Binding으로 제공한다. L4에는 필요한 배포·자원 기능만 계약으로 요청하며 같은 자원에 두 writer를 두지 않는다. | 서비스마다 상태 권위 하나, 기존 데이터 보존, OS Shell의 동일 권한·기록·멱등성 적용 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |
| M04-03 · 첫 capability 제공 | 확정된 provider 하나로 격리된 자원을 제공하고 credential reference를 소비자에게 연결한다. | 실제 연결/읽기·쓰기; 비밀 값이 browser/Git/로그에 나타나지 않음 | 미착수 · 완료 증거 없음 |
| M04-04 · 수명주기 · 실패 · 회수 | 중복 요청, reconcile 재개, 의존 장애, 자원 해제와 데이터 보존 정책을 검증한다. | 실패가 명시되고 승인 없는 파괴적 삭제 없음 | 미착수 · 완료 증거 없음 |
| M04-05 · 소비자 수용 · 운영 인계 | 후속 module이 Binding을 사용하고 갱신·관측·backup/restore 책임을 인계받는다. | capability별 Ready 증거; 선택한 제품의 dependency gate 통과 | 미착수 · 완료 증거 없음 |

### M05 · OpenSphere-Workspace

사용자가 서비스를 만나는 웹 진입면

**설계 있음 · 설치 수용 전** — 신규 설계를 기준으로 구현합니다. Developer 등 독립 제품을 한 Workspace 서버로 통합하거나 subdomain별로 무조건 새 repo를 만들지 않습니다.

- 범위: account · portal · apps는 한 repo의 별도 artifact; 제품은 각 repo 소유
- 진입: G02 + Workforce identity/issuer/audience/host 정책 확정 + 선택한 자원 dependency 준비. Cluster Manager 전체 설치를 무조건 선행 조건으로 삼지 않는다.
- 완료: G05: account→portal→apps→제품 하나의 실제 SSO/권한/launch 여정과 차단·장애·재부팅 검증을 통과한다.

| 작업 | 내용 | 통과 증거 | 관측 상태 |
|---|---|---|---|
| M05-01 · SSO · tenant · 권한 | Workforce issuer, audience, claim crosswalk, 세션/회수와 entitlement를 연결한다. | 허용 사용자 로그인·역할 구분 + tenant 경계/회수 검증 | 미착수 · 완료 증거 없음 |
| M05-02 · DNS · TLS · ingress | account/portal/apps의 정확한 host, 신뢰된 인증서, Service 라우팅을 준비한다. | 인증서 우회 없는 HTTPS; 서비스별 host/audience 일치 | 미착수 · 완료 증거 없음 |
| M05-03 · Account · Portal · Apps | 계정 문맥, 역할별 portal, 허용된 앱 발견을 각 artifact로 제공한다. | 실제 권한/상태 반영; loading·empty·denied·degraded 화면 | 미착수 · 완료 증거 없음 |
| M05-04 · 제품 하나 연결 | 서명된 descriptor·canonical host·audience·권한으로 실제 제품 launch를 연결한다. | SSO 이동 + open redirect/미허가 앱 차단 + audit receipt | 미착수 · 완료 증거 없음 |
| M05-05 · 운영 · 개별 rollback | 표면별 상태, 호환성, 배포/rollback과 인증 장애·재부팅 복원을 검증한다. | 한 표면 장애가 다른 제품 데이터/권한을 변경하지 않음 | 미착수 · 완료 증거 없음 |

### M06 · OpenSphere-Developer

개발 서비스 · 기존 운영분의 안전한 통합

**별도 서비스 기동 확인 · 통합 미판정** — 재부팅 점검에서 Developer/GitLab/별도 Supabase/관측이 기동했습니다. Console 설치 소유 자원이 아니며 클린 재현 때 함께 삭제하지 않습니다.

- 범위: 기존 독립 운영 상태를 보존하고 통합 여부를 별도 판단
- 진입: standalone 또는 console-hosted profile 선택. hosted는 G02와 필요한 identity/자원 계약을 충족; Workspace 연결은 선택이다.
- 완료: G06: 선택 profile에서 실제 프로젝트 하나의 Git·작업·결과 조회 여정과 권한/실패/복원 수용 통과.

| 작업 | 내용 | 통과 증거 | 관측 상태 |
|---|---|---|---|
| M06-01 · 기존 설치 inventory · TLS | 운영 중인 host, DB, GitLab, PVC, 신원과 소유권을 기록하고 HTTPS 신뢰 문제를 해결한다. | 기존 데이터 보존 + 인증서 우회 없는 접속 | 기동 확인; Developer 인증서 신뢰 실패 |
| M06-02 · Profile · 계약 연결 | standalone/hosted 선택, identity·Git provider·필수 capability와 Console/Workspace 연동을 확정한다. | 중복 Backbone 설치 없이 명시한 profile의 계약 통과 | 미착수 · 완료 증거 없음 |
| M06-03 · 프로젝트 종단 여정 | 실제 프로젝트 하나로 허용된 Git·개발 작업·진행/결과 조회와 감사 경로를 검증한다. | 실제 산출물 + 권한 거절·중복 요청·장애 복원 증거 | 미착수 · 완료 증거 없음 |
| M06-04 · 운영 · upgrade · 재현 | Developer 소유 범위의 배포, 백업/복구, 버전 호환성과 독립 재현을 검증한다. | Console 클린 설치와 데이터 경계 분리; module별 수용 receipt | 미착수 · 완료 증거 없음 |

### M07 · OpenSphere-Pulse

Telemetry · topology · incident 서비스

**재구성 설계 있음 · 설치 수용 전** — Console Backbone의 Beszel 설치와 Pulse 제품 설치는 같은 완료 항목이 아닙니다. 재구성 문서가 현재 설치 완료를 뜻하지 않습니다.

- 범위: 독립 실행과 Console hosted를 구분; agent/edge는 대상별 최소 배치
- 진입: standalone/console-hosted profile, 대상·수집 범위·저장/보존 정책·필수 dependency를 확정한다.
- 완료: G07: 실제 대상 하나의 수집→저장→조회→상태/incident 여정과 단절·재연결·보존 검증을 통과한다.

| 작업 | 내용 | 통과 증거 | 관측 상태 |
|---|---|---|---|
| M07-01 · 수집 대상 · profile | 첫 대상과 protocol, edge/agent 필요성, 자원·보안·보존 범위를 고정한다. | 수집하지 않는 대상/데이터도 명시; 과잉 agent 배포 0 | 미착수 · 완료 증거 없음 |
| M07-02 · Server · 저장 · 연결 | 선택 profile의 UI/API·데이터 기반·필요 edge/agent를 digest에 고정해 배포한다. | 신원/통신 경계·소유권 inventory·실제 연결 | 미착수 · 완료 증거 없음 |
| M07-03 · Telemetry · topology · incident | 대상 하나의 관측 시각·단절·상태 변화와 선택한 incident 여정을 검증한다. | 실제 데이터 출처·freshness; 단절을 정상으로 은폐하지 않음 | 미착수 · 완료 증거 없음 |
| M07-04 · 보존 · 복원 · 제품 통합 | retention, 재연결/중복 수집, 백업/복구 및 선택한 Console/Workspace 통합을 검증한다. | module별 실패/복원 receipt; Beszel과 책임·중복 수집 구분 | 미착수 · 완료 증거 없음 |

### M08 · OpenSphere-AI-Workbench

필요가 확인된 AI 작업 환경

**상세 설계 전** — Console의 OSAA를 별도 Workbench 설치로 대체하지 않습니다. Workbench는 별도의 제품 여정과 수용 기준이 필요합니다.

- 범위: 제품 domain; OSAA 네이티브 assistant와 구분
- 진입: 실제 model/provider·데이터·실행 자원·비용·보안 요구를 먼저 확정. GPU를 기본 필수로 간주하지 않는다.
- 완료: G08: 허용 데이터로 작업 하나를 실행하고 결과·사용량·취소·권한·비밀 보호·실패 복원을 검증한다.

| 작업 | 내용 | 통과 증거 | 관측 상태 |
|---|---|---|---|
| M08-01 · 첫 작업 · model · 자원 | 실제 필요한 작업 하나와 provider/model, 데이터 분류·quota·CPU/GPU 필요성을 결정한다. | 목표와 비용 상한; GPU 불필요 시 추가 인프라 0 | 미착수 · 완료 증거 없음 |
| M08-02 · 계약 · 권한 · 배포 설계 | API·artifact·runtime·identity·Secret 참조·데이터 격리와 삭제 책임을 구체화한다. | 모듈 완전 설계 표준 + threat/실패·수용 fixture | 미착수 · 완료 증거 없음 |
| M08-03 · 작업 실행 · 결과 · 취소 | 허용 작업의 실행/상태/결과/사용량과 중단·재시도를 연결한다. | 실제 응답/산출물; 승인 없는 외부 전송·권한 밖 실행 차단 | 미착수 · 완료 증거 없음 |
| M08-04 · 운영 · 통합 · 회수 | 선택한 Console/Workspace 연결과 자원 회수·장애 복원·provider 키 회전을 검증한다. | 정책/사용량/결과 receipt; OSAA와 권한·데이터 경계 유지 | 미착수 · 완료 증거 없음 |

## 공통 규칙

- 큰 박스는 책임을 가진 repository 또는 수용 단위다. 작은 박스는 작업과 통과 증거다. 박스 개수가 Pod·이미지·릴리스 수를 뜻하지 않는다.
- 설치·기동, 기능 수용, 재부팅 복원, 클린 설치 재현을 별도로 판정한다. Pod Ready나 HTTP 200만으로 설치 완료를 선언하지 않는다.
- Setup CLI는 최초 Console 기반을 마련하고 종료하는 독립 실행 도구다. 이후 기능 설정·모듈 활성화는 Console의 승인·선언·Owner 실행·receipt 경로로 처리한다.
- 공식 이미지 버전·채널·GHCR·digest 정책을 상속한다. 채널을 선택해도 실행 계획은 불변 digest에 고정하며, Setup 실행 파일 버전과 OCI artifactVersion을 혼동하지 않는다.
- Console의 CLI·OS Shell·OSAA/OSDST·Extension Controller·Registry·Recovery·Gitea bootstrap은 네이티브 기능이다. 별도 제품 설치로 분리하여 Console 완료 조건을 피하지 않는다.
- L4 OpenSphere-Platform-Support는 독립 운영 기반, L5 OpenSphere-Foundation은 공통 서비스 요구·Claim·Instance·Binding·데이터 수명주기 책임이다. 하나의 설치 묶음이 아니며 필요한 capability 계약으로 연결한다.
- Workspace·Developer·Pulse·AI Workbench는 요구와 호환성에 따라 선택한다. 독립 실행 제품에 Workspace 설치를 일률적으로 강제하지 않는다. Design Kit는 공통 빌드 의존성이지 상시 서비스 설치 단계가 아니다.
- 각 기능은 자신의 제어 계약을 제공한다. OS Shell이 공통 정책·기록을 집행하고 CLI·22·GUI가 같은 계약을 소비한다.
- Argo CD·선택적 Crossplane adapter와 공유 관측 runtime은 L4. Crossplane core는 선택 adapter가 요구할 때만 HISS 선행 준비.
- Module/Feature, 10P×6L, repo명=설계 폴더, 서명·GHCR·채널·불변 버전, OS Shell 공통 제어, OsPanel Drawer·폰트·로고 정책을 상속한다. 관측/복구/정책의 기존 owner를 무조건 교체하지 않는다.

## 기능 확장

- status: PartiallyImplemented
- **flow**
  - 기능이 제어 계약 제공
  - 설치·활성화 시 OS Shell 검증·등록
  - 권한별 CLI·22·화면 발견
  - 기존 기능 owner 실행
  - 갱신·제거 시 노출 회수와 기록 보존
- gap: 공통 실행 기반과 owner capability 조회는 있으나 Shell·22의 HISS 명령/대상은 중앙 코드에 고정됨. CLI는 범용 조회·실행 기반 보유.

## L4 독립 티어

- layer: SRL-L4
- position: HISS Preflight 이후, Foundation Established 이전
- argoCd: 승인된 Gitea 선언의 배포·동기화
- crossplane: 선택 adapter의 프로비저닝; core 준비만 조건부 HISS 선행 요소
- ownership: Foundation은 L5 consumer. 같은 자원의 owner는 하나. 별도 repo 또는 네 번째 stack을 뜻하지 않음.
- acceptance: 이번 작업에서 실제 설치·수용 검증하지 않음
- decision: ADR-0015 / Accepted
- tier: SRL-L4
- module: OpenSphere-Platform-Support
- independentFrom: OpenSphere-Foundation / SRL-L5
- runtimeAcceptance: not-complete
- securityRegistration: approval-required
- sourceBaseline: OpenSphere-shell-foundation 5e3217bffc1b7a331260459d34b7a857f45f6c8b

## 결정

- D-MILESTONE-01
- 기존 승인 계승
- Setup은 최초 기반, Console은 후속 설정·승인·운영. Console 네이티브 기능을 후속 별도 제품으로 밀어내지 않는다.
- D-MILESTONE-02
- 사용자 완료 기준
- 필수 기능 수용 후 공개 Setup 클린 설치에서 동일 수용을 재통과해야 Console 설치 완료다.
- D-MILESTONE-03
- 현재 구현 및 보완
- 기존 Cluster Manager와 공통 HISS 실행 경로는 배포됐다. 자동 제어 계약 확장과 전체 기능 수용을 보강한다.
- D-MILESTONE-04
- 의존성 기반 제안
- Foundation은 첫 자원 요구에 맞춰 최소 도입; 후속 제품은 선택. Workspace는 standalone 제품의 강제 선행 조건이 아니다.
- D-MILESTONE-05
- 2026-09-06 Accepted 요구 / 구현 미완료
- 기능이 제어 계약 제공 → 설치·활성화 시 OS Shell 검증·등록 → 권한별 CLI·22·화면 발견 → 기존 기능 owner 실행 → 갱신·제거 시 노출 회수와 기록 보존

## 미결 질문

- id: Q01
- when: 자동 확장 구현
- question: 공통 실행 기반과 owner capability 조회는 있으나 Shell·22의 HISS 명령/대상은 중앙 코드에 고정됨. CLI는 범용 조회·실행 기반 보유.
- Q02
- M04 진입 전
- 첫 소비자 capability와 provider, 기존 자원 재사용 여부를 정한다. Ceph·HA 등은 요구 근거가 있어야 한다.
- Q03
- M05 진입 전
- Workforce IdP/issuer/audience, production host, tenant 규모와 최소 앱 하나를 정한다.
- Q04
- M06–M08 진입 전
- 첫 선택 제품과 profile, SLO/RPO/RTO·데이터 보존·비용·운영 책임을 고정한다.
- Q05
- 각 게이트 실행 전
- 아직 없는 실행 명령·이미지·namespace를 추정해서 쓰지 않는다. 구현/발행 후 정확한 version/digest와 실행 증거를 기록한다.

## Gate 기록

- gateId / 판정(Pass·Fail·NotRun)
- 검사 시각 / 담당자 / 대상 context·installation ID
- source revision / Setup version / channel / artifact digest / BOM·migration checksum
- 검사 분모 / 정상·거절·실패 fixture / 실행 결과
- 실행 전후 resource inventory / postcondition / receipt·audit correlation
- rollback·복구 대상 / 잔여 결함 / 다음 진입 허용 여부

## 출처

- id: S1
- title: Setup 설치 책임 경계
- path: ../10-ARTIFACT/ARTIFACT-SETUP-CLI-INSTALLATION-DEVELOPMENT-TOOL.md
- note: 2026-09-02 Accepted 책임 구분을 사용. 과거 버전/시험 수치는 현재 상태로 재사용하지 않음.
- id: S2
- title: Console 네이티브 설치 검증 기록
- path: ../20-MODULE/OpenSphere-Console/90-EVIDENCE/CONSOLE-EVIDENCE-NATIVE-INSTALLATION-VERIFICATION-2026-09-03.md
- note: 로컬 수정·남은 기능/재현 gate의 증거.
- id: S3
- title: 재부팅 후 서비스 복원 점검
- path: ../../.codex-tmp/reboot-service-check-2026-09-04/REBOOT-SERVICE-REPORT.md
- note: 2026-09-04 00:30–00:36 KST 기동/TLS 관찰. 전체 기능 수용 아님.
- id: S4
- title: Console 실제 DB 격리 복원 증거
- path: ../20-MODULE/OpenSphere-Console/90-EVIDENCE/CONSOLE-EVIDENCE-LIVE-RECOVERY-DATABASE-VERIFICATION-2026-09-03.json
- note: DB 검증 범위만; Storage/Gitea 파일 전체 복원 보증 아님.
- id: S5
- title: Console 설계·네이티브 경계
- path: ../20-MODULE/OpenSphere-Console/CONSOLE-DESIGN-INDEX.md
- note: 기능별 정본과 수용 Matrix를 링크로 상속.
- id: S6
- title: HISS 전체 22 실무 시험
- path: OpenSphere-Platform/DESIGN/20-MODULE/OpenSphere-Cluster-Manager/CLUSTER-MANAGER-HISS-ALL-ITEMS-R2D2-TEST-2026-09-06.md
- note: 로컬 설계 근거 경로. 제품 공개 URL 또는 현재 설치 완료 증거가 아님.
- id: S7
- title: OS Shell 공통 제어 구조
- path: OpenSphere-Platform/DESIGN/20-MODULE/OpenSphere-Console/02-ARCHITECTURE/CONSOLE-ARCHITECTURE-OS-SHELL-COMMON-CONTROL.md
- note: 로컬 설계 근거 경로. 제품 공개 URL 또는 현재 설치 완료 증거가 아님.
- id: S8
- title: CONSTITUTION-0004 · L4 및 설립 순서
- path: DOCS/10-ARCHIVE/OpenSphere-Platform-release-r2d2-20260822/_DOCS_/01-CONSTITUTION/CONSTITUTION-0004-PLATFORM-BOOTSTRAP-SUPPORT-FOUNDATION-LIFECYCLE.md
- note: 로컬 설계 근거 경로. 제품 공개 URL 또는 현재 설치 완료 증거가 아님.
- id: S9
- title: C4 모델 C_CLUSTER / C_FAPI / C_FCTL
- path: ../02-ARCHITECTURE/ARCHITECTURE-PLATFORM-C4-MODEL.json
- note: Owner/Claim/Binding 의미. 상세 배포 계약이나 현재 구현 완료가 아님.
- id: S10
- title: Workspace 설계 정본
- path: ../20-MODULE/OpenSphere-Workspace/WORKSPACE-DESIGN-INDEX.md
- note: account/portal/apps 및 독립 제품 launch 경계.
- id: S11
- title: Developer 설계 정본
- path: ../20-MODULE/OpenSphere-Developer/DEVELOPER-DESIGN-INDEX.md
- note: standalone/console-hosted profile; 현재 runtime은 S3 참조.
- id: S12
- title: Pulse 설계 정본
- path: ../20-MODULE/OpenSphere-Pulse/PULSE-DESIGN-INDEX.md
- note: dual mode 및 telemetry/topology/incident 제품 경계.
- id: S13
- title: 제품 domain 대장
- path: ../04-DOMAIN/DOMAIN-PLATFORM-DOMAIN-CATALOG.md
- note: AI Workbench의 제품 경계. 완전 설치 계약으로 보지 않음.
- id: S14
- title: 공식 버전·채널·GHCR 정책
- path: OPERATIONS-PLATFORM-RELEASE-CHANNEL-POLICY.md
- note: REL-02 최소 영향, REL-03 버전, REL-04 채널, REL-05 GHCR, digest 고정 기준.
- id: S15
- title: 모듈 완전 설계 표준
- path: ../09-GOVERNANCE/GOVERNANCE-MODULE-COMPLETE-DESIGN-DOCUMENT-STANDARD.md
- note: 후속 모듈 구현 진입 시 필요한 구체 설계 분모.
- id: S16
- title: Repository inventory
- path: ../09-GOVERNANCE/GOVERNANCE-PLATFORM-IMPLEMENTATION-REPOSITORY-INVENTORY.json
- note: repository 경계만 사용. 2026-09-01의 구현 상태는 최신 현황으로 주장하지 않음.

## 의존 관계

| 선행 | 소비자 | 조건 |
|---|---|---|
| M00 | M01 | 환경 전제 |
| M01 | M02 | 기존 설치를 보존한 기능 수용 |
| M02 | M01 | 검증한 수정을 배포본에 반영하고 클린 재현 |
| G02 | M04 | 요구 자원/Owner 계약이 필요한 경우 |
| G02 | M05–M08 | Console hosted 통합 경로 |
| M04 | M05–M08 | 선택한 제품이 요구하는 capability만 |
| M05 | M06–M08 | Workforce 발견·SSO·launch 통합 선택 시; standalone의 필수 선행 아님 |
| M02 | M03 | 기존 Cluster Manager 활성화와 OS Shell 공통 제어 |
| M03 | L1-HIS-Preflight | 기반 실제 증거와 제어 계약 검증 |
| L1-HIS-Preflight | L4-Platform-Support | Argo CD와 선택 adapter 준비 |
| L4-Platform-Support | M04 | 선택 서비스가 요구한 capability만; L4 전체 일괄 설치 아님 |
