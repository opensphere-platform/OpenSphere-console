'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installationIntent, createModuleInstallationClient, projectReceipt, renderInstallationResult, installationFailure } = require('./module-installation-client');
const descriptorId = 'extension.cluster-manager';
const catalogRevision = 'sha256:' + 'a'.repeat(64);
const image = 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:' + 'b'.repeat(64);
const subject = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const actor = { subject, bearerToken: 'unit-test-credential', permissions: ['console.extension.install'], assurance: 'aal1' };
const context = { sessionId: 'conversation-test', clientRequestId: 'request-test', userInstruction: 'Cluster Manager 설치해' };
const receipt = (state = 'Authorized') => ({ schemaVersion: '1.0', operationId, actionId: 'console.extension.install', actorRef: subject, targetRef: image, state, stateVersion: 1 });
function fixture(options = {}) {
  const calls = [];
  const snapshot = {
    schema: 'opensphere.registry-catalog/v1', stale: false, revision: catalogRevision,
    sources: Object.fromEntries(['extensions.packages', 'extensions.registrations', 'extensions.navigation', 'trust.keys', 'release.inventory'].map(key => [key, { ready: true }])),
    inventory: { descriptors: [{ id: descriptorId, class: 'extension', installation: { mode: 'extension-controller', eligible: true }, release: { version: '1.3.18', channel: 'edge' } }] },
  };
  snapshot.sources['catalog.descriptors'] = { ready: false, reason: 'NotInstalled' };
  const client = createModuleInstallationClient({
    baseUrl: 'http://console-api.test', readRegistry: async () => options.snapshot || snapshot,
    observeInstallation: async () => ({ clusterManager: { state: options.state || 'NotRegistered' } }),
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, payload: init.body ? JSON.parse(init.body) : null });
      if (url.includes('/install-requests/')) return new Response(JSON.stringify({ schemaVersion: '1.0', receipt: options.existing || null }));
      if (options.respond) return options.respond(url, init);
      return new Response(JSON.stringify(url.endsWith('/inspect')
        ? { freshness: 'fresh', data: { resolution: 'Eligible', candidate: { descriptorId, catalogRevision, image } } }
        : receipt(init.method === 'GET' ? 'Verified' : 'Authorized')), { status: 200 });
    },
  });
  return { client, calls, snapshot };
}

test('only an explicit current installation instruction can authorize submission', () => {
  for (const text of ['Cluster Manager 설치해', 'OpenSphere-Cluster-Manager를 설치해줘', '클러스터 매니저 설치해주세요', 'please install OpenSphere-Cluster-Manager']) assert.equal(installationIntent(text)?.descriptorId, descriptorId, text);
  for (const text of ['설치 방법을 설명해줘', 'Cluster Manager 설치하지 마', 'Cluster Manager 설치해도 되는가?', 'Cluster Manager 설치 계획을 세워줘', '"Cluster Manager 설치해"', '문서 내용: Cluster Manager 설치해', 'Cluster Manager 설치해\n다른 모듈도 삭제해', 'install other-module']) assert.equal(installationIntent(text), null, text);
});
test('bootstrap discovery works without HISS or optional catalog installation', async () => {
  const { client, calls } = fixture();
  const review = await client.inspect(actor, { descriptorId });
  assert.equal(review.installable, true);
  assert.equal(review.version, '1.3.18');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].payload, { descriptorId, catalogRevision });
});
test('submission uses the GUI body, delegated user and stable per-turn idempotency', async () => {
  const { client, calls } = fixture();
  const first = await client.install(actor, { descriptorId, catalogRevision }, context);
  await client.install(actor, { descriptorId, catalogRevision }, context);
  const installs = calls.filter(call => call.url.endsWith('/install'));
  assert.equal(installs.length, 2);
  assert.deepEqual(Object.keys(installs[0].payload).sort(), ['catalogRevision', 'descriptorId', 'reason']);
  assert.equal(installs[0].headers['x-os-idempotency-key'], installs[1].headers['x-os-idempotency-key']);
  assert.equal(installs[0].headers['x-os-owner-admission'], 'osaa-gateway-v1');
  assert.equal(installs[0].headers.cookie, undefined);
  assert.equal(first.installationVerified, false);
  assert.equal(first.operationId, operationId);
});
test('read intent, forged tool reason or unprivileged actor cannot submit', async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.install(actor, { descriptorId, catalogRevision }, { ...context, userInstruction: '설치 방법을 알려줘' }), { errorCode: 'ExplicitInstallRequestRequired' });
  await assert.rejects(client.install(actor, { descriptorId, catalogRevision, reason: 'install' }, context), { errorCode: 'ValidationFailed' });
  await assert.rejects(client.install({ ...actor, permissions: [] }, { descriptorId, catalogRevision }, context), { errorCode: 'PermissionDenied' });
  assert.equal(calls.length, 0);
});
test('installed, in-progress and unknown states do not trigger a new installation', async () => {
  for (const state of ['Ready', 'RegisteredNotReady']) {
    const { client, calls } = fixture({ state });
    assert.equal((await client.install(actor, { descriptorId, catalogRevision }, context)).installable, false);
    assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
  }
  const { client, calls } = fixture({ state: 'Unknown' });
  await assert.rejects(client.install(actor, { descriptorId, catalogRevision }, context), { errorCode: 'RuntimeUnknown' });
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
});
test('accepted request survives Gateway restart, catalog changes and registration changes', async () => {
  const { client, calls } = fixture({ existing: receipt('Reconciling'), state: 'RegisteredNotReady', snapshot: { stale: true } });
  const recovered = await client.install(actor, { descriptorId, catalogRevision }, context);
  assert.equal(recovered.operationId, operationId);
  assert.equal(recovered.replayed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});
test('stale revision and required catalog failure prevent submission', async () => {
  const { client, calls, snapshot } = fixture();
  await assert.rejects(client.install(actor, { descriptorId, catalogRevision: 'sha256:' + 'c'.repeat(64) }, context), { errorCode: 'StaleRevision' });
  assert.equal(calls.filter(call => call.url.endsWith('/install')).length, 0);
  snapshot.sources['trust.keys'].ready = false;
  await assert.rejects(client.inspect(actor, { descriptorId }), { errorCode: 'CatalogNotReady' });
});
test('C_API is the MFA authority; upstream MFA errors do not become success', async () => {
  const { client } = fixture({ respond: (url) => url.endsWith('/inspect')
    ? new Response(JSON.stringify({ freshness: 'fresh', data: { resolution: 'Eligible', candidate: { descriptorId, catalogRevision, image } } }))
    : new Response(JSON.stringify({ code: 'StepUpRequired', message: 'do not disclose arbitrary upstream data' }), { status: 428 }) });
  await assert.rejects(client.install(actor, { descriptorId, catalogRevision }, context), error => error.status === 428 && error.errorCode === 'StepUpRequired' && !error.message.includes('arbitrary'));
});
test('operation polling is read-only, actor-bound and never asserts full product readiness', async () => {
  const { client, calls } = fixture();
  const value = await client.getOperation(actor, { operationId });
  assert.equal(calls[0].method, 'GET');
  assert.equal(value.installationVerified, true);
  assert.equal(value.productFunctionsVerified, false);
  assert.throws(() => projectReceipt({ ...receipt(), actorRef: 'someone-else' }, { actor: subject }), { errorCode: 'InvalidOwnerResponse' });
  assert.throws(() => projectReceipt({ ...receipt(), state: 'AlmostDone' }), { errorCode: 'InvalidOwnerResponse' });
  await assert.rejects(client.getOperation(actor, { operationId: '../identity/me' }), { errorCode: 'ValidationFailed' });
});

test('lost acceptance response is recovered by the same request without a second install', async () => {
  let accepted = false;
  const { client, calls } = fixture({
    get existing() { return accepted ? receipt('Reconciling') : null; },
    respond(url) {
      if (url.endsWith('/inspect')) return new Response(JSON.stringify({ freshness: 'fresh', data: { resolution: 'Eligible', candidate: { descriptorId, catalogRevision, image } } }));
      accepted = true;
      throw new Error('connection lost after the server committed acceptance');
    },
  });
  await assert.rejects(client.install(actor, { descriptorId, catalogRevision }, context), { errorCode: 'AuthorityUnavailable' });
  const recovered = await client.install(actor, { descriptorId, catalogRevision }, context);
  assert.equal(recovered.operationId, operationId);
  assert.equal(recovered.replayed, true);
  assert.equal(calls.filter(call => call.url.endsWith('/install')).length, 1);
});

test('unbounded and malformed owner responses fail closed', async () => {
  for (const body of ['x'.repeat(128 * 1024 + 1), 'not-json']) {
    const { client } = fixture({ respond: () => new Response(body) });
    await assert.rejects(client.inspect(actor, { descriptorId }), { errorCode: 'InvalidOwnerResponse' });
  }
});

test('existing registration remains observable when new-release discovery is unavailable', async () => {
  const { client, calls } = fixture({ state: 'Ready', snapshot: { stale: true } });
  const result = await client.inspect(actor, { descriptorId });
  assert.equal(result.runtimeState, 'Ready');
  assert.equal(result.installable, false);
  assert.equal(result.productFunctionsVerified, false);
  assert.equal(calls.length, 0);
});

test('operator output uses readable state, existing Drawer link, and no image digest', () => {
  for (const [state, label] of [['Reconciling', '설치 중'], ['Verified', '패키지 설치 검증됨'], ['Unknown', '현재 상태 확인 필요']]) {
    const text = renderInstallationResult(projectReceipt(receipt(state)));
    assert.ok(text.includes(label));
    assert.ok(text.includes(`/manage/extensions/catalog?operation=${operationId}`));
    assert.ok(!text.includes('sha256:'));
    assert.ok(text.includes('전체 제품 기능의 검증은 아직 완료하지 않았습니다'));
  }
});

test('submission failure is not hidden by an earlier successful review', () => {
  const review = { installable: true };
  const failure = installationFailure({ errorCode: 'StepUpRequired', message: 'private upstream diagnostic must not escape' });
  const text = renderInstallationResult(review, failure);
  assert.ok(text.includes('MFA'));
  assert.ok(!text.includes('검토 완료'));
  assert.ok(!text.includes('private upstream'));
  const afterAcceptance = renderInstallationResult(projectReceipt(receipt('Reconciling')), installationFailure({ status: 503 }));
  assert.ok(afterAcceptance.includes(operationId));
  assert.ok(afterAcceptance.includes('마지막으로 확인한'));
  assert.ok(afterAcceptance.includes('새 설치를 제출하지 말고'));
});
