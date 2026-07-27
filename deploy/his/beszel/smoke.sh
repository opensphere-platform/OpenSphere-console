#!/usr/bin/env bash
# Read-only acceptance checks for the CC2 Beszel deployment.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
k="${KUBECTL:-$here/../../rcc/kubectl-cc2}"
ssh_target="${BESZEL_SSH_TARGET:-cc2-k3s}"
domain="beszel.cc2.opl.io.kr"
expected_ip="158.180.78.77"
expected_image="docker.io/henrygd/beszel@sha256:a849ad80814b6a1a3be665304dcace5d4854b3bed7bde4dd1227e8ce1b82d477"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ "$(dig +short "$domain" A | tail -1)" = "$expected_ip" ] \
  || fail "$domain does not resolve to $expected_ip"
"$k" get namespace beszel-system >/dev/null
[ "$("$k" get storageclass beszel-local-retain -o jsonpath='{.reclaimPolicy}')" = "Retain" ] \
  || fail "Beszel storage does not retain its volume"
[ "$("$k" -n beszel-system get pvc beszel-hub-data -o jsonpath='{.status.phase}')" = "Bound" ] \
  || fail "Beszel PVC is not Bound"
"$k" -n beszel-system rollout status deployment/beszel-hub --timeout=10s >/dev/null
[ "$("$k" -n beszel-system get deployment beszel-hub -o jsonpath='{.spec.template.spec.containers[0].image}')" = "$expected_image" ] \
  || fail "Hub image is not the reviewed digest"
[ "$("$k" -n beszel-system get deployment beszel-hub -o jsonpath='{.spec.template.spec.automountServiceAccountToken}')" = "false" ] \
  || fail "Hub gained a Kubernetes service-account token"

curl -fsS --max-time 10 "https://$domain/api/health" >/dev/null \
  || fail "public Hub health failed"
ssh -o BatchMode=yes "$ssh_target" \
  "systemctl --quiet is-active beszel-agent.service" \
  || fail "host agent is not active"
version="$(ssh -o BatchMode=yes "$ssh_target" \
  "/usr/local/lib/beszel-agent/0.18.7/beszel-agent --version")"
printf '%s' "$version" | grep -q '0.18.7' || fail "host agent is not v0.18.7"
if ssh -o BatchMode=yes "$ssh_target" \
  "ss -ltn | awk '{print \$4}' | grep -Eq '(^|:|\\])45876$'"; then
  fail "port 45876 is listening; outbound-only mode was not enforced"
fi

echo "PASS: Hub, retained storage, pinned image, public health and outbound-only agent are healthy."
