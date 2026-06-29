# OpenSphere Console 재감사 응답서

- 작성일: 2026-06-29
- 대상: `OpenSphere-console`
- 근거 재감사: `docs/AUDIT-RE-AUDIT-2026-06-29-OpenSphere-console.md` (기술팀장, 판정: **조건부 미승인**)
- 조치 커밋: `30e09e1` (`fix(security): 재감사 must-close 반영 + 도메인 기반 OIDC 전환`), origin/main
- 배포 이미지(런타임 반영): `dupa-registry-controller:sec5`, `console-backend:sec3`
- 신규 리소스: Secret `dupa-events-token`(opensphere-system, key `SHELL_SERVICE_TOKEN`)

---

## 1. 종합

재감사의 판정과 지적을 **수용**한다. 답변서의 "Closed" 과표기(특히 `/api/admin/events`, allowlist 범위)는 정확한 정정이었다. 재감사가 제시한 **3개 must-close 중 즉시 닫을 수 있는 2건(events 무인증 쓰기, plugin proxy allowlist 범위)을 코드로 닫았고**, 추가로 P2-2(JWT 필수 claim)도 함께 강화했다. 나머지 1건(raw token bridge 제거)은 subShell(별도 repo) 이식이 선행되어야 하므로 **이행 계획**으로 전환한다.

런타임 재검증에서 events 무토큰 쓰기는 `401`, 미등록/비활성 plugin proxy는 `403`, 검증·활성 plugin과 enabled 바인딩은 `200`으로 동작한다. `npm test`는 18/18 통과한다.

---

## 2. must-close 조치 결과

### ✅ 재감사 P1-1 — `/api/admin/events` 무인증 쓰기 (CLOSED)

**조치**: events 발행에 서비스 토큰을 강제(fail-closed). 사용자 토큰이 없는 subShell server-to-server 발행구이므로 사용자 Bearer가 아니라 공유 서비스 토큰으로 보호.
- `backend/dupa-control/controller.js` — events 핸들러 진입 시 `X-Shell-Token == SHELL_SERVICE_TOKEN` 검사, 불일치/미설정 시 `401`.
- `SHELL_SERVICE_TOKEN`은 env(Secret `dupa-events-token`)에서 로드. 미설정이면 events 발행 전면 차단(fail-closed).

**재현**:
```bash
# 무토큰 → 401 (이전: 202)
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://console.opensphere.dev/api/admin/events \
  -H 'content-type: application/json' -d '{"source":"x","action":"y"}'        # 401
# 서비스 토큰 → 202
TOK=$(kubectl -n opensphere-system get secret dupa-events-token -o jsonpath='{.data.SHELL_SERVICE_TOKEN}' | base64 -d)
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://console.opensphere.dev/api/admin/events \
  -H "x-shell-token: $TOK" -H 'content-type: application/json' -d '{"source":"sub","action":"ok"}'   # 202
```

**잔여(크로스-repo)**: subShell 백엔드가 events 발행 시 `X-Shell-Token` 헤더를 전송하도록 이식 필요. 미이식 상태에서 익명 발행은 차단됨(= 보안상 의도된 fail-closed). 권고대로 향후 SA TokenReview/mTLS/NetworkPolicy로 승격 가능.

### ✅ 재감사 P1-2 — plugin proxy allowlist 범위 (CLOSED)

**조치**: allowlist를 "모든 UIPluginPackage 이름"에서 **"검증 성공 + 활성(published)" plugin id + enabled CLIDownload 서비스 id**로 축소.
- `backend/dupa-control/controller.js` — `proxyAllow`를 reconcile 루프 **이후** `published`(Enabled + Ready + manifest/signature/entry 검증 성공) 기준으로 계산. enabled가 아닌 CLIDownload는 제외.
- 결과: Failed/Disabled/미검증 package id는 allowlist에서 자동 제외 → `auth_request`에서 `403`.

**재현**:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://console.opensphere.dev/api/plugins/some-random-svc/x   # 403
curl -s -o /dev/null -w "%{http_code}\n" https://console.opensphere.dev/api/plugins/os-cli/opensphere-cli-linux-amd64  # 200 (enabled binding)
curl -s -o /dev/null -w "%{http_code}\n" https://console.opensphere.dev/api/plugins/cluster-manager/plugins/ui-shell.manifest.json  # 200 (published)
```

**메모(Disabled workload)**: Disabled 상태는 여전히 workload를 삭제하지 않으나, allowlist에서 제외되어 **proxy 접근은 차단**(403)된다. 워크로드 리소스 정리(삭제)는 보안이 아닌 리소스 정책 사안으로 분리해 후속.

### ✅ 재감사 P2-2 — JWT 필수 claim 방어 (CLOSED)

**조치**: `exp`·`sub`·`iat` 부재를 거부(이전: `exp`는 존재할 때만 검사).
- `backend/dupa-control/controller.js` `assertClaims` + `backend/console-backend/server.js` `verifyAuthed`: `missing exp/sub/iat` → `401`.
- 보안 회귀 테스트 3건 추가(`security.test.js`): missing exp/sub/iat 거부. **npm test 18/18**.

**재현**:
```bash
cd OpenSphere-console && npm test    # tests 18 / pass 18 / fail 0
```
(Kanidm id_token은 exp/sub/iat 포함 → 실로그인 무영향. admin/console-admins UI 정상 확인.)

### ◐ 재감사 P1-2(원본) — raw token bridge 제거 (이행 계획)

`window.__OS_AUTH__.token()`은 여전히 id_token을 전역 JS context에 노출(storage는 sessionStorage로 개선됨). 이는 **모든 subShell의 impersonation 토큰 브리지**라 즉시 제거 시 전 subShell이 깨진다.
- **이행 계획**: ① 셸이 Authorization을 주입하는 `ctx.api.fetch`(또는 backend proxy) 제공 → ② subShell들(별도 repo)을 그 capability로 순차 이식 → ③ 전역 `window.__OS_AUTH__` 제거. 단계별 PR로 진행.

---

## 3. 재감사 부분/후속 항목 응답

| 재감사 항목 | 응답 |
|---|---|
| P1-4 audit append-only 아님 | 수용. 현재 stdout JSONL + ConfigMap(ring buffer). 운영기준은 Loki/OTel/SIEM 또는 append-only store로 승격 — 로드맵. 이벤트 schema에 requestId/source workload identity/auth method/client ip 추가 권고도 반영 예정. |
| P2-1 error boundary 격리 약함 | 수용. 현재 UX fallback + blob 출처 귀속. 강한 격리는 iframe/worker 샌드박스 필요 — 제품 성숙도 후속. |
| P2-2 max token lifetime | exp/sub/iat 필수화는 반영. 최대 수명 검사는 Kanidm 토큰 TTL 확정 후 추가 예정(과제로 등록). |
| P2-2 lifecycle upgrade/rollback | 범위 외 잔여. health 노출만 반영. version graph/rollback은 로드맵. |

---

## 4. 재검증 가이드 (팀장 직접)

> 전제: `console.opensphere.dev` 도메인(ingress 443 PF) 또는 `localhost:18090`.

```bash
B=https://console.opensphere.dev   # 또는 http://127.0.0.1:18090
# 1) events 무인증 차단
curl -s -o /dev/null -w "events no-token: %{http_code}\n" -X POST $B/api/admin/events -d '{"a":1}'   # 401
# 2) plugin proxy allowlist (published)
curl -s -o /dev/null -w "random: %{http_code}\n" $B/api/plugins/some-random-svc/x      # 403
curl -s -o /dev/null -w "os-cli: %{http_code}\n" $B/api/plugins/os-cli/opensphere-cli-linux-amd64   # 200
# 3) 기존 보안 게이트 회귀 없음
curl -s -o /dev/null -w "admin no-token: %{http_code}\n" $B/api/admin/plugins/catalog  # 401
curl -s -o /dev/null -w "identity no-token: %{http_code}\n" $B/api/identity            # 401
# 4) JWT 필수 claim + 테스트
cd OpenSphere-console && npm test    # 18/18
# 5) 인증 UI 무회귀
#  브라우저 mars 로그인 → /manage/plugins(Topology 로드)·/manage/console-admins(사용자 로드) 정상
```
선택: Disabled plugin을 만든 뒤 `/api/plugins/<id>/...` → 403 확인(allowlist 제외).

---

## 5. Sign-off 재청구

### closed sign-off 청구
- 재감사 P1-1(events 무인증 쓰기) — service-token fail-closed
- 재감사 P1-2(allowlist 범위) — published 기준 축소
- 재감사 P2-2(JWT 필수 claim) — exp/sub/iat 강제

### 일정 합의 청구 (이행 계획 항목)
- raw token bridge 제거(`ctx.api.fetch` 도입 → subShell 이식 → 전역 제거)
- events 발행측 subShell 토큰 전송 이식
- append-only audit store / upgrade·rollback / iframe-worker 격리 (제품 성숙도)

### 신규 표면 점검 청구 (이번 조치가 도입)
- `SHELL_SERVICE_TOKEN`(Secret `dupa-events-token`) 회전 정책 — 현재 정적. KMS/회전 도입 시 갱신.
- allowlist가 reconcile 성공분으로만 갱신 → reconcile 장기 실패 시 직전 allowlist 유지(가용성 우선) 동작의 적정성.

---

## 부록 A. 변경 (커밋 30e09e1)
```
backend/dupa-control/controller.js     # allowlist=published, events service-token, JWT 필수 claim
backend/console-backend/server.js      # JWT 필수 claim(exp/sub/iat)
backend/dupa-control/security.test.js  # missing-claim 회귀 테스트 3건 (총 18)
src/app/core/auth.service.ts           # (도메인 전환) authority→auth.console.opensphere.dev
```
배포: dupa `:sec5`, console-backend `:sec3`, Secret `dupa-events-token`(SHELL_SERVICE_TOKEN env).

## 부록 B. 검증 결과 (2026-06-29)
- events: no-token 401 / token 202
- plugin proxy: random 403 / os-cli 200 / cluster-manager(published) 200
- admin no-token 401 · identity no-token 401 (회귀 없음)
- npm test 18/18 · 도메인 로그인 end-to-end 정상 · admin·console-admins UI 정상
