# OpenSphere Baseline Monitoring 운영 Runbook

이 디렉터리는 Console이 Prometheus/Grafana 없이 제공하는 노드 OS 기초 관측 계층을 설치한다. Beszel은 Supabase(Data & Identity), Gitea(Change Control), Platform Support Shared Observability와 독립된 SRL-L3 진단 경로이며 기존 기능의 기동 조건이 아니다.

## 영향 경계

- Beszel이 미설치이거나 장애여도 Console 로그인, 역할, 상태 변경, Extensions, 외부 채널은 계속 동작해야 한다.
- Console Backend의 Beszel reader Secret 참조는 `optional: true`다.
- adapter 장애는 `/api/monitoring/baseline/v1/*`에만 `Unavailable` 또는 bounded stale로 나타난다.
- 브라우저는 Beszel/PocketBase에 직접 접속하지 않고 Console Backend의 읽기 API만 사용한다.
- Beszel Hub UI를 iframe으로 삽입하거나 외부 Service/Ingress로 공개하지 않는다.

## 설치 순서

1. Supabase migration `0029_browser_session_and_baseline_monitoring.sql`을 적용한다.
2. `opensphere-browser-session` Secret을 생성하고 Console Backend를 먼저 rollout한다.
3. 기존 로그인·Extensions·상태 변경 화면이 정상인지 확인한다.
4. 아래 설치 스크립트로 Beszel 기반을 적용한다.

```powershell
Set-Location D:\@PROJECT\OpenSphere\OpenSphere-Platform-V2\OpenSphere-console
.\deploy\baseline-monitoring\install.ps1
```

스크립트는 기존 `beszel-runtime` Secret을 재사용하며 누락된 webhook token만 추가한다. 기존 agent token이나 관리자 비밀번호를 자동 회전하지 않는다.

## 설치 확인

```powershell
kubectl -n opensphere-monitoring rollout status statefulset/beszel-hub --timeout=5m
kubectl -n opensphere-monitoring wait --for=condition=complete job/beszel-bootstrap --timeout=5m
kubectl -n opensphere-monitoring rollout status daemonset/beszel-agent --timeout=5m
kubectl -n opensphere-monitoring get pod,svc,pvc,networkpolicy
kubectl -n opensphere-monitoring get configmap beszel-agent-public-key -o jsonpath='{.data.key}'
kubectl -n opensphere-console rollout status deployment/opensphere-console-backend --timeout=5m
```

Console의 `/manage/infrastructure-monitoring`에서 다음을 확인한다.

- 전체 Kubernetes Node가 `verified`, `candidate`, `unmatched`, `ambiguous`, `rejected` 중 하나로 명시됨
- 연결된 Agent 수와 Kubernetes Ready 수가 별도로 표시됨
- 자료 출처, 관측 시각, stale 여부가 표시됨
- Beszel 장애 시 마지막 정상 자료가 최대 24시간까지만 `stale`로 표시됨

## 보안 결정

- Hub와 Agent 이미지는 v0.18.7 exact digest로 고정한다.
- Hub는 non-root, read-only root filesystem, capability drop으로 실행한다.
- Agent는 host `/proc`, `/sys`, `/etc`, `/`를 read-only로 관측하고 capability를 모두 제거한다. hostPath state 디렉터리 소유권 때문에 현재 UID 0을 사용하므로 이는 edge 운영 감사 항목이다.
- Agent는 SSH를 끄고 Hub로 outbound WebSocket만 사용한다. hostPort는 열지 않는다.
- `BESZEL_HUB_SHARE_ALL_SYSTEMS=true`는 내부 전용 read-only Console service user가 bootstrap 관리자가 등록한 system을 읽기 위한 제한적 예외다. Hub에는 외부 UI/Ingress가 없고 reader 자격은 Backend namespace Secret에만 투영한다. 이 예외를 제거하려면 upstream owner/share API로 system별 reader binding을 먼저 구현해야 한다.
- generic webhook은 Console 전용 producer token으로 Notification Dispatcher에 들어가며 Console 사용자 세션이나 CephX/Gitea 자격과 공유하지 않는다.

## 롤백과 장애 격리

신규 관측 계층만 중단할 때는 Console Backend의 Beszel 환경변수를 비우거나 reader Secret을 제거한 뒤 Backend를 rollout한다. 기존 Console 기능은 유지되고 모니터링 화면만 `구성되지 않음`으로 표시되어야 한다.

Beszel 리소스를 제거해야 할 때 PVC는 즉시 삭제하지 않는다. StatefulSet과 DaemonSet을 먼저 scale down하고 export/restore 증거를 확보한 뒤 별도 승인으로 PVC를 처리한다. `kubectl delete namespace`를 롤백 명령으로 사용하지 않는다.

## 아직 완료되지 않은 운영 Gate

- Beszel PVC off-backbone backup과 실제 restore drill
- 각 노드의 CPU/memory/disk 값과 host 기준 도구 비교
- node 재생성 시 UID/fingerprint 오결합 0건 검증
- alert webhook의 전달·중복 제거·재시도 이력 검증
- summary p95 500ms, series p95 1.5s 목표 측정
- Agent UID 0/hostPath profile에 대한 기술 감사

이 Gate를 통과하기 전에는 “운영 완료” 또는 GA-ready로 판정하지 않는다.
