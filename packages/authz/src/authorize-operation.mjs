const risks = new Set(['R0', 'R1', 'R2', 'R3']);

export function authorizeOperation({ session, permission, risk, reason, now = new Date() }) {
  if (!session?.subjectId || session.revokedAt || new Date(session.expiresAt) <= now) {
    throw Object.assign(new Error('active session is required'), { code: 'SessionInvalid' });
  }
  if (session.authorityFresh !== true) {
    throw Object.assign(new Error('authorization authority is unavailable'), { code: 'AuthorizationAuthorityUnavailable' });
  }
  if (!session.permissions?.includes(permission)) {
    throw Object.assign(new Error('permission denied'), { code: 'PermissionDenied' });
  }
  if (!risks.has(risk)) throw new TypeError('risk is outside the closed contract');
  if (risk !== 'R0' && !String(reason || '').trim()) {
    throw Object.assign(new Error('reason is required'), { code: 'ReasonRequired' });
  }
  if ((risk === 'R2' || risk === 'R3') && session.aal !== 'aal2') {
    throw Object.assign(new Error('recent aal2 is required'), { code: 'StepUpRequired' });
  }
  return Object.freeze({
    actorRef: session.subjectId,
    permissionRevision: session.permissionRevision,
    aal: session.aal,
    authorizedAt: now.toISOString(),
  });
}
