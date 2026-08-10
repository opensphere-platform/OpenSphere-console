#!/usr/bin/env node
// 원장 무결성 — **실행 검증 하네스**.
//
// 왜 별도 파일인가: `verify.mjs` 는 SQL 텍스트를 정규식으로 본다. 그건 "그런 문장이 파일에 있다" 만
// 확인하고 "그 문장이 실제로 막는다" 는 확인하지 못한다(arch-002 레드팀 감사 패턴 B — 자기참조 검증).
// 원장 무결성은 DB 가 실제로 거부해야 성립하는 주장이므로 진짜 PostgreSQL 에 걸어서 확인한다.
//
// 실행:  docker 가 필요하다.
//   node backend/supabase/verify-ledger-integrity.mjs
//
// 검증 항목 (arch-002 L2-7 시정 잠금):
//   1. TRUNCATE 가 거부된다            ← 시정 전에는 통과했다(statement-level 트리거 부재)
//   2. DELETE / UPDATE 가 거부된다
//   3. prev_hash 를 서버가 채운다      ← 시정 전에는 항상 NULL 이었다
//   4. 클라이언트가 보낸 prev_hash 는 무시된다
//   5. 행이 사라지면 verify_event_ledger_chain() 이 그 지점을 지목한다

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(here, 'migrations');
const CONTAINER = 'os-ledger-verify';
const IMAGE = 'pgvector/pgvector:pg16';

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const psql = (sql, { stopOnError = true } = {}) =>
  sh('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
    ...(stopOnError ? ['-v', 'ON_ERROR_STOP=1'] : []), '-t', '-A'], { input: sql });

// Supabase 관리형 스키마(auth/storage)와 역할은 마이그레이션 밖에서 만들어진다. 최소 스텁을 세운다.
const PREP = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE ROLE supabase_admin LOGIN SUPERUSER; CREATE ROLE authenticator NOLOGIN;
CREATE ROLE opensphere_ai_pipeline NOLOGIN; CREATE ROLE opensphere_ai_runtime NOLOGIN;
CREATE ROLE opensphere_console_backend NOLOGIN; CREATE ROLE opensphere_external_channel_executor NOLOGIN;
CREATE ROLE opensphere_notification_dispatcher NOLOGIN; CREATE ROLE opensphere_oaa_gateway NOLOGIN;
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

/** 실패해야 하는 문장. 성공하면 그 자체가 결함이다. */
function mustReject(sql, label) {
  let rejected = false;
  let detail = '';
  try {
    psql(sql);
  } catch (err) {
    rejected = true;
    detail = String(err.stderr || err.stdout || err.message);
  }
  assert.ok(rejected, `${label}: 거부되어야 하는데 통과했다 — 원장이 열려 있다`);
  assert.match(detail, /append-only/, `${label}: 거부되긴 했으나 append-only 계약이 아닌 다른 이유였다`);
  console.log(`  ✓ ${label} — 거부됨`);
}

function mustRejectPermission(sql, label) {
  let rejected = false;
  let detail = '';
  try { psql(sql); } catch (err) {
    rejected = true;
    detail = String(err.stderr || err.stdout || err.message);
  }
  assert.ok(rejected, `${label}: least-privilege 경계를 넘어선 SQL이 통과했다`);
  assert.match(detail, /permission denied|violates row-level security/i,
    `${label}: 권한 경계 이외의 이유로 실패했다 — ${detail.slice(0, 300)}`);
  console.log(`  ✓ ${label} — 권한 거부됨`);
}

function mustRejectContract(sql, label, pattern) {
  let rejected = false;
  let detail = '';
  try { psql(sql); } catch (err) { rejected = true; detail = String(err.stderr || err.stdout || err.message); }
  assert.ok(rejected, `${label}: 강제 계약을 우회했다`);
  assert.match(detail, pattern, `${label}: 예상 계약이 아닌 이유로 실패했다 — ${detail.slice(0, 300)}`);
  console.log(`  ✓ ${label} — 계약 거부됨`);
}

function verifyR2d2RoleMatrix() {
  console.log('\nR2D2 DB 역할 허용·거부 matrix (0046~0053)');
  psql(`SET ROLE opensphere_oaa_observer;
    INSERT INTO oaa.source_health(cluster_id,source,configured,epistemic_state,snapshot_complete,updated_at)
    VALUES ('role-test','Kubernetes',true,'known',true,clock_timestamp()); RESET ROLE;`);
  console.log('  ✓ observer는 source health projection을 기록할 수 있다');
  mustRejectPermission('SET ROLE opensphere_oaa_observer; SELECT count(*) FROM console.module_operation;', 'observer → module_operation');

  psql('SET ROLE opensphere_oaa_api; SELECT count(*) FROM oaa.source_health; RESET ROLE;');
  console.log('  ✓ API 역할은 operational projection을 조회할 수 있다');
  mustRejectPermission(`SET ROLE opensphere_oaa_api;
    INSERT INTO oaa.source_health(cluster_id,source,configured,epistemic_state,snapshot_complete,updated_at)
    VALUES ('role-test','Gitea',true,'known',true,clock_timestamp());`, 'API → projection write');

  psql(`SET ROLE opensphere_oaa_maintenance;
    SELECT count(*) FROM oaa.source_health;
    INSERT INTO oaa.slo_sample(sampled_at,metric,value,labels) VALUES(clock_timestamp(),'coverage_ratio',1,'{}'); RESET ROLE;`);
  console.log('  ✓ maintenance는 partition/SLO 계약 범위만 사용할 수 있다');
  mustRejectPermission(`SET ROLE opensphere_oaa_maintenance;
    UPDATE oaa.source_health SET blocker_code='tamper' WHERE cluster_id='role-test';`, 'maintenance → observer projection write');

  psql('SET ROLE opensphere_oaa_incident_relay; SELECT count(*) FROM oaa.incident_outbox; RESET ROLE;');
  console.log('  ✓ relay는 incident outbox를 조회할 수 있다');
  mustRejectPermission('SET ROLE opensphere_oaa_incident_relay; SELECT count(*) FROM oaa.resource_node;', 'relay → graph read');

  mustRejectPermission('SET ROLE opensphere_console_backend; SELECT count(*) FROM oaa.observation;', 'Console Backend → observation read');
}

function verifyR2d2RedteamHardening() {
  console.log('\nR2D2 red-team 시정 강제계약 (0053)');
  const observationPartition = psql(`SELECT c.oid::regclass::text FROM pg_inherits i
    JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='oaa.observation'::regclass ORDER BY c.relname DESC LIMIT 1;`).trim();
  const sloPartition = psql(`SELECT c.oid::regclass::text FROM pg_inherits i
    JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='oaa.slo_sample'::regclass ORDER BY c.relname DESC LIMIT 1;`).trim();
  for (const role of ['opensphere_oaa_gateway','opensphere_oaa_observer']) {
    mustRejectPermission(`SET ROLE ${role}; UPDATE oaa.observation SET severity='info';`, `${role} → observation parent UPDATE`);
    mustRejectPermission(`SET ROLE ${role}; DELETE FROM oaa.observation;`, `${role} → observation parent DELETE`);
    mustRejectPermission(`SET ROLE ${role}; TRUNCATE oaa.observation;`, `${role} → observation parent TRUNCATE`);
    mustRejectPermission(`SET ROLE ${role}; UPDATE ${observationPartition} SET severity='info';`, `${role} → observation partition UPDATE`);
    mustRejectPermission(`SET ROLE ${role}; DELETE FROM ${observationPartition};`, `${role} → observation partition DELETE`);
    mustRejectPermission(`SET ROLE ${role}; TRUNCATE ${observationPartition};`, `${role} → observation partition TRUNCATE`);
  }
  for (const role of ['opensphere_oaa_gateway','opensphere_oaa_maintenance']) {
    mustRejectPermission(`SET ROLE ${role}; UPDATE oaa.slo_sample SET value=0;`, `${role} → SLO parent UPDATE`);
    mustRejectPermission(`SET ROLE ${role}; DELETE FROM oaa.slo_sample;`, `${role} → SLO parent DELETE`);
    mustRejectPermission(`SET ROLE ${role}; TRUNCATE oaa.slo_sample;`, `${role} → SLO parent TRUNCATE`);
    mustRejectPermission(`SET ROLE ${role}; UPDATE ${sloPartition} SET value=0;`, `${role} → SLO partition UPDATE`);
    mustRejectPermission(`SET ROLE ${role}; DELETE FROM ${sloPartition};`, `${role} → SLO partition DELETE`);
    mustRejectPermission(`SET ROLE ${role}; TRUNCATE ${sloPartition};`, `${role} → SLO partition TRUNCATE`);
  }
  console.log('  ✓ evidence parent·동적 partition의 role×UPDATE/DELETE/TRUNCATE matrix가 fail-closed다');

  mustReject(`SET session_replication_role='replica';
    UPDATE oaa.slo_sample SET value=0 WHERE metric='coverage_ratio';`, 'replica role → SLO append-only UPDATE');
  mustReject(`SET session_replication_role='replica';
    DELETE FROM oaa.slo_sample WHERE metric='coverage_ratio';`, 'replica role → SLO append-only DELETE');
  mustReject(`SET session_replication_role='replica'; TRUNCATE oaa.slo_sample;`, 'replica role → SLO append-only TRUNCATE');
  console.log('  ✓ ENABLE ALWAYS append-only trigger는 session_replication_role=replica 우회를 막는다');

  mustRejectPermission(`SET ROLE opensphere_oaa_observer;
    INSERT INTO oaa.incident(cluster_id,fingerprint,incident_type,status,severity,confidence,cause_status,title,
      first_detected_at,last_observed_at,primary_node_id,summary,fencing_epoch)
    VALUES('raw-write','${`sha256:${'9'.repeat(64)}`}','raw','active','high',1,'confirmed','raw',clock_timestamp(),clock_timestamp(),'n','raw',1);`,
  'observer → raw incident INSERT');
  mustRejectPermission(`SET ROLE opensphere_oaa_observer; UPDATE oaa.incident SET status='resolved';`,
    'observer → raw incident UPDATE');
  mustRejectPermission(`SET ROLE opensphere_oaa_observer;
    INSERT INTO oaa.incident_timeline(incident_id,sequence,transition,to_status,transition_sequence,fencing_epoch,reason_code,evidence_digest)
    SELECT incident_id,999,'raw','active',999,fencing_epoch,'raw','${`sha256:${'8'.repeat(64)}`}' FROM oaa.incident LIMIT 1;`,
  'observer → raw incident timeline INSERT');
  for (const table of ['incident','incident_timeline','incident_evidence','incident_impact','incident_outbox']) {
    mustRejectPermission(`SET ROLE opensphere_oaa_observer; DELETE FROM oaa.${table};`, `observer → raw ${table} DELETE`);
    mustRejectPermission(`SET ROLE opensphere_oaa_observer; TRUNCATE oaa.${table};`, `observer → raw ${table} TRUNCATE`);
  }
  console.log('  ✓ incident 5-table 상태·timeline·evidence·impact·outbox는 fenced RPC 외 raw DML이 없다');

  const selfOperation = '12121212-1212-4212-8212-121212121212';
  const selfActor = '13131313-1313-4313-8313-131313131313';
  psql(`INSERT INTO console.module_operation(operation_id,idempotency_key,module_id,action,actor_id,reason,assurance,
    risk_class,target_fingerprint,phase,requested_risk_class,required_assurance,deadline_at,execution_state,verification_state)
    VALUES('${selfOperation}','r2d2-self-approval-db','r2d2','rollback-image','${selfActor}','self approval DB rejection',
      'aal2','R2','${`sha256:${'7'.repeat(64)}`}','AwaitingApproval','R2','aal2',clock_timestamp()+interval '1 hour','awaiting_approval','pending');`);
  mustRejectContract(`SET ROLE opensphere_console_backend;
    INSERT INTO console.module_operation_approval(operation_id,approver_id,assurance,approval_digest)
    VALUES('${selfOperation}','${selfActor}','aal2','${`sha256:${'6'.repeat(64)}`}');`, 'R2 self approval', /independent approver/i);
  console.log('  ✓ R2/R3 submitter와 승인자의 DB-level separation of duties가 강제된다');

  const pathSetting = psql(`SELECT array_to_string(proconfig,',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='oaa' AND p.proname='propose_engineering_remediation_v2';`).trim();
  assert.doesNotMatch(pathSetting, /public/, 'Engineering SECURITY DEFINER search_path still includes public');
  console.log('  ✓ Engineering SECURITY DEFINER search_path에서 public이 제거됐다');
}

function verifyR2d2ReconcileAndRetentionGates() {
  console.log('\nR2D2 reconcile 완전성·retention 폐쇄형 실행계약 (0053)');
  const session = '14141414-1414-4414-8414-141414141414';
  const nodeId = 'kubernetes:Deployment:opensphere-console:barrier-test';
  const authorityRevision = `sha256:${'5'.repeat(64)}`;
  const epoch = Number(psql(`SET ROLE opensphere_oaa_observer;
    SELECT oaa.claim_observer_epoch('barrier-test','barrier-verifier','barrier-lease',120); RESET ROLE;`)
    .trim().split('\n').find((line) => /^\d+$/u.test(line)));
  assert.ok(epoch > 0, 'barrier verifier could not claim a fence');
  psql(`SET ROLE opensphere_oaa_observer;
    INSERT INTO oaa.reconcile_session(reconcile_session_id,cluster_id,source,collector_id,fencing_epoch,
      collection_epoch,expected_scope_count,completed_scope_count,snapshot_complete)
    VALUES('${session}','barrier-test','kubernetes','barrier-verifier',${epoch},1,1,1,false);
    INSERT INTO oaa.resource_node(cluster_id,node_id,node_type,canonical_id,authority,authority_uid,display_name,
      namespace,health,epistemic_state,attributes,fencing_epoch,collection_epoch,stream_sequence,source_revision,
      reconcile_session_id,snapshot_complete,observed_at,expires_at)
    VALUES('barrier-test','${nodeId}','Deployment','deployment/barrier-test','kubernetes','uid-barrier','barrier-test',
      'opensphere-console','Ready','known','{}',${epoch},1,1,'rv-1','${session}',true,clock_timestamp(),clock_timestamp()+interval '3 minutes');
    RESET ROLE;`);
  const material = ['complete-reconcile-v2',session,'1','1','1',authorityRevision,nodeId].join('\n');
  const completeDigest = `sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
  mustRejectContract(`SET ROLE opensphere_oaa_observer;
    SELECT oaa.complete_reconcile_session_v2('${session}',1,1,false,'${authorityRevision}','${completeDigest}');`,
  'page token 미소진 reconcile', /incomplete reconcile scope\/page barrier/i);
  mustRejectContract(`SET ROLE opensphere_oaa_observer;
    SELECT oaa.complete_reconcile_session_v2('${session}',1,0,true,'${authorityRevision}','${completeDigest}');`,
  'DB 관측 수와 불일치한 reconcile', /observed resource count mismatch/i);
  mustRejectContract(`SET ROLE opensphere_oaa_observer;
    SELECT oaa.complete_reconcile_session_v2('${session}',1,1,true,'${authorityRevision}','${`sha256:${'4'.repeat(64)}`}');`,
  '완전성 digest 불일치 reconcile', /completeness digest mismatch/i);
  assert.equal(psql(`SELECT snapshot_complete FROM oaa.reconcile_session WHERE reconcile_session_id='${session}';`).trim(), 'f',
    'failed barrier incorrectly marked the snapshot complete');
  assert.match(psql(`SET ROLE opensphere_oaa_observer;
    SELECT oaa.complete_reconcile_session_v2('${session}',1,1,true,'${authorityRevision}','${completeDigest}'); RESET ROLE;`), /t/,
  'valid independent completeness evidence did not cross the barrier');
  assert.equal(psql(`SELECT snapshot_complete||'|'||observed_resource_count||'|'||page_token_exhausted
    FROM oaa.reconcile_session WHERE reconcile_session_id='${session}';`).trim(), 'true|1|true');
  mustRejectPermission(`SET ROLE opensphere_oaa_observer; SELECT oaa.complete_reconcile_session('${session}',1);`,
    'legacy collector-count-only reconcile RPC');
  console.log('  ✓ 독립 DB count·page exhaustion·authority revision·digest가 모두 맞아야 reconcile이 완료된다');

  const exportId = '15151515-1515-4515-8515-151515151515';
  const holdId = '16161616-1616-4616-8616-161616161616';
  psql(`CREATE TABLE oaa.slo_sample_202401 PARTITION OF oaa.slo_sample
    FOR VALUES FROM ('2024-01-01T00:00:00Z') TO ('2024-02-01T00:00:00Z');
    SELECT oaa.harden_evidence_partition('oaa.slo_sample_202401'::regclass,'slo_sample');
    INSERT INTO oaa.evidence_partition_export(export_id,stream,range_start,range_end,row_count,object_ref,
      object_digest,verified_at,verified_by)
    VALUES('${exportId}','slo_sample','2024-01-01T00:00:00Z','2024-02-01T00:00:00Z',0,
      's3://r2d2-evidence/slo-202401','${`sha256:${'3'.repeat(64)}`}',clock_timestamp(),'ledger-verifier');`);
  mustRejectContract(`SET ROLE opensphere_oaa_maintenance;
    ALTER TABLE oaa.slo_sample DETACH PARTITION oaa.slo_sample_202401;`, 'maintenance direct partition DDL', /must be owner|permission denied/i);
  mustRejectContract(`SET ROLE opensphere_oaa_maintenance;
    SELECT oaa.purge_evidence_partition('slo_sample','slo_sample_202401','2024-01-01T00:00:00Z','2024-02-01T00:00:00Z','${exportId}');`,
  'restore 미검증 partition purge', /verified export and restore proof required/i);
  psql(`UPDATE oaa.evidence_partition_export SET restored_at=clock_timestamp() WHERE export_id='${exportId}';
    INSERT INTO oaa.evidence_legal_hold(hold_id,stream,range_start,range_end,reason,created_by)
    VALUES('${holdId}','slo_sample','2024-01-01T00:00:00Z','2024-02-01T00:00:00Z','redteam retention legal hold','ledger-verifier');`);
  mustRejectContract(`SET ROLE opensphere_oaa_maintenance;
    SELECT oaa.purge_evidence_partition('slo_sample','slo_sample_202401','2024-01-01T00:00:00Z','2024-02-01T00:00:00Z','${exportId}');`,
  'legal hold partition purge', /active legal hold blocks purge/i);
  psql(`UPDATE oaa.evidence_legal_hold SET active=false,released_by='ledger-verifier',released_at=clock_timestamp()
    WHERE hold_id='${holdId}';`);
  assert.match(psql(`SET ROLE opensphere_oaa_maintenance;
    SELECT oaa.purge_evidence_partition('slo_sample','slo_sample_202401','2024-01-01T00:00:00Z','2024-02-01T00:00:00Z','${exportId}'); RESET ROLE;`), /t/,
  'fully evidenced partition purge did not complete');
  assert.equal(psql(`SELECT to_regclass('oaa.slo_sample_202401') IS NULL;`).trim(), 't');
  console.log('  ✓ restore proof·legal hold·30일·exact child 검사가 실제 DETACH/DROP과 원자 결속된다');
}

function verifyR2d2DurabilityAndRemediation() {
  console.log('\nR2D2 durable claim·deadline·Engineering Remediation 원자성');
  const actor = '77777777-7777-4777-8777-777777777777';
  const approver = '88888888-8888-4888-8888-888888888888';
  const digestA = `sha256:${'a'.repeat(64)}`;
  const digestB = `sha256:${'b'.repeat(64)}`;
  const digestC = `sha256:${'c'.repeat(64)}`;
  const operation = '99999999-9999-4999-8999-999999999999';
  psql(`INSERT INTO console.module_operation(
      operation_id,idempotency_key,module_id,action,actor_id,reason,assurance,risk_class,target_fingerprint,
      phase,requested_risk_class,required_assurance,deadline_at,execution_state,verification_state
    ) VALUES(
      '${operation}','r2d2-r2-unapproved','r2d2','rollback-image','${actor}','R2 approval claim verification',
      'aal2','R2','${digestA}','Queued','R2','aal2',clock_timestamp()+interval '1 hour','accepted','pending'
    );`);
  assert.equal(psql(`SELECT count(*) FROM console.claim_module_operation('worker-a',1,10)
    WHERE operation_id='${operation}';`).trim(), '0', 'unapproved R2 operation was claimed');
  console.log('  ✓ 승인 없는 R2는 DB claim 단계에서 차단된다');
  psql(`INSERT INTO console.module_operation_approval(operation_id,approver_id,assurance,approval_digest)
    VALUES('${operation}','${approver}','aal2','${digestB}');`);
  assert.equal(psql(`SELECT count(*) FROM console.claim_module_operation('worker-a',1,10)
    WHERE operation_id='${operation}';`).trim(), '1', 'approved R2 operation was not claimable');
  console.log('  ✓ active AAL2 승인이 있는 R2만 claim된다');

  const expired = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  psql(`INSERT INTO console.module_operation(
      operation_id,idempotency_key,module_id,action,actor_id,reason,assurance,risk_class,target_fingerprint,
      phase,requested_risk_class,required_assurance,deadline_at,execution_state,verification_state
    ) VALUES(
      '${expired}','r2d2-expired-work','r2d2','restart-workload','${actor}','Expired operation verification',
      'aal1','R1','${digestA}','Queued','R1','aal1',clock_timestamp()-interval '1 second','accepted','pending'
    ); SELECT count(*) FROM console.claim_module_operation('worker-b',2,10);`);
  assert.equal(psql(`SELECT phase||'|'||execution_state FROM console.module_operation WHERE operation_id='${expired}';`).trim(),
    'TimedOut|timed_out', 'expired unstarted operation did not converge to TimedOut');
  console.log('  ✓ 만료된 미실행 작업은 TimedOut으로 수렴한다');

  const incident = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const mismatch = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const assessment = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const remediation = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const patchText = '--- a/backend/opensphere-console-oaa-gateway/server.js\n+++ b/backend/opensphere-console-oaa-gateway/server.js\n@@ -1 +1 @@\n-old\n+new\n';
  const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
  psql(`INSERT INTO oaa.observer_fence(cluster_id,fencing_epoch,collector_id,lease_identity,lease_expires_at)
    VALUES('local',1,'ledger-verifier','ledger-verifier',clock_timestamp()+interval '1 hour')
    ON CONFLICT(cluster_id) DO UPDATE SET fencing_epoch=1,collector_id='ledger-verifier',lease_identity='ledger-verifier',lease_expires_at=clock_timestamp()+interval '1 hour';
    INSERT INTO oaa.incident(
      incident_id,cluster_id,fingerprint,incident_type,status,severity,confidence,cause_status,title,
      first_detected_at,last_observed_at,primary_node_id,rule_revision,summary,fencing_epoch
    ) VALUES('${incident}','local','${digestA}','digest_drift','active','high',1,'confirmed','digest drift',
      clock_timestamp(),clock_timestamp(),'node:deployment','r2d2-correlation-v1','exact digest mismatch',1);
    INSERT INTO oaa.mismatch(mismatch_id,incident_id,cluster_id,subject_node_id,mismatch_type,epistemic_state,
      expected_digest,actual_digest,evidence_digest)
    VALUES('${mismatch}','${incident}','local','node:deployment','exact_image_digest','known','${digestA}','${digestB}','${digestC}');
    INSERT INTO oaa.remediation_assessment(assessment_id,mismatch_id,incident_id,minimum_ladder_step,lower_steps,
      engineering_required,rationale,policy_revision,evidence_digest)
    VALUES('${assessment}','${mismatch}','${incident}',5,
      '[{"step":0,"status":"exhausted"},{"step":1,"status":"exhausted"},{"step":2,"status":"exhausted"},{"step":3,"status":"exhausted"},{"step":4,"status":"exhausted"}]',
      true,'lower recovery ladder exhausted','r2d2-remediation-v1','${digestC}');`);
  const proposalSql = `SELECT stage||'|'||remediation_request_id FROM oaa.propose_engineering_remediation_v2(
    '${remediation}','r2d2-remediation-proposal-db','${actor}','aal2','ffffffff-ffff-4fff-8fff-ffffffffffff','9',
    '${assessment}','${incident}','https://gitea.opensphere.local/opensphere/OpenSphere-console.git',
    '${'1'.repeat(40)}',ARRAY['backend/opensphere-console-oaa-gateway/'],'${patchDigest}',
    $patch$${patchText}$patch$,ARRAY['backend/opensphere-console-oaa-gateway/server.js'],'${digestB}',
    'known mismatch requires bounded source repair','R2',ARRAY['oaaGateway'],ARRAY['opensphere-console-oaa-gateway'],
    ARRAY['unit','contract','integration','security'],'component',NULL::text,'edge','localhost','${'2'.repeat(40)}',
    ARRAY['${digestA}'],'${digestC}',clock_timestamp()+interval '1 hour');`;
  const proposalResult = psql(`SET ROLE opensphere_console_backend; ${proposalSql} RESET ROLE;`)
    .trim().split('\n').find((line) => line.startsWith('proposed|'));
  assert.equal(proposalResult, `proposed|${remediation}`, 'atomic remediation proposal did not persist');
  assert.equal(psql(`SELECT count(*) FROM console.module_operation mo JOIN oaa.engineering_remediation_request er
    ON er.operation_id=mo.operation_id WHERE er.remediation_request_id='${remediation}'
      AND mo.phase='AwaitingApproval' AND er.stage='proposed';`).trim(), '1',
    'remediation request and durable operation were not atomically correlated');
  console.log('  ✓ proposal와 durable operation이 하나의 DB transaction으로 상관 결속된다');
  assert.equal(psql(`SELECT count(*) FROM oaa.remediation_patch_artifact
    WHERE remediation_request_id='${remediation}' AND patch_digest='${patchDigest}';`).trim(), '1',
    'exact patch artifact was not committed atomically with proposal');
  console.log('  ✓ exact unified diff artifact가 proposal과 원자적으로 결속된다');
  const remediationOperation = psql(`SELECT operation_id FROM oaa.engineering_remediation_request
    WHERE remediation_request_id='${remediation}';`).trim();
  assert.match(psql(`SET ROLE opensphere_console_backend;
    SELECT stage FROM oaa.record_engineering_remediation_approval(
      '${remediation}','source_patch','${approver}','aal2','${digestC}','${digestB}',clock_timestamp()+interval '30 minutes');
    RESET ROLE;`).trim(), /approved/, 'patch-bound approval did not activate the dedicated lifecycle');
  assert.equal(psql(`SELECT count(*) FROM console.claim_module_operation('generic-owner-worker',3,10)
    WHERE operation_id='${remediationOperation}';`).trim(), '0',
    'Engineering Remediation escaped into the generic owner-facade worker');
  console.log('  ✓ Engineering Remediation은 승인 후에도 generic owner worker에서 격리된다');
  assert.equal(psql(`SET ROLE opensphere_console_backend;
    SELECT count(*) FROM oaa.claim_engineering_remediation('engineering-worker',4,5)
      WHERE remediation_request_id='${remediation}'; RESET ROLE;`).trim().split('\n').includes('1'), true,
    'approved remediation was not claimable by the dedicated worker');
  assert.equal(psql(`SET ROLE opensphere_console_backend;
    SELECT oaa.heartbeat_engineering_remediation('${remediation}','engineering-worker',4); RESET ROLE;`).trim().split('\n').includes('t'), true,
    'dedicated remediation lease heartbeat failed');
  assert.match(psql(`SET ROLE opensphere_console_backend;
    SELECT stage FROM oaa.advance_engineering_remediation('${remediation}','engineering-worker',4,
      'approved','sandboxed','{"network":"none","credentials":0}'::jsonb,'${digestA}'); RESET ROLE;`).trim(), /sandboxed/,
    'fenced Engineering Remediation stage did not advance');
  for (const [from, to] of [['sandboxed','patched'],['patched','testing'],['testing','ready_to_commit'],['ready_to_commit','committed'],['committed','building']]) {
    psql(`SET ROLE opensphere_console_backend;
      SELECT stage FROM oaa.advance_engineering_remediation('${remediation}','engineering-worker',4,
        '${from}','${to}','{}'::jsonb,'${digestA}'); RESET ROLE;`);
  }
  assert.match(psql(`SET ROLE opensphere_console_backend;
    SELECT source_revision FROM oaa.record_engineering_build_evidence(
      '${remediation}','engineering-worker',4,'${'3'.repeat(40)}','${patchDigest}',
      '{"unit":{"status":"passed"}}'::jsonb,'${digestA}','${digestB}','${digestC}',
      ARRAY['${digestA}'],'localhost','${digestB}'); RESET ROLE;`).trim(), /3{40}/,
    'fenced build evidence was not accepted');
  let staleBuildRejected = false;
  try {
    psql(`SET ROLE opensphere_console_backend;
      SELECT source_revision FROM oaa.record_engineering_build_evidence(
        '${remediation}','engineering-worker',5,'${'3'.repeat(40)}','${patchDigest}',
        '{}'::jsonb,'${digestA}','${digestB}','${digestC}',ARRAY['${digestA}'],'localhost','${digestB}');`);
  } catch (error) { staleBuildRejected = /build evidence claim was lost/.test(String(error.stderr || error.message)); }
  assert.ok(staleBuildRejected, 'stale Engineering Remediation worker appended build evidence');
  psql(`SET ROLE opensphere_console_backend;
    SELECT stage FROM oaa.advance_engineering_remediation('${remediation}','engineering-worker',4,
      'building','build_failed','{"code":"BuilderFailed"}'::jsonb,'${digestA}'); RESET ROLE;`);
  assert.equal(psql(`SELECT (claim_owner IS NULL)::text||'|'||stage FROM oaa.engineering_remediation_request
    WHERE remediation_request_id='${remediation}';`).trim(), 'true|build_failed',
    'build failure did not release its claim');
  assert.equal(psql(`SELECT phase||'|'||execution_state FROM console.module_operation
    WHERE operation_id='${remediationOperation}';`).trim(), 'Failed|failed',
    'build failure did not terminate the durable operation');
  psql(`UPDATE oaa.engineering_remediation_request SET stage='verifying',claim_owner='deploy-worker',claim_epoch=8,
    lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE remediation_request_id='${remediation}';`);
  assert.match(psql(`SET ROLE opensphere_console_backend;
    SELECT status FROM oaa.record_engineering_deployment_verification(
      '${remediation}','deploy-worker',8,'${remediationOperation}',ARRAY['${digestA}'],ARRAY['${digestB}'],
      '${digestA}','${digestB}','{"passed":false}'::jsonb,'{"passed":false}'::jsonb,false,'failed'); RESET ROLE;`).trim(), /failed/,
    'fenced deployment verification was not accepted');
  let staleVerificationRejected = false;
  try {
    psql(`SET ROLE opensphere_console_backend;
      SELECT status FROM oaa.record_engineering_deployment_verification(
        '${remediation}','deploy-worker',9,'${remediationOperation}',ARRAY['${digestA}'],ARRAY['${digestA}'],
        '${digestA}','${digestA}','{"passed":true}'::jsonb,'{"passed":true}'::jsonb,false,'succeeded');`);
  } catch (error) { staleVerificationRejected = /deployment verification claim was lost/.test(String(error.stderr || error.message)); }
  assert.ok(staleVerificationRejected, 'stale Engineering Remediation worker appended deployment verification');
  console.log('  ✓ scoped approval→claim→stage·build·verification fencing과 실패 종결이 연결된다');
  mustRejectPermission(`SET ROLE opensphere_oaa_api; ${proposalSql}`, 'API role → remediation proposal mutation');
}

/**
 * 결재 판정이 원장에 결속되는가.
 *
 * 제품 주장은 "3년 뒤에도 누가 왜 승인했는지 남는다" 이다. 그 주장이 참이려면
 * 의도(누가·왜)와 **결과**(효력을 발휘했는가) 둘 다 원장에 있어야 한다.
 * 0033 이전에는 결과가 원장 밖 테이블에만 있었다.
 */
function verifyApprovalBinding() {
  console.log('\n결재 판정의 원장 결속 (0010 + 0033)');

  // 요청자와 승인자 두 사람. 자기결재 금지를 확인하려면 서로 다른 신원이 필요하다.
  psql(`INSERT INTO auth.users (id, email) VALUES
      ('11111111-1111-4111-8111-111111111111','requester@test'),
      ('22222222-2222-4222-8222-222222222222','approver@test');
    INSERT INTO console.operator (user_id, display_name) VALUES
      ('11111111-1111-4111-8111-111111111111','요청자'),
      ('22222222-2222-4222-8222-222222222222','승인자');`);

  const REQ = '33333333-3333-4333-8333-333333333333';
  psql(`SELECT console.begin_change('${REQ}','idem-approval-0033','human',
      '11111111-1111-4111-8111-111111111111','plugin.enable','registration/developer',
      '결재 결속 검증용 변경', NULL);
    UPDATE console.change_request SET status='authorized' WHERE request_id='${REQ}';`);

  // ① 자기결재는 거부되어야 한다.
  let selfBlocked = false;
  try {
    psql(`SELECT console.begin_change_approval('${REQ}','11111111-1111-4111-8111-111111111111','본인이 스스로 승인 시도');`);
  } catch (err) { selfBlocked = /cannot approve their own request/.test(String(err.stderr || err.message)); }
  assert.ok(selfBlocked, '자기결재가 통과했다 — 두 사람 원칙이 깨졌다');
  console.log('  ✓ 요청자 본인의 승인이 거부된다');

  // ② 사유 없는 승인은 거부되어야 한다(원장에 남길 reason 이 비면 안 된다).
  let reasonRequired = false;
  try {
    psql(`SELECT console.begin_change_approval('${REQ}','22222222-2222-4222-8222-222222222222','짧음');`);
  } catch (err) { reasonRequired = /approval reason is required/.test(String(err.stderr || err.message)); }
  assert.ok(reasonRequired, '사유 없이 승인이 통과했다');
  console.log('  ✓ 사유 없는 승인이 거부된다');

  // ③ 승인 의도가 원장에 남는가.
  psql(`SELECT console.begin_change_approval('${REQ}','22222222-2222-4222-8222-222222222222','예산 확인 후 승인합니다');`);
  const intent = psql(`SELECT action || '|' || phase || '|' || actor_type || '|' || actor_id || '|' || reason
    FROM audit.event WHERE correlation_id='${REQ}' AND action='change-approval';`).trim();
  assert.equal(intent,
    'change-approval|authorized|human|22222222-2222-4222-8222-222222222222|예산 확인 후 승인합니다',
    '승인 의도가 원장에 기대한 형태로 남지 않았다');
  console.log('  ✓ 승인 의도가 원장에 남는다 — 행위자·사유 포함');

  // ④ 승인 **결과**가 원장에 남는가. 0033 이전에는 이 행이 없었다.
  psql(`SELECT console.record_change_approval_result('${REQ}','22222222-2222-4222-8222-222222222222',true,4242,NULL);`);
  const outcome = psql(`SELECT phase || '|' || result || '|' || reason
    FROM audit.event WHERE correlation_id='${REQ}' AND action='change-approval-result';`).trim();
  assert.equal(outcome, 'applied|approval-applied|예산 확인 후 승인합니다 [gitea-review:4242]',
    `승인 결과가 원장에 남지 않았다 (실제: ${outcome || '(행 없음)'})`);
  console.log('  ✓ 승인 결과가 원장에 남는다 — phase=applied, gitea 리뷰 id 포함');

  // ⑤ 의도와 결과가 같은 correlation 으로 한 사슬에 이어지는가.
  const trail = psql(`SELECT string_agg(action || ':' || phase, ' -> ' ORDER BY chain_sequence)
    FROM audit.event WHERE correlation_id='${REQ}';`).trim();
  assert.match(trail, /change-approval:authorized -> change-approval-result:applied$/,
    `상관 추적이 의도→결과로 이어지지 않는다 (실제: ${trail})`);
  console.log(`  ✓ 한 correlation 으로 이어진다 — ${trail}`);

  assert.equal(psql('SELECT valid FROM audit.verify_event_ledger_chain();').trim(), 't',
    '결재 기록을 추가한 뒤 사슬이 깨졌다');
  console.log('  ✓ 결재 기록 추가 후에도 사슬 무결');
}

/**
 * 에이전트 행위가 사람과 같은 원장에 결속되는가.
 *
 * 제품 주장은 "에이전트가 판단 앞에서 멈춘다" 이다. 멈췄다는 사실이 감사 원장 밖에 있으면
 * 사후에 확인할 수 없으므로 주장이 성립하지 않는다. 0034 이전에는 oaa.* 어느 테이블도
 * audit.event 에 쓰지 않았다.
 */
function verifyAgentBinding() {
  console.log('\n에이전트 행위의 원장 결속 (0034)');

  const OPERATOR = '22222222-2222-4222-8222-222222222222';   // 위임한 운영자
  const REQ_OK = '44444444-4444-4444-8444-444444444444';
  const REQ_BLOCK = '55555555-5555-4555-8555-555555555555';

  const before = Number(psql(`SELECT count(*) FROM audit.event WHERE actor_type='service';`).trim());

  // ① 성공한 도구 실행이 원장에 남는가.
  psql(`INSERT INTO oaa.tool_run
      (request_id, actor_id, tool_id, target, permission_code, reason, status, result_digest, completed_at)
    VALUES ('${REQ_OK}','${OPERATOR}','catalog.read','registration/developer',
      'oaa.system.read','카탈로그 조회','applied','sha256:${'a'.repeat(64)}', now());`);
  const applied = psql(`SELECT action || '|' || actor_type || '|' || phase || '|' || result || '|' || reason
    FROM audit.event WHERE correlation_id='${REQ_OK}';`).trim();
  assert.equal(applied,
    'agent.tool.catalog.read|service|applied|agent-tool-applied|카탈로그 조회 [permission:oaa.system.read]',
    `에이전트 실행이 원장에 기대한 형태로 남지 않았다 (실제: ${applied || '(행 없음)'})`);
  console.log('  ✓ 에이전트 도구 실행이 원장에 남는다 — actor_type=service, 권한 코드 포함');

  // ② **차단된** 실행이 원장에 남는가. 이것이 이 단계의 핵심이다.
  psql(`INSERT INTO oaa.tool_run
      (request_id, actor_id, tool_id, target, permission_code, reason, status, completed_at)
    VALUES ('${REQ_BLOCK}','${OPERATOR}','change.approve','request/33333333-3333-4333-8333-333333333333',
      'oaa.action.execute.high','에이전트는 결재할 수 없습니다','blocked', now());`);
  const blocked = psql(`SELECT phase || '|' || result || '|' || reason
    FROM audit.event WHERE correlation_id='${REQ_BLOCK}';`).trim();
  assert.equal(blocked,
    'failed|agent-tool-blocked|에이전트는 결재할 수 없습니다 [permission:oaa.action.execute.high]',
    `정책이 막은 사실이 원장에 남지 않았다 (실제: ${blocked || '(행 없음)'})`);
  console.log('  ✓ 정책이 막은 사실이 원장에 남는다 — result=agent-tool-blocked');

  // ③ 중간 상태는 원장을 오염시키지 않는다.
  psql(`INSERT INTO oaa.tool_run (request_id, actor_id, tool_id, target, permission_code, status)
    VALUES ('66666666-6666-4666-8666-666666666666','${OPERATOR}','x.y','t','oaa.chat.use','intent');`);
  assert.equal(psql(`SELECT count(*) FROM audit.event WHERE correlation_id='66666666-6666-4666-8666-666666666666';`).trim(),
    '0', '중간 상태(intent)가 원장에 새어 들어갔다');
  console.log('  ✓ 중간 상태(intent)는 원장에 남지 않는다');

  const after = Number(psql(`SELECT count(*) FROM audit.event WHERE actor_type='service';`).trim());
  assert.equal(after - before, 2, `service 행위자 기록 수가 기대와 다르다 (${after - before})`);

  assert.equal(psql('SELECT valid FROM audit.verify_event_ledger_chain();').trim(), 't',
    '에이전트 기록을 추가한 뒤 사슬이 깨졌다');
  console.log('  ✓ 에이전트 기록 추가 후에도 사슬 무결');
}

function main() {
  console.log('원장 무결성 검증 (arch-002 L2-7)\n');

  try { sh('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }); } catch { /* 없으면 그만 */ }
  sh('docker', ['run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_PASSWORD=verify',
    '-e', 'POSTGRES_DB=postgres', IMAGE], { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) {
      try { sh('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }); break; }
      catch { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']); }
    }
    psql(PREP);

    // 전부 순서대로 적용한다. 하나라도 실패하면 여기서 멈춘다 —
    // 배포 설치기(Invoke-SupabaseMigrationPsql)도 ON_ERROR_STOP 으로 같은 동작을 하므로,
    // 이 하네스가 통과하지 못하는 마이그레이션 집합은 배포도 통과하지 못한다.
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      psql(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    }
    console.log('  ✓ 마이그레이션 전량 적용 완료 (건너뛴 것 없음)\n');
    verifyR2d2RoleMatrix();
    verifyR2d2RedteamHardening();
    verifyR2d2ReconcileAndRetentionGates();
    verifyR2d2DurabilityAndRemediation();

    // ── 1. 서버가 사슬을 채우는가 ────────────────────────────────────────────
    psql(`INSERT INTO audit.event (request_id, correlation_id, actor_type, action, target_type, target_id, reason, phase, result, event_hash)
      VALUES (extensions.gen_random_uuid(),'c1','system','t.one','x','x1','r1','applied','ok','h1'),
             (extensions.gen_random_uuid(),'c2','system','t.two','x','x2','r2','applied','ok','h2'),
             (extensions.gen_random_uuid(),'c3','system','t.three','x','x3','r3','applied','ok','h3');`);
    const chain = psql(`SELECT chain_sequence || '|' || prev_hash || '|' || ledger_hash
      FROM audit.event ORDER BY chain_sequence;`).trim().split('\n').map((row) => row.split('|'));
    assert.deepEqual(chain.map(([sequence]) => sequence), ['1', '2', '3']);
    assert.equal(chain[0][1], '0'.repeat(64), '첫 원장 행의 genesis 링크가 잘못됐다');
    assert.equal(chain[1][1], chain[0][2], '두 번째 행이 첫 번째 ledger_hash를 가리키지 않는다');
    assert.equal(chain[2][1], chain[1][2], '세 번째 행이 두 번째 ledger_hash를 가리키지 않는다');
    console.log('  ✓ prev_hash 를 서버가 채운다 — genesis → ledger_hash → ledger_hash');

    assert.equal(psql('SELECT valid FROM audit.verify_event_ledger_chain();').trim(), 't');
    console.log('  ✓ verify_event_ledger_chain() 이 정상 사슬을 valid=true 로 판정한다');

    // ── 2. 변경 계열이 전부 막히는가 ────────────────────────────────────────
    mustReject('TRUNCATE audit.event;', 'TRUNCATE');
    mustReject(`DELETE FROM audit.event WHERE action='t.two';`, 'DELETE');
    mustReject(`UPDATE audit.event SET prev_hash='forged' WHERE action='t.three';`, 'UPDATE');

    // ── 3. 클라이언트가 보낸 링크를 신뢰하지 않는가 ──────────────────────────
    psql(`INSERT INTO audit.event (request_id, correlation_id, actor_type, action, target_type, target_id, reason, phase, result, event_hash, prev_hash)
      VALUES (extensions.gen_random_uuid(),'c4','system','t.four','x','x4','r4','applied','ok','h4','ATTACKER');`);
    assert.equal(psql(`SELECT prev_hash = (SELECT ledger_hash FROM audit.event WHERE action='t.three')
      FROM audit.event WHERE action='t.four';`).trim(), 't',
      '클라이언트가 보낸 prev_hash 가 그대로 저장됐다 — 위조된 링크를 받아들인다');
    console.log('  ✓ 클라이언트가 보낸 prev_hash 를 서버 값으로 덮는다');

    // ── 4. 결재 판정이 원장에 결속되는가 ────────────────────────────────────
    verifyApprovalBinding();

    // ── 5. 에이전트 행위가 같은 원장에 결속되는가 ───────────────────────────
    verifyAgentBinding();

    // ── 5. 사슬이 실제로 변조를 탐지하는가 ──────────────────────────────────
    // ⚠ 이 검사는 사슬을 **의도적으로 깨뜨린다.** 반드시 마지막에 둔다 —
    //    앞선 검사들이 무결한 사슬을 전제로 하기 때문이다.
    //    최악의 공격자(테이블 소유자)가 트리거를 내리고 중간 행을 지운 상황을 만든다.
    console.log('\n변조 탐지 (사슬을 의도적으로 깨뜨린다)');
    psql(`ALTER TABLE audit.event DISABLE TRIGGER audit_event_append_only;
          DELETE FROM audit.event WHERE action='t.two';
          ALTER TABLE audit.event ENABLE ALWAYS TRIGGER audit_event_append_only;`);
    const breaks = psql(`SELECT CASE WHEN valid THEN 'valid' ELSE 'invalid' END || '|' || first_invalid_sequence
      FROM audit.verify_event_ledger_chain();`).trim();
    assert.equal(breaks, 'invalid|3', `사슬 파손이 탐지되지 않았다 (실제: ${breaks || '(없음)'})`);
    console.log('  ✓ 행이 사라지면 verify_event_ledger_chain() 이 첫 파손 chain_sequence=3을 지목한다');

    console.log('\n원장 무결성 검증 통과.');
  } finally {
    try { sh('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }); } catch { /* 정리 실패는 무시 */ }
  }
}

main();
