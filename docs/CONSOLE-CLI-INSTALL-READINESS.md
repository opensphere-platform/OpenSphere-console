# Setup CLI를 통한 Console 설치 준비

> 후속 실제 설치에서 SQL 구문 오류가 확인됐고 Console 202609031456 / Setup edge.22로 수정 발행했다. 아래 doctor 성공은 설치 성공이 아니다. 최신 복구 상태는 [SQL 오류 및 복구 보고서](CONSOLE-INSTALL-SQL-REPAIR-20260903.md)를 따른다.

2026-09-03. 목표는 공개 Setup CLI가 localhost docker-desktop Kubernetes에서 Console을 설치할 수 있도록 하는 것이다. CLI 자체 발행으로 완료 처리하지 않는다.

**현재 판정 (2026-09-03 14:38 KST): 설치 사전진단 통과 / Kubernetes 미설치.** Console `202609031353` 통합 이미지 21개의 GHCR 발행·edge 승격, 양쪽 main CI, 공개 Setup `setup-v0.5.0-edge.21`의 실제 최소 OAuth 권한 doctor가 모두 통과했다. 원격 설치 자료 47개/manifest 12개 그룹까지 검증했다. 아래 작업 시작·차단·승인 기록은 이력이며 현재 차단 상태가 아니다. 정확한 artifact, 명령, 미실행 범위는 [최종 발행·진단 결과](CONSOLE-INSTALL-RELEASE-202609031353.md)를 따른다.

## 현재 작업과 권한

사용자가 Console 설치 준비를 명시적으로 요청했다. 이전의 main push·GHCR 발행·OAuth 운영 인계 및 여섯 Secret get/update 승인을 이어 적용한다. 다른 namespace/제품/cluster는 수정하지 않는다. Setup은 Windows에 상주 설치하지 않는다.

- requestIntent: prepare Console installation through Setup CLI
- releaseScope: integrated
- justification: 새 migration 및 registry-auth/v1 설치·운영 인계가 API/installer/schema에 걸치며, 검증된 현재 설치용 통합 BOM을 구성해야 한다. component 릴리스로 통합 anchor를 임의 변경하지 않는다.
- buildAuthority: Windows localhost, linux/amd64, docker-desktop
- production surfaces added: 0 repositories, 0 processes, 0 datastores, 0 frameworks
- temporary verification: 격리 PostgreSQL 컨테이너만 사용하며 검증 후 제거
- preserved namespaces: opensphere-developer, opensphere-developer-standalone, opensphere-www 및 cluster infrastructure

## 작업 시작 시 확인된 상태 (이력)

- Kubernetes v1.36.1, 6/6 Ready amd64 nodes. Console 관리 namespace는 아직 없다.
- 공개 Setup edge.21에 OAuth App Client ID가 포함돼 있다. 실제 identity/refresh는 통과했지만 GHCR manifest는 404였다. 갱신 과정에서 사용한 credential은 저장하지 않았다.
- Console API 188개, 계약 30개, bootstrap-core 릴리스 준비 gate 통과. 전체 기능/실제 PostgreSQL/배포 검증은 계속 진행 중이다.
- GHCR publisher 로그인을 Docker credential store에 연결했다. Git GCM은 repo/workflow용이다. publisher와 runtime 최소 읽기 권한을 구분하며 publisher credential을 클러스터에 넘기지 않는다.

## 완료 기준

1. Console 구현·DB 권한/MFA 검증, source 추적·main 동기화 완료.
2. 현재 source commit의 KST 공식 버전, canonical GHCR 이미지와 BOM, anchor-last edge 이동 검증.
3. 최소 읽기 credential로 정확한 이미지 digest 접근을 검증하고 Console에 운영 권한을 안전하게 인계.
4. 공개 Setup의 resolve/doctor가 localhost에서 통과하고, 검증한 명령·이미지·버전·남은 위험을 보고.
5. 설치·rollout 및 Console 운영 인계를 실행했다면 그 실제 결과를 별도 기록. 미실행을 성공으로 표시하지 않음.

## 실제 GHCR 원인 확인

기존에 사용자가 제공한 발행 자격 증명을 숨김 입력으로 사용해 계정·packages 권한을 확인했다. 소유 계정의 container package 목록은 6개였고 opensphere-console을 포함한 Console release family는 없었다. 같은 발행 credential의 Console edge manifest 조회도 404였다. 기존 실패는 단순 OAuth 로그인 실패로 판단할 수 없으며 설치할 Console 이미지/BOM을 실제로 발행해야 한다. broad publisher credential은 Docker 발행용으로만 연결하고 Setup/Console runtime 인계에 사용하지 않는다.

## 설치 전 발견 및 수정

- DB 상태 함수의 이전 RLS 개수 기대를 새 0028 migration으로 수정했다. 전체 16개 보호는 Ready, 일부 보호 해제는 Blocked다.
- 초기 관리자 권한은 최신 managed_role_permissions 계약상 11개다. API의 10개 기대값 때문에 실제 등록에서 503이 발생하던 오류를 수정했다. 단일 승자·패자 정리 HTTP 검증이 통과했다.
- 이전 전체 migration 개수/최신 ID/digest 및 DB 통합 시험의 C_EXT owner authority 주소를 현행 설치 계약에 맞게 갱신했다.

## 최종 로컬 검증 및 외부 반영 차단 (2026-09-03)

- 격리 PostgreSQL: migration 28개 실제 적용, SQL 검증 28개, 초기 관리자 경쟁 요청 HTTP E2E, 전체 Console API/Extension Controller DB HTTP E2E 모두 통과. 검증 컨테이너 제거 완료.
- Console: 전체 회귀 785개, 별도 API 188개, migration 계약 30개, bootstrap-core release gate, 웹 production build, OS CLI/Registry Go 검증 통과.
- Setup: 현재 수정된 Console source를 대상으로 298개 테스트 통과. 공개 edge.21 런타임과 registry-auth/v1 계약은 호환된다. source lock의 원격 pin 갱신은 Console push 이후 수행한다.
- 실제 docker-desktop Kubernetes: v1.36.1, 6/6 Ready linux/amd64, 기본 StorageClass standard, 설치 권한 및 https://localhost:1114 포트 확인 통과.
- Setup renderManifest로 현재 Console API 14개 객체를 실제 API 주소(10.96.0.1/32 TCP443, 172.18.0.3/32 TCP6443)에 맞춰 렌더링하고 client dry-run / strict schema 검증 통과. 가상 image digest를 사용한 문법 검증이며 설치 artifact 또는 실제 Pod 동작 증거가 아니다.
- 변경 소스의 실제 PAT/OAuth token/private key 유입 검사 통과. 기존 CLI signing key와 public key 일치만 확인했으며 개인키 원문을 출력하지 않았다.

자동 보안 검토는 main stage/commit/push 요청을 실행 전에 거부했다. O:/OpenSphere/AGENTS.md의 과거 문서 전용/외부 반영 제한을 근거로 이전 대화의 push 승인을 인정하지 않았다. 차단된 명령은 실행되지 않았다. 제한을 우회하거나 AGENTS.md를 수정하지 않았다. 현재 Console HEAD는 순방향 SQL 원본 commit fa287c6cbf2e8cff5a2e0f46658beafc0c758a1d이고, 검증된 나머지 변경은 작업 트리에 보존되어 있다. 새 Console GHCR 이미지/BOM/edge 이동 및 Kubernetes 설치는 실행하지 않았다.

## 승인 요청 시 계획한 실행 범위 (이력)

1. 검증된 Console 변경을 main에 commit/push한다. 새 source commit의 Git committer timestamp를 Asia/Seoul로 변환한 yyyyMMddHHmm만 공식 image 버전으로 사용한다.
2. 기존 scripts/Publish-LocalEdge.ps1로 Windows localhost에서 linux/amd64 canonical 18개 + auxiliary 3개를 빌드/서명·GHCR push한다. exact digest/metadata 검증 후 immutable 날짜 tag, Console anchor 마지막 순서로 edge를 이동한다. 기존 tags/package를 삭제하거나 공개로 전환하지 않는다.
3. Setup source lock을 공개된 Console commit으로 갱신하고 conformance/CI를 검증한다. runtime 동작 변경이 없다면 공개 edge.21을 덮어쓰거나 재발행하지 않는다.
4. 새 최소 read:packages OAuth 승인을 한 번 받아 실제 GHCR digest 접근과 공개 Setup doctor를 실행한다. Publisher 관리자 키는 Setup/Console에 인계하지 않는다. 승인된 OAuth credential은 한 실행 안에서만 보유하며 local runtime cache에 저장하지 않는다.
5. 설치 준비 완료는 doctor의 전체 공급망/소스/매니페스트 검증 통과 이후로 판정한다. Kubernetes 설치/rollout 및 갱신 인계 실검증을 수행했다면 그 결과를 별도 기록한다.

발행 후 사용할 휴대형 명령(계획 당시 GHCR 미발행 상태였으며, 현재 결과는 문서 상단 링크 참조):

```powershell
.\opensphere-setup.exe --channel edge doctor --release edge --context docker-desktop --registry-auth oauth
.\opensphere-setup.exe --channel edge bootstrap --release edge --context docker-desktop --registry-auth oauth
```

Windows 상주 설치, PATH 변경, host CLI 설치 및 CA 신뢰 등록은 하지 않는다. 별도 명령 실행마다 OAuth 승인이 필요할 수 있다. 기본 StorageClass standard는 자동 탐지한다. 다른 Developer/WWW namespace 및 기존 workload를 수정하지 않는다.

## 외부 반영 승인

2026-09-03 사용자가 검증된 변경의 main push·GHCR 이미지 발행·edge 채널 갱신 요청에 “승인한다”라고 답했다. 이전 자동 검토 차단 이후 이번 작업 범위를 명시적으로 승인한 기록이며, 광역 권한 부여나 다른 서비스 변경 승인이 아니다. 승인 범위대로 발행 및 설치 전 진단을 이어 진행한다.

## 발행 경로 보완

깨끗한 worktree에서 잠금 파일 기반 dependency 설치를 먼저 수행하도록 발행 스크립트를 보완했다. CI는 migration 원본 commit 검증을 위해 전체 Git 이력을 받는다. 내장 Manual의 두 체크섬 불일치와 폐기된 source 참조를 수정하고, 저장된 DESIGN snapshot의 자체 무결성 및 저장소 문서 원본 일치를 검사하는 gate를 CI/발행에 추가했다. 외부 DESIGN이 없는 CI에서 최신 외부 설계를 검증한 것으로 주장하지 않는다. 변경 후 매뉴얼·발행 회귀 17개가 통과했다. 이전 c31df1f 기반 발행은 채널 승격 전에 중지했으며 fd80207 소스로 전체 통합 BOM을 다시 발행했다.
