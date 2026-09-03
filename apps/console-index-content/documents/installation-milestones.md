# OpenSphere 설치 이정표

> 문서 ID: OS-INSTALL-MILESTONES · 개정: 2026-09-04 · 상태: 진행 순서 제안
> 정본 데이터: [이정표 계획](OPERATIONS-PLATFORM-INSTALLATION-MILESTONE-PLAN.json). 이 문서는 같은 데이터에서 생성한다.
> 설명 페이지: [OpenSphere Console · 설치 이정표](https://localhost:1114/#installation).

기존 승인된 제품 경계를 따르는 실행 순서 제안. 문서 작성 요청은 후속 모듈의 설치·삭제·신규 기술 도입 승인이 아니다.

## 현재 위치와 바로 다음 단계

재부팅 후 서비스 기동과 Console 기반 런타임을 확인했습니다. 기능 수용·공식 배포본 결속·클린 설치 재현은 진행 중입니다.

- 관찰: 2026-09-04 00:30–00:36 KST / docker-desktop
- 기동: 6/6 노드 · 65/65 활성 Pod Ready · 13/13 PVC Bound
- 접근: Console과 Developer의 HTTPS 신뢰 검증 실패가 남음. www 설계 페이지는 TLS 신뢰 검증 통과.
- 한계: 이 페이지는 기준 시점의 기록이며 실시간 상태판이 아닙니다. 단계 전환 전 다시 검증합니다.

**M02의 남은 네이티브 기능 수용과 G02 클린 재현은 최종 릴리스 게이트로 계속 진행합니다. M03 Cluster Manager의 범위·계약과 read-only 진단 slice는 지금 병행 착수할 수 있습니다. 승인 쓰기 작업은 필요한 Console Owner 경로와 G02 결과에 연계합니다.**

M00 · 기존 Kubernetes: API·Ready 노드·CNI/DNS·StorageClass·ingress/LB 경로를 제공한다. Setup doctor는 이를 검사하며 클러스터를 임의 교체하지 않는다. 재부팅 복원 점검은 통과했지만 매 설치 직전에 재검사한다.

Cluster Manager와 Foundation의 모듈 설계·구현 폴더가 비어 있는 것을 2026-09-04 파일 확인으로 재확인했다. 상세 계약·게시 이미지·실행 명령이 준비됐다는 의미로 이정표를 읽지 않는다. 기존 구현 상태를 이 문서만으로 승격하지 않는다.

## 책임과 순서

1. 큰 박스는 책임을 가진 repository 또는 수용 단위다. 작은 박스는 작업과 통과 증거다. 박스 개수가 Pod·이미지·릴리스 수를 뜻하지 않는다.
2. 설치·기동, 기능 수용, 재부팅 복원, 클린 설치 재현을 별도로 판정한다. Pod Ready나 HTTP 200만으로 설치 완료를 선언하지 않는다.
3. Setup CLI는 최초 Console 기반을 마련하고 종료하는 독립 실행 도구다. 이후 기능 설정·모듈 활성화는 Console의 승인·선언·Owner 실행·receipt 경로로 처리한다.
4. 공식 이미지 버전·채널·GHCR·digest 정책을 상속한다. 채널을 선택해도 실행 계획은 불변 digest에 고정하며, Setup 실행 파일 버전과 OCI artifactVersion을 혼동하지 않는다.
5. Console의 CLI·OS Shell·OSAA/OSDST·Extension Controller·Registry·Recovery·Gitea bootstrap은 네이티브 기능이다. 별도 제품 설치로 분리하여 Console 완료 조건을 피하지 않는다.
6. Cluster Manager는 기존 클러스터의 진단·제한된 승인 작업을 담당한다. Ceph가 없으면 미설치/해당 없음으로 표시한다. 이정표 통과를 위해 Ceph·메시·새 컨트롤러를 일괄 도입하지 않는다.
7. Foundation은 필요한 서비스 자원을 선언·할당·Binding하는 책임이다. Cluster Manager의 읽기 진단과 구분한다. Foundation Owner API는 내부 역할이며 별도 OpenSphere-Foundation-Owner repository가 아니다.
8. Workspace·Developer·Pulse·AI Workbench는 요구와 호환성에 따라 선택한다. 독립 실행 제품에 Workspace 설치를 일률적으로 강제하지 않는다. Design Kit는 공통 빌드 의존성이지 상시 서비스 설치 단계가 아니다.

| 연결 | 조건 |
|---|---|
| M00 → M01 | 환경 전제 |
| M01 → M02 | 기존 설치를 보존한 기능 수용 |
| M02 → M01 | 검증한 수정을 배포본에 반영하고 클린 재현 |
| M02 → M03 | Console 기반 운영 확인 후 read-only 설계·구현 병행; 승인 쓰기·최종 설치는 G02 결과 연계 |
| G02 → M04 | 요구 자원/Owner 계약이 필요한 경우 |
| M03 → M04 | 인프라 요구가 확인된 경우만; 읽기 진단에 Foundation 강제 의존 없음 |
| G02 → M05–M08 | Console hosted 통합 경로 |
| M04 → M05–M08 | 선택한 제품이 요구하는 capability만 |
| M05 → M06–M08 | Workforce 발견·SSO·launch 통합 선택 시; standalone의 필수 선행 아님 |

M01의 bootstrap과 M02의 제품 수용은 한 설치 과정의 다른 책임이다. M02가 source 수정을 검증하면 M01의 배포본에 반영하여 클린 재현한다. G02는 Console 전체 설치를 닫는 결합 gate다. M03 read-only 진단은 M02와 병행할 수 있으며 Foundation을 강제하지 않지만, 승인 action이 Foundation 소유 자원을 변경한다면 해당 M04 계약·capability를 먼저 갖춰야 한다.

## 이정표 요약

| ID | 책임 단위 | 기준 시점 상태 | 다음 단계 조건 |
|---|---|---|---|
| M01 | OpenSphere-Setup-CLI | 기동 확인 · 수용 미완료 | 필수 |
| M02 | OpenSphere-Console | 기반 운영 확인 · 최종 수용 진행 | 필수 · 최종 릴리스 게이트 |
| M03 | OpenSphere-Cluster-Manager | 읽기 진단 설계·구현 착수 가능 | 다음 구현 대상 · read-only부터 |
| M04 | OpenSphere-Foundation | 필요 capability부터 상세 설계 | 제품의 자원 요구가 있을 때 |
| M05 | OpenSphere-Workspace | 설계 있음 · 설치 수용 전 | Workforce 진입면을 제공할 때 |
| M06 | OpenSphere-Developer | 별도 서비스 기동 확인 · 통합 미판정 | 개발 서비스를 선택할 때 |
| M07 | OpenSphere-Pulse | 재구성 설계 있음 · 설치 수용 전 | 관측 제품을 선택할 때 |
| M08 | OpenSphere-AI-Workbench | 상세 설계 전 | AI workload 요구가 있을 때 |

표시 의미: 기동 관찰 = 지정 검사 범위에서 관찰; 부분 확인 = 일부 증거만 있음; 미완료 = 완료 차단 항목; 계획 = 아직 수용 증거 없음; 조건부 = 소비자 요구로 범위 확정 후 진행. 어느 것도 전체 설치의 Pass를 대신하지 않는다.

## M01 · OpenSphere-Setup-CLI

**Console을 설치하는 최초 진입점** · 01 · Bootstrap · 기동 확인 · 수용 미완료

- 적용: 필수
- 범위: 일회성 실행; Windows 상시 설치·자동 시작 서비스가 아님
- 진입 조건: 구조적으로 정상인 기존 Kubernetes + 설치 대상/버전/채널 선택
- 기준 시점: 기존 설치는 기동 중입니다. 로컬 수정과 운영 보완이 공개 배포본에 모두 결속되지 않아 클린 재현은 아직 보증하지 않습니다.
- 완료 조건: **G01: 고정한 배포본으로 Backbone과 네이티브 제어면이 기동하고, 소유권 목록·실패 상태·검증 receipt를 남긴다. 전체 완료는 G02까지 통과해야 한다.**
- 출처: S1, S2, S3, S4

| 작업 ID / 기능 | 해야 할 작업 | 통과 증거 | 기준 시점 판정 |
|---|---|---|---|
| M01-01 · 공개 배포본 실행 | GitHub에서 독립 실행 파일/배포 archive를 받아 버전·채널을 선택한다. 다운로드 무결성을 검증한다. | 새 실행 환경에서 같은 고정 버전으로 시작; Windows 설치·상주 없음 | 부분 확인 — 실행 방식 구현; 최종 통합 배포본 수용 대기 |
| M01-02 · 환경 doctor | context, API, schedulable 노드, DNS/CNI, StorageClass, ingress/LB 및 포트 충돌을 검사한다. | 무변경 진단 결과 + 대상 context; 실패 원인과 조치 경계 | 기동 관찰 — 재부팅 점검에서 기반 기동 확인; 다음 실행 시 재검사 |
| M01-03 · OAuth · GHCR 권한 인계 | 장치 인증으로 설치 이미지 접근을 검증하고 운영 중 필요한 최소 pull 권한의 저장·갱신·회수를 인계한다. | private 이미지 pull, 재기동 후 사용, 만료/회수 처리; 토큰 로그 노출 0 | 부분 확인 — 구현·인증 진행 이력 있음; 전체 수명주기 수용 필요 |
| M01-04 · Release · BOM 고정 | source revision, 공식 버전, 채널, digest, 서명/출처 및 migration 집합을 하나의 계획에 결속한다. | release lock + BOM + 호환성 검증; mutable tag를 실행 중 재해석하지 않음 | 부분 확인 — 운영 DB migration 32; 게시 배포본과 수정 결속 대기 |
| M01-05 · 설치 소유권 · 기반 자원 | 정확한 관리 namespace, RBAC, Secret, TLS, PVC와 installation lock을 생성한다. | 자원 inventory + idempotent 재실행; 타 설치/Developer/www 보존 | 부분 확인 — 자원 기동 확인; Console TLS 신뢰 실패 남음 |
| M01-06 · Supabase · Data & Identity | PostgreSQL, Auth, REST, Storage와 역할·schema·migration·Identity bootstrap을 준비한다. | migration checksum + 로그인 + 실제 데이터 읽기/쓰기 + 역할 경계 | 기동 관찰 — DB 읽기·migration 32건 유지 확인; 전체 journey 수용 별도 |
| M01-07 · Gitea · 변경 권위 | 선언 저장소, 보호된 main, 서버 측 신원과 서명·검토·webhook 인계 기반을 준비한다. | repo 보호와 credential 경계; merge→실행→receipt는 M02에서 검증 | 부분 확인 — Gitea/DB 기동·repo 보존 확인; 변경 실행 인계 미완료 |
| M01-08 · Beszel · 기본 관측 | Hub와 대상 노드 agent를 설치하고 등록·연결·관측 freshness를 확인한다. | 노드별 최근 관측 + 재기동 후 재연결; 과거 데이터만으로 Ready 금지 | 기동 관찰 — Hub/agent 6개 Ready; 전체 수집 freshness 수용 별도 |
| M01-09 · Console · 네이티브 제어면 | Web/API, Registry, CLI, Shell, OSAA/OSDST, Extension Controller와 Recovery 제어면을 release BOM대로 구성한다. | 컴포넌트 readiness + endpoint; 외부 연동 미설정은 설명 가능한 상태 | 부분 확인 — 기동 확인; 기능 완성/수용은 M02 진행 중 |
| M01-10 · 설치 상태 · 재개 · receipt | 단계별 진행·실패 원인·재개 지점을 기록한다. 모든 필수 postcondition 후에만 Ready를 선언한다. | Preparing/Installing/Ready 구분; 중단 후 재개·중복 부작용 0 | 부분 확인 — 부분 설치 복구 진행 이력; 최종 자동 수용 미완료 |

## M02 · OpenSphere-Console

**설치 완료를 증명하는 수용 단계** · 02 · 수용 마감 · 기반 운영 확인 · 최종 수용 진행

- 적용: 필수 · 최종 릴리스 게이트
- 범위: Console 소유 네이티브 기능; 별도 제품으로 분리하지 않음
- 진입 조건: M01으로 기동한 기존 설치를 보존하고 결함을 수정한다. 지금 클린 삭제하지 않는다.
- 기준 시점: Console 기반 서비스와 네이티브 런타임은 운영 중입니다. Platform Release 실행 Owner, Repair Runner 실행 경로, 사용자 OS Shell·OSAA 종단 시험, 파일 Recovery, 공식 배포본 결속과 클린 재현이 남아 있습니다. 이 항목은 Cluster Manager read-only slice 착수를 막지 않습니다.
- 완료 조건: **G02: 전체 필수 기능 수용 → 수정의 공식 배포본 결속 → 소유 자원만 정리한 클린 설치 → 같은 기능 수용 + 재부팅 검증 통과. 동일 바이너리/BOM/schema·설정 의미·결과로 비교하며 새 Secret 값까지 같을 필요는 없다.**
- 출처: S2, S3, S4, S5

| 작업 ID / 기능 | 해야 할 작업 | 통과 증거 | 기준 시점 판정 |
|---|---|---|---|
| M02-01 · HTTPS · 로그인 · 화면 | 신뢰되는 HTTPS에서 로그인하고 필수 route·역할·오류/빈 상태·API를 확인한다. | 인증서 우회 없이 접속; 필수 화면의 예상 밖 5xx 없음 | 미완료 — Console TLS 신뢰 실패; 전체 브라우저 journey 미검증 |
| M02-02 · OS CLI · OS Shell | 사용자 명령, 세션 연결/재연결, 권한 회수와 실행 종료를 검증한다. | 허용 명령 성공 + 거부/회수 이후 실행 차단 + 감사 기록 | 부분 확인 — Shell Ready·heartbeat·부팅 후 attach 확인; 실제 명령 cycle 미완료 |
| M02-03 · OSAA · OSDST | 설정된 provider의 실제 응답, 대화 상태 저장·재개, 승인 없는 mutation 차단을 확인한다. | 실제 응답 + 대화 재개 + 권한 거절 시험 | 부분 확인 — readiness 200; 실제 provider/사용자 종단 수용 미완료 |
| M02-04 · Registry · Extension Controller | 배포물 조회·호환성·권한을 검사하고 허용된 모듈 활성화/비활성화 경로를 검증한다. | descriptor→계획→승인→적용→상태/receipt; unsigned·비호환 거절 | 부분 확인 — 서비스 기동 확인; 후속 모듈 설치의 종단 증거 필요 |
| M02-05 · Platform Release | 승인된 Gitea 변경이 정확한 Owner 실행과 release 상태·receipt로 이어지도록 완성한다. | merge/webhook→실행→postcondition→receipt; 실패·중복 요청 검증 | 미완료 — 상태 조회 보완과 실제 승인 변경 실행은 별개; 실행 경로 미완료 |
| M02-06 · Repair Runner | native operation/schema와 허용된 repair executor를 연결하고 영향·실패·재개를 표시한다. | 진단→허용 계획→승인→실행→복구 결과; 권한 우회 0 | 미완료 — 네이티브 실행 경로 미완료 |
| M02-07 · Recovery · 복원 증거 | 백업 대상/운영 API·receipt를 연결하고 DB·Storage·Gitea 파일의 실제 복원 무결성을 검증한다. | DB 권한/데이터 + 파일 hash/object mapping + Git 무결성; 격리 복원 증거 | 부분 확인 — Supabase/Gitea DB 검증 통과; 파일 무결성·운영 경로 미완료 |
| M02-08 · 실패 · 재부팅 · 운영 인계 | 의존 서비스 장애, 권한 만료, 중단/재개, 재부팅 뒤 접근·상태·실행 결과를 확인한다. | UI·API·DB·관측·Secret 수명주기의 실패/복원 receipt | 부분 확인 — 재부팅 기동 점검 통과; TLS/전체 사용자 기능은 별도 |
| M02-09 · 검증한 수정의 배포본 결속 | 수정한 source·migration·installer·BOM을 정리하고 영향받는 이미지만 정책대로 발행한다. | source SHA→GHCR digest→Setup 검증 자료→실행 inventory 일치 | 미완료 — 로컬 소스 마운트/수정 남음; 최종 발행 전 |
| M02-10 · 클린 설치 재현 | 기능 수용 후 Console 설치 소유 자원만 정리하고 공개 Setup으로 다시 설치한다. | 같은 전체 수용 행렬 재통과; 수동 패치·source mount 없이 설치 완료 | 미완료 — 미실행; Developer/www/타 설치는 삭제 대상 아님 |

## M03 · OpenSphere-Cluster-Manager

**다음 구현 대상 · 클러스터를 관리 가능한 상태로** · 03 · 병행 착수 · 읽기 진단 설계·구현 착수 가능

- 적용: 다음 구현 대상 · read-only부터
- 범위: C_CLUSTER · 인프라 진단과 제한된 작업; 범용 kubectl 실행기 아님
- 진입 조건: Console 기반 운영 확인 + cluster-manager API/권한/배포/수용 명세. 설계와 read-only 진단 slice는 지금 착수한다. 승인 쓰기 작업은 필요한 Console Owner 경로와 G02 결과에 연계한다.
- 기준 시점: 현재 경계 문서가 있으며 read-only 최소 slice의 구체 설계·구현을 착수할 수 있습니다. 아직 설치 명령이나 게시 이미지가 준비된 상태는 아닙니다.
- 완료 조건: **G03: 기존 cluster를 안전하게 등록·조회하고 상태의 근거·시각·장애를 설명한다. 필요한 승인 action 하나를 선택한 Owner 경로로 검증한다. read-only slice와 write slice의 완료를 구분한다.**
- 출처: S6, S7, S8

| 작업 ID / 기능 | 해야 할 작업 | 통과 증거 | 기준 시점 판정 |
|---|---|---|---|
| M03-01 · 설치 가능한 최소 계약 | 첫 화면·API/schema·권한·배포 artifact·namespace·제거/rollback·수용 fixture를 확정한다. | 완전 설계 표준에 맞춘 최소 기능 묶음 + 호환성/자원 명세 | 계획 — 미착수 · 완료 증거 없음 |
| M03-02 · 기존 cluster 등록 | docker-desktop의 대상/범위/신원을 명시하고 이미 존재하는 자원을 관측 대상으로 연결한다. | 중복 등록/쓰기 부작용 없음; Secret 노출 없는 cluster 식별 | 계획 — 미착수 · 완료 증거 없음 |
| M03-03 · 상태 · 근거 · freshness | 노드, workload, event, network/DNS, storage 상태를 출처·관측 시각과 함께 제공한다. | UI와 API 실측 일치; 단절·권한 부족·stale을 정상으로 표시하지 않음 | 계획 — 미착수 · 완료 증거 없음 |
| M03-04 · Storage · Ceph 구분 | 현재 StorageClass/PVC를 우선 진단한다. Ceph는 설치되어 있거나 실제 요구가 있을 때만 연결한다. | Ceph 없음은 해당 없음; 기존 standard SC로 충족하면 새 storage 설치 0 | 계획 — 미착수 · 완료 증거 없음 |
| M03-05 · 제한된 승인 작업 | 실제 필요한 action 하나의 Owner·권한·계획·승인·idempotency·postcondition을 연결한다. | JNY-01 정상/실패 receipt; Foundation 필요 시 M04의 최소 capability 연결 | 계획 — 미착수 · 완료 증거 없음 |
| M03-06 · Console에서 설치·관측·회수 | 서명된 배포물과 호환성을 확인해 Console을 통해 설치하고 장애·upgrade·비활성화를 검증한다. | 해당 module inventory·감사·rollback; 기존 cluster/Console 데이터 보존 | 계획 — 미착수 · 완료 증거 없음 |

## M04 · OpenSphere-Foundation

**필요한 기반 서비스만 선언하고 제공** · 04 · 조건부 기반 · 필요 capability부터 상세 설계

- 적용: 제품의 자원 요구가 있을 때
- 범위: C_FAPI / C_FCTL · 하나의 OpenSphere-Foundation repository
- 진입 조건: G02 + 요구 capability·운영 Owner·provider 선택. M03의 읽기 진단과 독립적으로 계약을 설계할 수 있다.
- 기준 시점: 공통 C4/Owner 개념은 있으나 모듈 상세 설계·구현 폴더는 비어 있습니다. 첫 provider와 저장소·메시·HA 필요성은 요구 근거로 결정해야 합니다.
- 완료 조건: **G04: 선택한 capability 하나의 plan→승인→Claim→Binding→소비자 연결과 실패/삭제/복원 정책을 검증한다. 모든 provider 설치를 완료 조건으로 삼지 않는다.**
- 출처: S8, S9

| 작업 ID / 기능 | 해야 할 작업 | 통과 증거 | 기준 시점 판정 |
|---|---|---|---|
| M04-01 · 소비자 요구 고정 | 후속 제품이 요구하는 DB·object storage·identity 등 capability, 용량, 격리, 복구 기준을 정한다. | 요구→기존 자원 재사용/새 provider 비교; 필요 없는 provider는 제외 | 계획 — 미착수 · 완료 증거 없음 |
| M04-02 · Owner · 계약 · 배포 설계 | capability/catalog/plan/apply/status와 Claim/Binding, 최소 RBAC·실행 책임을 구체화한다. | 하나의 상태 권위; 필요 없는 중간 service/controller 추가 0 | 계획 — 미착수 · 완료 증거 없음 |
| M04-03 · 첫 capability 제공 | 확정된 provider 하나로 격리된 자원을 제공하고 credential reference를 소비자에게 연결한다. | 실제 연결/읽기·쓰기; 비밀 값이 browser/Git/로그에 나타나지 않음 | 계획 — 미착수 · 완료 증거 없음 |
| M04-04 · 수명주기 · 실패 · 회수 | 중복 요청, reconcile 재개, 의존 장애, 자원 해제와 데이터 보존 정책을 검증한다. | 실패가 명시되고 승인 없는 파괴적 삭제 없음 | 계획 — 미착수 · 완료 증거 없음 |
| M04-05 · 소비자 수용 · 운영 인계 | 후속 module이 Binding을 사용하고 갱신·관측·backup/restore 책임을 인계받는다. | capability별 Ready 증거; 선택한 제품의 dependency gate 통과 | 계획 — 미착수 · 완료 증거 없음 |

## M05 · OpenSphere-Workspace

**사용자가 서비스를 만나는 웹 진입면** · 05 · 선택 확장 · 설계 있음 · 설치 수용 전

- 적용: Workforce 진입면을 제공할 때
- 범위: account · portal · apps는 한 repo의 별도 artifact; 제품은 각 repo 소유
- 진입 조건: G02 + Workforce identity/issuer/audience/host 정책 확정 + 선택한 자원 dependency 준비. Cluster Manager 전체 설치를 무조건 선행 조건으로 삼지 않는다.
- 기준 시점: 신규 설계를 기준으로 구현합니다. Developer 등 독립 제품을 한 Workspace 서버로 통합하거나 subdomain별로 무조건 새 repo를 만들지 않습니다.
- 완료 조건: **G05: account→portal→apps→제품 하나의 실제 SSO/권한/launch 여정과 차단·장애·재부팅 검증을 통과한다.**
- 출처: S10

| 작업 ID / 기능 | 해야 할 작업 | 통과 증거 | 기준 시점 판정 |
|---|---|---|---|
| M05-01 · SSO · tenant · 권한 | Workforce issuer, audience, claim crosswalk, 세션/회수와 entitlement를 연결한다. | 허용 사용자 로그인·역할 구분 + tenant 경계/회수 검증 | 계획 — 미착수 · 완료 증거 없음 |
| M05-02 · DNS · TLS · ingress | account/portal/apps의 정확한 host, 신뢰된 인증서, Service 라우팅을 준비한다. | 인증서 우회 없는 HTTPS; 서비스별 host/audience 일치 | 계획 — 미착수 · 완료 증거 없음 |
| M05-03 · Account · Portal · Apps | 계정 문맥, 역할별 portal, 허용된 앱 발견을 각 artifact로 제공한다. | 실제 권한/상태 반영; loading·empty·denied·degraded 화면 | 계획 — 미착수 · 완료 증거 없음 |
| M05-04 · 제품 하나 연결 | 서명된 descriptor·canonical host·audience·권한으로 실제 제품 launch를 연결한다. | SSO 이동 + open redirect/미허가 앱 차단 + audit receipt | 계획 — 미착수 · 완료 증거 없음 |
| M05-05 · 운영 · 개별 rollback | 표면별 상태, 호환성, 배포/rollback과 인증 장애·재부팅 복원을 검증한다. | 한 표면 장애가 다른 제품 데이터/권한을 변경하지 않음 | 계획 — 미착수 · 완료 증거 없음 |

## M06 · OpenSphere-Developer

**개발 서비스 · 기존 운영분의 안전한 통합** · 05 · 선택 확장 · 별도 서비스 기동 확인 · 통합 미판정

- 적용: 개발 서비스를 선택할 때
- 범위: 기존 독립 운영 상태를 보존하고 통합 여부를 별도 판단
- 진입 조건: standalone 또는 console-hosted profile 선택. hosted는 G02와 필요한 identity/자원 계약을 충족; Workspace 연결은 선택이다.
- 기준 시점: 재부팅 점검에서 Developer/GitLab/별도 Supabase/관측이 기동했습니다. Console 설치 소유 자원이 아니며 클린 재현 때 함께 삭제하지 않습니다.
- 완료 조건: **G06: 선택 profile에서 실제 프로젝트 하나의 Git·작업·결과 조회 여정과 권한/실패/복원 수용 통과.**
- 출처: S3, S11

| 작업 ID / 기능 | 해야 할 작업 | 통과 증거 | 기준 시점 판정 |
|---|---|---|---|
| M06-01 · 기존 설치 inventory · TLS | 운영 중인 host, DB, GitLab, PVC, 신원과 소유권을 기록하고 HTTPS 신뢰 문제를 해결한다. | 기존 데이터 보존 + 인증서 우회 없는 접속 | 미완료 — 기동 확인; Developer 인증서 신뢰 실패 |
| M06-02 · Profile · 계약 연결 | standalone/hosted 선택, identity·Git provider·필수 capability와 Console/Workspace 연동을 확정한다. | 중복 Backbone 설치 없이 명시한 profile의 계약 통과 | 계획 — 미착수 · 완료 증거 없음 |
| M06-03 · 프로젝트 종단 여정 | 실제 프로젝트 하나로 허용된 Git·개발 작업·진행/결과 조회와 감사 경로를 검증한다. | 실제 산출물 + 권한 거절·중복 요청·장애 복원 증거 | 계획 — 미착수 · 완료 증거 없음 |
| M06-04 · 운영 · upgrade · 재현 | Developer 소유 범위의 배포, 백업/복구, 버전 호환성과 독립 재현을 검증한다. | Console 클린 설치와 데이터 경계 분리; module별 수용 receipt | 계획 — 미착수 · 완료 증거 없음 |

## M07 · OpenSphere-Pulse

**Telemetry · topology · incident 서비스** · 05 · 선택 확장 · 재구성 설계 있음 · 설치 수용 전

- 적용: 관측 제품을 선택할 때
- 범위: 독립 실행과 Console hosted를 구분; agent/edge는 대상별 최소 배치
- 진입 조건: standalone/console-hosted profile, 대상·수집 범위·저장/보존 정책·필수 dependency를 확정한다.
- 기준 시점: Console Backbone의 Beszel 설치와 Pulse 제품 설치는 같은 완료 항목이 아닙니다. 재구성 문서가 현재 설치 완료를 뜻하지 않습니다.
- 완료 조건: **G07: 실제 대상 하나의 수집→저장→조회→상태/incident 여정과 단절·재연결·보존 검증을 통과한다.**
- 출처: S12

| 작업 ID / 기능 | 해야 할 작업 | 통과 증거 | 기준 시점 판정 |
|---|---|---|---|
| M07-01 · 수집 대상 · profile | 첫 대상과 protocol, edge/agent 필요성, 자원·보안·보존 범위를 고정한다. | 수집하지 않는 대상/데이터도 명시; 과잉 agent 배포 0 | 계획 — 미착수 · 완료 증거 없음 |
| M07-02 · Server · 저장 · 연결 | 선택 profile의 UI/API·데이터 기반·필요 edge/agent를 digest에 고정해 배포한다. | 신원/통신 경계·소유권 inventory·실제 연결 | 계획 — 미착수 · 완료 증거 없음 |
| M07-03 · Telemetry · topology · incident | 대상 하나의 관측 시각·단절·상태 변화와 선택한 incident 여정을 검증한다. | 실제 데이터 출처·freshness; 단절을 정상으로 은폐하지 않음 | 계획 — 미착수 · 완료 증거 없음 |
| M07-04 · 보존 · 복원 · 제품 통합 | retention, 재연결/중복 수집, 백업/복구 및 선택한 Console/Workspace 통합을 검증한다. | module별 실패/복원 receipt; Beszel과 책임·중복 수집 구분 | 계획 — 미착수 · 완료 증거 없음 |

## M08 · OpenSphere-AI-Workbench

**필요가 확인된 AI 작업 환경** · 05 · 선택 확장 · 상세 설계 전

- 적용: AI workload 요구가 있을 때
- 범위: 제품 domain; OSAA 네이티브 assistant와 구분
- 진입 조건: 실제 model/provider·데이터·실행 자원·비용·보안 요구를 먼저 확정. GPU를 기본 필수로 간주하지 않는다.
- 기준 시점: Console의 OSAA를 별도 Workbench 설치로 대체하지 않습니다. Workbench는 별도의 제품 여정과 수용 기준이 필요합니다.
- 완료 조건: **G08: 허용 데이터로 작업 하나를 실행하고 결과·사용량·취소·권한·비밀 보호·실패 복원을 검증한다.**
- 출처: S13

| 작업 ID / 기능 | 해야 할 작업 | 통과 증거 | 기준 시점 판정 |
|---|---|---|---|
| M08-01 · 첫 작업 · model · 자원 | 실제 필요한 작업 하나와 provider/model, 데이터 분류·quota·CPU/GPU 필요성을 결정한다. | 목표와 비용 상한; GPU 불필요 시 추가 인프라 0 | 계획 — 미착수 · 완료 증거 없음 |
| M08-02 · 계약 · 권한 · 배포 설계 | API·artifact·runtime·identity·Secret 참조·데이터 격리와 삭제 책임을 구체화한다. | 모듈 완전 설계 표준 + threat/실패·수용 fixture | 계획 — 미착수 · 완료 증거 없음 |
| M08-03 · 작업 실행 · 결과 · 취소 | 허용 작업의 실행/상태/결과/사용량과 중단·재시도를 연결한다. | 실제 응답/산출물; 승인 없는 외부 전송·권한 밖 실행 차단 | 계획 — 미착수 · 완료 증거 없음 |
| M08-04 · 운영 · 통합 · 회수 | 선택한 Console/Workspace 연결과 자원 회수·장애 복원·provider 키 회전을 검증한다. | 정책/사용량/결과 receipt; OSAA와 권한·데이터 경계 유지 | 계획 — 미착수 · 완료 증거 없음 |

## 공통 수용·재현·실패 규칙

1. 각 gate는 Pass / Fail / NotRun으로 기록한다. 진행률 퍼센트나 Pod 개수로 기능 수용을 대체하지 않는다. 미설정된 선택 기능은 명시한 비활성 상태여야 하며, 필수 기능의 503을 선택 기능으로 재분류하지 않는다.
2. 기존 설치에서 기능을 완성·검증한 뒤 그 방법을 source/installer/release에 반영한다. 오류마다 새 발행·전체 삭제를 반복하지 않는다.
3. G02 클린 재현은 source checkout, 로컬 코드 마운트, 수동 Secret/DB 패치 없이 공개 Setup과 고정 BOM만으로 전체 수용을 통과해야 한다. 실행 중 새로 생성하는 Secret·installation ID는 값의 동일성 대신 보안·기능 계약을 비교한다.
4. 삭제/교체 전에 설치 소유 inventory·볼륨·DB 범위·복원 필요성을 검증한다. Developer, www 및 다른 installation 자원은 보호한다. 이 문서 생성으로 삭제를 실행하지 않는다.
5. 실패 시 다음 단계로 자동 전진하지 않는다. 정확한 실패 원인·남은 자원·재개점·수동 보완을 기록하며 수동 보완은 배포본 결속 전까지 기술 부채다.
6. backup·restore·upgrade·권한 회수·재부팅은 각 기능의 데이터/상태 계약을 검사한다. DB 복원 성공으로 파일·object·Git 무결성까지 통과했다고 주장하지 않는다.
7. OCI 버전, edge/candidate/stable/ga, GHCR 주소·빌드 권위·서명/digest는 S14를 상속한다. 이 문서는 새 버전 형식이나 임의 채널 승격을 만들지 않는다.

게이트 기록의 필수 필드:

- gateId / 판정(Pass·Fail·NotRun)
- 검사 시각 / 담당자 / 대상 context·installation ID
- source revision / Setup version / channel / artifact digest / BOM·migration checksum
- 검사 분모 / 정상·거절·실패 fixture / 실행 결과
- 실행 전후 resource inventory / postcondition / receipt·audit correlation
- rollback·복구 대상 / 잔여 결함 / 다음 진입 허용 여부

현재 G01은 기동 범위의 증거만 있고 최종 배포본 수용은 남아 있다. G02는 Fail/미완료, G03–G08은 NotRun이다. 이는 이 문서의 계획 판정이며 installation lock을 변경하지 않는다.

## 결정과 열린 질문

| ID | 지위 | 내용 |
|---|---|---|
| D-MILESTONE-01 | 기존 승인 계승 | Setup은 최초 기반, Console은 후속 설정·승인·운영. Console 네이티브 기능을 후속 별도 제품으로 밀어내지 않는다. |
| D-MILESTONE-02 | 사용자 완료 기준 | 필수 기능 수용 후 공개 Setup 클린 설치에서 동일 수용을 재통과해야 Console 설치 완료다. |
| D-MILESTONE-03 | 진행 순서 제안 | Console 기반 운영을 확인하면 Cluster Manager read-only slice를 병행 착수한다. 승인 쓰기 slice와 전체 설치 완료는 필요한 Console Owner 경로와 G02 결과에 연계한다. |
| D-MILESTONE-04 | 의존성 기반 제안 | Foundation은 첫 자원 요구에 맞춰 최소 도입; 후속 제품은 선택. Workspace는 standalone 제품의 강제 선행 조건이 아니다. |

| 질문 | 닫아야 할 시점 | 내용 |
|---|---|---|
| Q01 | M03 read-only 착수 시 | read-only 진단의 첫 API·화면·권한·freshness·배포 artifact와 수용 fixture를 확정한다. 첫 제한 쓰기 action의 Owner·rollback은 write slice 전에 닫는다. |
| Q02 | M04 진입 전 | 첫 소비자 capability와 provider, 기존 자원 재사용 여부를 정한다. Ceph·HA 등은 요구 근거가 있어야 한다. |
| Q03 | M05 진입 전 | Workforce IdP/issuer/audience, production host, tenant 규모와 최소 앱 하나를 정한다. |
| Q04 | M06–M08 진입 전 | 첫 선택 제품과 profile, SLO/RPO/RTO·데이터 보존·비용·운영 책임을 고정한다. |
| Q05 | 각 게이트 실행 전 | 아직 없는 실행 명령·이미지·namespace를 추정해서 쓰지 않는다. 구현/발행 후 정확한 version/digest와 실행 증거를 기록한다. |

상세 모듈 명세는 20-MODULE/<정확한 repository 이름> 아래에 응집한다. 이 문서는 공통 설치 순서·경계·진입/종료 조건만 소유하며 각 제품 API·화면·데이터 정본을 복사하지 않는다.

## 근거와 유지보수

| ID | 정본/증거 | 사용 범위와 한계 |
|---|---|---|
| S1 | [Setup 설치 책임 경계](../10-ARTIFACT/ARTIFACT-SETUP-CLI-INSTALLATION-DEVELOPMENT-TOOL.md) | 2026-09-02 Accepted 책임 구분을 사용. 과거 버전/시험 수치는 현재 상태로 재사용하지 않음. |
| S2 | [Console 네이티브 설치 검증 기록](../20-MODULE/OpenSphere-Console/90-EVIDENCE/CONSOLE-EVIDENCE-NATIVE-INSTALLATION-VERIFICATION-2026-09-03.md) | 로컬 수정·남은 기능/재현 gate의 증거. |
| S3 | [재부팅 후 서비스 복원 점검](../../.codex-tmp/reboot-service-check-2026-09-04/REBOOT-SERVICE-REPORT.md) | 2026-09-04 00:30–00:36 KST 기동/TLS 관찰. 전체 기능 수용 아님. |
| S4 | [Console 실제 DB 격리 복원 증거](../20-MODULE/OpenSphere-Console/90-EVIDENCE/CONSOLE-EVIDENCE-LIVE-RECOVERY-DATABASE-VERIFICATION-2026-09-03.json) | DB 검증 범위만; Storage/Gitea 파일 전체 복원 보증 아님. |
| S5 | [Console 설계·네이티브 경계](../20-MODULE/OpenSphere-Console/CONSOLE-DESIGN-INDEX.md) | 기능별 정본과 수용 Matrix를 링크로 상속. |
| S6 | [Cluster Manager 경계](../04-DOMAIN/CLUSTER-MANAGER/DOMAIN-CLUSTER-MANAGER-BOUNDARY-OVERVIEW.md) | Observed legacy / Target Proposed. 구체 배포물 미확정. |
| S7 | [첫 종단 운영 여정 JNY-01](../01-PRODUCT/PRODUCT-PLATFORM-CORE-JOURNEY.md) | 읽기 진단·승인 작업·receipt 및 실패 흐름의 Proposed 기준. |
| S8 | [첫 릴리스 범위](../01-PRODUCT/PRODUCT-PLATFORM-RELEASE-SCOPE.md) | Proposed 범위. 사용자 네이티브 완료 요구를 축소하는 근거로 사용하지 않음. |
| S9 | [C4 모델 C_CLUSTER / C_FAPI / C_FCTL](../02-ARCHITECTURE/ARCHITECTURE-PLATFORM-C4-MODEL.json) | Owner/Claim/Binding 의미. 상세 배포 계약이나 현재 구현 완료가 아님. |
| S10 | [Workspace 설계 정본](../20-MODULE/OpenSphere-Workspace/WORKSPACE-DESIGN-INDEX.md) | account/portal/apps 및 독립 제품 launch 경계. |
| S11 | [Developer 설계 정본](../20-MODULE/OpenSphere-Developer/DEVELOPER-DESIGN-INDEX.md) | standalone/console-hosted profile; 현재 runtime은 S3 참조. |
| S12 | [Pulse 설계 정본](../20-MODULE/OpenSphere-Pulse/PULSE-DESIGN-INDEX.md) | dual mode 및 telemetry/topology/incident 제품 경계. |
| S13 | [제품 domain 대장](../04-DOMAIN/DOMAIN-PLATFORM-DOMAIN-CATALOG.md) | AI Workbench의 제품 경계. 완전 설치 계약으로 보지 않음. |
| S14 | [공식 버전·채널·GHCR 정책](OPERATIONS-PLATFORM-RELEASE-CHANNEL-POLICY.md) | REL-02 최소 영향, REL-03 버전, REL-04 채널, REL-05 GHCR, digest 고정 기준. |
| S15 | [모듈 완전 설계 표준](../09-GOVERNANCE/GOVERNANCE-MODULE-COMPLETE-DESIGN-DOCUMENT-STANDARD.md) | 후속 모듈 구현 진입 시 필요한 구체 설계 분모. |
| S16 | [Repository inventory](../09-GOVERNANCE/GOVERNANCE-PLATFORM-IMPLEMENTATION-REPOSITORY-INVENTORY.json) | repository 경계만 사용. 2026-09-01의 구현 상태는 최신 현황으로 주장하지 않음. |

파일 날짜나 과거 승인/완료 문구만으로 현재 상태를 바꾸지 않는다. 새 증거가 생기면 계획 JSON의 기준 시각·작업 판정·근거를 갱신하고 Console의 landing-installation-milestones.html 및 함께 배포하는 JSON/Markdown을 같은 개정으로 검토한다. Console build는 repository 안의 정적 component와 public asset만 사용하며 다른 repository의 source를 읽지 않는다. 별도 웹페이지나 서버를 제품 진입점으로 삼지 않는다.

배포 대상은 context docker-desktop, namespace opensphere-console, Deployment opensphere-console의 shell container다. 사용자 주소는 https://localhost:1114/#installation. 기존 local-dev/www 설명 페이지와는 별도이며 그 작업은 보존한다.

빌드·게시·배포·runtime 검증을 구분하고 기존 Console 이미지/BOM과 source 연계를 기록한다. credential이나 실시간 cluster 객체를 설명 자료에 포함하지 않는다. 다운로드 문서의 상대 출처 링크는 workspace 설계 정본을 기준으로 한다.
