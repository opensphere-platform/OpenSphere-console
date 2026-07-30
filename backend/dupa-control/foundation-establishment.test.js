const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FOUNDATION_CONTRACT_CRDS,
  CONSUMER_PROTECT_FINALIZER,
  MODEL_EVIDENCE_MAX_AGE_MS,
  BINDING_EVIDENCE_MAX_AGE_MS,
  foundationEstablishmentProjection,
} = require('./foundation-establishment');

const NOW = Date.parse('2026-07-30T06:00:00.000Z');

function response(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json };
}

function crd(name) {
  return {
    metadata: { name },
    status: { conditions: [{ type: 'Established', status: 'True' }] },
  };
}

function readyDeployment() {
  return {
    metadata: { generation: 3 },
    spec: { replicas: 1 },
    status: {
      observedGeneration: 3,
      updatedReplicas: 1,
      availableReplicas: 1,
      readyReplicas: 1,
    },
  };
}

function completeEvidence() {
  return {
    now: NOW,
    supportReady: true,
    shellReady: true,
    bootstrapOwner: response(readyDeployment()),
    crds: response({ items: FOUNDATION_CONTRACT_CRDS.map(crd) }),
    controlPlane: response(readyDeployment()),
    models: response({ items: [
      {
        metadata: { name: 'data' },
        spec: { model: 'data', desiredState: 'Installed' },
        status: {
          phase: 'Installed',
          operator: { deployed: true },
          observedAt: new Date(NOW - 30_000).toISOString(),
        },
      },
    ] }),
    descriptors: response({ items: [
      { metadata: { name: 'data' }, spec: { model: 'data' } },
    ] }),
    bindings: response({ items: [{
      metadata: { name: 'proof', finalizers: [CONSUMER_PROTECT_FINALIZER] },
      status: {
        phase: 'Connected',
        connection: { lastCheck: new Date(NOW - 30_000).toISOString() },
      },
    }] }),
  };
}

test('an Activated extension is not PFS Established while support is blocked', () => {
  const result = foundationEstablishmentProjection({
    ...completeEvidence(),
    supportReady: false,
  });
  assert.equal(result.shellReady, true);
  assert.equal(result.phase, 'NotEstablished');
  assert.equal(result.established, false);
  assert.equal(result.blockers.some((item) => item.key === 'support-profile'), true);
});

test('PFS enters Establishing after support becomes Ready but bootstrap evidence is missing', () => {
  const result = foundationEstablishmentProjection({
    supportReady: true,
    shellReady: true,
    bootstrapOwner: response(null, 404),
    crds: response({ items: [] }),
    controlPlane: response(null, 404),
    models: response(null, 404),
    descriptors: response(null, 404),
    bindings: response(null, 404),
  });
  assert.equal(result.phase, 'Establishing');
  assert.equal(result.established, false);
  assert.deepEqual(
    result.blockers.map((item) => item.key),
    ['foundation-bootstrap-owner', 'foundation-contracts', 'foundation-control-plane', 'foundation-models', 'claim-binding-proof'],
  );
});

test('PFS is Established only with live contracts, controller, model and protected binding proof', () => {
  const result = foundationEstablishmentProjection(completeEvidence());
  assert.equal(result.phase, 'Established');
  assert.equal(result.established, true);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.evidence.protectedConnectedBindings, 1);
});

test('unreadable Kubernetes evidence fails closed as Blocked', () => {
  const input = completeEvidence();
  input.controlPlane = response({ message: 'forbidden' }, 403);
  const result = foundationEstablishmentProjection(input);
  assert.equal(result.phase, 'Blocked');
  assert.equal(result.established, false);
  assert.equal(
    result.blockers.find((item) => item.key === 'foundation-control-plane')?.state,
    'Error',
  );
});

test('a Connected binding without the consumer-protect finalizer is not establishment proof', () => {
  const input = completeEvidence();
  input.bindings = response({ items: [{
    metadata: { name: 'unsafe' },
    status: {
      phase: 'Connected',
      connection: { lastCheck: new Date(NOW - 30_000).toISOString() },
    },
  }] });
  const result = foundationEstablishmentProjection(input);
  assert.equal(result.phase, 'Establishing');
  assert.equal(result.established, false);
  assert.equal(result.evidence.connectedBindings, 1);
  assert.equal(result.evidence.protectedConnectedBindings, 0);
});

test('a Disabled or stale model cannot establish PFS even when old status says Installed', () => {
  for (const variant of [
    { desiredState: 'Disabled', observedAt: new Date(NOW - 30_000).toISOString() },
    { desiredState: 'Installed', observedAt: new Date(NOW - MODEL_EVIDENCE_MAX_AGE_MS - 1).toISOString() },
  ]) {
    const input = completeEvidence();
    input.models.json.items[0].spec.desiredState = variant.desiredState;
    input.models.json.items[0].status.observedAt = variant.observedAt;
    const result = foundationEstablishmentProjection(input);
    assert.equal(result.established, false);
    assert.equal(result.blockers.some((item) => item.key === 'foundation-models'), true);
  }
});

test('a stale Connected binding cannot establish PFS', () => {
  const input = completeEvidence();
  input.bindings.json.items[0].status.connection.lastCheck =
    new Date(NOW - BINDING_EVIDENCE_MAX_AGE_MS - 1).toISOString();
  const result = foundationEstablishmentProjection(input);
  assert.equal(result.established, false);
  assert.equal(result.evidence.connectedBindings, 0);
  assert.equal(result.blockers.some((item) => item.key === 'claim-binding-proof'), true);
});
