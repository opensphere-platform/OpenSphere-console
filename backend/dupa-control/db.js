// db.js — Backbone PostgreSQL 접근(pg pool). docs/BACKBONE-ARCHITECTURE.md §1.3(b)/§3.1.
// 감사로그 영속을 ConfigMap → PostgreSQL로 이전(④, 첫 실수요). audit_log는 append-only(INSERT만).
// 비밀번호는 env가 아니라 K8s Secret(opensphere-backbone/backbone-postgres)에서 컨트롤러가 읽어 init에 전달
// (cross-ns secretKeyRef 불가 우회; dupa-backbone-installer ClusterRole이 secrets get 보유).
//
// 중요한 권한 경계: 이 런타임 모듈은 스키마를 만들거나 바꾸지 않는다. 빈 데이터 디렉터리의
// PostgreSQL 초기화 단계만 audit_log/trigger/소유권을 만들며, console 앱 역할에는
// SELECT+INSERT만 부여된다. 따라서 controller RCE나 일반 앱 DB 자격 유출만으로는
// append-only 증거를 수정·삭제·truncate·trigger 비활성화할 수 없다.
const { Pool, Client } = require('pg');

let pool = null;
let enabled = false;
let cfg = null; // 다른 데이터베이스로 transient Client 연결할 때 재사용(PG는 cross-DB 쿼리 불가).

async function init({ host, port, database, user, password }) {
  // 재시도 호출(이전 init 실패)일 때 끊긴 pool 정리 → 누수 방지. 성공 후엔 호출자 isEnabled 가드로 재호출 안 됨.
  if (pool) { try { await pool.end(); } catch { /* noop */ } pool = null; }
  enabled = false;
  cfg = { host, port: Number(port) || 5432, user, password };
  pool = new Pool({
    host, port: Number(port) || 5432, database, user, password,
    max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
  });
  pool.on('error', (e) => console.error('[db] pool error:', (e && e.message) || e));
  await pool.query('SELECT 1');       // 연결 확인(실패 시 throw → 호출자가 폴백)
  await ensureSchema();
  enabled = true;
  console.log(`[db] connected ${user}@${host}:${port}/${database} (audit_log ready)`);
}

// audit schema는 PostgreSQL bootstrap 단계가 봉인한다. 런타임은 권한·소유권·ALWAYS
// trigger를 검증만 하며, 누락/약화 시 기동을 실패시킨다.
async function ensureSchema() {
  const check = await pool.query(`
    SELECT
      (SELECT rolsuper = false AND rolbypassrls = false AND rolcanlogin = true
       FROM pg_roles WHERE rolname = current_user) AS runtime_is_unprivileged,
      (SELECT rolsuper = true AND rolcanlogin = false
       FROM pg_roles WHERE rolname = 'opensphere_audit_owner') AS audit_owner_is_sealed,
      (SELECT pg_get_userbyid(c.relowner) = 'opensphere_audit_owner'
       FROM pg_class c WHERE c.oid = 'public.audit_log'::regclass) AS audit_owner_isolated,
      (SELECT tgenabled = 'A' FROM pg_trigger
       WHERE tgrelid = 'public.audit_log'::regclass AND tgname = 'audit_log_append_only') AS audit_trigger_always,
      has_table_privilege(current_user, 'public.audit_log', 'SELECT') AS audit_read,
      has_table_privilege(current_user, 'public.audit_log', 'INSERT') AS audit_append,
      NOT has_table_privilege(current_user, 'public.audit_log', 'UPDATE') AS audit_no_update,
      NOT has_table_privilege(current_user, 'public.audit_log', 'DELETE') AS audit_no_delete,
      NOT has_table_privilege(current_user, 'public.audit_log', 'TRUNCATE') AS audit_no_truncate,
      to_regclass('public.managed_credential') IS NOT NULL AS credentials_ready
  `);
  const row = check.rows[0] || {};
  if (!Object.values(row).every((value) => value === true)) {
    throw new Error('Backbone PostgreSQL audit security schema is not ready');
  }
}

// 감사 이벤트 INSERT(append-only). e = {time, opId, actor, action, target, result, reason}.
async function insertAudit(e) {
  if (!enabled || !pool) throw new Error('Backbone PostgreSQL unavailable');
  try {
    await pool.query(
      'INSERT INTO audit_log (ts, op_id, actor, action, target, result, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [e.time || new Date().toISOString(), e.opId || '', e.actor || 'system', e.action || '', e.target || '', e.result || '', e.reason || ''],
    );
    return true;
  } catch (e2) {
    enabled = false;
    throw e2;
  }
}

async function healthCheck() {
  if (!enabled || !pool) return false;
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    enabled = false;
    return false;
  }
}

// 최근 N건(newest-first) — 기동 시 인메모리 링 hydrate용. 컨트롤러 이벤트 형상으로 매핑.
async function recentAudit(limit) {
  if (!enabled) return [];
  const r = await pool.query(
    'SELECT ts, op_id, actor, action, target, result, reason FROM audit_log ORDER BY ts DESC LIMIT $1',
    [Number(limit) || 500],
  );
  return r.rows.map((x) => ({
    time: x.ts instanceof Date ? x.ts.toISOString() : String(x.ts),
    opId: x.op_id || '', actor: x.actor || 'system', action: x.action || '',
    target: x.target || '', result: x.result || '', reason: x.reason || '',
  }));
}

// Console 관리 자격(PAT allowlist, CLI device 공개키)은 Kubernetes ConfigMap이 아니라
// Backbone PostgreSQL에 둔다. 비밀 토큰/개인키는 이 테이블에 절대 저장하지 않는다.
async function listManagedCredentials(kind) {
  if (!enabled || !pool) throw new Error('Backbone PostgreSQL unavailable');
  const r = await pool.query(
    `SELECT credential_id, owner_name, record, created_at, updated_at, last_used_at
     FROM managed_credential WHERE kind=$1 ORDER BY created_at DESC`,
    [kind],
  );
  return r.rows.map((row) => ({
    id: row.credential_id,
    owner: row.owner_name,
    record: row.record,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    lastUsedAt: row.last_used_at instanceof Date ? row.last_used_at.toISOString() : (row.last_used_at ? String(row.last_used_at) : null),
  }));
}

// 자격 증명 사용 시각은 비밀이나 권한 상태가 아닌 운영 메타데이터다. 고빈도 PAT가
// PostgreSQL 쓰기를 증폭하지 않도록 5분 단위로만 갱신한다.
async function touchManagedCredential(kind, id) {
  if (!enabled || !pool) throw new Error('Backbone PostgreSQL unavailable');
  const r = await pool.query(
    `UPDATE managed_credential SET last_used_at=now()
     WHERE kind=$1 AND credential_id=$2
       AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')
     RETURNING last_used_at`,
    [kind, id],
  );
  return r.rowCount > 0;
}

// 자격 상태 변경과 append-only 감사를 하나의 트랜잭션으로 확정한다. 감사 INSERT가
// 실패하면 상태 변경도 롤백되어 "발급됐지만 감사 없음" 상태가 생기지 않는다.
async function mutateManagedCredential({ kind, id, owner, record, audit }) {
  if (!enabled || !pool) throw new Error('Backbone PostgreSQL unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (record === null) {
      await client.query('DELETE FROM managed_credential WHERE kind=$1 AND credential_id=$2', [kind, id]);
    } else {
      await client.query(
        `INSERT INTO managed_credential (kind, credential_id, owner_name, record)
         VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (kind, credential_id) DO UPDATE
         SET owner_name=EXCLUDED.owner_name, record=EXCLUDED.record, updated_at=now()`,
        [kind, id, owner, JSON.stringify(record)],
      );
    }
    await client.query(
      'INSERT INTO audit_log (ts, op_id, actor, action, target, result, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [audit?.time || new Date().toISOString(), audit?.opId || '', audit?.actor || owner || 'system',
        audit?.action || `${kind}-${record === null ? 'revoke' : 'upsert'}`, `${kind}/${id}`,
        audit?.result || 'accepted', audit?.reason || ''],
    );
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

// 데이터 탭(읽기) — DATABASE 목록(크기 포함). template/접속불가 제외.
async function listDatabases() {
  if (!enabled) return [];
  const r = await pool.query(
    'SELECT datname AS name, pg_database_size(datname) AS size FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname',
  );
  return r.rows.map((x) => ({ name: x.name, size: Number(x.size) || 0 }));
}
// DATABASE → {TABLE→COLUMN, FUNCTION, EXTENSION} 트리 — 각 DB로 transient Client 연결(PG는 cross-DB 쿼리 불가).
// information_schema.columns(테이블+컬럼) + pg_proc(함수) + pg_extension(확장). 연결 실패한 DB는 error로 표기.
async function listTree() {
  if (!enabled) return [];
  const dbs = await listDatabases();
  const out = [];
  for (const d of dbs) {
    let client = null;
    try {
      client = new Client({ ...cfg, database: d.name, connectionTimeoutMillis: 4000 });
      await client.connect();
      const r = await client.query(
        `SELECT table_schema AS schema, table_name AS name, column_name AS col, data_type AS type
         FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name, ordinal_position`,
      );
      const tmap = new Map();
      for (const row of r.rows) {
        const key = `${row.schema}.${row.name}`;
        if (!tmap.has(key)) tmap.set(key, { schema: row.schema, name: row.name, columns: [] });
        tmap.get(key).columns.push({ name: row.col, type: row.type });
      }
      // 함수/프로시저(pg_proc) — 시스템 스키마 제외. kind: func/proc/agg/window.
      const fr = await client.query(
        `SELECT n.nspname AS schema, p.proname AS name,
                pg_get_function_identity_arguments(p.oid) AS args,
                pg_get_function_result(p.oid) AS rettype, l.lanname AS lang,
                CASE p.prokind WHEN 'p' THEN 'proc' WHEN 'a' THEN 'agg' WHEN 'w' THEN 'window' ELSE 'func' END AS kind
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY n.nspname, p.proname`,
      );
      const functions = fr.rows.map((x) => ({ schema: x.schema, name: x.name, args: x.args || '', rettype: x.rettype || '', lang: x.lang || '', kind: x.kind || 'func' }));
      // 설치된 확장(pg_extension) — pgvector('vector') 등 가용 여부 가시화.
      const er = await client.query('SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname');
      const extensions = er.rows.map((x) => ({ name: x.name, version: x.version || '' }));
      out.push({ database: d.name, size: d.size, tables: [...tmap.values()], functions, extensions });
    } catch (e) {
      console.error(`[db] listTree(${d.name}) 실패:`, String(e).slice(0, 80));
      out.push({ database: d.name, size: d.size, tables: [], functions: [], extensions: [], error: String(e).slice(0, 80) });
    } finally { if (client) { try { await client.end(); } catch { /* noop */ } } }
  }
  return out;
}

// 식별자 검증/인용(SQL 인젝션 차단). PG 식별자 규칙 + 길이 63 제한.
const VALID_IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const qIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const qLiteral = (s) => "'" + String(s ?? '').replace(/'/g, "''") + "'";
function fmtCell(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
// 테이블 행 미리보기(읽기) — SELECT * LIMIT n. 식별자 정규식 검증 + information_schema 존재확인 + 인용. 쓰기 불가.
async function previewRows(database, schema, table, limit) {
  if (!enabled) return null;
  if (![database, schema, table].every((s) => VALID_IDENT.test(s || ''))) throw new Error('invalid identifier');
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  let client = null;
  try {
    client = new Client({ ...cfg, database, connectionTimeoutMillis: 4000 });
    await client.connect();
    const chk = await client.query('SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', [schema, table]);
    if (!chk.rowCount) throw new Error('table not found');
    const r = await client.query(`SELECT * FROM ${qIdent(schema)}.${qIdent(table)} LIMIT ${lim}`);
    const cols = r.fields.map((f) => f.name);
    return { columns: cols, rows: r.rows.map((row) => cols.map((c) => fmtCell(row[c]))) };
  } finally { if (client) { try { await client.end(); } catch { /* noop */ } } }
}

// ── 테넌트 프로비저닝(BackboneClaim reconciler용) — 전용 role+database 생성/해제. ──
// password는 호출자가 hex로 생성(특수문자 없음 → DDL 인라인 안전). role=database 동명.
async function provisionTenant(database, password) {
  if (!enabled) throw new Error('pg not connected');
  if (!VALID_IDENT.test(database || '')) throw new Error('invalid database name');
  if (!/^[A-Za-z0-9]+$/.test(password || '')) throw new Error('password must be alnum (hex)');
  const role = await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [database]);
  if (role.rowCount) await pool.query(`ALTER ROLE ${qIdent(database)} LOGIN PASSWORD '${password}'`);
  else await pool.query(`CREATE ROLE ${qIdent(database)} LOGIN PASSWORD '${password}'`);
  const dbx = await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [database]);
  if (!dbx.rowCount) await pool.query(`CREATE DATABASE ${qIdent(database)} OWNER ${qIdent(database)}`);
}

async function provisionTenantAppRole(database, username, password) {
  if (!enabled) throw new Error('pg not connected');
  if (!VALID_IDENT.test(database || '')) throw new Error('invalid database name');
  if (!VALID_IDENT.test(username || '')) throw new Error('invalid app role name');
  if (!password) throw new Error('password is required');
  const role = await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [username]);
  if (role.rowCount) await pool.query(`ALTER ROLE ${qIdent(username)} LOGIN PASSWORD ${qLiteral(password)}`);
  else await pool.query(`CREATE ROLE ${qIdent(username)} LOGIN PASSWORD ${qLiteral(password)}`);
  const dbx = await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [database]);
  if (!dbx.rowCount) throw new Error(`database ${database} is not provisioned`);
  await pool.query(`GRANT CONNECT ON DATABASE ${qIdent(database)} TO ${qIdent(username)}`);
  let client = null;
  try {
    client = new Client({ ...cfg, database, connectionTimeoutMillis: 4000 });
    await client.connect();
    await client.query(`GRANT USAGE ON SCHEMA public TO ${qIdent(username)}`);
  } finally { if (client) { try { await client.end(); } catch { /* noop */ } } }
}

async function dropTenant(database, appRole) {
  if (!enabled || !VALID_IDENT.test(database || '')) return;
  try { await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [database]); } catch { /* noop */ }
  try { await pool.query(`DROP DATABASE IF EXISTS ${qIdent(database)}`); } catch (e) { console.error('[db] dropTenant db:', String(e).slice(0, 80)); }
  if (appRole && VALID_IDENT.test(appRole)) {
    try { await pool.query(`DROP ROLE IF EXISTS ${qIdent(appRole)}`); } catch (e) { console.error('[db] dropTenant app role:', String(e).slice(0, 80)); }
  }
  try { await pool.query(`DROP ROLE IF EXISTS ${qIdent(database)}`); } catch (e) { console.error('[db] dropTenant role:', String(e).slice(0, 80)); }
}

// ── 함수 생성(가이드 폼) — admin 게이트 뒤 첫 DDL 쓰기. 식별자 검증 + body 달러 인용. ──
// schema/name은 VALID_IDENT, args/returns는 시그니처라 raw(세미콜론 차단·길이 bound), body는 달러 인용으로 분리.
// (admin은 이미 신뢰 주체 — body는 임의 PL/pgSQL이라 본질적으로 코드 실행. 게이트+감사로 통제.)
async function createFunction({ database, schema, name, args, returns, language, body, replace }) {
  if (!enabled) throw new Error('pg not connected');
  schema = schema || 'public';
  if (![database, schema, name].every((s) => VALID_IDENT.test(s || ''))) throw new Error('invalid identifier (database/schema/name)');
  const lang = String(language || 'plpgsql').toLowerCase();
  if (!['sql', 'plpgsql'].includes(lang)) throw new Error('language must be sql or plpgsql');
  args = String(args || '');
  returns = String(returns || 'void');
  if (/;/.test(args) || /;/.test(returns)) throw new Error('semicolon not allowed in args/returns');
  if (args.length > 2000 || returns.length > 200) throw new Error('args/returns too long');
  body = String(body || '');
  if (!body.trim()) throw new Error('function body required');
  if (body.length > 100000) throw new Error('body too long');
  let tag = 'osfn'; // 달러 인용 태그 — body와 충돌 회피.
  while (body.includes('$' + tag + '$')) tag += 'x';
  const ddl = `CREATE ${replace ? 'OR REPLACE ' : ''}FUNCTION ${qIdent(schema)}.${qIdent(name)}(${args}) RETURNS ${returns} LANGUAGE ${lang} AS $${tag}$${body}$${tag}$`;
  let client = null;
  try {
    client = new Client({ ...cfg, database, connectionTimeoutMillis: 5000 });
    await client.connect();
    await client.query(ddl);
  } finally { if (client) { try { await client.end(); } catch { /* noop */ } } }
}

// 함수 소스 로드(편집용) — identity args(타입만)로 오버로드 식별 → 전체 args(이름 포함)·반환·언어·body 반환.
async function functionSource({ database, schema, name, args }) {
  if (!enabled) throw new Error('pg not connected');
  schema = schema || 'public';
  if (![database, schema, name].every((s) => VALID_IDENT.test(s || ''))) throw new Error('invalid identifier');
  args = String(args || '');
  if (/;/.test(args)) throw new Error('semicolon not allowed in args');
  let client = null;
  try {
    client = new Client({ ...cfg, database, connectionTimeoutMillis: 5000 });
    await client.connect();
    const sig = `${schema}.${name}(${args})`; // VALID_IDENT 보장 → regprocedure 입력 안전.
    const r = await client.query(
      `SELECT pg_get_function_arguments(p.oid) AS full_args, pg_get_function_result(p.oid) AS ret, l.lanname AS lang, p.prosrc AS body
       FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.oid = to_regprocedure($1)`, [sig]);
    if (!r.rowCount) throw new Error('function not found');
    const x = r.rows[0];
    return { args: x.full_args || '', returns: x.ret || '', language: x.lang || 'plpgsql', body: x.body || '' };
  } finally { if (client) { try { await client.end(); } catch { /* noop */ } } }
}

// 함수 삭제(DROP) — identity args로 특정 오버로드 지정. admin 게이트 뒤·감사.
async function dropFunction({ database, schema, name, args }) {
  if (!enabled) throw new Error('pg not connected');
  schema = schema || 'public';
  if (![database, schema, name].every((s) => VALID_IDENT.test(s || ''))) throw new Error('invalid identifier');
  args = String(args || '');
  if (/;/.test(args)) throw new Error('semicolon not allowed in args');
  let client = null;
  try {
    client = new Client({ ...cfg, database, connectionTimeoutMillis: 5000 });
    await client.connect();
    await client.query(`DROP FUNCTION ${qIdent(schema)}.${qIdent(name)}(${args})`);
  } finally { if (client) { try { await client.end(); } catch { /* noop */ } } }
}

module.exports = { init, insertAudit, recentAudit, listManagedCredentials, touchManagedCredential, mutateManagedCredential, healthCheck, listDatabases, listTree, previewRows, provisionTenant, provisionTenantAppRole, dropTenant, createFunction, functionSource, dropFunction, isEnabled: () => enabled };
