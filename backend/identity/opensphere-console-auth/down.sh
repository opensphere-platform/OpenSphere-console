#!/usr/bin/env bash
# Roll back the BFF swap: repoint kanidm + kanidm-ext services back to the real Kanidm
# pods. Login reverts to the stock Kanidm OIDC immediately. Pass --purge to also delete
# the BFF Deployment/SA/RBAC/kanidm-core (the kanidm-login-theme Carbon reskin stays).
set -euo pipefail
NS=opensphere-console-auth

echo "== repoint services back to real Kanidm =="
kubectl -n "$NS" patch svc kanidm     -p '{"spec":{"selector":{"app":"kanidm"}}}'
kubectl -n "$NS" patch svc kanidm-ext -p '{"spec":{"selector":{"app":"kanidm"}}}'

if [[ "${1:-}" == "--purge" ]]; then
  echo "== purge BFF resources =="
  kubectl -n "$NS" delete deploy opensphere-console-auth --ignore-not-found
  kubectl -n "$NS" delete svc kanidm-core --ignore-not-found
  kubectl -n "$NS" delete sa opensphere-console-auth --ignore-not-found
  kubectl -n opensphere-console delete rolebinding opensphere-console-auth-kanidm-reader --ignore-not-found
  kubectl -n opensphere-console delete role opensphere-console-auth-kanidm-reader --ignore-not-found
fi
echo "done -> https://localhost:8444 served by Kanidm again"
