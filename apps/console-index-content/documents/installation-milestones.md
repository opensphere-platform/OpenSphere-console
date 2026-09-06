# OpenSphere Setup · 설치와 제어 능력 확장

> 시험 기준: 2026-09-06 21:10 KST · docker-desktop. 실시간 상태판이 아닌 기준 시점의 시험·설계 기록. 다른 기능의 과거 관측을 최신 수용으로 확대하지 않음.

설명 페이지: https://localhost:1114/#installation (탭 이름 Setup; 기존 주소 유지).

## 현재 판정

22의 삭제·재설치·중복 요청 시험은 cert-manager만 통과했습니다. Ingress·metrics 권한 오류, 검증 4건의 실패 후 대기 표시, 22 종합 응답 오류가 남습니다. Crossplane을 제외해도 전체 제어는 불가합니다.

공통 실행 기반과 owner capability 조회는 있으나 Shell·22의 HISS 명령/대상은 중앙 코드에 고정됨. CLI는 범용 조회·실행 기반 보유.

## 기능 제어의 확장

1. 기능이 제어 계약 제공
2. 설치·활성화 시 OS Shell 검증·등록
3. 권한별 CLI·22·화면 발견
4. 기존 기능 owner 실행
5. 갱신·제거 시 노출 회수와 기록 보존

## Argo CD + Crossplane의 위치

**SRL-L4 · HISS Preflight 이후, Foundation Established 이전**

Argo CD: 승인된 Gitea 선언의 배포·동기화. Crossplane: 선택 adapter의 프로비저닝; core 준비만 조건부 HISS 선행 요소.
Foundation은 L5 consumer. 같은 자원의 owner는 하나. 별도 repo 또는 네 번째 stack을 뜻하지 않음.
이번 작업에서 실제 설치·수용 검증하지 않음

## 설치 단위와 작업

### M01 · OpenSphere-Setup-CLI

Console을 설치하는 최초 진입점

상태: 기동 확인 · 수용 미완료. 기존 Console과 Cluster Manager는 설치돼 있습니다. 공통 HISS 경로는 edge로 발행·배포됐지만 기능별 준비물의 Setup 반영과 수동 보완 없는 클린 재현은 미완료입니다.

진입: 구조적으로 정상인 기존 Kubernetes + 설치 대상/버전/채널 선택

| 작업 | 내용 | 통과 증거 | 관측 |
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

G01: 고정한 배포본으로 Backbone과 네이티브 제어면이 기동하고, 소유권 목록·실패 상태·검증 receipt를 남긴다. 전체 완료는 G02까지 통과해야 한다.

### M02 · OpenSphere-Console

설치 완료를 증명하는 수용 단계

상태: 기반 운영 확인 · 최종 수용 진행. 현재 목표는 공통 OS Shell 실행의 전체 기능 검증과, 각 기능이 제공하는 계약의 등록·발견입니다. HISS 공통 경로 배포와 cert-manager 시험은 통과했으나 자동 확장·전체 HISS·클린 재현은 미완료입니다. 아래 다른 기능의 과거 관측은 최신 수용으로 재사용하지 않습니다.

진입: M01으로 기동한 기존 설치를 보존하고 결함을 수정한다. 지금 클린 삭제하지 않는다.

| 작업 | 내용 | 통과 증거 | 관측 |
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

G02: 전체 필수 기능 수용 → 수정의 공식 배포본 결속 → 소유 자원만 정리한 클린 설치 → 같은 기능 수용 + 재부팅 검증 통과. 동일 바이너리/BOM/schema·설정 의미·결과로 비교하며 새 Secret 값까지 같을 필요는 없다.

### M03 · OpenSphere-Cluster-Manager

기존 제품을 사용해 HISS·Ceph를 관리하고 제어 능력을 확장

상태: 설치됨 · 전체 제어 미완료. 설치된 원래 제품으로 22 시험을 진행했습니다. cert-manager는 삭제·재설치·중복 요청을 통과했지만 나머지는 권한·기록 결함이 있습니다. Crossplane과 공유 관측의 L4 책임은 기본 HISS와 구분합니다.

진입: 기존 Cluster Manager 202609061919와 Console 공통 제어 경로를 사용한다. 조회 전용 대체 제품을 새로 만들지 않는다. 기능별 권한·소유권·실패 복구를 검증한다.

| 작업 | 내용 | 통과 증거 | 관측 |
|---|---|---|---|
| M03-01 · HISS · 실제 제어 범위 | cert-manager는 반복 제어 통과. Ingress·metrics는 권한 오류, CNI·DNS·Storage·Snapshot 검증 4건은 기록 갱신 실패로 중단됐다. | 실패를 Failed로 수렴하고 재시도·설치·삭제·중복 요청을 대상별 검증; 외부 소유 자원 보존 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |
| M03-02 · 기능이 자기 제어 계약 제공 | 각 기능/adapter가 명령 ID·목적·입출력·사용자 권한·부작용·완료·복구·멱등성 규칙과 실행 핸들러를 제공한다. | 기능 패키지와 제어 계약의 버전·소유자 일치; 외부 제품은 OpenSphere adapter가 계약 제공 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |
| M03-03 · OS Shell · 검증과 등록 | 기능 활성화 시 계약의 신뢰·호환성·명령 충돌·실행 준비를 검사해 등록한다. 사용자 권한·MFA·기록은 공통 적용한다. | 신뢰된 계약만 등록; 기능이 자기 권한을 임의 부여하지 않음; 실행은 기존 owner로 전달 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |
| M03-04 · CLI · 22 · 화면이 같은 계약 사용 | CLI는 명령 목록·도움말·입력을, 22는 도구 설명·입력 형식을 받아 사용한다. 관리 화면도 같은 OS Shell 계약을 호출한다. | 공통 계약 지원 기능 추가 시 Console·CLI·22의 기능명별 코드 수정이나 재빌드 없이 제어 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |
| M03-05 · 갱신 · 회수 · 사용자 권한 | 기능 갱신·제거 시 명령과 도구 노출도 갱신한다. 22는 로그인 사용자 권한으로 실행하고 이전 작업·감사 기록은 보존한다. | 권한 회수·stale 계약·owner 장애를 정상으로 숨기지 않음; MFA는 HTTPS localhost·edge에서만 예외 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |
| M03-06 · Ceph · 기반 증거 · 다음 단계 | Storage/CSI와 실제 데이터 경로를 확인하고 필요한 Ceph 연결을 관리한다. Crossplane core는 선택 adapter가 요구할 때만 선행 준비한다. | 기반 증거 이후 L4 배포 기반 준비로 이동. Argo CD·Crossplane adapter 전체를 HISS에 포함하지 않음 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |

G03: 각 기능이 제공한 계약을 OS Shell에 등록하고 화면·CLI·22의 제어·권한·기록·오류·멱등성을 일치시킨다. HISS 항목별 실제 검증과 기능 갱신·제거 후 목록 갱신까지 통과해야 하며 cert-manager 하나의 성공으로 대체하지 않는다.

### M04 · OpenSphere-Foundation

L4 배포 기반을 소비해 필요한 서비스 자원을 제공

상태: 필요 capability부터 상세 설계. Foundation은 L5의 Claim·Binding과 서비스 자원 책임입니다. Argo CD·Crossplane adapter는 L4이며 Foundation 자체나 별도 네 번째 Service Stack이 아닙니다. 이번 페이지 갱신은 이들의 실제 설치·정상 동작을 선언하지 않습니다.

진입: 진입: 필요한 HISS 증거 + L4 Platform Support 배포 계약 + 소비자 요구. Argo CD는 Git 선언을 동기화하고 Crossplane은 선택 adapter일 때 자원을 조정한다.

| 작업 | 내용 | 통과 증거 | 관측 |
|---|---|---|---|
| M04-01 · 소비자 요구 고정 | 후속 제품이 요구하는 DB·object storage·identity 등 capability, 용량, 격리, 복구 기준을 정한다. | 요구→기존 자원 재사용/새 provider 비교; 필요 없는 provider는 제외 | 미착수 · 완료 증거 없음 |
| M04-02 · 선행 L4 · Argo CD + Crossplane | Argo CD는 Gitea의 승인된 선언을 배포·동기화한다. Crossplane은 선택한 provider/adapter의 자원 프로비저닝을 담당한다. Foundation은 이를 소비한다. | Git 선언 → 동기화 → 실제 자원·Binding → 상태·실패·rollback 검증; 같은 자원의 lifecycle owner는 하나 | 계획 / 아래 통과 조건을 실제 실행으로 검증해야 함 |
| M04-03 · 첫 capability 제공 | 확정된 provider 하나로 격리된 자원을 제공하고 credential reference를 소비자에게 연결한다. | 실제 연결/읽기·쓰기; 비밀 값이 browser/Git/로그에 나타나지 않음 | 미착수 · 완료 증거 없음 |
| M04-04 · 수명주기 · 실패 · 회수 | 중복 요청, reconcile 재개, 의존 장애, 자원 해제와 데이터 보존 정책을 검증한다. | 실패가 명시되고 승인 없는 파괴적 삭제 없음 | 미착수 · 완료 증거 없음 |
| M04-05 · 소비자 수용 · 운영 인계 | 후속 module이 Binding을 사용하고 갱신·관측·backup/restore 책임을 인계받는다. | capability별 Ready 증거; 선택한 제품의 dependency gate 통과 | 미착수 · 완료 증거 없음 |

G04: 선택한 capability 하나의 plan→승인→Claim→Binding→소비자 연결과 실패/삭제/복원 정책을 검증한다. 모든 provider 설치를 완료 조건으로 삼지 않는다.

### M05 · OpenSphere-Workspace

사용자가 서비스를 만나는 웹 진입면

상태: 설계 있음 · 설치 수용 전. 신규 설계를 기준으로 구현합니다. Developer 등 독립 제품을 한 Workspace 서버로 통합하거나 subdomain별로 무조건 새 repo를 만들지 않습니다.

진입: G02 + Workforce identity/issuer/audience/host 정책 확정 + 선택한 자원 dependency 준비. Cluster Manager 전체 설치를 무조건 선행 조건으로 삼지 않는다.

| 작업 | 내용 | 통과 증거 | 관측 |
|---|---|---|---|
| M05-01 · SSO · tenant · 권한 | Workforce issuer, audience, claim crosswalk, 세션/회수와 entitlement를 연결한다. | 허용 사용자 로그인·역할 구분 + tenant 경계/회수 검증 | 미착수 · 완료 증거 없음 |
| M05-02 · DNS · TLS · ingress | account/portal/apps의 정확한 host, 신뢰된 인증서, Service 라우팅을 준비한다. | 인증서 우회 없는 HTTPS; 서비스별 host/audience 일치 | 미착수 · 완료 증거 없음 |
| M05-03 · Account · Portal · Apps | 계정 문맥, 역할별 portal, 허용된 앱 발견을 각 artifact로 제공한다. | 실제 권한/상태 반영; loading·empty·denied·degraded 화면 | 미착수 · 완료 증거 없음 |
| M05-04 · 제품 하나 연결 | 서명된 descriptor·canonical host·audience·권한으로 실제 제품 launch를 연결한다. | SSO 이동 + open redirect/미허가 앱 차단 + audit receipt | 미착수 · 완료 증거 없음 |
| M05-05 · 운영 · 개별 rollback | 표면별 상태, 호환성, 배포/rollback과 인증 장애·재부팅 복원을 검증한다. | 한 표면 장애가 다른 제품 데이터/권한을 변경하지 않음 | 미착수 · 완료 증거 없음 |

G05: account→portal→apps→제품 하나의 실제 SSO/권한/launch 여정과 차단·장애·재부팅 검증을 통과한다.

### M06 · OpenSphere-Developer

개발 서비스 · 기존 운영분의 안전한 통합

상태: 별도 서비스 기동 확인 · 통합 미판정. 재부팅 점검에서 Developer/GitLab/별도 Supabase/관측이 기동했습니다. Console 설치 소유 자원이 아니며 클린 재현 때 함께 삭제하지 않습니다.

진입: standalone 또는 console-hosted profile 선택. hosted는 G02와 필요한 identity/자원 계약을 충족; Workspace 연결은 선택이다.

| 작업 | 내용 | 통과 증거 | 관측 |
|---|---|---|---|
| M06-01 · 기존 설치 inventory · TLS | 운영 중인 host, DB, GitLab, PVC, 신원과 소유권을 기록하고 HTTPS 신뢰 문제를 해결한다. | 기존 데이터 보존 + 인증서 우회 없는 접속 | 기동 확인; Developer 인증서 신뢰 실패 |
| M06-02 · Profile · 계약 연결 | standalone/hosted 선택, identity·Git provider·필수 capability와 Console/Workspace 연동을 확정한다. | 중복 Backbone 설치 없이 명시한 profile의 계약 통과 | 미착수 · 완료 증거 없음 |
| M06-03 · 프로젝트 종단 여정 | 실제 프로젝트 하나로 허용된 Git·개발 작업·진행/결과 조회와 감사 경로를 검증한다. | 실제 산출물 + 권한 거절·중복 요청·장애 복원 증거 | 미착수 · 완료 증거 없음 |
| M06-04 · 운영 · upgrade · 재현 | Developer 소유 범위의 배포, 백업/복구, 버전 호환성과 독립 재현을 검증한다. | Console 클린 설치와 데이터 경계 분리; module별 수용 receipt | 미착수 · 완료 증거 없음 |

G06: 선택 profile에서 실제 프로젝트 하나의 Git·작업·결과 조회 여정과 권한/실패/복원 수용 통과.

### M07 · OpenSphere-Pulse

Telemetry · topology · incident 서비스

상태: 재구성 설계 있음 · 설치 수용 전. Console Backbone의 Beszel 설치와 Pulse 제품 설치는 같은 완료 항목이 아닙니다. 재구성 문서가 현재 설치 완료를 뜻하지 않습니다.

진입: standalone/console-hosted profile, 대상·수집 범위·저장/보존 정책·필수 dependency를 확정한다.

| 작업 | 내용 | 통과 증거 | 관측 |
|---|---|---|---|
| M07-01 · 수집 대상 · profile | 첫 대상과 protocol, edge/agent 필요성, 자원·보안·보존 범위를 고정한다. | 수집하지 않는 대상/데이터도 명시; 과잉 agent 배포 0 | 미착수 · 완료 증거 없음 |
| M07-02 · Server · 저장 · 연결 | 선택 profile의 UI/API·데이터 기반·필요 edge/agent를 digest에 고정해 배포한다. | 신원/통신 경계·소유권 inventory·실제 연결 | 미착수 · 완료 증거 없음 |
| M07-03 · Telemetry · topology · incident | 대상 하나의 관측 시각·단절·상태 변화와 선택한 incident 여정을 검증한다. | 실제 데이터 출처·freshness; 단절을 정상으로 은폐하지 않음 | 미착수 · 완료 증거 없음 |
| M07-04 · 보존 · 복원 · 제품 통합 | retention, 재연결/중복 수집, 백업/복구 및 선택한 Console/Workspace 통합을 검증한다. | module별 실패/복원 receipt; Beszel과 책임·중복 수집 구분 | 미착수 · 완료 증거 없음 |

G07: 실제 대상 하나의 수집→저장→조회→상태/incident 여정과 단절·재연결·보존 검증을 통과한다.

### M08 · OpenSphere-AI-Workbench

필요가 확인된 AI 작업 환경

상태: 상세 설계 전. Console의 OSAA를 별도 Workbench 설치로 대체하지 않습니다. Workbench는 별도의 제품 여정과 수용 기준이 필요합니다.

진입: 실제 model/provider·데이터·실행 자원·비용·보안 요구를 먼저 확정. GPU를 기본 필수로 간주하지 않는다.

| 작업 | 내용 | 통과 증거 | 관측 |
|---|---|---|---|
| M08-01 · 첫 작업 · model · 자원 | 실제 필요한 작업 하나와 provider/model, 데이터 분류·quota·CPU/GPU 필요성을 결정한다. | 목표와 비용 상한; GPU 불필요 시 추가 인프라 0 | 미착수 · 완료 증거 없음 |
| M08-02 · 계약 · 권한 · 배포 설계 | API·artifact·runtime·identity·Secret 참조·데이터 격리와 삭제 책임을 구체화한다. | 모듈 완전 설계 표준 + threat/실패·수용 fixture | 미착수 · 완료 증거 없음 |
| M08-03 · 작업 실행 · 결과 · 취소 | 허용 작업의 실행/상태/결과/사용량과 중단·재시도를 연결한다. | 실제 응답/산출물; 승인 없는 외부 전송·권한 밖 실행 차단 | 미착수 · 완료 증거 없음 |
| M08-04 · 운영 · 통합 · 회수 | 선택한 Console/Workspace 연결과 자원 회수·장애 복원·provider 키 회전을 검증한다. | 정책/사용량/결과 receipt; OSAA와 권한·데이터 경계 유지 | 미착수 · 완료 증거 없음 |

G08: 허용 데이터로 작업 하나를 실행하고 결과·사용량·취소·권한·비밀 보호·실패 복원을 검증한다.

## 기준과 출처

- 큰 박스는 책임을 가진 repository 또는 수용 단위다. 작은 박스는 작업과 통과 증거다. 박스 개수가 Pod·이미지·릴리스 수를 뜻하지 않는다.
- 설치·기동, 기능 수용, 재부팅 복원, 클린 설치 재현을 별도로 판정한다. Pod Ready나 HTTP 200만으로 설치 완료를 선언하지 않는다.
- Setup CLI는 최초 Console 기반을 마련하고 종료하는 독립 실행 도구다. 이후 기능 설정·모듈 활성화는 Console의 승인·선언·Owner 실행·receipt 경로로 처리한다.
- 공식 이미지 버전·채널·GHCR·digest 정책을 상속한다. 채널을 선택해도 실행 계획은 불변 digest에 고정하며, Setup 실행 파일 버전과 OCI artifactVersion을 혼동하지 않는다.
- Console의 CLI·OS Shell·OSAA/OSDST·Extension Controller·Registry·Recovery·Gitea bootstrap은 네이티브 기능이다. 별도 제품 설치로 분리하여 Console 완료 조건을 피하지 않는다.
- Foundation은 필요한 서비스 자원을 선언·할당·Binding하는 책임이다. Cluster Manager의 읽기 진단과 구분한다. Foundation Owner API는 내부 역할이며 별도 OpenSphere-Foundation-Owner repository가 아니다.
- Workspace·Developer·Pulse·AI Workbench는 요구와 호환성에 따라 선택한다. 독립 실행 제품에 Workspace 설치를 일률적으로 강제하지 않는다. Design Kit는 공통 빌드 의존성이지 상시 서비스 설치 단계가 아니다.
- 각 기능은 자신의 제어 계약을 제공한다. OS Shell이 공통 정책·기록을 집행하고 CLI·22·GUI가 같은 계약을 소비한다.
- Argo CD·선택적 Crossplane adapter와 공유 관측 runtime은 L4. Crossplane core는 선택 adapter가 요구할 때만 HISS 선행 준비.

- S1 · Setup 설치 책임 경계: `../10-ARTIFACT/ARTIFACT-SETUP-CLI-INSTALLATION-DEVELOPMENT-TOOL.md` — 2026-09-02 Accepted 책임 구분을 사용. 과거 버전/시험 수치는 현재 상태로 재사용하지 않음.
- S2 · Console 네이티브 설치 검증 기록: `../20-MODULE/OpenSphere-Console/90-EVIDENCE/CONSOLE-EVIDENCE-NATIVE-INSTALLATION-VERIFICATION-2026-09-03.md` — 로컬 수정·남은 기능/재현 gate의 증거.
- S3 · 재부팅 후 서비스 복원 점검: `../../.codex-tmp/reboot-service-check-2026-09-04/REBOOT-SERVICE-REPORT.md` — 2026-09-04 00:30–00:36 KST 기동/TLS 관찰. 전체 기능 수용 아님.
- S4 · Console 실제 DB 격리 복원 증거: `../20-MODULE/OpenSphere-Console/90-EVIDENCE/CONSOLE-EVIDENCE-LIVE-RECOVERY-DATABASE-VERIFICATION-2026-09-03.json` — DB 검증 범위만; Storage/Gitea 파일 전체 복원 보증 아님.
- S5 · Console 설계·네이티브 경계: `../20-MODULE/OpenSphere-Console/CONSOLE-DESIGN-INDEX.md` — 기능별 정본과 수용 Matrix를 링크로 상속.
- S6 · HISS 전체 22 실무 시험: `OpenSphere-Platform/DESIGN/20-MODULE/OpenSphere-Cluster-Manager/CLUSTER-MANAGER-HISS-ALL-ITEMS-R2D2-TEST-2026-09-06.md` — 로컬 설계 근거 경로. 제품 공개 URL 또는 현재 설치 완료 증거가 아님.
- S7 · OS Shell 공통 제어 구조: `OpenSphere-Platform/DESIGN/20-MODULE/OpenSphere-Console/02-ARCHITECTURE/CONSOLE-ARCHITECTURE-OS-SHELL-COMMON-CONTROL.md` — 로컬 설계 근거 경로. 제품 공개 URL 또는 현재 설치 완료 증거가 아님.
- S8 · CONSTITUTION-0004 · L4 및 설립 순서: `DOCS/10-ARCHIVE/OpenSphere-Platform-release-r2d2-20260822/_DOCS_/01-CONSTITUTION/CONSTITUTION-0004-PLATFORM-BOOTSTRAP-SUPPORT-FOUNDATION-LIFECYCLE.md` — 로컬 설계 근거 경로. 제품 공개 URL 또는 현재 설치 완료 증거가 아님.
- S9 · C4 모델 C_CLUSTER / C_FAPI / C_FCTL: `../02-ARCHITECTURE/ARCHITECTURE-PLATFORM-C4-MODEL.json` — Owner/Claim/Binding 의미. 상세 배포 계약이나 현재 구현 완료가 아님.
- S10 · Workspace 설계 정본: `../20-MODULE/OpenSphere-Workspace/WORKSPACE-DESIGN-INDEX.md` — account/portal/apps 및 독립 제품 launch 경계.
- S11 · Developer 설계 정본: `../20-MODULE/OpenSphere-Developer/DEVELOPER-DESIGN-INDEX.md` — standalone/console-hosted profile; 현재 runtime은 S3 참조.
- S12 · Pulse 설계 정본: `../20-MODULE/OpenSphere-Pulse/PULSE-DESIGN-INDEX.md` — dual mode 및 telemetry/topology/incident 제품 경계.
- S13 · 제품 domain 대장: `../04-DOMAIN/DOMAIN-PLATFORM-DOMAIN-CATALOG.md` — AI Workbench의 제품 경계. 완전 설치 계약으로 보지 않음.
- S14 · 공식 버전·채널·GHCR 정책: `OPERATIONS-PLATFORM-RELEASE-CHANNEL-POLICY.md` — REL-02 최소 영향, REL-03 버전, REL-04 채널, REL-05 GHCR, digest 고정 기준.
- S15 · 모듈 완전 설계 표준: `../09-GOVERNANCE/GOVERNANCE-MODULE-COMPLETE-DESIGN-DOCUMENT-STANDARD.md` — 후속 모듈 구현 진입 시 필요한 구체 설계 분모.
- S16 · Repository inventory: `../09-GOVERNANCE/GOVERNANCE-PLATFORM-IMPLEMENTATION-REPOSITORY-INVENTORY.json` — repository 경계만 사용. 2026-09-01의 구현 상태는 최신 현황으로 주장하지 않음.

## 배포 경계

Console의 console-index-content 이미지와 같은 Pod의 init container만 갱신한다. 웹 이미지·API·DB·HISS 실행은 변경하지 않는다. 기존 local-dev/www 페이지를 보존한다. 콘텐츠 배포를 기능 구현·전체 설치 완료로 간주하지 않는다.
