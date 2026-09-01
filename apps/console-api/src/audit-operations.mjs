import { authorizeOperation } from '../../../packages/authz/src/authorize-operation.mjs';

function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
}

export function createAuditOperations({ store, clock = () => new Date() }) {
  if (!store?.listAuditEvents) throw new TypeError('audit projection store is required');
  return Object.freeze({
    async list({ session, cursor = null, limit = 50, correlationId }) {
      const authorization = authorizeOperation({
        session,
        permission: 'console.audit.read',
        risk: 'R0',
        reason: '',
        now: clock(),
      });
      const normalizedCursor = cursor == null || cursor === '' ? null : String(cursor);
      if (normalizedCursor != null && !/^[1-9][0-9]{0,18}$/.test(normalizedCursor)) {
        fail('ValidationFailed', 'audit cursor must be a positive decimal sequence', 400);
      }
      const normalizedLimit = Number(limit);
      if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 200) {
        fail('ValidationFailed', 'audit limit must be an integer between 1 and 200', 400);
      }
      const permissionRevision = Number(authorization.permissionRevision);
      const revokeEpoch = Number(session.revokeEpoch);
      if (!session.sessionId || !Number.isSafeInteger(permissionRevision) || permissionRevision < 0
          || !Number.isSafeInteger(revokeEpoch) || revokeEpoch < 0) {
        fail('AuthenticationRequired', 'session authority revision is invalid', 401);
      }
      return store.listAuditEvents({
        sessionId: session.sessionId,
        actorRef: authorization.actorRef,
        expectedPermissionRevision: permissionRevision,
        expectedRevokeEpoch: revokeEpoch,
        cursor: normalizedCursor,
        limit: normalizedLimit,
        correlationId: String(correlationId || ''),
      });
    },
  });
}
