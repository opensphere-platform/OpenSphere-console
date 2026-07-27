'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMaintenanceCoordinator, MAX_PODS } = require('./maintenance-coordinator');

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

function node(name, overrides = {}) {
  return {
    metadata: {
      name,
      labels: { 'kubernetes.io/hostname': name, ...(overrides.labels || {}) },
    },
    status: {
      conditions: [{ type: 'Ready', status: overrides.ready === false ? 'False' : 'True' },
        ...(overrides.conditions || [])],
      allocatable: overrides.allocatable === undefined
        ? { cpu: '8', memory: '16Gi' }
        : overrides.allocatable,
    },
    spec: {
      ...(overrides.unschedulable === undefined ? {} : { unschedulable: overrides.unschedulable }),
      ...(overrides.taints === undefined ? {} : { taints: overrides.taints }),
    },
  };
}

function controlPlaneNode(name, overrides = {}) {
  return node(name, {
    ...overrides,
    labels: { 'node-role.kubernetes.io/control-plane': '', ...(overrides.labels || {}) },
  });
}

/** A control-plane node that carries real etcd member evidence. */
function etcdNode(name, overrides = {}) {
  return controlPlaneNode(name, {
    ...overrides,
    labels: { 'node-role.kubernetes.io/etcd': 'true', ...(overrides.labels || {}) },
  });
}

/** The kubeadm shape: a static etcd pod rather than a label. */
function staticEtcdPod(nodeName) {
  return {
    metadata: {
      name: `etcd-${nodeName}`,
      namespace: 'kube-system',
      annotations: { 'kubernetes.io/config.mirror': 'abc' },
      ownerReferences: [],
    },
    spec: { nodeName, volumes: [] },
    status: { phase: 'Running' },
  };
}

function pod(name, overrides = {}) {
  return {
    metadata: {
      name,
      uid: overrides.uid || `uid-${name}`,
      namespace: overrides.namespace || 'default',
      labels: overrides.labels || { app: 'web' },
      ownerReferences: overrides.ownerReferences === undefined
        ? [{ kind: 'ReplicaSet', name: 'rs', uid: 'uid-rs' }]
        : overrides.ownerReferences,
      annotations: overrides.annotations || {},
    },
    spec: {
      volumes: overrides.volumes || [],
      nodeName: overrides.nodeName || 'node-a',
      containers: overrides.containers || [{ name: 'app', resources: { requests: overrides.requests || {} } }],
      ...(overrides.initContainers === undefined ? {} : { initContainers: overrides.initContainers }),
      ...(overrides.tolerations === undefined ? {} : { tolerations: overrides.tolerations }),
      ...(overrides.nodeSelector === undefined ? {} : { nodeSelector: overrides.nodeSelector }),
      ...(overrides.affinity === undefined ? {} : { affinity: overrides.affinity }),
      ...(overrides.topologySpreadConstraints === undefined
        ? {} : { topologySpreadConstraints: overrides.topologySpreadConstraints }),
      ...(overrides.schedulerName === undefined ? {} : { schedulerName: overrides.schedulerName }),
    },
    status: { phase: overrides.phase || 'Running' },
  };
}

function budget(overrides = {}) {
  return {
    metadata: {
      name: overrides.name || 'api',
      namespace: overrides.namespace || 'default',
      ...(overrides.generation === undefined ? {} : { generation: overrides.generation }),
    },
    spec: { selector: overrides.selector === undefined ? { matchLabels: { app: 'web' } } : overrides.selector },
    status: overrides.status === undefined
      ? { disruptionsAllowed: overrides.disruptionsAllowed ?? 0 }
      : overrides.status,
  };
}

/** A Ready stand-in that the controller started on another node. */
function replacementFor(original, nodeName = 'node-b') {
  return {
    metadata: {
      name: `${original.metadata.name}-repl`,
      uid: `uid-${original.metadata.name}-repl`,
      namespace: original.metadata.namespace,
      labels: original.metadata.labels,
      ownerReferences: original.metadata.ownerReferences,
      annotations: {},
    },
    spec: { volumes: [], nodeName, containers: [{ name: 'app', resources: { requests: {} } }] },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  };
}

/**
 * A client that models eviction actually completing: once a pod is evicted it
 * disappears from the node and its controller brings up a Ready replacement
 * elsewhere. Tests that need a stuck or partial drain override the pieces.
 */
function fakeClient(overrides = {}) {
  const calls = { cordon: [], evict: [], getPod: [] };
  const evicted = new Set();
  const onNode = overrides.listPodsOnNode || (async () => [pod('web-1')]);
  const evictionCompletes = overrides.evictionCompletes !== false;
  const replacementsAppear = overrides.replacementsAppear !== false;

  return {
    calls,
    evicted,
    listNodes: overrides.listNodes || (async () => [node('node-a'), node('node-b'), node('node-c')]),
    listPodsOnNode: onNode,
    listPodDisruptionBudgets: overrides.listPodDisruptionBudgets || (async () => []),
    listPodsInNamespace: overrides.listPodsInNamespace || (async () => []),
    listAllPods: overrides.listAllPods || (async () => {
      if (!replacementsAppear) return [];
      const originals = await onNode();
      return originals
        .filter((entry) => evicted.has(`${entry.metadata.namespace}/${entry.metadata.name}`))
        .map((entry) => replacementFor(entry));
    }),
    getPod: overrides.getPod || (async (namespace, name) => {
      calls.getPod.push(`${namespace}/${name}`);
      if (evictionCompletes && evicted.has(`${namespace}/${name}`)) return null;
      const originals = await onNode();
      return originals.find((entry) => entry.metadata.namespace === namespace
        && entry.metadata.name === name) || null;
    }),
    patchNodeUnschedulable: overrides.patchNodeUnschedulable || (async (name, value) => {
      calls.cordon.push({ name, value });
    }),
    evictPod: overrides.evictPod || (async (namespace, name) => {
      if (overrides.refuseEviction?.(namespace, name)) {
        throw { code: 429, msg: 'disruption budget' };
      }
      calls.evict.push(`${namespace}/${name}`);
      evicted.add(`${namespace}/${name}`);
    }),
  };
}

function build(overrides = {}) {
  const client = fakeClient(overrides);
  return {
    client,
    coordinator: createMaintenanceCoordinator({
      client,
      now: () => NOW,
      // Most fixtures are plain worker clusters; the etcd tests override this.
      etcdTopology: overrides.etcdTopology === undefined ? 'stacked' : overrides.etcdTopology,
      // The manifest declares these; most fixtures use the operational answers.
      drainPolicy: overrides.drainPolicy === undefined
        ? { daemonSetPods: 'leave-in-place', staticPods: 'leave-in-place', emptyDirData: 'accept-data-loss' }
        : overrides.drainPolicy,
      // Poll immediately in tests; the bound is attempts, not wall-clock.
      sleep: async () => {},
      drainTimeoutMs: overrides.drainTimeoutMs ?? 60,
      pollIntervalMs: overrides.pollIntervalMs ?? 20,
    }),
  };
}

test('resolves a host to exactly one node', async () => {
  const { coordinator } = build();
  const resolved = await coordinator.resolveNode('node-a', 'node-a.cc2.example');
  assert.equal(resolved.metadata.name, 'node-a');
});

test('resolves via the reported snapshot hostname when names differ', async () => {
  const { coordinator } = build({
    listNodes: async () => [node('worker-1', { labels: { 'kubernetes.io/hostname': 'worker-1' } })],
  });
  const resolved = await coordinator.resolveNode('host-alpha', 'worker-1.internal');
  assert.equal(resolved.metadata.name, 'worker-1');
});

test('refuses when a host maps to no node', async () => {
  const { coordinator } = build({ listNodes: async () => [node('other')] });
  await assert.rejects(() => coordinator.resolveNode('node-a', ''), (e) => e.code === 409);
});

test('refuses to guess when a host matches several nodes', async () => {
  const { coordinator } = build({
    listNodes: async () => [
      node('node-a'),
      { metadata: { name: 'dup', labels: { 'kubernetes.io/hostname': 'node-a' } }, status: { conditions: [] } },
    ],
  });
  await assert.rejects(() => coordinator.resolveNode('node-a', ''), (e) => /refusing to guess/.test(e.msg));
});

test('a single-node cluster refuses normal reboot preparation', async () => {
  const { coordinator } = build({ listNodes: async () => [controlPlaneNode('only')] });
  const findings = await coordinator.preflight('only', '');
  assert.equal(findings.allowed, false);
  const codes = findings.blocking.map((entry) => entry.code);
  assert.ok(codes.includes('single-node-cluster'), JSON.stringify(codes));
  assert.ok(codes.includes('sole-control-plane'), JSON.stringify(codes));
});

test('no option makes a single-node reboot possible', async () => {
  // CC2 is a single-node cluster. There is deliberately no breakglass: a lone
  // administrator must not be able to talk the system into rebooting the only
  // node, because nothing would be left to move the workloads onto.
  const attempts = [
    {},
    { etcdTopology: 'external' },
    { etcdTopology: 'stacked' },
    { force: true, allowSingleNode: true, breakglass: true, skipPreflight: true },
  ];
  for (const attempt of attempts) {
    const client = fakeClient({ listNodes: async () => [etcdNode('cc2')] });
    const coordinator = createMaintenanceCoordinator({ client, now: () => NOW, ...attempt });
    const findings = await coordinator.preflight('cc2', '');
    assert.equal(findings.allowed, false, `options ${JSON.stringify(attempt)} must not permit it`);
    assert.ok(findings.blocking.some((entry) => entry.code === 'single-node-cluster'));

    // And preparation must not touch the cluster at all.
    const result = await coordinator.prepare('cc2', '');
    assert.equal(result.prepared, false);
    assert.deepEqual(client.calls.cordon, [], 'a refused single-node reboot must not cordon');
    assert.deepEqual(client.calls.evict, [], 'a refused single-node reboot must not evict');
  }
});

test('a blocking finding is never cleared by anything but its cause', async () => {
  // `allowed` is derived from the blocking list; there is no separate flag an
  // operator or a caller could flip.
  const source = require('node:fs').readFileSync(require.resolve('./maintenance-coordinator.js'), 'utf8');
  const assignments = source.match(/allowed:[^,\n]*/g) || [];
  assert.deepEqual(assignments, ['allowed: blocking.length === 0'],
    `allowed must have exactly one derivation, found: ${JSON.stringify(assignments)}`);
});

test('rebooting the only control-plane node is refused', async () => {
  const { coordinator } = build({
    listNodes: async () => [controlPlaneNode('cp-1'), node('w-1'), node('w-2')],
  });
  const findings = await coordinator.preflight('cp-1', '');
  assert.equal(findings.allowed, false);
  assert.ok(findings.blocking.some((entry) => entry.code === 'sole-control-plane'));
});

test('a reboot that would break etcd quorum is refused', async () => {
  // Three etcd members, one already down: rebooting another leaves one.
  const { coordinator } = build({
    listNodes: async () => [
      etcdNode('cp-1'), etcdNode('cp-2'), etcdNode('cp-3', { ready: false }), node('w-1'),
    ],
  });
  const findings = await coordinator.preflight('cp-1', '');
  assert.equal(findings.allowed, false);
  const quorum = findings.blocking.find((entry) => entry.code === 'etcd-quorum');
  assert.ok(quorum, JSON.stringify(findings.blocking));
  assert.match(quorum.detail, /below the quorum/);
});

test('a healthy control-plane reboot with quorum to spare is allowed', async () => {
  const { coordinator } = build({
    listNodes: async () => [etcdNode('cp-1'), etcdNode('cp-2'), etcdNode('cp-3'), node('w-1')],
  });
  const findings = await coordinator.preflight('cp-1', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
  assert.equal(findings.controlPlane, true);
  assert.deepEqual(findings.etcd.members, ['cp-1', 'cp-2', 'cp-3']);
  assert.equal(findings.etcd.memberOfCluster, true);
});

test('an undeclared etcd topology refuses a control-plane reboot rather than guessing', async () => {
  const { coordinator } = build({
    etcdTopology: '',
    listNodes: async () => [etcdNode('cp-1'), etcdNode('cp-2'), etcdNode('cp-3'), node('w-1')],
  });
  const findings = await coordinator.preflight('cp-1', '');
  assert.equal(findings.allowed, false);
  const unknown = findings.blocking.find((entry) => entry.code === 'etcd-topology-unknown');
  assert.ok(unknown, JSON.stringify(findings.blocking));
  assert.match(unknown.detail, /RCC_ETCD_TOPOLOGY/);
});

test('an undeclared topology does not obstruct a plain worker reboot', async () => {
  const { coordinator } = build({ etcdTopology: '' });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
});

test('the control-plane label alone is not treated as etcd membership', async () => {
  // Declared stacked, but nothing in the cluster shows a member. Counting
  // labels here would have produced a confident and wrong quorum of 2.
  const { coordinator } = build({
    listNodes: async () => [
      controlPlaneNode('cp-1'), controlPlaneNode('cp-2'), controlPlaneNode('cp-3'), node('w-1'),
    ],
  });
  const findings = await coordinator.preflight('cp-1', '');
  assert.equal(findings.allowed, false);
  assert.ok(findings.blocking.some((entry) => entry.code === 'etcd-topology-contradiction'),
    JSON.stringify(findings.blocking));
});

test('kubeadm stacked etcd is discovered from its static pod', async () => {
  const { coordinator } = build({
    listNodes: async () => [
      controlPlaneNode('cp-1'), controlPlaneNode('cp-2'), controlPlaneNode('cp-3'), node('w-1'),
    ],
    listPodsInNamespace: async () => ['cp-1', 'cp-2', 'cp-3'].map(staticEtcdPod),
  });
  const findings = await coordinator.preflight('cp-1', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
  assert.deepEqual(findings.etcd.members, ['cp-1', 'cp-2', 'cp-3']);
  assert.match(findings.etcd.memberEvidence['cp-1'], /static pod etcd-cp-1/);
});

test('external etcd leaves quorum untouched but must not contradict the cluster', async () => {
  const clean = build({
    etcdTopology: 'external',
    listNodes: async () => [controlPlaneNode('cp-1'), controlPlaneNode('cp-2'), node('w-1')],
  });
  const allowed = await clean.coordinator.preflight('cp-1', '');
  assert.equal(allowed.allowed, true, JSON.stringify(allowed.blocking));
  assert.equal(allowed.etcd.topology, 'external');

  const contradicted = build({
    etcdTopology: 'external',
    listNodes: async () => [etcdNode('cp-1'), etcdNode('cp-2'), etcdNode('cp-3'), node('w-1')],
  });
  const refused = await contradicted.coordinator.preflight('cp-1', '');
  assert.equal(refused.allowed, false);
  assert.ok(refused.blocking.some((entry) => entry.code === 'etcd-topology-contradiction'));
});

test('the last etcd member is never rebootable', async () => {
  const { coordinator } = build({
    listNodes: async () => [etcdNode('cp-1'), node('w-1'), node('w-2')],
  });
  const findings = await coordinator.preflight('cp-1', '');
  assert.equal(findings.allowed, false);
  assert.ok(findings.blocking.some((entry) => entry.code === 'sole-etcd-member'),
    JSON.stringify(findings.blocking));
});

test('an API-server-only control-plane node does not consume etcd quorum', async () => {
  const { coordinator } = build({
    listNodes: async () => [
      // Three real members plus a fourth control-plane node with no etcd.
      etcdNode('cp-1'), etcdNode('cp-2'), etcdNode('cp-3'), controlPlaneNode('api-4'), node('w-1'),
    ],
  });
  const findings = await coordinator.preflight('api-4', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
  assert.equal(findings.etcd.memberOfCluster, false);
});

test('an even etcd membership is flagged without blocking', async () => {
  const { coordinator } = build({
    listNodes: async () => [etcdNode('cp-1'), etcdNode('cp-2'), etcdNode('cp-3'), etcdNode('cp-4'), node('w-1')],
  });
  const findings = await coordinator.preflight('cp-1', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
  assert.ok(findings.warnings.some((entry) => entry.code === 'etcd-even-membership'));
});

test('a NotReady node is refused', async () => {
  const { coordinator } = build({
    listNodes: async () => [node('node-a', { ready: false }), node('node-b'), node('node-c')],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, false);
  assert.ok(findings.blocking.some((entry) => entry.code === 'node-not-ready'));
});

test('node pressure is reported as a warning, not a block', async () => {
  const { coordinator } = build({
    listNodes: async () => [
      node('node-a', { conditions: [{ type: 'DiskPressure', status: 'True' }] }),
      node('node-b'), node('node-c'),
    ],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, true);
  assert.ok(findings.warnings.some((entry) => entry.code === 'node-pressure'));
  assert.deepEqual(findings.pressures, ['DiskPressure']);
});

test('a PodDisruptionBudget covering an evicted pod refuses the drain', async () => {
  const { coordinator } = build({
    listPodDisruptionBudgets: async () => [budget({ disruptionsAllowed: 0 })],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, false);
  const blocked = findings.blocking.find((entry) => entry.code === 'pdb-blocked');
  assert.ok(blocked, JSON.stringify(findings.blocking));
  // The evidence must name the pod, so an approver can see what is at stake.
  assert.match(blocked.detail, /default\/web-1/);
});

test('a saturated but unrelated PodDisruptionBudget does not block the drain', async () => {
  const { coordinator } = build({
    listPodDisruptionBudgets: async () => [
      // Right selector, wrong namespace.
      budget({ namespace: 'prod', disruptionsAllowed: 0 }),
      // Right namespace, selector matches nothing on this node.
      budget({ name: 'db', selector: { matchLabels: { app: 'postgres' } }, disruptionsAllowed: 0 }),
      // Right namespace, excluded by a matchExpression.
      budget({
        name: 'batch',
        selector: { matchExpressions: [{ key: 'app', operator: 'NotIn', values: ['web'] }] },
        disruptionsAllowed: 0,
      }),
      // Right namespace and selector, but it still has room.
      budget({ name: 'roomy', disruptionsAllowed: 2 }),
    ],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
});

test('a PodDisruptionBudget that cannot be evaluated fails closed', async () => {
  const unevaluable = [
    // An operator this coordinator does not implement.
    budget({ selector: { matchExpressions: [{ key: 'app', operator: 'Gt', values: ['1'] }] } }),
    // An absent selector: policy/v1 reads this differently from an empty one.
    budget({ selector: null }),
    // A status that has not caught up with the spec describes the old budget.
    budget({ generation: 4, status: { observedGeneration: 3, disruptionsAllowed: 5 } }),
    // No disruptionsAllowed reported at all.
    budget({ status: {} }),
  ];
  for (const entry of unevaluable) {
    const { coordinator } = build({ listPodDisruptionBudgets: async () => [entry] });
    const findings = await coordinator.preflight('node-a', '');
    assert.equal(findings.allowed, false, JSON.stringify(entry));
    assert.ok(findings.blocking.some((finding) => finding.code === 'pdb-unknown'),
      `expected pdb-unknown for ${JSON.stringify(entry)}`);
  }
});

test('an empty selector covers every pod in its namespace', async () => {
  const { coordinator } = build({
    listPodDisruptionBudgets: async () => [budget({ selector: {}, disruptionsAllowed: 0 })],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, false);
  assert.ok(findings.blocking.some((entry) => entry.code === 'pdb-blocked'));
});

test('an unmanaged pod refuses the drain because nothing would reschedule it', async () => {
  const { coordinator } = build({
    listPodsOnNode: async () => [pod('orphan', { ownerReferences: [] })],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, false);
  assert.ok(findings.blocking.some((entry) => entry.code === 'unmanaged-pod'));
});

test('DaemonSet, mirror and terminal pods are not counted as evictable', async () => {
  const { coordinator } = build({
    listPodsOnNode: async () => [
      pod('ds', { ownerReferences: [{ kind: 'DaemonSet', name: 'node-exporter' }] }),
      pod('static', { annotations: { 'kubernetes.io/config.mirror': 'x' } }),
      pod('done', { phase: 'Succeeded' }),
      pod('web-1'),
    ],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.deepEqual(findings.evictable.map((entry) => entry.name), ['web-1']);
  // What stays behind is named, not silently dropped.
  assert.deepEqual(findings.leftInPlace.map((entry) => entry.pod).sort(),
    ['default/ds', 'default/static']);
});

test('pods that cannot be evicted refuse the drain until policy declares otherwise', async () => {
  const cases = [
    ['daemonset-pod', pod('ds', { ownerReferences: [{ kind: 'DaemonSet', name: 'n' }] })],
    ['static-pod', pod('static', { annotations: { 'kubernetes.io/config.mirror': 'x' } })],
    ['local-storage-data', pod('cache', { volumes: [{ emptyDir: {} }] })],
  ];
  for (const [code, subject] of cases) {
    // An undeclared policy refuses.
    const strict = build({ drainPolicy: {}, listPodsOnNode: async () => [subject] });
    const refused = await strict.coordinator.preflight('node-a', '');
    assert.equal(refused.allowed, false, code);
    const finding = refused.blocking.find((entry) => entry.code === code);
    assert.ok(finding, `${code}: ${JSON.stringify(refused.blocking)}`);
    // The refusal says exactly which declaration would change the answer.
    assert.match(finding.detail, /RCC_DRAIN_/);

    // A nonsense declaration is not a declaration.
    const nonsense = build({
      drainPolicy: { daemonSetPods: 'yes', staticPods: 'true', emptyDirData: 'whatever' },
      listPodsOnNode: async () => [subject],
    });
    const stillRefused = await nonsense.coordinator.preflight('node-a', '');
    assert.equal(stillRefused.allowed, false, `${code} must not accept a junk policy value`);
  }
});

test('an unmanaged pod can never be waved through by policy', async () => {
  for (const drainPolicy of [{}, { unmanagedPods: 'accept-loss' }, { unmanagedPods: 'leave-in-place' }]) {
    const { coordinator } = build({
      drainPolicy,
      listPodsOnNode: async () => [pod('orphan', { ownerReferences: [] })],
    });
    const findings = await coordinator.preflight('node-a', '');
    assert.equal(findings.allowed, false);
    assert.ok(findings.blocking.some((entry) => entry.code === 'unmanaged-pod'));
  }
});

test('a hostPath mount is never movable, whatever the policy says', async () => {
  const { coordinator } = build({
    drainPolicy: { emptyDirData: 'accept-data-loss', daemonSetPods: 'leave-in-place', staticPods: 'leave-in-place' },
    listPodsOnNode: async () => [pod('pinned', { volumes: [{ hostPath: { path: '/var/lib/data' } }] })],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, false);
  const finding = findings.blocking.find((entry) => entry.code === 'node-pinned-storage');
  assert.ok(finding, JSON.stringify(findings.blocking));
  assert.match(finding.detail, /\/var\/lib\/data/);
});

test('a memory-backed emptyDir holds no data to lose', async () => {
  const { coordinator } = build({
    drainPolicy: {},
    listPodsOnNode: async () => [pod('tmpfs', { volumes: [{ emptyDir: { medium: 'Memory' } }] })],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
});

test('emptyDir data loss is allowed only once policy has accepted it', async () => {
  const { coordinator } = build({
    drainPolicy: { emptyDirData: 'accept-data-loss' },
    listPodsOnNode: async () => [pod('cache', { volumes: [{ emptyDir: {} }] })],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
  assert.ok(findings.warnings.some((entry) => entry.code === 'local-storage'));
  assert.equal(findings.drainPolicy.emptyDirData, 'accept-data-loss');
});

test('no remaining Ready node refuses the reboot', async () => {
  const { coordinator } = build({
    listNodes: async () => [node('node-a'), node('node-b', { ready: false })],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, false);
  assert.ok(findings.blocking.some((entry) => entry.code === 'no-capacity'));
});

test('an oversized node is refused rather than partially drained', async () => {
  const many = Array.from({ length: MAX_PODS + 1 }, (_, i) => pod(`p-${i}`));
  const { coordinator } = build({ listPodsOnNode: async () => many });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, false);
  assert.ok(findings.blocking.some((entry) => entry.code === 'too-many-pods'));
});

test('prepare cordons then drains through the eviction API', async () => {
  const { client, coordinator } = build({
    listPodsOnNode: async () => [pod('web-1'), pod('web-2')],
  });
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, true);
  assert.deepEqual(client.calls.cordon, [{ name: 'node-a', value: true }]);
  assert.deepEqual(client.calls.evict, ['default/web-1', 'default/web-2']);
});

test('a refused preflight never cordons the node', async () => {
  const { client, coordinator } = build({
    listNodes: async () => [node('node-a', { ready: false }), node('node-b')],
  });
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, false);
  assert.deepEqual(client.calls.cordon, [], 'a refused reboot must not touch the cluster');
});

test('an eviction refused by a budget uncordons the node again', async () => {
  const { client, coordinator } = build({
    listPodsOnNode: async () => [pod('web-1')],
    evictPod: async () => { throw { code: 429, msg: 'disruption budget' }; },
  });
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, false);
  assert.equal(result.drain.drained, false);
  assert.match(result.drain.refused[0].reason, /PodDisruptionBudget/);
  // Cordon then uncordon: the cluster must not be left degraded.
  assert.deepEqual(client.calls.cordon, [
    { name: 'node-a', value: true },
    { name: 'node-a', value: false },
  ]);
});

test('an unexpected drain error also restores scheduling', async () => {
  const { client, coordinator } = build({
    listPodsOnNode: async () => [pod('web-1')],
    patchNodeUnschedulable: async (name, value) => {
      client.calls.cordon.push({ name, value });
    },
  });
  // Make eviction throw a non-eviction error path by breaking the client after cordon.
  const original = coordinator.drain;
  const failing = createMaintenanceCoordinator({
    client: { ...client, evictPod: async () => { throw new Error('api server down'); } },
    now: () => NOW,
  });
  assert.ok(typeof original === 'function');
  const result = await failing.prepare('node-a', '');
  // A thrown eviction is captured as a refusal, so preparation fails cleanly.
  assert.equal(result.prepared, false);
});

test('uncordon is idempotent and restores scheduling', async () => {
  const { client, coordinator } = build();
  await coordinator.uncordon('node-a');
  await coordinator.uncordon('node-a');
  assert.deepEqual(client.calls.cordon, [
    { name: 'node-a', value: false },
    { name: 'node-a', value: false },
  ]);
});

test('an unreadable cluster fails closed rather than allowing the reboot', async () => {
  for (const broken of [
    { listNodes: async () => null },
    { listPodsOnNode: async () => null },
    { listPodDisruptionBudgets: async () => null },
  ]) {
    const { coordinator } = build(broken);
    await assert.rejects(() => coordinator.preflight('node-a', ''), (e) => e.code === 503 || e.code === 409);
  }
});

test('preflight records evidence an approver can review', async () => {
  const { coordinator } = build();
  const findings = await coordinator.preflight('node-a', '');
  for (const key of ['node', 'ready', 'controlPlane', 'nodeCount', 'readyWorkerCount',
    'controlPlaneCount', 'podCount', 'evictable', 'blocking', 'warnings', 'allowed', 'checkedAt']) {
    assert.ok(key in findings, `evidence is missing ${key}`);
  }
  assert.equal(findings.checkedAt, new Date(NOW).toISOString());
});

test('the coordinator never deletes pods directly', () => {
  const source = require('node:fs').readFileSync(require.resolve('./maintenance-coordinator.js'), 'utf8');
  // Deleting a pod bypasses PodDisruptionBudgets; only eviction is permitted.
  assert.doesNotMatch(source, /method:\s*'DELETE'/);
  assert.match(source, /\/eviction/);
});

test('the in-cluster client exposes no general Kubernetes proxy', () => {
  const source = require('node:fs').readFileSync(require.resolve('./maintenance-coordinator.js'), 'utf8');
  for (const forbidden of ['/secrets', '/exec', '/attach', '/portforward']) {
    assert.ok(!source.includes(forbidden), `${forbidden} must not be reachable`);
  }
});

// ── E3: capacity is simulated, not assumed ───────────────────────────────────

test('a Ready node that is already full cannot receive the workload', async () => {
  const { coordinator } = build({
    listNodes: async () => [
      node('node-a'),
      node('node-b', { allocatable: { cpu: '4', memory: '8Gi' } }),
    ],
    listPodsOnNode: async () => [pod('big', { requests: { cpu: '2', memory: '6Gi' } })],
    // node-b looks Ready and idle, but is already committed to 7Gi.
    listAllPods: async () => [
      pod('resident', { nodeName: 'node-b', requests: { cpu: '1', memory: '7Gi' } }),
    ],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, false);
  const finding = findings.blocking.find((entry) => entry.code === 'insufficient-capacity');
  assert.ok(finding, JSON.stringify(findings.blocking));
  assert.match(finding.detail, /default\/big/);
  assert.match(finding.detail, /node-b: insufficient capacity/);
});

test('a workload that genuinely fits is allowed, with the placement recorded', async () => {
  const { coordinator } = build({
    listNodes: async () => [node('node-a'), node('node-b', { allocatable: { cpu: '4', memory: '8Gi' } })],
    listPodsOnNode: async () => [pod('web-1', { requests: { cpu: '500m', memory: '1Gi' } })],
    listAllPods: async () => [pod('resident', { nodeName: 'node-b', requests: { cpu: '1', memory: '2Gi' } })],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
  assert.deepEqual(findings.capacity.placements, [{ pod: 'default/web-1', node: 'node-b' }]);
  // 4 cores minus 1 committed minus 500m placed.
  assert.equal(findings.capacity.remaining['node-b'].cpu, 2500);
});

test('a cordoned node is not counted as available capacity', async () => {
  const { coordinator } = build({
    listNodes: async () => [node('node-a'), node('node-b', { unschedulable: true })],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, false);
  const finding = findings.blocking.find((entry) => entry.code === 'no-capacity');
  assert.ok(finding, JSON.stringify(findings.blocking));
  assert.match(finding.detail, /node-b is cordoned/);
});

test('a taint the pod does not tolerate excludes that node', async () => {
  const taints = [{ key: 'dedicated', value: 'gpu', effect: 'NoSchedule' }];
  const untolerated = build({
    listNodes: async () => [node('node-a'), node('node-b', { taints })],
  });
  const refused = await untolerated.coordinator.preflight('node-a', '');
  assert.equal(refused.allowed, false);
  assert.ok(refused.blocking.some((entry) => /taint dedicated=gpu:NoSchedule/.test(entry.detail)),
    JSON.stringify(refused.blocking));

  const tolerated = build({
    listNodes: async () => [node('node-a'), node('node-b', { taints })],
    listPodsOnNode: async () => [pod('web-1', {
      tolerations: [{ key: 'dedicated', operator: 'Equal', value: 'gpu', effect: 'NoSchedule' }],
    })],
  });
  const allowed = await tolerated.coordinator.preflight('node-a', '');
  assert.equal(allowed.allowed, true, JSON.stringify(allowed.blocking));
});

test('an unrecognised taint effect or toleration operator fails closed', async () => {
  const badEffect = build({
    listNodes: async () => [node('node-a'), node('node-b', { taints: [{ key: 'k', effect: 'NoIdea' }] })],
  });
  const first = await badEffect.coordinator.preflight('node-a', '');
  assert.equal(first.allowed, false);
  assert.ok(first.blocking.some((entry) => entry.code === 'schedulability-unknown'));

  const badOperator = build({
    listNodes: async () => [
      node('node-a'),
      node('node-b', { taints: [{ key: 'k', value: 'v', effect: 'NoSchedule' }] }),
    ],
    listPodsOnNode: async () => [pod('web-1', { tolerations: [{ key: 'k', operator: 'Matches' }] })],
  });
  const second = await badOperator.coordinator.preflight('node-a', '');
  assert.equal(second.allowed, false);
  assert.ok(second.blocking.some((entry) => entry.code === 'schedulability-unknown'));
});

test('PreferNoSchedule is not treated as a barrier', async () => {
  const { coordinator } = build({
    listNodes: async () => [node('node-a'), node('node-b', { taints: [{ key: 'k', effect: 'PreferNoSchedule' }] })],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
});

test('a nodeSelector the remaining nodes do not satisfy refuses the reboot', async () => {
  const { coordinator } = build({
    listNodes: async () => [node('node-a', { labels: { tier: 'fast' } }), node('node-b')],
    listPodsOnNode: async () => [pod('web-1', { nodeSelector: { tier: 'fast' } })],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, false);
  assert.ok(findings.blocking.some((entry) => /node-b: nodeSelector/.test(entry.detail)),
    JSON.stringify(findings.blocking));
});

test('scheduling constraints that cannot be simulated fail closed', async () => {
  const cases = [
    ['required node affinity', { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: {} } } }],
    ['required pod anti-affinity', { affinity: { podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{}] } } }],
    ['a topology spread constraint', { topologySpreadConstraints: [{ whenUnsatisfiable: 'DoNotSchedule' }] }],
    ['the custom scheduler', { schedulerName: 'volcano' }],
  ];
  for (const [expected, overrides] of cases) {
    const { coordinator } = build({ listPodsOnNode: async () => [pod('web-1', overrides)] });
    const findings = await coordinator.preflight('node-a', '');
    assert.equal(findings.allowed, false, expected);
    const finding = findings.blocking.find((entry) => entry.code === 'schedulability-unknown');
    assert.ok(finding, `${expected}: ${JSON.stringify(findings.blocking)}`);
    assert.match(finding.detail, new RegExp(expected));
  }
});

test('a soft constraint is simulated rather than refused', async () => {
  const { coordinator } = build({
    listPodsOnNode: async () => [pod('web-1', {
      affinity: { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 1 }] } },
      topologySpreadConstraints: [{ whenUnsatisfiable: 'ScheduleAnyway' }],
    })],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
});

test('unreadable capacity inputs fail closed instead of counting as zero', async () => {
  const cases = [
    ['unparseable allocatable', { listNodes: async () => [node('node-a'), node('node-b', { allocatable: { cpu: '4', memory: 'lots' } })] }],
    ['missing allocatable', { listNodes: async () => [node('node-a'), node('node-b', { allocatable: {} })] }],
    ['unparseable pod request', { listPodsOnNode: async () => [pod('web-1', { requests: { memory: '512 MB' } })] }],
    ['unparseable resident request', { listAllPods: async () => [pod('r', { nodeName: 'node-b', requests: { cpu: '-1' } })] }],
  ];
  for (const [label, overrides] of cases) {
    const { coordinator } = build(overrides);
    const findings = await coordinator.preflight('node-a', '');
    assert.equal(findings.allowed, false, label);
    assert.ok(findings.blocking.some((entry) => entry.code === 'capacity-unknown'),
      `${label}: ${JSON.stringify(findings.blocking)}`);
  }
});

test('a client that cannot report cluster pods fails closed', async () => {
  const client = fakeClient();
  delete client.listAllPods;
  const coordinator = createMaintenanceCoordinator({ client, now: () => NOW, etcdTopology: 'stacked' });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, false);
  assert.ok(findings.blocking.some((entry) => entry.code === 'capacity-unknown'));
});

test('the largest pod is placed first so greedy packing does not mislead', async () => {
  // Two pods needing 6Gi and 3Gi; two nodes with 7Gi and 4Gi free. Placing the
  // small pod first would put it on the 7Gi node and strand the large one.
  const { coordinator } = build({
    listNodes: async () => [
      node('node-a'),
      node('node-b', { allocatable: { cpu: '8', memory: '7Gi' } }),
      node('node-c', { allocatable: { cpu: '8', memory: '4Gi' } }),
    ],
    listPodsOnNode: async () => [
      pod('small', { requests: { memory: '3Gi' } }),
      pod('large', { requests: { memory: '6Gi' } }),
    ],
  });
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
  const placed = Object.fromEntries(findings.capacity.placements.map((p) => [p.pod, p.node]));
  assert.equal(placed['default/large'], 'node-b');
  assert.equal(placed['default/small'], 'node-c');
});

test('init containers and sidecars are accounted the way the scheduler does', async () => {
  // A plain init container that is larger than the app dominates the request.
  const initHeavy = build({
    listNodes: async () => [node('node-a'), node('node-b', { allocatable: { cpu: '8', memory: '5Gi' } })],
    listPodsOnNode: async () => [pod('web-1', {
      requests: { memory: '1Gi' },
      initContainers: [{ name: 'migrate', resources: { requests: { memory: '6Gi' } } }],
    })],
  });
  const refused = await initHeavy.coordinator.preflight('node-a', '');
  assert.equal(refused.allowed, false, JSON.stringify(refused.blocking));

  // A restartable init container is a sidecar: it adds instead of dominating.
  const sidecar = build({
    listNodes: async () => [node('node-a'), node('node-b', { allocatable: { cpu: '8', memory: '5Gi' } })],
    listPodsOnNode: async () => [pod('web-1', {
      requests: { memory: '3Gi' },
      initContainers: [{ name: 'proxy', restartPolicy: 'Always', resources: { requests: { memory: '3Gi' } } }],
    })],
  });
  const alsoRefused = await sidecar.coordinator.preflight('node-a', '');
  assert.equal(alsoRefused.allowed, false, '3Gi + 3Gi must not fit in 5Gi');
});

test('a pod with no requests is placed but flagged', async () => {
  const { coordinator } = build();
  const findings = await coordinator.preflight('node-a', '');
  assert.equal(findings.allowed, true, JSON.stringify(findings.blocking));
  assert.ok(findings.warnings.some((entry) => entry.code === 'no-requests'));
});

// ── E4: an accepted eviction is not a completed one ──────────────────────────

test('a drain waits for pods to actually leave before reporting success', async () => {
  const { client, coordinator } = build();
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, true, JSON.stringify(result.blocking || result.drain));
  assert.equal(result.drain.drained, true);
  assert.equal(result.drain.replacementsReady, true);
  // It confirmed departure by reading the pod back, not by trusting the POST.
  assert.ok(client.calls.getPod.includes('default/web-1'),
    'the drain must verify the pod left rather than trust the eviction call');
});

test('a pod that never leaves fails the drain instead of proceeding', async () => {
  const { client, coordinator } = build({ evictionCompletes: false });
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, false);
  assert.equal(result.drain.drained, false);
  assert.match(result.drain.refused[0].reason, /accepted but the pod is still on this node/);
  // And the node is put back so the cluster is not left degraded.
  assert.deepEqual(client.calls.cordon, [
    { name: 'node-a', value: true },
    { name: 'node-a', value: false },
  ]);
});

test('a drain with no Ready replacement anywhere fails closed', async () => {
  const { coordinator } = build({ replacementsAppear: false });
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, false);
  assert.equal(result.drain.replacementsReady, false);
  assert.match(result.drain.refused[0].reason, /no replacement became Ready on another node/);
});

test('a replacement that exists but is not Ready does not count', async () => {
  const original = pod('web-1');
  const { coordinator } = build({
    listPodsOnNode: async () => [original],
    listAllPods: async () => {
      const notReady = replacementFor(original);
      notReady.status.conditions = [{ type: 'Ready', status: 'False' }];
      return [notReady];
    },
  });
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, false);
  assert.match(result.drain.refused[0].reason, /no replacement became Ready/);
});

test('a replacement on the node being drained does not count', async () => {
  const original = pod('web-1');
  const { coordinator } = build({
    listPodsOnNode: async () => [original],
    // Same controller, Ready, but still on the node we are trying to empty.
    listAllPods: async () => [replacementFor(original, 'node-a')],
  });
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, false);
  assert.match(result.drain.refused[0].reason, /no replacement became Ready/);
});

test('a partial drain is a failure, not a partial success', async () => {
  const { coordinator } = build({
    listPodsOnNode: async () => [pod('web-1'), pod('web-2')],
    refuseEviction: (namespace, name) => name === 'web-2',
  });
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, false);
  assert.equal(result.drain.drained, false);
  assert.equal(result.drain.refused.length, 1);
  assert.match(result.drain.refused[0].pod, /web-2/);
});

test('the drain gives up rather than polling forever', async () => {
  let polls = 0;
  const { coordinator } = build({
    drainTimeoutMs: 100,
    pollIntervalMs: 10,
    getPod: async () => { polls += 1; return pod('web-1'); },
  });
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, false);
  // ceil(100/10) attempts plus the initial check.
  assert.ok(polls > 1 && polls <= 12, `bounded polling expected, saw ${polls}`);
});

test('a pod recreated elsewhere under a new uid counts as gone', async () => {
  const original = pod('db-0');
  const { coordinator } = build({
    listPodsOnNode: async () => [original],
    // A StatefulSet replacement keeps the name and changes the uid.
    getPod: async () => ({
      ...original,
      metadata: { ...original.metadata, uid: 'uid-db-0-new' },
      spec: { ...original.spec, nodeName: 'node-b' },
    }),
    listAllPods: async () => [{
      ...original,
      metadata: { ...original.metadata, uid: 'uid-db-0-new' },
      spec: { ...original.spec, nodeName: 'node-b' },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    }],
  });
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, true, JSON.stringify(result.drain));
});

// ── E6: a failed uncordon is evidence, not a swallowed error ─────────────────

test('a failed uncordon is reported as degraded rather than ignored', async () => {
  const { coordinator } = build({
    evictionCompletes: false,
    patchNodeUnschedulable: async (name, value) => {
      if (value === false) throw { code: 500, msg: 'apiserver unavailable' };
    },
  });
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, false);
  assert.ok(result.degraded, 'the caller must be told the node is still cordoned');
  assert.equal(result.degraded.code, 'uncordon-failed');
  assert.equal(result.degraded.node, 'node-a');
  assert.match(result.degraded.detail, /apiserver unavailable/);
  // And the recorded cordon state must reflect reality, not intent.
  assert.equal(result.cordon.cordoned, true);
});

test('a successful compensating uncordon records that scheduling is restored', async () => {
  const { coordinator } = build({ evictionCompletes: false });
  const result = await coordinator.prepare('node-a', '');
  assert.equal(result.prepared, false);
  assert.equal(result.degraded, undefined);
  assert.equal(result.cordon.cordoned, false);
  assert.ok(result.cordon.restoredAt);
});

test('a degradation survives an error thrown mid-drain', async () => {
  const { coordinator } = build({
    getPod: async () => { throw { code: 500, msg: 'apiserver exploded' }; },
    patchNodeUnschedulable: async (name, value) => {
      if (value === false) throw { code: 500, msg: 'still unavailable' };
    },
  });
  await assert.rejects(() => coordinator.prepare('node-a', ''), (error) => {
    assert.equal(error.msg, 'apiserver exploded');
    assert.equal(error.degraded.code, 'uncordon-failed');
    assert.equal(error.node, 'node-a');
    return true;
  });
});
