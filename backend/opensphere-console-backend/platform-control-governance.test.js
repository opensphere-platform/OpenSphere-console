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
const recoveryOwner = read('opensphere-console-backend/recovery-owner.js');
const recoveryPermissions = read('supabase/migrations/0022_oaa_recovery_owner_permissions.sql');

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

test('Ceph prerequisite requests are immutable templates assigned to a dedicated reconciler', () => {
  assert.match(server, /CEPH_PREREQUISITE_TEMPLATE/);
  assert.match(server, /ceph-rook-prerequisite/);
  assert.match(server, /rook-ceph\/v1\.20\.2/);
  assert.match(server, /6e0f10f5ca54e618fb90dd149dc9dfbc8a4932955bff2227b692fb32069daf52/);
  assert.match(server, /change template fields are immutable/);
  assert.match(server, /ceph-prerequisite-reconciler/);
  assert.match(server, /reconciler is outside the configured allowlist/);
  assert.match(server, /reconcile receipt identity does not match the assigned consumer reconciler/);
});

test('rollback proposals retain their source request in the reviewed Gitea declaration', () => {
  const governed = server.slice(server.indexOf('async function governedChange'), server.indexOf('async function approveGovernedChange'));
  assert.match(governed, /uuid\(body\.rollbackOf, 'rollbackOf request id'\)/);
  assert.match(governed, /rollbackOf is allowed only for rollback changes/);
  assert.match(governed, /metadata: \{ requestId, consumerId,[\s\S]*rollbackOf/);
  assert.match(governed, /spec: \{ action: action\.toLowerCase\(\), target, reason, desiredState: declaration\.value,[\s\S]*rollbackOf/);
});

test('two-person approval is enforced in both backend and database', () => {
  assert.match(server, /change creator cannot approve their own request/);
  assert.match(approvals, /change creator cannot approve their own request/);
  assert.match(approvals, /length\(btrim\(p_reason\)\) < 8/i);
  assert.match(server, /authToken: GITEA_REVIEW_TOKEN/);
});

test('OAA mutations are typed, exact-confirmed, digest-pinned, and never direct', () => {
  assert.match(server, /'oaa\.k8s\.resource\.apply'/);
  assert.match(server, /'oaa\.k8s\.resource\.delete'/);
  assert.match(server, /'oaa\.k8s\.workload\.rollback-image'/);
  assert.match(server, /requireExactOaaConfirmation/);
  assert.match(server, /OAA_IMAGE_DIGEST_RE/);
  assert.match(server, /impact assessment/);
  assert.match(server, /consumerId: 'oaa-gateway', action: policy\.action/);
  assert.match(server, /action must be apply, delete, configure, or rollback/);
  assert.doesNotMatch(server.slice(server.indexOf('async function submitOaaAction'), server.indexOf('async function requireSupabase')), /k8s\(|K8S_API|PATCH.*deployments/);
});

test('OAA Backend lifecycle gate is inside action submission and absent from provider credential probing', () => {
  const submit = server.slice(server.indexOf('async function submitOaaAction'), server.indexOf('async function requireSupabase'));
  const probe = server.slice(server.indexOf('async function probeOaaProviderCredential'), server.indexOf('async function validateOaaCredential'));
  assert.match(submit, /await requireOaaLifecycleGate\(authorization\)/);
  assert.doesNotMatch(submit, /oaa\.knowledge\.ingest-manual/);
  assert.doesNotMatch(probe, /requireOaaLifecycleGate|\btoolId\b/);
});

test('Supabase session projection carries the legacy Cluster Manager admin alias without changing canonical RBAC', () => {
  assert.match(server, /CONSOLE_ADMIN_COMPATIBILITY_GROUPS/);
  assert.match(server, /groups\.has\(SUPABASE_BACKEND_ROLE\)/);
  assert.match(server, /groups: projectedSessionGroups\(actor\)/);
  assert.match(server, /console-admins,console-operators,console-viewers/);
});

test('OAA identity owner is permission-gated, mutation-AAL2, PII-minimized, and preserves administrator continuity', () => {
  const verify = server.slice(server.indexOf('async function verifyOaaIdentityOwner'), server.indexOf('function managementReason'));
  const status = server.slice(server.indexOf('async function oaaIdentityStatus'), server.indexOf('async function oaaIdentityOwnerAction'));
  const action = server.slice(server.indexOf('async function oaaIdentityOwnerAction'), server.indexOf('async function cliEnrollmentCreate'));
  assert.match(verify, /console\.identity\.manage/);
  assert.match(verify, /options\.requireAal2 === true && actor\.assurance !== 'aal2'/);
  assert.match(action, /requireClosedOaaIdentityBody/);
  assert.match(action, /requireExactOaaConfirmation/);
  assert.doesNotMatch(action, /createRecoveryLink|action_link|onboardingPath/);
  assert.doesNotMatch(status, /email:/);
  assert.match(server, /actor\.sub === operator\.user_id/);
  assert.doesNotMatch(server, /actor\.user_id === operator\.user_id/);
  assert.match(server, /last active Console administrator cannot be disabled or demoted/);
  assert.match(server, /\/api\/oaa\/owner\/identity\/status/);
  assert.match(server, /\/api\/oaa\/owner\/identity\/actions/);
  assert.match(server, /verifyOaaIdentityOwner\(req, \{ requireAal2: true \}\)/);
});

test('OAA recovery owner is read/plan only and cannot expose a script as an executor', () => {
  assert.match(server, /\/api\/oaa\/owner\/recovery\/capabilities/);
  assert.match(server, /\/api\/oaa\/owner\/recovery\/status/);
  assert.match(server, /\/api\/oaa\/owner\/recovery\/plan/);
  assert.match(server, /console\.recovery\.read/);
  assert.match(recoveryOwner, /RECOVERY_OWNER_CAPABILITIES = Object\.freeze\(\['status-read', 'plan-read'\]\)/);
  assert.match(recoveryOwner, /No signed recovery-drill executor is configured/);
  assert.doesNotMatch(recoveryOwner, /exec\(|spawn\(|kubectl|powershell/i);
  assert.match(recoveryPermissions, /console\.recovery\.read/);
  assert.match(recoveryPermissions, /console\.backup\.restore permission remains reserved/);
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
