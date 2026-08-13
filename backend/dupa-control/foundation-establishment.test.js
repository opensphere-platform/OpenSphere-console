const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FOUNDATION_CONTRACT_CRDS,
  CONSUMER_PROTECT_FINALIZER,
  foundationEstablishmentProjection,
} = require('./foundation-establishment');
const fs = require('node:fs');
const path = require('node:path');

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
    supportReady: true,
    shellReady: true,
    bootstrapOwner: response(readyDeployment()),
    crds: response({ items: FOUNDATION_CONTRACT_CRDS.map(crd) }),
    controlPlane: response(readyDeployment()),
    models: response({ items: [
      { metadata: { name: 'data' }, spec: { model: 'data', desiredState: 'Installed' } },
    ] }),
    descriptors: response({ items: [
      { metadata: { name: 'data' }, spec: { model: 'data' } },
    ] }),
    bindings: response({ items: [{
      metadata: { name: 'proof', finalizers: [CONSUMER_PROTECT_FINALIZER] },
      status: { phase: 'Connected' },
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
  input.bindings = response({ items: [{ metadata: { name: 'unsafe' }, status: { phase: 'Connected' } }] });
  const result = foundationEstablishmentProjection(input);
  assert.equal(result.phase, 'Establishing');
  assert.equal(result.established, false);
  assert.equal(result.evidence.connectedBindings, 1);
  assert.equal(result.evidence.protectedConnectedBindings, 0);
});

test('DUPA reads only the named Foundation contract CRDs with least privilege', () => {
  const controller = fs.readFileSync(path.join(__dirname, 'controller.js'), 'utf8');
  const manifest = fs.readFileSync(path.join(__dirname, 'opensphere-console-dupa-controller.yaml'), 'utf8');
  assert.match(controller, /FOUNDATION_CONTRACT_CRDS\.map\(\(name\) =>/);
  assert.match(controller, /customresourcedefinitions\/\$\{encodeURIComponent\(name\)\}/);
  assert.doesNotMatch(controller, /k8s\('GET', '\/apis\/apiextensions\.k8s\.io\/v1\/customresourcedefinitions'\)/);
  for (const name of FOUNDATION_CONTRACT_CRDS) {
    assert.match(manifest, new RegExp(`- ${name.replaceAll('.', '\\.')}`));
  }
  const roleStart = manifest.indexOf('metadata: { name: dupa-console-evidence-reader }');
  const roleEnd = manifest.indexOf('\n---', roleStart);
  const evidenceRole = manifest.slice(roleStart, roleEnd);
  assert.match(evidenceRole, /resources: \[customresourcedefinitions\]/);
  assert.match(evidenceRole, /verbs: \[get\]/);
  assert.doesNotMatch(evidenceRole, /resources: \[customresourcedefinitions\][\s\S]*?verbs: \[[^\]]*(?:list|watch)/);
});
