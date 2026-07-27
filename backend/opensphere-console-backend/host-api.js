'use strict';

/**
 * Linux host authority API surface.
 *
 * Two audiences share one route prefix and must never share a credential path:
 *   - the `rcc-node-agent`, which POSTs an HMAC-signed snapshot and holds no
 *     browser session, and
 *   - the Console operator, who holds a Supabase session and never holds agent
 *     key material.
 *
 * Stage 1 is read-only. No route here dispatches work to a host.
 */

const { verifyAgentRequest, createNonceCache, MAX_BODY_BYTES } = require('./agent-signature');
const net = require('net');

const SNAPSHOT_SCHEMA_VERSION = 'rcc.host.snapshot/v1';
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_ROUTE_RE = /^\/api\/control-centers\/([^/]+)\/hosts(?:\/([^/]+))?(\/heartbeat)?$/;

// The linux-host-manager subShell may only reach its own canonical DUPA API
// namespace, so the operator read routes are mounted beneath it as well.
// Agents never use this prefix, and heartbeat is refused on it, so a
// browser-facing path can never become a signed-ingestion path.
const PLUGIN_API_NAMESPACE = '/api/plugins/linux-host-manager';

// Freshness thresholds are expressed against the agent's own collection time so
// a paused agent is reported as stale rather than silently rendered as current.
const STALE_AFTER_SECONDS = 180;
const OFFLINE_AFTER_SECONDS = 600;

const MAX_FILESYSTEMS = 32;
const MAX_INTERFACES = 16;
const MAX_FAILED_UNITS = 25;
// Must equal snapshot.MaxDegradedKeys in the Go agent. A smaller bound here
// would silently drop the collector failures the agent took care to report.
const MAX_DEGRADED_KEYS = 32;
const MAX_STRING = 128;
const MAX_CLOCK_SKEW_SECONDS = 900;

// Bounds for the inventory blocks the agent reports. Every one mirrors a bound
// the agent already applies, so a payload that passed there cannot be truncated
// here, and a payload that did not cannot get through.
const MAX_PENDING_PACKAGES = 100;
const MAX_REBOOT_PACKAGES = 32;
const MAX_RESTART_ALLOWLIST = 64;
const MAX_PACKAGE_ALLOWLIST = 128;
const MAX_LINKS = 32;
const MAX_LINK_ADDRESSES = 8;
const MAX_DNS_SERVERS = 8;
const MAX_SEARCH_DOMAINS = 8;
const MAX_BLOCK_DEVICES = 64;
const MAX_DEPLOYMENTS = 8;
const MAX_STAGE4_ALLOWLIST = 32;
const MAX_SSH_BAN_ADDRESSES = 128;
const MAX_SSH_PROTECTED_ADDRESSES = 64;
const MAX_SSH_BAN_EVENTS = 100;
const SSH_PROTECTION_PROFILE = 'rcc-ssh-baseline-v1';
const SSH_PROTECTION_DRIFT = `${SSH_PROTECTION_PROFILE}-drift`;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const PACKAGE_VERSION_RE = /^([0-9]{1,4}:)?[0-9][A-Za-z0-9.+~-]{0,127}$/;

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

/**
 * Route parser for the operator-facing paths. The agent path is parsed by
 * `agent-signature.parseHeartbeatPath`, which is stricter still.
 */
function parseHostRoute(rawUrl, allowedControlCenters) {
  const url = new URL(String(rawUrl ?? ''), 'http://polyon-rcc.local');
  const viaPlugin = url.pathname.startsWith(`${PLUGIN_API_NAMESPACE}/`);
  const pathname = viaPlugin
    ? `/api${url.pathname.slice(PLUGIN_API_NAMESPACE.length)}`
    : url.pathname;
  const match = HOST_ROUTE_RE.exec(pathname);
  if (!match) return null;

  const [, controlCenterId, hostId, heartbeat] = match;
  if (!DNS_LABEL_RE.test(controlCenterId)) throw { code: 400, msg: 'invalid control center id' };
  if (!allowedControlCenters.has(controlCenterId)) throw { code: 404, msg: 'control center is not configured' };
  if (hostId !== undefined && !DNS_LABEL_RE.test(hostId)) throw { code: 400, msg: 'invalid host id' };

  if (heartbeat) {
    if (viaPlugin) throw { code: 404, msg: 'unknown host route' };
    if (!hostId) throw { code: 404, msg: 'unknown host route' };
    return { kind: 'heartbeat', controlCenterId, hostId };
  }
  return hostId
    ? { kind: 'detail', controlCenterId, hostId, viaPlugin }
    : { kind: 'list', controlCenterId, viaPlugin };
}

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

function boundedString(value, max = MAX_STRING) {
  if (typeof value !== 'string') return '';
  // Control characters would corrupt logs and the manual-facing UI alike.
  return value.replace(CONTROL_CHARS_RE, '').slice(0, max);
}

function boundedInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function boundedFloat(value, { min = 0, max = 100000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.round(n * 100) / 100, min), max);
}

function boundedArray(value, max, mapper) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map(mapper);
}

/**
 * Validates and re-projects an agent snapshot. The stored document is built
 * field by field from an allowlist, so an agent cannot persist unknown keys,
 * unbounded arrays or attacker-chosen JSON into `console.host_snapshot`.
 */
function validateSnapshot(payload, binding, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw { code: 400, msg: 'snapshot body must be a JSON object' };
  }
  if (payload.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw { code: 422, msg: `unsupported snapshot schemaVersion, expected ${SNAPSHOT_SCHEMA_VERSION}` };
  }
  if (payload.controlCenterId !== binding.controlCenterId || payload.hostId !== binding.hostId) {
    throw { code: 422, msg: 'snapshot identity does not match the signed request' };
  }

  const collectedAt = Date.parse(String(payload.collectedAt ?? ''));
  if (!Number.isFinite(collectedAt)) throw { code: 422, msg: 'snapshot collectedAt is not an RFC 3339 timestamp' };
  if (Math.abs(nowMs - collectedAt) > MAX_CLOCK_SKEW_SECONDS * 1000) {
    throw { code: 422, msg: 'snapshot collectedAt is outside the accepted clock skew' };
  }

  const agentVersion = boundedString(payload.agentVersion, 64);
  if (!agentVersion) throw { code: 422, msg: 'snapshot agentVersion is required' };

  const identity = payload.identity && typeof payload.identity === 'object' ? payload.identity : {};
  const resources = payload.resources && typeof payload.resources === 'object' ? payload.resources : {};
  const systemd = payload.systemd && typeof payload.systemd === 'object' ? payload.systemd : {};

  const failedUnits = boundedArray(systemd.failedUnits, MAX_FAILED_UNITS, (unit) => boundedString(unit, 96))
    .filter(Boolean);
  // The agent counts every failed unit but only lists the first MAX_FAILED_UNITS.
  // Trust the larger of the two so an agent cannot under-report the count, and
  // derive truncation from the gap rather than from a full list, which would
  // flag an exactly-full list as incomplete.
  const failedUnitCount = Math.max(
    boundedInt(systemd.failedUnitCount, { max: 100000 }),
    failedUnits.length,
  );

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    controlCenterId: binding.controlCenterId,
    hostId: binding.hostId,
    agentVersion,
    collectedAt: new Date(collectedAt).toISOString(),
    identity: {
      hostname: boundedString(identity.hostname, 253),
      osName: boundedString(identity.osName),
      osId: boundedString(identity.osId, 64),
      osVersionId: boundedString(identity.osVersionId, 64),
      kernelVersion: boundedString(identity.kernelVersion, 96),
      architecture: boundedString(identity.architecture, 32),
      machineIdHash: boundedString(identity.machineIdHash, 96),
      bootIdHash: boundedString(identity.bootIdHash, 96),
      uptimeSeconds: boundedInt(identity.uptimeSeconds),
    },
    resources: {
      cpuCount: boundedInt(resources.cpuCount, { max: 4096 }),
      load1: boundedFloat(resources.load1),
      load5: boundedFloat(resources.load5),
      load15: boundedFloat(resources.load15),
      memTotalBytes: boundedInt(resources.memTotalBytes),
      memAvailableBytes: boundedInt(resources.memAvailableBytes),
      memFreeBytes: boundedInt(resources.memFreeBytes),
      swapTotalBytes: boundedInt(resources.swapTotalBytes),
      swapFreeBytes: boundedInt(resources.swapFreeBytes),
      processCount: boundedInt(resources.processCount, { max: 4194304 }),
      runningProcesses: boundedInt(resources.runningProcesses, { max: 4194304 }),
      blockedOnIoCount: boundedInt(resources.blockedOnIoCount, { max: 4194304 }),
      contextSwitchCount: boundedInt(resources.contextSwitchCount),
    },
    filesystems: boundedArray(payload.filesystems, MAX_FILESYSTEMS, (fs) => ({
      device: boundedString(fs?.device, 96),
      mountPoint: boundedString(fs?.mountPoint, 255),
      fsType: boundedString(fs?.fsType, 32),
      readOnly: fs?.readOnly === true,
      totalBytes: boundedInt(fs?.totalBytes),
      usedBytes: boundedInt(fs?.usedBytes),
      availableBytes: boundedInt(fs?.availableBytes),
      inodesTotal: boundedInt(fs?.inodesTotal),
      inodesUsed: boundedInt(fs?.inodesUsed),
    })).filter((fs) => fs.mountPoint),
    network: boundedArray(payload.network, MAX_INTERFACES, (nic) => ({
      name: boundedString(nic?.name, 32),
      rxBytes: boundedInt(nic?.rxBytes),
      txBytes: boundedInt(nic?.txBytes),
      rxPackets: boundedInt(nic?.rxPackets),
      txPackets: boundedInt(nic?.txPackets),
      rxErrors: boundedInt(nic?.rxErrors),
      txErrors: boundedInt(nic?.txErrors),
      rxDropped: boundedInt(nic?.rxDropped),
      txDropped: boundedInt(nic?.txDropped),
    })).filter((nic) => nic.name),
    systemd: {
      available: systemd.available === true,
      failedUnitCount,
      failedUnits,
      truncated: systemd.truncated === true || failedUnitCount > failedUnits.length,
    },
    // The inventory blocks the console gates its controls on. These have to be
    // re-projected here for the same reason everything else is: the stored
    // document is built field by field from an allowlist, so an agent cannot
    // persist unknown keys or unbounded arrays into console.host_snapshot.
    // Dropping them instead — which is what happened before Stage 4 — silently
    // disabled every capability derived from them, because the console reads
    // the stored payload and not the request body.
    packages: projectPackages(payload.packages),
    kernel: projectKernel(payload.kernel),
    networkState: projectNetworkState(payload.networkState),
    storage: projectStorage(payload.storage),
    boot: projectBoot(payload.boot),
    sshBan: projectSSHBan(payload.sshBan),
    operations: projectOperations(payload.operations),
    degraded: boundedArray(payload.degraded, MAX_DEGRADED_KEYS, (key) => boundedString(key, 48)).filter(Boolean),
  };
}

function projectIPAddress(value) {
  const address = boundedString(value, 64);
  const family = net.isIP(address);
  if (family === 4) return address.split('.').map((part) => String(Number(part))).join('.');
  if (family !== 6) return '';
  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    if (!mapped) return canonical;
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  } catch {
    return '';
  }
}

function projectSSHBan(raw) {
  const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const supported = state.supported === true;
  const active = supported && state.active === true;
  const bannedAddresses = active
    ? [...new Set(
      boundedArray(state.bannedAddresses, MAX_SSH_BAN_ADDRESSES, projectIPAddress).filter(Boolean),
    )].sort()
    : [];
  const currentlyBanned = active
    ? Math.max(boundedInt(state.currentlyBanned, { max: 1000000 }), bannedAddresses.length)
    : 0;
  return {
    provider: boundedString(state.provider, 32) || 'fail2ban',
    jail: boundedString(state.jail, 32) || 'sshd',
    installed: state.installed === true,
    packageVersion: boundedString(state.packageVersion, 128),
    candidateVersion: boundedString(state.candidateVersion, 128),
    protectionProfile: boundedString(state.protectionProfile, 64),
    profileDigest: SHA256_DIGEST_RE.test(String(state.profileDigest || ''))
      ? String(state.profileDigest) : '',
    active,
    supported,
    unsupportedReason: boundedString(state.unsupportedReason, 255),
    currentlyFailed: active ? boundedInt(state.currentlyFailed, { max: 1000000 }) : 0,
    totalFailed: active ? boundedInt(state.totalFailed, { max: Number.MAX_SAFE_INTEGER }) : 0,
    currentlyBanned,
    totalBanned: active ? boundedInt(state.totalBanned, { max: Number.MAX_SAFE_INTEGER }) : 0,
    bannedAddresses,
    banTimeSeconds: active ? boundedInt(state.banTimeSeconds, { min: -1, max: Number.MAX_SAFE_INTEGER }) : 0,
    findTimeSeconds: active ? boundedInt(state.findTimeSeconds, { max: Number.MAX_SAFE_INTEGER }) : 0,
    maxRetry: active ? boundedInt(state.maxRetry, { max: 1000000 }) : 0,
    recentEvents: boundedArray(state.recentEvents, MAX_SSH_BAN_EVENTS, (event) => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
      const action = boundedString(event.action, 16);
      const address = projectIPAddress(event.address);
      const occurred = Date.parse(String(event.occurredAt || ''));
      if (!['found', 'ban', 'unban'].includes(action) || !address || !Number.isFinite(occurred)) {
        return null;
      }
      return {
        occurredAt: new Date(occurred).toISOString(),
        action,
        address,
      };
    }).filter(Boolean),
    truncated: active && (state.truncated === true || currentlyBanned > bannedAddresses.length),
    collectedAt: boundedString(state.collectedAt, 64),
  };
}

/**
 * Package inventory as reported.
 *
 * An unsupported manager is normalised to carry no counts. "We could not read
 * it" and "nothing is pending" are the same number and completely different
 * facts, and only one of them means the host is patched.
 */
function projectPackages(raw) {
  const packages = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const supported = packages.supported === true;
  const age = Number(packages.metadataAgeSeconds);
  return {
    manager: boundedString(packages.manager, 32) || 'unknown',
    supported,
    unsupportedReason: boundedString(packages.unsupportedReason, 255),
    metadataAgeSeconds: Number.isFinite(age) && age >= 0 ? Math.trunc(age) : -1,
    pendingTotal: supported ? boundedInt(packages.pendingTotal, { max: 100000 }) : 0,
    pendingSecurity: supported ? boundedInt(packages.pendingSecurity, { max: 100000 }) : 0,
    pending: supported
      ? boundedArray(packages.pending, MAX_PENDING_PACKAGES, (entry) => ({
        name: boundedString(entry?.name, 128),
        currentVersion: boundedString(entry?.currentVersion, 128),
        candidateVersion: boundedString(entry?.candidateVersion, 128),
        security: entry?.security === true,
        origin: boundedString(entry?.origin, 200),
      })).filter((entry) => entry.name)
      : [],
    truncated: supported && packages.truncated === true,
    collectedAt: boundedString(packages.collectedAt, 64),
  };
}

function projectKernel(raw) {
  const kernel = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    running: boundedString(kernel.running, 128),
    installedLatest: boundedString(kernel.installedLatest, 128),
    candidate: boundedString(kernel.candidate, 128),
    updateAvailable: kernel.updateAvailable === true,
    rebootRequired: kernel.rebootRequired === true,
    rebootRequiredPackages: boundedArray(kernel.rebootRequiredPackages, MAX_REBOOT_PACKAGES,
      (name) => boundedString(name, 128)).filter(Boolean),
    collectedAt: boundedString(kernel.collectedAt, 64),
  };
}

/**
 * Network inventory as reported.
 *
 * Links are kept even when the stack is unsupported, which is the opposite of
 * how packages and block devices are treated, and deliberately so: a host
 * running systemd-networkd is perfectly readable and simply not changeable by
 * this platform, and discarding its links would hide true information. Where
 * the links genuinely could not be read the agent already reports none.
 *
 * Nothing is at risk in keeping them: every Stage 4 capability first requires
 * `supported`, so an unsupported stack can never produce a control however many
 * links it claims.
 */
function projectNetworkState(raw) {
  const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const supported = state.supported === true;
  const route = state.defaultRoute && typeof state.defaultRoute === 'object' ? state.defaultRoute : {};
  const dns = state.dns && typeof state.dns === 'object' ? state.dns : {};
  const defaultRoute = {
    present: route.present === true,
    interface: boundedString(route.interface, 32),
    gateway: boundedString(route.gateway, 64),
    metric: boundedInt(route.metric, { max: 1000000 }),
  };
  const links = boundedArray(state.links, MAX_LINKS, (link) => ({
    name: boundedString(link?.name, 32),
    type: boundedString(link?.type, 32),
    state: boundedString(link?.state, 16),
    mtu: boundedInt(link?.mtu, { max: 65536 }),
    driver: boundedString(link?.driver, 48),
    addresses: boundedArray(link?.addresses, MAX_LINK_ADDRESSES, (a) => boundedString(a, 64)).filter(Boolean),
    staticAddresses: boundedArray(link?.staticAddresses, MAX_LINK_ADDRESSES, (a) => boundedString(a, 64)).filter(Boolean),
    gateway: boundedString(link?.gateway, 64),
    managed: link?.managed === true,
    connection: boundedString(link?.connection, 128),
    method: boundedString(link?.method, 32),
    // Derived here, never trusted: a link cannot claim not to carry the
    // control path in order to become reconfigurable.
    carriesRcc: defaultRoute.present && boundedString(link?.name, 32) === defaultRoute.interface,
    truncated: link?.truncated === true,
  })).filter((link) => link.name);
  return {
    manager: boundedString(state.manager, 32) || 'unknown',
    supported,
    unsupportedReason: boundedString(state.unsupportedReason, 255),
    links,
    defaultRoute,
    dns: {
      source: boundedString(dns.source, 64),
      servers: boundedArray(dns.servers, MAX_DNS_SERVERS, (s) => boundedString(s, 64)).filter(Boolean),
      search: boundedArray(dns.search, MAX_SEARCH_DOMAINS, (s) => boundedString(s, 128)).filter(Boolean),
    },
    managementLink: defaultRoute.present ? defaultRoute.interface : '',
    truncated: state.truncated === true,
    collectedAt: boundedString(state.collectedAt, 64),
  };
}

function projectStorage(raw) {
  const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const supported = state.supported === true;
  return {
    supported,
    unsupportedReason: boundedString(state.unsupportedReason, 255),
    devices: supported
      ? boundedArray(state.devices, MAX_BLOCK_DEVICES, (device) => ({
        name: boundedString(device?.name, 128),
        kind: boundedString(device?.kind, 32),
        parent: boundedString(device?.parent, 128),
        sizeBytes: boundedInt(device?.sizeBytes),
        fsType: boundedString(device?.fsType, 32),
        uuid: boundedString(device?.uuid, 64),
        mountPoint: boundedString(device?.mountPoint, 255),
        readOnly: device?.readOnly === true,
        removable: device?.removable === true,
        rotational: device?.rotational === true,
        model: boundedString(device?.model, 64),
        protected: device?.protected === true,
      })).filter((device) => device.name)
      : [],
    capacity: supported
      ? boundedArray(state.capacity, MAX_FILESYSTEMS, (entry) => {
        const isProtected = entry?.protected === true;
        return {
          mountPoint: boundedString(entry?.mountPoint, 255),
          device: boundedString(entry?.device, 128),
          fsType: boundedString(entry?.fsType, 32),
          // A protected filesystem is never growable, whatever the agent said.
          growable: entry?.growable === true && !isProtected,
          protected: isProtected,
          sizeBytes: boundedInt(entry?.sizeBytes),
          deviceBytes: boundedInt(entry?.deviceBytes),
          headroomBytes: boundedInt(entry?.headroomBytes),
          reason: boundedString(entry?.reason, 255),
        };
      }).filter((entry) => entry.mountPoint)
      : [],
    truncated: supported && state.truncated === true,
    collectedAt: boundedString(state.collectedAt, 64),
  };
}

function projectDeployment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    id: boundedString(raw.id, 128),
    version: boundedString(raw.version, 128),
    digest: boundedString(raw.digest, 96),
    origin: boundedString(raw.origin, 255),
    booted: raw.booted === true,
    staged: raw.staged === true,
    rollback: raw.rollback === true,
    pinned: raw.pinned === true,
  };
}

/**
 * Boot model as reported.
 *
 * A host that cannot take an image update is normalised to have nothing staged
 * and nothing to roll back to. Otherwise a mutable host would present a
 * rollback control that its agent would refuse.
 */
function projectBoot(raw) {
  const boot = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const supported = boot.supported === true;
  const canRollback = supported && boot.canRollback === true;
  return {
    model: boundedString(boot.model, 32) || 'unknown',
    adapter: boundedString(boot.adapter, 32),
    supported,
    unsupportedReason: boundedString(boot.unsupportedReason, 255),
    canStage: supported && boot.canStage === true,
    canRollback,
    rollbackAvailable: canRollback && boot.rollbackAvailable === true,
    booted: projectDeployment(boot.booted),
    staged: supported ? projectDeployment(boot.staged) : null,
    deployments: supported
      ? boundedArray(boot.deployments, MAX_DEPLOYMENTS, projectDeployment).filter(Boolean)
      : [],
    collectedAt: boundedString(boot.collectedAt, 64),
  };
}

/**
 * What the agent says it will accept.
 *
 * This is advisory. Every capability the console derives from it is intersected
 * with an authority the control center granted, so an agent reporting a longer
 * list cannot populate the console with controls nobody granted.
 */
function projectOperations(raw) {
  const operations = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = operations.enabled === true;
  const list = (value, limit, max) => boundedArray(value, limit, (entry) => boundedString(entry, max)).filter(Boolean);
  return {
    enabled,
    restartAllowlist: list(operations.restartAllowlist, MAX_RESTART_ALLOWLIST, 128),
    packageAllowlist: list(operations.packageAllowlist, MAX_PACKAGE_ALLOWLIST, 128),
    packagesEnabled: enabled && operations.packagesEnabled === true,
    networkEnabled: enabled && operations.networkEnabled === true,
    networkAllowlist: list(operations.networkAllowlist, MAX_STAGE4_ALLOWLIST, 128),
    storageEnabled: enabled && operations.storageEnabled === true,
    mountRoots: list(operations.mountRoots, MAX_STAGE4_ALLOWLIST, 255),
    growAllowlist: list(operations.growAllowlist, MAX_STAGE4_ALLOWLIST, 255),
    osImageEnabled: enabled && operations.osImageEnabled === true,
    imageAllowlist: list(operations.imageAllowlist, MAX_STAGE4_ALLOWLIST, 255),
    sshBanEnabled: enabled && operations.sshBanEnabled === true,
    sshProtectedAddresses: [...new Set(list(
      operations.sshProtectedAddresses,
      MAX_SSH_PROTECTED_ADDRESSES,
      64,
    ).map(projectIPAddress).filter(Boolean))].sort(),
  };
}

/**
 * Freshness is derived, never trusted from the payload.
 *
 * Graded on whichever of the two timestamps makes the snapshot look older. The
 * agent's collection time is the one that matters, but a host whose clock runs
 * fast reports a future collectedAt: clamped to age zero, that host would keep
 * reading `fresh` for as long as its skew lasts after it had already died. The
 * server's own receipt time cannot run ahead of us, so taking the larger age
 * closes that window without ever making a slow host look fresher than it is.
 */
function snapshotFreshness(collectedAt, nowMs = Date.now(), receivedAt = null) {
  const parsed = Date.parse(String(collectedAt ?? ''));
  if (!Number.isFinite(parsed)) return { state: 'unknown', ageSeconds: null };
  const received = Date.parse(String(receivedAt ?? ''));
  const ageSeconds = Math.max(
    0,
    Math.round((nowMs - parsed) / 1000),
    Number.isFinite(received) ? Math.round((nowMs - received) / 1000) : 0,
  );
  if (ageSeconds > OFFLINE_AFTER_SECONDS) return { state: 'offline', ageSeconds };
  if (ageSeconds > STALE_AFTER_SECONDS) return { state: 'stale', ageSeconds };
  return { state: 'fresh', ageSeconds };
}

function snapshotOf(row) {
  const snapshot = Array.isArray(row?.host_snapshot) ? row.host_snapshot[0] : row?.host_snapshot;
  return snapshot && typeof snapshot === 'object' ? snapshot : null;
}

/**
 * Fleet-list projection. A host that has never reported is reported as
 * `never-reported`, which is materially different from "healthy with no data".
 */
function toHostSummary(row, nowMs = Date.now()) {
  const snapshot = snapshotOf(row);
  const payload = snapshot?.payload ?? null;
  const freshness = snapshot
    ? snapshotFreshness(snapshot.collected_at, nowMs, snapshot.received_at)
    : { state: 'never-reported', ageSeconds: null };
  return {
    hostId: row?.host_id ?? null,
    displayName: row?.display_name ?? null,
    controlCenterId: row?.control_center_id ?? null,
    status: row?.status ?? 'pending',
    labels: row?.labels && typeof row.labels === 'object' ? row.labels : {},
    reportState: freshness.state,
    snapshotAgeSeconds: freshness.ageSeconds,
    collectedAt: snapshot?.collected_at ?? null,
    agentVersion: snapshot?.agent_version ?? null,
    hostname: payload?.identity?.hostname ?? null,
    osName: payload?.identity?.osName ?? null,
    kernelVersion: payload?.identity?.kernelVersion ?? null,
    uptimeSeconds: payload?.identity?.uptimeSeconds ?? null,
    load1: payload?.resources?.load1 ?? null,
    cpuCount: payload?.resources?.cpuCount ?? null,
    memTotalBytes: payload?.resources?.memTotalBytes ?? null,
    memAvailableBytes: payload?.resources?.memAvailableBytes ?? null,
    failedUnitCount: payload?.systemd?.available ? (payload.systemd.failedUnitCount ?? 0) : null,
    degradedCount: Array.isArray(payload?.degraded) ? payload.degraded.length : 0,
    // The keys themselves, not just how many. The subShell header names the
    // failing collectors, and without this field it silently named none: a host
    // whose root filesystem or systemd state could not be read looked identical
    // to one that reported cleanly.
    degradedKeys: Array.isArray(payload?.degraded) ? payload.degraded : [],
  };
}

/**
 * Which typed operations this host can actually run right now.
 *
 * `supported` reflects the deployment (is the control center governed-write,
 * does the host allowlist anything). `permitted` reflects the caller. Both are
 * reported with a reason so the UI never has to guess why a control is off.
 */
function capabilitiesFor(row, options = {}) {
  const governed = options.hostControlMode === 'governed-write';
  const permissions = options.permissions instanceof Set ? options.permissions : new Set();
  // Authority comes from the enrolment, not from the host. A host reporting a
  // longer list is reporting what its own agent would accept; presenting that
  // as a set of available actions would let a misconfigured or compromised
  // agent populate the console with buttons nobody granted.
  const allowlist = Array.isArray(row?.restart_allowlist) ? row.restart_allowlist : [];
  const snapshot = row?.host_snapshot?.payload;
  const reported = Array.isArray(snapshot?.operations?.restartAllowlist)
    ? snapshot.operations.restartAllowlist
    : [];
  // Both sides must permit a unit. Where they disagree, the operator is told,
  // because the difference is either a stale agent or a configuration mistake.
  const effective = allowlist.filter((unit) => reported.includes(unit));
  const onlyGranted = allowlist.filter((unit) => !reported.includes(unit));
  const onlyReported = reported.filter((unit) => !allowlist.includes(unit));

  const gate = (permission, supported, supportedReason) => ({
    supported,
    reason: supported ? '' : supportedReason,
    permitted: permissions.has(permission),
    ...(permissions.has(permission) ? {} : { reason: supported ? `requires ${permission}` : supportedReason }),
  });

  const readOnly = 'this control center is in read-only host_control_mode';
  const restartReason = !governed
    ? readOnly
    : (allowlist.length === 0
      ? 'this control center has granted no restart allowlist for this host'
      : 'the agent does not report any of the units this control center allows');

  return {
    'journal.query': gate('console.hosts.journal', governed, readOnly),
    'service.restart': {
      ...gate('console.hosts.operate', governed && effective.length > 0, restartReason),
      allowlist: effective,
      granted: allowlist,
      reported,
      drift: { onlyGranted, onlyReported },
    },
    'host.reboot': gate('console.hosts.operate', governed, readOnly),
    // Stage 3. Package work needs three things to line up: the region must be
    // in governed-write mode, the host's agent must actually drive a package
    // manager it supports, and a maintenance policy must permit the operation.
    // Each is reported separately so a disabled control says which one is
    // missing rather than just being off.
    ...packageCapabilities(row, { governed, gate, readOnly, options }),
    // Stage 4. Same three-way test as package work — region mode, what the
    // host's agent actually supports and was given, and what the policy
    // permits — with one addition: these operations name a target, so the
    // policy must also permit the target, not merely the verb.
    ...stage4Capabilities(row, { governed, gate, readOnly, options }),
    ...sshBanCapabilities(row, { governed, gate, readOnly, options }),
    // Deciding an existing request. These are separate from requesting work:
    // an operator who may ask for a restart may not be allowed to approve one.
    approve: gate('console.hosts.approve', governed, readOnly),
    reject: gate('console.hosts.approve', governed, readOnly),
    cancel: {
      supported: governed,
      reason: governed ? '' : readOnly,
      permitted: permissions.has('console.hosts.operate') || permissions.has('console.hosts.approve'),
      ...(permissions.has('console.hosts.operate') || permissions.has('console.hosts.approve')
        ? {} : { reason: governed ? 'requires console.hosts.operate' : readOnly }),
    },
  };
}

function sshBanCapabilities(row, { governed, gate, readOnly, options }) {
  const snapshot = row?.host_snapshot?.payload;
  const state = snapshot?.sshBan || {};
  const enabled = snapshot?.operations?.sshBanEnabled === true;
  const protectedAddresses = Array.isArray(snapshot?.operations?.sshProtectedAddresses)
    ? snapshot.operations.sshProtectedAddresses : [];
  const policy = options.policy || null;
  const profile = String(state.protectionProfile || '');
  const packageVersion = String(
    state.installed === true ? (state.packageVersion || '') : (state.candidateVersion || ''),
  );

  let enableReason = '';
  if (!governed) enableReason = readOnly;
  else if (!enabled) enableReason = 'the agent on this host has not enabled SSH protection operations';
  else if (protectedAddresses.length === 0) {
    enableReason = 'the host has no protected management address';
  } else if (!PACKAGE_VERSION_RE.test(packageVersion)) {
    enableReason = state.installed === true
      ? 'the host reports no exact installed Fail2ban version'
      : 'the host reports no exact installable Fail2ban candidate version';
  } else if (profile === 'external') {
    enableReason = 'the fixed RCC profile path contains external policy and will not be overwritten';
  } else if (state.active === true && profile === SSH_PROTECTION_PROFILE) {
    enableReason = 'the active Fail2ban sshd jail already matches the RCC protection baseline';
  } else if (state.active === true && profile !== SSH_PROTECTION_DRIFT) {
    enableReason = 'the active Fail2ban sshd jail is not owned by the RCC protection baseline';
  } else if (!policy) {
    enableReason = 'this host has no maintenance policy, so SSH protection setup is refused';
  } else if (!Array.isArray(policy.allowedOperations)
      || !policy.allowedOperations.includes('ssh.protection.enable')) {
    enableReason = `the maintenance policy "${policy.name}" does not permit ssh.protection.enable`;
  } else if (policy.inWindow !== true) {
    enableReason = `the maintenance policy "${policy.name}" has no open window`;
  }

  let banReason = '';
  if (!governed) banReason = readOnly;
  else if (state.supported !== true || state.active !== true) {
    banReason = state.unsupportedReason || 'this host does not report an active Fail2ban sshd jail';
  } else if (!enabled) {
    banReason = 'the agent on this host has not been given SSH ban operations';
  }
  const build = (operation) => ({
    ...gate('console.hosts.ssh-ban', banReason === '', banReason),
    operation,
  });
  return {
    'ssh.protection.enable': {
      ...gate('console.hosts.ssh-ban', enableReason === '', enableReason),
      operation: 'ssh.protection.enable',
    },
    'ssh.ban': build('ssh.ban'),
    'ssh.unban': build('ssh.unban'),
  };
}

/**
 * Whether this host can be asked to do package or kernel work at all.
 *
 * The agent's own report decides support: it knows which package manager is
 * present and whether it was configured to act on one. A control center cannot
 * grant a capability the host does not have.
 */
function packageCapabilities(row, { governed, gate, readOnly, options }) {
  const snapshot = row?.host_snapshot?.payload;
  const packages = snapshot?.packages || {};
  const agentEnabled = snapshot?.operations?.packagesEnabled === true;
  const policy = options.policy || null;

  const supportReason = () => {
    if (!governed) return readOnly;
    if (packages.supported !== true) {
      return packages.unsupportedReason
        || 'this host reports no package manager this agent can drive';
    }
    if (!agentEnabled) {
      return 'the agent on this host has not been given package operations';
    }
    if (!policy) {
      return 'this host has no maintenance policy, so package and kernel work is refused';
    }
    return '';
  };

  const build = (operation) => {
    let reason = supportReason();
    if (!reason && Array.isArray(policy.allowedOperations)
      && !policy.allowedOperations.includes(operation)) {
      reason = `the maintenance policy "${policy.name}" does not permit ${operation}`;
    }
    return { ...gate('console.hosts.packages', reason === '', reason), operation };
  };

  return {
    'package.refresh': build('package.refresh'),
    'package.update': build('package.update'),
    'kernel.update': build('kernel.update'),
  };
}

/**
 * Whether this host can be asked to do network, storage or image work.
 *
 * Each operation is reported with the first reason it is unavailable, in the
 * order an operator would check them: is this region allowed to write at all,
 * does the host support it, was the agent given the authority, is there a
 * policy, does the policy permit this operation, and does the policy permit any
 * target for it. Reporting only "unavailable" would leave someone guessing
 * which of six things to fix.
 */
function stage4Capabilities(row, { governed, gate, readOnly, options }) {
  const snapshot = row?.host_snapshot?.payload;
  const operations = snapshot?.operations || {};
  const policy = options.policy || null;

  const build = (operation, permission, subsystem) => {
    let reason = '';
    if (!governed) {
      reason = readOnly;
    } else if (!subsystem.supported) {
      reason = subsystem.unsupportedReason
        || `this host does not report a ${subsystem.label} this agent can drive`;
    } else if (!subsystem.agentEnabled) {
      reason = `the agent on this host has not been given ${subsystem.label} operations`;
    } else if (subsystem.extraReason) {
      reason = subsystem.extraReason;
    } else if (!policy) {
      reason = 'this host has no maintenance policy, so this work is refused';
    } else if (!Array.isArray(policy.allowedOperations) || !policy.allowedOperations.includes(operation)) {
      reason = `the maintenance policy "${policy.name}" does not permit ${operation}`;
    } else if (subsystem.policyTargets && subsystem.policyTargets(policy) === false) {
      reason = subsystem.policyTargetReason(policy);
    }
    return { ...gate(permission, reason === '', reason), operation };
  };

  const network = {
    label: 'network',
    supported: snapshot?.networkState?.supported === true,
    unsupportedReason: snapshot?.networkState?.unsupportedReason,
    agentEnabled: operations.networkEnabled === true,
    // A host whose only link is the one carrying the default route has nothing
    // this platform will reconfigure, and saying so beats a control that is
    // refused on click.
    extraReason: reconfigurableLinkCount(snapshot) === 0
      ? 'every link on this host carries the default route to this control center, which is never reconfigured'
      : '',
  };
  const storage = {
    label: 'storage',
    supported: snapshot?.storage?.supported === true,
    unsupportedReason: snapshot?.storage?.unsupportedReason,
    agentEnabled: operations.storageEnabled === true,
  };
  const image = {
    label: 'operating system image',
    supported: snapshot?.boot?.supported === true,
    unsupportedReason: snapshot?.boot?.unsupportedReason,
    agentEnabled: operations.osImageEnabled === true,
  };

  return {
    'network.configure': build('network.configure', 'console.hosts.network', network),
    'mount.configure': build('mount.configure', 'console.hosts.storage', {
      ...storage,
      policyTargets: (p) => Array.isArray(p.allowedMountRoots) && p.allowedMountRoots.length > 0,
      policyTargetReason: (p) => `the maintenance policy "${p.name}" declares no mount roots, so no mount point may be created`,
    }),
    'filesystem.grow': build('filesystem.grow', 'console.hosts.storage', {
      ...storage,
      extraReason: growableCount(snapshot) === 0
        ? 'no filesystem on this host can be grown: either none is ext4 or xfs, or none has a block device larger than itself'
        : '',
    }),
    'osimage.stage': build('osimage.stage', 'console.hosts.osimage', {
      ...image,
      extraReason: snapshot?.boot?.canStage === true ? '' : 'the image adapter on this host does not expose a staging command',
      policyTargets: (p) => Array.isArray(p.allowedImages) && p.allowedImages.length > 0,
      policyTargetReason: (p) => `the maintenance policy "${p.name}" allowlists no image, so nothing may be staged`,
    }),
    'osimage.rollback': build('osimage.rollback', 'console.hosts.osimage', {
      ...image,
      extraReason: snapshot?.boot?.rollbackAvailable === true
        ? '' : 'this host has no previous deployment to roll back to',
    }),
  };
}

/** Links this platform would be willing to reconfigure. */
function reconfigurableLinkCount(snapshot) {
  const links = Array.isArray(snapshot?.networkState?.links) ? snapshot.networkState.links : [];
  return links.filter((link) => link.managed === true && link.carriesRcc !== true
    && link.type !== 'loopback' && link.connection).length;
}

function growableCount(snapshot) {
  const capacity = Array.isArray(snapshot?.storage?.capacity) ? snapshot.storage.capacity : [];
  return capacity.filter((entry) => entry.growable === true).length;
}

/**
 * The maintenance policy governing a host, projected for the console.
 *
 * The resolution itself is a database function, because precedence and the
 * timezone arithmetic belong where the zone database is. A null here means no
 * policy, which is a refusal rather than a permission.
 */
async function resolveHostPolicy(restRequest, row, nowMs) {
  if (!row?.id) return null;
  const ids = await restRequest('rpc/host_effective_policy', {
    method: 'POST',
    body: { p_host_uuid: row.id },
  });
  const policyId = Array.isArray(ids) ? ids[0] : ids;
  if (!policyId) return null;

  const policies = await restRequest('host_policy', {
    query: [
      `id=eq.${encodeURIComponent(policyId)}`,
      'select=id,name,scope,version,timezone,allowed_operations,allowed_images,allowed_mount_roots,emergency_allowed,enabled',
      'limit=1',
    ].join('&'),
  });
  const policy = Array.isArray(policies) && policies[0] ? policies[0] : null;
  if (!policy) return null;

  const windows = await restRequest('host_maintenance_window', {
    query: [
      `policy_id=eq.${encodeURIComponent(policyId)}`,
      'select=id,day_of_week,start_time,duration_minutes,enabled',
      'order=day_of_week.asc,start_time.asc',
      'limit=64',
    ].join('&'),
  });
  const current = await restRequest('rpc/host_policy_window_at', {
    method: 'POST',
    body: { p_policy_id: policyId, p_at: new Date(nowMs).toISOString() },
  });
  const openWindow = Array.isArray(current) && current[0] ? current[0] : null;

  return {
    id: policy.id,
    name: policy.name,
    scope: policy.scope,
    version: policy.version,
    timezone: policy.timezone,
    allowedOperations: Array.isArray(policy.allowed_operations) ? policy.allowed_operations : [],
    // Stage 4 operations name a target, so the policy governs the target too.
    // Permitting osimage.stage without naming images would permit any image.
    allowedImages: Array.isArray(policy.allowed_images) ? policy.allowed_images : [],
    allowedMountRoots: Array.isArray(policy.allowed_mount_roots) ? policy.allowed_mount_roots : [],
    emergencyAllowed: policy.emergency_allowed === true,
    enabled: policy.enabled !== false,
    windows: (Array.isArray(windows) ? windows : []).map((entry) => ({
      id: entry.id,
      dayOfWeek: entry.day_of_week,
      startTime: entry.start_time,
      durationMinutes: entry.duration_minutes,
      enabled: entry.enabled !== false,
    })),
    // Whether a window is open right now, and until when. This is the single
    // fact an operator most needs before asking for maintenance.
    inWindow: Boolean(openWindow),
    windowEndsAt: openWindow?.window_end || null,
  };
}

function toHostDetail(row, nowMs = Date.now(), options = {}) {
  const snapshot = snapshotOf(row);
  const payload = snapshot?.payload ?? null;
  const operations = capabilitiesFor(row, options);
  // A section is "supported" when at least one operation in it could be run
  // here. Deriving it from the operation gates rather than declaring it means
  // the tab header and the controls inside it can never disagree.
  const section = (names, fallback) => {
    const supported = names.some((name) => operations[name]?.supported === true);
    if (supported) return { supported: true, reason: '' };
    const first = names.map((name) => operations[name]?.reason).find(Boolean);
    return { supported: false, reason: first || fallback };
  };
  return {
    ...toHostSummary(row, nowMs),
    enrolledAt: row?.enrolled_at ?? null,
    receivedAt: snapshot?.received_at ?? null,
    schemaVersion: snapshot?.schema_version ?? null,
    // The UI gates every control on these, so a host whose control center is
    // still read-only, or an operator without the permission, sees a disabled
    // control with the reason rather than a button that fails on click.
    capabilities: {
      readSnapshot: true,
      services: { supported: true, reason: '' },
      journal: { supported: true, reason: '' },
      network: section(['network.configure'], 'network changes are not available on this host'),
      storage: section(['mount.configure', 'filesystem.grow'], 'storage changes are not available on this host'),
      updates: section(['package.update', 'kernel.update'], 'package updates are not available on this host'),
      osimage: section(['osimage.stage', 'osimage.rollback'], 'image operations are not available on this host'),
      sshBan: section(
        ['ssh.protection.enable', 'ssh.ban', 'ssh.unban'],
        'SSH protection is not available on this host',
      ),
      operations,
    },
    // What the platform knows about this host, and the rules that govern acting
    // on it. Every one of these is a read-only projection.
    packages: payload?.packages ?? null,
    kernel: payload?.kernel ?? null,
    networkState: payload?.networkState ?? null,
    storage: payload?.storage ?? null,
    boot: payload?.boot ?? null,
    sshBan: payload?.sshBan ?? null,
    policy: options.policy ?? null,
    snapshot: payload,
  };
}

// The most hosts one list response will ever carry. Reads are bounded because
// an unbounded fleet query is a way to make the console slow from the outside.
const HOST_LIST_LIMIT = 200;

// The two modes the control center may be in, resolved fail-closed.
//
// Anything absent, unknown, or not exactly 'governed-write' is reported as
// read-only. The value reaches us from the database, which constrains it, but a
// projection that echoes whatever it is handed would turn a schema drift into a
// claim that a region accepts writes.
function controlModeOf(row) {
  return row?.control_center?.host_control_mode === 'governed-write'
    ? 'governed-write'
    : 'read-only';
}

// `agent_key_id` is an identifier used for host binding, never key material.
// It is read server-side only and is not projected into any response body.
const HOST_SELECT = 'id,host_id,display_name,control_center_id,status,labels,enrolled_at,agent_key_id,restart_allowlist,'
  + 'host_snapshot(schema_version,agent_version,collected_at,received_at,payload),'
  + 'control_center(host_control_mode)';

/**
 * @param {object} deps
 * @param {Function} deps.restRequest PostgREST accessor bound to the backend role
 * @param {Function} deps.verifyReader resolves an operator assigned to the control center
 * @param {Function} deps.audit append-only audit sink
 * @param {Set<string>} deps.allowedControlCenters
 * @param {(keyId: string) => object|null} [deps.resolveAgentKey] absent means agent ingestion is unconfigured
 * @param {Function} [deps.readRawBody]
 * @param {() => number} [deps.now]
 */
function createHostApi({
  restRequest,
  verifyReader,
  audit,
  allowedControlCenters: allowedInput,
  resolveAgentKey,
  readRawBody,
  nonceCache = createNonceCache(),
  now = () => Date.now(),
}) {
  const allowedControlCenters = new Set(allowedInput || ['cc2']);
  async function loadHost(controlCenterId, hostId) {
    const rows = await restRequest('host', {
      query: [
        `control_center_id=eq.${encodeURIComponent(controlCenterId)}`,
        `host_id=eq.${encodeURIComponent(hostId)}`,
        `select=${HOST_SELECT}`,
      ].join('&'),
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  async function handleHeartbeat(req, res, route) {
    const nowMs = now();
    let verified;
    let raw;
    try {
      raw = await readRawBody(req, MAX_BODY_BYTES);
      verified = verifyAgentRequest({
        req,
        body: raw,
        resolveKey: resolveAgentKey,
        allowedControlCenters,
        nonceCache,
        nowSeconds: Math.floor(nowMs / 1000),
      });
    } catch (error) {
      // Deliberately terse: an unauthenticated caller learns nothing about which
      // key ids exist, which hosts are enrolled, or how far off its clock is.
      return sendJson(res, error?.code || 401, { error: error?.msg || 'agent request rejected' });
    }

    let snapshot;
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      snapshot = validateSnapshot(parsed, route, nowMs);
    } catch (error) {
      return sendJson(res, error?.code || 400, { error: error?.msg || 'snapshot body is not valid JSON' });
    }

    let host;
    try {
      host = await loadHost(route.controlCenterId, route.hostId);
    } catch {
      return sendJson(res, 503, { error: 'host authority is unavailable' });
    }
    if (!host || host.status === 'retired') return sendJson(res, 404, { error: 'host is not enrolled' });
    if (host.agent_key_id !== verified.keyId) {
      return sendJson(res, 401, { error: 'agent key is not bound to this host' });
    }

    try {
      await restRequest('host_snapshot', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: [{
          host_uuid: host.id,
          schema_version: snapshot.schemaVersion,
          agent_version: snapshot.agentVersion,
          agent_key_id: verified.keyId,
          collected_at: snapshot.collectedAt,
          received_at: new Date(nowMs).toISOString(),
          payload_digest: `sha256:${verified.bodySha256}`,
          payload: snapshot,
        }],
      });
    } catch {
      return sendJson(res, 503, { error: 'snapshot could not be recorded' });
    }

    if (host.status === 'pending') {
      try {
        await restRequest('host', {
          method: 'PATCH',
          query: `id=eq.${encodeURIComponent(host.id)}`,
          prefer: 'return=minimal',
          body: { status: 'active', updated_at: new Date(nowMs).toISOString() },
        });
      } catch { /* first-contact promotion is best effort; the snapshot is already durable */ }
    }

    // No cadence directive is returned. Reporting interval is host-local
    // configuration; a control center that could retune the agent would be a
    // control channel into the host, which Stage 1 does not have.
    return sendJson(res, 202, {
      accepted: true,
      hostId: route.hostId,
      controlCenterId: route.controlCenterId,
      receivedAt: new Date(nowMs).toISOString(),
    });
  }

  async function handleList(req, res, route) {
    const actor = await verifyReader(req, route.controlCenterId);
    let rows;
    try {
      rows = await restRequest('host', {
        query: [
          `control_center_id=eq.${encodeURIComponent(route.controlCenterId)}`,
          'status=in.(pending,active)',
          `select=${HOST_SELECT}`,
          'order=host_id.asc',
          // One more row than is ever reported, so a full page can be told
          // apart from a region that simply holds this many hosts. Asking for
          // exactly the bound returns a complete-looking list either way.
          `limit=${HOST_LIST_LIMIT + 1}`,
        ].join('&'),
      });
    } catch {
      throw { code: 503, msg: 'host authority is unavailable' };
    }
    const nowMs = now();
    const found = Array.isArray(rows) ? rows : [];
    const truncated = found.length > HOST_LIST_LIMIT;
    const items = found.slice(0, HOST_LIST_LIMIT).map((row) => toHostSummary(row, nowMs));
    await audit(actor, {
      action: 'rcc.host.list',
      controlCenterId: route.controlCenterId,
      target: route.controlCenterId,
      count: items.length,
      truncated,
    });
    return sendJson(res, 200, {
      controlCenterId: route.controlCenterId,
      hostControlMode: controlModeOf(found[0]),
      generatedAt: new Date(nowMs).toISOString(),
      // A list that stops at the bound and does not say so is read as the whole
      // fleet. The count beside it would be the bound, not the truth.
      truncated,
      limit: HOST_LIST_LIMIT,
      items,
    });
  }

  async function handleDetail(req, res, route) {
    const actor = await verifyReader(req, route.controlCenterId);
    let row;
    try {
      row = await loadHost(route.controlCenterId, route.hostId);
    } catch {
      throw { code: 503, msg: 'host authority is unavailable' };
    }
    // Retirement removes a host from the fleet list and refuses its heartbeat.
    // The detail route has to agree, or a decommissioned host stays fully
    // readable by direct id and its last snapshot keeps being presented as
    // current state for something that is no longer part of the region.
    if (!row || row.status === 'retired') throw { code: 404, msg: 'host not found' };
    const nowMs = now();
    await audit(actor, {
      action: 'rcc.host.read',
      controlCenterId: route.controlCenterId,
      target: `${route.controlCenterId}:${route.hostId}`,
    });
    return sendJson(res, 200, {
      // The same value the capabilities below are derived from. A fixed
      // 'read-only' here contradicted its own body the moment a region was
      // moved to governed-write: the header said no writes were possible while
      // the operations beside it reported themselves supported.
      hostControlMode: controlModeOf(row),
      generatedAt: new Date(nowMs).toISOString(),
      host: toHostDetail(row, nowMs, {
        hostControlMode: controlModeOf(row),
        permissions: new Set(Array.isArray(actor?.permissions) ? actor.permissions : []),
        policy: await resolveHostPolicy(restRequest, row, nowMs).catch(() => null),
      }),
    });
  }

  /**
   * Returns false when the URL is not a host route, so the caller can fall
   * through to the existing control-center routing without behaviour change.
   */
  async function handle(req, res) {
    let route;
    try {
      route = parseHostRoute(req.url, allowedControlCenters);
    } catch (error) {
      sendJson(res, error?.code || 400, { error: error?.msg || 'invalid host route' });
      return true;
    }
    if (!route) return false;

    if (route.kind === 'heartbeat') {
      if (typeof resolveAgentKey !== 'function') {
        sendJson(res, 503, { error: 'agent key material is not configured' });
        return true;
      }
      await handleHeartbeat(req, res, route);
      return true;
    }

    const method = String(req.method || '').toUpperCase();
    if (method !== 'GET') {
      // Stage 1 has no host mutation surface at all.
      sendJson(res, 405, { error: 'host control actions are not available in this stage' });
      return true;
    }

    try {
      if (route.kind === 'list') await handleList(req, res, route);
      else await handleDetail(req, res, route);
    } catch (error) {
      sendJson(res, error?.code || 500, { error: error?.msg || 'host request failed' });
    }
    return true;
  }

  return { handle, parseHostRoute: (url) => parseHostRoute(url, allowedControlCenters) };
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  PLUGIN_API_NAMESPACE,
  STALE_AFTER_SECONDS,
  OFFLINE_AFTER_SECONDS,
  parseHostRoute,
  validateSnapshot,
  snapshotFreshness,
  toHostSummary,
  toHostDetail,
  createHostApi,
};
