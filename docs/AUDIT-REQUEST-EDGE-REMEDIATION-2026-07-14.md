# OpenSphere Console `edge` 시정 기준선 재감사 요청서

- 요청일: 2026-07-14
- 대상 채널: `edge` — `candidate` 및 `stable` 승격 요청이 아님
- 이전 감사: [통합 기술감사 보고서](../../_DOCS_/30-기술감사/AUDIT-REPORT-INTEGRATED-CONSOLE-EDGE-2026-07-14.md)
- Console 기준선: `dc272f4c4b5eb69fbc924048611f0dbe38689062`
- Setup 기준선: `ff58d6c1916e708fc11dd62250a485b2bc422c04`
- release lock: `sha256:503352a00eb927785a92ec7b54918c0d511f17266997f58d3e3dfb6c3086a333`
- 발행 증거: [GitHub Actions run 29317030360](https://github.com/opensphere-platform/OpenSphere-console/actions/runs/29317030360)
- Setup clean-cluster 증거: [GitHub Actions run 29321079094](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/29321079094)
- 요청 상태: 시정 코드 배포·재현 증거 제출 완료, 독립 재감사 대기

## 1. 목적과 판정 원칙

이 요청서는 이전 감사가 고정한 `7996d93` / `52deaf9` / `sha256:c31d…` 기준선을 대체하지 않는다. 그 기준선에서 확인된 사실과 `candidate HOLD`, 운영 사용 `REJECT` 판정은 유효하게 보존한다.

이번 요청의 목적은 아래 새 기준선에서 시정된 항목을 **독립적으로 다시 검증**하고, 아직 충족하지 않은 승격 조건을 명확히 유지하는 것이다. 실행 중이라는 사실, 구현팀의 주장, 또는 이 문서만으로 어떤 항목도 수용하지 않는다.

## 2. 고정된 새 기준선

| 구분 | 고정 값 | 독립 확인 조건 |
|---|---|---|
| Console source | `dc272f4c4b5eb69fbc924048611f0dbe38689062` | `git rev-parse HEAD`와 모든 lock component `sourceRevision` 일치 |
| Setup source | `ff58d6c1916e708fc11dd62250a485b2bc422c04` | release resolve / bootstrap / upgrade / verify 동작 대조 |
| release lock | `sha256:503352a00eb927785a92ec7b54918c0d511f17266997f58d3e3dfb6c3086a333` | 9개 component digest·revision·attestation·SBOM 대조 |
| CI | run `29317030360` | test, native macOS CLI, 9 image publish, provenance, SPDX SBOM 모두 성공 |
| 설치 검증 | Setup `verify` | `14 pods / 12 services / runtime images locked`를 새 환경에서 재현 |

## 3. 시정 대상으로 제출하는 항목

| 이전 발견 | 제출한 시정 | 감사자가 확인할 완료 조건 |
|---|---|---|
| INT-AUD-001 P0 | PostgreSQL `console` 앱 역할을 비-superuser·비소유자로 분리하고, `audit_log`를 `opensphere_audit_owner`가 소유. 앱 역할은 UPDATE/DELETE/TRUNCATE 권한이 없음. | 라이브 role/owner/privilege 질의로 `console:false:false`, owner `opensphere_audit_owner`, `false:false:false`를 확인하고, app role이 trigger/ownership을 우회할 수 없는지 시험. |
| INT-AUD-002 P1 | GitHub Actions OIDC provenance 및 SPDX SBOM attestation을 release resolve의 필수 신뢰 조건으로 추가. channel tag는 검증된 9 component digest lock을 찾는 용도일 뿐 설치 입력이 아님. | 변조·누락·revision 불일치·attestation/SBOM 부재를 Setup이 우회 없이 거부하는지 확인. |
| INT-AUD-003 P1 | `/api/identity`를 token introspection 기준으로 통일. | 강등·비활성·폐기 후 기존 id token/PAT/device session이 허용 지연 없이 거부되는지 확인. |
| INT-AUD-004 P1, INT-AUD-009 P2, INT-AUD-010 P2 | CBS audit role boundary, `source` 열, PostgreSQL backup CronJob·RustFS 보관·restore drill을 추가. | backup artifact, 복원 drill, 보존·실패 알림을 별도 새 환경에서 확인. 외부/off-cluster 복제 부재는 미해결 조건으로 기록. |
| INT-AUD-005 P1 | Setup의 port-forward 기반 접근·일반 endpoint 설정·amd64/arm64 제품 artifact 계약을 구현. | Docker Desktop이 아닌 지원 Kubernetes에서 깨끗한 bootstrap·verify·upgrade·rollback을 수동 patch 없이 성공. 이 항목은 아직 독립 실증 전이다. |
| INT-AUD-006 P1 | bootstrap service credential의 수명 제한·rotation/폐기 명령 경로를 추가. | 설치 후 token이 무기한·상시 고권한으로 남지 않으며 rotate/revoke가 실제 Kanidm 상태에 반영되는지 확인. |
| INT-AUD-007 P2 | 관리자 대상 onboarding link는 별도 recovery approval 없이는 거부하도록 제한. | 일반 사용자와 관리자 대상 각각의 권한·사유·감사·TTL을 확인. |
| INT-AUD-011 P2 | BFF/readiness에 CBS 의존성 반영을 제출. | PostgreSQL/RustFS/Gitea 장애 주입 때 health/readiness와 사용자 오류가 거짓 정상으로 남지 않는지 확인. |
| INT-AUD-012 P2 | `os registry` 및 discovery 응답의 JSON content-type·schema/version 검증을 추가. | HTML 200, 잘못된 content-type, 구버전 schema를 fail-closed 하는지 확인. |
| INT-AUD-016 P2, P3 macOS key storage | Setup 비밀 전달 경로와 macOS CLI Keychain 저장을 argv 비노출 방식으로 변경. macOS native arm64에서 Keychain round-trip test와 artifact 빌드를 CI로 강제. | process/CI/실제 macOS에서 비밀이 argv·환경·임시 파일에 남지 않고 Keychain API를 직접 쓰는지 확인. |

## 4. 구현팀이 새 기준선에서 재확인한 증거

다음은 독립 감사의 대체물이 아니라 재현 출발점이다.

1. `edge` release resolve는 `dc272f4…` revision의 9개 component와 GitHub Actions provenance/SPDX SBOM 검증 시각을 포함하는 lock을 생성했다.
2. 그 lock만 입력으로 Setup upgrade를 수행했고, Setup verify가 `14 pods / 12 services / runtime images locked`를 반환했다.
3. 실행 PostgreSQL의 읽기 전용 검증은 앱 role에 대해 `console:false:false`, audit table owner `opensphere_audit_owner`, UPDATE/DELETE/TRUNCATE `false:false:false`를 반환했다.
4. `os --version`은 `os 0.4.0`을 반환했다.
5. GitHub Actions run `29317030360`은 native macOS arm64 Keychain test·artifact build, 9개 다중 아키텍처 image publish, provenance 및 SPDX SBOM attestation을 성공으로 기록했다.
6. GitHub Actions run `29319863597`은 Docker Desktop과 분리된 Linux kind cluster에서 local-path StorageClass를 준비한 뒤 public Ingress/DNS 없이 edge resolve·bootstrap·backup/restore drill·Service port-forward CLI download·verify를 성공했다.
7. GitHub Actions run `29321079094`는 같은 clean Linux kind 설치를 `development`와 명시적 `production` 인증 프로파일에서 각각 실행했다. 두 환경 모두 `opensphere-console-auth` Deployment의 `AUTH_ENVIRONMENT`를 요청값과 대조한 뒤 bootstrap·CLI 설치·verify를 성공했다. GitHub Attestation API의 일시적 5xx/429 장애는 제한 재시도하지만, 서명·SBOM·발행 workflow·repository·branch 검증 실패는 즉시 fail-closed 한다.

감사자는 위 각 결과를 새 workspace와 새 cluster에서 다시 생성해 원본 출력을 보존해야 한다.

## 5. 아직 닫히지 않은 승격 조건

아래 조건은 이 재감사 요청으로 위험 수용되거나 해결된 것으로 간주하지 않는다.

| 조건 | 현재 상태 | 승격 영향 |
|---|---|---|
| 일반 Kubernetes 독립 설치 | Linux kind clean bootstrap/CLI install/verify CI 증거는 있음. 독립 운영 cluster에서의 upgrade·rollback과 장기 운영 증거는 없음 | `candidate` HOLD |
| 외부/off-cluster backup 및 노드·볼륨 손실 복구 | in-cluster RustFS backup/restore drill은 있으나 외부 복제·HA 검증 없음 | `candidate` 조건부, `stable` Block |
| 운영 CA 및 TOTP 강제 | edge 기본은 development이며, 명시적 production 프로파일 전달은 clean CI로 확인됨. 운영 CA와 실제 운영 로그인 E2E는 별도 증거 필요 | 운영 사용 REJECT |
| UI/접근성 정본 준수 | Clarity v18 전환·상태·접근성 시정은 사용자 구성요소 승인 후 별도 범위로 수행해야 함 | `candidate` P2 위험수용 또는 시정 필요 |
| 정본 문서 거버넌스 | 상위 헌법 문서의 기존 미커밋/중복 정리는 이 기준선에 포함하지 않음 | `candidate` 조건부 |
| 운영 runbook·비밀/인증서 회전 훈련 | 코드 경로와 실제 운영 훈련은 별도 검증 필요 | `stable` Block |

따라서 구현팀의 현재 입장은 **새 edge 기준선은 재감사 가능하지만, `candidate` 승격은 여전히 HOLD이며 운영 사용은 여전히 REJECT**이다.

## 6. 필수 독립 재감사 절차

1. `dc272f4…` Console 및 `ff58d6c…` Setup을 새 clone으로 checkout한다.
2. `edge`를 resolve하여 lock의 9개 digest/revision/provenance/SBOM을 확인한다. tag만으로 이미지를 설치해서는 안 된다.
3. Docker Desktop 이외의 지원 Kubernetes에서 `bootstrap -r edge`, `bootstrap -r edge --auth-environment production`, `verify`, `upgrade`, rollback을 수행한다. 모든 manifest 직접 수정은 실패로 간주한다.
4. runtime role/ownership/privilege 질의와 audit write/failure path를 실행한다.
5. browser 및 `os`에서 강등·비활성·device revoke·PAT revoke·registry HTML fallback을 포함한 실패 경로를 확인한다.
6. PostgreSQL backup을 새 환경에 restore하고 감사 연속성·권한 경계를 확인한다.
7. 승인된 Clarity component 기준으로 UI/keyboard/reader/고대비/모바일 검증을 별도 수행한다.

## 7. 요청 판정

감사자는 이전 보고서의 발견별로 `fixed / partially fixed / not fixed / not independently verified`를 판정하고, 특히 P0/P1이 0건이 되었는지 판단해야 한다. 일반 Kubernetes 재현, 외부 복구, 운영 CA/TOTP, UI 접근성은 독립 증거가 생기기 전에는 승격 근거가 될 수 없다.
