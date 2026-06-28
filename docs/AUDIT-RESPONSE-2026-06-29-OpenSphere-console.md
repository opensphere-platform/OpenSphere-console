# OpenSphere Console 감사 조치 리포트 & 재감사 청구서

- 작성일: 2026-06-29
- 대상: OpenSphere 최상위 Shell, `OpenSphere-console`
- 근거 감사: `docs/AUDIT-REPORT-2026-06-29-OpenSphere-console.md` (기술팀장)
- 조치 커밋: `17ad750` (`fix(security): 기술감사 지적 일괄 개선`), origin/main 반영
- 배포 이미지(런타임 반영): `dupa-registry-controller:sec4`, `console-backend:sec2`, `opensphere-console:sec1`
- 조치 범위: 감사 P0/P1/P2 전 항목 + 메타검토에서 추가 발견한 누락 위험

---

## 1. 종합 판정 (조치측)

감사가 **제품 승격의 단일 결정 게이트**로 지목한 두 항목(P0-1 admin API 무인증, P0-2 plugin proxy allowlist 부재)을 **닫았다**. 감사의 우선순위 판단은 옳았으며, 추가로 메타검토에서 드러난 무인증 읽기 노출·헤더 스푸핑·백엔드 SSRF·에러 누출까지 같은 작업에서 처리했다.

런타임 검증 결과 **무인증/스푸핑 호출은 401/403으로 차단**되고, **인증된 admin UI·플러그인·CLI 다운로드는 정상 동작**한다. 회귀 테스트(`npm test`)는 15/15 통과한다.

남은 항목(P1-2 토큰 전역 노출 완전 제거, P2-2 upgrade/rollback, BFF TLS 검증 등)은 **크로스-repo 이식 또는 인프라성 변경**이라 본 차수에서 안전 증분까지 적용하고 잔여를 §4에 명시했다. 본 문서 §5의 절차로 재검증 후, §6의 항목에 대해 sign-off 또는 잔여 리스크 재평가를 청구한다.

---

## 2. 조치 결과 매트릭스 (감사 finding 기준)

| ID | 감사 지적 | 상태 | 조치 요약 | 핵심 위치 |
|---|---|---|---|---|
| **P0-1** | DUPA Admin API 무인증 변경 | ✅ Closed | controller가 `Authorization: Bearer`(Kanidm id_token, JWKS ES256) 검증 + `opensphere-console-admins` 그룹 강제. actor를 검증 토큰 claim에서 도출. nginx가 `X-OpenSphere-User` clear. 클라이언트는 Bearer 첨부. | `backend/dupa-control/controller.js`(`verifyActor`/`assertClaims`, admin gate), `nginx/default.conf.template`(`/api/admin/`), `src/app/core/plugin-control-client.service.ts` |
| **P0-2** | `/api/plugins/{id}` 임의 서비스 프록시 | ✅ Closed | nginx `auth_request` → controller `/api/internal/proxy-authz`가 **registry plugin명 + CLIDownload 바인딩 서비스 id** allowlist 강제. 미등록 → 403. | `nginx/default.conf.template`(`location ~ ^/api/plugins`, `/_plugin_authz`), `controller.js`(`proxyAllow`, reconcile) |
| **P1-1** | CSP가 manifest v2보다 약함(unsafe-eval) | ✅ Closed | 글로벌 + `/index.html` 두 곳에서 `'unsafe-eval'` 제거, `worker-src`를 `'self' blob:`로 축소. 셸/플러그인은 검증된 blob import만 사용(eval 0건). | `nginx/default.conf.template` (CSP 2곳) |
| **P1-2** | id_token이 localStorage·window 노출 | ◐ 부분(증분) | OIDC userStore **localStorage→sessionStorage**(탭/브라우저 종료 시 토큰 소멸). 전역 `window.__OS_AUTH__` 완전 제거는 §4 이연. | `src/app/core/auth.service.ts` |
| **P1-3** | 권한이 UI 게이트 중심 | ✅ Closed | P0-1의 backend authz로 해소(모든 mutating 엔드포인트가 admin 토큰 검증). PerspectiveService는 가시성 전용으로 명확화. | `controller.js`(verifyActor) |
| **P1-4** | 감사 로그 메모리 기반 | ✅ Closed | 모든 audit에 **operationId** + 구조화 1줄 stdout(로그 수집기 영속). dupa는 **ConfigMap `dupa-audit-log`** 로 영속·재기동 hydrate. | `controller.js`(`logAudit`/`flushAudit`/`hydrateAudit`), `console-backend/server.js`(`logAudit`) |
| **P2-1** | 런타임 plugin error boundary 부재 | ✅ Closed | PluginHost가 mount를 try/catch + `blob:` 출처 window error/unhandledrejection을 해당 plugin에 귀속 → 셸 생존 + 복구 배너. | `src/app/pages/plugin-host.ts` |
| **P2-2** | lifecycle(upgrade/rollback/health) 미흡 | ◐ 부분(증분) | registrations 응답에 **워크로드 health(Ready/NotReady/N/A)** 노출. upgrade/rollback 버전그래프는 §4 이연. | `controller.js`(registrations), `plugin-control-client.service.ts`(Registration.health) |
| **P2-3** | `/ai` deep link 하드코딩 | ✅ Closed | 특정 id 하드코딩 매처 제거 → **registry-driven clean-deeplink 일반 매처**(첫 세그먼트를 pluginId로 위임, 등록 여부는 Extension Host가 판정). | `src/app/app.routes.ts` |
| **P2-4** | 회귀 테스트 부재 | ✅ Closed | `npm test` 동작(`node --test`) + **보안 회귀 테스트 9건**(JWT claim 검증·admin 게이트·SSRF name). dead vitest scaffolding 정리. | `backend/dupa-control/security.test.js`, `package.json`, `tsconfig.spec.json` |

긍정 평가(POS-1 ExtensionHost 신뢰체인 / POS-2 console-backend IGA / POS-3 디자인시스템)는 변경하지 않았고 그대로 유효하다.

---

## 3. 메타검토 추가 발견 — 본 차수 조치

감사가 P0-1/P0-2를 nginx·dupa 한 곳으로 좁게 본 사이 드러난 동근원·인접 위험을 함께 닫았다.

| 항목 | 위험 | 상태 | 조치 |
|---|---|---|---|
| **(B)** 무인증 읽기 | `/api/identity`(전체 사용자 PII)·`/api/catalog`(토폴로지) 무인증 노출 | ✅ Closed | `verifyAuthed` 게이트 + 프런트 Bearer 첨부 |
| **(C)** 헤더 스푸핑 | nginx가 클라이언트 `X-OpenSphere-User`를 그대로 전달 → actor 위조 | ✅ Closed | actor=검증 토큰 claim, nginx에서 헤더 clear |
| **(D)** SA blast radius | 무인증 install이 임의 이미지 워크로드 배포(RCE 등가) | ✅ 완화 | P0-1로 워크로드 생성 트리거가 admin 인증 뒤로 게이트 |
| **(A)** 백엔드 SSRF | `verifyPlugin`이 CR name으로 임의 svc fetch | ✅ Closed | RFC1123 `safeName` 가드 |
| **(F)** 에러 누출 | raw 예외 문자열 응답(내부 호스트/스택) | ✅ Closed | 일반 메시지 + 상세는 서버 로그 |
| **(H)** DoS | 본문 무제한 버퍼링, rate/size 제한 없음 | ◐ 부분 | readBody 256KB + nginx `client_max_body_size 1m` (rate limit은 미적용) |

> **부수 정합 수정**: 콘솔 id_token은 **kanidm-core**(svc/kanidm-core, app=kanidm)가 서명하는데, 백엔드 검증 기본값이 **opensphere-auth BFF**(svc/kanidm)의 JWKS를 가리켜 kid 불일치로 모든 검증이 실패하던 구조적 결함을 발견·수정했다(kanidm-core svc + `servername` 정합). 이 결함은 감사 범위 밖이었으나 P0-1/B 인증이 실제로 작동하기 위한 전제였다.

---

## 4. 미완·이연 항목 (사유 명시)

| 항목 | 사유 | 권고 |
|---|---|---|
| **P1-2 `window.__OS_AUTH__` 전역 제거** | 현재 모든 subShell(별도 repo)의 impersonation 토큰 브리지. 제거하려면 Shell 소유 프록시(`ctx.api.fetch`에서 셸이 토큰 주입 → plugin은 raw 토큰 미접근)로 subShell들을 먼저 이식해야 함. | 다음 스프린트: ctx.api.fetch 도입 → subShell 순차 이식 → 전역 제거. 본 차수는 sessionStorage 증분까지. |
| **P2-2 upgrade/rollback/compatibility 버전그래프** | 실기능(이전 digest 보존·전이·되돌림·semver range 평가). PoC의 정상적 미완성. | 로드맵 항목. 현재는 health 노출까지. |
| **(H) rate limiting** | nginx/백엔드 rate limit 정책 부재. 본문 크기 상한만 적용. | nginx `limit_req` 또는 게이트웨이 도입 시 일괄. |
| **(G) BFF `proxy_ssl_verify off`** | 자체서명 kanidm-tls(PoC). 적절한 CA 신뢰 체계 필요. | 사설 CA/cert-manager 도입 시 검증 ON. |
| **(E) JWT `iat`/최대수명 미검증** | `alg=ES256` 하드핀·`exp`/`nbf`는 검증(혼동 공격 방어됨). 최대 수명만 미적용. | 선택적 강화. |
| **(I) `/api/status` dead route** | `api.service.platformStatus()`가 미라우팅 경로 호출(기능 미사용). | 경로 제거 또는 platform-status 백엔드 라우팅. |
| **이미지 태그 임시값** | deploy가 `sec1`/`sec2`/`sec4` 임시 태그에 핀(미러 캐시 우회용). | deploy.yaml에 정식 버전 태그 반영. |

---

## 5. 재감사 가이드 (팀장 직접 검증 절차)

> 전제: 콘솔 `http://localhost:18090`(port-forward), Kanidm `https://localhost:8444`(port-forward), mars(admin) 로그인.

### 5.1 인증 게이트 (P0-1 / B / C) — 무인증·스푸핑 차단
```bash
B=http://127.0.0.1:18090
# admin 변경/조회 — 무토큰 → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/admin/plugins/registrations/ai/disable -d '{}'   # 기대 401
curl -s -o /dev/null -w "%{http_code}\n" $B/api/admin/plugins/catalog                                      # 기대 401
# 헤더 스푸핑 → 여전히 401 (토큰 없이는 무력)
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/admin/plugins/registrations/ai/disable \
  -H 'X-OpenSphere-User: ceo' -d '{}'                                                                      # 기대 401
# 무인증 읽기 → 401
curl -s -o /dev/null -w "%{http_code}\n" $B/api/identity                                                    # 기대 401
curl -s -o /dev/null -w "%{http_code}\n" "$B/api/rhdh/catalog/entities?limit=5"                             # 기대 401
```

### 5.2 plugin proxy allowlist (P0-2)
```bash
curl -s -o /dev/null -w "%{http_code}\n" $B/api/plugins/some-random-svc/x                                   # 기대 403 (미등록)
curl -s -o /dev/null -w "%{http_code}\n" $B/api/plugins/os-cli/opensphere-cli-linux-amd64                   # 기대 200 (바인딩 allowlist)
curl -s -o /dev/null -w "%{http_code}\n" $B/registry/plugins.json                                           # 기대 200 (공개 — 셸 로드용)
```

### 5.3 CSP (P1-1)
```bash
curl -s -D - -o /dev/null $B/index.html | grep -i content-security-policy
# 기대: script-src 'self' blob:  (unsafe-eval 없음), worker-src 'self' blob:  (data: 없음)
```

### 5.4 인증된 UI 정상성 (회귀 없음 확인)
브라우저(mars 로그인)에서:
- `/manage/plugins` → Topology 로드(Catalog 3 / Enabled 3 / Bindings 1), 에러 배너 없음.
- `/manage/console-admins` → 사용자 목록 로드(mars, groups에 opensphere-console-admins).
- `/p/cluster-manager` → Cluster Overview 정상 렌더(노드/워크로드 데이터).

### 5.5 백엔드 검증 로직 (P0-1) — admin 그룹 강제
- admin 그룹이 아닌 사용자 토큰으로 `/api/admin/**` 호출 시 **403**(`not in opensphere-console-admins`)이어야 함. (admin 토큰=200, 무토큰=401, 비admin=403 3분기 확인)

### 5.6 audit 영속 (P1-4)
```bash
# admin 작업(예: 아이콘 변경/enable) 1회 후
kubectl -n opensphere-system get configmap dupa-audit-log -o jsonpath='{.data.audit\.jsonl}' | tail -3
# 기대: operationId(opId) 포함 JSONL 항목. controller Pod 재기동 후에도 잔존(hydrate).
kubectl -n opensphere-system logs deploy/dupa-registry-controller | grep '"opId"' | tail -3
```

### 5.7 회귀 테스트 (P2-4)
```bash
cd OpenSphere-console && npm test          # 기대: tests 15 / pass 15 / fail 0
npm run test:security                       # 보안 회귀만(9건)
```

### 5.8 JWKS 정합(부수 수정 확인)
```bash
# 콘솔 로그인 토큰 발급자(kanidm-core)와 검증자가 같은 kid를 보는지
kubectl -n opensphere-system exec deploy/dupa-registry-controller -- \
  node -e 'const https=require("https"),fs=require("fs");const u=new URL(process.env.KANIDM_JWKS_URL);https.request({hostname:u.hostname,port:u.port,path:u.pathname,ca:fs.readFileSync(process.env.KANIDM_CA_PATH),servername:process.env.KANIDM_TLS_SERVERNAME},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>console.log(r.statusCode,d.slice(0,120)))}).end()'
# 기대: 200 + 브라우저 토큰 header.kid와 동일한 kid
```

---

## 6. 재감사 청구 항목

### 6.1 Sign-off 청구 (Closed 판정 요청)
다음은 §5 절차로 재현 검증 가능하며 **closed sign-off**를 청구한다:
- P0-1, P0-2, P1-1, P1-3, P1-4, P2-1, P2-3, P2-4
- 메타검토 (B), (C), (D 완화), (A), (F)

### 6.2 잔여 리스크 재평가 청구 (수용/일정 결정 요청)
다음은 본 차수 미완 — **수용(accept)·이연 일정·우선순위**를 팀장 판단으로 결정 요청한다(§4 사유 참조):
- P1-2 전역 토큰 제거(크로스-repo 이식 선행) — 잔여 XSS 토큰 탈취면
- P2-2 upgrade/rollback/compatibility — 운영 성숙도
- (H) rate limiting / (G) BFF TLS 검증 / (E) JWT 최대수명 / (I) dead route
- 배포 이미지 정식 태그 반영

### 6.3 신규 점검 청구 (조치가 새로 도입한 표면)
조치 과정에서 새로 생긴 항목의 적정성 재감사를 청구한다:
1. **auth_request 결합도**: plugin proxy가 controller `/api/internal/proxy-authz`에 의존(fail-closed) — controller 장애 시 전 plugin 프록시 차단. 가용성·SPOF 관점 검토.
2. **dupa의 Kanidm 검증 의존**: controller가 Kanidm JWKS에 도달해야 admin API 동작 — IdP 장애 시 admin 평면 영향 범위.
3. **audit ConfigMap 영속**: ConfigMap 1MB 한도·write 빈도(디바운스 2s)·500건 링버퍼의 운영 적정성. (장기적으로 append-only store 권고는 유효)
4. **JWKS 발급자 이원화**(kanidm-core vs BFF): 토큰 발급/검증 경로의 명세화 필요 — 본 결함이 재발하지 않도록 issuer 토폴로지 문서화.
5. **sessionStorage 전환**: 멀티탭 UX 영향(탭별 재로그인) 수용 여부.

---

## 부록 A. 변경 파일 (커밋 17ad750)
```
backend/dupa-control/controller.js        # 인증·allowlist·SSRF가드·audit영속·에러sanitize·JWKS정합
backend/dupa-control/Dockerfile           # kanidm CA bake(/app)
backend/dupa-control/kanidm-ca.crt        # (신규) JWKS https 검증용 CA
backend/dupa-control/security.test.js     # (신규) 보안 회귀 9건
backend/console-backend/server.js         # 읽기 인증게이트·body한도·에러sanitize·JWKS정합
nginx/default.conf.template               # 헤더clear·auth_request·CSP·body한도
src/app/core/plugin-control-client.service.ts  # Bearer 첨부·health 필드
src/app/core/api.service.ts               # Bearer 첨부
src/app/core/auth.service.ts              # sessionStorage 전환
src/app/pages/console-admins.ts           # Bearer 첨부
src/app/pages/plugin-host.ts              # 런타임 error boundary
src/app/app.routes.ts                     # /ai 일반화
package.json / tsconfig.spec.json         # 테스트 타깃 복구
```

## 부록 B. 검증 환경
- 클러스터: Docker Desktop k8s(멀티노드, containerd). 이미지 레지스트리 `wpl-registry-5000`(pull-through 미러 — **재사용 태그 캐시 주의, 새 태그 권장**).
- 검증 일시: 2026-06-29. `npm test` 15/15, 인증 게이트 401/403, 정상 경로 200, UI 3종 로드 확인.
