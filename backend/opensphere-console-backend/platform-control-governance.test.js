const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const server = read('opensphere-console-backend/server.js');
const deploy = read('opensphere-console-backend/deploy.yaml');
const governance = read('supabase/migrations/0009_platform_control_governance.sql');
const approvals = read('supabase/migrations/0010_change_approval.sql');
const gitea = read('gitea/bootstrap/gitea.yaml');
const bootstrap = read('gitea/bootstrap/control-plane-bootstrap.ps1');

test('governed change state is Supabase-only and RLS protected', () => {
  for (const table of ['consumer_contract', 'observability_claim', 'change_execution', 'change_outbox', 'gitea_webhook_receipt', 'reconcile_receipt']) {
    assert.match(governance, new RegExp(`ALTER TABLE console\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'));
  }
  assert.match(governance, /GRANT EXECUTE ON FUNCTION console\.record_change_proposal[\s\S]*TO opensphere_console_backend;/i);
  assert.doesNotMatch(governance, /GRANT EXECUTE[\s\S]*(anon|authenticated)/i);
  assert.match(governance, /Supabase stores audit, idempotency and Console read models\. Gitea owns/i);
});

test('Gitea webhook cannot advance a change before HMAC verification', () => {
  const valid = server.indexOf('const signatureValid = Boolean(GITEA_WEBHOOK_SECRET');
  const commit = server.indexOf("rpc/record_change_commit");
  const queue = server.indexOf("rpc/queue_change_reconcile");
  assert.ok(valid >= 0 && commit > valid && queue > commit, 'HMAC verification must precede commit and outbox transitions');
  assert.match(server, /safeEqual\(createHmac\('sha256', GITEA_WEBHOOK_SECRET\)/);
  assert.match(server, /payload_digest: digest/);
});

test('governed proposal rejects browser-supplied secret material and persists intent first', () => {
  const governed = server.slice(server.indexOf('async function governedChange'), server.indexOf('async function approveGovernedChange'));
  assert.match(server, /may not contain secret material; use a named Secret reference/);
  assert.match(governed, /GITEA_CHANGE_REQUIRE_AAL2/);
  assert.ok(governed.indexOf("rpc/begin_change") < governed.indexOf('giteaRequest('), 'intent must persist before any Gitea side effect');
  assert.match(governed, /consumer contract is not bound to the configured Gitea repository/);
});

test('two-person approval is enforced in both backend and database', () => {
  assert.match(server, /change creator cannot approve their own request/);
  assert.match(approvals, /change creator cannot approve their own request/);
  assert.match(approvals, /length\(btrim\(p_reason\)\) < 8/i);
  assert.match(server, /authToken: GITEA_REVIEW_TOKEN/);
});

test('reconciler receipts remain server-to-server only', () => {
  assert.match(server, /x-opensphere-reconciler-token/);
  assert.match(server, /RECONCILER_RECEIPT_TOKEN/);
  assert.match(deploy, /name: RECONCILER_RECEIPT_TOKEN[\s\S]*opensphere-gitea-control-plane, key: reconciler-token/);
  assert.doesNotMatch(deploy, /GITEA_TOKEN, value:/);
  assert.match(deploy, /name: GITEA_TOKEN[\s\S]*secretKeyRef/);
});

test('Gitea supply-chain policy requires signed commits and server-only signing material', () => {
  assert.match(gitea, /opensphere-gitea-signing/);
  assert.match(gitea, /emptyDir: \{ medium: Memory \}/);
  assert.match(gitea, /GITEA__repository_0x2E_signing__SIGNING_KEY/);
  assert.match(gitea, /GITEA__repository_0x2E_signing__MERGES, value: "approved,commitssigned"/);
  assert.match(bootstrap, /require_signed_commits = \$true/);
  assert.match(bootstrap, /branch_protections\/main/);
  assert.match(bootstrap, /Invoke-GiteaRequest 'PATCH'/);
});
