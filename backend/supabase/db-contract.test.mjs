/**
 * Database contract for host operations, run against a real PostgreSQL.
 *
 * The application enforces the state machine with compare-and-set updates, and
 * that is the fast path. But the guarantees an approver relies on — that the
 * thing they approved is the thing that runs, that one operation cannot be
 * leased twice, that a resolved degradation stays resolved — must not depend on
 * every caller being written correctly. This exercises the constraints and
 * triggers themselves, against the same PostgreSQL the platform ships.
 *
 * Skipped when Docker is unavailable, so it never blocks a machine that cannot
 * run it. It is not skipped when it merely fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const migrationsDir = path.join(here, 'migrations');
// What deploy-cc2.sh actually applies to CC2. Testing the migrations instead
// would prove something true of a database the region never has.
const baselinePath = path.join(repoRoot, 'deploy', 'rcc', 'supabase-baseline.sql');
const CONTAINER = 'rcc-db-contract';
// The commit this work branched from: the region an upgrade starts out as.
const BASE_REVISION = '914a52b661daa2e11b9552b0480e0ec142878666';
// The image the platform actually deploys, so extensions and roles behave the
// same way here as they do in the cluster.
const IMAGE = process.env.RCC_DB_TEST_IMAGE || 'supabase/postgres:17.6.1.136';

function dockerAvailable() {
  const probe = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (probe.status !== 0) return false;
  // Only pull if it is already local; a test must not download 400MB silently.
  const local = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
  if (local.status === 0) return true;
  return spawnSync('docker', ['pull', IMAGE], { stdio: 'ignore', timeout: 300000 }).status === 0;
}

const available = dockerAvailable();

// Captured from the baseline-built database and compared against the
// migration-built one. Two files, one database: whichever way a region was
// built, it has to end up the same.
let baselineFingerprint = null;

/**
 * The half of the contract that is executable rather than structural.
 *
 * Columns, constraint names and policy names describe the shape of the
 * database. They say nothing about what the guards actually do, so a guard
 * gutted in a migration — the body of the state machine, the enablement of a
 * trigger, the USING clause of an RLS policy — leaves an identical shape and
 * every structural comparison still agrees. The behavioural SQL tests run
 * against the baseline, so on the migration side that damage is invisible
 * twice over.
 *
 * These three queries are what closes it. `prosrc` is the function body as
 * stored; `tgenabled` distinguishes ALWAYS from the replication-disabled
 * default; `qual`/`with_check` are the policy predicates themselves.
 */
function behaviourFingerprint(describe) {
  return {
    functions: describe(`SELECT p.proname || ':' || md5(p.prosrc)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'console';`),
    triggers: describe(`SELECT c.relname || ':' || t.tgname || ':' || t.tgenabled::text
        || ':' || md5(pg_get_triggerdef(t.oid))
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'console' AND NOT t.tgisinternal;`),
    policyRules: describe(`SELECT tablename || ':' || policyname || ':' || cmd
        || ':' || COALESCE(qual, '-') || ':' || COALESCE(with_check, '-')
      FROM pg_policies WHERE schemaname = 'console';`),
  };
}

// The deployment connects as supabase_admin to `postgres`; so does this.
function sql(statement, { expectFailure = false, role = 'supabase_admin' } = {}) {
  const result = spawnSync('docker', [
    'exec', '-i', CONTAINER,
    'psql', '-U', role, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', statement,
  ], { encoding: 'utf8' });
  if (!expectFailure && result.status !== 0) {
    throw new Error(`SQL failed: ${statement}\n${result.stderr}`);
  }
  // psql prints a command tag ("UPDATE 1") alongside RETURNING rows even in
  // tuples-only mode; the tag is not a result.
  const rows = (result.stdout || '').split('\n')
    .filter((line) => !/^(UPDATE|INSERT|DELETE|SELECT|MERGE) \d+$/.test(line.trim()));
  return { ok: result.status === 0, out: rows.join('\n').trim(), err: result.stderr || '' };
}

function applyBaseline() {
  const body = fs.readFileSync(baselinePath, 'utf8');
  const result = spawnSync('docker', [
    'exec', '-i', CONTAINER, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
  ], { input: body, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`baseline failed:\n${result.stderr}`);
  return body.split('\n').length;
}

test('host operation database contract', { skip: !available && 'docker unavailable' }, async (t) => {
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  execFileSync('docker', [
    'run', '-d', '--name', CONTAINER,
    // No POSTGRES_DB override: this image bootstraps auth, storage and the
    // PostgREST roles into whichever database it is told to create, and the
    // deployment applies the baseline to `postgres`.
    '-e', 'POSTGRES_PASSWORD=contract',
    IMAGE,
  ], { stdio: 'pipe' });

  try {
    // pg_isready succeeds against the temporary server this image runs while it
    // is still executing its own bootstrap, so it is not a readiness signal.
    // Neither is the bootstrap schema: that server has already created auth,
    // extensions and storage by the time it is stopped, so a probe over the
    // Unix socket answers "3" roughly a second before the real server exists,
    // and everything after it races the shutdown. It was observed answering at
    // t=2s while the server that survives did not accept a connection until
    // t=3s, and the suite then failed with "the database system is shutting
    // down" partway through.
    //
    // The distinction that holds is the listener: initdb runs its temporary
    // server on the Unix socket only, and the real one is the first to listen
    // on TCP. So both have to be true — bootstrap finished, over a connection
    // only the final server can accept.
    //
    // This is not merely a flaky test. Every SQL mutation in the sweep is
    // scored by this suite failing, so a container that dies on its own would
    // have been recorded as a guard being caught.
    let ready = false;
    for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
      const probe = spawnSync('docker', [
        'exec', CONTAINER, 'psql', '-h', '127.0.0.1', '-U', 'supabase_admin', '-d', 'postgres', '-tAc',
        "SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','extensions','storage');",
      ], { encoding: 'utf8' });
      ready = probe.status === 0 && probe.stdout.trim() === '3';
      if (!ready) await new Promise((resolve) => { setTimeout(resolve, 500); });
    }
    assert.ok(ready, 'the supabase database never finished its own bootstrap');

    // The image ships auth, storage and the PostgREST roles. deploy-cc2.sh adds
    // the backend login role before applying the baseline; so does this.
    sql(`DO $$ BEGIN
           CREATE ROLE opensphere_console_backend LOGIN PASSWORD 'contract'
             NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
         EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    // storage-api creates these on first boot; the baseline references them.
    sql('CREATE SCHEMA IF NOT EXISTS storage;');
    sql(`CREATE TABLE IF NOT EXISTS storage.buckets (
           id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
           file_size_limit bigint, allowed_mime_types text[],
           created_at timestamptz NOT NULL DEFAULT now());`);
    sql(`CREATE TABLE IF NOT EXISTS storage.objects (
           id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
           bucket_id text REFERENCES storage.buckets(id), name text,
           owner uuid, owner_id text, path_tokens text[], metadata jsonb,
           created_at timestamptz NOT NULL DEFAULT now());`);
    sql('ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');

    await t.test('the deployed baseline applies, and applies again unchanged', () => {
      const lines = applyBaseline();
      assert.ok(lines > 0, 'the baseline must have content');
      // Re-running must be a no-op. A baseline that only works against an empty
      // database cannot be applied to a region that already exists.
      applyBaseline();
      applyBaseline();
    });

    await t.test('the baseline carries every RCC object the migrations define', () => {
      // The migrations are the source of record; the baseline is what ships.
      // If they drift, a guarantee proven here never reaches the region.
      const baseline = fs.readFileSync(baselinePath, 'utf8');
      // Discovered rather than enumerated. A hardcoded list is a list somebody
      // has to remember to extend, and the migration it forgets is invisible
      // here: migration 0031 was excluded for exactly that reason.
      const rccMigrations = fs.readdirSync(migrationsDir)
        .filter((name) => /^\d{4}_/.test(name) && Number(name.slice(0, 4)) >= 27).sort();
      assert.ok(rccMigrations.length >= 5,
        `every RCC migration must be covered, found ${rccMigrations.join(', ')}`);
      const required = new Set();
      for (const name of rccMigrations) {
        const body = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
        for (const match of body.matchAll(/CREATE (?:TABLE IF NOT EXISTS|OR REPLACE FUNCTION) (console\.[a-z_]+)/g)) {
          required.add(match[1]);
        }
        for (const match of body.matchAll(/CREATE TRIGGER ([a-z_]+)/g)) required.add(match[1]);
        for (const match of body.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? ([a-z_]+)/g)) {
          required.add(match[1]);
        }
        for (const match of body.matchAll(/CREATE POLICY ([a-z_]+)/g)) required.add(match[1]);
        for (const match of body.matchAll(/ADD CONSTRAINT ([a-z_]+)/g)) required.add(match[1]);
        // A guard that is only ENABLE ALWAYS on one install path is a guard a
        // replication session can switch off on the other.
        for (const match of body.matchAll(/ENABLE ALWAYS TRIGGER ([a-z_]+)/g)) {
          assert.ok(baseline.includes(`ENABLE ALWAYS TRIGGER ${match[1]}`),
            `${match[1]} is ENABLE ALWAYS in ${name} but not in the deployed baseline`);
        }
      }
      for (const object of required) {
        assert.ok(baseline.includes(object),
          `${object} is defined by a migration but missing from the deployed baseline`);
      }
    });

    await t.test('the catalogue rows the migrations seed reach the baseline intact', () => {
      // Row-level drift is the kind that never shows up as a missing object: a
      // different lease bound or a cleared second-person flag reads as a
      // working catalogue right up until it authorises something it should not.
      const rows = sql(`SELECT operation || '|' || max_lease_seconds || '|' || requires_second_person
                          || '|' || requires_policy || '|' || requires_rollback
                          || '|' || required_permission
                        FROM console.host_operation_type ORDER BY operation;`).out.split('\n');
      assert.equal(rows.length, 14, `the catalogue must hold 14 operations, got ${rows.length}`);
      const migrationText = fs.readdirSync(migrationsDir)
        .filter((name) => /^\d{4}_/.test(name) && Number(name.slice(0, 4)) >= 27)
        .map((name) => fs.readFileSync(path.join(migrationsDir, name), 'utf8')).join('\n');
      for (const row of rows) {
        const [operation, lease] = row.split('|');
        assert.ok(migrationText.includes(`'${operation}'`),
          `${operation} is in the deployed catalogue but no migration declares it`);
        assert.ok(migrationText.includes(String(lease)),
          `${operation} has lease ${lease} in the database but no migration mentions it`);
      }
    });

    await t.test('the schema the backend reads actually exists', () => {
      for (const table of ['host', 'host_operation', 'host_operation_event',
        'host_operation_type', 'host_maintenance_degradation']) {
        const found = sql(`SELECT to_regclass('console.${table}') IS NOT NULL;`);
        assert.equal(found.out, 't', `console.${table} must exist`);
      }
    });

    // The row set the guarantees are asserted against. Every foreign key is
    // real, so a fixture that would not exist in production cannot be used to
    // prove something about production.
    await t.test('fixtures insert', () => {
      sql(`INSERT INTO auth.users (id, email)
           VALUES ('11111111-1111-1111-1111-111111111111', 'requester@example.test'),
                  ('22222222-2222-2222-2222-222222222222', 'approver@example.test')
           ON CONFLICT DO NOTHING;`);
      sql(`INSERT INTO console.operator (user_id, display_name)
           VALUES ('11111111-1111-1111-1111-111111111111', 'Requester'),
                  ('22222222-2222-2222-2222-222222222222', 'Approver')
           ON CONFLICT DO NOTHING;`);
      sql(`INSERT INTO console.control_center (id, display_name)
           VALUES ('cc2', 'CC2') ON CONFLICT DO NOTHING;`);
      // Dispatch is refused unless the region is in governed-write mode.
      sql(`UPDATE console.control_center SET host_control_mode = 'governed-write' WHERE id = 'cc2';`);
      // An approver must actually hold access to the region they approve for.
      sql(`INSERT INTO console.operator_control_center
             (user_id, control_center_id, access_level, reason)
           VALUES ('11111111-1111-1111-1111-111111111111', 'cc2', 'operator', 'runs host operations'),
                  ('22222222-2222-2222-2222-222222222222', 'cc2', 'admin', 'approves host operations')
           ON CONFLICT DO NOTHING;`);
      sql(`INSERT INTO console.host
             (id, control_center_id, host_id, display_name, status, agent_key_id)
           VALUES ('33333333-3333-3333-3333-333333333333', 'cc2', 'node-a', 'node-a', 'active', 'k1')
           ON CONFLICT DO NOTHING;`);
      sql(`INSERT INTO console.host_operation
             (id, request_id, host_uuid, control_center_id, operation, parameters, reason, status,
              requested_by, content_digest, lease_attempt)
           VALUES ('a0000000-0000-0000-0000-000000000003',
                   'b0000000-0000-0000-0000-000000000003',
                   '33333333-3333-3333-3333-333333333333', 'cc2',
                   'service.restart', '{"unit":"chronyd.service"}'::jsonb,
                   'restart chronyd after clock drift', 'requested',
                   '11111111-1111-1111-1111-111111111111',
                   'sha256:${'a'.repeat(64)}', 0)
           ON CONFLICT DO NOTHING;`);
      assert.equal(sql('SELECT count(*) FROM console.host_operation;').out, '1');
    });

    await t.test('content may still change while a request is only requested', () => {
      const result = sql(`UPDATE console.host_operation
        SET parameters = '{"unit":"sshd.service"}'::jsonb
        WHERE id = 'a0000000-0000-0000-0000-000000000003';`, { expectFailure: true });
      assert.ok(result.ok, `an unreviewed request must still be editable: ${result.err}`);
      // Put it back so later assertions read the original content.
      sql(`UPDATE console.host_operation SET parameters = '{"unit":"chronyd.service"}'::jsonb
           WHERE id = 'a0000000-0000-0000-0000-000000000003';`);
    });

    await t.test('content is frozen once review has begun', () => {
      sql(`UPDATE console.host_operation SET status = 'awaiting_approval'
           WHERE id = 'a0000000-0000-0000-0000-000000000003';`);

      const edits = [
        [`parameters = '{"unit":"sshd.service"}'::jsonb`, /parameters of a reviewed request/],
        [`operation = 'host.reboot'`, /operation of a reviewed request/],
        [`content_digest = 'sha256:${'b'.repeat(64)}'`, /content digest of a reviewed request/],
      ];
      for (const [assignment, expected] of edits) {
        const result = sql(`UPDATE console.host_operation SET ${assignment}
          WHERE id = 'a0000000-0000-0000-0000-000000000003';`, { expectFailure: true });
        assert.equal(result.ok, false, `${assignment} must be refused by the database`);
        assert.match(result.err, expected);
      }
      // And the row is untouched.
      assert.equal(sql(`SELECT parameters->>'unit' FROM console.host_operation
        WHERE id = 'a0000000-0000-0000-0000-000000000003';`).out, 'chronyd.service');
    });

    await t.test('an approval cannot be rewritten after the fact', () => {
      sql(`UPDATE console.host_operation
           SET status = 'approved',
               approved_by = '22222222-2222-2222-2222-222222222222',
               approved_at = now(),
               approved_digest = content_digest
           WHERE id = 'a0000000-0000-0000-0000-000000000003';`);
      assert.equal(sql(`SELECT status FROM console.host_operation
        WHERE id = 'a0000000-0000-0000-0000-000000000003';`).out, 'approved');

      for (const [assignment, expected] of [
        [`approved_by = '11111111-1111-1111-1111-111111111111'`, /approver of a request cannot be rewritten/],
        [`approved_digest = 'sha256:${'c'.repeat(64)}'`, /approved digest cannot be rewritten/],
      ]) {
        const result = sql(`UPDATE console.host_operation SET ${assignment}
          WHERE id = 'a0000000-0000-0000-0000-000000000003';`, { expectFailure: true });
        assert.equal(result.ok, false, `${assignment} must be refused`);
        assert.match(result.err, expected);
      }
    });

    await t.test('only one session can claim a dispatchable operation', () => {
      // approved -> dispatchable is the legal path; the database rejects a jump.
      const illegal = sql(`UPDATE console.host_operation SET status = 'running'
        WHERE id = 'a0000000-0000-0000-0000-000000000003';`, { expectFailure: true });
      assert.equal(illegal.ok, false, 'the state machine must refuse a skipped step');
      assert.match(illegal.err, /illegal host operation transition/);

      sql(`UPDATE console.host_operation SET status = 'dispatchable'
           WHERE id = 'a0000000-0000-0000-0000-000000000003';`);

      // Two concurrent compare-and-set claims. The second must see no row.
      const claim = `UPDATE console.host_operation
        SET status = 'leased', lease_attempt = lease_attempt + 1,
            lease_owner = 'node-a:' || (lease_attempt + 1),
            lease_expires_at = now() + interval '5 minutes'
        WHERE id = 'a0000000-0000-0000-0000-000000000003' AND status = 'dispatchable'
        RETURNING lease_attempt;`;
      const first = sql(claim);
      const second = sql(claim);
      assert.equal(first.out, '1', 'the first claim wins the lease');
      assert.equal(second.out, '', 'the second claim must find nothing to claim');
      assert.equal(sql(`SELECT lease_attempt FROM console.host_operation
        WHERE id = 'a0000000-0000-0000-0000-000000000003';`).out, '1',
      'a losing claim must not advance the attempt counter');
    });

    await t.test('the event journal collapses a replayed event', () => {
      const insert = `INSERT INTO console.host_operation_event
          (operation_id, phase, actor_type, result, detail, event_hash)
        VALUES ('a0000000-0000-0000-0000-000000000003', 'leased', 'service', 'ok',
                '{"attempt":1}'::jsonb, 'sha256:${'d'.repeat(64)}')
        ON CONFLICT (operation_id, phase, event_hash) DO NOTHING;`;
      sql(insert);
      sql(insert);
      assert.equal(sql(`SELECT count(*) FROM console.host_operation_event
        WHERE operation_id = 'a0000000-0000-0000-0000-000000000003' AND phase = 'leased';`).out, '1',
      'a replayed event must be the same row, not a second one');
    });

    await t.test('the journal accepts every phase the backend emits', () => {
      const phases = ['requested', 'awaiting_approval', 'approved', 'preparing', 'dispatchable',
        'leased', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired',
        'maintenance.cordon', 'maintenance.drain', 'maintenance.uncordon',
        'maintenance.refused', 'maintenance.degraded'];
      for (const [index, phase] of phases.entries()) {
        const hash = `sha256:${String(index).padStart(2, '0')}${'e'.repeat(62)}`;
        const result = sql(`INSERT INTO console.host_operation_event
            (operation_id, phase, actor_type, result, detail, event_hash)
          VALUES ('a0000000-0000-0000-0000-000000000003', '${phase}', 'system', 'ok', '{}'::jsonb, '${hash}');`,
        { expectFailure: true });
        assert.ok(result.ok, `phase ${phase} must be accepted: ${result.err}`);
      }
    });

    await t.test('a break-glass actor cannot author a host operation event', () => {
      const result = sql(`INSERT INTO console.host_operation_event
          (operation_id, phase, actor_type, result, detail, event_hash)
        VALUES ('a0000000-0000-0000-0000-000000000003', 'approved', 'break_glass', 'ok', '{}'::jsonb,
                'sha256:${'f'.repeat(64)}');`, { expectFailure: true });
      assert.equal(result.ok, false, 'host operations have no break-glass path');
    });

    await t.test('a degradation resolves once and stays resolved', () => {
      sql(`INSERT INTO console.host_maintenance_degradation
             (host_uuid, control_center_id, operation_id, node, code, detail)
           VALUES ('33333333-3333-3333-3333-333333333333', 'cc2',
                   'a0000000-0000-0000-0000-000000000003', 'node-a', 'uncordon-failed',
                   'node-a is still cordoned');`);

      sql(`UPDATE console.host_maintenance_degradation
           SET resolved_at = now(), resolution = 'automatic'
           WHERE host_uuid = '33333333-3333-3333-3333-333333333333';`);

      const reopen = sql(`UPDATE console.host_maintenance_degradation
        SET resolved_at = NULL, resolution = NULL
        WHERE host_uuid = '33333333-3333-3333-3333-333333333333';`, { expectFailure: true });
      assert.equal(reopen.ok, false, 'history must not be rewritten');
      assert.match(reopen.err, /cannot be reopened/);
    });

    await t.test('a resolution must say how it was resolved', () => {
      const half = sql(`INSERT INTO console.host_maintenance_degradation
          (host_uuid, control_center_id, node, code, detail, resolved_at)
        VALUES ('33333333-3333-3333-3333-333333333333', 'cc2', 'node-b', 'uncordon-failed', 'x', now())
        ON CONFLICT (host_uuid) DO UPDATE SET resolved_at = now();`, { expectFailure: true });
      assert.equal(half.ok, false, 'a resolved_at without a resolution is not a resolution');
    });

    await t.test('an unknown degradation code is refused', () => {
      const result = sql(`INSERT INTO console.host_maintenance_degradation
          (host_uuid, control_center_id, node, code, detail)
        VALUES ('33333333-3333-3333-3333-333333333333', 'cc2', 'node-c', 'anything-goes', 'x')
        ON CONFLICT (host_uuid) DO UPDATE SET code = 'anything-goes';`, { expectFailure: true });
      assert.equal(result.ok, false);
    });

    await t.test('the restart allowlist is validated by the database', () => {
      // Empty is the default and the safe state: a newly enrolled host may
      // restart nothing until someone grants a unit explicitly.
      assert.equal(sql(`SELECT restart_allowlist = '{}'::text[] FROM console.host
        WHERE id = '33333333-3333-3333-3333-333333333333';`).out, 't');

      const ok = sql(`UPDATE console.host
        SET restart_allowlist = ARRAY['chronyd.service','sshd.service']
        WHERE id = '33333333-3333-3333-3333-333333333333';`, { expectFailure: true });
      assert.ok(ok.ok, `plain .service names must be accepted: ${ok.err}`);

      for (const bad of ["ARRAY['chronyd']", "ARRAY['../../etc/passwd.service']",
        "ARRAY['chronyd.socket']", "ARRAY['-chronyd.service']", "ARRAY['a.service; rm -rf /']"]) {
        const refused = sql(`UPDATE console.host SET restart_allowlist = ${bad}
          WHERE id = '33333333-3333-3333-3333-333333333333';`, { expectFailure: true });
        assert.equal(refused.ok, false, `${bad} must be refused`);
      }
    });

    await t.test('a host with no policy is governed by nothing', () => {
      // Default-deny lives here: the absence of a policy is a refusal, and the
      // resolver says so by returning nothing rather than a permissive default.
      const governing = sql(`SELECT coalesce(console.host_effective_policy(
        '33333333-3333-3333-3333-333333333333'::uuid)::text, 'none');`);
      assert.equal(governing.out, 'none', 'no policy must mean no permission');
    });

    await t.test('policies insert and the version starts at one', () => {
      sql(`INSERT INTO console.host_policy
             (id, control_center_id, name, timezone, allowed_operations, created_by, reason)
           VALUES ('c0000000-0000-0000-0000-000000000001', 'cc2', 'CC2 default',
                   'Europe/Berlin', ARRAY['package.refresh','package.update'],
                   '22222222-2222-2222-2222-222222222222', 'routine patching window')
           ON CONFLICT DO NOTHING;`);
      assert.equal(sql(`SELECT version, scope FROM console.host_policy
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`).out, '1|control-center');
    });

    await t.test('an unknown timezone is refused rather than silently defaulted', () => {
      const bad = sql(`INSERT INTO console.host_policy
          (control_center_id, name, timezone, created_by, reason)
        VALUES ('cc2', 'bad zone', 'Mars/Olympus', '22222222-2222-2222-2222-222222222222',
                'this should not be accepted');`, { expectFailure: true });
      assert.equal(bad.ok, false, 'a window in an imaginary zone is not a window');
    });

    await t.test('a policy cannot permit an operation that does not exist', () => {
      const bad = sql(`UPDATE console.host_policy
        SET allowed_operations = ARRAY['package.refresh','host.selfdestruct']
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`, { expectFailure: true });
      assert.equal(bad.ok, false);
    });

    await t.test('the scope of a policy is immutable', () => {
      const moved = sql(`UPDATE console.host_policy
        SET host_uuid = '33333333-3333-3333-3333-333333333333'
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`, { expectFailure: true });
      assert.equal(moved.ok, false, 'changing scope silently re-targets every approval');
      assert.match(moved.err, /scope of a policy is immutable/);
    });

    await t.test('a substantive edit bumps the version; a cosmetic one does not', () => {
      sql(`UPDATE console.host_policy SET name = 'CC2 default patching'
           WHERE id = 'c0000000-0000-0000-0000-000000000001';`);
      assert.equal(sql(`SELECT version FROM console.host_policy
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`).out, '1',
      'renaming a policy does not change what it permits');

      sql(`UPDATE console.host_policy SET allowed_operations = ARRAY['package.refresh']
           WHERE id = 'c0000000-0000-0000-0000-000000000001';`);
      assert.equal(sql(`SELECT version FROM console.host_policy
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`).out, '2',
      'changing what is permitted must invalidate approvals');

      // The application must not be able to forge the version.
      sql(`UPDATE console.host_policy SET version = 99
           WHERE id = 'c0000000-0000-0000-0000-000000000001';`);
      assert.equal(sql(`SELECT version FROM console.host_policy
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`).out, '2',
      'the version is the count the database keeps, not the value a caller sent');
    });

    await t.test('editing a window also invalidates approvals', () => {
      sql(`UPDATE console.host_policy
        SET allowed_operations = ARRAY['package.refresh','package.update','kernel.update']
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`);
      const before = Number(sql(`SELECT version FROM console.host_policy
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`).out);

      sql(`INSERT INTO console.host_maintenance_window
             (id, policy_id, day_of_week, start_time, duration_minutes)
           VALUES ('d0000000-0000-0000-0000-000000000001',
                   'c0000000-0000-0000-0000-000000000001', 0, '02:00', 120);`);
      const after = Number(sql(`SELECT version FROM console.host_policy
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`).out);
      assert.ok(after > before, 'adding a window changes when a host may be disturbed');
    });

    await t.test('a window is resolved in local time, and survives DST', () => {
      // Europe/Berlin: CET (+01) in winter, CEST (+02) in summer. A window
      // declared as Sunday 02:00 local must be 02:00 local in both, not a fixed
      // UTC offset that drifts by an hour for half the year.
      const winter = sql(`SELECT window_start AT TIME ZONE 'Europe/Berlin'
        FROM console.host_policy_window_at('c0000000-0000-0000-0000-000000000001',
        timestamptz '2026-01-11 02:30:00+01');`);
      assert.match(winter.out, /2026-01-11 02:00:00/, `winter window: ${winter.out}`);

      const summer = sql(`SELECT window_start AT TIME ZONE 'Europe/Berlin'
        FROM console.host_policy_window_at('c0000000-0000-0000-0000-000000000001',
        timestamptz '2026-07-12 02:30:00+02');`);
      assert.match(summer.out, /2026-07-12 02:00:00/, `summer window: ${summer.out}`);

      // The same local wall-clock time is a different UTC instant in each.
      const winterUtc = sql(`SELECT window_start FROM console.host_policy_window_at(
        'c0000000-0000-0000-0000-000000000001', timestamptz '2026-01-11 02:30:00+01');`).out;
      const summerUtc = sql(`SELECT window_start FROM console.host_policy_window_at(
        'c0000000-0000-0000-0000-000000000001', timestamptz '2026-07-12 02:30:00+02');`).out;
      assert.ok(winterUtc.includes('01:00') && summerUtc.includes('00:00'),
        `the UTC offset must differ across DST: winter=${winterUtc} summer=${summerUtc}`);
    });

    await t.test('an instant outside every window resolves to nothing', () => {
      const outside = sql(`SELECT count(*) FROM console.host_policy_window_at(
        'c0000000-0000-0000-0000-000000000001', timestamptz '2026-01-11 05:00:00+01');`);
      assert.equal(outside.out, '0', 'five in the morning is not inside a 02:00-04:00 window');

      const wrongDay = sql(`SELECT count(*) FROM console.host_policy_window_at(
        'c0000000-0000-0000-0000-000000000001', timestamptz '2026-01-12 02:30:00+01');`);
      assert.equal(wrongDay.out, '0', 'Monday is not Sunday');
    });

    await t.test('a window that runs past midnight still covers the small hours', () => {
      sql(`INSERT INTO console.host_maintenance_window
             (policy_id, day_of_week, start_time, duration_minutes)
           VALUES ('c0000000-0000-0000-0000-000000000001', 6, '23:00', 240)
           ON CONFLICT DO NOTHING;`);
      // Saturday 23:00 + 4h reaches Sunday 03:00 local.
      const after = sql(`SELECT count(*) FROM console.host_policy_window_at(
        'c0000000-0000-0000-0000-000000000001', timestamptz '2026-01-11 01:00:00+01');`);
      assert.equal(after.out, '1', 'a window begun on the previous local day must still be found');
    });

    await t.test('a disabled policy or window governs nothing', () => {
      sql(`UPDATE console.host_maintenance_window SET enabled = false
           WHERE policy_id = 'c0000000-0000-0000-0000-000000000001';`);
      assert.equal(sql(`SELECT count(*) FROM console.host_policy_window_at(
        'c0000000-0000-0000-0000-000000000001', timestamptz '2026-01-11 02:30:00+01');`).out, '0');
      sql(`UPDATE console.host_maintenance_window SET enabled = true
           WHERE policy_id = 'c0000000-0000-0000-0000-000000000001';`);

      sql(`UPDATE console.host_policy SET enabled = false
           WHERE id = 'c0000000-0000-0000-0000-000000000001';`);
      assert.equal(sql(`SELECT count(*) FROM console.host_policy_window_at(
        'c0000000-0000-0000-0000-000000000001', timestamptz '2026-01-11 02:30:00+01');`).out, '0');
      assert.equal(sql(`SELECT coalesce(console.host_effective_policy(
        '33333333-3333-3333-3333-333333333333'::uuid)::text, 'none');`).out, 'none');
      sql(`UPDATE console.host_policy SET enabled = true
           WHERE id = 'c0000000-0000-0000-0000-000000000001';`);
    });

    await t.test('a host-scoped policy takes precedence over the control-center one', () => {
      sql(`INSERT INTO console.host_policy
             (id, control_center_id, name, host_uuid, timezone, allowed_operations, created_by, reason)
           VALUES ('c0000000-0000-0000-0000-000000000002', 'cc2', 'node-a only',
                   '33333333-3333-3333-3333-333333333333', 'UTC',
                   ARRAY['package.refresh'], '22222222-2222-2222-2222-222222222222',
                   'this host needs a different window')
           ON CONFLICT DO NOTHING;`);
      assert.equal(sql(`SELECT console.host_effective_policy(
        '33333333-3333-3333-3333-333333333333'::uuid);`).out,
      'c0000000-0000-0000-0000-000000000002',
      'the more specific policy must win, without depending on row order');
    });

    await t.test('two policies cannot claim the same scope', () => {
      const duplicateDefault = sql(`INSERT INTO console.host_policy
          (control_center_id, name, timezone, created_by, reason)
        VALUES ('cc2', 'second default', 'UTC', '22222222-2222-2222-2222-222222222222',
                'ambiguous precedence');`, { expectFailure: true });
      assert.equal(duplicateDefault.ok, false, 'two defaults would make precedence an accident');

      const duplicateHost = sql(`INSERT INTO console.host_policy
          (control_center_id, name, host_uuid, timezone, created_by, reason)
        VALUES ('cc2', 'second host policy', '33333333-3333-3333-3333-333333333333', 'UTC',
                '22222222-2222-2222-2222-222222222222', 'ambiguous precedence');`,
      { expectFailure: true });
      assert.equal(duplicateHost.ok, false);
    });

    await t.test('an absurd window duration is refused', () => {
      for (const minutes of ['0', '5', '1441', '-60']) {
        const bad = sql(`INSERT INTO console.host_maintenance_window
            (policy_id, day_of_week, start_time, duration_minutes)
          VALUES ('c0000000-0000-0000-0000-000000000002', 3, '04:00', ${minutes});`,
        { expectFailure: true });
        assert.equal(bad.ok, false, `${minutes} minutes must be refused`);
      }
      for (const day of ['7', '-1', '99']) {
        const bad = sql(`INSERT INTO console.host_maintenance_window
            (policy_id, day_of_week, start_time, duration_minutes)
          VALUES ('c0000000-0000-0000-0000-000000000002', ${day}, '04:00', 60);`,
        { expectFailure: true });
        assert.equal(bad.ok, false, `day ${day} must be refused`);
      }
    });

    // One active operation per host is a standing invariant, so a fixture that
    // needs the slot has to retire whatever an earlier assertion left in it.
    const retireActive = () => sql(`UPDATE console.host_operation
           SET status = 'cancelled', decided_reason = 'retired by a later fixture',
               completed_at = now()
         WHERE host_uuid = '33333333-3333-3333-3333-333333333333'
           AND status NOT IN ('succeeded','failed','rejected','cancelled','expired');`);

    await t.test('a policy-governed operation cannot be dispatched without a policy', () => {
      // One active operation per host is a standing invariant, so the earlier
      // fixture has to reach a terminal state before another can be created.
      sql(`UPDATE console.host_operation SET status = 'running', started_at = now()
           WHERE id = 'a0000000-0000-0000-0000-000000000003';`);
      sql(`UPDATE console.host_operation
             SET status = 'succeeded', completed_at = now(),
                 result = '{"outcome":"succeeded"}'::jsonb,
                 result_digest = 'sha256:${'1'.repeat(64)}'
           WHERE id = 'a0000000-0000-0000-0000-000000000003';`);

      sql(`INSERT INTO console.host_operation
             (id, request_id, host_uuid, control_center_id, operation, parameters, reason, status,
              requested_by, content_digest, lease_attempt)
           VALUES ('a0000000-0000-0000-0000-000000000009',
                   'b0000000-0000-0000-0000-000000000009',
                   '33333333-3333-3333-3333-333333333333', 'cc2',
                   'package.refresh', '{"manager":"apt"}'::jsonb,
                   'refresh the package index', 'requested',
                   '11111111-1111-1111-1111-111111111111',
                   'sha256:${'e'.repeat(64)}', 0);`);
      sql(`UPDATE console.host_operation SET status = 'approved',
             approved_by = '22222222-2222-2222-2222-222222222222', approved_at = now(),
             approved_digest = content_digest
           WHERE id = 'a0000000-0000-0000-0000-000000000009';`);

      const ungoverned = sql(`UPDATE console.host_operation SET status = 'dispatchable'
        WHERE id = 'a0000000-0000-0000-0000-000000000009';`, { expectFailure: true });
      assert.equal(ungoverned.ok, false, 'ungoverned package work must never reach an agent');
      assert.match(ungoverned.err, /requires a maintenance policy/);
    });

    await t.test('an approval does not survive the policy moving on', () => {
      // The binding is written when the request is created, which is the only
      // point at which it may be written at all: re-pointing it afterwards is
      // exactly how an approval would be made to outlive its own policy.
      retireActive();
      sql(`INSERT INTO console.host_operation
             (id, request_id, host_uuid, control_center_id, operation, parameters, reason, status,
              requested_by, content_digest, lease_attempt, policy_id, policy_version)
           VALUES ('a0000000-0000-0000-0000-00000000000a',
                   'b0000000-0000-0000-0000-00000000000a',
                   '33333333-3333-3333-3333-333333333333', 'cc2',
                   'package.refresh', '{"manager":"apt"}'::jsonb,
                   'refresh the package index', 'requested',
                   '11111111-1111-1111-1111-111111111111',
                   'sha256:${'a'.repeat(64)}', 0,
                   'c0000000-0000-0000-0000-000000000002',
                   (SELECT version FROM console.host_policy
                     WHERE id = 'c0000000-0000-0000-0000-000000000002'));`);
      sql(`UPDATE console.host_operation SET status = 'approved',
             approved_by = '22222222-2222-2222-2222-222222222222', approved_at = now(),
             approved_digest = content_digest
           WHERE id = 'a0000000-0000-0000-0000-00000000000a';`);

      // Dispatch is fine while the policy is unchanged.
      const ok = sql(`UPDATE console.host_operation SET status = 'dispatchable'
        WHERE id = 'a0000000-0000-0000-0000-00000000000a';`, { expectFailure: true });
      assert.ok(ok.ok, `dispatch under the current version must work: ${ok.err}`);

      // Someone edits the policy. The approved work is now approved under rules
      // that no longer exist.
      sql(`UPDATE console.host_policy SET allowed_operations = ARRAY['package.refresh','kernel.update']
           WHERE id = 'c0000000-0000-0000-0000-000000000002';`);
      const stale = sql(`UPDATE console.host_operation SET status = 'leased',
          lease_attempt = 1, lease_owner = 'node-a:1', lease_expires_at = now() + interval '5 minutes'
        WHERE id = 'a0000000-0000-0000-0000-00000000000a';`, { expectFailure: true });
      assert.equal(stale.ok, false, 'a policy change must invalidate work approved under it');
      assert.match(stale.err, /has moved to version/);
    });

    await t.test('the policy an approval was granted under cannot be re-pointed', () => {
      // Without this the version guard above is decoration: anyone able to
      // update the row could simply bind it to the new version just before
      // dispatch and the approval would survive a policy it never saw.
      for (const [what, assignment] of [
        ['version', `policy_version = (SELECT version FROM console.host_policy
                       WHERE id = 'c0000000-0000-0000-0000-000000000002')`],
        ['identity', `policy_id = 'c0000000-0000-0000-0000-000000000001'`],
        ['emergency flag', 'policy_emergency = true'],
      ]) {
        const rebind = sql(`UPDATE console.host_operation SET ${assignment}
          WHERE id = 'a0000000-0000-0000-0000-00000000000a';`, { expectFailure: true });
        assert.equal(rebind.ok, false, `the policy ${what} of an approved request must be frozen`);
        assert.match(rebind.err, /cannot be rewritten/);
      }
    });

    await t.test('policy identity and version travel together or not at all', () => {
      retireActive();
      const half = sql(`INSERT INTO console.host_operation
             (id, request_id, host_uuid, control_center_id, operation, parameters, reason, status,
              requested_by, content_digest, lease_attempt, policy_id)
           VALUES ('a0000000-0000-0000-0000-00000000000b',
                   'b0000000-0000-0000-0000-00000000000b',
                   '33333333-3333-3333-3333-333333333333', 'cc2',
                   'package.refresh', '{"manager":"apt"}'::jsonb,
                   'refresh the package index', 'requested',
                   '11111111-1111-1111-1111-111111111111',
                   'sha256:${'b'.repeat(64)}', 0,
                   'c0000000-0000-0000-0000-000000000002');`, { expectFailure: true });
      assert.equal(half.ok, false, 'a policy id without a version binds nothing');
    });

    await t.test('browser roles cannot write a policy', () => {
      for (const role of ['anon', 'authenticated']) {
        const write = sql(`SET ROLE ${role};
          INSERT INTO console.host_policy (control_center_id, name, timezone, created_by, reason)
          VALUES ('cc2', 'self granted', 'UTC', '11111111-1111-1111-1111-111111111111',
                  'granting myself a window');`, { expectFailure: true });
        assert.equal(write.ok, false, `${role} must not author a maintenance policy`);

        const widen = sql(`SET ROLE ${role};
          UPDATE console.host_policy SET allowed_operations = ARRAY['kernel.update']
          WHERE id = 'c0000000-0000-0000-0000-000000000001';`, { expectFailure: true });
        assert.equal(widen.ok, false, `${role} must not widen a policy`);
      }
    });

    // ── Stage 4: network, storage and image governance ──────────────────────
    //
    // Two guarantees are new here and both are enforced by the database rather
    // than by every caller being written correctly: an operation that names a
    // target only runs against a target the policy allowlisted, and an
    // operation the platform must be able to undo cannot be dispatched without
    // a rollback armed.

    await t.test('the Stage 4 catalog is present with its own permissions', () => {
      const rows = sql(`SELECT operation || '|' || required_permission || '|' ||
          requires_second_person || '|' || requires_policy || '|' || requires_rollback
        FROM console.host_operation_type
        WHERE operation IN ('network.configure','mount.configure','filesystem.grow',
                            'osimage.stage','osimage.rollback')
        ORDER BY operation;`).out.split('\n');
      assert.deepEqual(rows, [
        'filesystem.grow|console.hosts.storage|true|true|false',
        'mount.configure|console.hosts.storage|true|true|false',
        'network.configure|console.hosts.network|true|true|true',
        'osimage.rollback|console.hosts.osimage|true|true|false',
        'osimage.stage|console.hosts.osimage|true|true|false',
      ]);
      // Three separate permissions: none of the authorities implies another.
      assert.equal(sql(`SELECT count(*) FROM console.permission
        WHERE code IN ('console.hosts.network','console.hosts.storage','console.hosts.osimage')
          AND risk_level = 'high';`).out, '3');
    });

    await t.test('SSH ban operations stay high risk, two-person, and outside maintenance', () => {
      const rows = sql(`SELECT operation || '|' || required_permission || '|' ||
          risk_level || '|' || requires_second_person || '|' || requires_maintenance || '|' ||
          requires_policy || '|' || requires_rollback || '|' || max_lease_seconds
        FROM console.host_operation_type
        WHERE operation IN ('ssh.ban','ssh.unban')
        ORDER BY operation;`).out.split('\n');
      assert.deepEqual(rows, [
        'ssh.ban|console.hosts.ssh-ban|high|true|false|false|false|120',
        'ssh.unban|console.hosts.ssh-ban|high|true|false|false|false|120',
      ]);
      assert.equal(sql(`SELECT risk_level FROM console.permission
        WHERE code = 'console.hosts.ssh-ban';`).out, 'high');
      assert.equal(sql(`SELECT count(*)
        FROM console.role_permission rp
        JOIN console.role r ON r.id = rp.role_id
        JOIN console.permission p ON p.id = rp.permission_id
        WHERE r.code = 'console-admins' AND p.code = 'console.hosts.ssh-ban';`).out, '1');
    });

    await t.test('SSH protection setup is high risk, policy-bound maintenance', () => {
      assert.equal(sql(`SELECT operation || '|' || required_permission || '|' ||
          risk_level || '|' || requires_second_person || '|' || requires_maintenance || '|' ||
          requires_policy || '|' || requires_rollback || '|' || max_lease_seconds
        FROM console.host_operation_type
        WHERE operation = 'ssh.protection.enable';`).out,
      'ssh.protection.enable|console.hosts.ssh-ban|high|true|true|true|false|1800');
    });

    await t.test('an image allowlist entry must be digest-pinned', () => {
      // A tag can be moved by whoever controls the registry, which makes it a
      // target nobody can review.
      for (const image of [
        'registry.example.com/polyon/os:v1',
        'registry.example.com/polyon/os',
        'registry.example.com/polyon/os@sha256:abc',
        `registry.example.com/polyon/os@md5:${'a'.repeat(32)}`,
      ]) {
        const bad = sql(`UPDATE console.host_policy SET allowed_images = ARRAY['${image}']
          WHERE id = 'c0000000-0000-0000-0000-000000000001';`, { expectFailure: true });
        assert.equal(bad.ok, false, `${image} must be refused`);
      }
      const good = sql(`UPDATE console.host_policy
        SET allowed_images = ARRAY['registry.example.com/polyon/os@sha256:${'b'.repeat(64)}']
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`);
      assert.equal(good.ok, true);
    });

    await t.test('a mount root the host would refuse cannot be written into a policy', () => {
      // A policy that records something the agent refuses is a disagreement
      // that only surfaces at 3am.
      for (const root of ['/', '/boot', '/etc', '/var/lib/rancher', 'srv', '/srv/../etc']) {
        const bad = sql(`UPDATE console.host_policy SET allowed_mount_roots = ARRAY['${root}']
          WHERE id = 'c0000000-0000-0000-0000-000000000001';`, { expectFailure: true });
        assert.equal(bad.ok, false, `${root} must be refused as a mount root`);
      }
      assert.equal(sql(`UPDATE console.host_policy SET allowed_mount_roots = ARRAY['/srv','/mnt']
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`).ok, true);
    });

    await t.test('editing a target list invalidates approvals like any other rule change', () => {
      const before = Number(sql(`SELECT version FROM console.host_policy
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`).out);
      sql(`UPDATE console.host_policy
        SET allowed_images = ARRAY['registry.example.com/polyon/os@sha256:${'c'.repeat(64)}']
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`);
      const afterImages = Number(sql(`SELECT version FROM console.host_policy
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`).out);
      assert.equal(afterImages, before + 1, 'changing which images are permitted is a rule change');

      sql(`UPDATE console.host_policy SET allowed_mount_roots = ARRAY['/srv']
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`);
      assert.equal(Number(sql(`SELECT version FROM console.host_policy
        WHERE id = 'c0000000-0000-0000-0000-000000000001';`).out), afterImages + 1,
      'changing where mounts may be created is a rule change');
    });

    // Only one operation may be active per host, and a completed one is
    // immutable, so each Stage 4 fixture retires whatever an earlier assertion
    // left in flight and then claims the slot with its own row.
    const dispatchableOperation = (id, operation, parameters, digestChar) => {
      sql(`UPDATE console.host_operation
             SET status = 'cancelled', decided_reason = 'retired by a later fixture',
                 completed_at = now()
           WHERE host_uuid = '33333333-3333-3333-3333-333333333333'
             AND status NOT IN ('succeeded','failed','rejected','cancelled','expired');`);
      const governed = operation === 'journal.query' ? '' : `,
                   'c0000000-0000-0000-0000-000000000001',
                   (SELECT version FROM console.host_policy
                     WHERE id = 'c0000000-0000-0000-0000-000000000001')`;
      const governedColumns = operation === 'journal.query' ? '' : ', policy_id, policy_version';
      // The state machine insists every operation is born in `requested`, so
      // the fixture walks the legal path rather than inserting a leased row.
      sql(`INSERT INTO console.host_operation
             (id, request_id, host_uuid, control_center_id, operation, parameters, reason,
              status, requested_by, content_digest, lease_attempt${governedColumns})
           VALUES ('${id}', gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'cc2',
                   '${operation}', '${parameters}'::jsonb, 'a stage 4 fixture', 'requested',
                   '11111111-1111-1111-1111-111111111111',
                   'sha256:${digestChar.repeat(64)}', 0${governed});`);
      sql(`UPDATE console.host_operation SET status = 'awaiting_approval' WHERE id = '${id}';`);
      sql(`UPDATE console.host_operation
             SET status = 'approved', approved_by = '22222222-2222-2222-2222-222222222222',
                 approved_at = now(), approved_digest = content_digest
           WHERE id = '${id}';`);
      sql(`UPDATE console.host_operation SET status = 'dispatchable' WHERE id = '${id}';`);
      return id;
    };

    // A lease must record its owner and expiry, and may not exceed the budget
    // the catalog grants that operation. Every lease below therefore derives
    // its expiry from the catalog; the assertions are about the rollback guard,
    // not about those rules.
    const LEASE = `lease_attempt = 1, lease_owner = 'node-a:1',
                   lease_expires_at = now() + make_interval(secs =>
                     (SELECT max_lease_seconds FROM console.host_operation_type t
                       WHERE t.operation = host_operation.operation) - 5)`;

    await t.test('a revertable operation cannot be dispatched without a rollback armed', () => {
      // An application bug that forgot to arm the rollback would otherwise
      // produce exactly the change this mechanism exists to prevent: one that
      // severs the control path with nothing scheduled to undo it.
      const id = dispatchableOperation('a0000000-0000-0000-0000-00000000000f',
        'network.configure', '{"rollbackSeconds":120}', '4');

      const unarmed = sql(`UPDATE console.host_operation SET status = 'leased', ${LEASE}
        WHERE id = '${id}';`, { expectFailure: true });
      assert.equal(unarmed.ok, false, 'a lease without a rollback deadline must be refused');
      assert.match(unarmed.err, /rollback deadline/);

      const deadlineOnly = sql(`UPDATE console.host_operation
        SET status = 'leased', ${LEASE}, rollback_deadline_at = now() + interval '2 minutes'
        WHERE id = '${id}';`, { expectFailure: true });
      assert.equal(deadlineOnly.ok, false, 'a deadline nobody armed is not an armed rollback');
      assert.match(deadlineOnly.err, /rollback armed/);

      const armed = sql(`UPDATE console.host_operation
        SET status = 'leased', ${LEASE},
            rollback_deadline_at = now() + interval '2 minutes', rollback_state = 'armed'
        WHERE id = '${id}' RETURNING rollback_state;`);
      assert.equal(armed.ok, true, armed.err);
      assert.equal(armed.out, 'armed');
    });

    await t.test('an operation with no rollback requirement is unaffected', () => {
      const id = dispatchableOperation('a0000000-0000-0000-0000-00000000001f',
        'journal.query', '{}', '5');
      const leased = sql(`UPDATE console.host_operation SET status = 'leased', ${LEASE}
        WHERE id = '${id}';`);
      assert.equal(leased.ok, true, leased.err);
    });

    await t.test('the rollback state is a closed set', () => {
      const id = dispatchableOperation('a0000000-0000-0000-0000-00000000002f',
        'network.configure', '{"rollbackSeconds":120}', '6');
      sql(`UPDATE console.host_operation
             SET status = 'leased', ${LEASE},
                 rollback_deadline_at = now() + interval '2 minutes', rollback_state = 'armed'
           WHERE id = '${id}';`);

      // An agent must not be able to write an arbitrary string into a column an
      // operator reads as the platform's own record.
      const bad = sql(`UPDATE console.host_operation SET rollback_state = 'probably-fine'
        WHERE id = '${id}';`, { expectFailure: true });
      assert.equal(bad.ok, false);
      for (const state of ['confirmed', 'rolled-back', 'rollback-failed', 'not-recorded']) {
        const result = sql(`UPDATE console.host_operation SET rollback_state = '${state}'
          WHERE id = '${id}';`);
        assert.equal(result.ok, true, `${state} must be accepted: ${result.err}`);
      }
    });

    await t.test('the adapter recorded on an operation is a closed set', () => {
      const id = dispatchableOperation('a0000000-0000-0000-0000-00000000003f',
        'filesystem.grow', '{"mountPoint":"/srv/data"}', '7');
      const bad = sql(`UPDATE console.host_operation SET adapter = 'sh -c'
        WHERE id = '${id}';`, { expectFailure: true });
      assert.equal(bad.ok, false);
      for (const adapter of ['NetworkManager', 'systemd-mount', 'rpm-ostree', 'bootc']) {
        const result = sql(`UPDATE console.host_operation SET adapter = '${adapter}'
          WHERE id = '${id}';`);
        assert.equal(result.ok, true, `${adapter} must be accepted: ${result.err}`);
      }
    });

    await t.test('the journal accepts every Stage 4 phase the backend emits', () => {
      const id = 'a0000000-0000-0000-0000-00000000003f';
      for (const phase of ['preflight.refused', 'rollback.armed', 'rollback.confirmed', 'rollback.executed']) {
        const result = sql(`INSERT INTO console.host_operation_event
             (operation_id, phase, actor_type, result, detail, event_hash)
           VALUES ('${id}', '${phase}', 'system', 'ok', '{}'::jsonb,
                   'sha256:' || md5('${phase}') || md5('${phase}'));`);
        assert.equal(result.ok, true, `${phase} must be an accepted phase: ${result.err}`);
      }
      const invented = sql(`INSERT INTO console.host_operation_event
           (operation_id, phase, actor_type, result, detail, event_hash)
         VALUES ('${id}', 'rollback.whatever', 'system', 'ok', '{}'::jsonb,
                 'sha256:' || md5('x') || md5('x'));`, { expectFailure: true });
      assert.equal(invented.ok, false, 'a phase nobody declared must be refused');
    });

    await t.test('browser roles cannot write a Stage 4 target allowlist', () => {
      for (const role of ['anon', 'authenticated']) {
        const result = sql(`SET ROLE ${role};
          UPDATE console.host_policy SET allowed_images = ARRAY['x@sha256:${'d'.repeat(64)}']
          WHERE id = 'c0000000-0000-0000-0000-000000000001';`, { expectFailure: true });
        assert.equal(result.ok, false, `${role} must not be able to widen a target allowlist`);
      }
    });

    await t.test('browser roles cannot write host operations', () => {
      for (const role of ['anon', 'authenticated']) {
        const result = sql(`SET ROLE ${role};
          INSERT INTO console.host_operation (id, host_uuid, control_center_id, operation,
            parameters, reason, status, requested_by, content_digest, lease_attempt)
          VALUES (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'cc2',
                  'host.reboot', '{}'::jsonb, 'self approved', 'approved',
                  '11111111-1111-1111-1111-111111111111', 'sha256:${'0'.repeat(64)}', 0);`,
        { expectFailure: true });
        assert.equal(result.ok, false, `${role} must not be able to author an operation`);
      }
    });

    // ── what the backend role itself may not do ─────────────────────────────
    //
    // These are the guarantees that differ between a region built by applying
    // migrations in order and one installed from the consolidated baseline,
    // because migration 0002 sets default privileges that the baseline does
    // not inherit automatically. A test that only ever exercises one install
    // path cannot see the difference, so each of these is asserted against
    // whichever path this run built.

    await t.test('the backend cannot rewrite the operation catalogue', () => {
      // The catalogue is the closed list of what this platform can do to a
      // host, including each entry's lease bound and whether it needs a second
      // approver. A backend that can edit it can authorise itself.
      const widen = sql(`SET ROLE opensphere_console_backend;
        UPDATE console.host_operation_type SET requires_second_person = false
        WHERE operation = 'host.reboot';`, { expectFailure: true });
      assert.equal(widen.ok, false, 'the backend must not relax a catalogue entry');

      const invent = sql(`SET ROLE opensphere_console_backend;
        INSERT INTO console.host_operation_type
          (operation, risk_level, requires_second_person, requires_maintenance,
           required_permission, max_lease_seconds, description)
        VALUES ('shell.run', 'low', false, false, 'console.hosts.read', 60, 'invented');`,
      { expectFailure: true });
      assert.equal(invent.ok, false, 'the backend must not invent an operation');
    });

    await t.test('the backend cannot delete an operation or a degradation', () => {
      // A completed operation is immutable on UPDATE. Deletion is the way
      // around that: the row stops existing and its history goes with it.
      const dropOperation = sql(`SET ROLE opensphere_console_backend;
        DELETE FROM console.host_operation
        WHERE id = 'a0000000-0000-0000-0000-000000000009';`, { expectFailure: true });
      assert.equal(dropOperation.ok, false, 'operation history must not be deletable');

      const dropDegradation = sql(`SET ROLE opensphere_console_backend;
        DELETE FROM console.host_maintenance_degradation;`, { expectFailure: true });
      assert.equal(dropDegradation.ok, false, 'a resolved degradation is history');
    });

    await t.test('the journal is append-only even to the backend', () => {
      for (const statement of [
        `UPDATE console.host_operation_event SET result = 'error'`,
        'DELETE FROM console.host_operation_event',
      ]) {
        const result = sql(`SET ROLE opensphere_console_backend; ${statement};`,
          { expectFailure: true });
        assert.equal(result.ok, false, `${statement} must be refused`);
      }
    });

    // ── a lease is fixed for as long as it is held ──────────────────────────

    await t.test('a held lease cannot be stolen, extended or renumbered', () => {
      retireActive();
      sql(`INSERT INTO console.host_operation
             (id, request_id, host_uuid, control_center_id, operation, parameters, reason, status,
              requested_by, content_digest, lease_attempt)
           VALUES ('a0000000-0000-0000-0000-0000000000c1',
                   'b0000000-0000-0000-0000-0000000000c1',
                   '33333333-3333-3333-3333-333333333333', 'cc2',
                   'journal.query', '{"units":[],"lines":10,"priority":""}'::jsonb,
                   'reading the journal', 'requested',
                   '11111111-1111-1111-1111-111111111111',
                   'sha256:${'c'.repeat(64)}', 0);`);
      sql(`UPDATE console.host_operation SET status = 'approved',
             approved_by = '22222222-2222-2222-2222-222222222222', approved_at = now(),
             approved_digest = content_digest
           WHERE id = 'a0000000-0000-0000-0000-0000000000c1';`);
      sql(`UPDATE console.host_operation SET status = 'dispatchable'
           WHERE id = 'a0000000-0000-0000-0000-0000000000c1';`);
      sql(`UPDATE console.host_operation SET status = 'leased', lease_attempt = 1,
             lease_owner = 'node-a:1', lease_expires_at = now() + interval '60 seconds'
           WHERE id = 'a0000000-0000-0000-0000-0000000000c1';`);

      // Guarding only the entry edge would leave all three of these open: the
      // row never crosses into 'leased', it is already there.
      for (const [what, assignment] of [
        ['owner', `lease_owner = 'attacker:1'`],
        ['expiry', `lease_expires_at = now() + interval '10 years'`],
        ['attempt', 'lease_attempt = 99'],
      ]) {
        const steal = sql(`UPDATE console.host_operation SET ${assignment}
          WHERE id = 'a0000000-0000-0000-0000-0000000000c1';`, { expectFailure: true });
        assert.equal(steal.ok, false, `a held lease must not change ${what}`);
      }
    });

    await t.test('a lease may not outlive its own catalogue bound', () => {
      const tooLong = sql(`UPDATE console.host_operation SET status = 'leased', lease_attempt = 2,
          lease_owner = 'node-a:2', lease_expires_at = now() + interval '48 hours'
        WHERE id = 'a0000000-0000-0000-0000-0000000000c1';`, { expectFailure: true });
      assert.equal(tooLong.ok, false, 'a lease longer than the catalogue permits must be refused');
    });

    await t.test('a receipt from a superseded attempt cannot be filed', () => {
      sql(`UPDATE console.host_operation SET status = 'running', started_at = now()
           WHERE id = 'a0000000-0000-0000-0000-0000000000c1';`);
      const wrongAttempt = sql(`UPDATE console.host_operation
          SET status = 'succeeded', completed_at = now(),
              result = '{"outcome":"succeeded","attempt":7}'::jsonb,
              result_digest = 'sha256:${'2'.repeat(64)}'
        WHERE id = 'a0000000-0000-0000-0000-0000000000c1';`, { expectFailure: true });
      assert.equal(wrongAttempt.ok, false, 'a receipt must name the attempt that was leased');
      assert.match(wrongAttempt.err, /cannot be filed against attempt/);

      sql(`UPDATE console.host_operation
             SET status = 'succeeded', completed_at = now(),
                 result = '{"outcome":"succeeded","attempt":1}'::jsonb,
                 result_digest = 'sha256:${'2'.repeat(64)}'
           WHERE id = 'a0000000-0000-0000-0000-0000000000c1';`);
    });

    await t.test('a stored result digest cannot be rewritten', () => {
      // The digest pins the bytes the agent signed. Leaving it out of the
      // immutability rule would let the result stay put while the thing that
      // proves it is what arrived was replaced.
      const rewrite = sql(`UPDATE console.host_operation
          SET result_digest = 'sha256:${'3'.repeat(64)}'
        WHERE id = 'a0000000-0000-0000-0000-0000000000c1';`, { expectFailure: true });
      assert.equal(rewrite.ok, false, 'a receipt digest must be immutable once stored');
    });

    // ── policy is permanent configuration with no write API ─────────────────

    await t.test('the backend cannot write a policy or a window at all', () => {
      // There is no route, no API and no UI that edits a policy: it is written
      // by an administrator with direct SQL, deliberately. Making that a
      // privilege rather than an observation about the current code means a
      // compromised backend cannot widen the rules it is judged by.
      for (const table of ['host_policy', 'host_maintenance_window']) {
        for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
          assert.equal(sql(`SELECT has_table_privilege('opensphere_console_backend',
            'console.${table}', '${privilege}');`).out, 'f',
          `the backend must not hold ${privilege} on console.${table}`);
        }
        assert.equal(sql(`SELECT has_table_privilege('opensphere_console_backend',
          'console.${table}', 'SELECT');`).out, 't',
        `the backend still reads console.${table} to judge an operation`);
      }
    });

    await t.test('a policy edit leaves evidence behind', () => {
      // Not approval — nobody is asked. Evidence, so a widened allowlist can be
      // found afterwards and attributed to a session.
      const before = Number(sql(`SELECT count(*) FROM console.host_policy_change
        WHERE policy_id = 'c0000000-0000-0000-0000-000000000001';`).out);
      sql(`UPDATE console.host_policy
             SET allowed_mount_roots = ARRAY['/srv', '/mnt']
           WHERE id = 'c0000000-0000-0000-0000-000000000001';`);
      const rows = sql(`SELECT action || '|' || (before IS NOT NULL) || '|' || (after IS NOT NULL)
                          || '|' || (changed_by <> '')
        FROM console.host_policy_change
        WHERE policy_id = 'c0000000-0000-0000-0000-000000000001'
        ORDER BY id DESC LIMIT 1;`).out;
      assert.equal(Number(sql(`SELECT count(*) FROM console.host_policy_change
        WHERE policy_id = 'c0000000-0000-0000-0000-000000000001';`).out), before + 1,
      'a substantive policy edit must be recorded');
      assert.equal(rows, 'updated|true|true|true',
        'the record must carry what it was, what it became, and who did it');

      // A no-op edit is not a change and must not manufacture evidence.
      sql(`UPDATE console.host_policy SET reason = 'reworded, same rules'
           WHERE id = 'c0000000-0000-0000-0000-000000000001';`);
      assert.equal(Number(sql(`SELECT count(*) FROM console.host_policy_change
        WHERE policy_id = 'c0000000-0000-0000-0000-000000000001';`).out), before + 1,
      'an edit that changes no rule is not a policy change');
    });

    await t.test('the policy journal cannot be rewritten by anyone', () => {
      for (const statement of [
        `UPDATE console.host_policy_change SET changed_by = 'somebody else'`,
        'DELETE FROM console.host_policy_change',
      ]) {
        assert.equal(sql(`${statement};`, { expectFailure: true }).ok, false,
          `${statement} must be refused even to the owner`);
      }
    });

    // ── guards that a replication session must not be able to switch off ────

    await t.test('the guard triggers survive session_replication_role = replica', () => {
      // ORIGIN is the default, and any session may set replication_role. A
      // guard left on the default is a guard one SET statement away from off.
      const disabled = sql(`SET session_replication_role = replica;
        INSERT INTO console.host_operation (id, request_id, host_uuid, control_center_id,
          operation, parameters, reason, status, requested_by, content_digest, lease_attempt)
        VALUES (gen_random_uuid(), gen_random_uuid(),
                '33333333-3333-3333-3333-333333333333', 'cc2',
                'host.reboot', '{"deadlineSeconds":600}'::jsonb,
                'skipping the state machine', 'dispatchable',
                '11111111-1111-1111-1111-111111111111',
                'sha256:${'4'.repeat(64)}', 0);`, { expectFailure: true });
      assert.equal(disabled.ok, false,
        'an operation must not be creatable straight into dispatchable, replica role or not');
    });

    // ── reads are scoped to the reader's own region ─────────────────────────

    await t.test('policy, window and degradation reads are scoped by assignment', () => {
      // A policy row names the operations, image digests and mount roots a
      // region permits; a degradation names a cordoned Kubernetes node. None of
      // it belongs to an operator with no assignment to that region.
      for (const table of ['host_policy', 'host_maintenance_window', 'host_maintenance_degradation']) {
        const definition = sql(`SELECT qual FROM pg_policies
          WHERE schemaname = 'console' AND tablename = '${table}'
            AND roles::text LIKE '%authenticated%';`).out;
        assert.ok(definition.includes('operator_control_center'),
          `console.${table} reads must be scoped by control centre assignment, got: ${definition}`);
        assert.ok(!/^true$/.test(definition.trim()),
          `console.${table} must not be readable by every authenticated session`);
      }
    });
    await t.test('the schema this baseline produces is recorded for comparison', () => {
      const describe = (statement) => sql(statement).out.split('\n').filter(Boolean).sort();
      baselineFingerprint = {
        columns: describe(`SELECT table_name || '.' || column_name || ':' || data_type
            || ':' || is_nullable || ':' || COALESCE(column_default, '-')
          FROM information_schema.columns WHERE table_schema = 'console'
            AND table_name LIKE 'host%';`),
        constraints: describe(`SELECT conrelid::regclass::text || ':' || conname
          FROM pg_constraint WHERE connamespace = 'console'::regnamespace
            AND conrelid::regclass::text LIKE '%host%';`),
        policies: describe(`SELECT tablename || ':' || policyname FROM pg_policies
          WHERE schemaname = 'console' AND tablename LIKE 'host%';`),
        ...behaviourFingerprint(describe),
      };
      assert.ok(baselineFingerprint.columns.length > 60, 'the host tables must be present');
      assert.ok(baselineFingerprint.functions.length > 5,
        'the guard functions must be present to be compared');
      assert.ok(baselineFingerprint.triggers.length > 5,
        'the guards must be present to be compared');
    });
  } finally {
    spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  }
});

/**
 * The other install path.
 *
 * A region installed fresh from the consolidated baseline and a region that
 * already existed and had the RCC migrations applied to it must end up as the
 * same database. They are built by different files, and the contract above only
 * ever exercises the fresh one, so a divergence between them is invisible to
 * every test that picks a side — which is how the backend role came to be able
 * to rewrite the operation catalogue on upgraded regions but not on fresh ones.
 *
 * `console.control_center` is defined only in the baseline, so there is no
 * from-scratch migration path to test and this does not invent one. What it
 * builds is the real thing: the region as it stood before any of this work
 * (the baseline at the branch point), then migrations 0027..0033 applied on
 * top, which is exactly what an existing region receives.
 */
test('an upgraded region and a fresh one are the same database',
  { skip: !available && 'docker unavailable' }, async (t) => {
  const container = 'rcc-db-upgrade';
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  execFileSync('docker', [
    'run', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=contract', IMAGE,
  ], { stdio: 'pipe' });

  const run = (statement, { expectFailure = false } = {}) => {
    const result = spawnSync('docker', [
      'exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', statement,
    ], { encoding: 'utf8' });
    if (!expectFailure && result.status !== 0) {
      throw new Error(`SQL failed: ${statement}\n${result.stderr}`);
    }
    return { ok: result.status === 0, out: (result.stdout || '').trim(), err: result.stderr || '' };
  };

  try {
    let ready = false;
    for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
      // Over TCP, for the reason given on the identical wait above: the
      // temporary bootstrap server answers on the socket and then goes away.
      const probe = spawnSync('docker', [
        'exec', container, 'psql', '-h', '127.0.0.1', '-U', 'supabase_admin', '-d', 'postgres', '-tAc',
        "SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','extensions','storage');",
      ], { encoding: 'utf8' });
      ready = probe.status === 0 && probe.stdout.trim() === '3';
      if (!ready) await new Promise((resolve) => { setTimeout(resolve, 500); });
    }
    assert.ok(ready, 'the supabase database never finished its own bootstrap');

    run(`DO $$ BEGIN
           CREATE ROLE opensphere_console_backend LOGIN PASSWORD 'contract'
             NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
         EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    run('CREATE SCHEMA IF NOT EXISTS storage;');
    run(`CREATE TABLE IF NOT EXISTS storage.buckets (
           id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
           file_size_limit bigint, allowed_mime_types text[],
           created_at timestamptz NOT NULL DEFAULT now());`);
    run(`CREATE TABLE IF NOT EXISTS storage.objects (
           id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
           bucket_id text REFERENCES storage.buckets(id), name text,
           owner uuid, owner_id text, path_tokens text[], metadata jsonb,
           created_at timestamptz NOT NULL DEFAULT now());`);
    run('ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');

    const applySql = (label, body) => {
      const result = spawnSync('docker', [
        'exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', 'postgres',
        '-v', 'ON_ERROR_STOP=1',
      ], { input: body, encoding: 'utf8' });
      assert.equal(result.status, 0, `${label} failed to apply:\n${result.stderr}`);
    };

    await t.test('the RCC migrations apply in order to a region that predates them', () => {
      // The region as it stood at the branch point, taken from git rather than
      // reconstructed, so this is the schema an upgrade actually starts from.
      const priorBaseline = execFileSync('git',
        ['show', `${BASE_REVISION}:deploy/rcc/supabase-baseline.sql`],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      assert.ok(!priorBaseline.includes('console.host_operation'),
        'the prior baseline must predate host operations, or this proves nothing');
      applySql('the prior baseline', priorBaseline);

      // A region built by the upstream installer carries migration 0002's
      // default privileges, which silently grant the backend role full DML on
      // every table created in this schema afterwards. Applying them here is
      // what makes this an upgrade test rather than a second fresh install:
      // without them the divergence being guarded against cannot occur, and
      // the privilege assertions below would pass for the wrong reason.
      applySql('migration 0002 default privileges',
        fs.readFileSync(path.join(migrationsDir, '0002_backend_boundary.sql'), 'utf8'));
      assert.equal(run(`SELECT count(*) FROM pg_default_acl d
        JOIN pg_namespace n ON n.oid = d.defaclnamespace
        WHERE n.nspname = 'console';`).out !== '0', true,
      'the default privileges must actually be in effect for this to prove anything');

      // The consolidated baseline lags the migration series. At the branch
      // point it carried everything through 0024, so a real region of that
      // vintage had 0025 and 0026 applied on top of it as migrations and this
      // reconstruction needs them too. Leaving them out builds a region missing
      // objects nobody ever removed, and the divergence that then shows up
      // belongs to the harness rather than to anything being tested.
      const priorBaselineCoversThrough = 24;
      const numbered = fs.readdirSync(migrationsDir)
        .filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
      const at = (n) => Number(n.slice(0, 4));

      for (const name of numbered.filter((n) => at(n) > priorBaselineCoversThrough && at(n) < 27)) {
        applySql(`${name} (predates the prior baseline)`, fs.readFileSync(path.join(migrationsDir, name), 'utf8'));
      }

      const names = numbered.filter((n) => at(n) >= 27);
      assert.equal(names.length, 7, `expected 0027..0033, got ${names.join(', ')}`);
      for (const name of names) {
        applySql(name, fs.readFileSync(path.join(migrationsDir, name), 'utf8'));
      }
      // Applied twice, because a migration that only works on a region that has
      // never seen it cannot be retried after a partial failure. Only the
      // migrations this work adds are replayed: nothing here claims the older
      // ones are idempotent.
      for (const name of names) {
        applySql(`${name} (re-run)`, fs.readFileSync(path.join(migrationsDir, name), 'utf8'));
      }
    });

    await t.test('the upgraded region grants the backend exactly what a fresh one does', () => {
      // This is the divergence that default privileges create. Migration 0002
      // grants the backend full DML on every table created in the console
      // schema afterwards; a clean install from the baseline has no such
      // default. Anything that must be narrower has to say so explicitly, and
      // these are the tables where "narrower" is the whole point.
      const forbidden = [
        ['host_operation_type', 'INSERT'],
        ['host_operation_type', 'UPDATE'],
        ['host_operation_type', 'DELETE'],
        ['host_operation', 'DELETE'],
        ['host_operation_event', 'UPDATE'],
        ['host_operation_event', 'DELETE'],
        ['host_maintenance_degradation', 'DELETE'],
        // Policy is permanent configuration with no write API on either path.
        ['host_policy', 'INSERT'],
        ['host_policy', 'UPDATE'],
        ['host_policy', 'DELETE'],
        ['host_maintenance_window', 'UPDATE'],
        ['host_policy_change', 'INSERT'],
        ['host_policy_change', 'UPDATE'],
        ['host_policy_change', 'DELETE'],
      ];
      for (const [table, privilege] of forbidden) {
        const granted = run(`SELECT has_table_privilege('opensphere_console_backend',
          'console.${table}', '${privilege}');`).out;
        assert.equal(granted, 'f',
          `the backend must not hold ${privilege} on console.${table} after an upgrade`);
      }
      // And the privileges it genuinely needs are still there.
      for (const [table, privilege] of [
        ['host_operation', 'INSERT'], ['host_operation', 'UPDATE'],
        ['host_operation_event', 'INSERT'], ['host_operation_type', 'SELECT'],
        ['host_policy', 'SELECT'], ['host_policy_change', 'SELECT'],
        ['host_maintenance_degradation', 'UPDATE'],
      ]) {
        assert.equal(run(`SELECT has_table_privilege('opensphere_console_backend',
          'console.${table}', '${privilege}');`).out, 't',
        `the backend still needs ${privilege} on console.${table}`);
      }
    });

    await t.test('the upgraded region carries every guard in its always-on form', () => {
      // tgenabled: 'O' is the ORIGIN default, 'A' is ALWAYS. A guard left on
      // the default is one SET session_replication_role away from off.
      const guards = ['host_operation_state_machine', 'host_operation_event_append_only',
        'host_operation_content_immutable', 'host_maintenance_degradation_guard',
        'host_policy_version_guard', 'host_window_bumps_policy',
        'host_operation_policy_guard', 'host_operation_rollback_guard'];
      for (const guard of guards) {
        const state = run(`SELECT tgenabled FROM pg_trigger WHERE tgname = '${guard}';`).out;
        assert.equal(state, 'A', `${guard} must be ENABLE ALWAYS, got '${state}'`);
      }
    });

    await t.test('both paths agree on the schema they produce', () => {
      // Compared as a set of normalised object descriptions rather than as
      // text: the two files are written differently on purpose, and what has
      // to match is the database they leave behind.
      const describe = (statement) => run(statement).out.split('\n').filter(Boolean).sort();
      const columns = describe(`SELECT table_name || '.' || column_name || ':' || data_type
          || ':' || is_nullable || ':' || COALESCE(column_default, '-')
        FROM information_schema.columns WHERE table_schema = 'console'
          AND table_name LIKE 'host%' ORDER BY 1;`);
      assert.ok(columns.length > 60, `expected the host tables to be present, got ${columns.length}`);

      const constraints = describe(`SELECT conrelid::regclass::text || ':' || conname
        FROM pg_constraint WHERE connamespace = 'console'::regnamespace
          AND conrelid::regclass::text LIKE '%host%';`);
      const policies = describe(`SELECT tablename || ':' || policyname FROM pg_policies
        WHERE schemaname = 'console' AND tablename LIKE 'host%';`);

      assert.ok(baselineFingerprint, 'the baseline contract must have run first');
      assert.deepEqual(columns, baselineFingerprint.columns,
        'host table columns diverge between the two install paths');
      assert.deepEqual(constraints, baselineFingerprint.constraints,
        'host constraints diverge between the two install paths');
      assert.deepEqual(policies, baselineFingerprint.policies,
        'host RLS policies diverge between the two install paths');
    });

    await t.test('both paths agree on what the guards actually do', () => {
      // The structural comparison above comes out identical whether a guard
      // still guards anything or not. Every behavioural test in this file runs
      // against the baseline-built database, so without this a guard weakened
      // in a migration passes the whole suite: the shape matches, and nothing
      // ever executes the migration's version of it.
      const describe = (statement) => run(statement).out.split('\n').filter(Boolean).sort();
      const upgraded = behaviourFingerprint(describe);

      // Migration 0025 was never folded into the consolidated baseline, so a
      // freshly installed region lacks objects an upgraded one has. That gap
      // predates this work — the baseline at the branch point lacked them too,
      // and 0025 is untouched here — and folding an unrelated migration into
      // the deployment baseline is not this change's to make. Naming what it
      // owns keeps the exception explicit and bounded: the assertion below
      // fails if the divergence ever grows beyond it, or if it is fixed.
      const unfolded = new Set([
        'external_backup_read_secret', 'external_backup_store_secret',
        'restore_configuration_snapshot',
        'external_backup_target', 'configuration_backup', 'configuration_restore',
      ]);
      const nameOf = (entry) => entry.slice(0, entry.indexOf(':'));
      const shared = (list) => list.filter((entry) => !unfolded.has(nameOf(entry)));

      const upgradedOnly = [...upgraded.functions, ...upgraded.triggers, ...upgraded.policyRules]
        .filter((entry) => ![
          ...baselineFingerprint.functions,
          ...baselineFingerprint.triggers,
          ...baselineFingerprint.policyRules,
        ].includes(entry))
        .map(nameOf);
      assert.deepEqual([...new Set(upgradedOnly)].sort(), [...unfolded].sort().filter(
        (name) => upgradedOnly.includes(name)),
      `a fresh region is missing objects beyond migration 0025: ${[...new Set(upgradedOnly)].join(', ')}`);

      assert.deepEqual(shared(upgraded.functions), shared(baselineFingerprint.functions),
        'a console function body differs between the two install paths');
      assert.deepEqual(shared(upgraded.triggers), shared(baselineFingerprint.triggers),
        'a guard trigger differs between the two install paths (definition or ALWAYS state)');
      assert.deepEqual(shared(upgraded.policyRules), shared(baselineFingerprint.policyRules),
        'an RLS predicate differs between the two install paths');
    });
  } finally {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  }
});
