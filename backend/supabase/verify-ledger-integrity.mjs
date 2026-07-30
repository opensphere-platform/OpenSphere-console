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
//   5. 행이 사라지면 verify_event_chain() 이 그 지점을 지목한다

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

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
  const trail = psql(`SELECT string_agg(action || ':' || phase, ' -> ' ORDER BY seq)
    FROM audit.event WHERE correlation_id='${REQ}';`).trim();
  assert.match(trail, /change-approval:authorized -> change-approval-result:applied$/,
    `상관 추적이 의도→결과로 이어지지 않는다 (실제: ${trail})`);
  console.log(`  ✓ 한 correlation 으로 이어진다 — ${trail}`);

  assert.equal(psql('SELECT count(*) FROM audit.verify_event_chain();').trim(), '0',
    '결재 기록을 추가한 뒤 사슬이 깨졌다');
  console.log('  ✓ 결재 기록 추가 후에도 사슬 무결');
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

    // ── 1. 서버가 사슬을 채우는가 ────────────────────────────────────────────
    psql(`INSERT INTO audit.event (request_id, correlation_id, actor_type, action, target_type, target_id, reason, phase, result, event_hash)
      VALUES (extensions.gen_random_uuid(),'c1','system','t.one','x','x1','r1','applied','ok','h1'),
             (extensions.gen_random_uuid(),'c2','system','t.two','x','x2','r2','applied','ok','h2'),
             (extensions.gen_random_uuid(),'c3','system','t.three','x','x3','r3','applied','ok','h3');`);
    const chain = psql(`SELECT coalesce(prev_hash,'ROOT') FROM audit.event ORDER BY seq;`).trim().split('\n');
    assert.deepEqual(chain, ['ROOT', 'h1', 'h2'], 'prev_hash 사슬이 서버에서 채워지지 않았다');
    console.log('  ✓ prev_hash 를 서버가 채운다 — ROOT → h1 → h2');

    assert.equal(psql('SELECT count(*) FROM audit.verify_event_chain();').trim(), '0');
    console.log('  ✓ verify_event_chain() 이 정상 사슬을 0 파손으로 판정한다');

    // ── 2. 변경 계열이 전부 막히는가 ────────────────────────────────────────
    mustReject('TRUNCATE audit.event;', 'TRUNCATE');
    mustReject(`DELETE FROM audit.event WHERE action='t.two';`, 'DELETE');
    mustReject(`UPDATE audit.event SET prev_hash='forged' WHERE action='t.three';`, 'UPDATE');

    // ── 3. 클라이언트가 보낸 링크를 신뢰하지 않는가 ──────────────────────────
    psql(`INSERT INTO audit.event (request_id, correlation_id, actor_type, action, target_type, target_id, reason, phase, result, event_hash, prev_hash)
      VALUES (extensions.gen_random_uuid(),'c4','system','t.four','x','x4','r4','applied','ok','h4','ATTACKER');`);
    assert.equal(psql(`SELECT prev_hash FROM audit.event WHERE action='t.four';`).trim(), 'h3',
      '클라이언트가 보낸 prev_hash 가 그대로 저장됐다 — 위조된 링크를 받아들인다');
    console.log('  ✓ 클라이언트가 보낸 prev_hash 를 서버 값으로 덮는다');

    // ── 4. 결재 판정이 원장에 결속되는가 ────────────────────────────────────
    verifyApprovalBinding();

    // ── 5. 사슬이 실제로 변조를 탐지하는가 ──────────────────────────────────
    // ⚠ 이 검사는 사슬을 **의도적으로 깨뜨린다.** 반드시 마지막에 둔다 —
    //    앞선 검사들이 무결한 사슬을 전제로 하기 때문이다.
    //    최악의 공격자(테이블 소유자)가 트리거를 내리고 중간 행을 지운 상황을 만든다.
    console.log('\n변조 탐지 (사슬을 의도적으로 깨뜨린다)');
    psql(`ALTER TABLE audit.event DISABLE TRIGGER audit_event_append_only;
          DELETE FROM audit.event WHERE action='t.two';
          ALTER TABLE audit.event ENABLE ALWAYS TRIGGER audit_event_append_only;`);
    const breaks = psql(`SELECT seq || '|' || expected_prev || '|' || actual_prev FROM audit.verify_event_chain();`).trim();
    assert.equal(breaks, '3|h1|h2', `사슬 파손이 탐지되지 않았다 (실제: ${breaks || '(없음)'})`);
    console.log('  ✓ 행이 사라지면 verify_event_chain() 이 그 지점을 지목한다 — seq 3, 기대 h1, 실제 h2');

    console.log('\n원장 무결성 검증 통과.');
  } finally {
    try { sh('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }); } catch { /* 정리 실패는 무시 */ }
  }
}

main();
