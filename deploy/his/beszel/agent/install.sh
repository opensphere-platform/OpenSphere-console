#!/usr/bin/env bash
# Install the digest-verified Beszel v0.18.7 ARM64 agent as a non-root service.
#
# Required:
#   BESZEL_AGENT_SECRET_DIRECTORY=/absolute/directory
# containing files named `key` and `token`, both non-empty and with no newline.
set -euo pipefail
umask 077

version="0.18.7"
archive_url="https://github.com/henrygd/beszel/releases/download/v0.18.7/beszel-agent_linux_arm64.tar.gz"
archive_sha256="0134256068937cab74b7f26e37007a4b5bf3d52cd40496a8b8b0ebbbb1a6f02f"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
secret_dir="${BESZEL_AGENT_SECRET_DIRECTORY:-}"

die() {
  echo "beszel agent install: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "run as root"
case "$secret_dir" in
  /*) ;;
  *) die "BESZEL_AGENT_SECRET_DIRECTORY must be an absolute path" ;;
esac
[ -f "$secret_dir/key" ] || die "missing $secret_dir/key"
[ -f "$secret_dir/token" ] || die "missing $secret_dir/token"
[ -s "$secret_dir/key" ] || die "the key file is empty"
[ -s "$secret_dir/token" ] || die "the token file is empty"
[ "$(wc -l <"$secret_dir/key" | tr -d ' ')" -eq 0 ] || die "the key file must not contain a newline"
[ "$(wc -l <"$secret_dir/token" | tr -d ' ')" -eq 0 ] || die "the token file must not contain a newline"

case "$(uname -m)" in
  aarch64|arm64) ;;
  *) die "this pinned archive is for ARM64; found $(uname -m)" ;;
esac

for command in curl sha256sum tar install useradd systemctl; do
  command -v "$command" >/dev/null 2>&1 || die "required command is missing: $command"
done

tmp="$(mktemp -d /tmp/polyon-beszel-agent.XXXXXX)"
cleanup() {
  case "$tmp" in
    /tmp/polyon-beszel-agent.*) rm -rf "$tmp" ;;
  esac
}
trap cleanup EXIT

curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 \
  "$archive_url" -o "$tmp/agent.tar.gz"
actual="$(sha256sum "$tmp/agent.tar.gz" | awk '{print $1}')"
[ "$actual" = "$archive_sha256" ] \
  || die "archive digest mismatch: expected $archive_sha256, got $actual"

members="$(tar -tzf "$tmp/agent.tar.gz")"
for expected in LICENSE readme.md beszel-agent; do
  printf '%s\n' "$members" | grep -Fx "$expected" >/dev/null \
    || die "verified archive is missing $expected"
done
[ "$(printf '%s\n' "$members" | wc -l | tr -d ' ')" -eq 3 ] \
  || die "archive contains an unexpected member"
tar -xzf "$tmp/agent.tar.gz" -C "$tmp"

if ! getent group beszel >/dev/null 2>&1; then
  groupadd --system beszel
fi
if ! id -u beszel >/dev/null 2>&1; then
  useradd --system --gid beszel --home-dir /var/lib/beszel-agent \
    --shell /usr/sbin/nologin beszel
fi

install -d -o root -g root -m 0755 "/usr/local/lib/beszel-agent/$version"
install -o root -g root -m 0755 "$tmp/beszel-agent" \
  "/usr/local/lib/beszel-agent/$version/beszel-agent"
install -d -o root -g beszel -m 0750 /etc/beszel-agent
install -o root -g beszel -m 0440 "$secret_dir/key" /etc/beszel-agent/key
install -o root -g beszel -m 0440 "$secret_dir/token" /etc/beszel-agent/token
install -o root -g beszel -m 0440 "$here/agent.env.example" /etc/beszel-agent/agent.env
install -o root -g root -m 0644 "$here/beszel-agent.service" \
  /etc/systemd/system/beszel-agent.service

systemctl daemon-reload
systemctl enable --now beszel-agent.service

"/usr/local/lib/beszel-agent/$version/beszel-agent" --version
systemctl --quiet is-active beszel-agent.service \
  || die "service did not become active; inspect journalctl -u beszel-agent"
if ss -ltnp 2>/dev/null | grep -q ':45876'; then
  die "port 45876 is listening even though SSH mode is disabled"
fi
echo "Beszel agent $version is active with no SSH listener."
