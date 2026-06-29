# Observability 아키텍처 — prometheus-stack의 포지션

> **상태**: 설계/결정(draft) · **작성일**: 2026-06-29 · **대상 독자**: 콘솔/플랫폼/Foundation 팀
> **범위**: prometheus-stack(관측 스택)을 OpenSphere 아키텍처 어디에 둘 것인가 — **플랫폼 전역(cross-cutting) 결정**.
> 본 문서는 콘솔 repo에 있으나 **콘솔 전용이 아니다**. 정의하는 관측 계층은 OpenSphere 전 레이어가 공유한다.

---

## 0. 질문과 결론(TL;DR)

**질문**: prometheus-stack은 (a) K8s의 일반(공유) 리소스인가, (b) OpenSphere 내장 요소인가? 콘솔뿐 아니라 OpenSphere 모두가 쓰도록 **공유 일반 리소스**로 두는 것이 개념적으로 맞는가?

**결론**: ✅ **맞다.** prometheus는 Backbone/Foundation 같은 *수직 backing service*가 아니라 **모든 레이어를 가로지르는 수평(cross-cutting) 관측 인프라**다. 한 레이어(콘솔/Backbone)에 묶으면 위상이 틀린다. 단 아래 **성립 조건**을 지켜야 "공유 일반 리소스"가 실제로 성립한다:

1. **수집/저장층 = 공유 cluster infra**, **노출/계측층 = 각 컴포넌트 소유**로 분리.
2. **특정 Prometheus 인스턴스에 하드 의존 금지** — Operator CRD(ServiceMonitor/PodMonitor)에 의존.
3. **stack 자체는 ship-but-optional** — 기존 클러스터 모니터링이 있으면 양보(충돌 회피).

---

## 1. 현재 상태 (사실)

- **prometheus는 매니페스트·코드에 없음 = 미배포.** 설계 문서에만 존재한다.
- 그나마 **도메인 산발적** — AI 평면의 `TrustyAI / Prometheus monitoring`(모델 드리프트/공정성, `_DOCS_/OAH-SUPPORT-SERVICES-INSTALLATION-MAP-2026-06-29.md` §9)처럼 특정 도메인에 묶여 있다.
- **통합된 "공유 관측 계층" 포지션은 아직 없다.**
- 콘솔 백엔드(`console-backend`, `dupa-registry-controller`)는 **`/metrics` 계측이 전무**(0).

→ 본 문서는 이 산발적 상태를 **단일 공유 관측 계층**으로 통합하는 포지션을 정의한다.

---

## 2. 개념 모델 — prometheus는 Backbone과 "종류가 다르다"

핵심: 위상(topology)이 다르다.

| | Backbone / Foundation | prometheus-stack |
|---|---|---|
| 방향 | **수직(vertical)** backing service | **수평(horizontal)** cross-cutting |
| 소비 | 단일 소비자가 명시적 연결(DB/S3 endpoint) | **모두를 scrape** — 의존 방향 역전 |
| 소유 | 콘솔/사용자 워크로드가 소유 | 어느 레이어에도 안 묶임 |
| 연결 | 소비자 → 자원 | 자원이 `/metrics` 노출 → prometheus가 끌어감 |

Backbone은 콘솔이 "연결해서 쓰는" 것, prometheus는 "모두를 관측하는" 것. **그래서 console 전용/Backbone 소속이면 틀리고, cluster-scoped 공유가 맞다.**

---

## 3. 성립 조건 — "일반 리소스"를 두 층으로 분리

`prometheus-stack`을 통째로 "일반 리소스"라 하면 모호하다. **두 층으로 나눈다**:

| 층 | 구성 | 소유 | 위치 |
|---|---|---|---|
| **수집/저장층** | Prometheus server · Grafana · Alertmanager · kube-state-metrics · node-exporter | **공유 cluster infra** (한 번 설치) | 전용 ns `monitoring` |
| **노출/계측층** | `/metrics`(exposition) + **ServiceMonitor/PodMonitor** CR | **각 컴포넌트가 소유** | 컴포넌트와 같은 ns |

이 분리가 "공유 일반 리소스" 포지션의 성립 조건이다. 수집층은 공유, 계측층은 분산 소유.

### 원칙 1 — Operator CRD에 의존 (특정 인스턴스 하드 의존 금지)

컴포넌트는 `/metrics`를 노출하고 **ServiceMonitor를 동봉**할 뿐 "어느 prometheus"인지 몰라야 한다. 그러면 누가 prometheus를 돌리든(우리가 ship하든, 엔터프라이즈 기존 것이든) 자동 관측된다. **이것이 진짜 "general resource"의 디커플링.**

### 원칙 2 — stack은 ship-but-optional

운영/엔터프라이즈 클러스터엔 **이미 모니터링 스택이 있는 경우가 많다.** 그때 우리가 또 prometheus-operator를 깔면:
- ServiceMonitor/PodMonitor **CRD는 cluster-scoped 싱글톤** → 두 operator가 소유권 충돌
- 중복 scrape · 중복 Grafana

→ **dev/standalone엔 우리가 ship, 기존 모니터링이 있으면 disable해 양보.** OpenShift·Rancher·대부분 성숙 operator가 이 방식("CRD 의존 + stack optional")을 쓴다.

> 네임스페이스는 `monitoring`(중립·관례)을 권장한다. `opensphere-monitoring`은 "OpenSphere 소유"를 함의해 *공유 일반 리소스* 포지션과 모순된다.

---

## 4. 레이어 배치

```
Cluster infra : K8s · CNI · storage(local-path) · ingress-nginx
   └─ Observability : prometheus-stack  ★cluster-scoped 공유 (ns: monitoring)
                          ▲ scrape (ServiceMonitor 발견)
        ┌─────────────────┼───────────────────────────┐
   Foundation        Backbone(PG/RustFS/Gitea)     Console · Fleet · AI · user workloads
   (각자 /metrics + ServiceMonitor 노출 = 관측 "대상")
```

- **Backbone에 prometheus를 넣지 않는다.** Backbone은 콘솔의 수직 backing(상태저장)이고 prometheus는 수평 관측이다. 단 Backbone 컴포넌트도 **관측 대상**으로서 ServiceMonitor를 노출한다(집이 아니라 대상). → [BACKBONE-ARCHITECTURE.md](BACKBONE-ARCHITECTURE.md) §3.4
- **AI의 TrustyAI/Prometheus는 별도 스택이 아니라** 이 공유 prometheus 위에 얹는 도메인 특화 룰/소비다. 통합 관측층으로 일반화하면 현재 문서의 산발적 배치가 정리된다. **중복 스택 금지.**

---

## 5. 확정 결정

| 항목 | 결정 |
|---|---|
| prometheus의 종류 | **cluster-scoped 공유 관측 인프라** (수평 cross-cutting). console/Backbone 소속 아님 |
| "공유 일반 리소스" 포지션 | ✅ 채택. 단 수집층(공유)/계측층(컴포넌트 소유) 분리 + Operator CRD 의존 + ship-but-optional 전제 |
| 네임스페이스 | `monitoring`(중립) |
| Backbone과의 관계 | Backbone = 관측 **대상**(ServiceMonitor 노출), prometheus의 집 아님 |
| 도메인 관측(AI 등) | 공유 prometheus 위 도메인 룰로 얹음(중복 스택 금지) |

---

## 6. 로드맵 / 액션 아이템

### ① 콘솔 계측 (0 → 1) — 우선

현재 콘솔 백엔드는 `/metrics`가 전무하다. 다음을 추가한다:

- **대상**: `console-backend`(server.js, :8080), `dupa-registry-controller`(controller.js, :8080).
- **노출 방식**: 각 서비스의 기존 의존성 posture를 따른다 —
  - `dupa-registry-controller`는 **"의존성 0(node 내장)"** 설계(`controller.js` 헤더) → **경량 수기 exposition** `/metrics`(Prometheus 텍스트 포맷)로 일관성 유지.
  - `console-backend`는 `prom-client`(소형) 또는 동일 수기 방식.
- **노출 지표(예)**: HTTP 요청 수/지연, 인증 실패(JWKS verify), 감사 이벤트 수, plugin proxy authz allow/deny, **reconcile 루프 시간/오류**(dupa), 의존성 헬스(Backbone ping).
- **ServiceMonitor**: 각 Service에 라벨 + 동일 ns(`opensphere-system`)에 ServiceMonitor CR 동봉. 포트명 `metrics`, path `/metrics`.
- ⚠️ **보안**: `/metrics`는 **클러스터 내부 전용** — nginx로 브라우저에 라우팅하지 않는다(prometheus가 Service로 직접 scrape). 민감정보 미노출.

### ② Observability 포지션 문서화 — 본 문서

- 이 문서가 그 산출물. Backbone 문서와 별개의 cross-cutting 결정으로 둔다.
- 후속: Backbone/Foundation/Console 각 설계 문서에 "관측은 본 문서의 공유 계층을 따른다" 한 줄 링크.

### ③ Fleet 확장 시 — 멀티클러스터 페더레이션 (향후, 지금 결정 불필요)

- 멀티클러스터(Fleet)에서는 **per-cluster prometheus + 중앙 집계**(Thanos / Mimir / remote-write) 패턴.
- 지금은 포지션만 열어둔다(단일 클러스터에선 공유 prometheus 하나로 충분).

### ④ (부수) ship-but-optional 설치 메커니즘

- dev/로컬: `tools/local-dev/install-monitoring.sh`(신규)로 kube-prometheus-stack 설치, bring-up.sh에서 **선택적 단계**(flag로 skip 가능).
- 기존 모니터링 감지 시(Operator CRD 존재) → 설치 skip, ServiceMonitor만 적용.
- 저장: 단일노드 dev는 local-path PVC + 짧은 retention(예: 7d). → [BACKBONE-ARCHITECTURE.md](BACKBONE-ARCHITECTURE.md) §0.4 스토리지 제약 동일 적용.

---

## 7. 미해결 / 후속

1. **Grafana 대시보드 소유** — 공유 Grafana에 OpenSphere 표준 대시보드를 어떻게 배포·버전관리할지(ConfigMap sidecar vs GitOps via Gitea).
2. **알림 라우팅** — Alertmanager 룰/수신자 소유 경계(플랫폼 공통 vs 도메인별).
3. **멀티테넌시** — 사용자 워크로드 메트릭과 플랫폼 메트릭의 RBAC/네임스페이스 격리(공유 prometheus에서 테넌트 분리).
4. **retention/용량** — 운영 클러스터의 장기 보관(원칙 2의 "기존 스택 양보"와 연계).

---

## 부록. ServiceMonitor / `/metrics` 골격

### A. ServiceMonitor (컴포넌트 동봉, ns=opensphere-system)

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: dupa-registry-controller
  namespace: opensphere-system
  labels: { app.kubernetes.io/part-of: opensphere-console }
spec:
  selector:
    matchLabels: { app: dupa-registry-controller }   # 대상 Service 라벨
  endpoints:
    - port: metrics        # Service의 포트명(neu: 9090 등, /metrics 전용 포트 권장)
      path: /metrics
      interval: 30s
```

> 전제: Prometheus Operator CRD(`monitoring.coreos.com/v1`)가 클러스터에 존재(원칙 1). 없으면 ServiceMonitor는 무해하게 무시되거나, install-monitoring.sh가 CRD를 제공.

### B. 경량 `/metrics` (의존성 0, dupa 스타일 — 수기 exposition)

```js
// 별도 포트(예: 9090) 또는 내부 경로. 브라우저 비노출.
// Prometheus text exposition format.
function metricsText() {
  return [
    '# HELP dupa_reconcile_seconds reconcile loop duration',
    '# TYPE dupa_reconcile_seconds gauge',
    `dupa_reconcile_seconds ${lastReconcileSec}`,
    '# HELP dupa_audit_events_total audit events emitted',
    '# TYPE dupa_audit_events_total counter',
    `dupa_audit_events_total ${auditCount}`,
    // http_requests_total, authz_decisions_total{decision="allow|deny"} ...
  ].join('\n') + '\n';
}
```

---

## 부록 B. 출처 (코드베이스 근거)

- prometheus 산발 배치(AI): `_DOCS_/OAH-SUPPORT-SERVICES-INSTALLATION-MAP-2026-06-29.md` §9
- 콘솔 백엔드 미계측(현황): `backend/console-backend/server.js`, `backend/dupa-control/controller.js`(`/metrics` 부재)
- dupa "의존성 0" 설계: `backend/dupa-control/controller.js` 헤더(L8 "의존성 0 node 내장")
- 스토리지 제약(retention/PVC): [BACKBONE-ARCHITECTURE.md](BACKBONE-ARCHITECTURE.md) §0.4
