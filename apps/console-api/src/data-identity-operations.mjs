function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
}

export function createDataIdentityOperations({ store }) {
  if (!store?.getSupabaseStatus) throw new TypeError('Supabase status projection store is required');
  return Object.freeze({
    async getSupabaseStatus({ session, correlationId }) {
      const permissionRevision = Number(session?.permissionRevision);
      const revokeEpoch = Number(session?.revokeEpoch);
      if (!session?.sessionId || !session?.subjectId
          || !Number.isSafeInteger(permissionRevision) || permissionRevision < 0
          || !Number.isSafeInteger(revokeEpoch) || revokeEpoch < 0) {
        fail('AuthenticationRequired', 'session authority revision is invalid', 401);
      }
      return store.getSupabaseStatus({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        expectedPermissionRevision: permissionRevision,
        expectedRevokeEpoch: revokeEpoch,
        correlationId,
      });
    },
  });
}
