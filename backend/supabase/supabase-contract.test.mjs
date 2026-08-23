import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Supabase backbone manifest and migrations satisfy ADR-006 static boundary', () => {
  const result = spawnSync(process.execPath, [path.join(here, 'verify.mjs')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
});

test('OSAA PostgREST profile is available only through explicitly granted database roles', () => {
  const manifest = readFileSync(path.join(here, 'bootstrap', 'supabase.yaml'), 'utf8');
  const repairRunner = readFileSync(path.join(here, 'migrations', '0070_osaa_local_edge_repair_runner.sql'), 'utf8');
  assert.match(manifest, /PGRST_DB_SCHEMAS, value: "console,audit,storage,osaa"/);
  assert.match(repairRunner,
    /REVOKE ALL ON osaa\.engineering_remediation_runner,osaa\.engineering_browser_verification\s+FROM PUBLIC,anon,authenticated,service_role/);
  assert.match(repairRunner,
    /GRANT EXECUTE ON FUNCTION osaa\.register_engineering_remediation_runner[\s\S]*TO opensphere_console_backend/);
  assert.doesNotMatch(repairRunner,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL|EXECUTE)[^;]*\b(?:anon|authenticated)\b/i);
});

test('Supabase installer delimits migration identifiers before punctuation', () => {
  const installer = readFileSync(path.join(here, 'install.ps1'), 'utf8');
  assert.match(installer, /Migration checksum drift for \$\{migrationId\}:/);
  assert.doesNotMatch(installer, /Migration checksum drift for \$migrationId:/);
});

test('fresh Supabase install checks ledger existence before reading migration rows', () => {
  const installer = readFileSync(path.join(here, 'install.ps1'), 'utf8');
  assert.match(installer,
    /to_regclass\('console\.schema_migration'\) IS NULL THEN 'absent' ELSE 'present'/);
  assert.match(installer,
    /\$migrationLedgerExists = Test-SupabaseMigrationLedgerExists/);
  assert.match(installer,
    /if \(\$ExistingInstallation -and -not \$migrationLedgerExists\) \{\s*throw 'Existing Supabase installation is missing console\.schema_migration'/);
  assert.match(installer,
    /if \(\$migrationLedgerExists\) \{\s*foreach \(\$migration in \$migrations\)/);

  const preflight = installer.indexOf('$migrationLedgerExists = Test-SupabaseMigrationLedgerExists');
  const guardedRead = installer.indexOf('if ($migrationLedgerExists) {', preflight);
  const firstChecksumRead = installer.indexOf('Get-SupabaseMigrationChecksum $migrationId', guardedRead);
  const ledgerBootstrap = installer.indexOf('Invoke-SupabaseMigrationPsql $migrationLedgerBootstrap');
  assert.ok(preflight >= 0 && guardedRead > preflight && firstChecksumRead > guardedRead);
  assert.ok(ledgerBootstrap > firstChecksumRead,
    'fresh-install preflight must remain read-only until the migration ledger bootstrap');
});

test('fresh Supabase bootstrap runs Storage migrations without waiting on its PostgREST readiness gate', () => {
  const installer = readFileSync(path.join(here, 'install.ps1'), 'utf8');
  const authReady = installer.indexOf(
    "'rollout', 'status', 'deployment/opensphere-supabase-auth', '--timeout=10m'");
  const storageRunning = installer.indexOf(
    "'--for=jsonpath={.status.phase}=Running', 'pod', '-l', 'app=opensphere-supabase-storage'");
  const storageMigration = installer.indexOf("'/app/dist/scripts/migrate-call.js'");
  const consoleMigrations = installer.indexOf(
    '$migrationSql = Get-Content -Raw -LiteralPath $migration.FullName');
  const finalStorageReady = installer.lastIndexOf(
    "foreach ($workload in @('opensphere-supabase-rest', 'opensphere-supabase-storage'))");

  assert.ok(authReady >= 0 && storageRunning > authReady);
  assert.ok(storageMigration > storageRunning && consoleMigrations > storageMigration);
  assert.ok(finalStorageReady > consoleMigrations);

  const bootstrapPrefix = installer.slice(authReady, storageMigration);
  assert.doesNotMatch(bootstrapPrefix,
    /rollout', 'status', 'deployment\/opensphere-supabase-storage'/,
    'Storage readiness depends on PostgREST and must not gate its own schema bootstrap');
});

test('Storage startup gate is executable after a Windows checkout', () => {
  const dockerfile = readFileSync(path.join(here, 'images', 'storage', 'Dockerfile'), 'utf8');
  assert.match(dockerfile,
    /RUN sed -i 's\/\\r\$\/\/' \/usr\/local\/bin\/opensphere-storage-entrypoint\.sh/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/opensphere-storage-entrypoint\.sh"\]/);
});

test('released migration history is immutable and numeric prefixes are never reused', () => {
  const lock = JSON.parse(readFileSync(path.join(here, 'migration-history-lock.json'), 'utf8'));
  const migrationDir = path.join(here, 'migrations');
  const files = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
  const prefixes = new Map();

  for (const file of files) {
    const id = file.slice(0, -4);
    assert.match(id, /^\d{4}_[a-z0-9_]+$/, `invalid migration name: ${file}`);
    const prefix = id.slice(0, 4);
    assert.equal(prefixes.has(prefix), false,
      `migration number ${prefix} is reused by ${prefixes.get(prefix)} and ${file}`);
    prefixes.set(prefix, file);
  }

  const lockedEntries = Object.entries(lock.migrations);
  const highestLockedPrefix = Math.max(...lockedEntries.map(([id]) => Number(id.slice(0, 4))));
  for (const [id, expected] of lockedEntries) {
    const file = `${id}.sql`;
    assert.ok(files.includes(file), `released migration was removed or renamed: ${file}`);
    const canonical = readFileSync(path.join(migrationDir, file), 'utf8').replace(/\r\n/g, '\n');
    const actual = createHash('sha256').update(canonical, 'utf8').digest('hex');
    assert.equal(actual, expected, `released migration content changed: ${file}`);
  }

  for (const file of files) {
    const id = file.slice(0, -4);
    if (Number(id.slice(0, 4)) <= highestLockedPrefix) {
      assert.ok(Object.hasOwn(lock.migrations, id),
        `migration ${file} reuses released history; allocate a number after ${highestLockedPrefix}`);
    }
  }
});

test('migration manifest is the digest-bound canonical inventory', () => {
  const migrationDir = path.join(here, 'migrations');
  const manifest = JSON.parse(readFileSync(path.join(migrationDir, 'manifest.json'), 'utf8'));
  const files = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.migrationCount, files.length);
  assert.deepEqual(manifest.migrations.map(({ name }) => name), files);
  assert.equal(manifest.latestMigrationId, files.at(-1).slice(0, 4));
  const ids = new Set();
  let predecessorMigrationId = null;
  for (const entry of manifest.migrations) {
    assert.equal(entry.id, entry.name.slice(0, 4));
    assert.equal(ids.has(entry.id), false, `duplicate migration ID ${entry.id}`);
    ids.add(entry.id);
    assert.equal(entry.predecessorMigrationId, predecessorMigrationId);
    assert.equal(entry.path, `backend/supabase/migrations/${entry.name}`);
    const canonical = readFileSync(path.join(migrationDir, entry.name), 'utf8').replace(/\r\n/gu, '\n');
    assert.equal(createHash('sha256').update(canonical, 'utf8').digest('hex'), entry.sha256);
    predecessorMigrationId = entry.id;
  }
  const material = manifest.migrations.map(({ id, predecessorMigrationId: predecessor, name, sha256 }) =>
    `${id}\n${predecessor ?? '-'}\n${name}\n${sha256}`).join('\n');
  assert.equal(manifest.setDigest, `sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`);
});

test('OSAA deterministic verification is accepted as append-only agent evidence', () => {
  const sql = readFileSync(path.join(here, 'migrations', '0068_osaa_agent_verification_evidence.sql'), 'utf8');
  assert.match(sql, /DROP CONSTRAINT IF EXISTS agent_step_step_kind_check/);
  assert.match(sql, /CHECK \(step_kind IN \('retrieval', 'llm', 'tool', 'verification'\)\)/);
  assert.match(sql, /ALTER TABLE osaa[.]agent_step/);
  assert.doesNotMatch(sql, /\boaa[.]/);
  assert.doesNotMatch(sql, /DROP TRIGGER|DISABLE TRIGGER|UPDATE osaa[.]agent_step|DELETE FROM osaa[.]agent_step/i);
});

test('component-scoped migration runner provisions only scoped Shell DB credentials and never rolls workloads', () => {
  const runner = readFileSync(path.join(here, 'migrate-only.ps1'), 'utf8');
  assert.match(runner, /manifest\.json/);
  assert.match(runner, /Migration manifest inventory mismatch/);
  assert.match(runner, /NOTIFY pgrst, 'reload schema'/);
  assert.match(runner, /opensphere-shell-api-db/);
  assert.match(runner, /opensphere-shell-gateway-db/);
  assert.match(runner, /opensphere-shell-reconciler-db/);
  assert.match(runner, /NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.doesNotMatch(runner, /rollout\s+(?:restart|status)/i);
  assert.doesNotMatch(runner, /kubectl[^\n]*delete/i);
  assert.doesNotMatch(runner, /(?:deployment|statefulset)[^\n]*(?:apply|patch)/i);
});

test('Shell session ledger is RPC-only, fenced, hash-only, and append-only', () => {
  const sql = readFileSync(path.join(here, 'migrations', '0061_shell_session_ledger.sql'), 'utf8');
  for (const table of ['shell_session', 'shell_attach_ticket', 'shell_session_event']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS console\\.${table}`));
  }
  assert.match(sql, /ticket_hash text PRIMARY KEY CHECK\(ticket_hash~'\^sha256:/);
  assert.doesNotMatch(sql, /\b(raw_ticket|ticket_plaintext|ticket_value)\b/i);
  assert.match(sql, /expires_at<=created_at\+interval '30 seconds'/);
  assert.match(sql, /consumed_at IS NULL AND expires_at>v_now/);
  assert.match(sql, /GET DIAGNOSTICS v_affected=ROW_COUNT/);
  assert.match(sql, /ENABLE ALWAYS TRIGGER shell_session_event_append_only/);
  assert.match(sql, /BEFORE TRUNCATE ON console\.shell_session_event/);
  assert.match(sql, /NEW\.generation<OLD\.generation OR NEW\.fencing_epoch<OLD\.fencing_epoch/);
  assert.match(sql, /current_shell_permission_revision/);
  assert.match(sql, /ORDER BY code COLLATE "C"/);
  assert.match(sql, /FROM PUBLIC,anon,authenticated,service_role,authenticator,opensphere_console_backend/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL) ON TABLE console\.shell_/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION console\.consume_shell_attach_ticket/);
});

test('0062 makes create quota/idempotency and feature drain one atomic RPC-only authority', () => {
  const sql = readFileSync(path.join(here, 'migrations', '0062_shell_session_quota_and_kill_switch.sql'), 'utf8');
  assert.match(sql, /DEFAULT 2 CHECK\(actor_active_limit/);
  assert.match(sql, /DEFAULT 8 CHECK\(global_active_limit/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('opensphere[.]shell[.]global'/);
  assert.match(sql, /ShellSessionIdempotencyConflict/);
  assert.match(sql, /ShellActorSessionQuotaExceeded/);
  assert.match(sql, /ShellGlobalSessionQuotaExceeded/);
  assert.match(sql, /VALUES\(true,false,'0062 requires an explicit AAL2 owner enable/);
  assert.match(sql, /SET desired_state='Terminated'/);
  assert.match(sql, /scale_down_allowed boolean/);
  assert.match(sql, /touch_shell_session_activity/);
  assert.match(sql, /v_now\+interval '15 minutes'/);
  assert.match(sql, /REVOKE ALL ON TABLE console[.]shell_control_state,console[.]shell_control_event/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION console[.]set_shell_feature_state[\s\S]*TO opensphere_console_backend/);
  assert.match(sql, /set_shell_feature_state_local_edge/);
  assert.match(sql, /opensphere-local-edge-release/);
  assert.match(sql, /releaseIntentSignatureSha256/);
  assert.match(sql, /v_state[.]enabled=p_enabled[\s\S]*v_state[.]operation_evidence=p_operation_evidence/);
  assert.match(sql, /v_active=0 AND v_tickets=0/);
  assert.match(sql, /ShellFeatureBrowserEnableRequiresVerifiedRelease/);
  assert.match(sql, /operation_phase IN \('Draining','ScaleDownClaimed'\)/);
  assert.match(sql, /claim_shell_feature_scale_down/);
  assert.match(sql, /ShellFeatureScaleDownClaimHeld/);
  assert.match(sql, /complete_shell_feature_scale_down/);
  assert.doesNotMatch(sql, /GRANT (SELECT|INSERT|UPDATE|DELETE)/);
});

test('0064 binds local-edge feature evidence to the actual append-only migration ledger', () => {
  const sql = readFileSync(path.join(here, 'migrations', '0064_shell_feature_release_ledger_contract.sql'), 'utf8');
  assert.match(sql, /FROM console[.]schema_migration/);
  assert.match(sql, /ORDER BY migration_id DESC/);
  assert.match(sql, /latestMigrationId' IS DISTINCT FROM v_latest_migration_id/);
  assert.match(sql, /sourceRevision' IS DISTINCT FROM v_latest_source_revision/);
  assert.doesNotMatch(sql, /latestMigrationId'<>\s*'006[234]'/);
});

test('actual PostgreSQL verifier uses an isolated per-run container and cleans only its own authority', () => {
  const verifier = readFileSync(path.join(here, 'verify-ledger-integrity.mjs'), 'utf8');
  assert.match(verifier, /os-ledger-verify-\$\{process[.]pid\}-\$\{randomUUID/);
  assert.doesNotMatch(verifier, /const CONTAINER = ['"]os-ledger-verify['"]/);
  assert.match(verifier, /opensphere-ledger-verifier-run\/v1/);
  assert.equal((verifier.match(/\['rm', '-f', CONTAINER\]/g) || []).length, 1);
});

test('full installer provisions three isolated Shell LOGIN roles and workload Secrets', () => {
  const installer = readFileSync(path.join(here, 'install.ps1'), 'utf8');
  for (const role of ['opensphere_shell_api', 'opensphere_shell_gateway', 'opensphere_shell_reconciler']) {
    assert.match(installer, new RegExp(`CREATE ROLE ${role} LOGIN PASSWORD`));
    assert.match(installer, new RegExp(`ALTER ROLE ${role} LOGIN PASSWORD`));
  }
  for (const name of ['opensphere-shell-api-db', 'opensphere-shell-gateway-db', 'opensphere-shell-reconciler-db']) {
    assert.match(installer, new RegExp(name));
  }
  assert.match(installer, /opensphere\.io\/authority: cbss/);
});

test('R2D2 activation grants the query role only read access to observer fencing', () => {
  const migrationDir = path.join(here, 'migrations');
  const sql = readFileSync(path.join(migrationDir, '0054_r2d2_activation_runtime_fixes.sql'), 'utf8');
  assert.match(sql, /GRANT SELECT ON oaa\.observer_fence TO opensphere_oaa_gateway, opensphere_oaa_api;/);
  assert.match(sql, /FOR SELECT TO opensphere_oaa_gateway, opensphere_oaa_api USING \(true\)/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE|ALL)/);
});

test('R2D2 reconcile evidence uses locale-independent bytewise ordering', () => {
  const migrationDir = path.join(here, 'migrations');
  const sql = readFileSync(path.join(migrationDir, '0055_r2d2_reconcile_digest_collation.sql'), 'utf8');
  assert.match(sql, /string_agg\(node_id, E'\\n' ORDER BY node_id COLLATE "C"\)/);
  assert.match(sql, /p_completeness_digest IS DISTINCT FROM expected_digest/);
});

test('R2D2 relation monotonicity never dereferences a node-only record field', () => {
  const migrationDir = path.join(here, 'migrations');
  const sql = readFileSync(path.join(migrationDir, '0056_r2d2_relation_monotonicity.sql'), 'utf8');
  assert.match(sql, /to_jsonb\(NEW\)->>'stream_sequence'/);
  assert.match(sql, /TG_TABLE_NAME = 'resource_node'/);
  assert.doesNotMatch(sql, /coalesce\(NEW\.stream_sequence/);
});

test('0071 keeps Dialogue State in CBSS and atomically separates it from Agent Runtime evidence', () => {
  const sql = readFileSync(path.join(here, 'migrations', '0071_osaa_dialogue_state_transition.sql'), 'utf8');
  const installer = readFileSync(path.join(here, 'install.ps1'), 'utf8');
  const migrationTransaction = readFileSync(path.join(here, 'migration-transaction.ps1'), 'utf8');
  assert.match(sql, /CREATE TABLE osaa[.]dialogue_state_projection/);
  assert.match(sql, /CREATE TABLE osaa[.]dialogue_state_transition/);
  assert.match(sql, /conversation_id uuid NOT NULL REFERENCES osaa[.]conversation\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /UNIQUE \(conversation_id, turn_request_id\)/);
  assert.match(sql, /UNIQUE \(conversation_id, next_revision\)/);
  assert.match(sql, /next_revision = base_revision \+ 1/);
  assert.match(sql, /ENABLE ALWAYS TRIGGER dialogue_state_transition_append_only/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /c[.]owner_id=current_setting\('opensphere[.]actor_id', true\)/);
  assert.match(sql, /enforce_dialogue_transition_chain/);
  assert.match(sql, /dialogue_genesis_digest/);
  assert.match(sql, /verify_dialogue_state_chain/);
  assert.match(sql, /BEFORE TRUNCATE ON osaa[.]dialogue_state_transition/);
  assert.match(sql, /CREATE ROLE opensphere_osaa_dialogue_maintenance NOLOGIN NOINHERIT NOBYPASSRLS/);
  assert.match(sql, /TO opensphere_osaa_dialogue_maintenance/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION osaa[.]reap_expired_dialogue_turns[^;]+opensphere_osaa_gateway/is);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT)\s*;/im);
  assert.match(installer, /New-SupabaseMigrationTransactionSql/);
  assert.match(migrationTransaction, /Migration \$MigrationId must not contain transaction control; the installer owns atomic attestation/);
  assert.match(migrationTransaction, /VALUES \('\$MigrationId', '\$Checksum', '\$SourceRevision', current_user\);/);
  assert.match(sql, /REVOKE UPDATE, DELETE, TRUNCATE ON osaa[.]dialogue_state_transition/);
  assert.match(sql, /purge_dialogue_state\(/);
  assert.match(sql, /conversation has a pending turn/);
  assert.match(sql, /dialogue_state_purge_receipt/);
  assert.match(sql, /CREATE TABLE osaa[.]dialogue_turn_recovery_receipt/);
  assert.match(sql, /reap_expired_dialogue_turns/);
  assert.match(sql, /recover_dialogue_turn/);
  assert.match(sql, /migration-needs-reconciliation/);
  assert.match(sql, /dialogue_turn_recovery_receipt_append_only/);
  assert.match(sql, /DROP POLICY IF EXISTS osaa_gateway_conversation/);
  assert.match(sql, /ALTER TABLE osaa[.]conversation FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /osaa_gateway_conversation_message_select/);
  assert.match(sql, /REVOKE DELETE, TRUNCATE ON osaa[.]conversation/);
  assert.doesNotMatch(sql, /agent_step|agent_run/);
  assert.doesNotMatch(sql, /ON CONFLICT[^;]*DO NOTHING/is);
});

test('0072 removes shared-JWT role assumption and owner-binds manual recovery', () => {
  const sql = readFileSync(path.join(here, 'migrations', '0072_osaa_dialogue_maintenance_identity.sql'), 'utf8');
  const installer = readFileSync(path.join(here, 'install.ps1'), 'utf8');
  assert.match(sql, /REVOKE opensphere_osaa_dialogue_maintenance FROM authenticator/);
  assert.match(sql, /session_user <> 'opensphere_osaa_dialogue_maintenance'/);
  assert.match(sql, /expected_owner_id text/);
  assert.match(sql, /AND c[.]owner_id=expected_owner_id/);
  assert.match(sql, /recover_dialogue_turn\(uuid, uuid, text, text\)/);
  assert.match(installer, /opensphere-osaa-maintenance-runtime/);
  assert.match(installer, /CREATE ROLE opensphere_osaa_dialogue_maintenance LOGIN PASSWORD/);
});
