'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RELATION_TYPES, sanitizeOperationalValue, canonicalNodeId, runtimeRowToNode,
  buildRelations, compareProjectionVersion, CompleteReconcileBarrier,
  BoundedCoalescingQueue, graphCoverage,
} = require('./operational-graph');

const context = {
  clusterId: 'local-edge', fencingEpoch: 3, collectionEpoch: 9,
  reconcileSessionId: '00000000-0000-4000-8000-000000000001', snapshotComplete: true,
  observedAt: '2026-08-10T00:00:00.000Z', expiresAt: '2099-08-10T00:01:00.000Z', sourceRevision: 'fixture',
};

test('Kubernetes identity requires UID and distinguishes name reuse', () => {
  assert.throws(() => canonicalNodeId('c', 'kubernetes', 'Pod', 'ns', 'same', ''), /UID/);
  assert.notEqual(
    canonicalNodeId('c', 'kubernetes', 'Pod', 'ns', 'same', 'uid-1'),
    canonicalNodeId('c', 'kubernetes', 'Pod', 'ns', 'same', 'uid-2'),
  );
});

test('operational sanitizer excludes credentials, Secret data and Pod env recursively', () => {
  const value = sanitizeOperationalValue({
    metadata: { uid: 'u1' }, data: { key: 'secret' },
    spec: { env: [{ name: 'TOKEN', value: 'secret' }], nested: { password: 'secret', ok: 'visible' } },
  });
  assert.equal(value.data, undefined);
  assert.equal(value.spec.env, undefined);
  assert.equal(value.spec.nested.password, undefined);
  assert.equal(value.spec.nested.ok, 'visible');
});

test('runtime rows become evidence-bound nodes and owner relations use closed vocabulary', () => {
  const namespace = runtimeRowToNode({ source: 'kubernetes', kind: 'Namespace', name: 'ns', namespace: '', health: 'Ready',
    payload: { metadata: { uid: 'ns-uid' } }, observed_at: context.observedAt, expires_at: context.expiresAt }, context);
  const deployment = runtimeRowToNode({ source: 'kubernetes', kind: 'Deployment', name: 'app', namespace: 'ns', health: 'Ready',
    payload: { metadata: { uid: 'dep-uid' } }, observed_at: context.observedAt, expires_at: context.expiresAt }, context);
  const replicaSet = runtimeRowToNode({ source: 'kubernetes', kind: 'ReplicaSet', name: 'app-1', namespace: 'ns', health: 'Ready',
    payload: { metadata: { uid: 'rs-uid', ownerReferences: [{ kind: 'Deployment', name: 'app' }] } },
    observed_at: context.observedAt, expires_at: context.expiresAt }, context);
  const relations = buildRelations([namespace, deployment, replicaSet], context);
  assert.ok(relations.some((item) => item.relationType === 'owns' && item.fromNodeId === deployment.nodeId && item.toNodeId === replicaSet.nodeId));
  assert.ok(relations.every((item) => RELATION_TYPES.has(item.relationType)));
});

test('complete barrier never permits partial pagination to imply deletion', () => {
  const barrier = new CompleteReconcileBarrier(['Pod/ns-a', 'Pod/ns-b']);
  barrier.mark('Pod/ns-a', true);
  barrier.mark('Pod/ns-b', false);
  assert.equal(barrier.snapshotComplete, false);
  assert.throws(() => barrier.assertComplete(), /incomplete reconcile barrier/);
  barrier.mark('Pod/ns-b', true);
  assert.equal(barrier.assertComplete(), true);
});

test('projection version rejects stale epoch, collection and stream sequence', () => {
  assert.equal(compareProjectionVersion({ fencingEpoch: 3, collectionEpoch: 9, streamSequence: 5 }, { fencingEpoch: 2, collectionEpoch: 99, streamSequence: 99 }), -1);
  assert.equal(compareProjectionVersion({ fencingEpoch: 3, collectionEpoch: 9, streamSequence: 5 }, { fencingEpoch: 3, collectionEpoch: 9, streamSequence: 6 }), 1);
});

test('bounded queue coalesces and degrades to source_lagging under pressure', () => {
  const queue = new BoundedCoalescingQueue(2);
  queue.push('a', { revision: 1 });
  assert.equal(queue.push('a', { revision: 2 }).coalesced, true);
  queue.push('b', {});
  queue.push('c', {}, 'high');
  assert.equal(queue.size, 2);
  assert.equal(queue.lagging, true);
  assert.equal(queue.dropped, 1);
});

test('coverage denominator is canonical inventory and cannot shrink with actor projection', () => {
  const components = ['component-a', 'component-b'];
  const result = graphCoverage([{ canonicalId: 'component-a' }], components);
  assert.equal(result.denominator, 2);
  assert.equal(result.matched, 1);
  assert.equal(result.coverage, 0.5);
  assert.deepEqual(result.componentMissing, ['component-b']);
});
