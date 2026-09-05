const keys = ['action','correlationId','metadataDigest','outcome','reason','source','target'].sort().join(',');
const fault = (status, message) => {throw Object.assign(new Error(message), {status, code:status===403?'PermissionDenied':'ValidationFailed'});};

export function validateClusterManagerEvent(body) {
  if (!body || Object.keys(body).sort().join(',') !== keys || body.source !== 'cluster-manager'
      || !/^(?:HIS|Ceph|OSAAHIS)[A-Za-z]{1,80}$/.test(body.action || '')
      || !/^(?:HISS\/[a-z0-9][a-z0-9/-]{0,127}|CephExternal\/rook-ceph)$/.test(body.target || '')
      || !['accepted','succeeded','failed','unknown'].includes(body.outcome)
      || typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 1000 || /[\r\n]/.test(body.reason)
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.correlationId || '')
      || !/^sha256:[a-f0-9]{64}$/.test(body.metadataDigest || '')) fault(400, 'Invalid Cluster Manager audit event');
  return body;
}

export function createClusterManagerAudit({query}) {
  return async ({session, body}) => {
    validateClusterManagerEvent(body);
    if (session.credentialType !== 'owner-access' || !session.permissions.includes('console.role.admin')) fault(403, 'Current Console administrator owner credential required');
    const result = await query('SELECT console_audit.append_cluster_manager_event($1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::text,$6::text,$7::text,$8::text,$9::text,$10::text) AS receipt',
      [session.sessionId,session.subjectId,session.permissionRevision,session.revokeEpoch,body.action,body.target,body.outcome,body.reason,body.correlationId,body.metadataDigest]);
    const receipt = result.rows?.[0]?.receipt;
    if (!receipt?.eventId) throw Object.assign(new Error('Cluster Manager audit persistence unavailable'),{status:503,code:'AuthorityUnavailable'});
    return receipt;
  };
}
