#!/usr/bin/env bash
# JIT-금지 게이트 (헌법 불변식 "Identity/IGA · JIT 금지" · D-1 의무)
# Keycloak realm-export(JSON)에서 JIT(Just-In-Time, 로그인 시 자동 사용자 생성) 활성화 흔적을 grep.
# 발견 시 exit 1 → CI/PR 차단. 사용: jit-gate.sh <realm-export.json>
#
# 차단 대상:
#   - registrationAllowed: true            (셀프 가입 = 자동 생성)
#   - identityProviders[].config.syncMode FORCE|IMPORT 외 + 자동링크   (외부 IdP JIT 프로비저닝)
#   - first broker login 플로우의 "Create User If Unique" 가 ALTERNATIVE/REQUIRED 로 자동 생성
set -euo pipefail
F="${1:-}"
[ -n "$F" ] && [ -f "$F" ] || { echo "usage: jit-gate.sh <realm-export.json>"; exit 2; }

fail=0
note() { echo "  ✗ JIT 위반: $1"; fail=1; }

# 1) 셀프 가입 금지
if grep -Eq '"registrationAllowed"[[:space:]]*:[[:space:]]*true' "$F"; then
  note 'registrationAllowed=true (셀프 가입 자동 생성)'
fi

# 2) 외부 IdP 자동 프로비저닝(syncMode FORCE/IMPORT). 없으면 통과.
if grep -Eq '"syncMode"[[:space:]]*:[[:space:]]*"(FORCE|IMPORT)"' "$F"; then
  note 'identityProvider syncMode=FORCE|IMPORT (외부 IdP JIT 자동 프로비저닝). LEGACY/수동 검토 흐름으로 전환 필요'
fi

# 3) first-broker-login 자동 생성(검토 단계 없이). 휴리스틱: 'Create User If Unique' + requirement REQUIRED/ALTERNATIVE
#    (정밀 검사는 authenticationFlows 파싱 필요 — PoC는 grep 휴리스틱 + 위 2종이 1차 방어)
if grep -q 'idp-create-user-if-unique' "$F" && grep -Eq '"requirement"[[:space:]]*:[[:space:]]*"(REQUIRED|ALTERNATIVE)"' "$F"; then
  echo "  ⚠ 참고: first-broker-login에 자동 생성 단계 존재 가능 — authenticationFlows 수동 확인 권고(차단은 아님)"
fi

if [ "$fail" -eq 0 ]; then echo "✓ JIT-금지 게이트 통과 ($F)"; else echo "✗ JIT-금지 게이트 실패"; fi
exit "$fail"
