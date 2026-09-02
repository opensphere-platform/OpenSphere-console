# Console Baseline Host Observation

이 디렉터리는 Console Backbone의 Host Observation Authority인 Beszel을 설치하는 release contract를 소유한다. C4 권위는 `S_HOBS`, Console 내부 read adapter는 `API_HOBS`, release artifact owner는 `C_API`다. 일반 metric·log·trace 권위인 HISS와 합치지 않는다.

Beszel은 `bootstrapCore`에 포함되지만 장애 전파는 제한한다. Hub 또는 Agent가 실패하면 Host Observation만 `NotConfigured`, `Stale`, `Expired` 또는 `Unavailable`로 내려간다. Supabase 로그인, Gitea 승인 변경과 다른 Console 기능을 함께 중지하지 않는다.

## Release artifact 계약

[release-contract.json](release-contract.json)이 Setup과 release workflow가 함께 읽는 기계 계약이다.

| BOM key | GHCR artifact | runtime |
|---|---|---|
| `beszelHub` | `opensphere-console-beszel-hub` | `StatefulSet/beszel-hub` |
| `beszelAgent` | `opensphere-console-beszel-agent` | `DaemonSet/beszel-agent` |
| `beszelBootstrap` | `opensphere-console-beszel-bootstrap` | `Job/beszel-bootstrap-v0187` |

세 이미지는 각각 exact-digest upstream을 얇게 감싸며 Console candidate workflow에서 multi-architecture build, provenance, SPDX SBOM과 signed integrated BOM 증거를 받는다. 배포 manifest는 upstream image나 channel tag를 직접 참조하지 않고 다음 render input만 가진다.

- `__OPENSPHERE_BESZEL_HUB_IMAGE__`
- `__OPENSPHERE_BESZEL_AGENT_IMAGE__`
- `__OPENSPHERE_BESZEL_BOOTSTRAP_IMAGE__`

Setup은 signed BOM에서 세 값을 `ghcr.io/opensphere-platform/<artifact>@sha256:<digest>` 형식으로 공급해야 한다. source manifest, `:candidate`, `:latest` 또는 Docker Hub digest를 설치 정본으로 사용하지 않는다.

## Setup 책임 경계

운영자가 이 디렉터리의 manifest를 직접 적용하는 흐름은 정식 설치 절차가 아니다. OpenSphere Setup CLI가 다음 순서를 소유한다.

1. `doctor`로 Kubernetes API, DNS, StorageClass, NetworkPolicy, Linux node readiness와 `opensphere-console` 선행 조건을 확인한다.
2. signed Console BOM과 attestations를 검증하고 `opensphere-ghcr-pull`을 `opensphere-monitoring`에 준비한다.
3. `beszel-runtime`의 admin, read-only reader와 agent 자격을 생성하거나 기존 installation lock에 결속된 값을 재사용한다.
4. [install.ps1](install.ps1)에 BOM의 세 exact image를 전달한다.
5. Hub readiness, bootstrap Job 완료, Agent rollout, 설치된 exact digest, private Service와 target C_API rollout을 확인한다.
6. 설치 receipt와 installation lock에 세 component digest와 검증 시각을 기록한다.

`install.ps1`은 Setup에서 호출할 수 있는 좁은 component installer다. 세 image 인자는 필수이며 공식 GHCR exact digest 이외의 값을 즉시 거부한다. 기존 자격을 암묵적으로 회전하지 않고 Console namespace에는 reader email/password projection만 전달한다.

## Runtime와 네트워크

- Hub는 `opensphere-monitoring` 내부 `ClusterIP:8090`만 갖는다.
- Ingress, Gateway route, NodePort, LoadBalancer, hostPort와 hostNetwork를 만들지 않는다.
- Browser는 Hub/PocketBase에 직접 접속하거나 Hub UI를 iframe으로 삽입하지 않는다.
- target `opensphere-console-api`만 전용 reader로 Hub를 읽는다.
- Agent는 SSH listener를 끄고 Hub로 outbound WebSocket만 연결한다. Agent NetworkPolicy의 ingress는 비어 있다.
- Hub egress는 cluster DNS로 제한한다. target C_API는 Hub를 읽기만 한다.
- Agent host 관측 mount는 read-only다. state hostPath 때문에 UID 0 예외가 남아 있으며 release security review 항목으로 유지한다.
- 모든 workload는 service-account token을 끈다. bootstrap Job만 제한된 namespaced Role로 agent public-key ConfigMap을 갱신한다.
- target release는 alert webhook ingest owner를 구현하지 않았으므로 webhook URL이나 producer token을 만들지 않는다. 이를 Ready로 표시하지 않는다.

## Health와 readiness

Hub의 startup, readiness와 liveness는 `/api/health`를 사용한다. Agent readiness/liveness는 `/agent health`를 사용한다. bootstrap은 Hub 준비를 bounded retry한 후 reader 인증, universal agent token과 public key 구성을 성공해야 한다.

Setup의 최종 verify는 다음을 별도로 판정한다.

- Hub `Ready`와 PVC bound
- bootstrap Job `Complete`
- Ready Linux node 대비 Agent desired/ready 수
- Hub와 Agent의 running image가 signed BOM exact digest와 일치
- Hub Service가 non-headless ClusterIP이고 외부 route가 없음
- Console reader의 create/update/delete 거부
- Kubernetes Node UID와 Beszel machine fingerprint가 durable binding된 경우에만 `Verified`
- Hub 중단 시 다른 Backbone 기능은 계속되고 Host Observation만 격리됨

## 남은 운영 수용 Gate

다음은 manifest와 정적 계약만으로 합격 처리하지 않는다.

- Beszel Hub PVC의 off-backbone backup과 격리 restore drill
- node 재생성 및 hostname 충돌에서 UID/fingerprint 오결합 0건
- reader write denial 통합 시험
- alert ingest owner와 delivery 중복·재시도 계약
- summary p95 500ms, series p95 1.5s 환경 측정
- Agent UID 0/hostPath 예외의 release security 승인

이 증거 전에는 baseline Host Observation을 GA-ready 또는 Recovered로 표시하지 않는다.
