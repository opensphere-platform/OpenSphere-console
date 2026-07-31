'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  MODULES,
  RISK_TABLE,
  createModuleOperationApi,
  idempotencyKeyFrom,
  observabilityProjection,
  ownerRequestBody,
  ownerTerminalResult,
} = require('./module-operation-api');

const actorId = '11111111-1111-4111-8111-111111111111';

function ownerStatus(overrides = {}) {
  return {
    checkedAt: '2026-07-31T03:00:00.000Z',
    profiles: [{ name: 'Observability', selected: false }],
    items: [{
      id: 'kube-prometheus-stack',
      release: { managed: false, status: 'not-installed', revision: 0, chartVersion: '87.19.1' },
      check: { state: 'Blocked', reason: 'ObservabilityMissing', checkedAt: '2026-07-31T03:00:00.000Z' },
      ...overrides,
    }],
  };
}

test('static risk table keeps local-edge runtime lifecycle single-admin and purge unavailable', () => {
  assert.deepEqual(MODULES['shared-observability'].actions, ['install', 'verify', 'delete-runtime', 'reinstall']);
  for (const action of MODULES['shared-observability'].actions) {
    assert.equal(RISK_TABLE[`shared-observability:${action}`].riskClass, 'R1');
    assert.equal(RISK_TABLE[`shared-observability:${action}`].assurance, 'aal2');
    assert.equal(RISK_TABLE[`shared-observability:${action}`].approvalMode, 'single-admin');
  }
  assert.equal(RISK_TABLE['shared-observability:purge'].riskClass, 'R3');
  assert.equal(RISK_TABLE['shared-observability:purge'].approvalMode, 'not-available');
  assert.equal(MODULES.argocd.status, 'NotAvailable');
  assert.equal(MODULES.crossplane.status, 'NotAvailable');
  assert.equal(MODULES.postgres.status, 'NotAvailable');
});

test('owner adapter uses only the fixed HIS item and requires explicit runtime-delete confirmation', () => {
  assert.equal(ownerRequestBody('install', '설치 사유가 충분합니다', {}).path, '/api/his/install');
  assert.equal(ownerRequestBody('verify', '검증 사유가 충분합니다', {}).path, '/api/his/validate');
  assert.throws(
    () => ownerRequestBody('delete-runtime', '삭제 사유가 충분합니다', { confirm: 'wrong' }),
    { code: 400, errorCode: 'confirmation_required' },
  );
  assert.equal(
    ownerRequestBody('delete-runtime', '삭제 사유가 충분합니다', { confirm: 'kube-prometheus-stack' }).path,
    '/api/his/uninstall',
  );
});

test('observability projection separates installed, activated and ready and fingerprints observed target', () => {
  const projection = observabilityProjection(ownerStatus({
    release: { managed: true, status: 'deployed', revision: 2, chartVersion: '87.19.1' },
    check: { state: 'Ready', reason: '', checkedAt: '2026-07-31T03:00:00.000Z' },
  }));
  assert.equal(projection.current.installed, true);
  assert.equal(projection.current.activated, false);
  assert.equal(projection.current.ready, true);
  assert.match(projection.targetFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('same idempotency key returns the same durable receipt and invokes owner once', async () => {
  const rows = [];
  let ownerMutationCount = 0;
  const restRequest = async (_resource, options = {}) => {
    if (options.method === 'POST') {
      const candidate = options.body[0];
      if (rows.some((row) => row.idempotency_key === candidate.idempotency_key)) {
        throw { code: 409, msg: 'duplicate' };
      }
      const row = { ...candidate, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      rows.push(row);
      return [row];
    }
    if (options.method === 'PATCH') {
      const id = decodeURIComponent(options.query.match(/operation_id=eq\.([^&]+)/)[1]);
      const row = rows.find((candidate) => candidate.operation_id === id);
      Object.assign(row, options.body);
      return [row];
    }
    const keyMatch = options.query.match(/idempotency_key=eq\.([^&]+)/);
    if (keyMatch) {
      const key = decodeURIComponent(keyMatch[1]);
      return rows.filter((row) => row.idempotency_key === key);
    }
    const idMatch = options.query.match(/operation_id=eq\.([^&]+)/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      return rows.filter((row) => row.operation_id === id);
    }
    return [];
  };
  const ownerRequest = async (pathname, options = {}) => {
    if (options.method === 'POST') {
      ownerMutationCount += 1;
      return { ok: true, operation: { id: 'his-op-1', action: 'install', phase: 'Queued' } };
    }
    assert.equal(pathname, '/api/his/status');
    return ownerStatus();
  };
  const api = createModuleOperationApi({
    restRequest,
    authenticate: async () => ({
      actor: { sub: actorId, assurance: 'aal2' },
      authorization: 'Bearer verified',
    }),
    readBody: async (req) => req.body,
    ownerRequest,
    logAudit: async () => ({}),
  });
  const json = (res, code, body) => { res.code = code; res.body = body; };
  const request = {
    method: 'POST',
    headers: { 'x-os-idempotency-key': 'test-observability-install-1' },
    body: { action: 'install', reason: 'Shared Observability 최초 설치' },
  };
  const first = {};
  assert.equal(await api.handle(request, first, '/api/modules/shared-observability/operations', json), true);
  assert.equal(first.code, 202);
  const second = {};
  assert.equal(await api.handle(request, second, '/api/modules/shared-observability/operations', json), true);
  assert.equal(second.code, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.receipt.operationId, first.body.receipt.operationId);
  assert.equal(ownerMutationCount, 1);
});

test('idempotency key is mandatory and cannot be silently regenerated by the server', () => {
  assert.throws(
    () => idempotencyKeyFrom({ headers: {} }, {}),
    { code: 400, errorCode: 'idempotency_key_required' },
  );
});

test('owner terminal state is folded into the receipt without becoming desired-state authority', () => {
  const row = { action: 'verify', evidence_ref: 'his-operation:abc' };
  const projection = observabilityProjection(ownerStatus({
    release: { managed: true, status: 'deployed', revision: 1 },
    operation: { id: 'abc', action: 'validate', phase: 'Ready' },
    check: { state: 'Ready', checkedAt: '2026-07-31T03:00:00.000Z' },
  }));
  assert.deepEqual(ownerTerminalResult(row, projection), { phase: 'Succeeded', errorCode: null });
});

test('migration makes the receipt backend-only and Setup CLI publishes it as release material', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '0035_module_operation_ledger.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS console\.module_operation/);
  assert.match(migration, /REVOKE ALL ON TABLE console\.module_operation FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE console\.module_operation TO opensphere_console_backend/);
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  const nginx = fs.readFileSync(path.join(__dirname, '..', '..', 'nginx', 'default.conf.template'), 'utf8');
  assert.match(server, /p\.startsWith\('\/api\/modules'\) \|\| p\.startsWith\('\/api\/module-operations'\)/);
  assert.match(server, /requireRecentAal2\(actor, 'module lifecycle mutation'\)/);
  assert.match(dockerfile, /COPY opensphere-console-backend\/module-operation-api\.js \.\/module-operation-api\.js/);
  assert.match(nginx, /location \/api\/modules[\s\S]+opensphere-console-backend/);
  assert.match(nginx, /location \/api\/module-operations[\s\S]+opensphere-console-backend/);
});
