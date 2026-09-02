'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const read = (value) => fs.readFileSync(path.join(root, value), 'utf8');

test('baseline monitoring uses governed release inputs and outbound-only agents', () => {
  const manifest = read('deploy/baseline-monitoring/beszel-release.yaml');
  assert.match(manifest, /image: __OPENSPHERE_BESZEL_HUB_IMAGE__/);
  assert.match(manifest, /image: __OPENSPHERE_BESZEL_AGENT_IMAGE__/);
  assert.match(manifest, /image: __OPENSPHERE_BESZEL_BOOTSTRAP_IMAGE__/);
  assert.match(
    read('deploy/baseline-monitoring/images/hub/Dockerfile'),
    /henrygd\/beszel@sha256:[0-9a-f]{64}/,
  );
  assert.match(
    read('deploy/baseline-monitoring/images/agent/Dockerfile'),
    /henrygd\/beszel-agent@sha256:[0-9a-f]{64}/,
  );
  assert.match(manifest, /BESZEL_AGENT_DISABLE_SSH, value: "true"/);
  assert.match(manifest, /name: beszel-agent[\s\S]*ingress: \[\]/);
  assert.doesNotMatch(manifest, /hostPort:/);
  assert.doesNotMatch(manifest, /hostNetwork:\s*true/);
  assert.doesNotMatch(manifest, /clusterIP:\s*None/);
  assert.match(manifest, /readOnlyRootFilesystem: true/);
});

test('target Beszel bootstrap does not claim an unimplemented alert ingest owner', () => {
  const manifest = read('deploy/baseline-monitoring/beszel-release.yaml');
  const installer = read('deploy/baseline-monitoring/install.ps1');
  assert.doesNotMatch(manifest, /WEBHOOK_TOKEN|webhook-token|generic\+http:/);
  assert.doesNotMatch(installer, /WEBHOOK_TOKEN|webhook-token/);
  assert.doesNotMatch(manifest, /opensphere-console-backend/);
});

test('Beszel bootstrap creates and authenticates the dedicated reader', () => {
  const manifest = read('deploy/baseline-monitoring/beszel-release.yaml');
  assert.match(manifest, /api\/collections\/users\/records/);
  assert.match(manifest, /role\\":\\"readonly/);
  assert.match(manifest, /READER_AUTH=.*auth-with-password/);
  assert.match(manifest, /READER_TOKEN=.*"token"/);
  assert.match(manifest, /\[ -n "\$\{READER_TOKEN\}" \]/);
});

test('node correlation persists Kubernetes UID and Beszel machine fingerprint as the identity boundary', () => {
  const migration = read('backend/supabase/migrations/0029_browser_session_and_baseline_monitoring.sql');
  const adapter = read('apps/console-api/runtime/baseline-monitoring.js');
  assert.match(migration, /kubernetes_node_uid text PRIMARY KEY/);
  assert.match(migration, /beszel_machine_fingerprint text NOT NULL/);
  assert.match(adapter, /bindingStore\.ensure/);
  assert.match(adapter, /identity = evidence\?\.state === 'verified' \? 'verified' : 'rejected'/);
});

test('Console nginx routes baseline monitoring reads through its authenticated API boundary', () => {
  const nginx = read('apps/console-web/nginx/default.conf.template');
  assert.match(nginx, /location \/api\/monitoring\/baseline\/ \{/);
  assert.match(
    nginx,
    /location \/api\/monitoring\/baseline\/ \{[\s\S]*proxy_pass http:\/\/\$console_backend_upstream:8080\$request_uri/,
  );
});
