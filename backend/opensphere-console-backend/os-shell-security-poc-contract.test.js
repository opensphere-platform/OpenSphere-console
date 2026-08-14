'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  createAttachTicketStore,
  createCredentialAgentAuthorizer,
  createSessionAuditEvent,
  createWebShellActionPolicy,
  createWebShellContextAuthority,
  evaluateWebShellCommand,
  normalizeSessionIntent,
} = require('./os-shell-security-poc-contract');

const digest = `sha256:${'a'.repeat(64)}`;

test('P-39 contract: SessionIntent accepts only the admitted profile and never PodSpec material', () => {
  const defaultIntent = normalizeSessionIntent({});
  assert.deepEqual(defaultIntent, { networkProfile: 'console-only' });
  assert.equal(Object.isFrozen(defaultIntent), true);
  assert.throws(() => { defaultIntent.networkProfile = 'public'; }, TypeError);
  assert.deepEqual(normalizeSessionIntent({ networkProfile: 'console-only' }), { networkProfile: 'console-only' });
  for (const field of ['image', 'command', 'env', 'volumes', 'serviceAccountName', 'podSpec', 'privileged']) {
    assert.throws(
      () => normalizeSessionIntent({ [field]: field === 'env' ? { TOKEN: 'canary' } : 'attacker-value' }),
      (error) => error.code === 'PrivilegeEscalationAttempt' && error.status === 403,
      field,
    );
  }
  assert.throws(
    () => normalizeSessionIntent({ arbitrary: true }),
    (error) => error.code === 'SessionIntentContractViolation',
  );
  assert.throws(
    () => normalizeSessionIntent({ networkProfile: 'public' }),
    (error) => error.code === 'NetworkProfileUnavailable' && error.status === 403,
  );
  for (const forged of [
    { context: 'desktop' },
    { flags: '--context desktop' },
    { env: { OPENSPHERE_EXECUTION_PROFILE: 'desktop' } },
  ]) {
    assert.throws(
      () => normalizeSessionIntent(forged),
      (error) => ['PrivilegeEscalationAttempt', 'SessionIntentContractViolation'].includes(error.code),
    );
  }
});

test('P-12/P-13 contract: attach ticket is one-time and bound to session, actor, and origin', () => {
  let currentMs = 1_000;
  let nonce = 0;
  const store = createAttachTicketStore({
    now: () => currentMs,
    ttlMs: 5_000,
    randomBytes: () => Buffer.alloc(32, ++nonce),
  });
  const binding = { sessionId: 'session-a', actorId: 'user-a', origin: 'https://console.example.test' };
  const issued = store.issue(binding);
  assert.deepEqual(store.consume(issued.ticket, binding), binding);
  assert.throws(
    () => store.consume(issued.ticket, binding),
    (error) => error.code === 'AttachTicketInvalid' && error.status === 401,
  );

  const crossUser = store.issue(binding);
  assert.throws(
    () => store.consume(crossUser.ticket, { ...binding, actorId: 'user-b' }),
    (error) => error.code === 'AttachTicketBindingMismatch' && error.status === 403,
  );
  assert.equal(store.size(), 0);

  const expired = store.issue(binding);
  currentMs += 5_001;
  assert.throws(
    () => store.consume(expired.ticket, binding),
    (error) => error.code === 'AttachTicketExpired' && error.status === 401,
  );
});

test('P-10/P-11 contract: credential agent binds session/user/origin, rejects replay, and returns no bearer', () => {
  let currentMs = 10_000;
  const contextAuthority = createWebShellContextAuthority({
    key: Buffer.alloc(32, 7),
    now: () => currentMs,
    randomBytes: () => Buffer.alloc(24, 8),
  });
  const expectedBinding = {
    sessionId: 'session-a',
    actorId: 'user-a',
    origin: 'https://console.example.test',
  };
  const attestedContext = contextAuthority.issue(expectedBinding);
  const agent = createCredentialAgentAuthorizer({ contextAuthority, now: () => currentMs });
  const allowed = agent.authorize({
    attestedContext,
    expectedBinding,
    requestNonce: 'request-nonce-0001',
    consoleOrigin: 'https://console.example.test',
    targetUrl: '/api/plugins/example/status',
  });
  assert.deepEqual(allowed, {
    method: 'GET',
    url: 'https://console.example.test/api/plugins/example/status',
    attachDelegatedCredential: true,
    sessionId: 'session-a',
    actorId: 'user-a',
  });
  assert.equal(Object.hasOwn(allowed, 'authorization'), false);
  assert.equal(JSON.stringify(allowed).includes('Bearer'), false);

  assert.throws(
    () => agent.authorize({
      attestedContext,
      expectedBinding,
      requestNonce: 'request-nonce-0001',
      consoleOrigin: 'https://console.example.test',
      targetUrl: '/api/plugins/example/status',
    }),
    (error) => error.code === 'CredentialAgentReplayDenied' && error.status === 409,
  );
  assert.throws(
    () => agent.authorize({
      attestedContext,
      expectedBinding,
      requestNonce: 'request-nonce-0002',
      consoleOrigin: 'https://console.example.test',
      targetUrl: 'https://outside.example.test/collect',
    }),
    (error) => error.code === 'CredentialAgentOriginDenied' && error.status === 403,
  );
  assert.throws(
    () => agent.authorize({
      attestedContext,
      expectedBinding,
      requestNonce: 'request-nonce-0004',
      consoleOrigin: 'https://console.example.test',
      targetUrl: '/api/status?access_token=canary',
    }),
    (error) => error.code === 'CredentialInUrlDenied' && error.status === 403,
  );
  assert.throws(
    () => contextAuthority.issue({
      ...expectedBinding,
      origin: 'http://console.example.test',
    }),
    (error) => error.code === 'OriginInvalid' && error.status === 403,
  );
  assert.throws(
    () => agent.authorize({
      attestedContext,
      expectedBinding: { ...expectedBinding, actorId: 'user-b' },
      requestNonce: 'request-nonce-0003',
      consoleOrigin: 'https://console.example.test',
      targetUrl: '/api/status',
    }),
    (error) => error.code === 'WebShellContextBindingMismatch' && error.status === 403,
  );

  const forgedDesktop = { ...attestedContext, executionProfile: 'desktop' };
  assert.throws(
    () => contextAuthority.verify(forgedDesktop, expectedBinding),
    (error) => error.code === 'WebShellContextInvalid' && error.status === 403,
  );
  const forgedEnvironment = { ...attestedContext, env: { KUBECONFIG: '/host/admin' } };
  assert.throws(
    () => contextAuthority.verify(forgedEnvironment, expectedBinding),
    (error) => error.code === 'WebShellContextInvalid' && error.status === 403,
  );
  currentMs = attestedContext.expiresAt;
  assert.throws(
    () => contextAuthority.verify(attestedContext, expectedBinding),
    (error) => error.code === 'WebShellContextExpired' && error.status === 401,
  );
});

test('P-34 contract: lifecycle audit rejects raw terminal, command line, and output fields', () => {
  const base = {
    eventType: 'SessionAttached',
    actorId: 'user-a',
    sessionId: 'session-a',
    networkProfile: 'console-only',
    runtimeImageDigest: digest,
    osArtifactDigest: digest,
    correlationId: 'correlation-a',
    result: 'allowed',
    at: '2026-08-14T00:00:00.000Z',
  };
  assert.equal(createSessionAuditEvent(base).eventType, 'SessionAttached');
  for (const field of ['terminalStream', 'keystroke', 'commandLine', 'output']) {
    assert.throws(
      () => createSessionAuditEvent({ ...base, [field]: 'secret-canary' }),
      (error) => error.code === 'RawTerminalAuditDenied',
      field,
    );
  }
  assert.throws(
    () => createSessionAuditEvent({ ...base, runtimeImageDigest: 'edge' }),
    (error) => error.code === 'MutableArtifactDenied' && error.status === 403,
  );
  assert.throws(
    () => createSessionAuditEvent({ ...base, reason: 'secret canary with spaces' }),
    (error) => error.code === 'AuditContractViolation',
  );
  assert.throws(
    () => createSessionAuditEvent({ ...base, networkProfile: 'public' }),
    (error) => error.code === 'AuditContractViolation',
  );
  assert.throws(
    () => createSessionAuditEvent({ ...base, at: 'secret-canary' }),
    (error) => error.code === 'AuditContractViolation',
  );
});

test('P-40 contract: Web Shell follows machine-readable execution class and passes owner guidance through', () => {
  const contextAuthority = createWebShellContextAuthority({ key: Buffer.alloc(32, 9) });
  const expectedBinding = {
    sessionId: 'session-a',
    actorId: 'user-a',
    origin: 'https://console.example.test',
  };
  const attestedContext = contextAuthority.issue(expectedBinding);
  const requestSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string' } },
  };
  const identity = {
    capabilityId: 'test.capability',
    actionId: 'status.read',
    toolId: 'test.status',
  };
  const actionPolicy = createWebShellActionPolicy([{ ...identity, requestSchema }]);
  const proof = { contextAuthority, attestedContext, expectedBinding, actionPolicy, request: { name: 'sample' } };
  assert.deepEqual(evaluateWebShellCommand({
    ...identity,
    executionClass: 'console-api',
    webShell: { available: true },
    inputSchema: requestSchema,
  }, proof), { available: true, executionClass: 'console-api', ...identity });

  const unavailable = evaluateWebShellCommand({
    executionClass: 'local-host',
    webShell: {
      available: false,
      reason: 'Use the owner API workflow after it becomes available.',
    },
  }, proof);
  assert.deepEqual(unavailable, {
    available: false,
    executionClass: 'local-host',
    failureCode: 'UnsupportedInWebShell',
    reasonCode: 'WebShellExecutionClassDenied',
    blocker: 'executionClass must be console-api',
    guidance: 'executionClass must be console-api',
  });
  for (const executionClass of ['external-tool', 'unknown-owner-class', undefined]) {
    const result = evaluateWebShellCommand({ executionClass }, proof);
    assert.equal(result.available, false);
    assert.equal(result.failureCode, 'UnsupportedInWebShell');
  }
  assert.equal(evaluateWebShellCommand({
    ...identity,
    executionClass: 'console-api',
    webShell: { available: 'true' },
    inputSchema: requestSchema,
  }, proof).failureCode, 'UnsupportedInWebShell');

  const ownerBlocked = evaluateWebShellCommand({
    ...identity,
    executionClass: 'console-api',
    webShell: { available: false, reason: 'Owner binding is pending.' },
    inputSchema: requestSchema,
  }, proof);
  assert.equal(ownerBlocked.reasonCode, 'OwnerWebShellUnavailable');
  assert.equal(ownerBlocked.blocker, 'Owner binding is pending.');

  for (const field of ['capabilityId', 'actionId', 'toolId']) {
    const result = evaluateWebShellCommand({
      ...identity,
      [field]: `forged.${field}`,
      executionClass: 'console-api',
      webShell: { available: true },
      inputSchema: requestSchema,
    }, proof);
    assert.equal(result.available, false, field);
    assert.equal(result.reasonCode, 'WebShellActionNotAllowed', field);
  }

  assert.equal(evaluateWebShellCommand({
    ...identity,
    executionClass: 'console-api',
    webShell: { available: true },
    inputSchema: { ...requestSchema, additionalProperties: true },
  }, proof).reasonCode, 'WebShellOwnerRequestSchemaOpen');

  assert.equal(evaluateWebShellCommand({
    ...identity,
    executionClass: 'console-api',
    webShell: { available: true },
    inputSchema: requestSchema,
  }, { ...proof, request: { name: 'sample', image: 'attacker/image' } }).reasonCode, 'WebShellRequestDenied');

  const forgedContext = { ...attestedContext, executionProfile: 'desktop' };
  assert.throws(
    () => evaluateWebShellCommand({ executionClass: 'console-api' }, {
      ...proof,
      attestedContext: forgedContext,
    }),
    (error) => error.code === 'WebShellContextInvalid' && error.status === 403,
  );
});

test('PFSS PostgreSQL owner manifest: every currently unavailable action is denied with its stable owner blocker', () => {
  const foundationServer = require(path.resolve(__dirname, '../../../OpenSphere-shell-foundation/server.js'));
  const manifest = foundationServer.foundationCliManifest();
  const postgresTools = manifest.tools.filter((tool) => tool.capabilityId === 'data.sql.postgres');
  assert.equal(postgresTools.length, 7);
  assert.ok(postgresTools.every((tool) => tool.executionClass === 'console-api'));
  assert.ok(postgresTools.every((tool) => tool.webShell?.available === false));

  const contextAuthority = createWebShellContextAuthority({ key: Buffer.alloc(32, 11) });
  const expectedBinding = {
    sessionId: 'postgres-session',
    actorId: 'postgres-operator',
    origin: 'https://console.example.test',
  };
  const attestedContext = contextAuthority.issue(expectedBinding);
  const actionPolicy = createWebShellActionPolicy([]);
  for (const tool of postgresTools) {
    const result = evaluateWebShellCommand(tool, {
      contextAuthority,
      attestedContext,
      expectedBinding,
      actionPolicy,
      request: {},
    });
    assert.equal(result.available, false, tool.actionId);
    assert.equal(result.failureCode, 'UnsupportedInWebShell', tool.actionId);
    assert.equal(result.reasonCode, 'OwnerWebShellUnavailable', tool.actionId);
    assert.equal(result.blocker, tool.webShell.reason, tool.actionId);
  }
});
