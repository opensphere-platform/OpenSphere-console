'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (value) => fs.readFileSync(path.join(root, value), 'utf8');

test('baseline monitoring uses exact-digest private Hub deployment and outbound-only agents', () => {
  const manifest = read('deploy/baseline-monitoring/beszel-release.yaml');
  assert.match(manifest, /henrygd\/beszel@sha256:[0-9a-f]{64}/);
  assert.match(manifest, /henrygd\/beszel-agent@sha256:[0-9a-f]{64}/);
  assert.match(manifest, /BESZEL_AGENT_DISABLE_SSH, value: "true"/);
  assert.doesNotMatch(manifest, /hostPort:/);
  assert.doesNotMatch(manifest, /hostNetwork:\s*true/);
  assert.doesNotMatch(manifest, /clusterIP:\s*None/);
  assert.match(manifest, /readOnlyRootFilesystem: true/);
});

test('Beszel alerts enter the existing notification dispatcher through a scoped producer token', () => {
  const manifest = read('deploy/baseline-monitoring/beszel-release.yaml');
  const deploy = read('backend/opensphere-console-backend/deploy.yaml');
  const server = read('backend/opensphere-console-backend/server.js');
  assert.match(manifest, /generic\+http:\/\/opensphere-console-backend/);
  assert.match(manifest, /@x-opensphere-beszel-token=/);
  assert.match(deploy, /name: BESZEL_WEBHOOK_TOKEN/);
  assert.match(server, /\/api\/internal\/monitoring\/beszel\/events/);
  assert.match(server, /sourceType: 'baseline-monitoring'/);
  assert.match(server, /route: '\/manage\/infrastructure-monitoring\?tab=alerts'/);
});

test('Beszel bootstrap creates missing user settings before configuring webhooks', () => {
  const manifest = read('deploy/baseline-monitoring/beszel-release.yaml');
  assert.match(manifest, /USER_ID=.*"id"/);
  assert.match(manifest, /if \[ -z "\$\{SETTINGS_ID\}" \]; then/);
  assert.match(manifest, /api\/collections\/user_settings\/records/);
  assert.match(manifest, /--data "\{\\"user\\":\\"\$\{USER_ID\}\\"\}"/);
});

test('node correlation persists Kubernetes UID and Beszel machine fingerprint as the identity boundary', () => {
  const migration = read('backend/supabase/migrations/0029_browser_session_and_baseline_monitoring.sql');
  const adapter = read('backend/opensphere-console-backend/baseline-monitoring.js');
  assert.match(migration, /kubernetes_node_uid text PRIMARY KEY/);
  assert.match(migration, /beszel_machine_fingerprint text NOT NULL/);
  assert.match(adapter, /bindingStore\.ensure/);
  assert.match(adapter, /identity = evidence\?\.state === 'verified' \? 'verified' : 'rejected'/);
});
