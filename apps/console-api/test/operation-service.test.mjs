import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createOperationService } from '../src/operation-service.mjs';
import { createPostgresOperationStore } from '../src/postgres-operation-store.mjs';
import { createRegistryOperations } from '../src/registry-operations.mjs';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import { createDatabaseSessionResolver } from '../src/session-resolver.mjs';

const actorRef = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const current = new Date('2026-09-01T00:00:00.000Z');
const policyCatalog = JSON.parse(await readFile(
  new URL('../../../packages/contracts/action-policies.json', import.meta.url),
  'utf8',
));
const catalogRevision = 'sha256:' + 'c'.repeat(64);
const extensionImage = 'ghcr.io/opensphere-platform/opensphere-plugin-workspace@sha256:' + 'e'.repeat(64);

function resolvedCandidate() {
  return {
    kind: 'extension', descriptorId: 'extension.workspace', id: 'workspace', image: extensionImage,
    digest: 'sha256:' + 'e'.repeat(64), channel: 'edge', catalogRevision,
    descriptorRevision: catalogRevision, executionRevision: extensionImage,
    sourceRevision: 'a'.repeat(40), manifestDigest: 'sha256:' + 'd'.repeat(64),
    compatibilityVersion: '1.0.0', keyId: 'opensphere-release-key-1',
    evidenceRefs: ['oci:provenance:workspace', 'oci:sbom:workspace'],
    packageResourceVersion: '17', packageGeneration: 1,
    verification: { catalog: 'Verified', manifest: 'Verified', signature: 'Verified', permissions: 'Approved' },
  };
}

const session = {
  sessionId,
  subjectId: actorRef,
  expiresAt: '2026-09-01T01:00:00.000Z',
  revokedAt: null,
  authorityFresh: true,
  permissions: [
    'console.registry.manage', 'console.extension.revoke', 'console.extension.install', 'console.extension.remove',
    'console.operation.approve', 'console.operation.verify',
  ],
  permissionRevision: '7',
  revokeEpoch: '2',
  aal: 'aal2',
};

function record(input) {
  return {
    operation_id: operationId,
    action_id: input.actionId,
    action_version: input.actionVersion,
    actor_ref: input.actorRef,
    target_ref: input.targetRef,
    required_permission: input.requiredPermission,
    payload_digest: input.payloadDigest,
    request_digest: 'sha256:' + 'a'.repeat(64),
    reason: input.reason,
    risk: input.risk,
    aal: 'aal2',
    permission_revision: input.expectedPermissionRevision,
    approval_required: input.approvalRequired,
    approval_revision: null,
    plan_revision: input.planRevision,
    idempotency_key: input.idempotencyKey,
    correlation_id: input.correlationId,
    source_revision: null,
    owner_ref: input.ownerRef,
    execution_plan: input.executionPlan ?? null,
    state: input.approvalRequired ? 'Planned' : 'Authorized',
    state_version: 0,
    expected_postcondition: null,
    observed_postcondition: null,
    error: null,
    created_at: current.toISOString(),
    updated_at: current.toISOString(),
  };
}

function fixture() {
  const accepted = [];
  const approved = [];
  const verified = [];
  const resolved = [];
  const store = {
    async accept(input) {
      accepted.push(input);
      return { operationRecord: record(input), replayed: accepted.length > 1 };
    },
    async get() {
      return accepted[0] ? record(accepted[0]) : null;
    },
    async approve(input) {
      approved.push(input);
      const operationRecord = record(accepted[0]);
      operationRecord.state = 'Authorized';
      operationRecord.state_version = 1;
      operationRecord.approval_revision = input.approvalRevision;
      return { operationRecord, replayed: approved.length > 1 };
    },
    async verify(input) {
      verified.push(input);
      const operationRecord = record(accepted[0]);
      operationRecord.state = 'Verified';
      operationRecord.state_version = input.expectedStateVersion + 1;
      operationRecord.observed_postcondition = { authority: 'ConsoleExtensionRevocation' };
      return { operationRecord, replayed: verified.length > 1 };
    },
    async listRevocations(input) {
      return {
        schemaVersion: '1.0',
        data: [],
        authority: 'ConsoleExtensionRevocation',
        observedAt: current.toISOString(),
        freshness: 'fresh',
        correlationId: input.correlationId,
        evidenceRefs: [],
      };
    },
    async getRegistryConnection(input) {
      return {
        schemaVersion: '1.0',
        data: {
          connectionId: 'opensphere-ghcr',
          registryOrigin: 'ghcr.io',
          namespace: 'opensphere-platform',
          username: null,
          credentialPresent: false,
          credentialVersion: null,
          configurationState: 'NotConfigured',
          lastVerifiedAt: null,
          lastVerificationCode: null,
          updatedAt: current.toISOString(),
        },
        authority: 'ConsoleRegistryConnectionMetadata',
        observedAt: current.toISOString(),
        freshness: 'fresh',
        correlationId: input.correlationId,
        evidenceRefs: ['registry-connection:opensphere-ghcr:NotConfigured'],
      };
    },
  };
  const operationService = createOperationService({ store, policyCatalog, clock: () => current });
  const registryResolver = {
    async resolveExtension(input) {
      resolved.push(input);
      return resolvedCandidate();
    },
  };
  const registryOperations = createRegistryOperations({
    operationService,
    policyRevision: policyCatalog.policyRevision,
    projectionStore: store,
    registryResolver,
    clock: () => current,
  });
  return { accepted, approved, verified, resolved, operationService, registryOperations };
}

test('Registry credential mutation persists only a digest after current policy authorization', async () => {
  const { accepted, registryOperations } = fixture();
  const credential = 'candidate-registry-token-never-persisted';
  const result = await registryOperations.replaceCredential({
    session,
    body: { username: 'opensphere-platform', credential, reason: 'rotate registry credential' },
    idempotencyKey: 'registry-credential-0001',
    correlationId: 'correlation-registry-0001',
  });

  assert.equal(result.receipt.actionId, 'console.registry.connection.replace');
  assert.equal(result.receipt.requiredPermission, 'console.registry.manage');
  assert.equal(result.receipt.state, 'Authorized');
  assert.match(result.receipt.payloadDigest, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(accepted[0]), new RegExp(credential));
  assert.equal(accepted[0].expectedPermissionRevision, 7);
  assert.equal(accepted[0].expectedRevokeEpoch, 2);
});

test('Registry connection projection exposes fixed metadata without credential material', async () => {
  const { registryOperations } = fixture();
  const envelope = await registryOperations.getRegistryConnection({
    session,
    correlationId: 'registry-connection-read-0001',
  });
  assert.equal(envelope.authority, 'ConsoleRegistryConnectionMetadata');
  assert.equal(envelope.data.connectionId, 'opensphere-ghcr');
  assert.equal(envelope.data.configurationState, 'NotConfigured');
  assert.equal(envelope.data.credentialPresent, false);
  assert.doesNotMatch(JSON.stringify(envelope), /secretRef|credentialDigest|password|token/i);
});

test('Registry revocation requires an exact digest and canonical confirmation', async () => {
  const { accepted, registryOperations } = fixture();
  const image = 'ghcr.io/opensphere-platform/console@sha256:' + 'b'.repeat(64);
  await assert.rejects(
    registryOperations.createRevocation({
      session,
      body: { image, reason: 'revoke compromised image', confirmation: 'REVOKE wrong' },
      idempotencyKey: 'registry-revocation-0001',
      correlationId: 'correlation-revocation-0001',
    }),
    { code: 'ValidationFailed' },
  );
  assert.equal(accepted.length, 0);
  const result = await registryOperations.createRevocation({
    session,
    body: { image, reason: 'revoke compromised image', confirmation: 'REVOKE ' + image },
    idempotencyKey: 'registry-revocation-0001',
    correlationId: 'correlation-revocation-0001',
  });
  assert.equal(result.receipt.approvalRequired, true);
  assert.equal(accepted.length, 1);
});

test('Extension install intake derives its immutable execution plan from C_REG', async () => {
  const { accepted, resolved, registryOperations } = fixture();
  const request = {
    descriptorId: 'extension.workspace',
    catalogRevision,
    reason: 'install reviewed extension candidate',
  };
  for (const invalid of [
    { ...request, descriptorId: 'workspace' },
    { ...request, catalogRevision: 'sha256:short' },
    { ...request, image: extensionImage },
    { ...request, extra: true },
  ]) {
    await assert.rejects(registryOperations.installCandidate({
      session,
      body: invalid,
      idempotencyKey: 'extension-install-invalid-0001',
      correlationId: 'extension-install-invalid-correlation-0001',
    }), { code: 'ValidationFailed' });
  }
  assert.equal(accepted.length, 0);
  const result = await registryOperations.installCandidate({
    session,
    body: request,
    idempotencyKey: 'extension-install-operation-0001',
    correlationId: 'extension-install-correlation-0001',
  });
  assert.equal(result.receipt.actionId, 'console.extension.install');
  assert.equal(result.receipt.requiredPermission, 'console.extension.install');
  assert.equal(result.receipt.targetRef, extensionImage);
  assert.deepEqual(result.receipt.executionPlan, {
    schemaVersion: '1.0', authority: 'OpenSphereRegistry', descriptorId: 'extension.workspace',
    catalogRevision, image: extensionImage,
  });
  assert.equal(result.receipt.state, 'Planned');
  assert.equal(result.receipt.approvalRequired, true);
  assert.equal(accepted.length, 1);
  assert.deepEqual(resolved, [{
    descriptorId: 'extension.workspace', catalogRevision,
    correlationId: 'extension-install-correlation-0001',
  }]);
});

test('Extension removal intake binds a canonical descriptor and confirmation without client Kubernetes evidence', async () => {
  const { accepted, registryOperations } = fixture();
  const request = {
    descriptorId: 'extension.workspace',
    reason: 'remove retired workspace extension',
    confirmation: 'REMOVE extension.workspace',
  };
  for (const invalid of [
    { ...request, descriptorId: 'workspace' },
    { ...request, confirmation: 'REMOVE extension.other' },
    { ...request, registrationUid: 'client-supplied-uid' },
  ]) {
    await assert.rejects(registryOperations.removeExtension({
      session,
      body: invalid,
      idempotencyKey: 'extension-remove-invalid-0001',
      correlationId: 'extension-remove-invalid-correlation-0001',
    }), { code: 'ValidationFailed' });
  }
  assert.equal(accepted.length, 0);
  const result = await registryOperations.removeExtension({
    session,
    body: request,
    idempotencyKey: 'extension-remove-operation-0001',
    correlationId: 'extension-remove-correlation-0001',
  });
  assert.equal(result.receipt.actionId, 'console.extension.remove');
  assert.equal(result.receipt.requiredPermission, 'console.extension.remove');
  assert.equal(result.receipt.targetRef, 'extension.workspace');
  assert.equal(result.receipt.executionPlan, null);
  assert.equal(result.receipt.state, 'Planned');
  assert.equal(result.receipt.approvalRequired, true);
  assert.deepEqual(accepted[0].executionPlan, null);
});

test('Extension removal checks current permission and AAL before accepting intent', async () => {
  const { accepted, registryOperations } = fixture();
  const body = {
    descriptorId: 'extension.workspace', reason: 'remove retired workspace extension',
    confirmation: 'REMOVE extension.workspace',
  };
  await assert.rejects(registryOperations.removeExtension({
    session: { ...session, permissions: session.permissions.filter((item) => item !== 'console.extension.remove') },
    body, idempotencyKey: 'extension-remove-denied-0001', correlationId: 'extension-remove-denied-correlation-0001',
  }), { code: 'PermissionDenied' });
  await assert.rejects(registryOperations.removeExtension({
    session: { ...session, aal: 'aal1' }, body,
    idempotencyKey: 'extension-remove-denied-0002', correlationId: 'extension-remove-denied-correlation-0002',
  }), { code: 'StepUpRequired' });
  assert.equal(accepted.length, 0);
});

test('Extension resolution is not called before current permission and AAL checks', async () => {
  const { registryOperations, resolved } = fixture();
  const body = { descriptorId: 'extension.workspace', catalogRevision, reason: 'install reviewed extension candidate' };
  await assert.rejects(registryOperations.inspectCandidate({
    session: { ...session, permissions: [] }, body: { descriptorId: body.descriptorId, catalogRevision },
    correlationId: 'extension-inspect-denied-0001',
  }), { code: 'PermissionDenied' });
  await assert.rejects(registryOperations.installCandidate({
    session: { ...session, aal: 'aal1' }, body,
    idempotencyKey: 'extension-install-denied-0001', correlationId: 'extension-install-denied-correlation-0001',
  }), { code: 'StepUpRequired' });
  assert.equal(resolved.length, 0);
});

test('approval requires current aal2 approval authority and carries compare-and-set state', async () => {
  const { approved, operationService, registryOperations } = fixture();
  const image = 'ghcr.io/opensphere-platform/console@sha256:' + 'd'.repeat(64);
  const planned = await registryOperations.createRevocation({
    session,
    body: { image, reason: 'revoke compromised image', confirmation: 'REVOKE ' + image },
    idempotencyKey: 'approval-source-operation-0001',
    correlationId: 'approval-source-correlation-0001',
  });
  const approver = { ...session, subjectId: '55555555-5555-4555-8555-555555555555' };
  const result = await operationService.approve({
    session: approver,
    operationId: planned.receipt.operationId,
    request: {
      reason: 'independent review completed',
      approvalRevision: policyCatalog.policyRevision,
      expectedStateVersion: 0,
      confirmation: null,
    },
    idempotencyKey: 'approval-operation-0001',
    correlationId: 'approval-correlation-0001',
  });
  assert.equal(result.receipt.state, 'Authorized');
  assert.equal(result.receipt.stateVersion, 1);
  assert.equal(approved[0].actorRef, approver.subjectId);
  assert.equal(approved[0].expectedStateVersion, 0);
  assert.equal(approved[0].expectedPermissionRevision, 7);
  assert.equal(approved[0].expectedRevokeEpoch, 2);

  await assert.rejects(operationService.approve({
    session: { ...approver, aal: 'aal1' },
    operationId: planned.receipt.operationId,
    request: {
      reason: 'attempt without step-up',
      approvalRevision: policyCatalog.policyRevision,
      expectedStateVersion: 0,
    },
    idempotencyKey: 'approval-operation-0002',
    correlationId: 'approval-correlation-0002',
  }), { code: 'StepUpRequired' });
  assert.equal(approved.length, 1);
});

test('approval request rejects unknown fields and invalid state versions before storage', async () => {
  const { approved, operationService } = fixture();
  const invoke = (request) => operationService.approve({
    session,
    operationId,
    request,
    idempotencyKey: 'approval-validation-0001',
    correlationId: 'approval-validation-correlation-0001',
  });
  await assert.rejects(invoke({
    reason: 'reviewed', approvalRevision: policyCatalog.policyRevision,
    expectedStateVersion: -1,
  }), { code: 'ValidationFailed' });
  await assert.rejects(invoke({
    reason: 'reviewed', approvalRevision: policyCatalog.policyRevision,
    expectedStateVersion: 0, approverRef: actorRef,
  }), { code: 'ValidationFailed' });
  assert.equal(approved.length, 0);
});

test('verification requires current authority and carries only compare-and-set state', async () => {
  const { verified, operationService, registryOperations } = fixture();
  const image = 'ghcr.io/opensphere-platform/console@sha256:' + '9'.repeat(64);
  const planned = await registryOperations.createRevocation({
    session,
    body: { image, reason: 'verify revoked image', confirmation: 'REVOKE ' + image },
    idempotencyKey: 'verification-source-operation-0001',
    correlationId: 'verification-source-correlation-0001',
  });
  const result = await operationService.verify({
    session,
    operationId: planned.receipt.operationId,
    request: { expectedStateVersion: 4 },
    idempotencyKey: 'verification-operation-0001',
    correlationId: 'verification-correlation-0001',
  });
  assert.equal(result.receipt.state, 'Verified');
  assert.equal(result.receipt.stateVersion, 5);
  assert.deepEqual(Object.keys(verified[0]).sort(), [
    'actorRef', 'correlationId', 'expectedPermissionRevision', 'expectedRevokeEpoch',
    'expectedStateVersion', 'idempotencyKey', 'operationId', 'sessionId',
  ]);
  assert.equal(verified[0].expectedPermissionRevision, 7);
  assert.equal(verified[0].expectedRevokeEpoch, 2);

  await assert.rejects(operationService.verify({
    session: { ...session, permissions: session.permissions.filter((permission) => permission !== 'console.operation.verify') },
    operationId: planned.receipt.operationId,
    request: { expectedStateVersion: 4 },
    idempotencyKey: 'verification-operation-0002',
    correlationId: 'verification-correlation-0002',
  }), { code: 'PermissionDenied' });
  assert.equal(verified.length, 1);
});

test('verification rejects unknown observations and invalid state versions before storage', async () => {
  const { verified, operationService } = fixture();
  const invoke = (request) => operationService.verify({
    session,
    operationId,
    request,
    idempotencyKey: 'verification-validation-0001',
    correlationId: 'verification-validation-correlation-0001',
  });
  await assert.rejects(invoke({ expectedStateVersion: -1 }), { code: 'ValidationFailed' });
  await assert.rejects(invoke({ expectedStateVersion: 4, observedPostcondition: { claimed: true } }), { code: 'ValidationFailed' });
  assert.equal(verified.length, 0);
});

test('unknown action, risk downgrade, stale policy, revoked session, and missing permission fail before storage', async () => {
  const { accepted, operationService } = fixture();
  const base = {
    schemaVersion: '1.0',
    actionId: 'console.registry.connection.remove',
    actionVersion: '1.0',
    targetRef: 'registry-connection:opensphere-ghcr',
    payload: { confirmation: 'REMOVE opensphere-ghcr' },
    reason: 'remove stale credential',
    risk: 'R2',
    planRevision: policyCatalog.policyRevision,
  };
  const invoke = (request, candidateSession = session) => operationService.accept({
    session: candidateSession,
    request,
    idempotencyKey: 'operation-policy-0001',
    correlationId: 'correlation-policy-0001',
  });
  await assert.rejects(invoke({ ...base, actionId: 'console.unknown.action' }), { code: 'PolicyRejected' });
  await assert.rejects(invoke({ ...base, risk: 'R0' }), { code: 'PolicyRejected' });
  await assert.rejects(invoke({ ...base, planRevision: 'old-policy' }), { code: 'StaleRevision' });
  await assert.rejects(invoke(base, { ...session, revokedAt: current.toISOString() }), { code: 'SessionInvalid' });
  await assert.rejects(invoke(base, { ...session, permissions: [] }), { code: 'PermissionDenied' });
  assert.equal(accepted.length, 0);
});

test('PostgreSQL store binds every authority parameter and maps database denial details', async () => {
  const calls = [];
  const store = createPostgresOperationStore({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ operation_record: record({
        actionId: 'console.registry.connection.remove',
        actionVersion: '1.0',
        actorRef,
        targetRef: 'registry-connection:opensphere-ghcr',
        requiredPermission: 'console.registry.manage',
        payloadDigest: 'sha256:' + 'c'.repeat(64),
        reason: 'remove credential',
        risk: 'R2',
        expectedPermissionRevision: 7,
        approvalRequired: false,
        planRevision: policyCatalog.policyRevision,
        idempotencyKey: 'store-operation-0001',
        correlationId: 'correlation-store-0001',
        ownerRef: 'C_EXT',
      }), replayed: false }] };
    },
  });
  await store.accept({
    sessionId,
    actorRef,
    expectedPermissionRevision: 7,
    expectedRevokeEpoch: 2,
    requiredPermission: 'console.registry.manage',
    actionId: 'console.registry.connection.remove',
    actionVersion: '1.0',
    targetRef: 'registry-connection:opensphere-ghcr',
    payloadDigest: 'sha256:' + 'c'.repeat(64),
    risk: 'R2',
    reason: 'remove credential',
    planRevision: policyCatalog.policyRevision,
    approvalRequired: false,
    idempotencyKey: 'store-operation-0001',
    correlationId: 'correlation-store-0001',
    sourceRevision: null,
    ownerRef: 'C_EXT',
    expectedPostcondition: null,
    executionPlan: null,
  });
  assert.equal(calls[0].values.length, 19);
  assert.equal(calls[0].values[0], sessionId);
  assert.equal(calls[0].values[2], 7);
  assert.equal(calls[0].values[3], 2);
  assert.match(calls[0].sql, /console_operation\.accept_operation/);

  const denied = createPostgresOperationStore({
    async query() {
      throw Object.assign(new Error('permission denied'), { detail: 'PermissionDenied' });
    },
  });
  await assert.rejects(denied.get({ sessionId, actorRef, operationId }), { code: 'PermissionDenied', status: 403 });
});

test('PostgreSQL session issue binds only digests, encrypted credentials and authority coordinates', async () => {
  const calls = [];
  const issued = {
    sessionId,
    subjectId: actorRef,
    state: 'active',
    aal: 'aal1',
  };
  const store = createPostgresOperationStore({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ session_record: issued }] };
    },
  });
  const input = {
    subjectId: actorRef,
    tokenDigest: Buffer.alloc(32, 1),
    csrfTokenDigest: Buffer.alloc(32, 2),
    accessTokenCiphertext: 'v1.iv.tag.access',
    refreshTokenCiphertext: 'v1.iv.tag.refresh',
    authSessionRef: 'supabase-session-ref',
    aal: 'aal1',
    accessTokenExpiresAt: '2026-09-02T01:00:00.000Z',
    absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
    persistence: '24h',
    pendingMfa: false,
    correlationId: 'correlation-session-issue-0001',
  };
  assert.equal(await store.issueSession(input), issued);
  assert.match(calls[0].sql, /console_identity[.]issue_browser_session/);
  assert.deepEqual(calls[0].values, Object.values(input));
  assert.equal(calls[0].values.some((value) => value === 'raw-access-token' || value === 'raw-refresh-token'), false);
});

test('PostgreSQL pending MFA read and activation bind proof, subject and credential compare-and-set', async () => {
  const calls = [];
  const pending = { sessionId, subjectId: actorRef, aal: 'aal1', accessTokenCiphertext: 'v1.iv.tag.pending' };
  const active = { sessionId, subjectId: actorRef, state: 'active', aal: 'aal2' };
  const store = createPostgresOperationStore({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ session_record: calls.length === 1 ? pending : active }] };
    },
  });
  const proof = { tokenDigest: Buffer.alloc(32, 3), csrfTokenDigest: Buffer.alloc(32, 4) };
  assert.equal(await store.getPendingMfa(proof), pending);
  assert.match(calls[0].sql, /console_identity[.]get_pending_browser_session_mfa/);
  assert.deepEqual(calls[0].values, Object.values(proof));

  const activation = {
    sessionId,
    subjectId: actorRef,
    expectedAccessCiphertextDigest: Buffer.alloc(32, 5),
    accessTokenCiphertext: 'v1.iv.tag.aal2access',
    refreshTokenCiphertext: 'v1.iv.tag.aal2refresh',
    authSessionRef: 'supabase-session-aal2',
    accessTokenExpiresAt: '2026-09-02T01:00:00.000Z',
    correlationId: 'correlation-session-mfa-0001',
  };
  assert.equal(await store.activateMfa(activation), active);
  assert.match(calls[1].sql, /console_identity[.]activate_browser_session_mfa/);
  assert.deepEqual(calls[1].values, Object.values(activation));
});

test('PostgreSQL activity touch binds only opaque session and CSRF digests', async () => {
  const calls = [];
  const active = {
    sessionId,
    subjectId: actorRef,
    state: 'active',
    aal: 'aal1',
    persistence: '24h',
    idleExpiresAt: '2026-09-02T12:00:00.000Z',
    absoluteExpiresAt: '2026-09-03T00:00:00.000Z',
  };
  const store = createPostgresOperationStore({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ session_record: active }] };
    },
  });
  const proof = { tokenDigest: Buffer.alloc(32, 9), csrfTokenDigest: Buffer.alloc(32, 10) };
  assert.equal(await store.touchActivity(proof), active);
  assert.match(calls[0].sql, /console_identity[.]touch_browser_session_activity/);
  assert.deepEqual(calls[0].values, Object.values(proof));
});

test('PostgreSQL owned-session management binds only proof digests, target and correlation', async () => {
  const calls = [];
  const otherSessionId = '33333333-3333-4333-8333-333333333333';
  const store = createPostgresOperationStore({
    async query(sql, values) {
      calls.push({ sql, values });
      if (/list_owned_browser_sessions/.test(sql)) {
        return { rows: [{ session_inventory: { items: [{ id: sessionId, current: true }] } }] };
      }
      return { rows: [{ revocation_record: /revoke_all_owned_browser_sessions/.test(sql)
        ? { current: true, revokedCount: 2 }
        : { sessionId: otherSessionId, current: false } }] };
    },
  });
  const tokenDigest = Buffer.alloc(32, 11);
  const csrfTokenDigest = Buffer.alloc(32, 12);
  const inventory = await store.listOwnedSessions({ tokenDigest });
  assert.equal(inventory.items[0].current, true);
  assert.match(calls[0].sql, /console_identity[.]list_owned_browser_sessions/);
  assert.deepEqual(calls[0].values, [tokenDigest]);

  const targeted = await store.revokeOwnedSession({
    tokenDigest, csrfTokenDigest, targetSessionId: otherSessionId,
    correlationId: 'owned-session-store-correlation-0001',
  });
  assert.equal(targeted.current, false);
  assert.match(calls[1].sql, /console_identity[.]revoke_owned_browser_session/);
  assert.deepEqual(calls[1].values, [
    tokenDigest, csrfTokenDigest, otherSessionId, 'owned-session-store-correlation-0001',
  ]);

  const all = await store.revokeAllOwnedSessions({
    tokenDigest, csrfTokenDigest, correlationId: 'owned-session-store-correlation-0002',
  });
  assert.equal(all.revokedCount, 2);
  assert.match(calls[2].sql, /console_identity[.]revoke_all_owned_browser_sessions/);
  assert.deepEqual(calls[2].values, [tokenDigest, csrfTokenDigest, 'owned-session-store-correlation-0002']);
  assert.doesNotMatch(JSON.stringify(calls.map(({ values }) => values)), /opaque|credential|password/i);
});

test('PostgreSQL owned recovery-link preparation binds proof, idempotency, correlation, and reason once', async () => {
  const calls = [];
  const prepared = {
    state: 'prepared', sessionId, subjectId: actorRef,
    accessTokenCiphertext: 'v1.iv.tag.access',
    auditEventId: '33333333-3333-4333-8333-333333333333',
  };
  const store = createPostgresOperationStore({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ recovery_record: prepared }] };
    },
  });
  const input = {
    tokenDigest: Buffer.alloc(32, 13),
    csrfTokenDigest: Buffer.alloc(32, 14),
    idempotencyKey: 'owned-password-recovery-key-0001',
    correlationId: 'owned-password-recovery-correlation-0001',
    reason: 'self-service password change',
  };
  assert.equal(await store.prepareOwnedPasswordRecoveryLink(input), prepared);
  assert.match(calls[0].sql, /console_identity[.]prepare_owned_password_recovery_link/);
  assert.deepEqual(calls[0].values, Object.values(input));
});

test('PostgreSQL refresh operations bind only proof, ciphertext CAS and rotated envelopes', async () => {
  const calls = [];
  const store = createPostgresOperationStore({
    async query(sql, values) {
      calls.push({ sql, values });
      if (/get_browser_session_refresh_credentials/.test(sql)) {
        return { rows: [{ session_record: { sessionId, subjectId: actorRef, refreshTokenCiphertext: 'v1.iv.tag.old' } }] };
      }
      return { rows: [{ refresh_record: { outcome: calls.length === 2 ? 'rotated' : 'rejected' } }] };
    },
  });
  const proof = { tokenDigest: Buffer.alloc(32, 6), csrfTokenDigest: null, requireCsrf: false };
  await store.getRefreshCredentials(proof);
  assert.deepEqual(calls[0].values, Object.values(proof));
  const rotation = {
    sessionId, subjectId: actorRef, expectedRefreshCiphertextDigest: Buffer.alloc(32, 7),
    accessTokenCiphertext: 'v1.iv.tag.newaccess', refreshTokenCiphertext: 'v1.iv.tag.newrefresh',
    authSessionRef: 'supabase-session-rotated', aal: 'aal1',
    accessTokenExpiresAt: '2026-09-02T02:00:00.000Z', correlationId: 'refresh-correlation-0001',
  };
  assert.deepEqual(await store.rotateCredentials(rotation), { outcome: 'rotated' });
  assert.deepEqual(calls[1].values, Object.values(rotation));
  assert.deepEqual(await store.rejectRefresh({
    sessionId, subjectId: actorRef, expectedRefreshCiphertextDigest: Buffer.alloc(32, 8),
    correlationId: 'refresh-rejected-correlation-0001',
  }), { outcome: 'rejected' });
  assert.match(calls[2].sql, /console_identity[.]reject_browser_session_refresh/);
});

test('PostgreSQL Registry projection binds session, actor and correlation without secret inputs', async () => {
  const calls = [];
  const store = createPostgresOperationStore({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ read_envelope: {
        authority: 'ConsoleRegistryConnectionMetadata', data: { configurationState: 'NotConfigured' },
      } }] };
    },
  });
  const envelope = await store.getRegistryConnection({
    sessionId,
    actorRef,
    correlationId: 'registry-store-correlation-0001',
  });
  assert.equal(envelope.authority, 'ConsoleRegistryConnectionMetadata');
  assert.match(calls[0].sql, /console_extension\.get_registry_connection/);
  assert.deepEqual(calls[0].values, [sessionId, actorRef, 'registry-store-correlation-0001']);
});

test('opaque session resolver sends only cookie and CSRF digests to PostgreSQL', async () => {
  const calls = [];
  const resolver = createDatabaseSessionResolver({
    store: {
      async resolveSession(input) {
        calls.push(input);
        return session;
      },
    },
  });
  const handle = 'opaque-session-handle-with-more-than-32-bytes';
  const csrf = 'csrf-proof-with-more-than-16-bytes';
  const resolved = await resolver({ headers: {
    cookie: 'theme=dark; __Host-opensphere-session=' + handle,
    'x-os-csrf-token': csrf,
  } }, { requireCsrf: true });
  assert.equal(resolved.subjectId, actorRef);
  assert.equal(resolved.lastReauthenticatedAt, null);
  assert.equal(calls[0].tokenDigest.toString('hex'), createHash('sha256').update(handle).digest('hex'));
  assert.equal(calls[0].csrfTokenDigest.toString('hex'), createHash('sha256').update(csrf).digest('hex'));
  assert.doesNotMatch(JSON.stringify(calls[0]), new RegExp(handle));

  await assert.rejects(
    resolver({ headers: { cookie: '__Host-opensphere-session=' + handle } }, { requireCsrf: true }),
    { code: 'CsrfRejected', status: 403 },
  );
  assert.equal(calls.length, 1);
});

test('HTTP liveness remains independent from database readiness', async (t) => {
  let healthCalls = 0;
  const server = createServer(createConsoleApiHandler({
    async resolveSession() { throw new Error('session resolver must not run for probes'); },
    operationService: {},
    registryOperations: {},
    health: async () => { healthCalls += 1; return false; },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;

  const liveness = await fetch(origin + '/livez');
  assert.equal(liveness.status, 200);
  assert.deepEqual(await liveness.json(), { state: 'Alive' });
  assert.equal(healthCalls, 0);

  const readiness = await fetch(origin + '/healthz');
  assert.equal(readiness.status, 503);
  assert.deepEqual(await readiness.json(), { state: 'Unavailable', authority: 'SupabasePostgreSQL' });
  assert.equal(healthCalls, 1);
});

test('HTTP Registry mutation returns a durable operation URL and no submitted credential', async (t) => {
  const { registryOperations, operationService } = fixture();
  const resolverCalls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession(_request, options) {
      resolverCalls.push(options);
      return session;
    },
    operationService,
    registryOperations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const credential = 'http-candidate-token-never-returned';
  const legacyAliasResponse = await fetch('http://127.0.0.1:' + address.port + '/api/admin/extensions/registry-connections/opensphere-ghcr', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'retired-header-alias-0001',
      'x-os-correlation-id': 'http-correlation-retired-alias-0001',
      'x-os-csrf-token': 'validated-by-session-resolver',
    },
    body: JSON.stringify({ username: 'opensphere-platform', credential, reason: 'reject retired header alias' }),
  });
  assert.equal(legacyAliasResponse.status, 400);
  assert.equal((await legacyAliasResponse.json()).code, 'ValidationFailed');

  const response = await fetch('http://127.0.0.1:' + address.port + '/api/admin/extensions/registry-connections/opensphere-ghcr', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-os-idempotency-key': 'http-registry-operation-0001',
      'x-os-correlation-id': 'http-correlation-registry-0001',
      'x-os-csrf-token': 'validated-by-session-resolver',
    },
    body: JSON.stringify({ username: 'opensphere-platform', credential, reason: 'rotate registry credential' }),
  });
  const body = await response.text();
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('location'), '/api/platform/operations/' + operationId);
  assert.equal(resolverCalls[0].requireCsrf, true);
  assert.doesNotMatch(body, new RegExp(credential));
});

test('HTTP Extension install returns only a Planned exact-revision operation', async (t) => {
  const { registryOperations, operationService } = fixture();
  const resolverCalls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession(_request, options) { resolverCalls.push(options); return session; },
    operationService,
    registryOperations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/admin/extensions/install', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-os-idempotency-key': 'http-extension-install-0001',
      'x-os-correlation-id': 'http-extension-install-correlation-0001',
      'x-os-csrf-token': 'validated-by-session-resolver',
    },
    body: JSON.stringify({
      descriptorId: 'extension.workspace',
      catalogRevision,
      reason: 'install reviewed extension candidate',
    }),
  });
  assert.equal(response.status, 202);
  const receipt = await response.json();
  assert.equal(receipt.state, 'Planned');
  assert.equal(receipt.targetRef, extensionImage);
  assert.equal(receipt.executionPlan.catalogRevision, catalogRevision);
  assert.equal(response.headers.get('location'), '/api/platform/operations/' + operationId);
  assert.deepEqual(resolverCalls, [{ requireCsrf: true, correlationId: 'http-extension-install-correlation-0001' }]);
});

test('HTTP Extension removal returns only a Planned typed operation', async (t) => {
  const { registryOperations, operationService } = fixture();
  const resolverCalls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession(_request, options) { resolverCalls.push(options); return session; },
    operationService,
    registryOperations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/admin/extensions/remove', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-os-idempotency-key': 'http-extension-remove-0001',
      'x-os-correlation-id': 'http-extension-remove-correlation-0001',
      'x-os-csrf-token': 'validated-by-session-resolver',
    },
    body: JSON.stringify({
      descriptorId: 'extension.workspace', reason: 'remove retired workspace extension',
      confirmation: 'REMOVE extension.workspace',
    }),
  });
  assert.equal(response.status, 202);
  const receipt = await response.json();
  assert.equal(receipt.state, 'Planned');
  assert.equal(receipt.actionId, 'console.extension.remove');
  assert.equal(receipt.targetRef, 'extension.workspace');
  assert.equal(response.headers.get('location'), '/api/platform/operations/' + operationId);
  assert.deepEqual(resolverCalls, [{ requireCsrf: true, correlationId: 'http-extension-remove-correlation-0001' }]);
});

test('HTTP Extension inspection returns only current C_REG evidence and requires CSRF', async (t) => {
  const { registryOperations, operationService, resolved } = fixture();
  const resolverCalls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession(_request, options) { resolverCalls.push(options); return session; },
    operationService,
    registryOperations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/admin/extensions/inspect', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-os-correlation-id': 'http-extension-inspect-correlation-0001',
      'x-os-csrf-token': 'validated-by-session-resolver',
    },
    body: JSON.stringify({ descriptorId: 'extension.workspace', catalogRevision }),
  });
  const envelope = await response.json();
  assert.equal(response.status, 200);
  assert.equal(envelope.authority, 'OpenSphereRegistry');
  assert.equal(envelope.freshness, 'fresh');
  assert.equal(envelope.data.candidate.image, extensionImage);
  assert.equal(envelope.data.candidate.verification.signature, 'Verified');
  assert.deepEqual(resolverCalls, [{ requireCsrf: true, correlationId: 'http-extension-inspect-correlation-0001' }]);
  assert.deepEqual(resolved, [{
    descriptorId: 'extension.workspace', catalogRevision,
    correlationId: 'http-extension-inspect-correlation-0001',
  }]);
});

test('HTTP Registry connection read is session-revalidated and no-secret', async (t) => {
  const { registryOperations, operationService } = fixture();
  const resolverCalls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession(_request, options) {
      resolverCalls.push(options);
      return session;
    },
    operationService,
    registryOperations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(
    'http://127.0.0.1:' + address.port + '/api/admin/extensions/registry-connections/opensphere-ghcr',
    { headers: { 'x-os-correlation-id': 'http-registry-connection-read-0001' } },
  );
  const envelope = await response.json();
  assert.equal(response.status, 200);
  assert.equal(envelope.authority, 'ConsoleRegistryConnectionMetadata');
  assert.equal(envelope.data.configurationState, 'NotConfigured');
  assert.equal(envelope.data.credentialPresent, false);
  assert.equal(resolverCalls[0].requireCsrf, false);
  assert.doesNotMatch(JSON.stringify(envelope), /secretRef|credentialDigest|password|token/i);
});

test('HTTP approval route requires CSRF and returns the Authorized receipt', async (t) => {
  const { registryOperations, operationService } = fixture();
  const image = 'ghcr.io/opensphere-platform/console@sha256:' + 'f'.repeat(64);
  const planned = await registryOperations.createRevocation({
    session,
    body: { image, reason: 'revoke compromised image', confirmation: 'REVOKE ' + image },
    idempotencyKey: 'http-approval-source-operation-0001',
    correlationId: 'http-approval-source-correlation-0001',
  });
  const resolverCalls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession(_request, options) {
      resolverCalls.push(options);
      return { ...session, subjectId: '55555555-5555-4555-8555-555555555555' };
    },
    operationService,
    registryOperations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(
    'http://127.0.0.1:' + address.port + '/api/platform/operations/' + planned.receipt.operationId + '/approvals',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-os-idempotency-key': 'http-approval-operation-0001',
        'x-os-correlation-id': 'http-approval-correlation-0001',
        'x-os-csrf-token': 'validated-by-session-resolver',
      },
      body: JSON.stringify({
        reason: 'independent HTTP approval',
        approvalRevision: policyCatalog.policyRevision,
        expectedStateVersion: 0,
      }),
    },
  );
  const receipt = await response.json();
  assert.equal(response.status, 202);
  assert.equal(receipt.state, 'Authorized');
  assert.equal(receipt.stateVersion, 1);
  assert.equal(response.headers.get('location'), '/api/platform/operations/' + planned.receipt.operationId);
  assert.equal(resolverCalls[0].requireCsrf, true);
});

test('HTTP verification route requires CSRF and returns the Verified receipt', async (t) => {
  const { registryOperations, operationService } = fixture();
  const image = 'ghcr.io/opensphere-platform/console@sha256:' + '8'.repeat(64);
  const planned = await registryOperations.createRevocation({
    session,
    body: { image, reason: 'verify HTTP revocation', confirmation: 'REVOKE ' + image },
    idempotencyKey: 'http-verification-source-operation-0001',
    correlationId: 'http-verification-source-correlation-0001',
  });
  const resolverCalls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession(_request, options) {
      resolverCalls.push(options);
      return session;
    },
    operationService,
    registryOperations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(
    'http://127.0.0.1:' + address.port + '/api/platform/operations/' + planned.receipt.operationId + '/verification',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-os-idempotency-key': 'http-verification-operation-0001',
        'x-os-correlation-id': 'http-verification-correlation-0001',
        'x-os-csrf-token': 'validated-by-session-resolver',
      },
      body: JSON.stringify({ expectedStateVersion: 4 }),
    },
  );
  const receipt = await response.json();
  assert.equal(response.status, 200);
  assert.equal(receipt.state, 'Verified');
  assert.equal(receipt.stateVersion, 5);
  assert.equal(response.headers.get('location'), '/api/platform/operations/' + planned.receipt.operationId);
  assert.equal(resolverCalls[0].requireCsrf, true);
});

test('HTTP revocation projection is a session-revalidated authority-aware read', async (t) => {
  const { registryOperations, operationService } = fixture();
  const resolverCalls = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession(_request, options) {
      resolverCalls.push(options);
      return session;
    },
    operationService,
    registryOperations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(
    'http://127.0.0.1:' + address.port + '/api/admin/extensions/revocations',
    { headers: { 'x-os-correlation-id': 'http-revocation-read-correlation-0001' } },
  );
  const envelope = await response.json();
  assert.equal(response.status, 200);
  assert.equal(envelope.authority, 'ConsoleExtensionRevocation');
  assert.equal(envelope.freshness, 'fresh');
  assert.equal(envelope.correlationId, 'http-revocation-read-correlation-0001');
  assert.equal(resolverCalls[0].requireCsrf, false);
});
