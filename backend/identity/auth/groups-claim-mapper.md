# Keycloak groups claim mapper (Workspace 정책 게이트 입력)

OpenSphere Console의 perspective(Workspace) 정책 게이트는 토큰의 `groups` claim을 읽어
허용 워크스페이스를 결정한다(`platform-admins` → A/B/C). 그러려면 `opensphere-console` 클라이언트에
**group-membership protocol mapper**가 있어야 한다.

## 적용 (realm: opensphere-admin, client: opensphere-console)

```bash
# admin 토큰 취득
T=$(curl -s -X POST $KC/realms/master/protocol/openid-connect/token \
  -d client_id=admin-cli -d username=$ADMIN -d password=$PW -d grant_type=password \
  | jq -r .access_token)
CID=$(curl -s "$KC/admin/realms/opensphere-admin/clients?clientId=opensphere-console" \
  -H "Authorization: Bearer $T" | jq -r '.[0].id')

curl -X POST "$KC/admin/realms/opensphere-admin/clients/$CID/protocol-mappers/models" \
  -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{
    "name":"groups","protocol":"openid-connect","protocolMapper":"oidc-group-membership-mapper",
    "config":{"claim.name":"groups","full.path":"false",
              "access.token.claim":"true","id.token.claim":"true","userinfo.token.claim":"true"}
  }'
```

- `full.path=false` → claim 값은 `platform-admins`(앞 `/` 없음). 셸 auth.service가 `/` 제거 정규화도 함.
- 적용 후 사용자는 **재로그인**해야 새 토큰에 groups가 포함된다.
- 정식: realm import(`keycloak-realm-import` CM)에 이 mapper를 포함시켜 부트스트랩 시 자동 생성.

## 정책 매핑 (현재 PoC, 셸 내 `perspective.service.ts`)
| 그룹/역할 | 허용 워크스페이스 |
|---|---|
| `platform-admins` (group) 또는 `platform-admin` (role) | A 운영 · B 협업 · C 업무 |
| 그 외 | B 협업 · C 업무 (운영 A 제외) |

> ⚠️ 이 정책은 셸 내부에 있다(PoC). 운영 전 **OPA(rego)** 로 이관 — `perspective.service.ts`의 `decide()`가 그 seam이다.
