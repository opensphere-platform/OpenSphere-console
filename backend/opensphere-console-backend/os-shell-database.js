'use strict';

const {
  contractError,
  hashAttachTicket,
  normalizeAttachTicketExpiry,
  normalizeOrigin,
  normalizeReleaseEvidence,
} = require('./os-shell-contract');

const EXACT_REVISION = /^sha256:[a-f0-9]{64}$/;
const HEALTH_CONTRACT = Object.freeze({
  api: Object.freeze([
    'console.current_shell_permission_revision(uuid)',
    'console.create_shell_session(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,jsonb)',
    'console.get_shell_session(uuid,uuid,uuid,text)',
    'console.list_shell_sessions(uuid,uuid,text,integer)',
    'console.issue_shell_attach_ticket(text,uuid,uuid,uuid,text,bigint,bigint,text,text,timestamptz)',
    'console.request_shell_session_teardown(uuid,uuid,uuid,text,text,text)',
    'console.authorize_shell_runtime_attach(text,text,uuid,text,bigint,bigint)',
    'console.revalidate_shell_runtime(text,uuid,text,bigint,bigint)',
  ]),
  gateway: Object.freeze([
    'console.current_shell_permission_revision(uuid)',
    'console.resolve_shell_attach_binding(text,uuid,uuid,uuid,text,text,text)',
    'console.consume_shell_attach_ticket(text,uuid,uuid,uuid,text,bigint,bigint,text,text,text)',
    'console.revalidate_shell_session(uuid,uuid,uuid,text,bigint,bigint,text,text)',
  ]),
  reconciler: Object.freeze([
    'console.current_shell_permission_revision(uuid)',
    'console.claim_shell_sessions(text,integer)',
    'console.inspect_shell_claim(uuid,text,bigint,bigint)',
    'console.classify_shell_runtime_registration(uuid,bigint,bigint)',
    'console.heartbeat_shell_session(uuid,uuid,text,bigint,bigint,text)',
    'console.transition_shell_session(uuid,uuid,text,bigint,bigint,text,text,text,text,text,text)',
    'console.register_shell_runtime(uuid,uuid,text,bigint,bigint,text,text,text,text,text,text,text,text,timestamptz)',
    'console.resolve_shell_runtime_registration(uuid,text,bigint,bigint)',
    'console.revoke_shell_session_authority(uuid,text,bigint,bigint,text)',
    'console.reproject_shell_runtime(uuid,uuid,text,bigint,bigint,text,text)',
  ]),
});
const HEALTH_ROLE = Object.freeze({ api: 'opensphere_shell_api', gateway: 'opensphere_shell_gateway', reconciler: 'opensphere_shell_reconciler' });

function rows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw contractError('ShellDatabaseContractInvalid', `${label} must be a positive integer`);
  }
  return normalized;
}

function required(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw contractError('ShellDatabaseContractInvalid', `${label} is required`);
  return normalized;
}

function createOsShellDatabase({ query, now = () => Date.now(), allowLoopbackHttp = false } = {}) {
  if (typeof query !== 'function') throw new TypeError('query is required');

  async function execute(text, values) {
    return rows(await query(text, values));
  }

  async function health(mode) {
    const signatures = HEALTH_CONTRACT[mode];
    if (!signatures) throw contractError('ShellDatabaseContractInvalid', 'database health mode is invalid');
    const result = await execute(`WITH required(signature) AS (SELECT unnest($1::text[]))
      SELECT current_user = $2::name
        AND has_schema_privilege(current_user, 'console', 'USAGE')
        AND COALESCE(bool_and(to_regprocedure(signature) IS NOT NULL
          AND has_function_privilege(current_user, to_regprocedure(signature), 'EXECUTE')), false) AS ready
      FROM required`, [signatures, HEALTH_ROLE[mode]]);
    return result[0]?.ready === true;
  }

  // This read is deliberately performed for every actor-bound call. The RPC
  // repeats the comparison inside its own transaction, closing the race where
  // a role expires or is revoked after this boundary read.
  async function currentPermissionRevision(actorId, expectedRevision = null) {
    const actor = required(actorId, 'actorId');
    const result = await execute(
      'SELECT console.current_shell_permission_revision($1::uuid) AS permission_revision',
      [actor],
    );
    const revision = result[0]?.permission_revision;
    if (!EXACT_REVISION.test(String(revision || ''))) {
      throw contractError('AuthorizationAuthorityUnavailable', 'permission authority returned no canonical revision', 503);
    }
    if (expectedRevision !== null && expectedRevision !== revision) {
      throw contractError('PermissionRevisionChanged', 'effective shell permission revision changed', 403);
    }
    return revision;
  }

  async function createSession(input) {
    const revision = await currentPermissionRevision(input.actorId, input.permissionRevision ?? null);
    const evidence = normalizeReleaseEvidence(input.releaseEvidence);
    const result = await execute(
      'SELECT * FROM console.create_shell_session($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::text,$7::text,$8::timestamptz,$9::timestamptz,$10::jsonb)',
      [required(input.sessionId, 'sessionId'), required(input.browserSessionId, 'browserSessionId'),
        required(input.actorId, 'actorId'), normalizeOrigin(input.origin, { allowLoopbackHttp }),
        required(input.aal, 'aal'), revision, required(input.runtimeTemplateRevision, 'runtimeTemplateRevision'),
        required(input.idleExpiresAt, 'idleExpiresAt'), required(input.absoluteExpiresAt, 'absoluteExpiresAt'),
        JSON.stringify(evidence)],
    );
    if (result.length !== 1) throw contractError('ShellSessionCreateFailed', 'session authority did not create exactly one row', 409);
    return result[0];
  }

  async function getSession(input) {
    const revision = await currentPermissionRevision(input.actorId, input.permissionRevision ?? null);
    const result = await execute(
      'SELECT * FROM console.get_shell_session($1::uuid,$2::uuid,$3::uuid,$4::text)',
      [required(input.sessionId, 'sessionId'), required(input.browserSessionId, 'browserSessionId'),
        required(input.actorId, 'actorId'), revision],
    );
    return result[0] || null;
  }

  async function listSessions(input) {
    const revision = await currentPermissionRevision(input.actorId, input.permissionRevision ?? null);
    return execute(
      'SELECT * FROM console.list_shell_sessions($1::uuid,$2::uuid,$3::text,$4::integer)',
      [required(input.browserSessionId, 'browserSessionId'), required(input.actorId, 'actorId'), revision,
        Math.max(1, Math.min(100, Number(input.limit || 50)))],
    );
  }

  async function issueAttachTicket(input) {
    const revision = await currentPermissionRevision(input.actorId, input.permissionRevision ?? null);
    const ticketHash = input.ticketHash
      ? required(input.ticketHash, 'ticketHash')
      : hashAttachTicket(required(input.ticket, 'ticket'));
    const expiresAt = normalizeAttachTicketExpiry(input.expiresAt, { now: now() });
    const result = await execute(
      'SELECT * FROM console.issue_shell_attach_ticket($1::text,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::bigint,$7::bigint,$8::text,$9::text,$10::timestamptz)',
      [ticketHash, required(input.sessionId, 'sessionId'), required(input.browserSessionId, 'browserSessionId'),
        required(input.actorId, 'actorId'), normalizeOrigin(input.origin, { allowLoopbackHttp }),
        positiveInteger(input.generation, 'generation'), positiveInteger(input.fencingEpoch, 'fencingEpoch'),
        required(input.aal, 'aal'), revision, expiresAt],
    );
    if (result.length !== 1) throw contractError('AttachTicketIssueFailed', 'ticket authority did not issue exactly one row', 409);
    return result[0];
  }

  async function consumeAttachTicket(input) {
    const revision = await currentPermissionRevision(input.actorId, input.permissionRevision ?? null);
    const ticketHash = input.ticketHash
      ? required(input.ticketHash, 'ticketHash')
      : hashAttachTicket(required(input.ticket, 'ticket'));
    const result = await execute(
      'SELECT * FROM console.consume_shell_attach_ticket($1::text,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::bigint,$7::bigint,$8::text,$9::text,$10::text)',
      [ticketHash, required(input.sessionId, 'sessionId'), required(input.browserSessionId, 'browserSessionId'),
        required(input.actorId, 'actorId'), normalizeOrigin(input.origin, { allowLoopbackHttp }),
        positiveInteger(input.generation, 'generation'), positiveInteger(input.fencingEpoch, 'fencingEpoch'),
        required(input.aal, 'aal'), revision, required(input.consumer, 'consumer')],
    );
    if (result.length > 1) throw contractError('AttachTicketAuthorityCorrupt', 'ticket CAS returned more than one row', 503);
    return result[0] || null;
  }

  async function resolveAttachBinding(input) {
    const revision = await currentPermissionRevision(input.actorId, input.permissionRevision ?? null);
    const result = await execute(
      'SELECT * FROM console.resolve_shell_attach_binding($1::text,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::text)',
      [input.ticketHash || hashAttachTicket(required(input.ticket, 'ticket')), required(input.sessionId, 'sessionId'),
        required(input.browserSessionId, 'browserSessionId'), required(input.actorId, 'actorId'),
        normalizeOrigin(input.origin, { allowLoopbackHttp }), required(input.aal, 'aal'), revision],
    );
    return result[0] || null;
  }

  async function authorizeRuntimeAttach(input) {
    const result = await execute(
      'SELECT * FROM console.authorize_shell_runtime_attach($1::text,$2::text,$3::uuid,$4::text,$5::bigint,$6::bigint)',
      [required(input.runtimeCredentialHash, 'runtimeCredentialHash'), input.ticketHash || hashAttachTicket(required(input.ticket, 'ticket')),
        required(input.sessionId, 'sessionId'), required(input.runtimeUid, 'runtimeUid'),
        positiveInteger(input.generation, 'generation'), positiveInteger(input.fencingEpoch, 'fencingEpoch')],
    );
    return result[0] || null;
  }

  async function revalidateRuntime(input) {
    const result = await execute(
      'SELECT * FROM console.revalidate_shell_runtime($1::text,$2::uuid,$3::text,$4::bigint,$5::bigint)',
      [required(input.runtimeCredentialHash, 'runtimeCredentialHash'), required(input.sessionId, 'sessionId'),
        required(input.runtimeUid, 'runtimeUid'), positiveInteger(input.generation, 'generation'),
        positiveInteger(input.fencingEpoch, 'fencingEpoch')],
    );
    return result[0] || null;
  }

  async function revalidateSession(input) {
    const revision = await currentPermissionRevision(input.actorId, input.permissionRevision ?? null);
    const result = await execute(
      'SELECT * FROM console.revalidate_shell_session($1::uuid,$2::uuid,$3::uuid,$4::text,$5::bigint,$6::bigint,$7::text,$8::text)',
      [required(input.sessionId, 'sessionId'), required(input.browserSessionId, 'browserSessionId'),
        required(input.actorId, 'actorId'), normalizeOrigin(input.origin, { allowLoopbackHttp }),
        positiveInteger(input.generation, 'generation'), positiveInteger(input.fencingEpoch, 'fencingEpoch'),
        required(input.aal, 'aal'), revision],
    );
    return result[0] || null;
  }

  async function requestTeardown(input) {
    const revision = await currentPermissionRevision(input.actorId, input.permissionRevision ?? null);
    const result = await execute(
      'SELECT * FROM console.request_shell_session_teardown($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::text)',
      [required(input.sessionId, 'sessionId'), required(input.browserSessionId, 'browserSessionId'),
        required(input.actorId, 'actorId'), normalizeOrigin(input.origin, { allowLoopbackHttp }),
        revision, required(input.reasonCode, 'reasonCode')],
    );
    return result[0] || null;
  }

  async function claimSessions(input) {
    return execute(
      'SELECT * FROM console.claim_shell_sessions($1::text,$2::integer)',
      [required(input.worker, 'worker'), Math.max(1, Math.min(20, positiveInteger(input.limit ?? 5, 'limit')))],
    );
  }

  async function heartbeatSession(input) {
    const revision = await currentPermissionRevision(input.actorId, input.permissionRevision ?? null);
    const result = await execute(
      'SELECT console.heartbeat_shell_session($1::uuid,$2::uuid,$3::text,$4::bigint,$5::bigint,$6::text) AS renewed',
      [required(input.sessionId, 'sessionId'), required(input.actorId, 'actorId'), required(input.worker, 'worker'),
        positiveInteger(input.generation, 'generation'), positiveInteger(input.fencingEpoch, 'fencingEpoch'), revision],
    );
    return result[0]?.renewed === true;
  }

  async function transitionSession(input) {
    const revision = await currentPermissionRevision(input.actorId, input.permissionRevision ?? null);
    const result = await execute(
      'SELECT * FROM console.transition_shell_session($1::uuid,$2::uuid,$3::text,$4::bigint,$5::bigint,$6::text,$7::text,$8::text,$9::text,$10::text,$11::text)',
      [required(input.sessionId, 'sessionId'), required(input.actorId, 'actorId'), required(input.worker, 'worker'),
        positiveInteger(input.generation, 'generation'), positiveInteger(input.fencingEpoch, 'fencingEpoch'),
        required(input.expectedState, 'expectedState'), required(input.nextState, 'nextState'), revision,
        input.runtimeUid ? required(input.runtimeUid, 'runtimeUid') : null,
        input.runtimeResourceVersion ? required(input.runtimeResourceVersion, 'runtimeResourceVersion') : null,
        required(input.reasonCode, 'reasonCode')],
    );
    if (result.length !== 1) throw contractError('ShellSessionTransitionFailed', 'session transition did not return exactly one row', 409);
    return result[0];
  }

  async function registerRuntime(input) {
    const revision = await currentPermissionRevision(input.actorId, input.permissionRevision ?? null);
    const result = await execute(
      'SELECT * FROM console.register_shell_runtime($1::uuid,$2::uuid,$3::text,$4::bigint,$5::bigint,$6::text,$7::text,$8::text,$9::text,$10::text,$11::text,$12::text,$13::text,$14::timestamptz)',
      [required(input.sessionId, 'sessionId'), required(input.actorId, 'actorId'), required(input.worker, 'worker'),
        positiveInteger(input.generation, 'generation'), positiveInteger(input.fencingEpoch, 'fencingEpoch'), revision,
        required(input.runtimeUid, 'runtimeUid'), required(input.runtimeResourceVersion, 'runtimeResourceVersion'),
        required(input.runtimeKeyId, 'runtimeKeyId'), required(input.runtimePublicKeyPem, 'runtimePublicKeyPem'),
        required(input.runtimeTlsCertificateSha256, 'runtimeTlsCertificateSha256'),
        required(input.runtimeAttachEndpoint, 'runtimeAttachEndpoint'), required(input.runtimeCredentialHash, 'runtimeCredentialHash'),
        required(input.runtimeCredentialExpiresAt, 'runtimeCredentialExpiresAt')],
    );
    if (result.length !== 1) throw contractError('ShellRuntimeRegistrationFailed', 'runtime registration did not return exactly one row', 409);
    return result[0];
  }

  async function revokeSessionAuthority(input) {
    const result = await execute(
      'SELECT * FROM console.revoke_shell_session_authority($1::uuid,$2::text,$3::bigint,$4::bigint,$5::text)',
      [required(input.sessionId, 'sessionId'), required(input.worker, 'worker'),
        positiveInteger(input.generation, 'generation'), positiveInteger(input.fencingEpoch, 'fencingEpoch'),
        required(input.reasonCode, 'reasonCode')],
    );
    return result[0] || null;
  }

  async function resolveRuntimeRegistration(input) {
    const result = await execute(
      'SELECT * FROM console.resolve_shell_runtime_registration($1::uuid,$2::text,$3::bigint,$4::bigint)',
      [required(input.sessionId, 'sessionId'), required(input.runtimeUid, 'runtimeUid'),
        positiveInteger(input.generation, 'generation'), positiveInteger(input.fencingEpoch, 'fencingEpoch')],
    );
    return result[0] || null;
  }

  async function inspectClaim(input) {
    const result = await execute('SELECT * FROM console.inspect_shell_claim($1::uuid,$2::text,$3::bigint,$4::bigint)',
      [required(input.sessionId, 'sessionId'), required(input.worker, 'worker'), positiveInteger(input.generation, 'generation'), positiveInteger(input.fencingEpoch, 'fencingEpoch')]);
    return result[0] || null;
  }

  async function classifyRuntimeRegistration(input) {
    const result = await execute('SELECT * FROM console.classify_shell_runtime_registration($1::uuid,$2::bigint,$3::bigint)',
      [required(input.sessionId, 'sessionId'), positiveInteger(input.generation, 'generation'), positiveInteger(input.fencingEpoch, 'fencingEpoch')]);
    return result[0] || null;
  }

  async function reprojectRuntime(input) {
    const result = await execute('SELECT * FROM console.reproject_shell_runtime($1::uuid,$2::uuid,$3::text,$4::bigint,$5::bigint,$6::text,$7::text)',
      [required(input.sessionId, 'sessionId'), required(input.actorId, 'actorId'), required(input.worker, 'worker'),
        positiveInteger(input.generation, 'generation'), positiveInteger(input.fencingEpoch, 'fencingEpoch'),
        input.expectedRuntimeUid ? required(input.expectedRuntimeUid, 'expectedRuntimeUid') : null, required(input.reasonCode, 'reasonCode')]);
    if (result.length !== 1) throw contractError('ShellRuntimeReprojectionFailed', 'runtime reprojection did not return one row', 409);
    return result[0];
  }

  return Object.freeze({
    claimSessions,
    classifyRuntimeRegistration,
    authorizeRuntimeAttach,
    consumeAttachTicket,
    createSession,
    currentPermissionRevision,
    getSession,
    heartbeatSession,
    health,
    issueAttachTicket,
    inspectClaim,
    listSessions,
    registerRuntime,
    reprojectRuntime,
    resolveAttachBinding,
    resolveRuntimeRegistration,
    requestTeardown,
    revokeSessionAuthority,
    revalidateSession,
    revalidateRuntime,
    transitionSession,
  });
}

module.exports = { createOsShellDatabase };
