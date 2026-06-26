# JIT-금지 게이트 (헌법 불변식 · D-1 의무)

헌법 불변식 **"Identity/IGA · JIT 금지"** 의 강제 게이트. 권위 plane = P2 `opensphere-foundation-identity`.
JIT(Just-In-Time provisioning) = 로그인/SSO 시점에 사용자를 **자동 생성**하는 것. IGA(거버넌스) 원칙상
사용자 생성은 명시적·승인된 흐름이어야 하며, 로그인만으로 계정이 생겨선 안 된다.

## 게이트 (`jit-gate.sh`)
Keycloak realm-export(JSON)에서 JIT 활성화 흔적을 검출 → 발견 시 `exit 1`(PR/배포 차단).
- `registrationAllowed:true` — 셀프 가입(자동 생성) 금지.
- identityProvider `syncMode: FORCE|IMPORT` — 외부 IdP 로그인 시 자동 프로비저닝 금지(수동/검토 흐름 요구).
- first-broker-login `idp-create-user-if-unique` 자동 단계 — 휴리스틱 경고(수동 확인 권고).

## 검증 (2026-06-14, 라이브 realm)
- 현 `opensphere-admin` realm: `registrationAllowed=false`, 외부 IdP 자동 프로비저닝 없음 → **✓ 통과**.
- 음성 테스트: `registrationAllowed=true` 주입 → **✗ exit 1**, `syncMode=FORCE` 주입 → **✗ exit 1**(정상 차단).

## 실행 (CI)
```sh
# 1) realm export (CI 러너에서 admin 자격으로)
curl -s -X POST "$KC/admin/realms/opensphere-admin/partial-export?exportClients=false&exportGroupsAndRoles=false" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -o realm-export.json
# 2) 게이트
bash identity/auth/jit-gate.sh realm-export.json
```
> realm-export.json은 **커밋하지 않는다**(realm 덤프에 민감 설정 포함 가능) — CI 런타임에 생성·검사.
> CI 워크플로 예시: `jit-gate.workflow.yml`. 정식은 `opensphere-foundation-identity` repo의 CI로 이관(D-1).

## 한계 (PoC)
- grep 휴리스틱 기반(1차 방어). first-broker-login 자동 생성의 정밀 판정은 `authenticationFlows` 파싱 필요(향후 강화).
- 런타임 검증 보강: identity 콘솔에 compliance 배지(realm registrationAllowed·IdP syncMode 표시)는 후속.
