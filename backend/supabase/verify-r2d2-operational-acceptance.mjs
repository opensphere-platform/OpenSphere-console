#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'opensphere-console-oaa-gateway', 'package.json'));
const { Pool } = require('pg');
const migrationsDir = path.join(here, 'migrations');
const container = 'os-r2d2-operational-acceptance';
const image = 'pgvector/pgvector:pg16';
const port = 55433;
const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
const digestA = `sha256:${'a'.repeat(64)}`;

const prep = `
DO $roles$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'anon','authenticated','service_role','supabase_admin','authenticator',
    'opensphere_ai_pipeline','opensphere_ai_runtime','opensphere_console_backend',
    'opensphere_external_channel_executor','opensphere_notification_dispatcher','opensphere_oaa_gateway'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
  END LOOP;
END $roles$;
ALTER ROLE supabase_admin WITH LOGIN SUPERUSER;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(), email text,
  raw_app_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $fn$;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[], owner uuid,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, owner_id text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(), path_tokens text[], version text, metadata jsonb);
`;

const sh = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', ...options });
const psql = (sql, database = 'postgres') => sh('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', database,
  '-v', 'ON_ERROR_STOP=1', '-t', '-A'], { input: sql });
const applyMigrations = (database, selected) => selected.forEach((name) => psql(readFileSync(path.join(migrationsDir, name), 'utf8'), database));
const migrationDigest = (name) => createHash('sha256')
  .update(readFileSync(path.join(migrationsDir, name), 'utf8').replace(/\r\n/gu, '\n'), 'utf8')
  .digest('hex');
const attestMigrations = (database, selected) => psql(selected.map((name) => {
  const id = name.slice(0, -4);
  return `INSERT INTO console.schema_migration(migration_id,sha256,source_revision,executor)
    VALUES('${id}','${migrationDigest(name)}','${'1'.repeat(40)}','acceptance') ON CONFLICT(migration_id) DO NOTHING;`;
}).join('\n'), database);
const schemaDump = (database) => sh('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', database,
  '--schema-only', '--no-owner', '--no-privileges']).replace(/^\\(?:restrict|unrestrict)\s+.*$/gmu, '');
const connection = (database = 'postgres') => new Pool({ host: '127.0.0.1', port, user: 'postgres', password: 'verify', database, max: 4 });
const percentile = (values, ratio) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * ratio) - 1)];

async function samples(pool, query, count = 30) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await pool.query(query);
    values.push(performance.now() - started);
  }
  return values;
}

async function main() {
  try { sh('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch { /* absent */ }
  sh('docker', ['run', '-d', '--name', container, '-p', `127.0.0.1:${port}:5432`,
    '-e', 'POSTGRES_PASSWORD=verify', '-e', 'POSTGRES_DB=postgres', image], { stdio: 'ignore' });
  let pool;
  try {
    let consecutiveReady = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        sh('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', 'SELECT 1'], { stdio: 'ignore' });
        consecutiveReady += 1;
        if (consecutiveReady >= 3) break;
      } catch { consecutiveReady = 0; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (consecutiveReady < 3) throw new Error('PostgreSQL acceptance container did not become stably ready');
    psql(prep);
    applyMigrations('postgres', migrations);
    pool = connection();

    const retentionStart = '2020-01-01T00:00:00Z';
    const retentionEnd = '2020-02-01T00:00:00Z';
    await assert.rejects(() => pool.query(`SELECT oaa.assert_evidence_purge_allowed(
      'observation',$1::timestamptz,$2::timestamptz,'40000000-0000-4000-8000-000000000001')`,
    [retentionStart, retentionEnd]), /verified export and restore proof required/);
    const exportProof = await pool.query(`INSERT INTO oaa.evidence_partition_export(
      stream,range_start,range_end,row_count,object_ref,object_digest,verified_at,verified_by,restored_at
    ) VALUES('observation',$1,$2,0,'s3://r2d2-acceptance/observation-202001', $3,clock_timestamp(),'acceptance',clock_timestamp())
    RETURNING export_id`, [retentionStart, retentionEnd, digestA]);
    await pool.query(`INSERT INTO oaa.evidence_legal_hold(stream,range_start,range_end,reason,created_by)
      VALUES('observation',$1,$2,'acceptance legal hold','acceptance')`, [retentionStart, retentionEnd]);
    await assert.rejects(() => pool.query(`SELECT oaa.assert_evidence_purge_allowed(
      'observation',$1::timestamptz,$2::timestamptz,$3::uuid)`,
    [retentionStart, retentionEnd, exportProof.rows[0].export_id]), /active legal hold blocks purge/);
    await pool.query(`UPDATE oaa.evidence_legal_hold SET active=false,released_by='acceptance',released_at=clock_timestamp()
      WHERE stream='observation' AND range_start=$1`, [retentionStart]);
    assert.equal((await pool.query(`SELECT oaa.assert_evidence_purge_allowed(
      'observation',$1::timestamptz,$2::timestamptz,$3::uuid) AS allowed`,
    [retentionStart, retentionEnd, exportProof.rows[0].export_id])).rows[0].allowed, true);

    await pool.query(`INSERT INTO oaa.observer_fence(cluster_id,fencing_epoch,collector_id,lease_identity,lease_expires_at)
      VALUES('acceptance',1,'observer-v1','lease:1',clock_timestamp()+interval '1 hour');
      INSERT INTO oaa.reconcile_session(reconcile_session_id,cluster_id,source,collector_id,fencing_epoch,collection_epoch,
        expected_scope_count,completed_scope_count,snapshot_complete,started_at,completed_at)
      VALUES('10000000-0000-4000-8000-000000000001','acceptance','kubernetes','observer-v1',1,1,1,1,true,clock_timestamp(),clock_timestamp());
      INSERT INTO oaa.source_health(cluster_id,source,epistemic_state,configured,snapshot_complete,last_complete_at,last_received_at,lag_seconds)
      VALUES('acceptance','kubernetes','known',true,true,clock_timestamp(),clock_timestamp(),0);
      INSERT INTO oaa.resource_node(cluster_id,node_id,node_type,canonical_id,authority,authority_uid,display_name,namespace,
        health,epistemic_state,attributes,fencing_epoch,collection_epoch,stream_sequence,source_revision,reconcile_session_id,
        snapshot_complete,observed_at,expires_at)
      SELECT 'acceptance','node:'||g,'Deployment','component:'||g,'kubernetes','uid-'||g,'workload-'||g,
        'opensphere-'||(g%20),'Ready','known',jsonb_build_object('replicas',1),1,1,g,g::text,
        '10000000-0000-4000-8000-000000000001',true,clock_timestamp(),clock_timestamp()+interval '5 minutes'
      FROM generate_series(1,10000) g;
      INSERT INTO oaa.resource_relation(cluster_id,from_node_id,relation_type,to_node_id,authority,confidence,evidence_ref,
        fencing_epoch,collection_epoch,source_revision,reconcile_session_id,observed_at,expires_at)
      SELECT 'acceptance','node:'||g,'depends_on','node:'||(g+1),'kubernetes','confirmed','acceptance:'||g,
        1,1,g::text,'10000000-0000-4000-8000-000000000001',clock_timestamp(),clock_timestamp()+interval '5 minutes'
      FROM generate_series(1,9999) g;`);

    const graphTimes = await samples(pool, `SELECT node_id,node_type,display_name,namespace,health,epistemic_state
      FROM oaa.resource_node WHERE cluster_id='acceptance' AND deleted_at IS NULL
      ORDER BY namespace,node_type,display_name LIMIT 250`);
    const graphP95 = percentile(graphTimes, 0.95);
    assert.ok(graphP95 <= 500, `10,000-node graph query p95 ${graphP95.toFixed(2)}ms exceeds 500ms`);

    await pool.query(`INSERT INTO oaa.incident(incident_id,cluster_id,fingerprint,incident_type,status,severity,confidence,
      cause_status,title,first_detected_at,last_observed_at,primary_node_id,rule_revision,summary,fencing_epoch)
      SELECT extensions.gen_random_uuid(),'acceptance','sha256:'||lpad(to_hex(g),64,'0'),'storm','active',
        CASE WHEN g%10=0 THEN 'high' ELSE 'warning' END,0.9,'confirmed','incident-'||g,
        clock_timestamp(),clock_timestamp(),'node:'||((g%10000)+1),'acceptance-v1','storm acceptance',1
      FROM generate_series(1,10000) g;
      INSERT INTO oaa.incident_outbox(incident_id,transition_sequence,event_type,idempotency_key,payload)
      SELECT incident_id,1,'incident_activated','acceptance:'||incident_id,jsonb_build_object('incidentId',incident_id)
      FROM oaa.incident WHERE cluster_id='acceptance';`);
    const incidentTimes = await samples(pool, `SELECT incident_id,severity,status,updated_at FROM oaa.incident
      WHERE cluster_id='acceptance' AND status IN('detected','active','recovering')
      ORDER BY updated_at DESC LIMIT 100`);
    const incidentP95 = percentile(incidentTimes, 0.95);
    assert.ok(incidentP95 <= 300, `active incident query p95 ${incidentP95.toFixed(2)}ms exceeds 300ms`);

    // Real rows distributed across 30 calendar days exercise both monthly partitions,
    // indexes, retention age predicates, and representative JSON evidence width.
    await pool.query(`INSERT INTO oaa.observation(cluster_id,source,source_event_id,subject_node_id,observation_type,severity,
      fact,payload_digest,evidence_ref,collector_id,fencing_epoch,collection_epoch,stream_sequence,source_revision,
      reconcile_session_id,snapshot_complete,observed_at,received_at)
      SELECT 'acceptance','kubernetes','history-'||g,'node:'||((g%10000)+1),'authority-snapshot','info',
        jsonb_build_object('padding',repeat('x',400),'day',g%30),'${digestA}','history:'||g,'observer-v1',1,1,g,g::text,
        '10000000-0000-4000-8000-000000000001',true,
        clock_timestamp()-(g%30)*interval '1 day',clock_timestamp()-(g%30)*interval '1 day'
      FROM generate_series(1,300000) g;`);
    const history = await pool.query(`SELECT count(*)::int AS rows,count(DISTINCT received_at::date)::int AS days,
      (SELECT coalesce(sum(pg_total_relation_size(inhrelid)),0)::bigint
         FROM pg_inherits WHERE inhparent='oaa.observation'::regclass) AS bytes
      FROM oaa.observation WHERE cluster_id='acceptance'`);
    assert.equal(history.rows[0].rows, 300000);
    assert.equal(history.rows[0].days, 30);

    await pool.query(`INSERT INTO console.module_operation(idempotency_key,module_id,action,actor_id,reason,assurance,risk_class,
      target_fingerprint,phase,requested_risk_class,required_assurance,deadline_at,execution_state,verification_state)
      VALUES('acceptance-operation','r2d2','restart-workload','20000000-0000-4000-8000-000000000001',
      'acceptance durable operation','aal1','R1','${digestA}','Succeeded','R1','aal1',clock_timestamp()+interval '1 hour','complete','succeeded');`);

    const authorityQuery = `SELECT count(*)::int FROM console.module_operation WHERE phase IN('Queued','Running','Verifying')`;
    const loadRound = async (count, prefix) => {
      const writer = pool.query(`INSERT INTO oaa.observation(cluster_id,source,source_event_id,subject_node_id,observation_type,severity,
        fact,payload_digest,evidence_ref,collector_id,fencing_epoch,collection_epoch,stream_sequence,source_revision,
        reconcile_session_id,snapshot_complete,observed_at,received_at)
        SELECT 'acceptance','kubernetes','${prefix}-'||g,'node:'||((g%10000)+1),'watch-event','info',
          jsonb_build_object('storm',true),'${digestA}','storm:'||g,'observer-v1',1,2,1000000+g,g::text,
          '10000000-0000-4000-8000-000000000001',true,clock_timestamp(),clock_timestamp()
        FROM generate_series(1,$1) g`, [count]);
      const latency = await samples(pool, authorityQuery, 60);
      await writer;
      return percentile(latency, 0.95);
    };
    const baselineP95 = await loadRound(10000, 'baseline');
    const stormP95 = await loadRound(100000, 'storm10x');
    const regressionPercent = baselineP95 > 0 ? ((stormP95 - baselineP95) / baselineP95) * 100 : 0;
    assert.ok(stormP95 < 100, `Console authority query became unavailable during 10x storm: ${stormP95.toFixed(2)}ms`);

    const outbox = await pool.query(`SELECT count(*)::int AS total,count(DISTINCT idempotency_key)::int AS unique_keys
      FROM oaa.incident_outbox WHERE idempotency_key LIKE 'acceptance:%'`);
    assert.equal(outbox.rows[0].total, 10000);
    assert.equal(outbox.rows[0].unique_keys, 10000);
    const replayPair = await pool.query(`WITH selected AS (
        SELECT incident_id,row_number() OVER (ORDER BY incident_id) AS position
        FROM oaa.incident WHERE cluster_id='acceptance' ORDER BY incident_id LIMIT 2
      )
      INSERT INTO oaa.incident_outbox(incident_id,transition_sequence,event_type,idempotency_key,payload,created_at)
      SELECT incident_id,2,'incident_severity_changed','acceptance-replay:'||incident_id,
        jsonb_build_object('incidentId',incident_id),'2099-08-10T00:00:00Z'::timestamptz
      FROM selected RETURNING outbox_id,created_at`);
    const replayIds = replayPair.rows.map((row) => String(row.outbox_id)).sort();
    const replayed = await pool.query(`SELECT outbox_id FROM oaa.incident_outbox
      WHERE (created_at,outbox_id)>($1,$2::uuid) ORDER BY created_at,outbox_id LIMIT 1`,
    [replayPair.rows[0].created_at, replayIds[0]]);
    assert.equal(String(replayed.rows[0].outbox_id), replayIds[1], 'same-timestamp SSE replay skipped an outbox transition');
    const outboxTimes = await samples(pool, `SELECT outbox_id FROM oaa.incident_outbox
      WHERE status IN('pending','retry') AND next_attempt_at<=clock_timestamp()
      ORDER BY created_at LIMIT 50`);
    const outboxP95 = percentile(outboxTimes, 0.95);
    assert.ok(outboxP95 <= 300, `notification outbox query p95 ${outboxP95.toFixed(2)}ms exceeds 300ms`);

    // A new Kubernetes Lease holder immediately claims a higher DB epoch. The
    // measured database takeover is well inside the 30-second end-to-end SLO;
    // the Kubernetes Lease expiry budget is verified separately by the elector contract.
    const failoverStarted = performance.now();
    const takeover = await pool.query(`SELECT
      oaa.claim_observer_epoch('acceptance','observer-v2','lease:2',60)::int AS epoch`);
    const failoverMs = performance.now() - failoverStarted;
    assert.equal(takeover.rows[0].epoch, 2);
    assert.ok(failoverMs <= 30000, `observer DB takeover ${failoverMs.toFixed(2)}ms exceeds 30 seconds`);
    // New epoch fences an old observer even if it resumes after a partition.
    await assert.rejects(() => pool.query(`INSERT INTO oaa.resource_node(cluster_id,node_id,node_type,canonical_id,authority,
      authority_uid,display_name,namespace,health,epistemic_state,attributes,fencing_epoch,collection_epoch,
      reconcile_session_id,snapshot_complete,expires_at)
      VALUES('acceptance','stale-writer','Pod','stale','kubernetes','stale-uid','stale','opensphere-console','Ready','known','{}',1,3,
        '10000000-0000-4000-8000-000000000001',true,clock_timestamp()+interval '5 minutes')`), /stale observer fencing epoch/);

    const beforeRestart = await pool.query(`SELECT count(*)::int AS nodes FROM oaa.resource_node WHERE cluster_id='acceptance'`);
    await pool.end(); pool = null;
    sh('docker', ['restart', container], { stdio: 'ignore' });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { sh('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    pool = connection();
    assert.equal((await pool.query(`SELECT count(*)::int AS nodes FROM oaa.resource_node WHERE cluster_id='acceptance'`)).rows[0].nodes,
      beforeRestart.rows[0].nodes, 'DB restart lost graph rows');

    sh('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '-Fc', '-f', '/tmp/r2d2.dump']);
    psql('CREATE DATABASE r2d2_restore;');
    sh('docker', ['exec', container, 'pg_restore', '-U', 'postgres', '-d', 'r2d2_restore', '--no-owner', '--no-privileges',
      '/tmp/r2d2.dump']);
    const restored = connection('r2d2_restore');
    const continuity = await restored.query(`SELECT
      (SELECT count(*) FROM oaa.resource_node WHERE cluster_id='acceptance')::int AS nodes,
      (SELECT count(*) FROM oaa.incident WHERE cluster_id='acceptance')::int AS incidents,
      (SELECT count(*) FROM console.module_operation WHERE idempotency_key='acceptance-operation')::int AS operations,
      (SELECT count(*)-count(DISTINCT fingerprint) FROM oaa.incident WHERE cluster_id='acceptance')::int AS duplicate_incidents,
      (SELECT count(*)-count(DISTINCT idempotency_key) FROM console.module_operation)::int AS duplicate_operations`);
    assert.deepEqual(continuity.rows[0], { nodes: 10000, incidents: 10000, operations: 1, duplicate_incidents: 0, duplicate_operations: 0 });
    await restored.end();

    // Expand/compatibility drill: old schema is explicitly detected, then all
    // operational migrations are applied in canonical inventory order.
    // expands without breaking the legacy module-operation projection or deleting data.
    psql('CREATE DATABASE r2d2_upgrade;');
    psql(prep, 'r2d2_upgrade');
    const legacy = migrations.filter((name) => Number(name.slice(0, 4)) <= 45);
    const expansion = migrations.filter((name) => Number(name.slice(0, 4)) >= 46);
    applyMigrations('r2d2_upgrade', legacy);
    const upgradePool = connection('r2d2_upgrade');
    assert.equal((await upgradePool.query(`SELECT to_regclass('oaa.resource_node') IS NOT NULL AS ready`)).rows[0].ready, false);
    await upgradePool.query(`INSERT INTO console.module_operation(idempotency_key,module_id,action,actor_id,reason,assurance,
      risk_class,target_fingerprint,phase) VALUES('legacy-operation','legacy','verify','30000000-0000-4000-8000-000000000001',
      'legacy operation preserved','aal1','R0','${digestA}','Succeeded')`);
    applyMigrations('r2d2_upgrade', expansion);
    attestMigrations('r2d2_upgrade', migrations);
    assert.equal((await upgradePool.query(`SELECT to_regclass('oaa.resource_node') IS NOT NULL AS ready`)).rows[0].ready, true);
    const legacyProjection = await upgradePool.query(`SELECT module_id,action,phase,result FROM console.module_operation WHERE idempotency_key='legacy-operation'`);
    assert.equal(legacyProjection.rows[0].phase, 'Succeeded');
    assert.equal((await upgradePool.query(`SELECT count(*)::int AS count FROM console.module_operation WHERE idempotency_key='legacy-operation'`)).rows[0].count, 1);

    // L-5 convergence: a clean install and a legacy->expanded upgrade must
    // produce the same catalog and the same immutable migration inventory.
    psql('CREATE DATABASE r2d2_fresh;');
    psql(prep, 'r2d2_fresh');
    applyMigrations('r2d2_fresh', migrations);
    attestMigrations('r2d2_fresh', migrations);
    assert.equal(schemaDump('r2d2_upgrade'), schemaDump('r2d2_fresh'),
      'clean install and component upgrade produced different database schemas');
    const canonicalLedger = migrations.map((name) => `${name.slice(0, -4)}|${migrationDigest(name)}`).join('\n');
    assert.equal((await upgradePool.query(`SELECT string_agg(migration_id || '|' || sha256, E'\\n' ORDER BY migration_id) AS ledger
      FROM console.schema_migration`)).rows[0].ledger, canonicalLedger,
      'component upgrade migration ledger differs from the canonical manifest inventory');
    const freshPool = connection('r2d2_fresh');
    assert.equal((await freshPool.query(`SELECT string_agg(migration_id || '|' || sha256, E'\\n' ORDER BY migration_id) AS ledger
      FROM console.schema_migration`)).rows[0].ledger, canonicalLedger,
      'clean install migration ledger differs from the canonical manifest inventory');
    await freshPool.end();
    await upgradePool.end();

    const summary = {
      graph: { nodes: 10000, p95Ms: Number(graphP95.toFixed(2)), targetMs: 500 },
      incidents: { rows: 10000, p95Ms: Number(incidentP95.toFixed(2)), targetMs: 300 },
      history: { days: 30, rows: history.rows[0].rows, bytes: Number(history.rows[0].bytes) },
      retention: { missingExportRejected: true, legalHoldRejected: true, verifiedExportAccepted: true },
      storm: { baselineEvents: 10000, stormEvents: 100000, authorityBaselineP95Ms: Number(baselineP95.toFixed(2)),
        authorityStormP95Ms: Number(stormP95.toFixed(2)), regressionPercent: Number(regressionPercent.toFixed(2)) },
      notification: { outboxRows: 10000, uniqueKeys: 10000, p95Ms: Number(outboxP95.toFixed(2)),
        sameTimestampReplay: true },
      fencing: { staleWriterRejected: true, dbTakeoverMs: Number(failoverMs.toFixed(2)), targetMs: 30000 },
      dbRestart: { continuity: true },
      restore: continuity.rows[0], upgrade: { oldSchemaDetected: true, expanded: true, legacyRowPreserved: true,
        cleanInstallSchemaConverged: true, migrationLedgerConverged: true },
    };
    console.log(JSON.stringify(summary, null, 2));
    console.log('R2D2 operational acceptance drill PASS');
  } finally {
    if (pool) await pool.end().catch(() => undefined);
    try { sh('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch { /* cleanup */ }
  }
}

await main();
