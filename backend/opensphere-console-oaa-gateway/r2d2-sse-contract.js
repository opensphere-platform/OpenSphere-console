'use strict';

function replayQuery(cursorRecord, limit = 200) {
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 200));
  if (!cursorRecord) {
    return {
      text: `SELECT outbox_id,event_type,payload,created_at FROM oaa.incident_outbox
        ORDER BY created_at,outbox_id LIMIT $1`,
      values: [boundedLimit],
    };
  }
  return {
    text: `SELECT outbox_id,event_type,payload,created_at FROM oaa.incident_outbox
      WHERE (created_at,outbox_id) > ($1,$2::uuid)
      ORDER BY created_at,outbox_id LIMIT $3`,
    values: [cursorRecord.created_at, cursorRecord.outbox_id, boundedLimit],
  };
}

function authorizationFingerprint(actor) {
  const groups = [...new Set((actor?.groups || []).map((group) => String(group)))].sort();
  return JSON.stringify({
    subject: String(actor?.sub || actor?.subject || actor?.id || ''),
    authzRevision: String(actor?.authzRevision || ''),
    groups,
  });
}

module.exports = { replayQuery, authorizationFingerprint };
