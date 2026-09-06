// CON-FR-007/018: actual PostgreSQL authorization and recovery; no live DB access.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { migrationTransactionSql } from './console-migrations.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const docker = process.env.OPHERE_TEST_DOCKER || 'docker';
const container = 'opensphere-install-recovery-test-' + process.pid + '-' + Date.now();
const label = 'module-installation-recovery-test';
let created = false;
process.on('exit', () => {
  if (!created) return;
  const info = JSON.parse(execFileSync(docker, ['inspect', container], { encoding: 'utf8', windowsHide: true }))[0];
  assert.equal(info.HostConfig.NetworkMode, 'none');
  assert.equal(info.Config.Labels['opensphere.task'], label);
  execFileSync(docker, ['rm', '-f', '-v', container], { stdio: 'pipe', windowsHide: true });
});
execFileSync(docker, ['run', '-d', '--name', container, '--label', 'opensphere.task=' + label,
  '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw', '--tmpfs', '/work:rw,mode=1777',
  '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'pgvector/pgvector:0.8.2-pg17',
  '-c', 'unix_socket_directories=/var/run/postgresql,/work'], { stdio: 'pipe', windowsHide: true });
created = true;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    execFileSync(docker, ['exec', container, 'pg_isready', '-h', '/work', '-U', 'postgres'], { stdio: 'pipe', windowsHide: true });
    break;
  } catch {
    if (attempt === 39) throw new Error('isolated PostgreSQL did not start');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
function sql(text) {
  try {
    return execFileSync(docker, ['exec', '-i', container, 'psql', '-X', '-h', '/work', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'],
      { input: text, encoding: 'utf8', maxBuffer: 8e6, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();
  } catch (error) { throw new Error(error.stderr || error.message); }
}
sql("DO $$DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['authenticated','authenticator','supabase_auth_admin','supabase_storage_admin','supabase_admin','anon','service_role'] LOOP IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=n) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',n);END IF;END LOOP;END$$;"
  + readFileSync(root + 'migrations/baseline/verify/supabase-test-prerequisites.sql', 'utf8').replace('CREATE ROLE authenticated NOLOGIN;', '')
  + 'CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;');
const manifest = JSON.parse(readFileSync(root + 'migrations/manifest.json', 'utf8'));
for (const entry of manifest.migrations) sql('BEGIN;' + migrationTransactionSql(root, entry) + 'COMMIT;');
const migration = readFileSync(root + 'migrations/versions/0042_module_installation_request_lookup.sql', 'utf8');
sql(migration); // also verifies safe reapplication after registration in the manifest
sql(readFileSync(root + 'migrations/baseline/verify/0001_console_authority.verify.sql', 'utf8').split('SET ROLE console_api;')[0]);
const actor = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
const otherActor = '55555555-5555-4555-8555-555555555555';
const otherSession = '66666666-6666-4666-8666-666666666666';
const key = 'r2d2-install-' + 'a'.repeat(64);
const image = 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:' + 'b'.repeat(64);
const digest = 'sha256:' + 'c'.repeat(64);
const id = sql(`INSERT INTO console_operation.operation(action_id,action_version,actor_ref,target_ref,required_permission,payload_digest,request_digest,risk,reason,aal,permission_revision,plan_revision,approval_required,idempotency_key,correlation_id,state)
  VALUES('console.extension.install','1.0','${actor}','${image}','console.extension.install','${digest}','${digest}','R2','Recover the accepted installation','aal2',7,'recovery-test',false,'${key}','recovery-correlation','Authorized') RETURNING operation_id;`);
const lookup = (a = actor, s = session, k = key) => `SET ROLE console_api; SELECT console_operation.get_operation_by_request('${s}','${a}','${k}');`;
const before = sql('SELECT jsonb_agg(to_jsonb(o)) FROM console_operation.operation o;');
assert.equal(JSON.parse(sql(lookup())).operation_id, id);
assert.equal(JSON.parse(sql(lookup())).state, 'Authorized');
assert.equal(sql(lookup(otherActor, otherSession)), '');
assert.equal(sql(lookup(actor, session, 'r2d2-install-' + 'd'.repeat(64))), '');
assert.equal(sql('SELECT jsonb_agg(to_jsonb(o)) FROM console_operation.operation o;'), before);
console.log('PASS repeated lookup preserves the accepted operation; another actor/missing key sees no record');
function reject(name, statement, pattern) {
  assert.throws(() => sql('BEGIN;' + statement + 'ROLLBACK;'), pattern, name);
  console.log('PASS ' + name);
}
reject('wrong session actor', lookup(actor, otherSession), /SessionInvalid/);
reject('revoked session', `UPDATE console_identity.browser_session SET revoked_at=now(),revoke_reason='test revocation' WHERE session_id='${session}';` + lookup(), /SessionInvalid/);
reject('stale permission revision', `UPDATE console_identity.subject_authority SET permission_revision=8 WHERE subject_id='${actor}';` + lookup(), /StaleAuthorityRevision/);
reject('stale session even for missing key', `UPDATE console_identity.subject_authority SET revoke_epoch=3 WHERE subject_id='${actor}';` + lookup(actor, session, 'missing-key'), /StaleAuthorityRevision/);
reject('anonymous cannot execute', lookup().replace('SET ROLE console_api;', 'SET ROLE anon;'), /permission denied/);
reject('lookup rejects invalid key', lookup(actor, session, 'short'), /ValidationFailed/);
sql(migration);
assert.equal(JSON.parse(sql(lookup())).operation_id, id);
console.log(JSON.stringify({ status: 'passed', engine: 'PostgreSQL 17', isolated: true, network: 'none', migrationReapply: true, liveClusterChanged: false }));
