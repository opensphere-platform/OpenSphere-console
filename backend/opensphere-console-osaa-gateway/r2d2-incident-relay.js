'use strict';

const { createHash } = require('crypto');

const EVENT_MAP = Object.freeze({
  incident_detected: { severity: 'warning', title: 'R2D2 detected an operational risk' },
  incident_activated: { severity: 'warning', title: 'R2D2 operational risk is active' },
  incident_severity_changed: { severity: 'warning', title: 'R2D2 operational risk severity changed' },
  incident_recovering: { severity: 'info', title: 'R2D2 is observing recovery' },
  incident_resolved: { severity: 'success', title: 'R2D2 operational risk resolved' },
  incident_suspended: { severity: 'warning', title: 'R2D2 authority observation is unavailable' },
  incident_resumed: { severity: 'info', title: 'R2D2 authority observation resumed' },
});

function sha256(value) { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }

function projectNotification(outbox) {
  const contract = EVENT_MAP[outbox.event_type];
  if (!contract) throw Object.assign(new Error('unsupported incident outbox event'), { code: 'UnsupportedIncidentEvent' });
  const payload = outbox.payload || {};
  const sourceId = `${outbox.incident_id}:${outbox.transition_sequence}`;
  return {
    source: 'r2d2_incident', sourceId, sourceType: 'r2d2_incident',
    severity: payload.severity === 'critical' || payload.severity === 'high' ? 'critical' : contract.severity,
    title: contract.title,
    body: `${payload.status || 'unknown'} · ${payload.primaryNodeId || 'unknown target'}`,
    route: `/manage/osaa?incident=${encodeURIComponent(outbox.incident_id)}`,
    occurredAt: outbox.created_at,
    evidenceDigest: sha256({ outboxId: outbox.outbox_id, payload }),
  };
}

class IncidentNotificationRelay {
  constructor(deps) {
    this.source = deps.source;
    this.notifications = deps.notifications;
    this.workerId = deps.workerId || `r2d2-relay-${process.pid}`;
    this.maxAttempts = deps.maxAttempts || 10;
  }

  async runOnce(limit = 50) {
    const rows = await this.source.claim(this.workerId, limit);
    const results = [];
    for (const row of rows) {
      try {
        const notification = projectNotification(row);
        const receipt = await this.notifications.upsertBySource(notification);
        await this.source.delivered(row.outbox_id, this.workerId, receipt?.id || null);
        results.push({ outboxId: row.outbox_id, status: 'delivered', duplicate: receipt?.duplicate === true });
      } catch (error) {
        const terminal = Number(row.attempt_count || 0) >= this.maxAttempts;
        await this.source.failed(row.outbox_id, this.workerId, error?.code || 'NotificationRelayFailed', terminal);
        results.push({ outboxId: row.outbox_id, status: terminal ? 'dead-letter' : 'retry' });
      }
    }
    return results;
  }
}

class PgIncidentOutboxSource {
  constructor(pool) { this.pool = pool; }
  async claim(workerId, limit) {
    const result = await this.pool.query('SELECT * FROM osaa.claim_incident_outbox($1,$2)', [workerId, limit]);
    return result.rows;
  }
  async delivered(outboxId, workerId) {
    const result = await this.pool.query(`UPDATE osaa.incident_outbox SET status='delivered',delivered_at=clock_timestamp(),
      claimed_by=NULL,claim_expires_at=NULL,updated_at=clock_timestamp()
      WHERE outbox_id=$1 AND claimed_by=$2 AND status='claimed'`, [outboxId, workerId]);
    if (result.rowCount !== 1) throw Object.assign(new Error('outbox claim lost'), { code: 'OutboxClaimLost' });
  }
  async failed(outboxId, workerId, code, terminal) {
    await this.pool.query(`UPDATE osaa.incident_outbox SET status=$3,last_error_code=$4,
      next_attempt_at=clock_timestamp()+least(interval '5 minutes',interval '2 seconds'*power(2,least(attempt_count,8))),
      claimed_by=NULL,claim_expires_at=NULL,updated_at=clock_timestamp()
      WHERE outbox_id=$1 AND claimed_by=$2 AND status='claimed'`, [outboxId, workerId, terminal ? 'dead-letter' : 'retry', code]);
  }
}

class PgNotificationSink {
  constructor(pool) { this.pool = pool; }
  async upsertBySource(item) {
    const result = await this.pool.query(`INSERT INTO console.notification_event(
      source_type,source_id,source,category,severity,title,body,route,labels,payload_digest,occurred_at
    ) VALUES($1,$2,$3,'operations',$4,$5,$6,$7,$8::jsonb,$9,$10)
    ON CONFLICT(source_type,source_id) DO NOTHING RETURNING id`, [
      item.sourceType, item.sourceId, item.source, item.severity, item.title, item.body, item.route,
      JSON.stringify({ producer: 'r2d2-incident-relay' }), item.evidenceDigest, item.occurredAt,
    ]);
    if (result.rows[0]) return { id: result.rows[0].id, duplicate: false };
    const existing = await this.pool.query('SELECT id FROM console.notification_event WHERE source_type=$1 AND source_id=$2', [item.sourceType, item.sourceId]);
    return { id: existing.rows[0]?.id || null, duplicate: true };
  }
}

module.exports = { EVENT_MAP, projectNotification, IncidentNotificationRelay, PgIncidentOutboxSource, PgNotificationSink };
