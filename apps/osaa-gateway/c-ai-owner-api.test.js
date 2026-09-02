'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createCAiOwnerApi } = require('./c-ai-owner-api');

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const REMEDIATION_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ACTOR_ID = '55555555-5555-4555-8555-555555555555';
const DESCRIPTOR_DIGEST = 'sha256:' + 'a'.repeat(64);
const BINDING_DIGEST = 'sha256:' + 'b'.repeat(64);
const SOURCE_REVISION = 'c'.repeat(40);

function actor(overrides = {}) {
  return {
    subject: ACTOR_ID, username: ACTOR_ID, browserSessionId: SESSION_ID,
    assurance: 'aal2', authzRevision: '19', ...overrides,
  };
}

function operationRow(overrides = {}) {
  return {
    operation_id: OPERATION_ID, actor_id: OTHER_ACTOR_ID,
    action: 'restart-workload', precondition: { target: 'deployment/console' },
    phase: 'AwaitingApproval', execution_state: 'awaiting_approval',
    verification_state: 'not_started', requested_risk_class: 'R2',
    required_assurance: 'aal2', descriptor_revision: '7',
    descriptor_digest: DESCRIPTOR_DIGEST, result: {},
    created_at: '2026-09-02T00:00:00.000Z',
    updated_at: '2026-09-02T00:00:00.000Z',
    deadline_at: '2099-09-02T00:00:00.000Z',
    private_internal_value: 'must-not-project', ...overrides,
  };
}

function remediationRow(overrides = {}) {
  return {
    remediation_request_id: REMEDIATION_ID,
    assessment_id: '66666666-6666-4666-8666-666666666666',
    incident_id: '77777777-7777-4777-8777-777777777777',
    operation_id: OPERATION_ID, operator_id: ACTOR_ID,
    repository: 'https://github.com/opensphere-platform/OpenSphere-console.git',
    base_revision: 'd'.repeat(40), allowed_paths: ['apps/osaa-gateway'],
    changed_paths: ['apps/osaa-gateway/server.js'],
    patch_digest: 'sha256:' + 'e'.repeat(64),
    patch_text: 'secret source patch must never project',
    reason: 'Bounded repair of the C_AI owner route', risk_level: 'R2',
    affected_components: ['opensphere-console-osaa-gateway'],
    affected_images: ['opensphere-console-osaa-gateway'],
    required_tests: ['unit', 'security'], release_scope: 'component',
    target_channel: 'edge', build_authority: 'localhost',
    rollback_revision: 'f'.repeat(40),
    rollback_image_digests: ['ghcr.io/opensphere-platform/x@sha256:' + '1'.repeat(64)],
    approval_binding_digest: BINDING_DIGEST,
    approval_mode: 'local-edge-supervised', verification_profile: 'osaa-admin',
    verification_route: '/manage/osaa',
    approval_expires_at: '2099-09-02T00:00:00.000Z',
    stage: 'awaiting_approval', created_at: '2026-09-02T00:00:00.000Z',
    updated_at: '2026-09-02T00:00:00.000Z', ...overrides,
  };
}

function fakePool(values, calls) {
  return {
    async query(sql, params) {
      calls.push({ sql, params });
      const match = sql.match(/osaa\.([a-z0-9_]+)\(/);
      assert.ok(match, 'C_AI store access must use a fixed osaa SECURITY DEFINER RPC');
      if (!Object.hasOwn(values, match[1])) throw new Error('missing fake RPC: ' + match[1]);
      const value = typeof values[match[1]] === 'function'
        ? await values[match[1]](params) : values[match[1]];
      return { rows: [{ value }] };
    },
  };
}

function apiWith(overrides = {}) {
  const dbCalls = [], k8sCalls = [], auditCalls = [], eventOrder = [];
  const values = {
    c_ai_list_module_operations: [operationRow()],
    c_ai_get_module_operation: {
      operation: operationRow(),
      steps: [{ sequence: 1, step_type: 'owner-submit', status: 'succeeded', evidence: { ok: true } }],
      approvals: [{ approver_id: OTHER_ACTOR_ID, assurance: 'aal2', approval_digest: 'sha256:' + '2'.repeat(64) }],
    },
    c_ai_approve_module_operation: { operationId: OPERATION_ID, phase: 'Queued' },
    c_ai_engineering_remediation_status: { workerReady: true },
    c_ai_list_engineering_remediations: [remediationRow()],
    c_ai_get_engineering_remediation: {
      request: remediationRow(), changedPaths: ['apps/osaa-gateway/server.js'],
      operationActorId: OTHER_ACTOR_ID,
      latestBuild: {
        source_revision: SOURCE_REVISION, patch_digest: 'sha256:' + 'e'.repeat(64),
        build_authority: 'localhost',
        image_digests: ['ghcr.io/opensphere-platform/x@sha256:' + '3'.repeat(64)],
        release_lock_digest: 'sha256:' + '4'.repeat(64),
        test_evidence: { private: true },
      },
    },
    c_ai_approve_engineering_source: remediationRow({ stage: 'approved' }),
    c_ai_record_engineering_browser_verification: {
      passed: true, evidenceDigest: 'sha256:' + '5'.repeat(64),
      observedAt: '2026-09-02T00:05:00.000Z',
    },
    ...(overrides.values || {}),
  };
  const defaultK8s = async (method, resourcePath, body) => {
    k8sCalls.push({ method, path: resourcePath, body });
    eventOrder.push(method === 'PATCH' ? 'k8s:patch' : 'k8s:' + method.toLowerCase());
    if (method === 'GET' && resourcePath.includes('/deployments/opensphere-osdst')) {
      return { ok: true, status: 200, json: {
        metadata: { generation: 4, annotations: {} },
        spec: { replicas: 2, template: {
          metadata: { annotations: { 'opensphere.io/osdst-mode': 'shadow' } },
          spec: { containers: [{ name: 'osdst', image: 'ghcr.io/opensphere-platform/opensphere-osdst@sha256:' + '6'.repeat(64) }] },
        } },
        status: { observedGeneration: 4, updatedReplicas: 2, readyReplicas: 2 },
      } };
    }
    if (method === 'PATCH' && resourcePath.includes('/deployments/opensphere-osdst')) {
      return { ok: true, status: 200, json: {
        metadata: { generation: 5, annotations: body.metadata.annotations },
        spec: { replicas: 2, template: { metadata: { annotations: body.spec.template.metadata.annotations } } },
        status: { observedGeneration: 5, updatedReplicas: 2, readyReplicas: 2 },
      } };
    }
    throw new Error('unexpected Kubernetes call: ' + method + ' ' + resourcePath);
  };
  const instance = createCAiOwnerApi({
    getPool: overrides.noPool ? () => null : () => fakePool(values, dbCalls),
    k8s: overrides.k8s || defaultK8s,
    osdstStatus: overrides.osdstStatus || (async () => ({ service: 'opensphere-osdst', ready: true })),
    auditMutation: overrides.auditMutation || (async (_actor, entry) => {
      auditCalls.push(entry); eventOrder.push('audit:' + entry.phase);
      return { requestId: entry.requestId };
    }),
    fetchImpl: overrides.fetchImpl || (async () => new Response('{}', { status: 200 })),
    timeoutSignal: () => undefined,
    durableOperationsEnabled: overrides.durableOperationsEnabled !== false,
    remediationProposalEnabled: true,
    remediationExecutionEnabled: overrides.remediationExecutionEnabled !== false,
    ...(overrides.providerAllowedOrigins ? { providerAllowedOrigins: overrides.providerAllowedOrigins } : {}),
  });
  return { instance, dbCalls, k8sCalls, auditCalls, eventOrder };
}

test('operation reads use only bounded RPC projections and never expose store-private fields', async () => {
  const { instance, dbCalls } = apiWith();
  const listed = await instance.listOperations('2');
  assert.equal(listed.operations.length, 1);
  assert.equal(listed.operations[0].operationId, OPERATION_ID);
  assert.equal(listed.operations[0].approvalConfirmation,
    'approve R2D2 operation ' + OPERATION_ID + ' ' + DESCRIPTOR_DIGEST);
  assert.equal(Object.hasOwn(listed.operations[0], 'private_internal_value'), false);
  const details = await instance.operationDetails(OPERATION_ID);
  assert.equal(details.steps[0].sequence, 1);
  assert.equal(details.approvals[0].approverId, OTHER_ACTOR_ID);
  assert.deepEqual(dbCalls[0].params, [2]);
  assert.match(dbCalls[0].sql, /^SELECT osaa\.c_ai_list_module_operations\(\$1\) AS value$/);
  await assert.rejects(instance.listOperations('51'), { code: 400 });
});

test('operation approval is AAL2, exact digest bound, independent, and feature gated', async () => {
  const { instance, dbCalls } = apiWith();
  const confirmation = 'approve R2D2 operation ' + OPERATION_ID + ' ' + DESCRIPTOR_DIGEST;
  const approved = await instance.approveOperation(actor(), OPERATION_ID, { confirmation });
  assert.equal(approved.operationId, OPERATION_ID);
  const write = dbCalls.find((call) => call.sql.includes('c_ai_approve_module_operation'));
  assert.deepEqual(write.params.slice(0, 5), [OPERATION_ID, ACTOR_ID, SESSION_ID, '19', confirmation]);
  assert.match(write.params[5], /^sha256:[0-9a-f]{64}$/);
  await assert.rejects(instance.approveOperation(actor({ assurance: 'aal1' }), OPERATION_ID, { confirmation }), { code: 403 });
  await assert.rejects(instance.approveOperation(actor(), OPERATION_ID, { confirmation: confirmation + ' ' }), { code: 400 });
  const sameActor = apiWith({ values: {
    c_ai_get_module_operation: { operation: operationRow({ actor_id: ACTOR_ID }) },
  } });
  await assert.rejects(sameActor.instance.approveOperation(actor(), OPERATION_ID, { confirmation }), { code: 409 });
  const disabled = apiWith({ durableOperationsEnabled: false });
  await assert.rejects(disabled.instance.approveOperation(actor(), OPERATION_ID, { confirmation }), {
    code: 503, errorCode: 'durable_operation_approval_disabled',
  });
  assert.equal(disabled.dbCalls.length, 0);
});

test('remediation reads omit patch bytes and retain exact source/build evidence', async () => {
  const { instance } = apiWith();
  const status = await instance.remediationStatus();
  assert.equal(status.workerReady, true);
  assert.equal(status.capabilities.repositoryWrite, true);
  const list = await instance.listRemediations('5');
  assert.equal(list.remediations[0].remediationRequestId, REMEDIATION_ID);
  assert.equal(Object.hasOwn(list.remediations[0], 'patch_text'), false);
  assert.equal(JSON.stringify(list).includes('secret source patch'), false);
  const details = await instance.remediationDetails(REMEDIATION_ID);
  assert.deepEqual(details.changedPaths, ['apps/osaa-gateway/server.js']);
  assert.equal(details.latestBuild.sourceRevision, SOURCE_REVISION);
  assert.equal(Object.hasOwn(details.latestBuild, 'test_evidence'), false);
  assert.equal(details.requiredConfirmation,
    'approve R2D2 source patch ' + REMEDIATION_ID + ' ' + BINDING_DIGEST);
});

test('source approval persists exact AAL2 independent approval coordinates', async () => {
  const { instance, dbCalls } = apiWith();
  const confirmation = 'approve R2D2 source patch ' + REMEDIATION_ID + ' ' + BINDING_DIGEST;
  const result = await instance.approveRemediationSource(actor(), REMEDIATION_ID, { confirmation });
  assert.equal(result.stage, 'approved');
  const write = dbCalls.find((call) => call.sql.includes('c_ai_approve_engineering_source'));
  assert.deepEqual(write.params.slice(0, 5), [REMEDIATION_ID, ACTOR_ID, SESSION_ID, '19', BINDING_DIGEST]);
  assert.match(write.params[5], /^sha256:[0-9a-f]{64}$/);
  assert.equal(write.params[6], '2099-09-02T00:00:00.000Z');
  await assert.rejects(instance.approveRemediationSource(
    actor({ assurance: 'aal1' }), REMEDIATION_ID, { confirmation },
  ), { code: 403 });
  const sameActor = apiWith({ values: {
    c_ai_get_engineering_remediation: {
      request: remediationRow(), operationActorId: ACTOR_ID,
      latestBuild: { source_revision: SOURCE_REVISION },
    },
  } });
  await assert.rejects(sameActor.instance.approveRemediationSource(
    actor(), REMEDIATION_ID, { confirmation },
  ), { code: 409 });
});

test('browser verification is fixed-profile, exact revision, AAL2 and RPC backed', async () => {
  const { instance, dbCalls } = apiWith({ values: {
    c_ai_get_engineering_remediation: {
      request: remediationRow({ stage: 'verifying' }),
      operationActorId: OTHER_ACTOR_ID,
      latestBuild: { source_revision: SOURCE_REVISION },
    },
  } });
  const evidence = {
    verificationProfile: 'osaa-admin', verificationRoute: '/manage/osaa',
    observedSourceRevision: SOURCE_REVISION, marker: 'os-admin-osaa',
    markerPresent: true, consoleErrorCount: 0, networkFailureCount: 0,
  };
  const recorded = await instance.recordBrowserVerification(actor(), REMEDIATION_ID, evidence);
  assert.equal(recorded.accepted, true);
  assert.equal(recorded.passed, true);
  const write = dbCalls.find((call) => call.sql.includes('c_ai_record_engineering_browser_verification'));
  assert.deepEqual(write.params.slice(0, 10), [
    REMEDIATION_ID, ACTOR_ID, 'osaa-admin', '/manage/osaa', SOURCE_REVISION,
    'os-admin-osaa', true, 0, 0, true,
  ]);
  assert.match(write.params[10], /^sha256:[0-9a-f]{64}$/);
  await assert.rejects(instance.recordBrowserVerification(
    actor({ assurance: 'aal1' }), REMEDIATION_ID, evidence,
  ), { code: 403 });
  await assert.rejects(instance.recordBrowserVerification(actor(), REMEDIATION_ID, {
    ...evidence, observedSourceRevision: '0'.repeat(40),
  }), { code: 400 });
  await assert.rejects(instance.recordBrowserVerification(actor(), REMEDIATION_ID, {
    ...evidence, marker: 'operator-supplied-marker',
  }), { code: 400 });
});

test('Dialogue State change audits intent before one exact deployment patch', async () => {
  const { instance, k8sCalls, auditCalls, eventOrder } = apiWith();
  const current = await instance.getDialogueState();
  assert.equal(current.mode, 'shadow');
  assert.equal(current.rollout.ready, true);
  const changed = await instance.setDialogueState(actor(), {
    mode: 'read-enforce', reason: 'Enable fact checks after reviewed readiness',
  });
  assert.equal(changed.changed, true);
  const patch = k8sCalls.find((call) => call.method === 'PATCH');
  assert.equal(patch.path,
    '/apis/apps/v1/namespaces/opensphere-console/deployments/opensphere-osdst');
  assert.deepEqual(patch.body.spec.template.metadata.annotations, {
    'opensphere.io/osdst-mode': 'read-enforce',
  });
  assert.equal(auditCalls[0].phase, 'intent');
  assert.equal(auditCalls.at(-1).phase, 'applied');
  assert.ok(eventOrder.indexOf('audit:intent') < eventOrder.indexOf('k8s:patch'));
  await assert.rejects(instance.setDialogueState(actor({ assurance: 'aal1' }), {
    mode: 'off', reason: 'Reviewed disable request',
  }), { code: 403 });
  await assert.rejects(instance.setDialogueState(actor(), {
    mode: 'off', reason: 'Reviewed disable request', arbitrary: true,
  }), { code: 400 });
});

function llmSecret(overrides = {}) {
  return {
    metadata: {
      name: 'osaa-llm-primary', namespace: 'opensphere-osaa-credentials',
      resourceVersion: '90210',
      labels: { 'opensphere.io/osaa-llm-key': 'true' },
      annotations: {
        'opensphere.io/osaa-key-id': 'primary',
        'opensphere.io/osaa-provider': 'openai',
        'opensphere.io/osaa-display-name': 'Primary',
        'opensphere.io/osaa-base-url': 'https://api.openai.com/v1',
        'opensphere.io/osaa-default-model': 'gpt-5',
        'opensphere.io/osaa-enabled': 'true',
      },
    },
    data: { api_key: Buffer.from('provider-secret-value').toString('base64') },
    ...overrides,
  };
}

test('LLM validation is exact-Secret, allowlisted, intent-first and never returns key bytes', async () => {
  const calls = [], audits = [], events = [];
  const secret = llmSecret();
  const { instance } = apiWith({
    async k8s(method, resourcePath, body) {
      calls.push({ method, path: resourcePath, body });
      events.push(method === 'PATCH' ? 'k8s:patch' : 'k8s:get');
      if (method === 'GET') return { ok: true, status: 200, json: secret };
      if (method === 'PATCH') return { ok: true, status: 200, json: { metadata: body.metadata } };
      throw new Error('unexpected Kubernetes call');
    },
    async auditMutation(_actor, entry) {
      audits.push(entry); events.push('audit:' + entry.phase);
      return { requestId: entry.requestId };
    },
    async fetchImpl(url, options) {
      events.push('provider:get');
      assert.equal(url, 'https://api.openai.com/v1/models');
      assert.equal(options.headers.authorization, 'Bearer provider-secret-value');
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5' }] }), { status: 200 });
    },
  });
  const out = await instance.testLlmKey(actor(), 'primary', {});
  assert.equal(out.validation.status, 'ready');
  assert.equal(out.item.id, 'primary');
  assert.equal(JSON.stringify(out).includes('provider-secret-value'), false);
  assert.equal(JSON.stringify(out).includes(secret.data.api_key), false);
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.path,
    '/api/v1/namespaces/opensphere-osaa-credentials/secrets/osaa-llm-primary');
  assert.equal(patch.body.metadata.resourceVersion, '90210');
  assert.equal(Object.hasOwn(patch.body, 'data'), false);
  assert.ok(events.indexOf('audit:intent') < events.indexOf('provider:get'));
  assert.ok(events.indexOf('audit:intent') < events.indexOf('k8s:patch'));
  assert.equal(audits.at(-1).phase, 'applied');
  await assert.rejects(instance.testLlmKey(actor(), 'primary', { arbitrary: true }), { code: 400 });
});

test('LLM validation blocks unallowlisted origins and records failed audit without patch', async () => {
  const calls = [], audits = [], base = llmSecret();
  const secret = llmSecret({ metadata: {
    ...base.metadata,
    annotations: {
      ...base.metadata.annotations,
      'opensphere.io/osaa-provider': 'custom',
      'opensphere.io/osaa-base-url': 'https://attacker.invalid/v1',
    },
  } });
  const { instance } = apiWith({
    async k8s(method, resourcePath, body) {
      calls.push({ method, resourcePath, body });
      if (method === 'GET') return { ok: true, status: 200, json: secret };
      throw new Error('patch must not occur');
    },
    async auditMutation(_actor, entry) {
      audits.push(entry); return { requestId: entry.requestId };
    },
  });
  await assert.rejects(instance.testLlmKey(actor(), 'primary', {}), {
    code: 503, errorCode: 'provider_origin_not_allowed',
  });
  assert.deepEqual(audits.map((entry) => entry.phase), ['intent', 'failed']);
  assert.deepEqual(calls.map((call) => call.method), ['GET']);
});

test('Kubernetes write failure cannot be reported as successful key validation', async () => {
  const audits = [], secret = llmSecret();
  const { instance } = apiWith({
    async k8s(method) {
      if (method === 'GET') return { ok: true, status: 200, json: secret };
      return { ok: false, status: 409, json: {} };
    },
    async auditMutation(_actor, entry) {
      audits.push(entry); return { requestId: entry.requestId };
    },
    async fetchImpl() {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5' }] }), { status: 200 });
    },
  });
  await assert.rejects(instance.testLlmKey(actor(), 'primary', {}), { code: 502 });
  assert.deepEqual(audits.map((entry) => entry.phase), ['intent', 'failed']);
});

test('missing C_AI store is explicit 503 and never empty success', async () => {
  const { instance } = apiWith({ noPool: true });
  await assert.rejects(instance.listOperations(), {
    code: 503, errorCode: 'c_ai_owner_store_unavailable',
  });
  await assert.rejects(instance.remediationStatus(), {
    code: 503, errorCode: 'c_ai_owner_store_unavailable',
  });
});

test('server routes retain target admission, permissions and fail-closed flags', () => {
  const root = __dirname;
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const owner = fs.readFileSync(path.join(root, 'c-ai-owner-api.js'), 'utf8');
  const identity = fs.readFileSync(path.join(root, 'console-identity-client.js'), 'utf8');
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  for (const route of [
    '/api/osaa/admin/dialogue-state', '/api/osaa/operations',
    '/api/osaa/remediations/status', '/api/osaa/remediations',
  ]) assert.ok(server.includes(route), route);
  assert.match(server, /cAiLlmKeyTest[\s\S]+testLlmKey/u);
  assert.match(server,
    /cAiOperationApproval[\s\S]+osaa\.action\.execute\.high[\s\S]+approveOperation/u);
  assert.match(server,
    /cAiRemediationSourceApproval[\s\S]+osaa\.action\.execute\.high[\s\S]+approveRemediationSource/u);
  assert.match(server,
    /R2D2_DURABLE_OPERATION_ENABLED = process\.env\.R2D2_DURABLE_OPERATION_ENABLED === 'true'/u);
  assert.match(server,
    /R2D2_ENGINEERING_EXECUTION_ENABLED = process\.env\.R2D2_ENGINEERING_EXECUTION_ENABLED === 'true'/u);
  assert.match(owner, /deployments.*encodeURIComponent\(dialogueDeployment\)/u);
  assert.match(owner, /secrets.*osaa-llm-/u);
  assert.doesNotMatch(owner + server,
    /console-api[\\/]runtime|r2d2-remediation-api|r2d2-operation-api/u);
  assert.match(identity, /x-os-owner-csrf-verified/u);
  assert.match(docker, /COPY c-ai-owner-api\.js \/app\/c-ai-owner-api\.js/u);
});
