# OpenSphere Console 재감사 보고서

- 작성일: 2026-06-29
- 감사 대상: `OpenSphere-console`
- 재감사 근거: `docs/AUDIT-RESPONSE-2026-06-29-OpenSphere-console.md`
- 기준 커밋: `17ad750` 포함 현재 `main`
- 감사 방식: 답변서의 Closed 주장과 현재 코드/로컬 런타임을 직접 대조

## 1. 종합 판정

**조건부 미승인**이다.

원 감사의 제품 승격 차단 항목이었던 P0-1(Admin API 무인증)과 P0-2(임의 plugin proxy)는 실제로 큰 폭으로 개선됐다. 무토큰 admin 변경, 무토큰 identity/catalog 읽기, 미등록 plugin proxy 접근은 로컬 검증에서 각각 401/403으로 차단됐다. CSP의 `unsafe-eval` 제거, `npm test` 복구, build 통과도 확인했다.

다만 답변서의 "Closed" 판정 일부는 코드 기준으로 과하다. 특히 `/api/admin/events`가 공개 nginx 경로 아래에서 무인증 쓰기를 허용하고, plugin proxy allowlist가 "검증 완료 registry"가 아니라 "모든 UIPluginPackage 이름"을 허용한다. 이 두 건은 최상위 Shell의 보안 경계와 감사 무결성 관점에서 재시정이 필요하다.

## 2. 주요 Findings

### P1-1. `/api/admin/events`가 무인증 쓰기 가능하다

현재 controller는 `/api/admin/*`에 인증을 적용하지만, `/api/admin/events`만 예외 처리한다.

- `backend/dupa-control/controller.js:398`  
  `if (p.startsWith('/api/admin/') && p !== '/api/admin/events')`
- `backend/dupa-control/controller.js:445`  
  `if (p === '/api/admin/events' && req.method === 'POST')`
- `nginx/default.conf.template:44`  
  `/api/admin/` 전체가 외부 console origin에서 controller로 프록시된다.

실측:

```bash
curl -i -X POST http://localhost:18090/api/admin/events \
  -H "Content-Type: application/json" \
  --data '{"source":"audit-retest","action":"unauth-write"}'
```

결과: `202 Accepted`.

또한 `dupa-audit-log` ConfigMap에 해당 이벤트가 반영되는 것을 확인했다.

영향:

- 인증 없는 사용자가 audit bus에 이벤트를 삽입할 수 있다.
- 감사 로그와 사용자 알림의 출처 신뢰성이 깨진다.
- `MAX_BODY`는 256KB로 제한됐지만 rate limit은 없어 audit noise/flush 부하를 만들 수 있다.

권고:

- `/api/admin/events`를 공개 `/api/admin/` 경로에서 제거하거나, 최소한 service-to-service 인증을 강제한다.
- subShell backend 이벤트라면 사용자 Bearer가 아니라 Kubernetes SA TokenReview, mTLS, 내부 전용 Secret header, NetworkPolicy 중 하나 이상으로 보호한다.
- 이벤트 source는 요청 body/header 자기보고가 아니라 검증된 workload identity에서 유도해야 한다.

### P1-2. plugin proxy allowlist가 검증 완료 registry가 아니라 모든 package 이름을 허용한다

답변서는 `/api/plugins/{id}`가 "registry plugin명 + CLIDownload 바인딩 서비스 id"로 제한된다고 설명한다. 그러나 현재 allowlist는 reconcile 초기에 모든 `UIPluginPackage` 이름으로 만들어진다.

- `backend/dupa-control/controller.js:275`  
  `const allow = new Set(Object.keys(pkgByName));`
- `backend/dupa-control/controller.js:316-331`  
  실제 검증 성공 후 `published.push(...)`가 수행된다.
- `backend/dupa-control/controller.js:389-391`  
  nginx `auth_request`는 `proxyAllow.has(id)`만 본다.

즉 Failed/Disabled/미검증 package 이름도 proxy allowlist에 들어갈 수 있다. Disabled 처리도 workload를 삭제하지 않고 registry에서만 제외한다.

- `backend/dupa-control/controller.js:303-306`

영향:

- "검증 완료 plugin만 proxy 가능"이라는 원 감사 요구와 아직 불일치한다.
- disabled plugin backend가 `/api/plugins/<id>/...`로 계속 접근 가능할 수 있다.
- 같은 namespace에 동일 이름 Service가 존재하면 registry 노출과 별개로 proxy가 열린다.

권고:

- UI plugin proxy allowlist는 `published`에 들어간 id, 즉 Enabled + Ready + manifest/signature/entry 검증 성공 id에서만 생성한다.
- Disabled 상태에서는 workload를 삭제하거나, 최소한 proxy allowlist에서 제거한다.
- CLIDownload는 `spec.enabled !== false`인 항목만 허용하고, link가 가리키는 service id의 소유/목적을 별도로 검증한다.

### P1-3. token 전역 노출은 아직 종료되지 않았다

`localStorage`에서 `sessionStorage`로 전환한 것은 개선이다. 그러나 `window.__OS_AUTH__.token()`은 여전히 id_token을 전역 JS context에 노출한다.

- `src/app/core/auth.service.ts:26`  
  OIDC store는 `sessionStorage`
- `src/app/core/auth.service.ts:101-104`  
  `window.__OS_AUTH__ = { user, token }`

답변서도 이 항목을 "부분 증분"으로 적고 있으므로, 재감사 판정도 Closed가 아니라 **부분 승인**이다.

권고:

- subShell raw token 접근을 제거하고 Shell-owned `ctx.api.fetch` 또는 backend proxy가 Authorization을 주입하도록 전환한다.
- plugin JS가 token 문자열을 획득할 수 없는 capability API 모델을 확정한다.

### P2-1. audit 영속성은 PoC 개선이지 제품형 append-only audit은 아니다

dupa controller는 stdout JSONL과 ConfigMap hydrate를 추가했다. 재시작 생존성과 로컬 재감사에는 의미가 있다. 그러나 ConfigMap은 최근 500건 ring buffer를 overwrite하며, tamper-resistant append-only store는 아니다.

- `backend/dupa-control/controller.js:93-112`
- `backend/dupa-control/controller.js:108`  
  `audit.slice().reverse()`를 다시 써서 ConfigMap 전체를 갱신한다.

판정: **PoC 기준 부분 승인**, 제품 승격 기준 Closed 아님.

권고:

- 운영 기준에서는 Loki/OTel/SIEM 또는 append-only DB/Object store로 보낸다.
- 이벤트 schema에는 actor, action, target, result, reason, opId 외에도 request id, source workload identity, auth method, client ip를 포함한다.

### P2-2. JWT claim 검증은 좋아졌지만 필수 claim 부재 방어가 약하다

`alg`, `iss`, `azp/aud`, `exp`, `nbf`, signature 검증이 추가된 것은 유효한 개선이다. 다만 `exp`와 `nbf`는 존재할 때만 검사한다.

- `backend/dupa-control/controller.js:62-63`
- `backend/console-backend/server.js:117-118`

Kanidm id_token은 정상적으로 `exp`를 포함하므로 즉시 exploit 가능성은 낮다. 그래도 최상위 Shell의 token verifier는 `exp` 부재를 거부하는 편이 맞다.

권고:

- `exp`, `iat`, `sub`를 필수 claim으로 검사한다.
- 최대 token lifetime을 검사한다.
- 보안 테스트에 missing `exp`, missing `sub`, excessive lifetime 케이스를 추가한다.

### P2-3. plugin error boundary는 UX fallback이지 강한 격리는 아니다

`PluginHost`에 mount try/catch와 `window.error`/`unhandledrejection` 처리가 추가됐다.

- `src/app/pages/plugin-host.ts:97-113`
- `src/app/pages/plugin-host.ts:120-125`

이는 shell white screen 방지에는 도움이 된다. 하지만 같은 main window JS context에서 실행되는 plugin 자체를 격리하지는 못한다. blob 출처가 stack/filename에 남지 않는 async 오류, DOM/event side effect, global mutation은 여전히 Shell에 영향을 줄 수 있다.

판정: **P2 UX resilience 개선 승인**, 보안 격리 Closed 아님.

## 3. 재검증 결과

통과:

```bash
npm test
# tests 15 / pass 15 / fail 0

npm run build
# build success
```

빌드 경고:

- `AdminPlugins`에서 `CarbonIcon` unused warning
- initial bundle budget 초과: 3.31 MB > 3.00 MB
- `admin-plugins.ts` component style budget 초과

보안 smoke:

```bash
curl -X POST http://localhost:18090/api/admin/plugins/registrations/ai/disable \
  -H "X-OpenSphere-User: ceo" -d '{}'
# 401

curl http://localhost:18090/api/admin/plugins/catalog
# 401

curl http://localhost:18090/api/identity
# 401

curl "http://localhost:18090/api/rhdh/catalog/entities?limit=5"
# 401

curl http://localhost:18090/api/plugins/some-random-svc/x
# 403
```

CSP:

```text
script-src 'self' blob:
worker-src 'self' blob:
```

`unsafe-eval`과 `worker-src data:` 제거 확인.

미통과:

```bash
curl -i -X POST http://localhost:18090/api/admin/events \
  -H "Content-Type: application/json" \
  --data '{"source":"audit-retest","action":"unauth-write"}'
# 202 Accepted
```

## 4. Finding별 Sign-off

| 원 항목 | 재감사 판정 | 근거 |
|---|---|---|
| P0-1 Admin API 무인증 변경 | 부분 승인 | lifecycle/catalog/registration 등은 Bearer + admin group으로 보호됨. 단 `/api/admin/events` 무인증 쓰기 예외가 남음. |
| P0-2 plugin proxy 임의 서비스 | 부분 승인 | 미등록 id는 403. 그러나 allowlist가 검증 성공 registry가 아니라 모든 package 이름 기반. |
| P1-1 CSP 약함 | 승인 | `unsafe-eval` 제거, `worker-src data:` 제거 확인. |
| P1-2 token 전역 노출 | 미승인/부분 개선 | storage는 sessionStorage로 개선됐으나 `window.__OS_AUTH__.token()` 유지. |
| P1-3 권한 모델 UI 중심 | 부분 승인 | 주요 mutating endpoint는 backend authz 적용. events 예외와 token bridge가 남음. |
| P1-4 audit 메모리 기반 | 부분 승인 | stdout + ConfigMap hydrate 개선. 제품형 append-only audit은 아님. |
| P2-1 plugin 장애 격리 | 부분 승인 | UX fallback 개선. 강한 runtime 격리는 아님. |
| P2-2 lifecycle upgrade/rollback | 미승인/범위 외 잔여 | health 노출만 추가. upgrade/rollback/version graph는 미구현. |
| P2-3 clean deep link | 승인 | `/ai` 하드코딩 제거, registry-driven PluginHost 위임으로 일반화. |
| P2-4 테스트 부재 | 승인 | `npm test` 15/15 통과. 보안 테스트 최소 세트 존재. |

## 5. 최종 의견

이번 조치는 원 감사의 핵심 위험을 실제로 많이 낮췄다. 특히 Admin API의 Bearer 검증, nginx spoof header clear, 무토큰 read 차단, CSP 정리는 방향이 맞다.

그러나 최상위 Shell을 제품 보안 경계로 승인하려면 아래 세 가지를 먼저 닫아야 한다.

1. `/api/admin/events` 무인증 쓰기 제거 또는 service-to-service 인증 적용
2. plugin proxy allowlist를 "검증 성공 + 활성 상태" 기준으로 축소
3. raw token bridge(`window.__OS_AUTH__.token`) 제거 계획을 실제 코드 이행으로 전환

이 세 가지가 보강되면 P0/P1 보안 게이트는 승인 가능권으로 들어온다. 나머지 upgrade/rollback, append-only audit, iframe/worker 격리는 제품 성숙도 후속 과제로 관리할 수 있다.
