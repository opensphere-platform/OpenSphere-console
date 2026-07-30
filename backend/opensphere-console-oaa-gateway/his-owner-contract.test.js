'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const cephManagerSource = fs.readFileSync(path.resolve(__dirname, '../../../OpenSphere-shell-clusterManager/ceph-manager.js'), 'utf8');

test('Platform Support Observability tools are capability-negotiated independently from HIS', () => {
  assert.match(source, /\/api\/platform-support\/oaa\/capabilities/);
  assert.match(source, /opensphere\.io\/oaa-platform-support-owner\/v1/);
  assert.match(source, /platformSupportOwnerCapabilities\.has\('observability-configure'\)/);
  assert.match(source, /platformSupportOwnerCapabilities\.has\('observability-validate'\)/);
  assert.match(source, /platformSupportOwnerCapabilities\.has\('observability-lifecycle'\)/);
  assert.match(source, /\/api\/platform-support\/validate/);
  assert.match(source, /`\/api\/platform-support\/\$\{action\}`/);
  assert.match(source, /signed Platform Support owner does not expose/);
  assert.doesNotMatch(source, /oaa\.his\.observability/);
});

test('Gateway enforces closed SecretRef-only Platform Support input', () => {
  assert.match(source, /normalizePlatformSupportObservabilityConfig/);
  assert.match(source, /requireExactOwnerObject/);
  assert.match(source, /additionalProperties: false/);
  assert.doesNotMatch(source, /remoteWrite[^\n]{0,80}(tokenValue|secretValue|password)/i);
});

test('Platform Support mutation is independently permissioned, AAL2-bound, and explicitly confirms exposure and reset', () => {
  assert.match(source, /'oaa\.platform\.support\.observability\.configure': 'console\.platform\.support\.manage'/);
  assert.match(source, /configure platform-support observability public=\$\{config\.grafana\.exposureMode === 'PublicIngress'\} data-reset=\$\{Boolean\(resetData\)\}/);
  assert.match(source, /owner control-plane action requires MFA assurance aal2/);
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
