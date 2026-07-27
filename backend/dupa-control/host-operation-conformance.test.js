'use strict';

/**
 * Cross-language conformance for the Stage 2 operation contract.
 *
 * The plan is built in Node and parsed in Go; the receipt is built in Go and
 * validated in Node. Both sides define the schema independently, so a change to
 * one without the other is a silent production break: the agent would reject
 * every plan, or the backend would reject every receipt, and only a deployed
 * host would notice.
 *
 * These assertions compare the two definitions directly from source, and run a
 * real round trip through the compiled Go package when a toolchain is present.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const agentRoot = path.join(repoRoot, 'backend/rcc-node-agent');
const planGo = fs.readFileSync(path.join(agentRoot, 'internal/plan/plan.go'), 'utf8');
const {
  planFor,
  contentDigest,
  normalizeParameters,
  createOperationApi,
  LEASE_SECONDS,
  PLAN_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
} = require('../opensphere-console-backend/operation-api');

/**
 * The operation names the deployed catalog declares.
 *
 * Scoped to the operation-catalog inserts: permissions are seeded with the same
 * shape and would otherwise be counted as operations.
 */
function catalogOperations() {
  const baseline = fs.readFileSync(path.join(repoRoot, 'deploy/rcc/supabase-baseline.sql'), 'utf8');
  const catalog = new Set();
  for (const block of baseline.matchAll(
    /INSERT INTO console\.host_operation_type[\s\S]*?VALUES([\s\S]*?)ON CONFLICT/g)) {
    for (const row of block[1].matchAll(/\('([a-z]+(?:\.[a-z]+)+)',/g)) catalog.add(row[1]);
  }
  return catalog;
}

const OP_ID = '2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f';
const DIGEST = contentDigest('journal.query', { units: ['chronyd.service'], lines: 50 });

/**
 * A host that supports every Stage 4 subsystem.
 *
 * Stage 4 parameters carry a pre-state the backend derives from the host's own
 * reported inventory, so a fixture that omitted it would not exercise the part
 * of the digest most likely to disagree between the two languages.
 */
const STAGE4_SNAPSHOT = {
  networkState: {
    supported: true,
    manager: 'NetworkManager',
    links: [
      { name: 'eth1', managed: true, connection: 'lab-data', method: 'auto', staticAddresses: [], gateway: '', mtu: 1500 },
      { name: 'eth0', managed: true, connection: 'primary', method: 'manual', staticAddresses: ['10.0.0.5/24'], gateway: '10.0.0.1', mtu: 1500 },
    ],
    defaultRoute: { present: true, interface: 'eth0', gateway: '10.0.0.1' },
  },
  storage: {
    supported: true,
    devices: [{
      name: '/dev/sdb1', uuid: '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c',
      fsType: 'ext4', sizeBytes: 536870912000, mountPoint: '', protected: false,
    }],
    capacity: [{
      mountPoint: '/srv/data', device: '/dev/sdb1', fsType: 'ext4',
      growable: true, protected: false,
      sizeBytes: 429496729600, deviceBytes: 536870912000, headroomBytes: 107374182400,
    }],
  },
  boot: {
    supported: true, adapter: 'bootc', model: 'bootc',
    canStage: true, canRollback: true, rollbackAvailable: true,
    booted: { digest: `sha256:${'a'.repeat(64)}`, version: '9.4' },
  },
  // The backend intersects every Stage 4 target with what the host's own agent
  // reports it will accept, so a snapshot without this describes a host that
  // would refuse each of these operations before a plan was ever built.
  operations: {
    enabled: true,
    networkEnabled: true,
    networkAllowlist: ['lab-data'],
    storageEnabled: true,
    mountRoots: ['/srv', '/mnt'],
    growAllowlist: ['/srv/data'],
    osImageEnabled: true,
    imageAllowlist: [`registry.example.com/polyon/os@sha256:${'b'.repeat(64)}`],
    sshBanEnabled: true,
    sshProtectedAddresses: ['203.0.113.10'],
  },
  sshBan: {
    provider: 'fail2ban',
    jail: 'sshd',
    installed: false,
    active: false,
    supported: false,
    candidateVersion: '1.0.2-3ubuntu0.1',
  },
};

function goAvailable() {
  return spawnSync('go', ['version'], { cwd: agentRoot, stdio: 'ignore' }).status === 0;
}

/** Minimal api instance used only for its receipt validator. */
function validator() {
  return createOperationApi({
    restRequest: async () => [],
    verifyOperator: async () => ({}),
    requirePermission() {},
    requireAssurance() {},
    audit: async () => {},
    allowedControlCenters: new Set(['cc2']),
    readRawBody: async () => Buffer.from(''),
    nonceCache: { claim: () => true },
    now: () => Date.now(),
  });
}

test('both sides declare the same schema versions', () => {
  assert.match(planGo, new RegExp(`SchemaVersion = "${PLAN_SCHEMA_VERSION}"`),
    'the Go agent must expect exactly the plan version the backend emits');
  assert.match(planGo, new RegExp(`ReceiptSchemaVersion = "${RECEIPT_SCHEMA_VERSION}"`),
    'the Go agent must emit exactly the receipt version the backend accepts');
});

test('both sides declare the same operation names', () => {
  // Derived from the deployed catalog rather than a list written here, so an
  // operation added to one side and not the other is a failure rather than a
  // test somebody forgot to update.
  const catalog = catalogOperations();
  assert.ok(catalog.size >= 11, `the catalog must be populated, found ${[...catalog].join(', ')}`);

  const goOps = new Set([...planGo.matchAll(/Op[A-Za-z]+\s*=\s*"([a-z.]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...goOps].sort(), [...catalog].sort(),
    'the agent and the operation catalog must know exactly the same operations');

  // The agent must also be willing to file a receipt for each of them, or the
  // operation would run and then be unable to report its own result.
  const receiptSwitch = /switch r\.Operation \{([\s\S]*?)default:/.exec(planGo);
  assert.ok(receiptSwitch, 'the receipt validator must enumerate operations');
  for (const operation of catalog) {
    const constant = [...planGo.matchAll(/(Op[A-Za-z]+)\s*=\s*"([a-z.]+)"/g)]
      .find((m) => m[2] === operation);
    assert.ok(constant, `${operation} must have a Go constant`);
    assert.ok(receiptSwitch[1].includes(constant[1]),
      `${operation} must be accepted by the receipt validator`);
  }
});

test('a receipt can always fit inside the signed channel body limit', () => {
  // If the receipt bound exceeded the transport bound, the agent could build a
  // result it is unable to send, and the operation would hang forever.
  const receiptBytes = /MaxReceiptBytes = (\d+) \* 1024/.exec(planGo);
  const journalBytes = /MaxJournalBytes\s+= (\d+) \* 1024/.exec(planGo);
  assert.ok(receiptBytes && journalBytes, 'both bounds must be declared');
  assert.ok(Number(journalBytes[1]) < Number(receiptBytes[1]),
    'journal output must leave room for the receipt envelope');
  const protocolGo = fs.readFileSync(path.join(agentRoot, 'internal/protocol/signing.go'), 'utf8');
  const bodyBytes = /MaxBodyBytes\s+= (\d+) \* 1024/.exec(protocolGo);
  assert.ok(bodyBytes, 'the transport bound must be declared');
  assert.ok(Number(receiptBytes[1]) <= Number(bodyBytes[1]),
    'a receipt must fit inside the signed request body limit');
});

test('every plan the backend emits parses in the Go agent', { skip: !goAvailable() && 'go toolchain unavailable' }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-conf-'));
  try {
    const binary = path.join(work, 'conformance');
    execFileSync('go', ['build', '-o', binary, './cmd/conformance'], { cwd: agentRoot, stdio: 'pipe' });

    const base = {
      id: OP_ID,
      lease_attempt: 1,
      control_center_id: 'cc2',
      host_id: 'node-a',
      maintenance: {},
    };
    // The digest binds the parameters the backend actually stores, which are
    // the normalized ones. Building it from the raw request instead would let
    // this fixture agree with itself while disagreeing with production.
    const withDigest = (row) => {
      const parameters = normalizeParameters(row.operation, row.parameters, { snapshot: STAGE4_SNAPSHOT });
      return { ...row, parameters, content_digest: contentDigest(row.operation, parameters) };
    };
    const plans = {
      'journal.query': withDigest({ ...base, operation: 'journal.query', parameters: { units: ['chronyd.service'], lines: 50 } }),
      'service.restart': withDigest({ ...base, operation: 'service.restart', parameters: { unit: 'chronyd.service' } }),
      'host.reboot': withDigest({
        ...base, operation: 'host.reboot', parameters: { deadlineSeconds: 300 },
        maintenance: { drain: { drained: true } },
      }),
      // Stage 3. The governed variants also exercise the policy binding, which
      // the agent re-checks against its own clock.
      'package.refresh': withDigest({ ...base, operation: 'package.refresh', parameters: { manager: 'apt' } }),
      'package.update': withDigest({
        ...base, operation: 'package.update',
        parameters: {
          manager: 'apt',
          packages: [{ name: 'curl', version: '8.5.0-2ubuntu10.6' }, { name: 'openssl', version: '3.0.13-0ubuntu3.5' }],
          securityOnly: true,
        },
      }),
      'kernel.update': withDigest({
        ...base, operation: 'kernel.update',
        parameters: { manager: 'apt', targetRelease: '6.8.0-51-generic' },
      }),
      // Stage 4. These carry a server-derived pre-state inside the parameters,
      // so the digest covers what the host looked like when it was reviewed.
      // Both sides have to canonicalise that identically or the agent rejects
      // every plan, which is precisely the failure only a deployed host finds.
      'network.configure': withDigest({
        ...base, operation: 'network.configure',
        parameters: {
          connection: 'lab-data', interface: 'eth1', method: 'manual',
          addresses: ['192.168.50.10/24'], dns: ['192.168.50.1'],
          searchDomains: ['lab.internal'], mtu: 9000, rollbackSeconds: 120,
        },
      }),
      'mount.configure': withDigest({
        ...base, operation: 'mount.configure',
        parameters: {
          filesystemUuid: '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c',
          mountPoint: '/srv/data', fsType: 'ext4',
        },
      }),
      'filesystem.grow': withDigest({
        ...base, operation: 'filesystem.grow', parameters: { mountPoint: '/srv/data' },
      }),
      'osimage.stage': withDigest({
        ...base, operation: 'osimage.stage',
        parameters: { adapter: 'bootc', image: `registry.example.com/polyon/os@sha256:${'b'.repeat(64)}` },
      }),
      'osimage.rollback': withDigest({
        ...base, operation: 'osimage.rollback', parameters: { adapter: 'bootc' },
      }),
      'ssh.protection.enable': withDigest({
        ...base, operation: 'ssh.protection.enable', parameters: {},
      }),
    };

    // The same three operations under a maintenance policy. A governed plan
    // hashes differently, so this proves both sides agree on that too.
    const governed = {
      policy_id: 'c0000000-0000-0000-0000-000000000001',
      policy_version: 3,
      policy_window_start: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      policy_window_end: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    for (const name of [
      'package.refresh', 'package.update', 'kernel.update', 'ssh.protection.enable',
    ]) {
      const row = { ...plans[name], ...governed };
      plans[`${name} (governed)`] = {
        ...row,
        content_digest: contentDigest(row.operation, row.parameters, {
          policyId: governed.policy_id, policyVersion: governed.policy_version,
        }),
      };
    }

    for (const [name, row] of Object.entries(plans)) {
      const file = path.join(work, `${name.replace(/[^a-z0-9.]/gi, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify(planFor(row, Date.now())));
      const output = execFileSync(binary, ['parse-plan', file, 'cc2', 'node-a'], { encoding: 'utf8' });
      assert.match(output, /^ACCEPTED/, `${name} plan was rejected by the agent: ${output}`);
      assert.match(output, new RegExp(`operation=${name.split(' ')[0].replace('.', '\\.')}`));

      // The same plan must be refused when it is for a different host.
      const wrong = spawnSync(binary, ['parse-plan', file, 'cc2', 'node-b'], { encoding: 'utf8' });
      assert.notEqual(wrong.status, 0, `${name} plan must not be accepted by another host`);
      assert.match(wrong.stdout, /REJECTED/);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a receipt the Go agent emits validates in the backend', { skip: !goAvailable() && 'go toolchain unavailable' }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-conf-'));
  try {
    const binary = path.join(work, 'conformance');
    execFileSync('go', ['build', '-o', binary, './cmd/conformance'], { cwd: agentRoot, stdio: 'pipe' });
    const raw = JSON.parse(execFileSync(binary, ['emit-receipt', OP_ID, DIGEST], { encoding: 'utf8' }));

    const api = validator();
    const row = {
      id: OP_ID,
      lease_attempt: raw.attempt,
      content_digest: DIGEST,
      operation: raw.operation,
      control_center_id: 'cc2',
      host: { host_id: 'node-a' },
    };
    const validated = api.validateReceipt(raw, row);
    assert.equal(validated.outcome, 'succeeded');
    assert.equal(validated.exitCode, 0);
    assert.ok(validated.output.includes('chronyd'), 'journal output must survive the round trip');
    // The stored result pins the identity the agent asserted.
    assert.equal(validated.controlCenterId, 'cc2');
    assert.equal(validated.hostId, 'node-a');
    assert.equal(validated.operation, raw.operation);
    assert.equal(validated.contentDigest, DIGEST);

    // Every bound field must be checked against real agent output, not just
    // the operation id: a receipt that names different work must not be filed
    // against this operation.
    const mutations = [
      [{ attempt: 9 }, 409],
      [{ contentDigest: `sha256:${'0'.repeat(64)}` }, 422],
      [{ controlCenterId: 'cc9' }, 422],
      [{ hostId: 'node-b' }, 422],
      [{ operation: 'host.reboot' }, 422],
      [{ operationId: '00000000-0000-4000-8000-000000000000' }, 422],
    ];
    for (const [mutation, code] of mutations) {
      assert.throws(
        () => api.validateReceipt({ ...raw, ...mutation }, row),
        (error) => error.code === code,
        `${JSON.stringify(mutation)} must be refused with ${code}`,
      );
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('no operation type issues a lease that outlives its own plan', () => {
  // A lease longer than the plan authorising it is a plan the agent refuses.
  // This is derived from the catalog rather than a list written here, because
  // the list-of-three version of this test passed while host.reboot was
  // undispatchable in Stage 3 and osimage.stage was undispatchable in Stage 4.
  const operations = catalogOperations();
  assert.ok(operations.size >= 11, `the catalog must be populated, found ${operations.size}`);
  const lifetime = Number(/MaxPlanLifetime = (\d+) \* time\.Minute/.exec(planGo)?.[1]);
  assert.ok(Number.isFinite(lifetime), 'the agent must declare a maximum plan lifetime');

  for (const operation of operations) {
    const plan = planFor({
      id: OP_ID,
      lease_attempt: 1,
      control_center_id: 'cc2',
      host_id: 'node-a',
      operation,
      content_digest: DIGEST,
      parameters: {},
      maintenance: {},
    }, Date.now());
    assert.ok(Date.parse(plan.leaseExpiresAt) <= Date.parse(plan.expiresAt),
      `${operation}: lease ${plan.leaseExpiresAt} outlives plan ${plan.expiresAt}`);
    assert.ok(Date.parse(plan.expiresAt) > Date.parse(plan.notBefore));
    // And the plan itself must be inside the bound the agent enforces, or the
    // agent refuses every plan for that operation and only a deployed host
    // finds out.
    const spanMinutes = (Date.parse(plan.expiresAt) - Date.parse(plan.notBefore)) / 60000;
    assert.ok(spanMinutes <= lifetime,
      `${operation}: plan spans ${spanMinutes} minutes, above the agent limit of ${lifetime}`);
  }
});

test('every lease the catalog grants fits inside the agent plan lifetime', () => {
  // The same guarantee stated against the deployed catalog rather than against
  // the backend's table, so the two cannot drift apart either.
  const baseline = fs.readFileSync(path.join(repoRoot, 'deploy/rcc/supabase-baseline.sql'), 'utf8');
  const lifetimeMinutes = Number(/MaxPlanLifetime = (\d+) \* time\.Minute/.exec(planGo)?.[1]);
  const seen = new Set();
  for (const block of baseline.matchAll(
    /INSERT INTO console\.host_operation_type[\s\S]*?VALUES([\s\S]*?)ON CONFLICT/g)) {
    for (const row of block[1].matchAll(/\('([a-z]+(?:\.[a-z]+)+)',[^)]*?,\s*(\d+),/g)) {
      seen.add(row[1]);
      assert.ok(Number(row[2]) <= lifetimeMinutes * 60,
        `${row[1]}: max_lease_seconds ${row[2]} exceeds the agent plan lifetime of ${lifetimeMinutes} minutes`);
      assert.equal(Number(row[2]), LEASE_SECONDS[row[1]],
        `${row[1]}: the catalog grants ${row[2]}s but the backend leases ${LEASE_SECONDS[row[1]]}s`);
    }
  }
  assert.ok(seen.size >= 11, `the catalog must declare a lease for every operation, found ${seen.size}`);
});
