# Console API 준비 실패 및 클린 설치 순서 수정

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

로컬 수정·관련 회귀 완료. 공개 Setup edge.24 및 새 Console edge 발행, 현재 실패 설치 purge와 최종 검증 결과는 아래에 추가한다. 기존 edge.23 결과 보고는 과거 공개·삭제·읽기 전용 검증 기록이며 실제 클린 설치 성공 기록이 아니다.