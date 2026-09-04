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
    c_ai_record_engineering_browser_verification: (params) => ({
      passed: params[9], evidenceDigest: params[10],
      observedAt: '2026-09-02T00:05:00.000Z',
    }),
    ...(overrides.values || {}),
  };
  const defaultK8s = async (method, resourcePath, body) => {
    k8sCalls.push({ method, path: resourcePath, body });
    eventOrder.push(method === 'PATCH' ? 'k8s:patch' : 'k8s:' + method.toLowerCase());
    if (method === 'GET' && resourcePath.includes('/deployments/opensphere-osdst')) {
      return { ok: true, status: 200, json: {
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: 'opensphere-osdst', namespace: 'opensphere-console', uid: 'osdst-uid', generation: 4, resourceVersion: '100', annotations: {} },
        spec: { replicas: 2, template: {
          metadata: { annotations: { 'opensphere.io/osdst-mode': 'shadow' } },
          spec: { containers: [{ name: 'osdst', image: 'ghcr.io/opensphere-platform/opensphere-osdst@sha256:' + '6'.repeat(64) }] },
        } },
        status: { observedGeneration: 4, updatedReplicas: 2, readyReplicas: 2 },
      } };
    }
    if (method === 'PATCH' && resourcePath.includes('/deployments/opensphere-osdst')) {
      return { ok: true, status: 200, json: {
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: 'opensphere-osdst', namespace: 'opensphere-console', uid: 'osdst-uid', generation: 5, resourceVersion: '101', annotations: body.metadata.annotations },
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
    llmCredentialMutationEnabled: overrides.llmCredentialMutationEnabled === true,
    llmCredentialDeletionEnabled: overrides.llmCredentialDeletionEnabled === true,
    ...(overrides.runtimeProfile ? { runtimeProfile: overrides.runtimeProfile } : {}),
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

test('development MFA exception is confined to exact local edge profile and preserves stable actor coordinates', async () => {
  const confirmation = 'approve R2D2 operation ' + OPERATION_ID + ' ' + DESCRIPTOR_DIGEST;
  const exactProfile = {
    channel: 'edge', environment: 'development', clusterId: 'local',
    consoleOrigin: 'https://localhost:1114',
  };
  const allowed = apiWith({ runtimeProfile: exactProfile });
  await allowed.instance.approveOperation(actor({ assurance: 'aal1' }), OPERATION_ID, { confirmation });
  const write = allowed.dbCalls.find((call) => call.sql.includes('c_ai_approve_module_operation'));
  assert.deepEqual(write.params.slice(0, 4), [OPERATION_ID, ACTOR_ID, SESSION_ID, '19']);

  for (const runtimeProfile of [
    { ...exactProfile, channel: 'candidate' },
    { ...exactProfile, environment: 'production' },
    { ...exactProfile, clusterId: 'remote' },
    { ...exactProfile, consoleOrigin: 'https://console.example.test' },
    { ...exactProfile, consoleOrigin: 'http://localhost:1114' },
  ]) {
    const denied = apiWith({ runtimeProfile });
    await assert.rejects(
      denied.instance.approveOperation(actor({ assurance: 'aal1' }), OPERATION_ID, { confirmation }),
      { code: 403 },
    );
  }
});

test('remediation reads omit patch bytes and retain exact source/build evidence', async () => {
  const { instance } = apiWith();
  const status = await instance.remediationStatus();
  assert.equal(status.workerReady, true);
  assert.equal(status.capabilities.repositoryWrite, true);
  const invalidStatus = apiWith({ values: { c_ai_engineering_remediation_status: null } });
  await assert.rejects(invalidStatus.instance.remediationStatus(), {
    code: 503, errorCode: 'c_ai_owner_projection_invalid',
  });
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
  assert.equal(current.controlUid, 'osdst-uid');
  const changed = await instance.setDialogueState(actor(), {
    mode: 'read-enforce', reason: 'Enable fact checks after reviewed readiness',
  });
  assert.equal(changed.changed, true);
  const patch = k8sCalls.find((call) => call.method === 'PATCH');
  assert.equal(patch.path,
    '/apis/apps/v1/namespaces/opensphere-console/deployments/opensphere-osdst');
  assert.equal(patch.body.metadata.resourceVersion, '100');
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

test('Dialogue State same-mode request is observe-only even while rollout is pending', async () => {
  const calls = [], audits = [];
  const current = {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'opensphere-osdst', namespace: 'opensphere-console',
      uid: 'osdst-uid', generation: 5, resourceVersion: '100', annotations: {},
    },
    spec: {
      replicas: 2,
      template: {
        metadata: { annotations: { 'opensphere.io/osdst-mode': 'shadow' } },
        spec: { containers: [{ name: 'osdst', image: 'example.test/osdst@sha256:' + '6'.repeat(64) }] },
      },
    },
    status: { observedGeneration: 4, updatedReplicas: 1, readyReplicas: 1 },
  };
  const { instance } = apiWith({
    async k8s(method) {
      calls.push(method);
      if (method !== 'GET') throw new Error('same mode must not be patched');
      return { ok: true, status: 200, json: current };
    },
    async auditMutation(_actor, event) {
      audits.push(event);
      return { requestId: event.requestId };
    },
  });
  const result = await instance.setDialogueState(actor(), {
    mode: 'shadow', reason: 'Observe the pending rollout without changing policy',
  });
  assert.equal(result.changed, false);
  assert.equal(result.mode, 'shadow');
  assert.equal(result.rollout.ready, false);
  assert.deepEqual(calls, ['GET']);
  assert.deepEqual(audits, []);
});

test('Dialogue State refuses changed UID or stale resourceVersion receipts', async () => {
  for (const receipt of [
    { uid: 'replacement-osdst-uid', resourceVersion: '101' },
    { uid: 'osdst-uid', resourceVersion: '100' },
  ]) {
    const audits = [];
    const current = {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: {
        name: 'opensphere-osdst', namespace: 'opensphere-console',
        uid: 'osdst-uid', generation: 4, resourceVersion: '100', annotations: {},
      },
      spec: {
        replicas: 2,
        template: {
          metadata: { annotations: { 'opensphere.io/osdst-mode': 'shadow' } },
          spec: { containers: [{ name: 'osdst', image: 'example.test/osdst@sha256:' + '6'.repeat(64) }] },
        },
      },
      status: { observedGeneration: 4, updatedReplicas: 2, readyReplicas: 2 },
    };
    const { instance } = apiWith({
      async auditMutation(_actor, event) {
        audits.push(event);
        return { requestId: event.requestId };
      },
      async k8s(method, _resourcePath, body) {
        if (method === 'GET') return { ok: true, status: 200, json: current };
        return {
          ok: true, status: 200,
          json: {
            ...current,
            metadata: { ...current.metadata, ...receipt, generation: 5, annotations: body.metadata.annotations },
            spec: {
              ...current.spec,
              template: {
                ...current.spec.template,
                metadata: { annotations: body.spec.template.metadata.annotations },
              },
            },
            status: { observedGeneration: 5, updatedReplicas: 2, readyReplicas: 2 },
          },
        };
      },
    });
    await assert.rejects(instance.setDialogueState(actor(), {
      mode: 'read-enforce', reason: 'Enable fact checks after reviewed readiness',
    }), { code: 409 });
    assert.deepEqual(audits.map((entry) => entry.phase), ['intent', 'failed']);
  }
});

function llmSecret(overrides = {}) {
  return {
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
    metadata: {
      name: 'osaa-llm-primary', namespace: 'opensphere-osaa-credentials',
      uid: 'llm-secret-uid', resourceVersion: '90210',
      labels: {
        'opensphere.io/part-of': 'opensphere-osaa',
        'opensphere.io/osaa-llm-key': 'true',
      },
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
      if (method === 'PATCH') {
        return {
          ok: true, status: 200,
          json: {
            ...secret,
            metadata: {
              ...secret.metadata, ...body.metadata, resourceVersion: '90211',
              annotations: { ...secret.metadata.annotations, ...body.metadata.annotations },
            },
          },
        };
      }
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
  await assert.rejects(instance.testLlmKey(actor({ assurance: 'aal1' }), 'primary', {}), { code: 403 });
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

test('LLM key rotation binds conflict read, UID, resourceVersion, exact bytes, and durable audit', async () => {
  const calls = [], audits = [], events = [];
  const input = {
    id: 'primary', provider: 'openai', displayName: 'Primary',
    apiKey: 'new-provider-secret', baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5', embeddingModel: '', enabled: true,
    reason: 'Rotate the reviewed primary provider credential',
  };
  const current = {
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
    metadata: {
      name: 'osaa-llm-primary', namespace: 'opensphere-osaa-credentials',
      uid: 'secret-uid-1', resourceVersion: '90',
      labels: {
        'opensphere.io/part-of': 'opensphere-osaa',
        'opensphere.io/osaa-llm-key': 'true',
      },
      annotations: {
        'opensphere.io/osaa-key-id': 'primary',
        'opensphere.io/osaa-validation-status': 'ready',
      },
    },
    data: { api_key: Buffer.from('old-provider-secret').toString('base64') },
  };
  const { instance } = apiWith({
    llmCredentialMutationEnabled: true,
    async auditMutation(_actor, event) {
      audits.push(event);
      events.push('audit:' + event.phase);
      return { requestId: event.requestId };
    },
    async k8s(method, resourcePath, body) {
      calls.push({ method, path: resourcePath, body });
      events.push('k8s:' + method.toLowerCase());
      if (method === 'POST') return { ok: false, status: 409, json: {} };
      if (method === 'GET') return { ok: true, status: 200, json: current };
      if (method === 'PATCH') {
        return {
          ok: true, status: 200,
          json: {
            ...current,
            metadata: {
              ...current.metadata, ...body.metadata, resourceVersion: '91',
              labels: { ...current.metadata.labels, ...body.metadata.labels },
              annotations: { ...current.metadata.annotations, ...body.metadata.annotations },
            },
            data: { api_key: Buffer.from(body.stringData.api_key).toString('base64') },
          },
        };
      }
      throw new Error('unexpected Kubernetes call');
    },
  });
  const result = await instance.upsertLlmKey(actor(), input);
  assert.equal(result.created, false);
  assert.equal(result.item.id, 'primary');
  assert.equal(result.item.validationStatus, 'untested');
  assert.equal(result.item.updatedBy, ACTOR_ID);
  assert.equal(JSON.stringify(result).includes(input.apiKey), false);
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET', 'PATCH']);
  assert.equal(calls[1].path,
    '/api/v1/namespaces/opensphere-osaa-credentials/secrets/osaa-llm-primary');
  assert.equal(calls[2].body.metadata.resourceVersion, '90');
  assert.equal(Object.hasOwn(calls[2].body.metadata, 'uid'), false);
  assert.equal(calls[2].body.metadata.annotations['opensphere.io/osaa-validation-status'], 'untested');
  assert.match(audits[0].payloadDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(audits).includes(input.apiKey), false);
  assert.deepEqual(audits.map((entry) => entry.phase), ['intent', 'applied']);
  assert.ok(events.indexOf('audit:intent') < events.indexOf('k8s:post'));
});

test('LLM key upsert is disabled by default and rejects foreign or stale Secret receipts', async () => {
  const input = {
    id: 'primary', provider: 'openai', displayName: 'Primary',
    apiKey: 'new-provider-secret', baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5', embeddingModel: '', enabled: true,
    reason: 'Rotate the reviewed primary provider credential',
  };
  const disabled = apiWith();
  await assert.rejects(disabled.instance.upsertLlmKey(actor(), input), {
    code: 503, errorCode: 'llm_credential_mutation_disabled',
  });
  assert.equal(disabled.k8sCalls.length, 0);
  assert.equal(disabled.auditCalls.length, 0);

  const foreignAudits = [], foreignCalls = [];
  const foreign = apiWith({
    llmCredentialMutationEnabled: true,
    async auditMutation(_actor, event) {
      foreignAudits.push(event);
      return { requestId: event.requestId };
    },
    async k8s(method, resourcePath, body) {
      foreignCalls.push({ method, resourcePath, body });
      if (method === 'POST') return { ok: false, status: 409, json: {} };
      return {
        ok: true, status: 200, json: {
          apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
          metadata: {
            name: 'osaa-llm-primary', namespace: 'opensphere-osaa-credentials',
            uid: 'foreign-uid', resourceVersion: '7',
            labels: { 'opensphere.io/osaa-llm-key': 'true' },
            annotations: { 'opensphere.io/osaa-key-id': 'primary' },
          },
        },
      };
    },
  });
  await assert.rejects(foreign.instance.upsertLlmKey(actor(), input), { code: 409 });
  assert.deepEqual(foreignCalls.map((call) => call.method), ['POST', 'GET']);
  assert.deepEqual(foreignAudits.map((entry) => entry.phase), ['intent', 'failed']);

  const staleAudits = [];
  const existing = {
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
    metadata: {
      name: 'osaa-llm-primary', namespace: 'opensphere-osaa-credentials',
      uid: 'secret-uid-1', resourceVersion: '7',
      labels: {
        'opensphere.io/part-of': 'opensphere-osaa',
        'opensphere.io/osaa-llm-key': 'true',
      },
      annotations: { 'opensphere.io/osaa-key-id': 'primary' },
    },
  };
  const stale = apiWith({
    llmCredentialMutationEnabled: true,
    async auditMutation(_actor, event) {
      staleAudits.push(event);
      return { requestId: event.requestId };
    },
    async k8s(method, _resourcePath, body) {
      if (method === 'POST') return { ok: false, status: 409, json: {} };
      if (method === 'GET') return { ok: true, status: 200, json: existing };
      return {
        ok: true, status: 200,
        json: {
          ...existing,
          metadata: {
            ...existing.metadata, ...body.metadata,
            labels: { ...existing.metadata.labels, ...body.metadata.labels },
            annotations: { ...existing.metadata.annotations, ...body.metadata.annotations },
          },
          data: { api_key: Buffer.from(body.stringData.api_key).toString('base64') },
        },
      };
    },
  });
  await assert.rejects(stale.instance.upsertLlmKey(actor(), input), { code: 409 });
  assert.deepEqual(staleAudits.map((entry) => entry.phase), ['intent', 'failed']);
});

test('LLM key deletion binds exact custody and UID/RV preconditions to observed absence', async () => {
  const calls = [], audits = [], events = [];
  const current = {
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
    metadata: {
      name: 'osaa-llm-primary', namespace: 'opensphere-osaa-credentials',
      uid: 'secret-uid-1', resourceVersion: '77',
      labels: {
        'opensphere.io/part-of': 'opensphere-osaa',
        'opensphere.io/osaa-llm-key': 'true',
      },
      annotations: { 'opensphere.io/osaa-key-id': 'primary' },
    },
  };
  let reads = 0;
  const { instance } = apiWith({
    llmCredentialDeletionEnabled: true,
    async auditMutation(_actor, event) {
      audits.push(event);
      events.push('audit:' + event.phase);
      return { requestId: event.requestId };
    },
    async k8s(method, resourcePath, body) {
      calls.push({ method, path: resourcePath, body });
      events.push('k8s:' + method.toLowerCase());
      if (method === 'GET' && reads++ === 0) return { ok: true, status: 200, json: current };
      if (method === 'DELETE') {
        return {
          ok: true, status: 200,
          json: {
            apiVersion: 'v1', kind: 'Status', status: 'Success',
            details: { name: 'osaa-llm-primary', uid: 'secret-uid-1' },
          },
        };
      }
      if (method === 'GET') return { ok: false, status: 404, json: null };
      throw new Error('unexpected Kubernetes call');
    },
  });
  const result = await instance.deleteLlmKey(actor(), 'primary', {
    reason: 'Remove the compromised primary provider credential',
    confirmation: 'delete LLM key primary',
  });
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'DELETE', 'GET']);
  assert.deepEqual(calls[1].body, {
    apiVersion: 'v1', kind: 'DeleteOptions',
    preconditions: { uid: 'secret-uid-1', resourceVersion: '77' },
  });
  assert.equal(result.deleted, true);
  assert.equal(result.id, 'primary');
  assert.deepEqual(audits.map((entry) => entry.phase), ['intent', 'applied']);
  assert.ok(events.indexOf('audit:intent') < events.indexOf('k8s:delete'));
});

test('LLM key deletion is disabled by default and refuses replacement races', async () => {
  const disabled = apiWith();
  await assert.rejects(disabled.instance.deleteLlmKey(actor(), 'primary', {
    reason: 'Remove the compromised primary provider credential',
    confirmation: 'delete LLM key primary',
  }), { code: 503, errorCode: 'llm_credential_deletion_disabled' });
  assert.equal(disabled.k8sCalls.length, 0);

  const audits = [];
  const current = {
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
    metadata: {
      name: 'osaa-llm-primary', namespace: 'opensphere-osaa-credentials',
      uid: 'secret-uid-1', resourceVersion: '77',
      labels: {
        'opensphere.io/part-of': 'opensphere-osaa',
        'opensphere.io/osaa-llm-key': 'true',
      },
      annotations: { 'opensphere.io/osaa-key-id': 'primary' },
    },
  };
  let reads = 0;
  const raced = apiWith({
    llmCredentialDeletionEnabled: true,
    async auditMutation(_actor, event) {
      audits.push(event);
      return { requestId: event.requestId };
    },
    async k8s(method) {
      if (method === 'GET' && reads++ === 0) return { ok: true, status: 200, json: current };
      if (method === 'DELETE') {
        return {
          ok: true, status: 200,
          json: {
            apiVersion: 'v1', kind: 'Status', status: 'Success',
            details: { name: 'osaa-llm-primary', uid: 'secret-uid-1' },
          },
        };
      }
      return {
        ok: true, status: 200,
        json: { ...current, metadata: { ...current.metadata, uid: 'replacement-uid', resourceVersion: '1' } },
      };
    },
  });
  await assert.rejects(raced.instance.deleteLlmKey(actor(), 'primary', {
    reason: 'Remove the compromised primary provider credential',
    confirmation: 'delete LLM key primary',
  }), { code: 409 });
  assert.deepEqual(audits.map((entry) => entry.phase), ['intent', 'failed']);
});

test('C_AI owner projections fail closed on oversized bytes and ignored list limits', async () => {
  const oversized = apiWith({ values: {
    c_ai_list_module_operations: [operationRow({ result: { output: 'x'.repeat(1024 * 1024) } })],
  } });
  await assert.rejects(oversized.instance.listOperations(), {
    code: 503, errorCode: 'c_ai_owner_projection_invalid',
  });

  const overLimit = apiWith({ values: {
    c_ai_list_module_operations: Array.from({ length: 3 }, () => operationRow()),
  } });
  await assert.rejects(overLimit.instance.listOperations('2'), {
    code: 503, errorCode: 'c_ai_owner_projection_invalid',
  });
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
  assert.match(server,
    /OSAA_LLM_CREDENTIAL_MUTATION_ENABLED = process\.env\.OSAA_LLM_CREDENTIAL_MUTATION_ENABLED === 'true'/u);
  assert.match(server,
    /OSAA_LLM_CREDENTIAL_DELETION_ENABLED = process\.env\.OSAA_LLM_CREDENTIAL_DELETION_ENABLED === 'true'/u);
  assert.match(server,
    /options: `-c role=opensphere_osaa_gateway -c search_path=\$\{PG\.schema\},extensions,public`/u);
  assert.match(server,
    /set_evidence_retention_policy\(\$1, \$2, \$3, \$4, \$5::uuid, \$6, \$7::uuid\)/u);
  assert.match(owner, /deployments.*encodeURIComponent\(dialogueDeployment\)/u);
  assert.match(owner, /secrets.*osaa-llm-/u);
  assert.match(owner, /llmCredentialMutationEnabled = false/u);
  assert.match(owner, /llmCredentialDeletionEnabled = false/u);
  assert.match(owner, /kind: 'DeleteOptions'[\s\S]+preconditions: \{ uid: binding\.uid, resourceVersion: binding\.resourceVersion \}/u);
  assert.match(server, /llmCredentialMutationEnabled: OSAA_LLM_CREDENTIAL_MUTATION_ENABLED/u);
  assert.match(server, /llmCredentialDeletionEnabled: OSAA_LLM_CREDENTIAL_DELETION_ENABLED/u);
  assert.doesNotMatch(server, /assertMutationEnabled\(actor, 'llm-key-(?:upsert|delete)'\)/u);
  assert.match(server, /assertMutationEnabled\(actor, 'k8s-restart-deployment'\)/u);
  assert.doesNotMatch(owner + server,
    /console-api[\\/]runtime|r2d2-remediation-api|r2d2-operation-api/u);
  assert.match(identity, /x-os-owner-csrf-verified/u);
  assert.match(docker, /COPY c-ai-owner-api\.js \/app\/c-ai-owner-api\.js/u);
});
