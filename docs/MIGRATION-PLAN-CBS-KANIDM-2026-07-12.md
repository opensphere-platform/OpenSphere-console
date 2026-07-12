# Phase C 마이그레이션 계획서 — 상태저장(cbs-*·kanidm) 이름·네임스페이스 정렬

- 작성일: 2026-07-12
- 범위: `opensphere-backbone` 데이터 티어 → `opensphere-cbs`, `kanidm` → `opensphere-console-kanidm`(ns `opensphere-console-auth` 유지 권장, §6 참조)
- 상위 기준: `NAMING-STANDARD.md` v2 §7-4
- 상태: **계획(실행 전)**. 이 문서 승인 후에만 백업/컷오버를 수행한다.
- 원칙: **데이터 보존 최우선.** StatefulSet/PVC 이름 변경은 볼륨을 orphan시키므로, 비운 채 재생성 금지 — 반드시 백업→복원.

## 1. 대상과 데이터

| 워크로드(현재) | 종류 | PVC(현재) | 데이터 | 정본 이름/ns |
|---|---|---|---|---|
| backbone-postgres | Deployment | backbone-postgres-data | **감사 DB(audit_log)**, console DB, pgvector | opensphere-cbs-postgresql / opensphere-cbs |
| backbone-rustfs | StatefulSet | data-backbone-rustfs-0 | **오브젝트 스토리지(S3)** | opensphere-cbs-rustfs / opensphere-cbs |
| backbone-gitea | Deployment | backbone-gitea-data | **Git 저장소·config** | opensphere-cbs-gitea / opensphere-cbs |
| kanidm | StatefulSet | (kanidm PVC) | **신원(사용자·그룹·자격증명)** — 손실 시 로그인 불가 | opensphere-console-kanidm |

> storage class는 local-path RWO(노드 소실 HA 없음). 백업은 반드시 **오프노드**로 반출한다.

## 2. 위험·전제

- **kanidm 손실 = 전면 로그인 불가**(최고 위험). **postgres 손실 = 감사 이력 소실.**
- StatefulSet 이름 변경 → PVC 템플릿 `<pvc>-<sts>-<n>` 변경 → 기존 볼륨 분리.
- 네임스페이스 이동 시 PVC는 이동 불가 → 데이터 복사/복원 필수.
- backbone(postgres/rustfs/gitea)은 **controller가 생성(bbWorkloads)**. 이름/ns를 controller.js에서 바꾸면 컨트롤러가 신규 워크로드를 만들지만 **데이터는 옮기지 않는다** → 수동/스크립트 복원 단계 필요.
- 다운타임: 각 컷오버 동안 해당 데이터 소비 경로(감사 쓰기·object·git·로그인)가 중단/degraded.

## 3. 실행 순서(위험 역순으로 리허설)

1. **리허설 환경에서 전체 1회 수행**(빈 클러스터/네임스페이스)해 RPO/RTO·절차 검증.
2. 운영: **gitea → rustfs → postgres → kanidm** 순(로그인 영향이 큰 kanidm을 마지막에, 롤백 여지 최대 확보).

## 4. 공통 절차(각 워크로드 반복)

1. **사전 점검**: 신규 ns(`opensphere-cbs`) 생성, storage 용량, 백업 목적지(오프노드) 준비, 컨슈머 목록 확정.
2. **정지/격리**: 소비자 쓰기 차단(컨트롤러 관리쓰기 503 게이트 활용) 또는 워크로드 read-only.
3. **백업**(오프노드) — §5 엔진별.
4. **신규 워크로드 생성**: 정본 이름/ns + **새 PVC**.
5. **복원**: 백업 → 신규.
6. **무결성 검증** — §5 엔진별 기준.
7. **컷오버**: 연결 문자열/DNS/시크릿을 신규로 전환(§7 코드 변경) + 소비자 재기동.
8. **관찰 창(≥24h)**: 오류·정합 모니터.
9. **폐기**: 구 워크로드·PVC 삭제(관찰 창 통과 후, 백업 보존).

## 5. 엔진별 백업·복원·검증

### 5.1 PostgreSQL (→ opensphere-cbs-postgresql)
- 백업: `pg_dump`(전 DB: console·audit 등, `--format=custom`). pgvector 확장 포함 스키마.
- 신규: 새 Deployment+PVC. init CM(`CREATE EXTENSION IF NOT EXISTS vector`) 선적용.
- 복원: `pg_restore`. 확장/시퀀스/소유자 확인.
- 검증: `audit_log` **행 수 일치**, 최근 이벤트 일치, pgvector 쿼리 동작, console DB 연결.
- 컨슈머: controller `BACKBONE_PG_HOST/SECRET_NS/SECRET`, db.js 연결. → 신규 host/secret로.

### 5.2 RustFS / S3 (→ opensphere-cbs-rustfs, StatefulSet)
- 백업/복사: `mc mirror`(또는 rclone) old-endpoint → 백업 → new-endpoint. 버킷/키/ACL 보존.
- 신규: 새 StatefulSet(PVC 템플릿 새 이름) + access/secret key 시크릿.
- 검증: **오브젝트 수·체크섬 일치**, BackboneClaim objectStore 동작.
- 컨슈머: controller `BACKBONE_S3_ENDPOINT/REGION` + rustfs 시크릿. → 신규 endpoint로.

### 5.3 Gitea (→ opensphere-cbs-gitea)
- 백업: `gitea dump`(repos+db+config) 또는 PVC 볼륨 스냅샷.
- 신규: 새 Deployment+PVC.
- 복원: dump 복원, admin/토큰 재검증.
- 검증: 저장소 목록·커밋 히스토리·익명 read 동작.
- 컨슈머: controller `GITEA_URL`. → 신규로.

### 5.4 Kanidm (→ opensphere-console-kanidm) — 최고 위험
- 백업: `kanidmd database backup`(sqlite DB) 오프노드 반출. TLS/CA·서명키 별도 보관.
- 신규: 새 StatefulSet(정본 이름) + kanidm-tls(SNI 재발급 필요 시) + Services(`-core`,`-ext`).
- 복원: `kanidmd database restore` → 도메인·oauth2 client(opensphere-console)·groups scope·사용자 확인.
- 검증: **실제 로그인 성공**(admin+일반), groups 클레임, JWKS(ES256) 서명검증.
- **cert SNI 의존**: BFF/backend/controller/oaa가 `kanidm.opensphere-console-auth.svc`(SNI)로 TLS 검증. 이름/ns 변경 시 **SNI·JWKS URL·CA 경로를 모든 소비자에서 동시 갱신** 필요.

## 6. kanidm ns 결정(권고)

표준 v2 표는 kanidm→`opensphere-console` ns지만, **이번 단계에서는 kanidm을 `opensphere-console-auth` ns에 유지하고 이름만** `opensphere-console-kanidm`으로 바꾸는 것을 권고한다(이유: ns 이동은 cert SNI·모든 소비자 DNS·CA를 동시에 흔들어 로그인 리스크가 급증). ns 이동은 kanidm 안정화 후 별도 창으로 분리한다. (표준 §2의 kanidm ns 목표는 3차로 이연.)

## 7. 동반 코드 변경(컷오버 시 함께)

- `controller.js`: `BACKBONE_NS`(opensphere-backbone→opensphere-cbs), bbWorkloads의 workload/PVC/secret 이름(backbone-*→opensphere-cbs-*), 연결 env 기본값, GITEA_URL.
- `admin-backbone.ts`/`backbone-graph.ts`: 컴포넌트 키/표시명.
- backbone bootstrap yaml·servicemonitors: 이름/ns/셀렉터.
- 테스트(`main-shell-base` 3기둥 이름, `oaa-gateway-tier` bbWorkloads 단언, `backbone-required`): 새 이름으로 갱신.
- kanidm 소비자 DNS/SNI/JWKS: BFF·backend·controller·oaa·console-services — kanidm 이름 변경분만.

## 8. 롤백

- 각 워크로드는 **컷오버 전 구 워크로드·PVC를 삭제하지 않는다**(관찰 창까지 병존). 문제 시 연결 문자열/DNS를 구 값으로 되돌리고 구 워크로드로 즉시 복귀.
- 코드 변경은 브랜치/커밋 단위로 revert 가능하게 분리.

## 9. Go/No-Go 게이트

| 게이트 | 통과 조건 |
|---|---|
| G1 백업 | 4개 데이터 오프노드 백업 + 체크섬/무결성 확인 |
| G2 리허설 | 빈 환경 전체 복원 성공 + RPO/RTO 측정 |
| G3 복원 검증 | pg 행수·object 수·gitea repo·**kanidm 실제 로그인** 일치 |
| G4 관찰 | 컷오버 후 ≥24h 오류 0·정합 유지 |
| G5 폐기 | 구 PVC 삭제 전 백업 보존·복구 재현 확인 |

## 10.5 리허설 결과 (합성 데이터, 라이브 무접촉)

방식 C — 격리 ns `opensphere-cbs-rehearsal`에서 정본 이름 매니페스트로 절차·툴링 검증.

| 엔진 | 상태 | 검증 내용 |
|---|---:|---|
| PostgreSQL | **PASS** | 정본 매니페스트(`opensphere-cbs-postgresql`) 배포·pgvector init, 합성 audit_log 10,000행(vector(3)) → `pg_dump`(custom, 97KB) → 신규 DB `pg_restore` → **복원 10000=10000 일치, vector 확장·데이터 보존**. |
| RustFS(S3) | **PASS** | 정본 StatefulSet 배포, **PVC `data-opensphere-cbs-rustfs-0` Bound**(STS 이름변경 시 PVC 템플릿 재바인딩=orphan 지점 확인). 30오브젝트 → `mc mirror` 신규 버킷 → **오브젝트 수·obj md5 일치**. |
| Gitea | **PASS** | 정본 Deployment 배포 + postgres 연결(rollout 성공). /data(repos) **tar 백업→복원 md5 일치**. DB는 postgres 검증분 재사용(gitea DB=postgres). |
| Kanidm | **PASS** | 정본 StatefulSet + **2-tier 자체서명 인증서**로 실기동("ready to rock"), **PVC `data-opensphere-console-kanidm-0` Bound**. `kanidmd database backup`→**564 신원 항목(idm_admin 포함)** export → 신규 DB `restore`→ 재export **564=564 일치, 신원 보존**. |

- 확인된 사실: **정본 이름 매니페스트 4종 모두 유효(dry-run + 실배포·기동)**. 백업/복원 툴이 데이터를 손실 없이 보존 — postgres(pgvector 포함), S3(체크섬), gitea 볼륨(md5), **kanidm 신원 DB(564 항목)**. StatefulSet 이름변경→PVC 템플릿 재바인딩(orphan) 지점을 rustfs·kanidm에서 실증.
- 미측정: **실데이터 RPO/RTO**(라이브 백업 exec 승인=§방식 A 필요). 합성 규모에선 각 백업/복원 모두 초 단위.
- 리허설 리소스는 검증 후 삭제(격리 ns drop, 라이브 무접촉).

## 10. 이번 문서의 산출

- 계획 확정(승인 대기). **실행(백업·컷오버·삭제)은 승인 후.**
- 코드 변경(§7)은 컷오버와 함께 별도 커밋으로 진행하며, 데이터 이동 없이 매니페스트만 먼저 반영하지 않는다(라이브에서 빈 신규 워크로드가 데이터 없이 뜨는 것을 방지).
