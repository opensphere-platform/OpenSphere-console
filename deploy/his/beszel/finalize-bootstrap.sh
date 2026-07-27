#!/usr/bin/env bash
# Close first-boot credentials after the CC2 agent is connected.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
k="${KUBECTL:-$here/../../rcc/kubectl-cc2}"
secret_dir="${BESZEL_SECRET_DIRECTORY:-}"

case "$secret_dir" in
  /*) ;;
  *) echo "BESZEL_SECRET_DIRECTORY must be an absolute path" >&2; exit 1 ;;
esac

node "$here/finalize-bootstrap.mjs" "$secret_dir"
"$k" -n beszel-system delete secret beszel-hub-bootstrap --ignore-not-found
"$k" -n beszel-system rollout restart deployment/beszel-hub
"$k" -n beszel-system rollout status deployment/beszel-hub --timeout=180s
curl -fsS --retry 12 --retry-delay 5 --retry-all-errors \
  --connect-timeout 10 --max-time 15 \
  https://beszel.cc2.opl.io.kr/api/health >/dev/null
echo "First-boot credentials were removed from the cluster and the Hub is ready."
