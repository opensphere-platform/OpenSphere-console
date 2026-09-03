# Console API 준비 실패 및 클린 설치 순서 수정

> 후속 관측: edge.24의 API 부재 처리에서 native 무출력/null 결함이 확인됐다. [edge.25 수정 보고서](CONSOLE-INSTALL-EDGE25-NULL-OUTPUT-20260903.md)를 함께 읽는다. 아래의 발행·삭제 검증은 당시 기록이며 전체 클린 설치 성공 기록이 아니다.

2026-09-03. 사용자 요청: API 단계 실패 원인 확인 후 “클린 설치를 준비”. 새 설치는 사용자가 실행하며, 이번 작업은 수정·발행·기존 실패 설치 purge·보고까지다.

## 확인한 실패

edge.23 / Console 202609031558의 세 번째 설치에서 C_API가 `CreateContainerConfigError`였다. Pod `opensphere-console-api-78d8dcffc9-rs5kv`의 Kubernetes 이벤트는 `secret "opensphere-baseline-monitoring-reader" not found`였다. 이미지는 정상 다운로드됐으며 컨테이너는 시작하지 못했다. Supabase PostgreSQL/Auth/REST/Storage 4개는 모두 Ready, 재시작 0이었다. 모니터링 namespace에 workload가 없어 Beszel installer는 실행되지 않았다.

원인은 설치 순서다. C_API 배포는 Beszel reader Secret을 필수 참조하는데 Setup은 C_API Ready 이후에만 이 Secret을 만드는 Beszel installer를 호출했다. 동시에 Beszel installer는 마지막에 존재하지 않을 수도 있는 C_API를 무조건 재시작했다.

후속 단계 검토에서도 C_EXT의 lifecycle readiness가 UIPluginRegistration CRD의 정상 조회를 요구하지만 해당 CRD는 foundation Ready 뒤에 적용되는 결함을 확인했다. 현재 Pod의 직접 실패 원인과 별개인, 코드에서 확인한 다음 단계의 순서 결함이다.

## 수정 경계

- Setup이 검증된 기존 C_EXT CRD 및 신뢰 키를 먼저 적용하고 CRD Established를 확인한다. 다른 workload는 앞당기지 않는다.
- Gitea → Beszel bootstrap 및 reader projection → Supabase·C_API·C_EXT → 나머지 base workload 순서로 진행한다.
- Beszel은 C_API가 아직 없으면 재시작하지 않고 다음 installer가 생성하도록 둔다. 존재하는 C_API는 기존대로 재시작·Ready를 확인한다. 조회 오류/다른 identity는 누락으로 취급하지 않는다.
- C_API installer의 입력 단계에 필수 monitoring reader Secret 존재 확인을 추가한다. 없으면 DB 작업 및 5분 rollout 대기 전에 실패한다.
- 일부 터미널에서 `?`로 보이는 진행 구분자를 ASCII `|`로 바꾼다.
- Secret을 optional로 만들거나, 임의 빈 Secret을 추가하거나, credential을 회전하거나, DB schema/RBAC/NetworkPolicy를 확대하지 않는다. 기존 Ready 기준을 낮추지 않는다.
- 요구 추적: CON-FR-014/017 설치·검증·복구, C_API/C_EXT/C_OBSERVE owner 경계. 새 repo/process/framework/datastore 없음.

## 검증

실제 Setup orchestration 함수를 I/O fixture로 실행하는 테스트를 추가했다. 게시된 이전 함수는 같은 시험에서 실제 누락 Secret 순서 오류를 재현했고, 수정본은 성공한다. Beszel 실패 시 API 미실행, CRD Established 실패 시 foundation 미실행, prerequisite 누락 시 write 이전 실패, legacy rollback 경로 보존을 확인한다.

실제 Beszel PowerShell consumer refresh 분기도 실행하여 fresh absence, existing API refresh, Forbidden, wrong identity를 시험한다. Console 입력/credential/progress 검증 및 Beszel/installer 12개 계약과 전체 machine contract 검증이 통과했다. 실제 새 Kubernetes 클린 bootstrap 성공을 대신 주장하지 않는다.

## 상태

수정·관련 회귀 및 공개 발행·검증·실패 설치 purge 완료. 결과는 아래와 같다. 기존 edge.23 결과 보고는 과거 공개·삭제·읽기 전용 검증 기록이며 실제 클린 설치 성공 기록이 아니다.
## 발행·삭제 완료 증거

- Console source `787b82193125d6c592b16dd05ce09007a01d0998`, version `202609031642`, immutable tag `local-787b82193125`. [Console CI](https://github.com/opensphere-platform/OpenSphere-console/actions/runs/33729459392) 성공. 최초 HTTP E2E의 58080 포트 충돌 후 동일 source·기준을 재실행하여 통과했다.
- `scripts/Publish-LocalEdge.ps1` 종료 0. canonical 18 + auxiliary 3개가 GHCR에 반영됐다. source/date/edge 태그 63개를 인증된 read-only API로 독립 재조회해 응답 bytes SHA-256과 Docker-Content-Digest가 모두 BOM과 일치함을 확인했다(2026-09-03 16:58:50 KST).
- anchor `sha256:6b034f2117f9972a08225b31cfec74da545358ba52e233e00f7674602e939dcf`. localhost/pre-ga/linux-amd64, ga-eligible=false. candidate/stable/GA 승격 없음.
- [Setup edge.24 공개 Release](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/tag/setup-v0.5.0-edge.24), source `21af3001e8eb08e321ca2cfd963a9b10132dfdfb`. [Setup CI](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33729666564), [5-platform publication](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33730087302) 성공. 전체 테스트 316개 통과.
- 공개 Windows EXE 7,497,216 bytes, SHA-256 `2bab26601ceed64f3b228d572d4b3760c7415af05780ef3ae25ecfeb60238265`. exact version/status 실행 및 두 번째 runtime cache 재사용을 확인했다.
- 실패 release `sha256:3236870044fa77b23fcb227b508a7dd35aff34655d80234d5432de7ce0c39035`는 공개 edge.23 uninstall --purge-data로 제거했다. Console 전용 namespace 5개, PV 및 실제 저장 경로 4개 삭제. 고정 관리 cluster resource 12종 잔여 없음. 타 namespace 9개와 Bound PV 8개는 UID/claim 보존.
- K8s 6/6 Ready, 127.0.0.1:1114 사용 가능. 새 설치는 시작하지 않았다. 실패 설치 삭제와 공개 실행 확인은 새 bootstrap 성공을 대신하지 않는다.

상세한 공개 asset·설치 명령·검증 한계는 [Setup edge.24 설치 기록](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/blob/main/docs/CONSOLE-INSTALL-ORDER-EDGE24.md)을 따른다. 추가된 최종 보고 문서는 불변 이미지/Setup release source를 바꾸지 않는다.

로컬 증거는 `.release/registry-auth-verification/console-edge24-publish.log`, `console-edge24-release-bom.json`, `console-edge24-final-tag-verification.json`, `console-edge24-purge-before.json`, `console-edge24-purge-after.json`, `console-edge24-third-purge.log`, `console-edge24-clean-readiness.json`이다. credential 원문은 기록하지 않는다.
