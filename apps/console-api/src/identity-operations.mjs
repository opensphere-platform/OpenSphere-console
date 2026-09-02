function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
}

function active(session, now) {
  const expiresAt = new Date(session?.expiresAt).getTime();
  if (!session?.sessionId || !session?.subjectId || session.revokedAt
      || session.authorityFresh !== true || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    fail('AuthenticationRequired', 'active current Console session is required', 401);
  }
  const permissionRevision = Number(session.permissionRevision);
  const revokeEpoch = Number(session.revokeEpoch);
  if (!Number.isSafeInteger(permissionRevision) || permissionRevision < 0
      || !Number.isSafeInteger(revokeEpoch) || revokeEpoch < 0) {
    fail('AuthenticationRequired', 'session authority revision is invalid', 401);
  }
  return { permissionRevision, revokeEpoch };
}

function envelope(data, correlationId, evidenceRefs, now) {
  return Object.freeze({
    schemaVersion: '1.0',
    data: Object.freeze(data),
    authority: 'SupabaseAuth',
    observedAt: now.toISOString(),
    freshness: 'fresh',
    correlationId,
    evidenceRefs: Object.freeze(evidenceRefs),
  });
}

export function createIdentityOperations({ store, clock = () => new Date() }) {
  if (!store?.revokeSession) throw new TypeError('identity session store is required');
  return Object.freeze({
    getSession({ session, currentIdentity, correlationId }) {
      const now = clock();
      active(session, now);
      const projection = {
        state: 'Active',
        subjectId: session.subjectId,
        expiresAt: new Date(session.expiresAt).toISOString(),
        aal: session.aal,
        permissionRevision: String(session.permissionRevision),
        revokeEpoch: String(session.revokeEpoch),
      };
      if (currentIdentity !== undefined) {
        const profile = currentIdentity?.profile;
        const browserSession = currentIdentity?.browserSession;
        const groups = currentIdentity?.groups;
        if (profile?.id !== session.subjectId || !profile.username || !profile.email || !profile.displayName
            || !Array.isArray(groups) || groups.some((group) => typeof group !== 'string')
            || browserSession?.id !== session.sessionId || browserSession.current !== true
            || browserSession.status !== 'active') {
          fail('AuthorityUnavailable', 'current identity projection is invalid', 503);
        }
        Object.assign(projection, {
          username: profile.username,
          email: profile.email,
          displayName: profile.displayName,
          groups: Object.freeze([...groups]),
          permissions: Object.freeze([...(session.permissions || [])].sort()),
          browserSession,
          authorityDegraded: false,
        });
      }
      return envelope(projection, correlationId, ['browser-session:' + session.sessionId, 'subject:' + session.subjectId], now);
    },

    getMe({ session, correlationId }) {
      const now = clock();
      active(session, now);
      return envelope({
        state: 'Active',
        sessionId: session.sessionId,
        subjectId: session.subjectId,
        permissions: Object.freeze([...(session.permissions || [])].sort()),
        aal: session.aal,
        permissionRevision: String(session.permissionRevision),
        revokeEpoch: String(session.revokeEpoch),
      }, correlationId, ['subject:' + session.subjectId], now);
    },

    async revokeSession({ session, correlationId }) {
      const { permissionRevision, revokeEpoch } = active(session, clock());
      await store.revokeSession({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        expectedPermissionRevision: permissionRevision,
        expectedRevokeEpoch: revokeEpoch,
        correlationId,
      });
    },
  });
}
