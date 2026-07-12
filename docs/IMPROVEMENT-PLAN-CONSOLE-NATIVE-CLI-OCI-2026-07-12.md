# OpenSphere Console native CLI · OCI 보안 개선 계획서

- 작성일: 2026-07-12
- 기준 커밋: `c368012` (`main`)
- 입력 근거: `AUDIT-REPORT-CONSOLE-NATIVE-CLI-2026-07-12.md` F-1~F-8, Console/Backbone 런타임 검증, OCI Identity & Security 첨부 화면 11건
- 문서 상태: 개선 실행 승인 전 계획안
- 민감정보 처리: 첨부 화면의 이메일, OCID, API key fingerprint, access key 및 credential 식별값은 본 문서에 기록하지 않는다.

## 1. 목표와 비목표

### 목표

1. Console-native `os` CLI 통합을 `ACCEPT WITH CONDITIONS`에서 `ACCEPT`로 승격한다.
2. Console 전체 운영 완결성 조건인 영구 감사, Backbone 복구, 전체 테스트 증거를 확보한다.
3. OCI 운영을 테넌시 전체 관리자 개인 계정에서 OpenSphere 전용 compartment와 최소권한 운영 모델로 분리한다.
4. 장기 비밀정보를 코드·argv·일반 파일에서 제거하고 OS 자격증명 저장소, OCI Vault 또는 OCI workload identity로 이전한다.
5. 모든 권한·자격증명 전환은 기존 break-glass 경로를 유지한 상태에서 검증 후 축소한다.

### 비목표

- 본 계획서 작성만으로 OCI policy, group, credential 또는 Console 배포를 변경하지 않는다.
- 첨부된 기존 credential의 실제 secret 값을 조회하거나 문서화하지 않는다.
- `Tenant Admin Policy`를 즉시 삭제·변경하지 않는다.
- workforce 신원과 Console admin PAT를 결합하지 않는다.

## 2. 현황 판정

### 2.1 Console-native CLI

- 소유권, `/manage/cli`, `/api/cli/*`, cross-build, checksum, read-only API, 2/2 Deployment는 정상이다.
- 구 `/api/plugins/os-cli/*`는 현재 403이며 `CLIDownload/os`는 제거됐다.
- 조건부 승인 원인은 Windows PAT 저장, argv 노출·장기 full-admin PAT, `os-cli` proxy 재도입 우회, artifact 서명 부재, role 변경 감사 누락, Pod 보안 보강, 전체 테스트 인벤토리 불일치다.

### 2.2 Backbone

- PostgreSQL, RustFS, Gitea가 Ready이며 controller는 PostgreSQL 영구 감사 저장소와 RustFS에 연결돼 있다.
- local-path RWO로 노드 소실 HA가 없으며, 오프노드 백업 반출과 실제 restore 훈련 증거가 아직 승인 게이트로 남는다.

### 2.3 OCI 첨부 화면

- 춘천 리전이 선택돼 있다.
- root compartment의 `Tenant Admin Policy`가 활성이고 `Administrators`에 테넌시 전체 리소스 관리 권한이 있다.
- 현재 사용자는 `Administrators` 그룹 소속으로 확인된다.
- API signing key, auth token, customer secret key, SMTP credential이 각각 존재한다. 화면에는 secret 본문이 아닌 metadata만 보이지만, 사용 목적·소유자·마지막 사용·회전 상태의 별도 인벤토리가 필요하다.
- recovery email과 mobile app MFA는 구성됐다.
- FIDO/passkey는 미구성이고 bypass code는 생성되지 않았다.
- 통합 애플리케이션, 접근 요청, 사용자 tag는 현재 화면상 비어 있다.

### 2.4 OCI 보안 해석

현재 권한은 초기 PoC에는 충분하지만 일상 운영·자동화 계정으로는 과도하다. Oracle은 PoC 이후 compartment를 설계하고 IAM group에 최소권한을 부여하도록 권고한다. `manage all-resources in tenancy`는 break-glass 관리 경로로만 제한하고 OpenSphere 자동화는 별도 principal과 compartment 정책으로 분리한다.

### 2.5 OCI Identity Domain 추가 확인

- `Default` identity domain은 Active, Free type이며 home region은 춘천이다.
- 활성 사용자는 화면상 1명뿐이고, 기본 group은 `All Domain Users`와 `Administrators` 두 개다.
- 동일 사용자가 테넌시 `Administrators` group과 `Identity Domain Administrator` 역할을 함께 보유한다.
- `Identity Domain Administrator`는 사용자·그룹·애플리케이션·시스템 설정·보안 설정을 모두 관리하는 domain superuser다.
- Security Administrator, Application Administrator, User Administrator/User Manager, Help Desk Administrator, Audit Administrator에는 별도 담당자가 없다.
- paired remote DR region은 서울로 표시되지만 remote-region disaster recovery 상태는 `Not Enabled`다.

### 2.6 추가 위험 판정

| ID | 심각도 | 위험 |
|---|---|---|
| OCI-IAM-1 | High | 유일한 활성 사용자 또는 인증요소 장애 시 테넌시·identity domain 관리 경로가 동시에 소실될 수 있다. |
| OCI-IAM-2 | High | 한 사용자가 tenancy-wide admin과 identity-domain superuser를 겸해 침해·오조작의 blast radius가 테넌시 전체다. |
| OCI-IAM-3 | Medium | Security/User/Application/Audit 관리가 위임되지 않아 직무분리와 독립 감사가 성립하지 않는다. |
| OCI-IAM-4 | Medium | identity-domain remote-region DR이 비활성이라 춘천 리전 장애 시 인증 연속성 증거가 없다. |

## 3. 설계 원칙

1. **Console native와 외부 provider 신원 분리**: `os` admin PAT는 Console 관리용이다. OCI API key, auth token 또는 customer secret을 PAT에 포함하거나 재사용하지 않는다.
2. **최소권한**: OCI 권한은 `inspect < read < use < manage` 중 필요한 최소 verb와 resource family만 OpenSphere compartment에 부여한다.
3. **사람과 워크로드 분리**: 사람은 named account+MFA, 자동화는 dynamic group/instance principal 또는 별도 제한 principal을 사용한다.
4. **비밀 없는 기본 경로**: 가능하면 OCI instance principal을 사용하고, 불가능한 외부 실행만 전용 API signing key를 사용한다.
5. **감사 실패 시 권한 변경 실패**: role grant/revoke 등 권한 상승 작업은 영구 감사 기록이 성공해야 완료된다.
6. **이중 검증 provenance**: CLI artifact는 SHA-256뿐 아니라 신뢰 키 기반 서명을 검증한다.
7. **단계적 축소**: 새 경로를 생성·검증한 뒤 기존 admin/credential을 축소한다. 반대 순서는 금지한다.

## 4. 개선 작업 패키지

### WP-1. CLI credential 저장·입력 개선 — F-1, F-2

담당: Console Security / Identity

- Windows: Credential Manager 또는 DPAPI로 PAT를 암호화 저장한다.
- macOS: Keychain, Linux: Secret Service/libsecret를 사용한다.
- 기존 JSON config에는 endpoint와 profile만 두고 PAT/ID token 평문 필드를 제거한다.
- `os login --pat-stdin`과 TTY masking 대화형 입력을 추가한다. `--pat <TOKEN>`은 deprecated 경고 후 제거한다.
- migration은 기존 config를 1회 읽어 secure store로 이동하고, 검증 성공 후 legacy PAT 필드를 원자적으로 삭제한다.
- PAT 기본 TTL 목표를 24시간 이하로 낮추고 break-glass 최대 TTL을 별도 정책으로 제한한다.
- PAT에 CLI용 audience/scope를 추가하고 role·resource별 최소권한을 적용한다.
- 발급·조회·폐기·회전 이벤트를 PostgreSQL 영구 감사에 남긴다.

완료 기준:

- Windows에서 PAT가 `%USERPROFILE%/.os/config.json`에 존재하지 않는다.
- process argv와 shell history에 PAT가 남지 않는다.
- Windows/macOS/Linux 각각 secure-store round-trip 및 migration 테스트가 통과한다.
- 만료·폐기·scope 부족 PAT가 CLI와 BFF 양쪽에서 거부된다.

### WP-2. native 서비스 재도입 방지 — F-3

담당: Console Platform

- `NATIVE_BINDING_NAMES={'os'}`와 별도로 `RESERVED_PROXY_SERVICE_IDS={'os-cli'}`를 둔다.
- `CLIDownload` link에서 추출한 service id가 예약값이면 allowlist에 추가하지 않고 상태를 `Rejected`로 기록한다.
- CRD CEL validation 또는 admission validation으로 `/api/plugins/os-cli/*` 선언을 사전 거부한다.
- 다른 metadata.name을 사용한 악성 회귀 fixture를 추가한다.

완료 기준:

- `metadata.name=anything`, `href=/api/plugins/os-cli/index.json`이 controller와 admission 양쪽에서 거부된다.
- `/api/cli/*`만 native CLI를 제공하고 구 plugin 경로는 항상 403이다.

### WP-3. PAT·role 영구 감사 — F-5

담당: Identity / Backbone

- `role grant/revoke`에 actor, subject, role, action, result, reason, opId를 기록한다.
- Kanidm 변경 전에 audit intent를 쓰고, 변경 결과를 append-only audit row로 완결한다.
- audit DB 미연결 시 role 쓰기는 503으로 fail-closed 한다.
- Console UI와 CLI가 동일 opId로 같은 감사 레코드를 조회하도록 한다.

완료 기준:

- 성공·실패·재시도·무권한 role 변경이 모두 PostgreSQL에 기록된다.
- UPDATE/DELETE가 차단된 append-only 보장이 테스트된다.

### WP-4. CLI artifact 서명·공급망 — F-4

담당: Release Engineering

- 기존 plugin의 ECDSA trust model을 재사용하거나 Sigstore/cosign 채택을 ADR로 확정한다.
- platform별 binary digest를 포함한 canonical manifest에 detached signature와 keyId를 추가한다.
- CI가 build→hash→sign→verify→image package 순서를 강제한다.
- `/manage/cli`에 `Verified`, keyId, build commit, build time을 표시한다.
- 키 회전을 위해 현재/차기 키의 dual-trust 기간과 폐기 절차를 둔다.

완료 기준:

- 변조된 manifest, binary, signature, unknown keyId가 모두 배포 전·다운로드 검증에서 실패한다.
- release artifact를 commit과 서명 키까지 역추적할 수 있다.

### WP-5. CLI Deployment 보안·가용성 — F-6

담당: Platform Operations

- Pod `seccompProfile: RuntimeDefault`, 고정 `runAsUser/runAsGroup`, `automountServiceAccountToken:false`를 적용한다.
- PDB `minAvailable:1`을 추가한다.
- topology spread 또는 pod anti-affinity로 replica를 가능한 한 다른 노드에 배치한다.
- NetworkPolicy로 ingress는 Console proxy에서만, egress는 DNS 및 필요한 endpoint만 허용한다.
- read-only root, drop ALL, 제한된 `/tmp` emptyDir는 유지한다.

완료 기준:

- policy 검사와 실제 Pod spec이 일치한다.
- 한 replica drain/재시작 중 `/api/cli/index.json`이 계속 200이다.

### WP-6. 테스트·정합·성능 — F-7, F-8

담당: Console QA / 각 기능 소유자

- 누락된 `os-oaa-agent.ts`를 계약에 맞게 복구하거나, 제거가 정본이면 OAA stale test와 참조를 함께 삭제한다.
- `npm test`에 모든 지원 기능 test를 명시적으로 포함하고 CI에서 테스트 인벤토리 누락을 검사한다.
- CLI의 중복 `registry()` 조건을 제거한다.
- Angular initial bundle 4.22MB와 component style budget 초과에 owner·기한·분할 목표를 부여한다.

완료 기준:

- 공식 전체 테스트 명령이 fail 0이며 감사 문서의 테스트 수와 CI 결과가 일치한다.
- OAA 기능 상태가 `지원/미지원` 중 하나로 정본 문서와 코드에서 일치한다.

### WP-7. Backbone 복구·내구성

담당: Backbone / Platform Operations

- PostgreSQL logical backup, RustFS mirror, Gitea dump를 클러스터 밖 저장소로 반출한다.
- 백업 checksum, encryption, retention, 실패 알림을 적용한다.
- 빈 환경에서 실제 restore drill을 수행하고 RPO/RTO를 측정한다.
- 운영 전 network storage·snapshot·replica 전환 로드맵을 확정한다.

완료 기준:

- 최신 backup으로 PostgreSQL audit, RustFS object, Gitea config repo가 복구된다.
- 복구 결과·소요시간·데이터 손실 범위를 감사 증거로 보관한다.

### WP-8. OCI compartment·IAM 최소권한 전환

담당: OCI Tenancy Admin / Platform Security

#### 8.1 compartment 구조

제안 구조:

```text
root
└─ OpenSphere
   ├─ Security
   ├─ Shared
   ├─ Dev
   └─ Prod
```

- 신규 OpenSphere 자원은 root가 아니라 해당 compartment에 생성한다.
- Dev와 Prod의 사용자·워크로드 권한, 예산, quota를 분리한다.
- compartment는 네트워크 보안 경계가 아니므로 VCN/NSG/route/security list는 별도로 설계한다.

#### 8.2 사람용 그룹

- `OpenSphere-BreakGlass-Admins`: 최소 2명, 테넌시 복구 전용, 일상 사용 금지.
- `OpenSphere-Platform-Admins`: OpenSphere compartment의 승인된 resource family만 manage.
- `OpenSphere-Deployers`: 배포에 필요한 resource family만 use/manage.
- `OpenSphere-Auditors`: inspect/read 중심, Audit·Cloud Guard 조회.

정확한 policy statement는 사용할 OCI 서비스 목록(Compute/OKE/VCN/Object Storage/Vault 등)을 확정한 뒤 생성한다. `manage all-resources in tenancy`를 복제하지 않는다.

#### 8.3 자동화 principal

- OCI 안에서 실행되는 자동화는 instance principal+dynamic group을 우선한다.
- dynamic group rule은 OpenSphere compartment와 tag를 함께 제한한다.
- 로컬/외부 CI가 불가피하면 사람 계정이 아닌 전용 automation user와 제한 policy를 사용한다.
- OCI credential은 Console admin PAT와 분리하고 OCI Vault 또는 승인된 CI secret store에 저장한다.

완료 기준:

- OpenSphere 배포가 `Administrators` 그룹 개인 계정 없이 성공한다.
- automation principal은 OpenSphere 대상 compartment 밖 리소스를 변경할 수 없다.

### WP-9. OCI credential·MFA·감사 정비

담당: OCI Tenancy Admin / Security Operations

- 첨부 화면에 존재하는 API key, auth token, customer secret key, SMTP credential의 owner, purpose, consumer, created, last-used, expiry/rotation을 인벤토리화한다.
- 사용처 없는 credential은 consumer 확인 후 폐기한다.
- API key는 새 키 생성→호출 검증→구 키 비활성/삭제 순서로 90일 이하 회전 정책을 적용한다.
- customer secret/auth token처럼 자동 만료하지 않는 credential은 owner와 수동 회전 기한을 강제한다.
- 개인 관리자 계정의 자동화 credential을 전용 principal로 이전한다.
- mobile app MFA에 더해 Windows Hello 또는 hardware key 기반 FIDO를 등록한다.
- bypass code를 생성해 암호화된 오프라인 break-glass 보관소에 저장하고 사용 절차를 테스트한다.
- OCI Audit log 조회·보존·export를 구성하고 Cloud Guard를 활성화해 IAM/credential 이상 행위를 탐지한다.
- Network Source 제한은 대체 API key와 break-glass 경로를 검증한 뒤 적용한다. 선적용으로 관리자 lockout을 만들지 않는다.

완료 기준:

- 모든 credential에 owner·purpose·rotation due date가 있다.
- 일상 사용자가 테넌시 전체 admin 권한과 장기 automation credential을 동시에 보유하지 않는다.
- FIDO와 mobile app 두 요소가 등록되고 bypass 복구가 검증된다.
- OCI Audit/Cloud Guard에서 policy·group·credential 변경을 추적할 수 있다.

### WP-10. OCI 비용·리전 통제

담당: FinOps / OCI Platform

- OpenSphere Dev/Prod compartment별 budget과 알림 수신자를 설정한다.
- compute, block volume, database 등 고비용 resource family에 quota를 둔다.
- 춘천 리전을 기본 배포 리전으로 명시하고, 승인되지 않은 리전 사용은 quota/policy 조건으로 제한한다.
- 태그 표준 `project=opensphere`, `environment`, `owner`, `cost-center`, `data-classification`을 정의한다.

완료 기준:

- 비용 초과 알림과 quota 거부가 테스트된다.
- 모든 신규 OCI 자원에 필수 defined tag가 적용된다.

### WP-11. OCI Identity Domain 이중화·직무분리

담당: OCI Tenancy Admin / Identity Security / Independent Auditor

#### 11.1 단일 관리자 장애 제거

- 현재 사용자와 자격증명을 공유하지 않는 두 번째 named break-glass 관리자를 생성한다.
- 두 break-glass 관리자는 각각 별도 recovery channel, mobile MFA, FIDO, offline bypass code를 구성한다.
- 최소 2인 중 한 명이 잠김·퇴사·기기 분실 상태에서도 다른 한 명이 사용자, MFA, group, policy를 복구할 수 있는지 시험한다.
- shared account와 shared authenticator 사용을 금지한다.

#### 11.2 일상 관리자와 superuser 분리

- `Administrators`와 `Identity Domain Administrator`는 긴급 복구용으로만 사용한다.
- 일상 업무는 Oracle의 위임 관리자 역할로 분해한다.
  - Security Administrator: MFA, sign-on, IdP, password/security policy
  - User Administrator 또는 제한된 User Manager: 사용자·그룹 lifecycle
  - Application Administrator: integrated application과 application grant
  - Audit Administrator: 로그인·권한·application access 보고서
- 가능한 경우 Security, User/Application, Audit 역할을 서로 다른 named user에게 배정한다.
- 소규모 운영으로 인적 분리가 불가능하면 승인자와 실행자를 분리하고 모든 superuser 사용에 사후 독립 검토를 강제한다.
- 현재 일상 계정의 tenancy/domain superuser 권한 축소는 위임 역할과 break-glass 검증이 끝난 후 수행한다.

#### 11.3 Identity Domain DR

- 서울 paired region 구독 여부와 춘천↔서울 네트워크 접근을 먼저 확인한다.
- 지원 조건을 충족하면 `Enable remote region disaster recovery`를 활성화하고 상태가 `Enabled`가 될 때까지 검증한다.
- Default domain의 일반 region replication과 remote-region disaster recovery를 서로 다른 통제로 기록한다.
- DR failover의 read-only 제약(사용자·그룹·비밀번호 변경 제한)을 반영한 로그인·MFA·application 인증 runbook을 작성한다.
- 방화벽·network source allowlist가 서울 DR endpoint를 차단하지 않는지 확인한다.
- Free domain type에서 필요한 DR·관리 역할·보고 기능이 충족되지 않으면 domain type upgrade를 별도 승인 안건으로 올린다.

#### 11.4 정기 접근 검토

- 월별: admin role, Administrators membership, API/auth/customer secret/SMTP credential inventory 검토.
- 분기별: break-glass 로그인, bypass code, FIDO, 서울 DR 접근, dormant user 및 실패 로그인 보고서 검증.
- 모든 관리자 역할 부여·회수에 ticket, 승인자, 만료일, OCI Audit event를 연결한다.

완료 기준:

- 독립된 break-glass 관리자 2명이 각자 MFA로 로그인하고 상호 복구할 수 있다.
- 일상 사용자는 `Administrators`와 `Identity Domain Administrator` 없이 필요한 업무를 수행한다.
- Audit Administrator가 운영 변경자와 분리되고 로그인·role assignment 보고서를 검토한다.
- remote-region DR가 Enabled이거나, 미지원 사유·보상 통제·승인된 upgrade/복구 계획이 존재한다.
- identity home region 장애를 가정한 로그인·인증 runbook tabletop 결과가 보관된다.

## 5. 단계별 일정

| 단계 | 목표 기간 | 필수 작업 | 종료 조건 |
|---|---:|---|---|
| P0 — 즉시 위험 축소 | 0~2일 | WP-2 예약 service 차단, F-8 정리, OAA test 판정, OCI credential 인벤토리, 두 번째 break-glass 생성, FIDO/bypass 준비 | 경계 우회 차단, 테스트 범위 확정, credential owner 식별, 단일 관리자 장애 제거 |
| P1 — CLI 무조건 승인 | 3~7일 | WP-1 secure store·stdin, scoped/short PAT, WP-3 role audit | F-1/F-2/F-3/F-5 해소, CLI 감사 재검증 PASS |
| P2 — 공급망·런타임 | 2주 | WP-4 서명, WP-5 Pod hardening, 전체 CI green | signed artifact, 보안·가용성 테스트 통과 |
| P3 — OCI 최소권한 전환 | 2~4주 | WP-8 compartment/group/policy/dynamic group, WP-9 credential 이전, WP-11 위임 관리자 역할 분리 | 개인 tenancy/domain superuser 없이 일상 운영·OpenSphere 배포 성공 |
| P4 — 운영 완결 | 4~6주 | WP-7 restore drill, WP-9 Audit/Cloud Guard, WP-10 budget/quota, WP-11 서울 DR 검증, bundle 개선 | Console production·OCI identity resilience 재감사 `ACCEPT` |

## 6. 변경·롤백 안전장치

1. `Tenant Admin Policy`와 기존 Administrators 경로는 새 break-glass 계정 2개와 OpenSphere 최소권한 배포 검증 전 제거하지 않는다.
2. credential은 새 자격증명 검증 후 구 자격증명을 폐기한다. 동시에 전부 회전하지 않는다.
3. PAT secure-store migration은 legacy read를 한 release 유지하되 legacy write는 금지한다. 성공 telemetry 후 legacy read를 제거한다.
4. artifact 서명 키 전환은 dual-trust 기간을 두고 rollback image와 이전 public key를 보관한다.
5. Network Source는 현재 세션이 아닌 별도 break-glass/API 호출로 검증한 뒤 활성화한다.
6. OCI policy 변경 전 현재 policy와 group membership을 export하고 rollback statement를 준비한다.

## 7. 재감사 게이트

| Gate | 승인 증거 |
|---|---|
| G-CLI-1 Credential | 3 OS secure store 테스트, argv/history 비노출, short/scoped PAT |
| G-CLI-2 Boundary | 임의 Binding name의 `/api/plugins/os-cli/*` 우회 거부 테스트 |
| G-CLI-3 Audit | role/PAT 성공·실패 영구 audit row와 fail-closed 테스트 |
| G-CLI-4 Provenance | 세 플랫폼 hash+signature 검증 및 key rotation 증거 |
| G-CLI-5 Runtime | seccomp/PDB/NetworkPolicy/topology 배포와 장애 테스트 |
| G-CONSOLE-1 Test | 지원 기능 전체 CI fail 0, 테스트 인벤토리 일치 |
| G-CONSOLE-2 Backbone | 오프노드 backup+실제 restore drill, RPO/RTO 결과 |
| G-OCI-1 IAM | OpenSphere compartment 최소권한 배포, 외부 compartment 변경 거부 |
| G-OCI-2 Credential | credential inventory·회전·전용 principal 이전 |
| G-OCI-3 Identity | mobile+FIDO, bypass 복구, break-glass 2인 검증 |
| G-OCI-4 Detection | OCI Audit export와 Cloud Guard 탐지·알림 검증 |
| G-OCI-5 Admin resilience | named break-glass 2인, 독립 Audit Admin, 일상 superuser 제거 |
| G-OCI-6 Identity DR | 서울 remote-region DR 또는 승인된 보상통제, 로그인/MFA runbook 검증 |

## 8. 공식 근거

- [OCI IAM security policies — least privilege와 verb](https://docs.oracle.com/en-us/iaas/Content/Security/Reference/iam_security_topic-IAM_Security_Policies.htm)
- [OCI compartments](https://docs.oracle.com/en-us/iaas/Content/Identity/compartments/Working_with_Compartments.htm)
- [OCI dynamic groups](https://docs.oracle.com/en-us/iaas/Content/Identity/Tasks/managingdynamicgroups.htm)
- [OCI IAM credential 보안·90일 이하 회전·instance principal 권고](https://docs.oracle.com/en-us/iaas/Content/Security/Reference/iam_security_topic-IAM_Credentials.htm)
- [OCI Secret Management](https://docs.oracle.com/en-us/iaas/Content/secret-management/Concepts/manage-secrets.htm)
- [OCI MFA/FIDO/bypass code](https://docs.oracle.com/en-us/iaas/Content/Security/Reference/iam_security_topic-iam_mfa_with_identity_domains.htm)
- [OCI Audit](https://docs.oracle.com/en-us/iaas/Content/Audit/home.htm)
- [OCI Cloud Guard](https://docs.oracle.com/en-us/iaas/Content/cloud-guard/home.htm)
- [OCI compartment quotas](https://docs.oracle.com/en-us/iaas/Content/Quotas/home.htm)
- [OCI Identity Domain administrator 역할과 위임](https://docs.oracle.com/en-us/iaas/Content/Identity/roles/understand-administrator-roles.htm)
- [Administrators group은 긴급 용도로 제한](https://docs.oracle.com/en-us/iaas/Content/Identity/conversion/security.htm)
- [Identity Domain remote-region disaster recovery](https://docs.oracle.com/iaas/Content/Identity/domains/disaster_recovery_and_domains.htm)

## 9. 요청 판정

본 계획 승인 후 P0~P2 완료 시 Console-native CLI 재감사를 요청한다. P3~P4 완료 시 Console production completeness 재감사를 요청한다.

```text
Target 1 — Console-native CLI integration: ACCEPT
Target 2 — Console production completeness: ACCEPT
Target 3 — OCI OpenSphere operating model: LEAST-PRIVILEGE VERIFIED
```
