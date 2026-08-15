'use strict';
const assert = require('node:assert/strict');
const { generateKeyPairSync, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');
const { browserFrame, createControl, delegatedCredential, exactBinding, runtimeCertificatePinned,
  probeTlsDependencyReadiness, runtimeFrame, validatedRuntimePublicKey } = require('./server');

const REVISION = `sha256:${'1'.repeat(64)}`;
const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
function config(mode, overrides = {}) {
  return { mode, enabled: true, attachEnabled: mode === 'gateway', reconcilerEnabled: mode === 'reconciler',
    registrationEnabled: false, runtimeControlEnabled: false, allowLoopbackHttp: false, port: 0,
    worker: 'worker-a', namespace: 'opensphere-shell-sessions', runtimeServiceAccount: 'opensphere-shell-runtime',
    runtimeImage: `ghcr.io/opensphere-platform/opensphere-os-shell-runtime@sha256:${'2'.repeat(64)}`,
    runtimeImageDigest: `sha256:${'2'.repeat(64)}`, osArtifactDigest: `sha256:${'3'.repeat(64)}`,
    manifestSha256: `sha256:${'4'.repeat(64)}`, releaseEvidenceRef: 'release://test', releaseKeyId: 'test-key',
    sessionPolicyRevision: 'policy-v1', runtimeTemplateRevision: 'template-v1', admissionSecret: 'a'.repeat(32),
    delegationSecret: 'd'.repeat(32), registrationURL: 'https://opensphere-shell-reconciler.opensphere-console.svc.cluster.local:8443/internal/runtime/register',
    runtimeControlURL: 'https://opensphere-shell-api.opensphere-console.svc.cluster.local:8443/api/os-shell/runtime',
    consoleAPIURL: 'https://opensphere-shell-console-api.opensphere-console.svc.cluster.local:8445',
    consoleAPIReadinessURL: 'https://opensphere-shell-console-api.opensphere-console.svc.cluster.local:8445/readyz',
    consoleBackendURL: 'https://opensphere-shell-credential-authority.opensphere-console.svc.cluster.local:8444', internalCAFile: 'unused',
    credentialAuthorityReadinessURL: 'https://opensphere-shell-credential-authority.opensphere-console.svc.cluster.local:8444/readyz',
    gatewayReadinessURL: 'http://opensphere-shell-gateway.opensphere-console.svc.cluster.local:8080/readyz',
    reconcilerReadinessURL: 'http://opensphere-shell-reconciler.opensphere-console.svc.cluster.local:8080/readyz',
    tlsCertFile: 'unused', tlsKeyFile: 'unused', ...overrides };
}
function row(overrides = {}) {
  return { session_id: SESSION_ID, actor_id: ACTOR_ID, origin: 'https://console.example.test',
    session_class: 'operator-interactive', runtime_adapter_id: 'cbss.kubernetes-pod', network_profile: 'console-only',
    runtime_uid: 'pod-uid-1', permission_revision: REVISION, aal: 'aal2', release_evidence_ref: 'release://test',
    generation: 1, fencing_epoch: 2, desired_state: 'Running', observed_state: 'Provisioning',
    absolute_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), idle_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    runtime_resource_version: '9', runtime_projection_started_at: new Date().toISOString(), runtime_registered_at: null, ...overrides };
}
function request(body, { url = '/internal/runtime/register', encrypted = true, headers = {} } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]); req.method = 'POST'; req.url = url;
  req.headers = headers; req.socket = { encrypted }; return req;
}
function response() {
  return { statusCode: 0, headers: {}, body: '', writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; },
    end(data = '') { this.body += String(data); } };
}

test('gateway converts closed browser frames and enforces sequence/rate/resize bounds', () => {
  const rate = { started: Date.now(), frames: 0, bytes: 0 };
  assert.deepEqual(browserFrame({ type: 'resize', sequence: 1, cols: 80, rows: 24 }, 0, rate), { type: 'resize', seq: 1, columns: 80, rows: 24 });
  assert.throws(() => browserFrame({ type: 'resize', sequence: 2, cols: 80, rows: 1 }, 1, rate), /contract/);
  assert.throws(() => browserFrame({ type: 'stdin', sequence: 1, data: 'x' }, 1, rate), /non-monotonic/);
  const limited = { started: Date.now(), frames: 0, bytes: 65530 };
  assert.throws(() => browserFrame({ type: 'stdin', sequence: 2, data: '12345678' }, 1, limited), /rate/);
});

test('gateway converts bounded monotonic runtime frames', () => {
  assert.deepEqual(runtimeFrame({ type: 'attached', seq: 1 }, 0, 'session'), { type: 'attached', sequence: 1, sessionId: 'session' });
  assert.deepEqual(runtimeFrame({ type: 'stdout', seq: 2, data: Buffer.from('ok').toString('base64') }, 1, 'session'), { type: 'stdout', sequence: 2, data: 'ok' });
  assert.throws(() => runtimeFrame({ type: 'pong', seq: 1 }, 1, 'session'), /non-monotonic/);
});

test('runtime registration accepts exactly one Ed25519 PEM bound to canonical kid', () => {
  const { publicKey } = generateKeyPairSync('ed25519'); const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const jwk = publicKey.export({ format: 'jwk' }); const kid = createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('base64url');
  assert.equal(validatedRuntimePublicKey(pem, kid), kid);
  assert.throws(() => validatedRuntimePublicKey(pem, `${kid.slice(0, -1)}x`), /key ID/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => validatedRuntimePublicKey(rsa, kid), /Ed25519/);
  assert.throws(() => validatedRuntimePublicKey(`${pem}${pem}`, kid), /PEM/);
});

test('runtime binding schema is closed and independent of JSON key order', () => {
  const value = row(); const binding = Object.fromEntries(Object.entries({ fencingEpoch: 2, generation: 1, releaseEvidenceRef: 'release://test',
    aal: 'aal2', permissionRevision: REVISION, runtimeUid: 'pod-uid-1', networkProfile: 'console-only',
    runtimeAdapterId: 'cbss.kubernetes-pod', sessionClass: 'operator-interactive', origin: 'https://console.example.test',
    actorId: ACTOR_ID, sessionId: SESSION_ID }));
  assert.equal(exactBinding(value, binding), true);
  assert.equal(exactBinding(value, { ...binding, unexpected: true }), false);
  assert.equal(exactBinding(value, { ...binding, generation: '1' }), false);
});

test('runtime TLS fingerprint is exact and credential authority uses only trusted TLS 1.3 with SNI', async () => {
  const certificate = Buffer.from('certificate-der'); const fingerprint = `sha256:${createHash('sha256').update(certificate).digest('hex')}`;
  assert.equal(runtimeCertificatePinned(certificate, fingerprint), true);
  assert.equal(runtimeCertificatePinned(Buffer.from('other'), fingerprint), false);
  assert.equal(runtimeCertificatePinned(certificate, fingerprint.toUpperCase()), false);
  let observed;
  const trustedRequest = (url, options, callback) => {
    observed = { url, options }; const exchange = new EventEmitter(); exchange.setTimeout = () => {}; exchange.destroy = (error) => exchange.emit('error', error);
    exchange.end = () => { const response = new EventEmitter(); response.statusCode = 200; callback(response);
      process.nextTick(() => { response.emit('data', Buffer.from(JSON.stringify({ accessToken: 'agent-only', tokenExpiresAt: new Date(Date.now() + 60_000).toISOString() })));
        response.emit('end'); }); }; return exchange;
  };
  const result = await delegatedCredential(config('api'), { sessionId: SESSION_ID }, 'context', { request: trustedRequest, readCA: () => Buffer.from('local-ca') });
  assert.equal(result.accessToken, 'agent-only'); assert.equal(observed.url.hostname, 'opensphere-shell-credential-authority.opensphere-console.svc.cluster.local');
  assert.equal(observed.options.rejectUnauthorized, true); assert.equal(observed.options.minVersion, 'TLSv1.3');
  assert.equal(observed.options.servername, observed.url.hostname); assert.deepEqual(observed.options.ca, Buffer.from('local-ca'));
  const untrustedRequest = () => { const exchange = new EventEmitter(); exchange.setTimeout = () => {}; exchange.destroy = (error) => exchange.emit('error', error);
    exchange.end = () => process.nextTick(() => exchange.emit('error', Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })));
    return exchange; };
  await assert.rejects(() => delegatedCredential(config('api'), {}, 'context', { request: untrustedRequest, readCA: () => Buffer.from('wrong-ca') }),
    { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
});

test('dependency readiness requires trusted TLS 1.3, exact SNI and the expected service contract', async () => {
  let observed;
  const trustedRequest = (url, options, callback) => {
    observed = { url, options }; const probe = new EventEmitter(); probe.setTimeout = () => {};
    probe.destroy = (error) => probe.emit('error', error); probe.end = () => { const response = new EventEmitter(); response.statusCode = 200; callback(response);
      process.nextTick(() => { response.emit('data', Buffer.from(JSON.stringify({ ready: true, service: 'opensphere-shell-credential-authority' })));
        response.emit('end'); }); }; return probe;
  };
  const ready = await probeTlsDependencyReadiness(config('api').credentialAuthorityReadinessURL,
    'opensphere-shell-credential-authority', config('api'), { request: trustedRequest, readCA: () => Buffer.from('local-ca') });
  assert.equal(ready, true); assert.equal(observed.options.minVersion, 'TLSv1.3'); assert.equal(observed.options.rejectUnauthorized, true);
  assert.equal(observed.options.servername, observed.url.hostname); assert.deepEqual(observed.options.ca, Buffer.from('local-ca'));
  const wrongServiceRequest = (_url, _options, callback) => { const probe = new EventEmitter(); probe.setTimeout = () => {}; probe.destroy = () => {};
    probe.end = () => { const response = new EventEmitter(); response.statusCode = 200; callback(response); process.nextTick(() => {
      response.emit('data', Buffer.from(JSON.stringify({ ready: true, service: 'wrong-service' }))); response.emit('end'); }); }; return probe; };
  assert.equal(await probeTlsDependencyReadiness(config('api').credentialAuthorityReadinessURL,
    'opensphere-shell-credential-authority', config('api'), { request: wrongServiceRequest, readCA: () => Buffer.from('local-ca') }), false);
});

test('registration is Pending-409, then exact Provisioning replay succeeds while changed hash, UID and epoch fail closed', async () => {
  const keys = generateKeyPairSync('ed25519'); const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const jwk = keys.publicKey.export({ format: 'jwk' }); const keyId = createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('base64url');
  let registrationState = 'Pending'; let acceptedHash = null; let registerCalls = 0; const authority = row();
  const database = {
    classifyRuntimeRegistration: async () => ({ ...authority, observed_state: registrationState }),
    registerRuntime: async (input) => {
      registerCalls += 1;
      if (acceptedHash && acceptedHash !== input.runtimeCredentialHash) throw Object.assign(new Error('runtime registration replay changed immutable binding'), { code: '40001' });
      acceptedHash ||= input.runtimeCredentialHash;
      return { ...authority, runtime_credential_expires_at: input.runtimeCredentialExpiresAt };
    },
  };
  const pod = { metadata: { name: 'runtime-pod', uid: 'pod-uid-1', resourceVersion: '9', labels: {
    'opensphere.io/session-id': SESSION_ID, 'opensphere.io/generation': '1', 'opensphere.io/fencing-epoch': '2' } }, status: { podIP: '10.0.0.8' } };
  const kubernetes = { tokenReview: async () => ({ status: { authenticated: true, audiences: ['opensphere-shell-runtime-bootstrap'],
    user: { username: 'system:serviceaccount:opensphere-shell-sessions:opensphere-shell-runtime', extra: {
      'authentication.kubernetes.io/pod-name': ['runtime-pod'], 'authentication.kubernetes.io/pod-uid': ['pod-uid-1'] } } } }), getPod: async () => pod };
  const control = createControl({ config: config('reconciler', { registrationEnabled: true }), database, kubernetes, internalServerFactory: () => null });
  const binding = { sessionId: SESSION_ID, actorId: ACTOR_ID, origin: authority.origin, sessionClass: authority.session_class,
    runtimeAdapterId: authority.runtime_adapter_id, networkProfile: authority.network_profile, runtimeUid: authority.runtime_uid,
    permissionRevision: REVISION, aal: 'aal2', releaseEvidenceRef: authority.release_evidence_ref, generation: 1, fencingEpoch: 2 };
  const body = { contract: 'opensphere-shell-runtime/v1', binding, keyId, publicKeyPem,
    tlsCertificateSha256: `sha256:${'a'.repeat(64)}`, runtimeCredentialHash: `sha256:${'b'.repeat(64)}`,
    runtimeVersion: 'test', attachEndpoint: 'wss://untrusted.example/ignored' };
  const invoke = (value) => control.testContract.registerRuntime(request(value, { headers: { authorization: 'Bearer bootstrap' } }), response());
  await assert.rejects(() => invoke(body), { status: 409, message: 'RuntimeRegistrationNotReady' });
  registrationState = 'Provisioning';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = response(); await control.testContract.registerRuntime(request(body, { headers: { authorization: 'Bearer bootstrap' } }), res);
    assert.equal(res.statusCode, 200); const output = JSON.parse(res.body); assert.deepEqual(output.binding, binding);
    assert.equal(output.runtimeCredentialHash, body.runtimeCredentialHash);
  }
  await assert.rejects(() => invoke({ ...body, runtimeCredentialHash: `sha256:${'c'.repeat(64)}` }), { status: 403 });
  await assert.rejects(() => invoke({ ...body, binding: { ...binding, runtimeUid: 'other-uid' } }), { status: 403 });
  await assert.rejects(() => invoke({ ...body, binding: { ...binding, fencingEpoch: 3 } }), { status: 403 });
  assert.equal(registerCalls, 3);
});

test('reconciler deletes an exact owned orphan after create/transition loss and recreates it at the claimed fence', async () => {
  const pending = row({ observed_state: 'Pending', runtime_uid: null, runtime_resource_version: null, runtime_projection_started_at: null });
  let claims = 0; let creates = 0; const deleted = []; const transitions = [];
  const database = { claimSessions: async () => claims++ === 0 ? [pending] : [], transitionSession: async (input) => {
    transitions.push(input); return { ...pending, observed_state: 'Provisioning', runtime_uid: input.runtimeUid,
      runtime_resource_version: input.runtimeResourceVersion, runtime_projection_started_at: new Date().toISOString() };
  } };
  const kubernetes = { listPods: async () => ({ items: [] }), createPod: async () => { creates += 1; if (creates === 1) throw Object.assign(new Error('exists'), { status: 409 });
    return { metadata: { uid: 'fresh-uid', resourceVersion: '10' } }; },
  getPod: async () => ({ metadata: { name: 'os-shell-10000000000040008000', uid: 'orphan-uid', labels: { 'opensphere.io/session-id': SESSION_ID,
    'opensphere.io/generation': '1', 'opensphere.io/fencing-epoch': '1' } } }),
  deletePod: async (_ns, _name, uid) => { deleted.push(uid); } };
  const control = createControl({ config: config('reconciler'), database, kubernetes }); await control.tick();
  assert.equal(creates, 2); assert.deepEqual(deleted, ['orphan-uid']); assert.equal(transitions[0].expectedState, 'Pending');
  assert.equal(transitions[0].runtimeUid, 'fresh-uid');
});

test('reclaimed Ready runtime is UID-precondition deleted, reprojected with a new generation, and recreated', async () => {
  const ready = row({ observed_state: 'Ready', runtime_registered_at: new Date().toISOString() }); let claims = 0; const actions = [];
  const database = { claimSessions: async () => claims++ === 0 ? [ready] : [], reprojectRuntime: async (input) => {
    actions.push(['reproject', input.expectedRuntimeUid]); return row({ observed_state: 'Pending', generation: 2, fencing_epoch: 3,
      runtime_uid: null, runtime_resource_version: null, runtime_projection_started_at: null }); },
  transitionSession: async (input) => { actions.push(['transition', input.generation, input.runtimeUid]); return row({ observed_state: 'Provisioning',
    generation: input.generation, fencing_epoch: input.fencingEpoch, runtime_uid: input.runtimeUid, runtime_resource_version: input.runtimeResourceVersion }); } };
  const kubernetes = { listPods: async () => ({ items: [] }), getPod: async () => ({ metadata: { name: 'runtime', uid: 'pod-uid-1', labels: { 'opensphere.io/session-id': SESSION_ID } } }),
    deletePod: async (_ns, _name, uid) => { actions.push(['delete', uid]); },
    createPod: async (_ns, pod) => { actions.push(['create', pod.metadata.labels['opensphere.io/generation'], pod.metadata.labels['opensphere.io/fencing-epoch']]);
      return { metadata: { uid: 'pod-uid-2', resourceVersion: '10' } }; } };
  const control = createControl({ config: config('reconciler'), database, kubernetes }); await control.tick();
  assert.deepEqual(actions, [['delete', 'pod-uid-1'], ['reproject', 'pod-uid-1'], ['create', '2', '3'], ['transition', 2, 'pod-uid-2']]);
});

test('expired authority is converted to teardown and the exact runtime UID is deleted', async () => {
  const expired = row({ observed_state: 'Ready', runtime_registered_at: new Date().toISOString(),
    idle_expires_at: new Date(Date.now() - 1000).toISOString() }); const actions = [];
  const database = { revokeSessionAuthority: async (input) => { actions.push(['revoke', input.reasonCode]); return { ...expired, desired_state: 'Terminated' }; },
    transitionSession: async (input) => { actions.push(['transition', input.expectedState, input.nextState]);
      return { ...expired, desired_state: 'Terminated', observed_state: input.nextState }; } };
  const kubernetes = { deletePod: async (_namespace, _name, uid) => { actions.push(['delete', uid]); } };
  const control = createControl({ config: config('reconciler'), database, kubernetes });
  await control.testContract.reconcile(expired, false);
  assert.deepEqual(actions, [['revoke', 'SessionExpired'], ['transition', 'Ready', 'Terminating'], ['delete', 'pod-uid-1'], ['transition', 'Terminating', 'Terminated']]);
});

test('internal runtime paths are never served by the plaintext browser listener and browser paths are rejected on the internal listener', async () => {
  const control = createControl({ config: config('api', { runtimeControlEnabled: true }), database: {}, internalServerFactory: () => null });
  for (const [url, encrypted] of [['/api/os-shell/runtime/revalidate', false], ['/api/os-shell/readiness', true]]) {
    const req = request({}, { url, encrypted, headers: {} }); const res = response(); await control.testContract.handler(req, res);
    assert.equal(res.statusCode, 404);
  }
});

test('browser readiness projects gateway and reconciler state and fails closed when either component is unavailable', async () => {
  const observedModes = [];
  const control = createControl({ config: config('api'), database: {
    currentPermissionRevision: async () => REVISION,
  }, componentReadinessProbe: async (_target, mode) => { observedModes.push(mode); return mode === 'gateway'; },
  dependencyReadinessProbe: async () => true });
  const req = request({}, { url: '/api/os-shell/readiness', encrypted: false }); req.method = 'GET';
  const res = response();
  await control.testContract.browserApi(req, res, '/api/os-shell/readiness', { sub: ACTOR_ID, permissionRevision: REVISION });
  assert.equal(res.statusCode, 200); const body = JSON.parse(res.body);
  assert.equal(body.readiness.ready, false);
  assert.deepEqual(body.readiness.components, { gateway: true, reconciler: false, credentialAuthority: true, consoleApi: true });
  assert.equal(body.readiness.blocker.code, 'ShellReconcilerUnavailable');
  assert.deepEqual(observedModes.sort(), ['gateway', 'reconciler']);
  assert.equal(body.readiness.release.manifestSha256, config('api').manifestSha256);
  assert.equal(body.readiness.release.runtimeTemplateRevision, config('api').runtimeTemplateRevision);
});

test('API readyz requires database plus exact-release gateway and reconciler readiness', async () => {
  let reconcilerReady = false;
  const control = createControl({ config: config('api'), database: { health: async (mode) => mode === 'api' },
    componentReadinessProbe: async (_target, mode) => mode === 'gateway' || reconcilerReady,
    dependencyReadinessProbe: async () => true });
  const invoke = async () => { const req = request({}, { url: '/readyz', encrypted: false }); req.method = 'GET';
    const res = response(); await control.testContract.handler(req, res); return { status: res.statusCode, body: JSON.parse(res.body) }; };
  const unavailable = await invoke(); assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.blocker.code, 'ShellReconcilerUnavailable');
  reconcilerReady = true; const ready = await invoke(); assert.equal(ready.status, 200);
  assert.deepEqual(ready.body.components, { gateway: true, reconciler: true, credentialAuthority: true, consoleApi: true });
  assert.equal(ready.body.release.runtimeImageDigest, config('api').runtimeImageDigest);
});

test('API readiness fails closed when credential authority or canonical Console API TLS frontdoor is unavailable', async () => {
  let consoleApiReady = false;
  const control = createControl({ config: config('api'), database: { health: async () => true },
    componentReadinessProbe: async () => true,
    dependencyReadinessProbe: async (_target, service) => service === 'opensphere-shell-credential-authority' || consoleApiReady });
  const invoke = async () => { const req = request({}, { url: '/readyz', encrypted: false }); req.method = 'GET';
    const res = response(); await control.testContract.handler(req, res); return { status: res.statusCode, body: JSON.parse(res.body) }; };
  const unavailable = await invoke(); assert.equal(unavailable.status, 503); assert.equal(unavailable.body.blocker.code, 'ShellConsoleApiUnavailable');
  consoleApiReady = true; assert.equal((await invoke()).status, 200);
});
