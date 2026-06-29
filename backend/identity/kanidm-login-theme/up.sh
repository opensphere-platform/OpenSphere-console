#!/usr/bin/env bash
# OpenSphere 로그인 테마 — Kanidm 1.4.6 SSR.
#
# Kanidm 1.4.6은 로그인을 SSR로 전환해 /pkg/style.css + bootstrap만 로드한다(구 /hpkg/style.js
# DOM 인젝터는 더 이상 로드되지 않음). 또 /pkg/* URL은 컨테이너 /hpkg 디렉터리에서 서빙된다.
# 따라서 테마 = Kanidm 원본 /hpkg/style.css + pkg-style-override.css(OpenSphere CSS)를 합쳐
# /hpkg/style.css 에 마운트(ConfigMap). crab 숨김 + h3→"OpenSphere" + IBM Plex + OS 블루.
# (login form, main.form-signin 만 대상 — apps portal/profile은 기본 유지.)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NS=opensphere-console-auth
TMP="$(mktemp -d)"

echo "== Kanidm 원본 style.css 추출(/hpkg/style.css) =="
# MSYS_NO_PATHCONV: Git Bash가 /hpkg/... 를 Windows 경로로 바꾸지 않도록(Windows 실행 대비)
MSYS_NO_PATHCONV=1 kubectl -n "$NS" exec deploy/kanidm -- cat /hpkg/style.css > "$TMP/orig.css"
[ -s "$TMP/orig.css" ] || { echo "ERR: /hpkg/style.css 추출 실패"; exit 1; }

echo "== 합본(원본 + OpenSphere 오버라이드) =="
cat "$TMP/orig.css" "$HERE/pkg-style-override.css" > "$TMP/style.css"

echo "== ConfigMap kanidm-login-css =="
kubectl -n "$NS" create configmap kanidm-login-css \
  --from-file=style.css="$TMP/style.css" --dry-run=client -o yaml | kubectl apply -f -

echo "== /hpkg/style.css 마운트로 교체 (구 /hpkg injector 제거) =="
kubectl -n "$NS" delete configmap kanidm-login-override --ignore-not-found
kubectl -n "$NS" patch deploy kanidm --type=json --patch-file "$HERE/kanidm-theme-patch.json"
kubectl -n "$NS" rollout restart deploy/kanidm
kubectl -n "$NS" rollout status deploy/kanidm --timeout=150s
echo "done → OpenSphere 로그인 테마 적용. (브라우저 하드 리로드로 /pkg/style.css 캐시 무효화)"
