'use strict';

const http = require('http');
const fs = require('fs');
const { Pool } = require('pg');
const { createConversationStore } = require('./conversation-store');
const { dialogueModePolicy } = require('./dialogue-rollout');
const { dialogueTransitionForToolResult } = require('./dialogue-transition');
const { createNativeIdentityVerifier } = require('./native-identity-client');

const PORT = Number(process.env.PORT || 8080);
const VERSION = String(process.env.APP_VERSION || '1.0.0');
const INSTANCE = String(process.env.HOSTNAME || 'local');
const CONSOLE_IDENTITY_URL = (process.env.CONSOLE_IDENTITY_URL || 'http://opensphere-console-api.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const PG_HOST = process.env.OSDST_PG_HOST || 'opensphere-supabase-postgres.opensphere-console-data.svc.cluster.local';
const PG_PORT = Number(process.env.OSDST_PG_PORT || 5432);
const PG_DB = process.env.OSDST_PG_DB || 'postgres';
const PG_USER = process.env.OSDST_PG_USER || 'opensphere_osdst_runtime';
const PG_PASSWORD = process.env.OSDST_PG_PASSWORD || '';
const PG_TLS = process.env.OSDST_PG_TLS === 'true';
const PG_CA_PATH = process.env.OSDST_PG_CA_PATH || '/etc/osdst-postgres-ca/ca.crt';
const MAINTENANCE_USER = String(process.env.OSDST_MAINTENANCE_PG_USER || '').trim();
const MAINTENANCE_PASSWORD = String(process.env.OSDST_MAINTENANCE_PG_PASSWORD || '');
const MODE = dialogueModePolicy(process.env.OSDST_MODE);
const MAX_BODY = 3 * 1024 * 1024;
const ADMIN_GROUP = process.env.CONSOLE_ADMIN_GROUP || 'console-admins';
const REAPER_INTERVAL_MS = Math.max(15000, Math.min(300000, Number(process.env.OSDST_REAPER_INTERVAL_MS || 60000) || 60000));
const PURGE_INTERVAL_MS = Math.max(60000, Math.min(86400000, Number(process.env.OSDST_PURGE_INTERVAL_MS || 3600000) || 3600000));

const counters = {
  requests: 0,
  failures: 0,
  turnsBegun: 0,
  turnsCompleted: 0,
  turnsFailed: 0,
  leaseHeartbeats: 0,
  transitionsCommitted: 0,
  transitionConflicts: 0,
  transitionFailures: 0,
  leasesRecovered: 0,
  conversationsPurged: 0,
};
let lastCommitAt = '';
let lastError = '';
let maintenancePool;
let maintenanceState = { ready: false, checkedAt: '', error: 'not_checked' };

function sslOptions() {
  if (!PG_TLS) return false;
  const ca = fs.readFileSync(PG_CA_PATH, 'utf8');
  return { ca, rejectUnauthorized: true, servername: PG_HOST };
}

function poolOptions(user, password, applicationName) {
  return {
    host: PG_HOST,
    port: PG_PORT,
    database: PG_DB,
    user,
    password,
    application_name: applicationName,
    ssl: sslOptions(),
    options: `-c role=${applicationName === 'opensphere-osdst-maintenance' ? 'opensphere_osdst_maintenance' : 'opensphere_osdst'} -c search_path=osaa,extensions,public`,
    query_timeout: 10000, statement_timeout: 10000,
    max: 6,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

const pool = new Pool(poolOptions(PG_USER, PG_PASSWORD, 'opensphere-osdst'));
pool.on('error', (error) => {
  lastError = String(error?.message || error).slice(0, 300);
  console.error('[osdst-db]', lastError);
});
const store = createConversationStore(pool);

function getMaintenancePool() {
  if (!MAINTENANCE_USER || !MAINTENANCE_PASSWORD) return null;
  if (!maintenancePool) {
    maintenancePool = new Pool(poolOptions(MAINTENANCE_USER, MAINTENANCE_PASSWORD, 'opensphere-osdst-maintenance'));
    maintenancePool.on('error', (error) => {
      maintenanceState = { ready: false, checkedAt: new Date().toISOString(), error: String(error?.message || error).slice(0, 300) };
    });
  }
  return maintenancePool;
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw Object.assign(new Error('payload too large'), { code: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON body'), { code: 400 }); }
}

const verifyActor = createNativeIdentityVerifier({baseUrl: CONSOLE_IDENTITY_URL});

function requireAdminAal2(actor) {
  if (!actor.groups.includes(ADMIN_GROUP)) throw Object.assign(new Error(`requires ${ADMIN_GROUP}`), { code: 403 });
  if (actor.assurance !== 'aal2') throw Object.assign(new Error('AAL2 reauthentication is required'), { code: 403 });
}

function requireChatUse(actor) {
  if (!actor.permissions.includes('osaa.chat.use')) {
    throw Object.assign(new Error('requires osaa.chat.use'), { code: 403 });
  }
}

async function readiness() {
  const result = await pool.query(`
    SELECT current_user AS writer,
      to_regclass('osaa.conversation') IS NOT NULL AS conversation_ready,
      to_regclass('osaa.conversation_message') IS NOT NULL AS message_ready,
      to_regclass('osaa.dialogue_state_projection') IS NOT NULL AS projection_ready,
      to_regclass('osaa.dialogue_state_transition') IS NOT NULL AS transition_ready
  `);
  const row = result.rows[0] || {};
  const ready = row.writer === 'opensphere_osdst' && row.conversation_ready && row.message_ready && row.projection_ready && row.transition_ready;
  return { ready, writer: row.writer || PG_USER, schema: ready ? 'osaa.dialogue-state/v1' : 'missing' };
}

async function checkMaintenance() {
  const target = getMaintenancePool();
  if (!target) {
    maintenanceState = { ready: false, checkedAt: new Date().toISOString(), error: 'maintenance_credential_not_configured' };
    return maintenanceState;
  }
  try {
    const result = await target.query("SELECT current_user AS identity, has_function_privilege(current_user,'osaa.reap_expired_dialogue_turns(integer)','EXECUTE') AS reaper_ready, has_function_privilege(current_user,'osaa.recover_dialogue_turn(uuid,uuid,text,text)','EXECUTE') AS recovery_ready");
    const row = result.rows[0] || {};
    maintenanceState = {
      ready: row.reaper_ready === true && row.recovery_ready === true,
      identity: row.identity || MAINTENANCE_USER,
      checkedAt: new Date().toISOString(),
      error: '',
    };
  } catch (error) {
    maintenanceState = { ready: false, checkedAt: new Date().toISOString(), error: String(error?.message || error).slice(0, 300) };
  }
  return maintenanceState;
}

async function reapExpiredTurns() {
  const target = getMaintenancePool();
  if (!target) return;
  try {
    const result = await target.query('SELECT * FROM osaa.reap_expired_dialogue_turns($1::integer)', [100]);
    counters.leasesRecovered += result.rowCount || 0;
    await checkMaintenance();
  } catch (error) {
    lastError = String(error?.message || error).slice(0, 300);
    maintenanceState = { ready: false, checkedAt: new Date().toISOString(), error: lastError };
  }
}

async function purgeExpiredConversations() {
  const target = getMaintenancePool();
  if (!target) return;
  try {
    const result = await target.query('SELECT * FROM osaa.purge_eligible_dialogue_state($1::integer)', [25]);
    counters.conversationsPurged += result.rowCount || 0;
  } catch (error) {
    lastError = String(error?.message || error).slice(0, 300);
  }
}

function statusProjection(database = null) {
  return {
    service: 'opensphere-osdst',
    displayName: 'OpenSphere Dialogue State Tracker',
    classification: 'CBSS Core Service',
    version: VERSION,
    instance: INSTANCE,
    mode: MODE.mode,
    ready: database?.ready === true && maintenanceState.ready === true,
    policy: MODE,
    writer: database?.writer || PG_USER,
    schema: database?.schema || 'unknown',
    singleWriter: true,
    lastCommitAt: lastCommitAt || null,
    counters: { ...counters },
    dependencies: {
      cbssSupabase: database?.ready === true ? 'ready' : 'unknown',
      consoleIdentity: 'runtime-verified-per-request',
      maintenance: maintenanceState,
    },
    lastError: lastError || null,
  };
}

function metrics() {
  const lines = [
    '# HELP osdst_up OSDST process is running.',
    '# TYPE osdst_up gauge',
    'osdst_up 1',
    '# HELP osdst_dialogue_mode OSDST dialogue policy mode.',
    '# TYPE osdst_dialogue_mode gauge',
    ...['off', 'shadow', 'read-enforce', 'mutation-enforce'].map((mode) => `osdst_dialogue_mode{mode="${mode}"} ${MODE.mode === mode ? 1 : 0}`),
  ];
  for (const [name, value] of Object.entries(counters)) {
    lines.push(`# TYPE osdst_${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} counter`);
    lines.push(`osdst_${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

async function route(req, res) {
  counters.requests += 1;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, service: 'opensphere-osdst', version: VERSION });
  if (url.pathname === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    return res.end(metrics());
  }
  if (url.pathname === '/readyz') {
    const state = await readiness();
    const ready = state.ready === true && maintenanceState.ready === true;
    return json(res, ready ? 200 : 503, { ...state, ready, service: 'opensphere-osdst', maintenance: maintenanceState });
  }
  if (url.pathname === '/v1/status' && req.method === 'GET') {
    const database = await readiness().catch((error) => ({ ready: false, error: String(error?.message || error) }));
    return json(res, database.ready ? 200 : 503, statusProjection(database));
  }

  const actor = await verifyActor(req);
  requireChatUse(actor);
  if (url.pathname === '/v1/conversations' && req.method === 'GET') {
    return json(res, 200, await store.list(actor, { status: url.searchParams.get('status') || '', limit: url.searchParams.get('limit') || 40 }));
  }
  const conversation = url.pathname.match(/^\/v1\/conversations\/([0-9a-f-]{36})$/i);
  if (conversation && req.method === 'GET') return json(res, 200, await store.get(actor, conversation[1]));
  if (conversation && req.method === 'PATCH') return json(res, 200, await store.update(actor, conversation[1], await readBody(req)));
  if (conversation && req.method === 'DELETE') return json(res, 200, await store.remove(actor, conversation[1]));
  const projection = url.pathname.match(/^\/v1\/conversations\/([0-9a-f-]{36})\/projection$/i);
  if (projection && req.method === 'GET') return json(res, 200, await store.dialogueContext(actor, projection[1]));

  if (url.pathname === '/v1/turns/begin' && req.method === 'POST') {
    const result = await store.beginTurn(actor, await readBody(req));
    counters.turnsBegun += 1;
    return json(res, 200, result);
  }
  if (url.pathname === '/v1/turns/complete' && req.method === 'POST') {
    const body = await readBody(req);
    let result;
    try {
      const response = {
        ...(body.response || {}),
        dialogueMode: MODE.mode,
        dialogueTransition: MODE.recordTransitions
          ? dialogueTransitionForToolResult(body.response?.toolResult, body.turn?.dialogueContext || null)
          : null,
      };
      result = await store.completeTurn(actor, body.turn, response);
    } catch (error) {
      if (Number(error?.code || 0) === 409) counters.transitionConflicts += 1;
      else counters.transitionFailures += 1;
      throw error;
    }
    counters.turnsCompleted += 1;
    if (result.dialogue) counters.transitionsCommitted += 1;
    lastCommitAt = new Date().toISOString();
    return json(res, 200, result);
  }
  if (url.pathname === '/v1/turns/fail' && req.method === 'POST') {
    const body = await readBody(req);
    await store.failTurn(actor, body.turn);
    counters.turnsFailed += 1;
    return json(res, 200, { failed: true });
  }
  if (url.pathname === '/v1/turns/heartbeat' && req.method === 'POST') {
    const body = await readBody(req);
    const result = await store.heartbeatTurn(actor, body.turn);
    counters.leaseHeartbeats += 1;
    return json(res, 200, result);
  }
  const recovery = url.pathname.match(/^\/v1\/admin\/conversations\/([0-9a-f-]{36})\/turns\/([0-9a-f-]{36})\/recover$/i);
  if (recovery && req.method === 'POST') {
    requireAdminAal2(actor);
    const body = await readBody(req);
    const reason = String(body.reason || '').trim();
    const ownerId = String(body.ownerId || '').trim();
    if (reason.length < 8 || reason.length > 500) throw Object.assign(new Error('recovery reason must contain 8 to 500 characters'), { code: 400 });
    const target = getMaintenancePool();
    if (!target) throw Object.assign(new Error('OSDST maintenance capability unavailable'), { code: 503 });
    const result = await target.query('SELECT * FROM osaa.recover_dialogue_turn($1::uuid,$2::uuid,$3::text,$4::text)', [recovery[1], recovery[2], ownerId, reason]);
    counters.leasesRecovered += result.rowCount || 0;
    return json(res, 200, { recovered: true, receipt: result.rows[0] || null });
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  void route(req, res).catch((error) => {
    counters.failures += 1;
    lastError = String(error?.message || error).slice(0, 300);
    json(res, Number(error?.code || 500), {
      error: lastError,
      ...(error?.errorCode ? { errorCode: error.errorCode } : {}),
      ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    });
  });
});

server.listen(PORT, () => {
  console.log(`opensphere-osdst v${VERSION} listening :${PORT} (mode=${MODE.mode})`);
  void checkMaintenance();
  const reaper = setInterval(() => void reapExpiredTurns(), REAPER_INTERVAL_MS);
  const purge = setInterval(() => void purgeExpiredConversations(), PURGE_INTERVAL_MS);
  reaper.unref();
  purge.unref();
});

async function shutdown() {
  server.close();
  await Promise.allSettled([pool.end(), maintenancePool?.end()]);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

module.exports = { MODE, counters, readiness, statusProjection };
