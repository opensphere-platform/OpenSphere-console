# OpenSphere Console 기술 감사 보고서

- 작성일: 2026-06-29
- 감사 대상: OpenSphere 최상위 Shell, `OpenSphere-console`
- 대상 경로:
  - `D:\@PROJECT\OpenSphere\OpenSphere-Platform-V2\OpenSphere-console`
  - `D:\@PROJECT\OpenSphere\OpenSphere-Platform-V2\OpenSphere-console\docs`
  - `D:\@PROJECT\OpenSphere\OpenSphere-Platform-V2\_DOCS_`
- 감사 관점: 문서 형식 정합성이 아니라 실제 코드 레벨의 기능, 보안, 운영성, 제품 승격 가능성 평가

## 1. 종합 판정

`OpenSphere-console`은 Shell/Extension Host의 큰 구조를 상당 부분 구현했다. 특히 manifest digest, signature, entry digest, Blob import, capability 기반 ctx 노출 등 Dynamic UI Plugin Architecture의 핵심 아이디어는 코드로 존재한다.

그러나 제품 승격 기준으로는 **보류**가 타당하다. 최상위 Shell이 반드시 책임져야 하는 관리 API 인증, plugin backend proxy 통제, 감사 로그 영속성, 장애 격리, lifecycle/rollback/health, 회귀 테스트가 아직 PoC 수준이다.

현재 상태는 "동작하는 Shell PoC"로는 의미가 크지만, "운영 가능한 최상위 보안 경계"라고 보기에는 부족하다.

## 2. 문서상 Shell 책임 요약

문서 기준으로 Main Shell은 다음을 소유해야 한다.

- 단일 제품 프레임과 1차 내비게이션
- top-level routing, URL policy, deep link 정책
- 인증과 세션 컨텍스트
- 권한 평가와 extension point 노출 제어
- API client/proxy 계약
- plugin registry, manifest 검증, lifecycle
- plugin health, compatibility, disable/rollback
- audit bus 및 감사 이력
- design system, shared components
- plugin failure isolation

특히 `../../_DOCS_/01-CONSTITUTION/CONSTITUTION-0003-SHELL-HOSTING-INTEGRATION.md`는 Shell proxy가 plugin route policy를 강제해야 하고, mutating call은 audit event를 남겨야 하며, 권한은 Shell, backend, K8s/OKD RBAC 세 곳에서 확인되어야 한다고 정의한다.

## 3. 주요 Findings

### P0-1. DUPA Admin Control API가 실제 인증 없이 변경 작업을 수행한다

브라우저가 `X-OpenSphere-User`를 직접 만들고, nginx가 이 값을 그대로 controller에 전달한다. controller는 이 헤더를 actor로 신뢰해 plugin install, enable, disable, uninstall, icon 변경을 처리한다.

관련 코드:

- `src/app/core/plugin-control-client.service.ts`
  - `headers()`가 `X-OpenSphere-User`를 클라이언트에서 생성
- `nginx/default.conf.template`
  - `/api/admin/` location이 해당 헤더를 그대로 전달
- `backend/dupa-control/controller.js`
  - `const actor = req.headers['x-opensphere-user'] || 'anonymous'`
  - `/api/admin/plugins/registrations/{id}/{action}`가 bearer token 검증 없이 상태 변경

영향:

- 인증되지 않은 사용자 또는 브라우저 콘솔 조작자가 plugin lifecycle을 바꿀 수 있다.
- audit actor가 spoof 가능하다.
- Shell이 최상위 보안 경계라는 전제와 충돌한다.

권고:

- `/api/admin/**`는 반드시 backend에서 Kanidm id_token 또는 PAT를 검증해야 한다.
- `opensphere-console-admins` 같은 admin group membership을 controller에서 확인해야 한다.
- 클라이언트 전달 actor 헤더는 신뢰하지 말고 검증된 token claim에서 actor를 도출해야 한다.

### P0-2. `/api/plugins/{id}/...` 프록시가 registry allowlist 없이 임의 서비스로 라우팅된다

nginx는 regex로 `{id}`를 추출한 뒤 `{id}.opensphere-system.svc.cluster.local:8080`으로 바로 프록시한다. 코드 주석에도 제품 단계에서는 controller가 basePath allowlist를 nginx에 생성해야 한다고 되어 있다.

관련 코드:

- `nginx/default.conf.template`
  - `location ~ ^/api/plugins/([a-z0-9-]+)/(.*)$`
  - `set $plugin_upstream $1.opensphere-system.svc.cluster.local`
  - `proxy_pass http://$plugin_upstream:8080/$2$is_args$args`

영향:

- registry에 등록되지 않은 in-cluster service도 이름만 알면 프록시 접근 가능하다.
- plugin permission scope와 backend route allowlist 계약이 proxy 레이어에서 강제되지 않는다.
- feature container backend가 자체 인증을 빠뜨리면 Shell proxy가 방어선이 되지 못한다.

권고:

- registry/controller가 검증된 plugin basePath allowlist를 생성해야 한다.
- 가능하면 nginx regex proxy 대신 policy-aware BFF/Envoy route로 이전한다.
- proxy는 plugin id, route, method, user/session context를 모두 검증해야 한다.

### P1-1. CSP가 manifest v2 보안 계약보다 약하다

문서의 manifest v2 계약은 `script-src 'self' blob:`과 inline/eval 금지를 요구한다. 실제 nginx CSP는 `'unsafe-eval'`을 허용하고 `worker-src blob:data`도 허용한다. 주석도 "PoC 단계 결정"이라고 명시한다.

관련 코드:

- `nginx/default.conf.template`
  - `script-src 'self' blob: 'unsafe-eval'`
  - `worker-src 'self' blob: data:`

영향:

- 검증된 Blob import 모델의 보안 강도가 약해진다.
- plugin 또는 흡수형 앱의 코드 실행 표면이 넓어진다.
- 문서상 제품 보안 계약과 구현이 불일치한다.

권고:

- 제품 승격 전 `'unsafe-eval'` 제거를 목표로 해야 한다.
- eval이 필요한 흡수형 앱은 별도 격리 모드, iframe/worker sandbox, 또는 별도 CSP zone으로 분리한다.
- CSP 정책을 보안 테스트로 고정한다.

### P1-2. 사용자 id_token이 localStorage와 `window.__OS_AUTH__`에 노출된다

현재 `AuthService`는 OIDC user store로 localStorage를 사용하고, id_token을 `window.__OS_AUTH__`로 노출한다. plugin backend가 사용할 수 있도록 한 의도는 이해되지만, 검증된 plugin도 메인 JS 컨텍스트에서 실행되므로 토큰 노출면이 크다.

관련 코드:

- `src/app/core/auth.service.ts`
  - `userStore: new WebStorageStateStore({ store: window.localStorage })`
  - `window.__OS_AUTH__ = { user: ..., token: ... }`

영향:

- XSS 또는 악성/취약 plugin이 id_token을 획득할 수 있다.
- plugin이 Shell proxy를 우회해 token을 직접 사용할 수 있다.
- "Shell API client attaches user/session context"라는 계약이 약해진다.

권고:

- plugin에는 token 원문을 제공하지 않는다.
- `ctx.api.fetch` 또는 Shell-owned proxy만 제공하고, backend에서 token introspection/claims 주입을 수행한다.
- storage는 가능하면 httpOnly secure cookie 기반 BFF 세션 또는 짧은 수명 in-memory token으로 전환한다.

### P1-3. 권한 모델이 UI 게이트 중심이다

`PerspectiveService`는 token group을 기반으로 client-side로 workspace/band 표시 여부를 결정한다. 그러나 DUPA Admin Control API는 backend에서 동일 권한을 검증하지 않는다. 문서는 Shell, backend, K8s/OKD RBAC 3중 검증을 요구한다.

관련 코드:

- `src/app/core/perspective.service.ts`
  - `decide(groups, roles)`가 client-side로 workspace 허용을 판단
- `backend/dupa-control/controller.js`
  - admin action에 bearer token 검증 부재

영향:

- UI 숨김은 보안 통제가 아니다.
- 직접 API 호출에 취약하다.

권고:

- 모든 mutating endpoint에 backend authorization을 추가한다.
- Kubernetes operation은 가능한 한 impersonation 또는 SubjectAccessReview 기반으로 최종 RBAC를 확인한다.

### P1-4. 감사 로그가 메모리 기반이다

DUPA controller와 console-backend 모두 audit을 process memory 배열로 보관한다. 재시작 시 사라지고, tamper-resistant 하지 않다.

관련 코드:

- `backend/dupa-control/controller.js`
  - `const audit = []`
- `backend/console-backend/server.js`
  - `const audit = []`

영향:

- 운영 감사 요건을 충족하지 못한다.
- 장애/재시작 시 lifecycle 이력과 IGA 변경 이력이 손실된다.
- 추적 가능한 operation ID가 없다.

권고:

- append-only audit store를 도입한다.
- event 필드에 actor subject, groups, plugin id, action, target, result, operationId, requestId, timestamp, reason을 포함한다.
- audit event는 변경 성공/실패 모두 기록한다.

### P2-1. plugin 장애 격리가 로딩 실패 fallback 중심이다

`ExtensionHostService`는 manifest/entry 검증 실패 시 해당 plugin을 제외한다. 그러나 plugin custom element가 mount된 이후 runtime JS error를 Shell error boundary로 감싸는 구현은 확인되지 않는다.

관련 코드:

- `src/app/pages/plugin-host.ts`
  - `replaceChildren(document.createElement(p.elementTag))`
- 전역 Angular ErrorHandler 또는 custom element error boundary 미확인

영향:

- plugin runtime 오류가 Shell UX 안정성에 영향을 줄 수 있다.
- 문서의 "Shell must survive plugin JavaScript errors" 요구가 완성되지 않았다.

권고:

- PluginHost에 error boundary, timeout, mount failure fallback을 추가한다.
- `window.onerror`/`unhandledrejection` attribution과 plugin health degrade 처리를 연결한다.

### P2-2. lifecycle 기능이 enable/disable/install/uninstall 중심이다

문서는 enable, disable, upgrade, rollback, health check, compatibility check, audit history를 요구한다. 현재 구현은 install/enable/disable/uninstall 및 단순 readiness 중심이다.

관련 코드:

- `backend/dupa-control/controller.js`
  - `/install|enable|disable|uninstall`
  - workload readiness와 manifest 검증은 있으나 rollback/upgrade version graph 부재

권고:

- UIPluginPackage version/channel/revision 모델을 도입한다.
- rollback 가능한 이전 digest와 registry snapshot을 보관한다.
- plugin health endpoint와 compatibility status를 Admin UI에 노출한다.

### P2-3. 라우팅 일반화가 미완이다

`/p/:id`는 일반화되어 있으나 `/ai/...` clean deep link는 AI 전용 matcher로 하드코딩되어 있다. 문서 원칙은 subShell 내부 메뉴와 route tree를 Main Shell이 하드코딩하지 않는 것이다.

관련 코드:

- `src/app/app.routes.ts`
  - `aiPluginRouteMatcher`
  - `{ matcher: aiPluginRouteMatcher, component: PluginHost, data: { pluginId: 'ai' } }`

권고:

- registry/manifest에 route aliases 또는 delegated wildcard route를 선언하게 한다.
- Main Shell은 registry 기반으로 route handoff를 구성한다.
- subShell별 hardcoding은 제거한다.

### P2-4. 회귀 테스트가 거의 없다

빌드는 통과하지만 test target이 없고, spec 파일은 `notification.merge.spec.ts` 1개뿐이다.

관련 코드:

- `angular.json`
  - `architect.test` 없음
- `src/app/core/notification.merge.spec.ts`
  - 알림 병합 유틸만 테스트

검증 결과:

- `npm.cmd run build`: 성공
- `npm.cmd test -- --watch=false`: 실패 (`Unknown argument: watch`)

권고:

- manifest 검증 실패 케이스 테스트
- permission scope gating 테스트
- admin API 인증/인가 테스트
- plugin proxy allowlist 테스트
- routing/deep link 테스트
- audit event persistence 테스트

## 4. 긍정 평가

### ExtensionHost 신뢰 체인은 방향이 좋다

다음 구현은 문서 방향과 잘 맞는다.

- registry version 확인
- manifest sha256 검증
- detached signature 검증
- shellCompat 검사
- known capability 검사
- `page:register` 필수화
- entry sha256 검증
- 검증된 bytes를 Blob URL로 import
- capability별 ctx 노출 제한

관련 코드:

- `src/app/core/extension-host.service.ts`

### Identity/console-backend의 IGA 쓰기 API는 상대적으로 성숙하다

`console-backend`의 identity write API는 Kanidm id_token 검증과 admin group 검증을 수행한다. DUPA Admin Control API도 이 수준으로 끌어올려야 한다.

관련 코드:

- `backend/console-backend/server.js`
  - `verifyAuthed(req)`
  - `verifyActor(req)`

### 디자인 시스템 적용은 대체로 정합하다

IBM Plex font, Clarity token override, Carbon icon strategy, 1단/2단 nav 색상 규칙은 현재 코드에 반영되어 있다.

관련 코드:

- `src/styles.scss`
- `src/app/os/os-shell.ts`
- `src/app/os/carbon-icon.ts`
- `src/app/os/icon-library.service.ts`

## 5. 제품 승격 전 필수 조치

1. `/api/admin/**` backend 인증/인가 강제
2. `/api/plugins/**` registry 기반 allowlist proxy로 전환
3. token 원문을 plugin/global window에 노출하지 않는 API capability 모델로 변경
4. CSP에서 `unsafe-eval` 제거 또는 격리 zone 설계
5. audit log 영속화 및 operationId 도입
6. plugin runtime error boundary와 health/degrade 상태 구현
7. lifecycle upgrade/rollback/compatibility/health 구현
8. route alias/delegated wildcard를 registry-driven으로 일반화
9. 보안 회귀 테스트와 CI test target 구성

## 6. 최종 의견

`OpenSphere-console`은 Main Shell로서의 제품 방향을 제대로 이해한 코드베이스다. 특히 ExtensionHost와 디자인 시스템은 좋은 출발점이다.

하지만 현재의 위험은 "화면이 덜 예쁘다"가 아니라 "Shell이 보안 경계로 충분히 서 있지 않다"는 것이다. 운영 환경으로 올리려면 Admin Control API와 plugin proxy를 가장 먼저 닫아야 한다. 이 두 부분이 보강되면 나머지 lifecycle, audit, health, route 일반화는 단계적으로 제품화할 수 있다.
