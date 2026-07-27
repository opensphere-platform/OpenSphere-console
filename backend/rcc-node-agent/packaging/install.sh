#!/usr/bin/env bash
# Installs the PolyON RCC node agent as a root-owned systemd service.
#
# The agent signing key is NEVER generated here and never printed. An operator
# registers the host in RCC, receives a key id, and writes the key material to
# /etc/rcc-node-agent/agent.key out of band.
set -euo pipefail

BINARY_SRC="${1:-./dist/rcc-node-agent}"
PREFIX="${PREFIX:-/usr/local/bin}"
CONFIG_DIR="/etc/rcc-node-agent"
UNIT_DIR="/etc/systemd/system"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi
if [ ! -f "${BINARY_SRC}" ]; then
  echo "agent binary not found at ${BINARY_SRC}; run 'make build' first" >&2
  exit 1
fi

install -d -m 0755 "${PREFIX}"
install -m 0755 -o root -g root "${BINARY_SRC}" "${PREFIX}/rcc-node-agent"

install -d -m 0750 -o root -g root "${CONFIG_DIR}"
if [ ! -f "${CONFIG_DIR}/agent.json" ]; then
  install -m 0640 -o root -g root "${SCRIPT_DIR}/agent.example.json" "${CONFIG_DIR}/agent.json"
  echo "wrote ${CONFIG_DIR}/agent.json - edit hostId and keyId before starting"
fi

if [ ! -f "${CONFIG_DIR}/agent.key" ]; then
  install -m 0600 -o root -g root /dev/null "${CONFIG_DIR}/agent.key"
  echo "created empty ${CONFIG_DIR}/agent.key (mode 0600)"
  echo "write the RCC-issued key material into it before starting the service"
fi

install -m 0644 -o root -g root "${SCRIPT_DIR}/rcc-node-agent.service" "${UNIT_DIR}/rcc-node-agent.service"
systemctl daemon-reload

echo
echo "installed. next steps:"
echo "  1. edit ${CONFIG_DIR}/agent.json (hostId, keyId, controlCenterUrl)"
echo "  2. write the issued key into ${CONFIG_DIR}/agent.key (mode 0600, >= 32 bytes)"
echo "  3. ${PREFIX}/rcc-node-agent --config ${CONFIG_DIR}/agent.json --check"
echo "  4. systemctl enable --now rcc-node-agent"
echo
echo "package and kernel maintenance is OFF. it needs two deliberate steps:"
echo "  a. set packagesEnabled and packageAllowlist in ${CONFIG_DIR}/agent.json"
echo "  b. install the sandbox drop-in, which apt cannot run without:"
echo "       install -D -m 0644 ${SCRIPT_DIR}/package-maintenance.conf \\"
echo "         /etc/systemd/system/rcc-node-agent.service.d/package-maintenance.conf"
echo "       systemctl daemon-reload && systemctl restart rcc-node-agent"
echo "     without it apt fails and the operation fails closed, which is the safe default."
echo
echo "SSH protection inventory is read-only and ON by default. setup/ban/unban is OFF."
echo "To enable governed SSH protection, set operationsEnabled + sshBanEnabled and"
echo "list every exact management address in sshBanProtectedAddresses."
echo "Existing Fail2ban ban/unban uses only its fixed sshd jail and AF_UNIX socket."
echo "Installing and activating the fixed RCC Fail2ban baseline additionally needs"
echo "the package-maintenance.conf drop-in shown above, plus policy, an open"
echo "maintenance window, a second administrator and AAL2. The drop-in alone grants"
echo "no SSH authority; without either side the setup operation fails closed."
echo
echo "network, storage and image maintenance are OFF and are three SEPARATE"
echo "authorities. none of them implies another, and each needs its own drop-in:"
echo "  network  networkEnabled + networkAllowlist  -> network-maintenance.conf"
echo "  storage  storageEnabled + storageMountRoots and/or storageGrowAllowlist"
echo "                                              -> storage-maintenance.conf"
echo "  image    osImageEnabled + osImageAllowlist  -> osimage-maintenance.conf"
echo "install one the same way as the package drop-in, for example:"
echo "       install -D -m 0644 ${SCRIPT_DIR}/network-maintenance.conf \\"
echo "         /etc/systemd/system/rcc-node-agent.service.d/network-maintenance.conf"
echo "       systemctl daemon-reload && systemctl restart rcc-node-agent"
echo "     without the matching drop-in the tool fails and the operation fails closed."
echo
echo "reporting is unaffected by all of the above: network, storage and boot-model"
echo "inventory is collected read-only by default, because reporting changes nothing."
