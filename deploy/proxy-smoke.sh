#!/bin/sh
# OpenSphere Console 프록시 계약 스모크 테스트 (팀장 검토 ⑤ 반영)
# 셸 nginx의 경로 계약이 암묵 의존이 되지 않도록 배포 후 반드시 실행한다.
#   사용: ./proxy-smoke.sh [BASE]   (기본 http://localhost:1114)
set -u
BASE="${1:-http://localhost:1114}"
fail=0

check() { # check <이름> <기대값> <실제값>
  if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; else echo "FAIL  $1 — 기대 $2, 실제 $3"; fail=1; fi
}

code() { curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$1"; }

# 1) 셸 정적 서빙
check "shell index" 200 "$(code "$BASE/")"
# 2) 플러그인 레지스트리 (§5.3 — ConfigMap)
check "registry" 200 "$(code "$BASE/registry/plugins.json")"
# 3) 기능 컨테이너 프록시: prefix-strip 계약 (/api/status/* → 컨테이너 /*)
check "status api (prefix strip)" 200 "$(code "$BASE/api/status/api/status")"
check "status healthz" 200 "$(code "$BASE/api/status/healthz")"
# 4) 플러그인 manifest + ESM MIME (모듈 로딩 요건)
check "plugin manifest" 200 "$(code "$BASE/api/status/plugins/ui-shell.manifest.json")"
MIME=$(curl -s -I --max-time 8 "$BASE/api/status/plugins/ui-shell.plugin.js" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')
check "plugin.js MIME" "text/javascript" "$MIME"
# 5) rhdh-self 엔진 프록시 (service 토큰 주입 포함 — 200이어야 함)
check "rhdh catalog via proxy" 200 "$(code "$BASE/api/rhdh/catalog/entities?limit=1")"

[ $fail -eq 0 ] && echo "== 프록시 계약 전체 PASS ==" || echo "== 실패 항목 있음 — 프록시/컨테이너 설정 확인 =="
exit $fail
