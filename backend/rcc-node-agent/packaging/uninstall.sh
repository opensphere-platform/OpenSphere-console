#!/usr/bin/env bash
# Removes the PolyON RCC node agent. Configuration and key material are kept by
# default so an accidental uninstall does not destroy the host binding.
set -euo pipefail

PREFIX="${PREFIX:-/usr/local/bin}"
CONFIG_DIR="/etc/rcc-node-agent"
UNIT_DIR="/etc/systemd/system"
PURGE="${PURGE:-0}"

if [ "$(id -u)" -ne 0 ]; then
  echo "uninstall.sh must run as root" >&2
  exit 1
fi

systemctl disable --now rcc-node-agent 2>/dev/null || true
rm -f "${UNIT_DIR}/rcc-node-agent.service"
systemctl daemon-reload
rm -f "${PREFIX}/rcc-node-agent"

if [ "${PURGE}" = "1" ]; then
  rm -rf "${CONFIG_DIR}"
  echo "removed ${CONFIG_DIR}"
else
  echo "kept ${CONFIG_DIR}; re-run with PURGE=1 to remove configuration and key"
fi

echo "revoke the host key id in RCC after uninstalling"
