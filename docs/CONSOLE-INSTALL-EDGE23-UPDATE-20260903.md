# Console 설치 오류 수정 및 단계별 진행 표시

2026-09-03. 사용자 지시: “업데이트, 기존 설치 삭제 후 보고. 클린 설치는 사용자가 다시 진행.” 상태: **main 반영·공개 발행·GHCR 63개 태그 검증 완료 / 두 번째 실패 설치 삭제 완료 / 새 설치 미실행**.

## 변경

- fresh PostgREST 노출을 실제 존재하는 `storage`로 한정했다. Console authority는 C_API의 기존 직접 DB 경로를 유지하며 레거시 빈 schema나 새 권한을 추가하지 않는다.
- 기존 C_API Secret의 Kubernetes outer base64와 애플리케이션 canonical base64를 각각 해석해 32-byte 키를 검증한다. 정상 키를 교체하지 않으며 비정상 길이/인코딩은 계속 거부한다.
- Setup은 검증한 API egress를 실제 PowerShell installer에 전달하는 template에도 반영한다. image/origin 치환은 기존 installer가 수행한다. Endpoint discovery 실패·넓은 CIDR은 fail closed.
- installer는 12개 실제 단계의 시작/완료/실패와 경과 시간을 출력한다. Console migration은 기존 적용 건수와 각 migration의 적용 시작/반영을 표시한다.
- rollout/wait는 기존 kubectl 명령과 Ready/timeout 판정을 유지하면서 native 진행 내용을 즉시 표시하고 15초 간격으로 마지막 준비 상태와 경과 시간을 다시 알린다. 멈춘 단계가 뒤의 API/Controller 설치로 보이지 않는다.
- 진행 표시는 stderr에 쓰며 최종 stdout JSON 계약을 보존한다. SQL/Secret/manifest 출력 경로는 열지 않는다. 준비 확인 명령의 임의 provider stderr도 그대로 재출력하지 않는다.
- 새로운 framework, dependency, repository, 장기 실행 process, 데이터 저장소, DB schema, 권한 확대: 없음.

관련 요구: CON-FR-014/017 설치·운영/복구, C_API 및 Supabase owner boundary. API egress는 이미 승인된 CON-FR-007 Registry credential lifecycle 범위만 사용한다.

## 세부 단계

| 번호 | 실제 작업 |
|---|---|
| 01 | 설치 입력·기존 상태 검증 |
| 02 | Supabase 선언 적용·PostgreSQL 준비 |
| 03 | Supabase 서비스 DB 역할 동기화 |
| 04 | Supabase Auth 준비 |
| 05 | Storage Pod 실행·자체 schema 초기화 |
| 06 | Console DB migration |
| 07 | Supabase REST 준비 |
| 08 | Supabase Storage 준비 |
| 09 | Console API 최소권한 계정·전용 Secret 확인 |
| 10 | Extension Controller 최소권한 계정·전용 Secret 확인 |
| 11 | Console API 배포·준비 |
| 12 | Extension Controller 배포·준비 |

예시 형식이며 아래 시간은 실측 성공 증거가 아니다.

```text
[시작 06/12] Console DB 마이그레이션 (0.0s)
[진행 06/12] Console DB 마이그레이션 — 기존 적용 0/28, 나머지 순차 적용 (0.1s)
[반영 06/12] Console DB 마이그레이션 — 28/28 opensphere-console/20260903/0028 (8.1s)
[시작 07/12] Supabase REST 준비 (최대 10분) (0.0s)
[대기 07/12] Supabase REST 준비 (최대 10분) — Waiting for deployment ... 0 of 1 updated replicas are available... (15.0s)
```

## 검증

- Setup 전체 테스트 309개 통과. 실제 materialization 함수가 installer에 쓰는 내용과 최종 render 검증 내용을 비교하는 positive/negative 회귀 포함.
- 실제 PowerShell 함수 검증: 정상 기존 Secret 반복 재사용, 잘못된 키 5종 거부, live output/heartbeat/elapsed, nonzero readiness 실패, stdout 보존, provider stderr 미노출.
- installer 기존 계약 6개 통과.
- 격리 PostgreSQL: 실제 installer 서비스-role SQL, fresh target manifest, 28개 migration/28개 SQL 검증, 초기 관리자 및 API/Controller DB HTTP E2E 통과.
- 위 검증을 CI에 연결했고 Console source 91cb7c99c3b8 및 Setup release source c2c24606bc3e의 CI가 통과했다. 기존 migration 원본/manifest digest는 변경하지 않는다.
- 이것만으로 실제 클린 bootstrap 완료, 전체 기능 완성 또는 GA를 주장하지 않는다.

## 현재 설치 상태와 다음 작업

사용자가 다시 실행한 공개 edge.22 설치는 2026-09-03T06:54:20Z에 REST readiness timeout으로 Failed가 됐다. PostgreSQL/Auth는 정상이고 28개 migration은 적용됐으나 REST/Storage 준비가 실패해 API/Controller 단계에 도달하지 못했다.

이번 요청에서 수정판을 발행하고 이 설치를 명시적으로 purge했다. 대상 namespace/볼륨/설치 lock 잔여 0건과 다른 서비스 보존을 확인했다. 새 설치 자체는 시작하지 않았다. 소스/문서 및 portable 실행 파일·다운로드 cache는 삭제 대상 데이터에 포함하지 않는다.

이전 보존형 upgrade 및 첫 purge 기록은 과거 증거다. 이전 auto-review 차단 이후 사용자가 이번 업데이트를 명시적으로 다시 지시했고, 좁은 수정이 승인되어 반영됐다. 정책 파일을 수정하거나 차단을 우회하지 않았다.

## 발행 결과

| 대상 | 발행 및 검증 결과 |
|---|---|
| Console source | `91cb7c99c3b8b499e204e4b6277e37d6bb901137` |
| Console 버전 | `202609031558` |
| 고정 source tag | `local-91cb7c99c3b8` |
| Console 채널 | `edge`, `localhost` build authority, `pre-ga`, `gaEligible=false`, `linux/amd64` |
| GHCR 범위 | canonical 18개 + auxiliary 3개, 총 21개 |
| Console anchor | `sha256:84348d9b833d77cda3c2ab5a37c7620085d5379ccf28292c37e51980e6c3b217` |
| Setup 공개 버전 | `setup-v0.5.0-edge.23` |
| Setup release source | `c2c24606bc3e2be4e7b9180e656bd342a7f541ed` |
| Setup 플랫폼 | Windows amd64, Linux amd64/arm64, macOS amd64/arm64 |

- [Console CI 33725807884](https://github.com/opensphere-platform/OpenSphere-console/actions/runs/33725807884) 성공.
- [Setup CI 33726928128](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33726928128) 성공.
- [Setup 공개 빌드 33726928343](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33726928343) 성공. 공개 platform runtime smoke test 포함.
- [Setup edge.23 공개 Release](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/tag/setup-v0.5.0-edge.23) 발행 완료.
- 공개 Windows EXE 7,497,216 bytes, SHA-256 `3bff50b81d01897cba9ecc509d91bb59663127d9b53b21af9fede86c09cd47e5`. GitHub asset digest와 공개 SHA256SUMS 둘 다 대조했다.
- 실제 다운로드한 EXE의 version 및 읽기 전용 status를 실행했다. 이어서 같은 status를 재실행해 검증된 runtime 재사용/추가 다운로드 없음도 확인했다.

공식 게시 스크립트는 21개 이미지의 source/platform/policy label 검증, 21개 날짜 태그와 21개 edge 태그 반영까지 수행했다. 마지막 전체 조회에서 오류로 종료했고, 후속 Docker 조회에서는 anonymous 401이 관찰됐다. 따라서 그 스크립트 자체를 성공 종료했다고 기록하지 않는다. 이후 게시자 credential을 메모리에서만 사용해 GHCR의 repository별 read-only token으로 21개 이미지 × source/date/edge 3개 태그를 전부 다시 조회했다. 응답 bytes의 SHA-256 및 Docker-Content-Digest가 모두 BOM과 일치했으며 63개 검증이 종료 0으로 완료됐다. 재검증은 원격 쓰기나 검증 기준 변경을 하지 않았다.

Setup의 첫 Windows 공개 빌드에서 발견한 동시 receipt 파일 경합도 수정했다. `.tmp`/`.staging`의 디렉터리 관찰 중 다른 writer가 제거한 정상 형식 파일의 ENOENT만 허용한다. 실제 append/cleanup의 exact bytes, directory identity, symlink/hard-link 및 권한 오류 거부는 유지한다. 삭제/비정상 교체를 결정적으로 재현하는 회귀와 Windows 실제 8 writer 테스트를 포함해 전체 309개가 통과했다.

## 삭제 결과

[두 번째 클린 삭제 기록](CONSOLE-INSTALL-CLEAN-PURGE-20260903.md)에 실제 공개 CLI 실행 및 비대상 보존을 기록했다.

- Console 전용 namespace 5개와 연결된 데이터 볼륨 4개 삭제.
- local-path provisioner 로그로 실제 저장 경로 4개 삭제 확인.
- 고정 관리 cluster resource 12종 잔여 0개. 생성되지 않았던 CRD 등을 실제 삭제 개수로 부풀리지 않는다.
- 비대상 namespace 9개 및 Bound PV 8개는 원래 UID/claim 보존. Developer, Developer standalone, WWW와 공용 기반 자원 포함.
- 1114 listener 없음. 노드 6개 모두 Ready. `standard` StorageClass 존재.
- 소스·문서·실행 파일·검증된 runtime/image cache 및 외부 계정/OAuth 앱은 유지.

## 사용자 클린 설치 명령

[새 Windows EXE](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.23/opensphere-setup.exe)를 내려받아 원하는 폴더에서 실행한다. 아래 명령은 사용자 실행용이며 이번 작업에서는 실행하지 않았다.

```powershell
.\opensphere-setup.exe --version 0.5.0-edge.23 bootstrap `
  --release edge --context docker-desktop `
  --storage-class standard --registry-auth oauth
```

기기 인증은 실행 중 표시되는 새 코드로 승인한다. 이전 설치의 Kubernetes OAuth/pull Secret은 이번 purge 범위에 포함되어 제거됐으므로 새 bootstrap이 새 운영 credential을 인계해야 한다. 호스트에 프로그램 설치/PATH/service 등록을 하지 않으며 CA 신뢰 등록도 위 명령에는 포함하지 않았다.

실제 새 Kubernetes bootstrap, 전체 Console 기능, GA 완성을 주장하지 않는다. 사용자가 새 설치를 시작하면 실제 결과를 기준으로 후속 판단한다.

## 재현 가능한 근거

credential 원문 없이 Console `.release/registry-auth-verification/`에 `console-edge23-db-tests.log`, `console-edge23-release-bom.json`, `console-edge23-publish-resume2.log`, `console-edge23-final-tag-verification.json`, `console-edge23-purge-before.json`, `console-edge23-purge-after.json`을 보관한다. 공개 실행 파일과 실행 증거는 Setup `.release/public-edge23/`에 보관한다. 문서 후속 commit은 이미 발행한 image/Release source를 바꾸지 않는다.