# Backbone 아키텍처 — 콘솔 제어평면 상태저장 지원 스택

> **상태**: 설계(draft) · **작성일**: 2026-06-29 · **대상 독자**: 콘솔/플랫폼 팀
> **범위**: 콘솔(제어/관리 평면)이 기능을 확장하기 위해 필요한 상태저장 데이터 티어의 정의·연결·설치·운영·백업.

---

## 0. 정의와 범위

### 0.1 Backbone이란

**Backbone** = **콘솔(제어/관리 평면) 자신**이 동작·확장하기 위해 필요한 상태저장 지원 스택.

> Foundation : 사용자 서비스 = **Backbone : 콘솔 자신**

- **Foundation** (`opensphere-foundation`) — *사용자 워크로드 평면*을 떠받치는 자원(OpenSearch, RustFS 등 사용자 서비스 구성용).
- **Backbone** (`opensphere-backbone`, 신규) — *콘솔 제어평면*을 떠받치는 자원. 테넌트 워크로드와 **공유되지 않는** 콘솔 전용 상태.

> 표기 규약: 산문에서는 항상 "Backbone 스택 / Backbone 서비스"로 쓴다(네트워크 backbone과의 혼동 방지). 네임스페이스 `opensphere-backbone`, 라벨 `opensphere.io/backbone-module: <postgres|rustfs|gitea>` (Foundation의 `opensphere.io/foundation-module` 컨벤션 미러).

### 0.2 구성요소

| 컴포넌트 | 역할 | 이미지(핀) |
|---|---|---|
| **PostgreSQL** | 콘솔 앱 DB(감사로그·사용자 설정·플러그인 메타) + Gitea DB 호스팅 | `bitnami/postgresql:16` (no `latest`) |
| **RustFS** | S3 호환 오브젝트 스토리지(플러그인 번들·Gitea LFS·업로드·백업) | `rustfs/rustfs:1.0.0-beta.8` |
| **Gitea** | 설정 이력 관리(config-as-code / GitOps) | `gitea/gitea:1.22` |

기술 선정 근거(MinIO 배제, RustFS Apache-2.0 채택, SeaweedFS 탈출구)는 별도 결정 기록 참조. RustFS는 **Foundation에서 이미 동일 패턴으로 운영 중**(`OpenSphere-shell-foundation/bootstrap/rustfs-dev.yaml`) — Backbone은 이를 미러링한다.

### 0.3 데이터 책임 경계 (무엇을 어디에 저장하는가)

| 저장소 | 저장 대상 | 비저장(금지) |
|---|---|---|
| **K8s etcd**(CRD/ConfigMap/Secret) | UIPluginPackage/Registration, CLIDownload(= 정당한 K8s 리소스), TLS/자격증명 Secret, 네트워킹 설정 | 고빈도 앱 데이터, 대용량 |
| **PostgreSQL** | **감사로그(append-only)**, 사용자 설정/북마크, 플러그인 메타/통계, Gitea 자체 DB | 바이너리 대용량(→RustFS) |
| **RustFS**(S3) | 플러그인 번들(.tgz/.wasm), Gitea LFS, 사용자 업로드(아이콘 등), **백업 아카이브** | 트랜잭션 상태 |
| **Gitea**(Git) | 플랫폼 설정 YAML(desired state), 환경별 브랜치, 변경 이력/diff/리뷰 | 감사로그·런타임상태·Secret(고빈도→repo 오염) |

> **즉시 해소 대상(현존 wart)**: 감사로그가 현재 `dupa-audit-log` **ConfigMap**(500건 캡, flush마다 전체 덮어쓰기 — `controller.js:120` `flushAudit`)에 저장됨. etcd는 감사 증거 저장소로 부적합 → **PostgreSQL `audit_log` 테이블로 이전이 Backbone의 첫 실수요**.

### 0.4 ⚠️ 클러스터 현실 제약 (모든 설계를 좌우)

라이브 클러스터 확인 결과(2026-06-29):

```
StorageClass: standard (default), provisioner rancher.io/local-path
  RECLAIMPOLICY=Delete · VOLUMEBINDINGMODE=WaitForFirstConsumer · ALLOWVOLUMEEXPANSION=false
```

| 제약 | 함의 |
|---|---|
| **local-path = 노드 고정 hostPath, RWO 전용** | Pod가 PVC 프로비저닝 노드에 묶임. RWX·네트워크 스토리지 없음 → **단일 replica StatefulSet/Deployment**만 가능(진짜 HA는 네트워크 스토리지 도입 후). |
| **볼륨 스냅샷 미지원** | 백업은 **반드시 논리 백업**(`pg_dump`·`gitea dump`·`mc mirror`). 볼륨 스냅샷 백업 불가. |
| **ReclaimPolicy=Delete** | PVC 삭제 = 데이터 즉시 소실. 백업 규율 필수. |
| **AllowVolumeExpansion=false** | 용량 증설은 PV 재생성 필요(초기 sizing 보수적으로). |
| **노드 소실 = PVC 소실** | local-path는 노드 로컬 → 노드 장애 시 데이터 손실. **오프노드 백업이 유일한 보호**. |

이 제약은 dev/로컬 한정이며, 운영 전환 시 **네트워크 스토리지(스냅샷·RWX 지원) + replica 격상**이 별도 과제다(§5).

---

## 1. 연결 — 콘솔 서비스 ↔ Backbone 자원 (Q1)

### 1.1 연결 원칙 (기존 하우스 패턴 준수)

코드베이스의 기존 패턴을 그대로 따른다(신규 관례 도입 안 함):

1. **엔드포인트**(host:port) = **평문 `env`** 주입 + **service DNS**. (예: `console-backend/deploy.yaml:49`의 평문 env 패턴)
2. **자격증명**(DB 비번·S3 secret_key·Gitea 토큰) = **K8s Secret** → `env.valueFrom.secretKeyRef`. (예: `keycloak-stack.yaml:45` `POSTGRESQL_PASSWORD`, `rustfs-dev.yaml:63` `RUSTFS_ACCESS_KEY`)
3. **Secret은 git에 두지 않는다** — 설치 스크립트가 imperative로 생성(`keycloak-stack.yaml:3` 주석 규약, `opensphere-auth/up.sh:15` 키 생성 패턴).
4. **in-cluster 연결은 service DNS** — `<svc>.opensphere-backbone.svc.cluster.local:<port>`.

### 1.2 service DNS / 포트

| 자원 | Service DNS | 포트 | 프로토콜 |
|---|---|---|---|
| PostgreSQL | `backbone-postgres.opensphere-backbone.svc.cluster.local` | 5432 | TCP(libpq) |
| RustFS (S3) | `backbone-rustfs.opensphere-backbone.svc.cluster.local` | 9000 | HTTP(S3) |
| RustFS (콘솔 UI) | `backbone-rustfs…svc` | 9001 | HTTP |
| Gitea (HTTP/API/Git) | `backbone-gitea.opensphere-backbone.svc.cluster.local` | 3000 | HTTP |

### 1.3 접근 레이어 (콘솔 백엔드 측 코드)

#### (a) S3 추상화 — `StorageService` ★필수 안전장치

콘솔 백엔드(Node.js)에 **S3 SDK 래퍼**를 둔다. 이것이 **RustFS ↔ SeaweedFS 무코드 교체**를 보장하는 탈출구다.

- 라이브러리: `@aws-sdk/client-s3` (또는 의존성 0 원칙 유지 시 경량 S3 서명 구현).
- 설정: `S3_ENDPOINT`(env), `S3_ACCESS_KEY`/`S3_SECRET_KEY`(secretKeyRef), **`forcePathStyle: true`**(RustFS/MinIO 호환 필수), `region: us-east-1`(더미).
- 인터페이스(구현체 교체 가능): `putObject` · `getObject` · `presignGetUrl` · `deleteObject` · `listObjects` · `ensureBucket`.
- 위치(제안): `backend/backbone/storage.js`.

#### (b) DB 접근 — `db.js` (pg pool)

- 라이브러리: `pg`(node-postgres). 단일 모듈이 connection pool 캡슐화.
- 설정: `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`(env) + `PGPASSWORD`(secretKeyRef).
- 마이그레이션: `backend/backbone/migrations/NNNN_*.sql` 순번 적용 + `schema_migrations` 테이블 멱등(§3.1).

#### (c) Gitea 접근 — Git over HTTP + REST

- reconciler(또는 콘솔 백엔드)가 Gitea **API 토큰**(secretKeyRef)으로 commit/PR/clone.
- Gitea **webhook** → reconciler 엔드포인트 트리거(설정 변경 시 K8s 적용).

### 1.4 연결 매트릭스 (누가 무엇에)

| 콘솔 서비스 | → Backbone 자원 | 용도 | 인증 |
|---|---|---|---|
| `dupa-registry-controller` | PostgreSQL | 감사로그 write/query(ConfigMap 대체) | secretKeyRef |
| `console-backend` | PostgreSQL | 사용자 설정·플러그인 메타 | secretKeyRef |
| `console-backend` | RustFS | 아이콘/업로드 에셋 | secretKeyRef |
| `dupa-registry-controller` | RustFS | (향후) 플러그인 번들 저장 | secretKeyRef |
| `reconciler`(신규) | Gitea + K8s API | 설정 pull → apply, drift 감지 | API 토큰 + SA |
| **Gitea** | PostgreSQL | 자체 DB | secretKeyRef |
| **Gitea** | RustFS | LFS 백엔드 | secretKeyRef |

> **순환 의존 주의**: 콘솔이 Backbone을 관리하지만 콘솔 자신이 Backbone에 의존한다. 부트스트랩 독립성 — Backbone은 콘솔 없이 기동 가능해야 하고(데이터 티어 자립), 콘솔은 Backbone 없을 때 **graceful degradation**(감사/설정 쓰기는 막히되 read-only 기능은 유지)으로 설계한다(§3.5).

---

## 2. 설치 — 어느 단계에서 어떤 방식으로 (Q2)

### 2.1 설치 단계 (bring-up 순서상 위치)

현 `tools/local-dev/bring-up.sh`는 Phase 0~6(registry→images→namespaces→CRDs→fleet/foundation). 콘솔 백엔드(dupa/console-backend)가 Backbone에 의존하게 되므로 **데이터 티어가 백엔드보다 먼저 Ready**여야 한다.

```
Phase 2  [NAMESPACES]   기존: opensphere-system/fleet/foundation/argocd
Phase 2.5[BACKBONE] ★신규 ── opensphere-backbone ns → Secrets → PostgreSQL(+ready) →
                            [RustFS, Gitea](+ready) → DB migrate + bucket 생성 + Gitea seed
Phase 3  [CRDs]
   …
Phase 8  [BACKEND]      console-backend·dupa는 이제 Backbone에 연결(연결정보 env/Secret 주입)
```

의존성 순서(DAG): `ns → secrets → PostgreSQL(ready) → {RustFS, Gitea} → 초기화(migrate/bucket/seed) → 콘솔 백엔드`.

### 2.2 설치 방식 — 선언적 매니페스트(now) → Helm(prod distributed)

> **이전 결정 정정/구체화**: "RustFS는 Helm으로"는 *distributed(다중노드 erasure-coding) 모드*를 위한 것이었다. 그러나 본 클러스터는 **local-path 단일노드 RWO** — distributed 불가, **standalone 단일 replica**만 가능하다. 또 하우스 컨벤션은 `kubectl apply -f`(Helm/Kustomize 미사용)이고 **Foundation이 RustFS를 이미 평문 StatefulSet 매니페스트로 운영**한다.
>
> → **dev/로컬: 평문 매니페스트 apply**(Foundation `rustfs-dev.yaml` 미러). **Helm은 운영 클러스터에서 distributed로 갈 때 도입**(S3 추상화 덕에 엔드포인트만 바뀜).

신규 스크립트 **`tools/local-dev/install-backbone.sh`** (멱등; `provision-kanidm-oauth2.sh`·`kanidm-up.sh` 스타일):

1. `kubectl create ns opensphere-backbone` (멱등).
2. **Secret 생성**(git 미포함, imperative + 랜덤): `backbone-postgres`(password), `backbone-rustfs`(access_key/secret_key/endpoint), `backbone-gitea`(admin_user/admin_password/api_token). 예: `--from-literal=password=$(openssl rand -hex 24)`.
3. `kubectl apply -f bootstrap/backbone/{postgres,rustfs,gitea}.yaml` + `rollout status` 대기.
4. **초기화(멱등)**: DB 마이그레이션 실행(`schema_migrations` 기준 미적용분만), RustFS 버킷 생성(`ensureBucket`), Gitea 초기 config repo seed.
5. `bring-up.sh`에 Phase 2.5로 호출 삽입.

### 2.3 설치 산출물

| 컴포넌트 | kind | 영속 | Secret | Service |
|---|---|---|---|---|
| PostgreSQL | Deployment + PVC(`Recreate`) | PVC 8Gi `/bitnami/postgresql` | `backbone-postgres` | `:5432` |
| RustFS | StatefulSet(volumeClaimTemplates) | PVC 20Gi `/data` | `backbone-rustfs` | `:9000`,`:9001` |
| Gitea | Deployment + PVC(`Recreate`) | PVC 10Gi `/data` | `backbone-gitea` | `:3000` |

> kind 선택 근거: PostgreSQL·Gitea는 단일 replica라 가장 가까운 하우스 선례(`keycloak-db` = Deployment+PVC+`Recreate`)를 따른다. RustFS는 Foundation 선례(StatefulSet+volumeClaimTemplates)를 그대로 미러. 셋 다 **`replicas: 1`**, 동시쓰기 방지 위해 `strategy: Recreate`(DB) / StatefulSet 기본.

매니페스트 골격은 **부록 A** 참조.

---

## 3. 상태 관리 / 제어 (Q3)

### 3.1 스키마 관리 (PostgreSQL)

- **마이그레이션**: `backend/backbone/migrations/NNNN_name.sql` 순번 적용, `schema_migrations(version, applied_at)`로 멱등. install-backbone.sh와 콘솔 백엔드 기동 시 미적용분 실행.
- **초기 스키마**:
  - `audit_log` — **append-only**. `id bigserial PK, ts timestamptz, op_id text, actor text, action text, target text, result text, reason text`. 인덱스: `(ts desc)`, `(actor)`, `(action)`. INSERT만(UPDATE/DELETE 권한 미부여 = 증거 무결성).
  - `user_setting` — `user_sub text, key text, value jsonb, updated_at timestamptz, PK(user_sub,key)`.
  - `plugin_meta`(향후) — 다운로드/사용 통계.
- **변경 절차**: 스키마 변경은 마이그레이션 파일 PR(Gitea) → 리뷰 → 적용.

### 3.2 버킷 레이아웃 (RustFS)

| 버킷 | 내용 | 비고 |
|---|---|---|
| `plugin-bundles` | 플러그인 .tgz/.wasm | 콘텐츠 주소(digest) 키 권장 |
| `gitea-lfs` | Gitea LFS 오브젝트 | Gitea 전용 |
| `console-uploads` | 아이콘 등 사용자 업로드 | presigned URL 다운로드 |
| `backups` | 논리 백업 아카이브 | ⚠️ **오프노드로 미러 필수**(§4) |

### 3.3 설정 SoT — Gitea(GitOps)

- **모델**: 기본 **Git-first(Option A)** 지향하되, 콘솔 UX(즉시 반영) 위해 **hybrid** 채택:
  - UI 설정 변경 → K8s/DB **즉시 적용** + Gitea에 **post-write commit**(이력/작성자/diff 확보).
  - reconciler가 Gitea ↔ 클러스터 **drift 감지**, webhook으로 재적용. (외부 변경=Git commit → 클러스터 반영도 동일 경로.)
- **repo 구조**: `config/`(플랫폼 설정 YAML), 환경별 브랜치(dev/stage/prod), 롤백 = `git revert`.
- **금지**: 감사로그·런타임상태·K8s Secret을 Git에 넣지 않는다(고빈도 쓰기 → repo 오염, 비밀 유출).
- **reconciler 구현 선택지**: (a) 경량 자체 reconciler(현 dupa 컨트롤러 패턴 재사용) vs (b) **ArgoCD**(`argocd` ns가 이미 bring-up.sh에 예약됨 — 미설치). dev는 (a)로 시작, 규모 확대 시 (b) 평가.

### 3.4 헬스 / 관측

- **probe**: PostgreSQL `exec pg_isready`(keycloak-db 선례), RustFS `tcpSocket:9000`(rustfs-dev 선례), Gitea `httpGet /api/healthz`.
- **집계**: 콘솔 백엔드에 `/api/admin/backbone/health`(각 의존성 ping 집계) 추가 → Admin UI 노출.
- **메트릭(향후)**: `postgres_exporter`, RustFS Prometheus endpoint, 구조화 stdout 로그(기존 `[audit]` 패턴).

### 3.5 제어 평면 / 부트스트랩 독립성

- Backbone의 1차 관리자 = 콘솔 Admin API(dupa/console-backend). RustFS 버킷·정책 provisioning은 **멱등 스크립트**(`provision-kanidm-oauth2.sh` 패턴 미러).
- **graceful degradation**: 콘솔은 Backbone(PG) 불가 시 → 감사/설정 쓰기 503으로 명확히 실패하되, 읽기 전용 화면은 유지. Backbone은 콘솔과 독립 기동(콘솔 장애가 데이터 티어에 영향 없음).

---

## 4. 백업 / 복구 (Q4)

> **대전제(§0.4 재확인)**: local-path는 볼륨 스냅샷 불가 → **논리 백업만**. 노드 소실 = PVC 소실 → **오프노드 백업이 유일한 보호**.

### 4.1 컴포넌트별 전략

| 컴포넌트 | 백업 방식 | 주기 | 위치 | 복구 |
|---|---|---|---|---|
| **PostgreSQL** | `pg_dump`(논리) | 일 1회(+ 운영은 WAL 아카이빙=PITR) | RustFS `backups/postgres/` **+ 오프노드** | 새 PG + `pg_restore`/`psql` |
| **RustFS** | `mc mirror`/`rclone`(버킷 단위) | 일 1회 | **외부 S3/다른 호스트**(오프노드) | mirror 역방향 |
| **Gitea** | `gitea dump`(repo+DB+LFS 통합) | 일 1회 | RustFS `backups/gitea/` **+ 오프노드** | `gitea restore` |

> Git 특성상 reconciler/개발자 워크스테이션의 **클론본 자체가 분산 백업**으로 기능(추가 안전망).

### 4.2 통합 백업 작업

- **CronJob `backbone-backup`**(opensphere-backbone ns): `pg_dump` + `gitea dump` → `backups` 버킷 적재 → `mc mirror`로 **오프노드 동기화**.
- **보존 정책**: 일 7 · 주 4 · 월 3 (롤링 삭제).
- ⚠️ `backups`를 같은 RustFS에만 두면 노드 소실 시 동반 소실 → **반드시 클러스터 밖**(외부 볼륨/다른 호스트/오프사이트 S3)으로 한 부 더.

### 4.3 재해 시나리오별 복구

| 시나리오 | 영향 | 복구 |
|---|---|---|
| Pod 재시작 | PVC 생존(노드 유지) | 자동 복구(무손실) |
| **노드 소실** | local-path PVC **소실** | 백업에서 복구 필수 — local-path 핵심 위험 |
| PVC 실수 삭제(Reclaim=Delete) | 즉시 소실 | 백업 복구 |
| 클러스터 재생성 | 전체 소실 | install-backbone.sh + 백업 일괄 복구 |

### 4.4 RTO/RPO (dev 기준)

- **RPO**: 일 1회 백업 → 최대 24h 손실. 단축하려면 PG WAL 아카이빙(운영 클러스터, 네트워크 스토리지 전제).
- **RTO**: 분 단위(dev 데이터 소규모; install-backbone.sh + restore).
- **복구 런북**: `tools/local-dev/restore-backbone.sh`(역순 — Secret 재생성 → 컴포넌트 기동 → restore → 검증).

---

## 5. 로드맵 · 결정 · 미해결

### 5.1 빌드 순서 (제약 반영)

```
① PostgreSQL (Deployment+PVC, Recreate)         ─┐ 기반 핵심
② RustFS (StatefulSet, foundation 미러)           │
③ S3StorageService + db.js 추상화(콘솔 백엔드)     │
④ 감사로그 ConfigMap → PostgreSQL 이전(첫 실수요)  ─┘
⑤ Gitea (PG 백엔드 + RustFS LFS)                 ─┐ 설정 이력관리(주목적)
⑥ reconciler + config repo seed(GitOps)          ─┘
⑦ backbone-backup CronJob + restore 런북          (운영 안전)
```

### 5.2 확정 결정

- 명칭 **Backbone**, ns `opensphere-backbone`, 라벨 `opensphere.io/backbone-module`.
- 스택 = PostgreSQL + RustFS + Gitea. RustFS는 Foundation `rustfs-dev.yaml` 패턴 미러.
- 연결 = env(엔드포인트) + secretKeyRef(자격증명) + service DNS. **S3 추상화 필수**(SeaweedFS 탈출구).
- dev 설치 = 평문 매니페스트 apply(+ `install-backbone.sh`). Helm은 운영 distributed 전환 시.
- 백업 = 논리 백업 + 오프노드 미러(local-path 제약).

### 5.3 미해결 / 후속

1. **HA·네트워크 스토리지** — local-path 단일노드 → 운영은 스냅샷/RWX 지원 SC + replica 격상(별도 과제).
2. **PostgreSQL 이미지 핀** — `keycloak-stack.yaml`이 `bitnami/postgresql:latest` 사용(하우스 no-latest 규약 위반) → Backbone은 `:16` 핀, 기존도 정정 권고.
3. **Secret 관리 성숙화** — 현재 imperative 생성. 향후 SOPS/sealed-secrets 또는 외부 KMS 평가.
4. **reconciler 선택** — 자체 경량 vs ArgoCD(`argocd` ns 예약됨).
5. **WAL/PITR** — RPO<24h 필요 시 네트워크 스토리지 전제로 도입.

---

## 부록 A. 매니페스트 골격 (스켈레톤)

> 실제 배포본은 `OpenSphere-console/backend/backbone/bootstrap/`에 두고 `install-backbone.sh`가 apply. Secret은 git 미포함(스크립트가 생성). 아래는 구조 예시.

### A.1 PostgreSQL (`keycloak-db` 패턴 미러)

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: backbone-postgres-data, namespace: opensphere-backbone }
spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: 8Gi } } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: backbone-postgres, namespace: opensphere-backbone, labels: { opensphere.io/backbone-module: postgres } }
spec:
  replicas: 1
  strategy: { type: Recreate }          # 동시 DB 접근 방지
  selector: { matchLabels: { app: backbone-postgres } }
  template:
    metadata: { labels: { app: backbone-postgres } }
    spec:
      containers:
        - name: postgresql
          image: docker.io/bitnami/postgresql:16     # no latest
          env:
            - { name: POSTGRESQL_DATABASE, value: console }
            - { name: POSTGRESQL_USERNAME, value: console }
            - { name: POSTGRESQL_PASSWORD, valueFrom: { secretKeyRef: { name: backbone-postgres, key: password } } }
          ports: [{ containerPort: 5432 }]
          readinessProbe: { exec: { command: ["/bin/sh","-c","pg_isready -U console -d console"] }, initialDelaySeconds: 10, periodSeconds: 5 }
          resources: { requests: { cpu: 100m, memory: 256Mi }, limits: { cpu: 500m, memory: 512Mi } }
          volumeMounts: [{ name: data, mountPath: /bitnami/postgresql }]
      volumes: [{ name: data, persistentVolumeClaim: { claimName: backbone-postgres-data } }]
---
apiVersion: v1
kind: Service
metadata: { name: backbone-postgres, namespace: opensphere-backbone }
spec: { selector: { app: backbone-postgres }, ports: [{ port: 5432, targetPort: 5432 }] }
```

### A.2 RustFS (Foundation `rustfs-dev.yaml` 미러 — ns만 변경)

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: backbone-rustfs, namespace: opensphere-backbone, labels: { opensphere.io/backbone-module: rustfs } }
spec:
  serviceName: backbone-rustfs
  replicas: 1
  selector: { matchLabels: { app: backbone-rustfs } }
  template:
    metadata: { labels: { app: backbone-rustfs } }
    spec:
      securityContext: { runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, runAsNonRoot: true }
      containers:
        - name: rustfs
          image: rustfs/rustfs:1.0.0-beta.8
          env:
            - { name: RUSTFS_VOLUMES, value: "/data" }
            - { name: RUSTFS_ADDRESS, value: "0.0.0.0:9000" }
            - { name: RUSTFS_CONSOLE_ADDRESS, value: "0.0.0.0:9001" }
            - { name: RUSTFS_ACCESS_KEY, valueFrom: { secretKeyRef: { name: backbone-rustfs, key: access_key } } }
            - { name: RUSTFS_SECRET_KEY, valueFrom: { secretKeyRef: { name: backbone-rustfs, key: secret_key } } }
          ports: [{ name: s3, containerPort: 9000 }, { name: console, containerPort: 9001 }]
          resources: { requests: { cpu: 100m, memory: 256Mi }, limits: { memory: 1Gi } }
          readinessProbe: { tcpSocket: { port: s3 }, initialDelaySeconds: 8, periodSeconds: 8, failureThreshold: 12 }
          volumeMounts: [{ name: data, mountPath: /data }]
  volumeClaimTemplates:
    - metadata: { name: data }
      spec: { accessModes: ["ReadWriteOnce"], storageClassName: standard, resources: { requests: { storage: 20Gi } } }
# + Service(9000/9001), Secret backbone-rustfs(access_key/secret_key/endpoint) — rustfs-dev.yaml 동일
# ⚠️ beta creds env 무시 이슈(#1058/#375): 기본값과 일치시켜 소비계약 정확히 유지
```

### A.3 Gitea (Deployment+PVC; DB·LFS는 Backbone 내부 사용)

```yaml
# 핵심 env (Deployment, image gitea/gitea:1.22):
#   GITEA__database__DB_TYPE=postgres
#   GITEA__database__HOST=backbone-postgres.opensphere-backbone.svc:5432
#   GITEA__database__NAME=gitea / USER=gitea / PASSWD=(secretKeyRef backbone-gitea)
#   GITEA__lfs__STORAGE_TYPE=minio  (S3 호환)
#   GITEA__lfs__MINIO_ENDPOINT=backbone-rustfs.opensphere-backbone.svc:9000
#   GITEA__lfs__MINIO_BUCKET=gitea-lfs / ACCESS_KEY_ID·SECRET_ACCESS_KEY=(secretKeyRef backbone-rustfs)
#   GITEA__server__ROOT_URL=https://git.console.opensphere.dev/  (ingress 추가 시)
# PVC /data 10Gi, Service :3000, strategy Recreate, readinessProbe httpGet /api/healthz
```

---

## 부록 B. 출처 (코드베이스 근거)

- 연결/설정·감사로그 ConfigMap: `backend/dupa-control/controller.js:107-138`, `backend/console-backend/server.js:46-54`, `nginx/default.conf.template`
- RustFS 선례: `OpenSphere-shell-foundation/bootstrap/rustfs-dev.yaml`
- PostgreSQL 선례: `backend/identity/auth/platform-idp/keycloak-stack.yaml:11-74`
- 설치 흐름/네임스페이스/이미지: `tools/local-dev/bring-up.sh`, `tools/local-dev/CONSOLE-RUNBOOK.md`, `tools/local-dev/provision-kanidm-oauth2.sh`
- StorageClass(라이브): `kubectl get storageclass` → `standard`(rancher.io/local-path)
- Secret 패턴: `backend/identity/opensphere-auth/up.sh:15-19`, `keycloak-stack.yaml:45-47`
