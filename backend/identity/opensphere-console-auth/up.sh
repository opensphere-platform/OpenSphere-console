#!/usr/bin/env bash
# Deploy the opensphere-console-auth BFF and swap Kanidm's browser/in-cluster services to it.
# The BFF becomes the OIDC issuer (owns the Carbon login UI, authenticates via Kanidm
# /v1/auth REST). Reversible with down.sh (repoint services back to Kanidm).
set -euo pipefail
. "$(cd "$(dirname "$0")/../../tools/local-dev" && pwd)/lib.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
NS=opensphere-console
REG="${REG:-$(detect_reg)}"
TAG="${1:-p1}"

echo "== refresh kanidm CA into build context (use a CURRENT one) =="
cp "$HERE/../../console/console-identity/kanidm-ca.crt" "$HERE/kanidm-ca.crt"

echo "== ensure a persistent ES256 signing key (stable kid across restarts) =="
if ! kubectl -n "$NS" get secret opensphere-console-auth-sig >/dev/null 2>&1; then
  TMP="$(mktemp)"; openssl ecparam -name prime256v1 -genkey -noout -out "$TMP"
  kubectl -n "$NS" create secret generic opensphere-console-auth-sig --from-file=sig.key="$TMP"
  rm -f "$TMP"
fi

echo "== build + push opensphere-console-auth:$TAG =="
docker build -t "$REG/opensphere-console-auth:$TAG" "$HERE"
docker push "$REG/opensphere-console-auth:$TAG"

echo "== apply SA/RBAC/kanidm-core/Deployment =="
kubectl apply -f "$HERE/deploy.yaml"
kubectl -n "$NS" set image deploy/opensphere-console-auth auth="$REG/opensphere-console-auth:$TAG"
kubectl -n "$NS" rollout status deploy/opensphere-console-auth --timeout=150s

echo "== swap services -> BFF (browser :8444 and in-cluster kanidm.svc) =="
kubectl -n "$NS" patch svc kanidm     -p '{"spec":{"selector":{"app":"opensphere-console-auth"}}}'
kubectl -n "$NS" patch svc kanidm-ext -p '{"spec":{"selector":{"app":"opensphere-console-auth"}}}'

echo "done -> https://localhost:8444 now served by opensphere-console-auth (Kanidm internal: kanidm-core.$NS.svc:8443)"
