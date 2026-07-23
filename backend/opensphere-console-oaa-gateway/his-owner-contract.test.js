'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const clusterManagerSource = fs.readFileSync(path.resolve(__dirname, '../../../OpenSphere-shell-clusterManager/his-manager.js'), 'utf8');
const cephManagerSource = fs.readFileSync(path.resolve(__dirname, '../../../OpenSphere-shell-clusterManager/ceph-manager.js'), 'utf8');

test('HIS Observability tools are capability-negotiated against the signed owner API', () => {
  assert.match(source, /\/api\/his\/oaa\/capabilities/);
  assert.match(source, /opensphere\.io\/oaa-his-owner\/v1/);
  assert.match(source, /hisOwnerCapabilities\.has\('observability-configure'\)/);
  assert.match(source, /signed Cluster Manager does not expose/);
  assert.match(clusterManagerSource, /capabilities: \['observability-config-read', 'observability-plan', 'observability-configure'\]/);
});

test('Gateway and Cluster Manager both enforce closed SecretRef-only HIS input', () => {
  assert.match(source, /normalizeHisObservabilityOwnerConfig/);
  assert.match(source, /requireExactOwnerObject/);
  assert.match(source, /additionalProperties: false/);
  assert.doesNotMatch(source, /remoteWrite[^\n]{0,80}(tokenValue|secretValue|password)/i);
  assert.match(clusterManagerSource, /normalizeOaaObservabilityConfig/);
  assert.match(clusterManagerSource, /config\.prometheus\.remoteWrite/);
  assert.match(clusterManagerSource, /\['enabled', 'url', 'secretName', 'secretKey'\]/);
});

test('HIS mutation is independently permissioned, AAL2-bound, and explicitly confirms exposure and reset', () => {
  assert.match(source, /'oaa\.his\.observability\.configure': 'console\.his\.manage'/);
  assert.match(source, /configure HIS observability public=\$\{config\.grafana\.exposureMode === 'PublicIngress'\} data-reset=\$\{Boolean\(resetData\)\}/);
  assert.match(source, /owner control-plane action requires MFA assurance aal2/);
  assert.match(clusterManagerSource, /OAA_HIS_MANAGE_PERMISSION/);
  assert.match(clusterManagerSource, /HIS OAA 변경은 AAL2 재인증/);
  assert.match(clusterManagerSource, /configurationPlan\.requiresDataReset !== body\.resetData/);
});

test('Ceph tools negotiate a signed owner capability and accept only staged SecretRefs', () => {
  assert.match(source, /\/api\/ceph\/oaa\/capabilities/);
  assert.match(source, /opensphere\.io\/oaa-ceph-owner\/v1/);
  assert.match(source, /OAA_CEPH_IMPORT_REF_RE/);
  assert.match(source, /'oaa\.ceph\.connect': 'console\.ceph\.manage'/);
  assert.match(source, /signed Cluster Manager or Rook prerequisites do not expose the Ceph connect capability/);
  assert.match(source, /\/api\/ceph\/oaa\/connect/);
  assert.doesNotMatch(source, /fixedOwnerPost\(CLUSTER_MANAGER_URL, '\/api\/ceph\/connect'/);
  assert.match(cephManagerSource, /secretInputPolicy: 'StagedSecretRefOnly'/);
  assert.match(cephManagerSource, /connectionFromImportRef/);
});

test('Ceph connect and disconnect are AAL2 owner actions, not arbitrary infrastructure payloads', () => {
  assert.match(source, /'oaa\.ceph\.connect'/);
  assert.match(source, /requireClosedOwnerInputs\(inputs, \['importRef', 'confirm', 'reason'\]\)/);
  assert.match(source, /connect Ceph external storage using \$\{importRef\}/);
  assert.match(source, /\/api\/ceph\/oaa\/disconnect/);
  assert.match(cephManagerSource, /Ceph OAA 변경은 AAL2 재인증/);
  assert.match(cephManagerSource, /operatorOwned: false/);
});
