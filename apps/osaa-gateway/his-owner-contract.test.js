'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const ownerContract = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../packages/contracts/owners/cluster-manager-owner-capabilities.json'),
  'utf8',
));

test('HISS Observability tools are capability-negotiated against the signed owner API', () => {
  assert.match(source, /\/api\/hiss\/osaa\/capabilities/);
  assert.match(source, /opensphere\.io\/osaa-his-owner\/v1/);
  assert.match(source, /hisOwnerCapabilities\.has\('observability-configure'\)/);
  assert.match(source, /signed Cluster Manager does not expose/);
  assert.deepEqual(ownerContract.capabilities.hiss, [
    'observability-config-read',
    'observability-plan',
    'observability-configure',
    'lifecycle-inspect',
    'lifecycle-execute',
  ]);
});

test('Gateway and Cluster Manager both enforce closed SecretRef-only HISS input', () => {
  assert.match(source, /normalizeHisObservabilityOwnerConfig/);
  assert.match(source, /requireExactOwnerObject/);
  assert.match(source, /additionalProperties: false/);
  assert.doesNotMatch(source, /remoteWrite[^\n]{0,80}(tokenValue|secretValue|password)/i);
  assert.equal(ownerContract.security.secretInputPolicy, 'StagedSecretRefOnly');
  assert.equal(ownerContract.security.unknownProperties, 'reject');
});

test('HISS mutation shares user authority and MFA policy and explicitly confirms exposure and reset', () => {
  assert.match(source, /'osaa\.his\.observability\.configure': 'console\.his\.manage'/);
  assert.match(source, /configure HISS observability public=\$\{config\.grafana\.exposureMode === 'PublicIngress'\} data-reset=\$\{Boolean\(resetData\)\}/);
  assert.match(source, /assertUserMutationAssurance\(actor, 'owner control-plane action', C_AI_RUNTIME_PROFILE\)/);
  assert.equal(ownerContract.security.mutationPermission, 'console.role.admin');
  assert.deepEqual(ownerContract.security.readPermissionsAnyOf, ['console.role.admin', 'console.role.operator', 'console.role.viewer']);
  assert.equal(ownerContract.security.assurance, 'aal2');
});

test('Ceph tools negotiate a signed owner capability and accept only staged SecretRefs', () => {
  assert.match(source, /\/api\/ceph\/osaa\/capabilities/);
  assert.match(source, /opensphere\.io\/osaa-ceph-owner\/v1/);
  assert.match(source, /OSAA_CEPH_IMPORT_REF_RE/);
  assert.match(source, /'osaa\.ceph\.connect': 'console\.ceph\.manage'/);
  assert.match(source, /signed Cluster Manager or Rook prerequisites do not expose the Ceph connect capability/);
  assert.match(source, /\/api\/ceph\/osaa\/connect/);
  assert.doesNotMatch(source, /fixedOwnerPost\(CLUSTER_MANAGER_URL, '\/api\/ceph\/connect'/);
  assert.equal(ownerContract.security.secretInputPolicy, 'StagedSecretRefOnly');
  assert.ok(ownerContract.capabilities.ceph.includes('connect-from-import'));
});

test('Ceph connect and disconnect are AAL2 owner actions, not arbitrary infrastructure payloads', () => {
  assert.match(source, /'osaa\.ceph\.connect'/);
  assert.match(source, /requireClosedOwnerInputs\(inputs, \['importRef', 'confirm', 'reason'\]\)/);
  assert.match(source, /connect Ceph external storage using \$\{importRef\}/);
  assert.match(source, /\/api\/ceph\/osaa\/disconnect/);
  assert.equal(ownerContract.security.assurance, 'aal2');
  assert.ok(ownerContract.capabilities.ceph.includes('disconnect'));
});
