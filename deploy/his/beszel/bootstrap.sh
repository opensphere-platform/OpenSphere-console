#!/usr/bin/env bash
# Create Beszel Hub secrets from local files, then apply the isolated Hub.
#
# Required:
#   BESZEL_SECRET_DIRECTORY=/absolute/directory
# with three files that contain no trailing newline:
#   pb-encryption-key  exactly 32 characters
#   user-email        the initial regular administrator email
#   user-password     at least 16 characters
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
k="${KUBECTL:-$here/../../rcc/kubectl-cc2}"
local_kubectl="${KUBECTL_CLIENT:-kubectl}"
secret_dir="${BESZEL_SECRET_DIRECTORY:-}"
expected_ip="158.180.78.77"
domain="beszel.cc2.opl.io.kr"

die() {
  echo "beszel bootstrap: $*" >&2
  exit 1
}

case "$secret_dir" in
  /*) ;;
  *) die "BESZEL_SECRET_DIRECTORY must be an absolute path" ;;
esac
for name in pb-encryption-key user-email user-password; do
  [ -f "$secret_dir/$name" ] || die "missing $secret_dir/$name"
  [ -s "$secret_dir/$name" ] || die "$secret_dir/$name is empty"
  [ "$(wc -l <"$secret_dir/$name" | tr -d ' ')" -eq 0 ] \
    || die "$secret_dir/$name must not contain a newline"
done
[ "$(wc -c <"$secret_dir/pb-encryption-key" | tr -d ' ')" -eq 32 ] \
  || die "pb-encryption-key must be exactly 32 characters"
[ "$(wc -c <"$secret_dir/user-password" | tr -d ' ')" -ge 16 ] \
  || die "user-password must be at least 16 characters"
grep -Eq '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' "$secret_dir/user-email" \
  || die "user-email is not a valid email address"

resolved="$(dig +short "$domain" A 2>/dev/null | tail -1)"
[ "$resolved" = "$expected_ip" ] \
  || die "$domain must resolve to $expected_ip before Ingress and ACME are created; found '${resolved:-nothing}'"

[ -x "$k" ] || die "kubectl wrapper is not executable: $k"
command -v "$local_kubectl" >/dev/null 2>&1 \
  || die "local kubectl client is required to stream Secret manifests"

# Namespace and Retain storage are applied first so the namespaced secrets have
# a target. The input files stay local; their values are never command-line
# arguments or terminal output. `kubectl-cc2` executes on the remote host, so a
# remote `--from-file` cannot see these local files. Build each Secret with the
# local client and stream the generated object to the remote client over stdin.
"$k" apply -f - <"$here/00-namespace-storage.yaml"
"$local_kubectl" -n beszel-system create secret generic beszel-hub-encryption \
  --from-file=pb-encryption-key="$secret_dir/pb-encryption-key" \
  --dry-run=client -o yaml | "$k" apply -f -
"$local_kubectl" -n beszel-system create secret generic beszel-hub-bootstrap \
  --from-file=user-email="$secret_dir/user-email" \
  --from-file=user-password="$secret_dir/user-password" \
  --dry-run=client -o yaml | "$k" apply -f -
"$k" apply -f - <"$here/10-hub.yaml"
"$k" apply -f - <"$here/20-network-ingress.yaml"
"$k" -n beszel-system rollout status deployment/beszel-hub --timeout=180s

# ACME may have issued the certificate while the local TLS path still has the
# immediately preceding chain cached, and Traefik can return a short 503 while
# it swaps routers. Retry all transport/HTTP failures inside the bounded
# bootstrap window instead of reporting a failed deployment that is already
# healthy a few seconds later.
curl -fsS --retry 12 --retry-delay 5 --retry-all-errors \
  --connect-timeout 10 --max-time 15 "https://$domain/api/health" >/dev/null
echo "Beszel Hub is ready at https://$domain."
echo "Next: node $here/enroll-agent.mjs $secret_dir"
