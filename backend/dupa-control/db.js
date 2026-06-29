// db.js — Backbone PostgreSQL 접근(pg pool). docs/BACKBONE-ARCHITECTURE.md §1.3(b)/§3.1.
// 감사로그 영속을 ConfigMap → PostgreSQL로 이전(④, 첫 실수요). audit_log는 append-only(INSERT만).
// 비밀번호는 env가 아니라 K8s Secret(opensphere-backbone/backbone-postgres)에서 컨트롤러가 읽어 init에 전달
// (cross-ns secretKeyRef 불가 우회; dupa-backbone-installer ClusterRole이 secrets get 보유).
const { Pool, Client } = require('pg');

let pool = null;
let enabled = false;
let cfg = null; // 다른 데이터베이스로 transient Client 연결할 때 재사용(PG는 cross-DB 쿼리 불가).

async function init({ host, port, database, user, password }) {
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

// 마이그레이션 멱등 — audit_log + 인덱스. INSERT만 쓰므로 증거 무결성(UPDATE/DELETE 미사용).
async function ensureSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (
    id      bigserial PRIMARY KEY,
    ts      timestamptz NOT NULL DEFAULT now(),
    op_id   text,
    actor   text,
    action  text,
    target  text,
    result  text,
    reason  text
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor)');
  await pool.query('CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action)');
}

// 감사 이벤트 INSERT(append-only). e = {time, opId, actor, action, target, result, reason}.
async function insertAudit(e) {
  if (!enabled) return false;
  await pool.query(
    'INSERT INTO audit_log (ts, op_id, actor, action, target, result, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [e.time || new Date().toISOString(), e.opId || '', e.actor || 'system', e.action || '', e.target || '', e.result || '', e.reason || ''],
  );
  return true;
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

// 데이터 탭(읽기) — DATABASE 목록(크기 포함). template/접속불가 제외.
async function listDatabases() {
  if (!enabled) return [];
  const r = await pool.query(
    'SELECT datname AS name, pg_database_size(datname) AS size FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname',
  );
  return r.rows.map((x) => ({ name: x.name, size: Number(x.size) || 0 }));
}
// DATABASE → TABLE → COLUMN 트리 — 각 DB로 transient Client 연결(PG는 cross-DB 쿼리 불가).
// information_schema.columns 한 방으로 테이블+컬럼(타입)을 묶는다. 연결 실패한 DB는 error로 표기.
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
      out.push({ database: d.name, size: d.size, tables: [...tmap.values()] });
    } catch (e) {
      console.error(`[db] listTree(${d.name}) 실패:`, String(e).slice(0, 80));
      out.push({ database: d.name, size: d.size, tables: [], error: String(e).slice(0, 80) });
    } finally { if (client) { try { await client.end(); } catch { /* noop */ } } }
  }
  return out;
}

// 식별자 검증/인용(SQL 인젝션 차단). PG 식별자 규칙 + 길이 63 제한.
const VALID_IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const qIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';
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
async function dropTenant(database) {
  if (!enabled || !VALID_IDENT.test(database || '')) return;
  try { await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [database]); } catch { /* noop */ }
  try { await pool.query(`DROP DATABASE IF EXISTS ${qIdent(database)}`); } catch (e) { console.error('[db] dropTenant db:', String(e).slice(0, 80)); }
  try { await pool.query(`DROP ROLE IF EXISTS ${qIdent(database)}`); } catch (e) { console.error('[db] dropTenant role:', String(e).slice(0, 80)); }
}

module.exports = { init, insertAudit, recentAudit, listDatabases, listTree, previewRows, provisionTenant, dropTenant, isEnabled: () => enabled };
