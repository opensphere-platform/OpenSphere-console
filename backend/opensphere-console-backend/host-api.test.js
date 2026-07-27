'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  SNAPSHOT_SCHEMA_VERSION,
  PLUGIN_API_NAMESPACE,
  parseHostRoute,
  validateSnapshot,
  snapshotFreshness,
  toHostSummary,
  toHostDetail,
  createHostApi,
} = require('./host-api');
const {
  sign,
  bodyDigest,
  createNonceCache,
  HEADER_KEY_ID,
  HEADER_TIMESTAMP,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_CONTROL_CENTER,
  HEADER_HOST,
  HEADER_AGENT_VERSION,
} = require('./agent-signature');

const ALLOWED = new Set(['cc2']);
const SECRET = Buffer.from('f1e2d3c4b5a697887766554433221100', 'utf8');
const KEY_ID = 'cc2-node-a-2026a';
const HOST_UUID = '2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f';
const NOW_MS = Date.parse('2026-03-26T00:00:00.000Z');

function goodSnapshot(overrides = {}) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    controlCenterId: 'cc2',
    hostId: 'node-a',
    agentVersion: '0.1.0-cc2',
    collectedAt: new Date(NOW_MS - 5000).toISOString(),
    identity: {
      hostname: 'node-a.cc2.opl.io.kr',
      osName: 'Rocky Linux 9.5 (Blue Onyx)',
      osId: 'rocky',
      osVersionId: '9.5',
      kernelVersion: '5.14.0-503.el9.x86_64',
      architecture: 'amd64',
      machineIdHash: 'sha256:6f1b2c3d4e5f6071',
      bootIdHash: 'sha256:aabbccddeeff0011',
      uptimeSeconds: 864000,
    },
    resources: {
      cpuCount: 16,
      load1: 1.25,
      load5: 1.1,
      load15: 0.98,
      memTotalBytes: 67430359040,
      memAvailableBytes: 41231234560,
      memFreeBytes: 12312345600,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
      processCount: 512,
      runningProcesses: 3,
      blockedOnIoCount: 0,
      contextSwitchCount: 998877,
    },
    filesystems: [
      { device: '/dev/mapper/rl-root', mountPoint: '/', fsType: 'xfs', readOnly: false, totalBytes: 107374182400, usedBytes: 42949672960, availableBytes: 64424509440, inodesTotal: 52428800, inodesUsed: 812345 },
    ],
    network: [
      { name: 'ens192', rxBytes: 91234567890, txBytes: 51234567890, rxPackets: 1234567, txPackets: 987654, rxErrors: 0, txErrors: 0, rxDropped: 2, txDropped: 0 },
    ],
    systemd: { available: true, failedUnitCount: 1, failedUnits: ['chronyd.service'], truncated: false },
    degraded: [],
    ...overrides,
  };
}

function signedHeartbeat(bodyString, overrides = {}) {
  const path = '/api/control-centers/cc2/hosts/node-a/heartbeat';
  const timestamp = String(Math.floor(NOW_MS / 1000));
  const nonce = '0123456789abcdef0123456789abcdef';
  const signed = {
    method: 'POST',
    path,
    keyId: KEY_ID,
    timestamp,
    nonce,
    controlCenterId: 'cc2',
    hostId: 'node-a',
    bodySha256: bodyDigest(Buffer.from(bodyString, 'utf8')),
  };
  return {
    method: 'POST',
    url: path,
    headers: {
      [HEADER_KEY_ID]: KEY_ID,
      [HEADER_TIMESTAMP]: timestamp,
      [HEADER_NONCE]: nonce,
      [HEADER_SIGNATURE]: sign(SECRET, signed),
      [HEADER_CONTROL_CENTER]: 'cc2',
      [HEADER_HOST]: 'node-a',
      [HEADER_AGENT_VERSION]: '0.1.0-cc2',
      ...overrides,
    },
  };
}

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = null;
  res.body = null;
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers; return res; };
  res.end = (payload) => { res.body = payload ? JSON.parse(payload) : null; return res; };
  return res;
}

function hostRow(overrides = {}) {
  return {
    id: HOST_UUID,
    host_id: 'node-a',
    display_name: 'node-a',
    control_center_id: 'cc2',
    status: 'active',
    labels: { role: 'worker' },
    enrolled_at: '2026-03-01T00:00:00.000Z',
    agent_key_id: KEY_ID,
    host_snapshot: {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      agent_version: '0.1.0-cc2',
      collected_at: new Date(NOW_MS - 30000).toISOString(),
      received_at: new Date(NOW_MS - 29000).toISOString(),
      payload: goodSnapshot(),
    },
    ...overrides,
  };
}

function buildApi(options = {}) {
  const calls = [];
  const restRequest = options.restRequest || (async (resource, opts = {}) => {
    calls.push({ resource, ...opts });
    if (resource === 'host' && (opts.method || 'GET') === 'GET') return [hostRow()];
    return [];
  });
  const api = createHostApi({
    restRequest,
    verifyReader: options.verifyReader || (async () => ({ sub: 'operator-uuid' })),
    audit: options.audit || (async () => {}),
    allowedControlCenters: ALLOWED,
    resolveAgentKey: options.resolveAgentKey === undefined
      ? ((keyId) => (keyId === KEY_ID
        ? { keyId: KEY_ID, secret: SECRET, controlCenterId: 'cc2', hostId: 'node-a', status: 'active' }
        : null))
      : options.resolveAgentKey,
    readRawBody: options.readRawBody || (async (req) => Buffer.from(req.rawBody ?? '', 'utf8')),
    nonceCache: options.nonceCache || createNonceCache(),
    now: () => NOW_MS,
  });
  return { api, calls };
}

test('parseHostRoute returns null for unrelated control-center paths', () => {
  assert.equal(parseHostRoute('/api/control-centers/cc2/k8s/api/v1/nodes', ALLOWED), null);
  assert.equal(parseHostRoute('/api/health', ALLOWED), null);
});

test('parseHostRoute classifies list, detail and heartbeat', () => {
  assert.deepEqual(parseHostRoute('/api/control-centers/cc2/hosts', ALLOWED), { kind: 'list', controlCenterId: 'cc2', viaPlugin: false });
  assert.deepEqual(parseHostRoute('/api/control-centers/cc2/hosts/node-a', ALLOWED), { kind: 'detail', controlCenterId: 'cc2', hostId: 'node-a', viaPlugin: false });
  assert.deepEqual(parseHostRoute('/api/control-centers/cc2/hosts/node-a/heartbeat', ALLOWED), { kind: 'heartbeat', controlCenterId: 'cc2', hostId: 'node-a' });
});

test('the subShell plugin namespace exposes reads only and never the heartbeat', () => {
  const base = `${PLUGIN_API_NAMESPACE}/control-centers/cc2/hosts`;
  assert.deepEqual(parseHostRoute(base, ALLOWED), { kind: 'list', controlCenterId: 'cc2', viaPlugin: true });
  assert.deepEqual(parseHostRoute(`${base}/node-a`, ALLOWED), { kind: 'detail', controlCenterId: 'cc2', hostId: 'node-a', viaPlugin: true });
  // A browser-reachable path must never become a signed-ingestion path.
  assert.throws(() => parseHostRoute(`${base}/node-a/heartbeat`, ALLOWED), (e) => e.code === 404);
  assert.equal(parseHostRoute('/api/plugins/other-plugin/control-centers/cc2/hosts', ALLOWED), null);
});

test('a plugin-namespace read is authorized exactly like the canonical route', async () => {
  const seen = [];
  const { api } = buildApi({ verifyReader: async (_req, ccId) => { seen.push(ccId); return { sub: 'operator-uuid' }; } });
  const res = fakeRes();
  const handled = await api.handle(
    { method: 'GET', url: `${PLUGIN_API_NAMESPACE}/control-centers/cc2/hosts`, headers: {} },
    res,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, ['cc2']);
  assert.equal(res.body.hostControlMode, 'read-only');
});

test('a plugin-namespace mutation attempt is refused', async () => {
  const { api } = buildApi();
  const res = fakeRes();
  await api.handle({ method: 'POST', url: `${PLUGIN_API_NAMESPACE}/control-centers/cc2/hosts/node-a`, headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

test('parseHostRoute fails closed on unknown control centers and malformed ids', () => {
  assert.throws(() => parseHostRoute('/api/control-centers/cc9/hosts', ALLOWED), (e) => e.code === 404);
  assert.throws(() => parseHostRoute('/api/control-centers/CC2/hosts', ALLOWED), (e) => e.code === 400);
  assert.throws(() => parseHostRoute('/api/control-centers/cc2/hosts/Node_A', ALLOWED), (e) => e.code === 400);
});

test('validateSnapshot accepts a well formed payload and re-projects it', () => {
  const result = validateSnapshot(goodSnapshot(), { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  assert.equal(result.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(result.identity.hostname, 'node-a.cc2.opl.io.kr');
  assert.equal(result.resources.cpuCount, 16);
  assert.equal(result.filesystems.length, 1);
  assert.equal(result.systemd.failedUnits[0], 'chronyd.service');
});

test('validateSnapshot rejects schema drift, identity mismatch and clock skew', () => {
  const binding = { controlCenterId: 'cc2', hostId: 'node-a' };
  assert.throws(() => validateSnapshot(goodSnapshot({ schemaVersion: 'rcc.host.snapshot/v2' }), binding, NOW_MS), (e) => e.code === 422);
  assert.throws(() => validateSnapshot(goodSnapshot({ hostId: 'node-b' }), binding, NOW_MS), (e) => e.code === 422);
  assert.throws(() => validateSnapshot(goodSnapshot({ collectedAt: 'yesterday' }), binding, NOW_MS), (e) => e.code === 422);
  assert.throws(() => validateSnapshot(goodSnapshot({ collectedAt: new Date(NOW_MS - 4 * 3600 * 1000).toISOString() }), binding, NOW_MS), (e) => e.code === 422);
  assert.throws(() => validateSnapshot('not-an-object', binding, NOW_MS), (e) => e.code === 400);
});

test('validateSnapshot drops unknown keys and enforces array bounds', () => {
  const hostile = goodSnapshot({
    injected: { command: 'rm -rf /' },
    filesystems: Array.from({ length: 100 }, (_, i) => ({ device: `/dev/sd${i}`, mountPoint: `/mnt/${i}`, fsType: 'ext4' })),
    network: Array.from({ length: 100 }, (_, i) => ({ name: `eth${i}` })),
    degraded: Array.from({ length: 100 }, (_, i) => `key-${i}`),
    systemd: { available: true, failedUnitCount: 900, failedUnits: Array.from({ length: 900 }, (_, i) => `u${i}.service`) },
  });
  const result = validateSnapshot(hostile, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  assert.equal(result.injected, undefined);
  assert.equal(result.filesystems.length, 32);
  assert.equal(result.network.length, 16);
  // Mirrors snapshot.MaxDegradedKeys in the Go agent. A tighter bound here would
  // discard collector failures the agent deliberately reported, and because the
  // agent sorts them first it would always discard the same alphabetically-last
  // ones on exactly the host that is most broken.
  assert.equal(result.degraded.length, 32);
  assert.equal(result.systemd.failedUnits.length, 25);
  assert.equal(result.systemd.truncated, true);
});

test('the ingestion bound on degraded keys is not tighter than the agent sends', () => {
  const goSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../rcc-node-agent/internal/snapshot/snapshot.go'), 'utf8');
  const declared = /MaxDegradedKeys\s*=\s*(\d+)/.exec(goSource);
  assert.ok(declared, 'the Go agent must still declare the bound this one mirrors');
  const payload = {
    ...goodSnapshot(),
    degraded: Array.from({ length: Number(declared[1]) }, (_, i) => `key-${i}`),
  };
  const result = validateSnapshot(payload, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  assert.equal(result.degraded.length, Number(declared[1]),
    'a full agent-side degraded list must survive ingestion intact');
});

test('validateSnapshot strips control characters from agent supplied strings', () => {
  const nasty = goodSnapshot();
  nasty.identity.hostname = `node-a${String.fromCharCode(0)}${String.fromCharCode(10)}injected`;
  const result = validateSnapshot(nasty, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  assert.equal(result.identity.hostname, 'node-ainjected');
});

test('snapshotFreshness grades fresh, stale, offline and unknown', () => {
  assert.equal(snapshotFreshness(new Date(NOW_MS - 30000).toISOString(), NOW_MS).state, 'fresh');
  assert.equal(snapshotFreshness(new Date(NOW_MS - 300000).toISOString(), NOW_MS).state, 'stale');
  assert.equal(snapshotFreshness(new Date(NOW_MS - 3600000).toISOString(), NOW_MS).state, 'offline');
  assert.equal(snapshotFreshness(undefined, NOW_MS).state, 'unknown');
});

test('a host whose clock runs fast cannot stay green after it stops reporting', () => {
  // collectedAt is accepted up to 900s of skew, and a future timestamp clamps to
  // age zero. A host 300s fast that died would have read `fresh` until its skew
  // ran out. The server's own receipt time cannot run ahead of us, so it decides.
  const collectedAt = new Date(NOW_MS + 300000).toISOString();
  assert.equal(snapshotFreshness(collectedAt, NOW_MS).state, 'fresh',
    'this is the unqualified reading the receipt time has to correct');

  const receivedAt = new Date(NOW_MS - 400000).toISOString();
  const graded = snapshotFreshness(collectedAt, NOW_MS, receivedAt);
  assert.equal(graded.state, 'stale');
  assert.equal(graded.ageSeconds, 400);

  const row = hostRow({
    host_snapshot: { ...hostRow().host_snapshot, collected_at: collectedAt, received_at: receivedAt },
  });
  assert.equal(toHostSummary(row, NOW_MS).reportState, 'stale');
});

test('a slow host is never made to look fresher than its own collection time', () => {
  // The correction only ever ages a snapshot. A host whose clock lags must still
  // be graded on when it says it collected, which is the older of the two.
  const graded = snapshotFreshness(
    new Date(NOW_MS - 700000).toISOString(), NOW_MS, new Date(NOW_MS - 1000).toISOString());
  assert.equal(graded.state, 'offline');
  assert.equal(graded.ageSeconds, 700);
});

test('the fleet projection names the collectors that failed, not just how many', () => {
  // The subShell host header renders these keys. It read a field the API never
  // sent, so a host whose root filesystem could not be read looked clean.
  const payload = { ...goodSnapshot(), degraded: ['mountNamespace', 'systemd'] };
  const row = hostRow({ host_snapshot: { ...hostRow().host_snapshot, payload } });
  const summary = toHostSummary(row, NOW_MS);
  assert.deepEqual(summary.degradedKeys, ['mountNamespace', 'systemd']);
  assert.equal(summary.degradedCount, 2);
  assert.deepEqual(toHostDetail(row, NOW_MS).degradedKeys, ['mountNamespace', 'systemd']);
  assert.deepEqual(toHostSummary(hostRow({ host_snapshot: null }), NOW_MS).degradedKeys, []);
});

test('toHostSummary distinguishes never-reported from healthy-with-no-data', () => {
  const summary = toHostSummary(hostRow({ host_snapshot: null, status: 'pending' }), NOW_MS);
  assert.equal(summary.reportState, 'never-reported');
  assert.equal(summary.collectedAt, null);
  assert.equal(summary.failedUnitCount, null);
  assert.equal(summary.snapshotAgeSeconds, null);
});

test('toHostDetail marks unimplemented sections unsupported with a reason', () => {
  const detail = toHostDetail(hostRow(), NOW_MS);
  assert.equal(detail.capabilities.readSnapshot, true);
  for (const key of ['network', 'storage', 'updates']) {
    assert.equal(detail.capabilities[key].supported, false, `${key} must not claim support`);
    assert.ok(String(detail.capabilities[key].reason).trim(), `${key} must explain why`);
  }
  assert.equal(detail.snapshot.identity.hostname, 'node-a.cc2.opl.io.kr');
});

test('Stage 2 operation capabilities are gated by deployment and permission', () => {
  // Read-only control center: nothing may be requested, whatever the caller holds.
  const readOnly = toHostDetail(hostRow(), NOW_MS, {
    hostControlMode: 'read-only',
    permissions: new Set(['console.hosts.operate', 'console.hosts.journal', 'console.hosts.approve']),
  });
  for (const op of ['journal.query', 'service.restart', 'host.reboot', 'approve']) {
    assert.equal(readOnly.capabilities.operations[op].supported, false, `${op} must be unsupported`);
    assert.match(readOnly.capabilities.operations[op].reason, /read-only/);
  }

  // Governed control center, but the caller holds no operation permission.
  const unprivileged = toHostDetail(hostRow(), NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.read']),
  });
  assert.equal(unprivileged.capabilities.operations['journal.query'].supported, true);
  assert.equal(unprivileged.capabilities.operations['journal.query'].permitted, false);
  assert.match(unprivileged.capabilities.operations['journal.query'].reason, /console\.hosts\.journal/);

  // Fully enabled.
  const enabled = toHostDetail(hostRow(), NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.journal', 'console.hosts.operate', 'console.hosts.approve']),
  });
  assert.equal(enabled.capabilities.operations['journal.query'].permitted, true);
  assert.equal(enabled.capabilities.operations['host.reboot'].permitted, true);
  assert.equal(enabled.capabilities.operations.approve.permitted, true);
});

const RESTART_OPTIONS = {
  hostControlMode: 'governed-write',
  permissions: new Set(['console.hosts.operate']),
};

function restartCapability(overrides = {}) {
  const row = hostRow();
  if (overrides.granted !== undefined) row.restart_allowlist = overrides.granted;
  if (overrides.reported !== undefined) {
    row.host_snapshot.payload.operations = { enabled: true, restartAllowlist: overrides.reported };
  }
  return toHostDetail(row, NOW_MS, RESTART_OPTIONS).capabilities.operations['service.restart'];
}

test('service.restart is unsupported when nothing has been granted', () => {
  const empty = restartCapability();
  assert.equal(empty.supported, false);
  assert.match(empty.reason, /granted no restart allowlist/);
  assert.deepEqual(empty.allowlist, []);
});

test('a unit the host reports but nobody granted is not offered', () => {
  // This is the case that matters: a compromised or misconfigured agent
  // declaring units it will restart must not populate the console with
  // buttons the control center never authorised.
  const claimed = restartCapability({ granted: [], reported: ['sshd.service', 'chronyd.service'] });
  assert.equal(claimed.supported, false, 'a host cannot grant itself authority');
  assert.deepEqual(claimed.allowlist, []);
  assert.deepEqual(claimed.drift.onlyReported, ['sshd.service', 'chronyd.service']);
});

test('a unit is offered only when both sides permit it', () => {
  const agreed = restartCapability({ granted: ['chronyd.service'], reported: ['chronyd.service'] });
  assert.equal(agreed.supported, true);
  assert.deepEqual(agreed.allowlist, ['chronyd.service']);
  assert.deepEqual(agreed.drift, { onlyGranted: [], onlyReported: [] });
});

test('a granted unit the agent will not honour is surfaced as drift, not offered', () => {
  const drifted = restartCapability({
    granted: ['chronyd.service', 'sshd.service'],
    reported: ['chronyd.service'],
  });
  assert.deepEqual(drifted.allowlist, ['chronyd.service'], 'only the intersection is actionable');
  assert.deepEqual(drifted.drift.onlyGranted, ['sshd.service']);
  assert.equal(drifted.supported, true);

  const none = restartCapability({ granted: ['sshd.service'], reported: ['chronyd.service'] });
  assert.equal(none.supported, false);
  assert.match(none.reason, /agent does not report any of the units/);
});

test('the capability API states who may approve, reject and cancel', () => {
  const row = hostRow();
  const viewer = toHostDetail(row, NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.read']),
  }).capabilities.operations;
  assert.equal(viewer.approve.permitted, false);
  assert.equal(viewer.reject.permitted, false, 'a viewer must not be offered reject');
  assert.equal(viewer.cancel.permitted, false, 'a viewer must not be offered cancel');
  assert.match(viewer.reject.reason, /console\.hosts\.approve/);

  const operator = toHostDetail(row, NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.operate']),
  }).capabilities.operations;
  assert.equal(operator.approve.permitted, false, 'requesting is not approving');
  assert.equal(operator.reject.permitted, false);
  assert.equal(operator.cancel.permitted, true, 'an operator may withdraw their own request');

  const approver = toHostDetail(row, NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.approve']),
  }).capabilities.operations;
  assert.equal(approver.approve.permitted, true);
  assert.equal(approver.reject.permitted, true);
  assert.equal(approver.cancel.permitted, true);
});

test('a read-only control center supports no decision at all', () => {
  const operations = toHostDetail(hostRow(), NOW_MS, {
    hostControlMode: 'read-only',
    permissions: new Set(['console.hosts.approve', 'console.hosts.operate']),
  }).capabilities.operations;
  for (const name of ['journal.query', 'service.restart', 'host.reboot', 'approve', 'reject', 'cancel']) {
    assert.equal(operations[name].supported, false, `${name} must be unsupported`);
    assert.match(operations[name].reason, /read-only host_control_mode/);
  }
});

test('handle ignores non-host control-center paths so existing routing is preserved', async () => {
  const { api } = buildApi();
  const res = fakeRes();
  const handled = await api.handle({ method: 'GET', url: '/api/control-centers/cc2/k8s/api/v1/nodes', headers: {} }, res);
  assert.equal(handled, false);
  assert.equal(res.statusCode, 0);
});

test('signed heartbeat persists the snapshot and returns 202', async () => {
  const body = JSON.stringify(goodSnapshot());
  const { api, calls } = buildApi();
  const req = signedHeartbeat(body);
  req.rawBody = body;
  const res = fakeRes();

  assert.equal(await api.handle(req, res), true);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.accepted, true);

  const write = calls.find((c) => c.resource === 'host_snapshot');
  assert.ok(write, 'snapshot must be written');
  assert.equal(write.body[0].host_uuid, HOST_UUID);
  assert.equal(write.body[0].agent_key_id, KEY_ID);
  assert.match(write.body[0].payload_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(write.body[0].payload.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(JSON.stringify(write.body[0]).includes(SECRET.toString('utf8')), false);
});

test('the snapshot write upserts, so a host keeps one current snapshot', async () => {
  // host_snapshot is keyed by host_uuid. Without merge-duplicates the second
  // heartbeat from every host would conflict and the console would keep showing
  // whatever the host reported the first time it ever came up.
  const body = JSON.stringify(goodSnapshot());
  const { api, calls } = buildApi();
  const req = signedHeartbeat(body);
  req.rawBody = body;

  await api.handle(req, fakeRes());
  const write = calls.find((c) => c.resource === 'host_snapshot');
  assert.match(String(write.prefer), /resolution=merge-duplicates/);
  assert.equal(write.body[0].host_uuid, HOST_UUID);
});

test('a pending host is promoted to active by its first accepted snapshot', async () => {
  const body = JSON.stringify(goodSnapshot());
  const { api, calls } = buildApi({
    restRequest: async (resource, opts = {}) => {
      calls.push({ resource, ...opts });
      if (resource === 'host' && (opts.method || 'GET') === 'GET') return [hostRow({ status: 'pending' })];
      return [];
    },
  });
  const req = signedHeartbeat(body);
  req.rawBody = body;
  const res = fakeRes();

  assert.equal(await api.handle(req, res), true);
  assert.equal(res.statusCode, 202);
  const promotion = calls.find((c) => c.resource === 'host' && c.method === 'PATCH');
  assert.ok(promotion, 'first contact must promote the enrolment');
  assert.equal(promotion.body.status, 'active');
  assert.equal(promotion.query, `id=eq.${HOST_UUID}`);
  // The snapshot is what proves the host is real, so it is stored either way.
  assert.ok(calls.find((c) => c.resource === 'host_snapshot'));
});

test('an already active host is not re-promoted on every heartbeat', async () => {
  const body = JSON.stringify(goodSnapshot());
  const { api, calls } = buildApi();
  const req = signedHeartbeat(body);
  req.rawBody = body;

  await api.handle(req, fakeRes());
  assert.equal(calls.some((c) => c.resource === 'host' && c.method === 'PATCH'), false);
});

test('a failed promotion still accepts the snapshot that has already been stored', async () => {
  // Promotion is best effort on purpose: the durable fact is the snapshot, and
  // the next heartbeat retries the status. Failing the request here would throw
  // away a report the platform had already accepted.
  const body = JSON.stringify(goodSnapshot());
  const seen = [];
  const { api } = buildApi({
    restRequest: async (resource, opts = {}) => {
      seen.push({ resource, method: opts.method || 'GET' });
      if (resource === 'host' && (opts.method || 'GET') === 'GET') return [hostRow({ status: 'pending' })];
      if (resource === 'host' && opts.method === 'PATCH') throw new Error('PostgREST unavailable');
      return [];
    },
  });
  const req = signedHeartbeat(body);
  req.rawBody = body;
  const res = fakeRes();

  await api.handle(req, res);
  assert.equal(res.statusCode, 202);
  assert.ok(seen.find((c) => c.resource === 'host_snapshot'), 'the snapshot is stored before promotion');
});

test('a retired host is gone from the detail route, not merely from the list', async () => {
  // Retirement is documented as excluding a host from reads and refusing its
  // heartbeat. The list filtered it; the detail route served its last snapshot
  // to anyone who still knew the id.
  const { api } = buildApi({
    restRequest: async (resource, opts = {}) => {
      if (resource === 'host' && (opts.method || 'GET') === 'GET') return [hostRow({ status: 'retired' })];
      return [];
    },
  });
  const res = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts/node-a', headers: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'host not found');

  const viaPlugin = fakeRes();
  await api.handle({
    method: 'GET',
    url: `${PLUGIN_API_NAMESPACE}/control-centers/cc2/hosts/node-a`,
    headers: {},
  }, viaPlugin);
  assert.equal(viaPlugin.statusCode, 404, 'the plugin namespace must not be a way around it');
});

test('heartbeat rejects a browser bearer token instead of falling back to it', async () => {
  const body = JSON.stringify(goodSnapshot());
  const { api, calls } = buildApi();
  const req = signedHeartbeat(body, { authorization: 'Bearer browser-session-token' });
  req.rawBody = body;
  const res = fakeRes();

  await api.handle(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.some((c) => c.resource === 'host_snapshot'), false);
});

test('heartbeat rejects a replayed nonce with 409 and does not double write', async () => {
  const body = JSON.stringify(goodSnapshot());
  const { api, calls } = buildApi();

  const first = signedHeartbeat(body);
  first.rawBody = body;
  await api.handle(first, fakeRes());

  const replay = signedHeartbeat(body);
  replay.rawBody = body;
  const res = fakeRes();
  await api.handle(replay, res);

  assert.equal(res.statusCode, 409);
  assert.equal(calls.filter((c) => c.resource === 'host_snapshot').length, 1);
});

test('heartbeat rejects a key that is not bound to the enrolled host', async () => {
  const body = JSON.stringify(goodSnapshot());
  const { api, calls } = buildApi({
    restRequest: async (resource, opts = {}) => {
      if (resource === 'host' && (opts.method || 'GET') === 'GET') return [hostRow({ agent_key_id: 'cc2-node-a-2025z' })];
      return [];
    },
  });
  const req = signedHeartbeat(body);
  req.rawBody = body;
  const res = fakeRes();

  await api.handle(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.some((c) => c.resource === 'host_snapshot'), false);
});

test('heartbeat returns 503 when agent key material is not configured', async () => {
  const body = JSON.stringify(goodSnapshot());
  const { api } = buildApi({ resolveAgentKey: undefined, restRequest: async () => [] });
  const configured = createHostApi({
    restRequest: async () => [],
    verifyReader: async () => ({ sub: 'operator-uuid' }),
    audit: async () => {},
    allowedControlCenters: ALLOWED,
    resolveAgentKey: null,
    readRawBody: async (req) => Buffer.from(req.rawBody ?? '', 'utf8'),
    now: () => NOW_MS,
  });
  const req = signedHeartbeat(body);
  req.rawBody = body;
  const res = fakeRes();
  await configured.handle(req, res);
  assert.equal(res.statusCode, 503);
  assert.ok(api);
});

test('heartbeat surfaces a database outage as 503 rather than accepting the report', async () => {
  const body = JSON.stringify(goodSnapshot());
  const { api } = buildApi({
    restRequest: async () => { throw { code: 500, msg: 'Supabase REST host GET failed' }; },
  });
  const req = signedHeartbeat(body);
  req.rawBody = body;
  const res = fakeRes();
  await api.handle(req, res);
  assert.equal(res.statusCode, 503);
});

test('heartbeat rejects a malformed body after the signature verifies', async () => {
  const body = '{"schemaVersion":';
  const { api, calls } = buildApi();
  const req = signedHeartbeat(body);
  req.rawBody = body;
  const res = fakeRes();
  await api.handle(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.some((c) => c.resource === 'host_snapshot'), false);
});

test('operator list is scoped by control-center assignment and audited', async () => {
  const audits = [];
  const { api } = buildApi({ audit: async (actor, event) => audits.push({ actor, event }) });
  const res = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts', headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.hostControlMode, 'read-only');
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].hostId, 'node-a');
  assert.equal(audits[0].event.action, 'rcc.host.list');
});

test('a fleet larger than one page says so instead of looking complete', async () => {
  // The query asked for exactly the page size, so a region with more hosts than
  // fit returned a full page that read as the whole fleet, and the count beside
  // it was the bound rather than the truth.
  let asked = null;
  const { api } = buildApi({
    restRequest: async (resource, opts = {}) => {
      if (resource === 'host' && (opts.method || 'GET') === 'GET') {
        asked = opts.query;
        return Array.from({ length: 201 }, (_, i) => hostRow({ host_id: `node-${i}` }));
      }
      return [];
    },
  });
  const res = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts', headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.match(asked, /limit=201/, 'one row beyond the page is what makes truncation detectable');
  assert.equal(res.body.items.length, 200, 'the page bound still holds');
  assert.equal(res.body.truncated, true);
  assert.equal(res.body.limit, 200);
});

test('a fleet that fits is not reported as cut short', async () => {
  const { api } = buildApi({
    restRequest: async (resource, opts = {}) => {
      if (resource === 'host' && (opts.method || 'GET') === 'GET') {
        return Array.from({ length: 200 }, (_, i) => hostRow({ host_id: `node-${i}` }));
      }
      return [];
    },
  });
  const res = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts', headers: {} }, res);
  assert.equal(res.body.items.length, 200);
  assert.equal(res.body.truncated, false, 'exactly one full page is a complete fleet');
});

test('both read responses report the control mode their own body was built from', async () => {
  // A fixed 'read-only' header contradicted the same response the moment a
  // region moved to governed-write: the header said no write was possible while
  // the operations beside it reported themselves supported.
  const governed = { control_center: { host_control_mode: 'governed-write' } };
  const { api } = buildApi({
    restRequest: async (resource, opts = {}) => {
      if (resource === 'host' && (opts.method || 'GET') === 'GET') return [hostRow(governed)];
      return [];
    },
  });

  const detail = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts/node-a', headers: {} }, detail);
  assert.equal(detail.body.hostControlMode, 'governed-write');
  assert.equal(
    detail.body.host.capabilities.operations['host.reboot'].supported,
    detail.body.hostControlMode === 'governed-write',
    'the header and the capabilities must be derived from one fact');

  const list = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts', headers: {} }, list);
  assert.equal(list.body.hostControlMode, 'governed-write');
});

test('a read-only region reports read-only and offers nothing', async () => {
  const { api } = buildApi();
  const detail = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts/node-a', headers: {} }, detail);
  assert.equal(detail.body.hostControlMode, 'read-only');
  assert.equal(detail.body.host.capabilities.operations['host.reboot'].supported, false);
  assert.equal(detail.body.host.capabilities.operations['service.restart'].supported, false);

  const list = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts', headers: {} }, list);
  assert.equal(list.body.hostControlMode, 'read-only');
});

test('an unknown or absent control mode is reported as read-only, never as write', async () => {
  // The column is constrained by the database, so this is drift insurance: a
  // projection that echoed whatever it was handed would turn a schema change
  // into a claim that a region accepts writes.
  for (const mode of [undefined, null, '', 'GOVERNED-WRITE', 'governed', 'anything']) {
    const { api } = buildApi({
      restRequest: async (resource, opts = {}) => {
        if (resource === 'host' && (opts.method || 'GET') === 'GET') {
          return [hostRow({ control_center: mode === undefined ? undefined : { host_control_mode: mode } })];
        }
        return [];
      },
    });
    const res = fakeRes();
    await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts/node-a', headers: {} }, res);
    assert.equal(res.body.hostControlMode, 'read-only', `mode ${String(mode)} must fail closed`);
    assert.equal(res.body.host.capabilities.operations['host.reboot'].supported, false);
  }
});

test('an empty region still reports a control mode, and it is read-only', async () => {
  const { api } = buildApi({ restRequest: async () => [] });
  const res = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts', headers: {} }, res);
  assert.equal(res.body.items.length, 0);
  assert.equal(res.body.truncated, false);
  assert.equal(res.body.hostControlMode, 'read-only');
});

test('operator list refuses an unassigned operator', async () => {
  const { api } = buildApi({
    verifyReader: async () => { throw { code: 403, msg: 'operator is not assigned to control center cc2' }; },
  });
  const res = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts', headers: {} }, res);
  assert.equal(res.statusCode, 403);
});

test('operator detail returns 404 for an unknown host', async () => {
  const { api } = buildApi({ restRequest: async () => [] });
  const res = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts/node-z', headers: {} }, res);
  assert.equal(res.statusCode, 404);
});

test('host mutation verbs are refused in Stage 1', async () => {
  const { api, calls } = buildApi();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = fakeRes();
    await api.handle({ method, url: '/api/control-centers/cc2/hosts/node-a', headers: {} }, res);
    assert.equal(res.statusCode, 405, `${method} must be refused`);
  }
  assert.equal(calls.length, 0);
});

test('no response body ever contains agent key material', async () => {
  const body = JSON.stringify(goodSnapshot());
  const { api } = buildApi();
  const heartbeatReq = signedHeartbeat(body);
  heartbeatReq.rawBody = body;
  const heartbeatRes = fakeRes();
  await api.handle(heartbeatReq, heartbeatRes);

  const listRes = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts', headers: {} }, listRes);

  const detailRes = fakeRes();
  await api.handle({ method: 'GET', url: '/api/control-centers/cc2/hosts/node-a', headers: {} }, detailRes);

  for (const res of [heartbeatRes, listRes, detailRes]) {
    const serialized = JSON.stringify(res.body);
    assert.equal(serialized.includes(SECRET.toString('utf8')), false);
    assert.equal(/agent_key_id|agentKeyId/.test(serialized), false);
  }
});

test('systemd failure count survives list truncation and is never under-reported', () => {
  const many = Array.from({ length: 200 }, (_, i) => `unit-${i}.service`);
  const payload = goodSnapshot();
  payload.systemd = { available: true, failedUnitCount: 200, failedUnits: many, truncated: true };
  const result = validateSnapshot(payload, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  assert.equal(result.systemd.failedUnits.length, 25, 'the list stays bounded');
  assert.equal(result.systemd.failedUnitCount, 200, 'the count must not be clamped to the list bound');
  assert.equal(result.systemd.truncated, true);
});

test('an exactly full failed-unit list is not reported as truncated', () => {
  const exact = Array.from({ length: 25 }, (_, i) => `unit-${i}.service`);
  const payload = goodSnapshot();
  payload.systemd = { available: true, failedUnitCount: 25, failedUnits: exact, truncated: false };
  const result = validateSnapshot(payload, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  assert.equal(result.systemd.failedUnitCount, 25);
  assert.equal(result.systemd.truncated, false);
});

test('an agent cannot under-report the failure count below the list it sent', () => {
  const payload = goodSnapshot();
  payload.systemd = {
    available: true,
    failedUnitCount: 0,
    failedUnits: ['a.service', 'b.service', 'c.service'],
    truncated: false,
  };
  const result = validateSnapshot(payload, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  assert.equal(result.systemd.failedUnitCount, 3);
});

// ── Stage 3: package capability and policy projection ───────────────────────

function packageSnapshotRow(overrides = {}) {
  const row = hostRow();
  row.host_snapshot.payload.packages = {
    manager: 'apt',
    supported: true,
    unsupportedReason: '',
    metadataAgeSeconds: 3600,
    pendingTotal: 12,
    pendingSecurity: 3,
    pending: [{ name: 'openssl', currentVersion: '3.0.13-1', candidateVersion: '3.0.13-2', security: true, origin: 'Ubuntu:24.04/noble-security' }],
    truncated: false,
    collectedAt: '2026-08-01T11:59:00.000Z',
    ...(overrides.packages || {}),
  };
  row.host_snapshot.payload.kernel = {
    running: '6.8.0-45-generic',
    installedLatest: '6.8.0-51-generic',
    candidate: '6.8.0-51-generic',
    updateAvailable: true,
    rebootRequired: true,
    rebootRequiredPackages: ['linux-image-6.8.0-51-generic'],
    collectedAt: '2026-08-01T11:59:00.000Z',
    ...(overrides.kernel || {}),
  };
  row.host_snapshot.payload.operations = {
    enabled: true, restartAllowlist: [], packagesEnabled: true, packageAllowlist: ['curl'],
    ...(overrides.operations || {}),
  };
  return row;
}

function stage3Policy(overrides = {}) {
  return {
    id: 'c0000000-0000-0000-0000-000000000001',
    name: 'CC2 nightly',
    scope: 'control-center',
    version: 3,
    timezone: 'Europe/Berlin',
    allowedOperations: ['package.refresh', 'package.update', 'kernel.update'],
    emergencyAllowed: false,
    enabled: true,
    windows: [],
    inWindow: true,
    windowEndsAt: '2026-08-01T13:00:00.000Z',
    ...overrides,
  };
}

function packageCapability(overrides = {}, operation = 'package.update') {
  return toHostDetail(overrides.row || packageSnapshotRow(), NOW_MS, {
    hostControlMode: overrides.hostControlMode || 'governed-write',
    permissions: overrides.permissions || new Set(['console.hosts.packages']),
    policy: overrides.policy === undefined ? stage3Policy() : overrides.policy,
  }).capabilities.operations[operation];
}

test('a supported, enabled, governed host offers package maintenance', () => {
  const capability = packageCapability();
  assert.equal(capability.supported, true);
  assert.equal(capability.permitted, true);
  assert.equal(capability.reason, '');
});

test('a host whose package manager this agent cannot drive is visibly unsupported', () => {
  const capability = packageCapability({
    row: packageSnapshotRow({
      packages: { manager: 'dnf', supported: false, unsupportedReason: 'this agent build drives apt only; dnf is detected but not operated' },
    }),
  });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /drives apt only/);
  assert.match(capability.reason, /dnf/);
});

test('a host that reports no manager at all says so rather than looking capable', () => {
  const row = packageSnapshotRow();
  delete row.host_snapshot.payload.packages;
  const capability = packageCapability({ row });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /no package manager/);
});

test('an agent that was never given package operations is not offered them', () => {
  const capability = packageCapability({
    row: packageSnapshotRow({ operations: { packagesEnabled: false } }),
  });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /has not been given package operations/);
});

test('a host with no policy is not offered package maintenance', () => {
  const capability = packageCapability({ policy: null });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /no maintenance policy/);
});

test('an operation the policy omits is not offered even on a capable host', () => {
  const capability = packageCapability({
    policy: stage3Policy({ allowedOperations: ['package.refresh'] }),
  });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /does not permit package\.update/);

  const refresh = packageCapability({
    policy: stage3Policy({ allowedOperations: ['package.refresh'] }),
  }, 'package.refresh');
  assert.equal(refresh.supported, true, 'the permitted operation is still offered');
});

test('package maintenance needs its own permission', () => {
  const capability = packageCapability({
    permissions: new Set(['console.hosts.operate', 'console.hosts.approve']),
  });
  assert.equal(capability.supported, true, 'the host is capable');
  assert.equal(capability.permitted, false, 'but this operator may not ask');
  assert.match(capability.reason, /console\.hosts\.packages/);
});

test('a read-only control center offers no package maintenance', () => {
  const capability = packageCapability({ hostControlMode: 'read-only' });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /read-only host_control_mode/);
});

test('the host detail carries update state and the rules that govern it', () => {
  const detail = toHostDetail(packageSnapshotRow(), NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.packages']),
    policy: stage3Policy(),
  });
  assert.equal(detail.packages.pendingSecurity, 3);
  assert.equal(detail.packages.metadataAgeSeconds, 3600,
    'evidence freshness must reach the console with the counts');
  assert.equal(detail.kernel.running, '6.8.0-45-generic');
  assert.equal(detail.kernel.installedLatest, '6.8.0-51-generic',
    'a kernel installed but not running is the whole point of the report');
  assert.equal(detail.kernel.rebootRequired, true);
  assert.equal(detail.policy.timezone, 'Europe/Berlin');
  assert.equal(detail.policy.inWindow, true);
});

test('a host that has never reported carries no invented update state', () => {
  const row = hostRow();
  row.host_snapshot = null;
  const detail = toHostDetail(row, NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.packages']),
    policy: stage3Policy(),
  });
  assert.equal(detail.packages, null);
  assert.equal(detail.kernel, null);
  assert.equal(detail.capabilities.operations['package.update'].supported, false);
});

// ── Stage 4: inventory ingestion and capability projection ──────────────────
//
// Every capability below is derived from what the host actually reported, and
// the report has to survive ingestion to get there. Stage 3 shipped with the
// inventory blocks silently dropped at the heartbeat, which disabled every
// capability derived from them in production while the unit tests — which built
// rows by hand — kept passing.

function stage4Payload(overrides = {}) {
  return {
    networkState: {
      supported: true,
      manager: 'NetworkManager',
      unsupportedReason: '',
      links: [
        { name: 'eth0', type: 'ether', state: 'up', mtu: 1500, managed: true, connection: 'primary', method: 'manual', addresses: ['10.0.0.5/24'], staticAddresses: ['10.0.0.5/24'], gateway: '10.0.0.1' },
        { name: 'eth1', type: 'ether', state: 'up', mtu: 1500, managed: true, connection: 'lab-data', method: 'auto', addresses: [], staticAddresses: [], gateway: '' },
      ],
      defaultRoute: { present: true, interface: 'eth0', gateway: '10.0.0.1', metric: 100 },
      dns: { source: '/etc/resolv.conf', servers: ['10.0.0.1'], search: ['cc2.local'] },
      ...(overrides.networkState || {}),
    },
    storage: {
      supported: true,
      unsupportedReason: '',
      devices: [{ name: '/dev/sdb1', kind: 'part', sizeBytes: 1000, fsType: 'ext4', uuid: '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c', mountPoint: '', protected: false }],
      capacity: [{ mountPoint: '/srv/data', device: '/dev/sdb1', fsType: 'ext4', growable: true, protected: false, sizeBytes: 800, deviceBytes: 1000, headroomBytes: 200, reason: '' }],
      ...(overrides.storage || {}),
    },
    boot: {
      supported: true, adapter: 'bootc', model: 'bootc',
      canStage: true, canRollback: true, rollbackAvailable: true,
      booted: { digest: `sha256:${'a'.repeat(64)}`, version: '9.4', origin: 'registry.example.com/polyon/os', booted: true },
      staged: null, deployments: [],
      ...(overrides.boot || {}),
    },
    operations: {
      enabled: true, restartAllowlist: [], packageAllowlist: [], packagesEnabled: false,
      networkEnabled: true, networkAllowlist: ['lab-data'],
      storageEnabled: true, mountRoots: ['/srv'], growAllowlist: ['/srv/data'],
      osImageEnabled: true, imageAllowlist: [`registry.example.com/polyon/os@sha256:${'b'.repeat(64)}`],
      ...(overrides.operations || {}),
    },
  };
}

function stage4Row(overrides = {}) {
  const row = hostRow();
  Object.assign(row.host_snapshot.payload, stage4Payload(overrides));
  return row;
}

function stage4Policy(overrides = {}) {
  return {
    ...stage3Policy(),
    allowedOperations: ['network.configure', 'mount.configure', 'filesystem.grow',
      'osimage.stage', 'osimage.rollback'],
    allowedImages: [`registry.example.com/polyon/os@sha256:${'b'.repeat(64)}`],
    allowedMountRoots: ['/srv'],
    ...overrides,
  };
}

function stage4Capability(operation, overrides = {}) {
  return toHostDetail(overrides.row || stage4Row(), NOW_MS, {
    hostControlMode: overrides.hostControlMode || 'governed-write',
    permissions: overrides.permissions
      || new Set(['console.hosts.network', 'console.hosts.storage', 'console.hosts.osimage']),
    policy: overrides.policy === undefined ? stage4Policy() : overrides.policy,
  }).capabilities.operations[operation];
}

test('the heartbeat stores the inventory the console gates its controls on', () => {
  // The regression this exists for: dropping these blocks at ingestion left
  // every derived capability permanently unsupported in production, while
  // hand-built unit fixtures kept passing.
  const payload = {
    schemaVersion: 'rcc.host.snapshot/v1',
    controlCenterId: 'cc2', hostId: 'node-a', agentVersion: '0.4.0',
    collectedAt: new Date(NOW_MS).toISOString(),
    identity: {}, resources: {}, filesystems: [], network: [], systemd: {},
    packages: { manager: 'apt', supported: true, pendingTotal: 4, pending: [{ name: 'curl' }] },
    kernel: { running: '6.8.0-45-generic', rebootRequired: true },
    degraded: [],
    ...stage4Payload(),
  };
  const stored = validateSnapshot(payload, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  for (const block of ['packages', 'kernel', 'networkState', 'storage', 'boot', 'operations']) {
    assert.ok(stored[block], `${block} must survive ingestion`);
  }
  assert.equal(stored.packages.pendingTotal, 4);
  assert.equal(stored.operations.restartAllowlist.length, 0);
  assert.equal(stored.networkState.links.length, 2);
  assert.equal(stored.storage.capacity[0].growable, true);
  assert.equal(stored.boot.canStage, true);
});

test('ingestion derives the management link rather than trusting it', () => {
  // A link cannot claim not to carry the control path in order to become
  // reconfigurable.
  const payload = {
    schemaVersion: 'rcc.host.snapshot/v1',
    controlCenterId: 'cc2', hostId: 'node-a', agentVersion: '0.4.0',
    collectedAt: new Date(NOW_MS).toISOString(),
    identity: {}, resources: {}, filesystems: [], network: [], systemd: {}, degraded: [],
    networkState: {
      supported: true,
      links: [
        { name: 'eth0', carriesRcc: false, managed: true, connection: 'primary' },
        { name: 'eth1', carriesRcc: true, managed: true, connection: 'lab-data' },
      ],
      defaultRoute: { present: true, interface: 'eth0' },
    },
  };
  const stored = validateSnapshot(payload, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  assert.equal(stored.networkState.links[0].carriesRcc, true, 'the default-route link must be marked');
  assert.equal(stored.networkState.links[1].carriesRcc, false, 'a claim cannot make a link reconfigurable');
  assert.equal(stored.networkState.managementLink, 'eth0');
});

test('ingestion refuses to let an unsupported subsystem look actionable', () => {
  const payload = {
    schemaVersion: 'rcc.host.snapshot/v1',
    controlCenterId: 'cc2', hostId: 'node-a', agentVersion: '0.4.0',
    collectedAt: new Date(NOW_MS).toISOString(),
    identity: {}, resources: {}, filesystems: [], network: [], systemd: {}, degraded: [],
    packages: { supported: false, pendingTotal: 99, pending: [{ name: 'curl' }] },
    storage: { supported: false, devices: [{ name: '/dev/sdb1' }], capacity: [{ mountPoint: '/srv/data', growable: true }] },
    boot: { supported: false, canStage: true, canRollback: true, rollbackAvailable: true, staged: { id: 'x' }, deployments: [{ id: 'x' }] },
    operations: { enabled: false, networkEnabled: true, storageEnabled: true, osImageEnabled: true },
  };
  const stored = validateSnapshot(payload, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  assert.equal(stored.packages.pendingTotal, 0, 'an unreadable manager reports no counts');
  assert.equal(stored.storage.devices.length, 0);
  assert.equal(stored.storage.capacity.length, 0);
  assert.equal(stored.boot.canStage, false);
  assert.equal(stored.boot.staged, null);
  assert.equal(stored.boot.deployments.length, 0);
  // A host not executing operations at all cannot be executing these.
  assert.equal(stored.operations.networkEnabled, false);
  assert.equal(stored.operations.storageEnabled, false);
  assert.equal(stored.operations.osImageEnabled, false);
});

test('read-only link state survives an unsupported network manager', () => {
  // A systemd-networkd host is perfectly readable and simply not changeable;
  // discarding its links would hide true information.
  const payload = {
    schemaVersion: 'rcc.host.snapshot/v1',
    controlCenterId: 'cc2', hostId: 'node-a', agentVersion: '0.4.0',
    collectedAt: new Date(NOW_MS).toISOString(),
    identity: {}, resources: {}, filesystems: [], network: [], systemd: {}, degraded: [],
    networkState: {
      supported: false, manager: 'systemd-networkd',
      unsupportedReason: 'this agent build drives NetworkManager only',
      links: [{ name: 'eth0', managed: false, connection: '' }],
      defaultRoute: { present: true, interface: 'eth0' },
    },
  };
  const stored = validateSnapshot(payload, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  assert.equal(stored.networkState.links.length, 1);
  assert.equal(stored.networkState.supported, false);
});

test('a fully capable host is offered every Stage 4 operation', () => {
  for (const operation of ['network.configure', 'mount.configure', 'filesystem.grow',
    'osimage.stage', 'osimage.rollback']) {
    const capability = stage4Capability(operation);
    assert.equal(capability.supported, true, `${operation}: ${capability.reason}`);
    assert.equal(capability.permitted, true, `${operation}: ${capability.reason}`);
  }
});

test('each Stage 4 operation needs its own permission', () => {
  const cases = {
    'network.configure': 'console.hosts.network',
    'mount.configure': 'console.hosts.storage',
    'filesystem.grow': 'console.hosts.storage',
    'osimage.stage': 'console.hosts.osimage',
    'osimage.rollback': 'console.hosts.osimage',
  };
  for (const [operation, permission] of Object.entries(cases)) {
    // Holding one authority must not confer another: none of the three implies
    // any other, and each widens the host sandbox differently.
    const others = Object.values(cases).filter((code) => code !== permission);
    const capability = stage4Capability(operation, { permissions: new Set(others) });
    assert.equal(capability.supported, true);
    assert.equal(capability.permitted, false, `${operation} must need ${permission}`);
    assert.match(capability.reason, new RegExp(permission.replace(/\./g, '\\.')));
  }
});

test('a host whose agent was never given an authority is not offered it', () => {
  const cases = {
    'network.configure': { networkEnabled: false },
    'filesystem.grow': { storageEnabled: false },
    'osimage.stage': { osImageEnabled: false },
  };
  for (const [operation, operations] of Object.entries(cases)) {
    const capability = stage4Capability(operation, { row: stage4Row({ operations }) });
    assert.equal(capability.supported, false, `${operation} must be unsupported`);
    assert.match(capability.reason, /has not been given/);
  }
});

test('an unsupported subsystem says which one and why, once', () => {
  const cases = [
    ['network.configure', { networkState: { supported: false, unsupportedReason: 'systemd-networkd is in use on this host' } }, /systemd-networkd/],
    ['filesystem.grow', { storage: { supported: false, unsupportedReason: 'lsblk is not present' } }, /lsblk/],
    ['osimage.stage', { boot: { supported: false, unsupportedReason: 'this host takes updates through its package manager' } }, /package manager/],
  ];
  for (const [operation, overrides, pattern] of cases) {
    const capability = stage4Capability(operation, { row: stage4Row(overrides) });
    assert.equal(capability.supported, false);
    assert.match(capability.reason, pattern);
  }
});

test('a policy that names no target permits no operation that needs one', () => {
  const noImages = stage4Capability('osimage.stage', { policy: stage4Policy({ allowedImages: [] }) });
  assert.equal(noImages.supported, false);
  assert.match(noImages.reason, /allowlists no image/);

  const noRoots = stage4Capability('mount.configure', { policy: stage4Policy({ allowedMountRoots: [] }) });
  assert.equal(noRoots.supported, false);
  assert.match(noRoots.reason, /no mount roots/);
});

test('an operation the policy omits is not offered even on a capable host', () => {
  const capability = stage4Capability('network.configure', {
    policy: stage4Policy({ allowedOperations: ['filesystem.grow'] }),
  });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /does not permit network\.configure/);
});

test('a host with no policy is offered no Stage 4 work at all', () => {
  for (const operation of ['network.configure', 'mount.configure', 'filesystem.grow', 'osimage.stage']) {
    const capability = stage4Capability(operation, { policy: null });
    assert.equal(capability.supported, false, `${operation} must be unsupported`);
    assert.match(capability.reason, /no maintenance policy/);
  }
});

test('a host whose only link carries the control path is offered no network change', () => {
  const row = stage4Row({
    networkState: {
      supported: true,
      links: [{ name: 'eth0', managed: true, connection: 'primary', carriesRcc: true }],
      defaultRoute: { present: true, interface: 'eth0' },
    },
  });
  const capability = stage4Capability('network.configure', { row });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /carries the default route/);
});

test('a host with nothing growable is told so rather than offered a dead control', () => {
  const row = stage4Row({
    storage: {
      supported: true,
      devices: [],
      capacity: [{ mountPoint: '/srv/data', growable: false, protected: false, reason: 'no headroom' }],
    },
  });
  const capability = stage4Capability('filesystem.grow', { row });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /no filesystem on this host can be grown/);
});

test('a host with no previous deployment is offered no rollback', () => {
  const row = stage4Row({ boot: { supported: true, adapter: 'bootc', canStage: true, canRollback: true, rollbackAvailable: false } });
  const capability = stage4Capability('osimage.rollback', { row });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /no previous deployment/);
});

test('an adapter without a staging command is not offered staging', () => {
  const row = stage4Row({ boot: { supported: true, adapter: 'bootc', canStage: false, canRollback: true, rollbackAvailable: true } });
  const capability = stage4Capability('osimage.stage', { row });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /staging command/);
});

test('a read-only control center offers no Stage 4 work', () => {
  for (const operation of ['network.configure', 'mount.configure', 'filesystem.grow',
    'osimage.stage', 'osimage.rollback']) {
    const capability = stage4Capability(operation, { hostControlMode: 'read-only' });
    assert.equal(capability.supported, false, `${operation} must be unsupported`);
    assert.match(capability.reason, /read-only host_control_mode/);
  }
});

test('the section headers agree with the controls inside them', () => {
  // A tab that says "supported" over a set of disabled controls, or the
  // reverse, is a screen nobody can act on.
  const detail = toHostDetail(stage4Row(), NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.network', 'console.hosts.storage', 'console.hosts.osimage']),
    policy: stage4Policy(),
  });
  assert.equal(detail.capabilities.network.supported, true);
  assert.equal(detail.capabilities.storage.supported, true);
  assert.equal(detail.capabilities.osimage.supported, true);

  const readOnly = toHostDetail(stage4Row(), NOW_MS, {
    hostControlMode: 'read-only', permissions: new Set(), policy: stage4Policy(),
  });
  for (const section of ['network', 'storage', 'osimage', 'updates']) {
    assert.equal(readOnly.capabilities[section].supported, false, `${section} must be unsupported`);
    assert.ok(readOnly.capabilities[section].reason, `${section} must say why`);
  }
});

test('the host detail carries the Stage 4 inventory the UI renders', () => {
  const detail = toHostDetail(stage4Row(), NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.network']),
    policy: stage4Policy(),
  });
  assert.equal(detail.networkState.manager, 'NetworkManager');
  assert.equal(detail.storage.capacity[0].mountPoint, '/srv/data');
  assert.equal(detail.boot.adapter, 'bootc');

  const never = toHostDetail(hostRow({ host_snapshot: null }), NOW_MS, {
    hostControlMode: 'governed-write', permissions: new Set(), policy: null,
  });
  // A host that has never reported must carry no invented state.
  assert.equal(never.networkState, null);
  assert.equal(never.storage, null);
  assert.equal(never.boot, null);
});

test('ingestion never lets a protected filesystem through as growable', () => {
  // The unsupported-subsystem test clears the whole capacity list, so only a
  // *supported* block layer carrying a protected-but-growable entry can prove
  // this particular normalisation is live.
  const payload = {
    schemaVersion: 'rcc.host.snapshot/v1',
    controlCenterId: 'cc2', hostId: 'node-a', agentVersion: '0.4.0',
    collectedAt: new Date(NOW_MS).toISOString(),
    identity: {}, resources: {}, filesystems: [], network: [], systemd: {}, degraded: [],
    storage: {
      supported: true,
      devices: [],
      capacity: [
        // A hostile or buggy agent claiming the root filesystem is growable.
        { mountPoint: '/', fsType: 'ext4', growable: true, protected: true, sizeBytes: 1, deviceBytes: 2 },
        { mountPoint: '/srv/data', fsType: 'ext4', growable: true, protected: false, sizeBytes: 1, deviceBytes: 2 },
      ],
    },
  };
  const stored = validateSnapshot(payload, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  const byMount = Object.fromEntries(stored.storage.capacity.map((e) => [e.mountPoint, e]));
  assert.equal(byMount['/'].growable, false, 'a protected filesystem is never growable');
  assert.equal(byMount['/srv/data'].growable, true, 'an ordinary filesystem stays growable');
});

test('SSH ban inventory is bounded and only actionable through its own permission', () => {
  const payload = goodSnapshot({
    sshBan: {
      provider: 'fail2ban', jail: 'sshd', installed: true, active: true, supported: true,
      currentlyFailed: 2, totalFailed: 20, currentlyBanned: 2, totalBanned: 8,
      bannedAddresses: ['203.0.113.24', '::ffff:203.0.113.24', '2001:db8::24', '<script>'],
      banTimeSeconds: 600, findTimeSeconds: 600, maxRetry: 5,
      collectedAt: new Date(NOW_MS).toISOString(),
    },
    operations: {
      enabled: true, sshBanEnabled: true,
      sshProtectedAddresses: ['203.0.113.10', '::ffff:203.0.113.10', 'not-an-ip'],
    },
  });
  const stored = validateSnapshot(payload, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  assert.deepEqual(stored.sshBan.bannedAddresses, ['2001:db8::24', '203.0.113.24']);
  assert.deepEqual(stored.operations.sshProtectedAddresses, ['203.0.113.10']);

  const row = hostRow();
  row.host_snapshot.payload = stored;
  const permitted = toHostDetail(row, NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.ssh-ban']),
  });
  assert.equal(permitted.capabilities.sshBan.supported, true);
  assert.equal(permitted.capabilities.operations['ssh.ban'].permitted, true);
  assert.equal(permitted.sshBan.currentlyBanned, 2);

  const denied = toHostDetail(row, NOW_MS, {
    hostControlMode: 'governed-write', permissions: new Set(),
  });
  assert.equal(denied.capabilities.operations['ssh.ban'].permitted, false);
  assert.match(denied.capabilities.operations['ssh.ban'].reason, /console\.hosts\.ssh-ban/);
});

test('an uninstalled SSH provider exposes a policy-bound setup capability and bounded events', () => {
  const payload = goodSnapshot({
    sshBan: {
      provider: 'fail2ban', jail: 'sshd', installed: false, active: false, supported: false,
      candidateVersion: '1.0.2-3ubuntu0.1',
      unsupportedReason: 'fail2ban-client is not installed on this host',
      recentEvents: [
        { occurredAt: '2026-08-01T11:30:00Z', action: 'ban', address: '203.0.113.24' },
        { occurredAt: 'invalid', action: 'shell', address: '<script>' },
      ],
    },
    operations: {
      enabled: true,
      sshBanEnabled: true,
      sshProtectedAddresses: ['203.0.113.10'],
    },
  });
  const stored = validateSnapshot(payload, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS);
  assert.equal(stored.sshBan.candidateVersion, '1.0.2-3ubuntu0.1');
  assert.deepEqual(stored.sshBan.recentEvents, [{
    occurredAt: '2026-08-01T11:30:00.000Z',
    action: 'ban',
    address: '203.0.113.24',
  }]);
  assert.equal(stored.operations.sshBanEnabled, true,
    'setup authority must remain visible before the provider is active');

  const row = hostRow();
  row.host_snapshot.payload = stored;
  const policy = {
    name: 'CC2 maintenance',
    enabled: true,
    inWindow: true,
    allowedOperations: ['ssh.protection.enable'],
  };
  const ready = toHostDetail(row, NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.ssh-ban']),
    policy,
  });
  assert.equal(ready.capabilities.operations['ssh.protection.enable'].supported, true);
  assert.equal(ready.capabilities.operations['ssh.protection.enable'].permitted, true);
  assert.equal(ready.capabilities.operations['ssh.ban'].supported, false);
  assert.equal(ready.capabilities.sshBan.supported, true);

  const noPolicy = toHostDetail(row, NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.ssh-ban']),
  });
  assert.equal(noPolicy.capabilities.operations['ssh.protection.enable'].supported, false);
  assert.match(noPolicy.capabilities.operations['ssh.protection.enable'].reason, /maintenance policy/);

  const driftedPayload = goodSnapshot({
    sshBan: {
      provider: 'fail2ban', jail: 'sshd', installed: true, active: true, supported: true,
      packageVersion: '1.0.2-3ubuntu0.1',
      protectionProfile: 'rcc-ssh-baseline-v1-drift',
      profileDigest: `sha256:${'a'.repeat(64)}`,
      bannedAddresses: [], recentEvents: [],
    },
    operations: {
      enabled: true,
      sshBanEnabled: true,
      sshProtectedAddresses: ['203.0.113.10'],
    },
  });
  const driftedRow = hostRow();
  driftedRow.host_snapshot.payload = validateSnapshot(
    driftedPayload, { controlCenterId: 'cc2', hostId: 'node-a' }, NOW_MS,
  );
  const drifted = toHostDetail(driftedRow, NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.ssh-ban']),
    policy,
  });
  assert.equal(drifted.sshBan.profileDigest, `sha256:${'a'.repeat(64)}`);
  assert.equal(drifted.capabilities.operations['ssh.protection.enable'].supported, true,
    'an RCC-owned active profile must be reconcilable when management addresses drift');

  driftedRow.host_snapshot.payload.sshBan.protectionProfile = 'external';
  const external = toHostDetail(driftedRow, NOW_MS, {
    hostControlMode: 'governed-write',
    permissions: new Set(['console.hosts.ssh-ban']),
    policy,
  });
  assert.equal(external.capabilities.operations['ssh.protection.enable'].supported, false);
  assert.match(external.capabilities.operations['ssh.protection.enable'].reason, /external policy/);
});
