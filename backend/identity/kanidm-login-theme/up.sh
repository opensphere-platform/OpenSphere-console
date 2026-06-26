#!/usr/bin/env bash
# OpenSphere Carbon login template applied to the Kanidm console login page.
# Injects override.css + style.js (Kanidm's, with a Carbon-template DOM injector)
# into the kanidm pod via a ConfigMap mounted over /hpkg/{override.css,style.js}.
# Keeps OIDC / console / plugins untouched — only the Kanidm /ui/login UI changes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NS=opensphere-console-auth

echo "== ConfigMap (override.css + style.js) =="
kubectl -n "$NS" create configmap kanidm-login-override \
  --from-file=override.css="$HERE/override.css" \
  --from-file=style.js="$HERE/style.js" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "== mount both over /hpkg/* in the kanidm pod =="
kubectl -n "$NS" patch deploy kanidm --type strategic -p '{
  "spec": {"template": {"spec": {
    "volumes": [{"name": "login-override", "configMap": {"name": "kanidm-login-override"}}],
    "containers": [{"name": "kanidmd", "volumeMounts": [
      {"name": "login-override", "mountPath": "/hpkg/override.css", "subPath": "override.css", "readOnly": true},
      {"name": "login-override", "mountPath": "/hpkg/style.js", "subPath": "style.js", "readOnly": true}
    ]}]
  }}}
}'
kubectl -n "$NS" rollout restart deploy/kanidm
kubectl -n "$NS" rollout status deploy/kanidm --timeout=150s
echo "done → https://localhost:8444/ui/login (OpenSphere Carbon login)"
