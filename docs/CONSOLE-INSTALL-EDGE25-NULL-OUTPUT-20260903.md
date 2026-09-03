# Console edge.24 Beszel 후처리 null 오류 — edge.25 수정

2026-09-03. 상태: 원인 실측·수정·회귀 검증 완료, 발행 및 실패 설치 삭제 준비. 사용자가 수정판 업데이트 후 클린 설치 준비·보고를 지시했다. 새 bootstrap은 실행하지 않는다.

## 직접 원인과 검증 누락

edge.24의 Beszel Hub 1/1, Agent 6/6, bootstrap Job Complete, reader Secret 생성까지 정상 완료됐다. 새로 추가한 API consumer 조회에서 아직 없는 Deployment를 `kubectl get --ignore-not-found -o name`으로 읽으면 native stdout이 없다. production Get-KubectlValue를 통과한 결과는 빈 문자열이 아니라 `$null`이다. 이후 `$consoleApi.Trim()`에서 null method 호출 예외가 발생했다. 설치 순서상 API 부재는 정상인데 이를 안전하게 처리하지 못했다.

공개 edge.24에 포함된 PowerShell 7.6.4와 실제 Kubernetes의 읽기 전용 조회로 exit 0 / helper result null / Trim 예외를 그대로 재현했다. 예상 불가능한 인프라 장애가 아니라 edge.24 코드와 테스트의 결함이다. 앞선 테스트는 Get-KubectlValue 자체를 빈 문자열 반환으로 대체하여 native 무출력 경계를 누락했다.

## 수정과 검증

consumer 분기를 `if (-not [string]::IsNullOrWhiteSpace($consoleApi))`로 바꿨다. 실제 API가 있을 때만 identity를 확인하고 restart/status를 수행한다. Forbidden 등 native nonzero는 production helper에서 계속 실패한다. credential, schema, RBAC, NetworkPolicy와 Ready 기준은 변경하지 않는다. CON-FR-014/017 및 C_API/C_OBSERVE의 fresh bootstrap 경계 수정이다.

회귀 테스트는 production Get-KubectlValue와 consumer 분기를 모두 실행하며 외부 kubectl만 native Node 프로세스 fixture로 대신한다. stdout 없음이 실제 null로 전달되는지 명시적으로 확인한다. absent/present/nonzero/wrong identity를 검증하며, 강화한 동일 테스트가 공개 edge.24 source를 실패시키고 수정본을 통과시키는 것을 확인했다. 공개 PowerShell 7.6.4의 기존 installer runtime tests와 관련 Node 계약 테스트 12개도 통과했다.

추가로 실제 Kubernetes 조회와 수정 consumer 분기를 실행하되 모든 mutation 호출을 금지해, API가 없는 현 상태에서 정상 완료됨을 확인했다. 이는 전체 installer/전체 Kubernetes clean bootstrap 성공을 뜻하지 않는다.

증거: `.release/registry-auth-verification/edge24-beszel-null-reproduction.json`, `edge24-native-null-before.log`, `edge24-beszel-null-runtime-test.log`, `edge24-beszel-null-contract-tests.log`, `edge24-beszel-null-live-readonly.log`. credential 원문 없음. 발행·삭제 완료 결과는 후속 절에 기록한다.
