'use strict';

const { channelInput, emailList, maskTarget } = require('../notification-dispatcher/contract');

const TYPE = { slack: 'chat', discord: 'chat', smtp: 'email', twilio: 'sms' };
const SEVERITIES = new Set(['info', 'success', 'warning', 'error', 'critical']);

function asText(value, label, { min = 0, max = 255, required = false } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw { code: 400, msg: `${label} is required` };
  if (text.length < min || text.length > max) throw { code: 400, msg: `${label} must be ${min}-${max} characters` };
  return text;
}

function auditReason(value) {
  return asText(value, 'reason', { max: 240 });
}

function publicChannel(row) {
  const config = row.config && typeof row.config === 'object' ? row.config : {};
  return {
    id: row.id, name: row.name, provider: row.provider, channelType: row.channel_type,
    enabled: Boolean(row.enabled), healthState: row.health_state,
    target: maskTarget(row.provider, config), credential: { configured: Boolean(row.credential_configured), version: Number(row.secret_version || 0) },
    lastTest: row.last_test_at ? { status: row.last_test_status, at: row.last_test_at, errorCode: row.last_test_error_code || null } : null,
    lastSuccessAt: row.last_success_at || null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function normalizeRule(input) {
  const sources = [...new Set((Array.isArray(input?.sources) ? input.sources : []).map((item) => asText(item, 'source', { max: 120 })).filter(Boolean))];
  const categories = [...new Set((Array.isArray(input?.categories) ? input.categories : []).map((item) => asText(item, 'category', { max: 120 })).filter(Boolean))];
  const labelMatch = input?.labelMatch && typeof input.labelMatch === 'object' && !Array.isArray(input.labelMatch) ? input.labelMatch : {};
  const channelIds = [...new Set((Array.isArray(input?.channelIds) ? input.channelIds : []).map((item) => asText(item, 'channel ID', { min: 36, max: 36 })).filter(Boolean))];
  if (!channelIds.length) throw { code: 400, msg: 'at least one target channel is required' };
  const severity = asText(input?.minSeverity || 'error', 'minimum severity', { required: true, max: 16 }).toLowerCase();
  if (!SEVERITIES.has(severity)) throw { code: 400, msg: 'invalid minimum severity' };
  const priority = Number(input?.priority || 100);
  const dedupWindowSeconds = Number(input?.dedupWindowSeconds || 0);
  if (!Number.isInteger(priority) || priority < 1 || priority > 100000) throw { code: 400, msg: 'priority is invalid' };
  if (!Number.isInteger(dedupWindowSeconds) || dedupWindowSeconds < 0 || dedupWindowSeconds > 86400) throw { code: 400, msg: 'dedup window is invalid' };
  return {
    name: asText(input?.name, 'rule name', { required: true, min: 2, max: 120 }),
    description: asText(input?.description, 'description', { max: 500 }), enabled: input?.enabled !== false,
    priority, min_severity: severity, sources, categories, label_match: labelMatch,
    quiet_hours: input?.quietHours && typeof input.quietHours === 'object' ? input.quietHours : {},
    dedup_window_seconds: dedupWindowSeconds,
    throttle: input?.throttle && typeof input.throttle === 'object' ? input.throttle : {},
    message_policy: input?.messagePolicy && typeof input.messagePolicy === 'object' ? input.messagePolicy : {},
    channelIds,
  };
}

function publicRule(row, channelNames) {
  return {
    id: row.id, name: row.name, description: row.description, enabled: Boolean(row.enabled), priority: row.priority,
    version: row.version, minSeverity: row.min_severity, sources: row.sources || [], categories: row.categories || [],
    labelMatch: row.label_match || {}, quietHours: row.quiet_hours || {}, dedupWindowSeconds: row.dedup_window_seconds,
    throttle: row.throttle || {}, channelIds: channelNames.map((item) => item.id), channels: channelNames, updatedAt: row.updated_at,
  };
}

function createNotificationApi({ restRequest, logAudit, newOpId, dispatcherRequest }) {
  async function channels() {
    const rows = await restRequest('notification_channel', { query: 'select=*&deleted_at=is.null&order=name.asc' });
    return rows.map(publicChannel);
  }

  async function summary() {
    const [allChannels, deliveries, control] = await Promise.all([
      restRequest('notification_channel', { query: 'select=id,enabled,health_state&deleted_at=is.null' }),
      restRequest('notification_delivery', { query: 'select=status&updated_at=gte.' + new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }),
      restRequest('notification_delivery_control', { query: 'select=paused,reason,changed_at&singleton=eq.true' }),
    ]);
    const active = allChannels.filter((row) => row.enabled).length;
    const healthy = allChannels.filter((row) => row.enabled && row.health_state === 'Healthy').length;
    const degraded = allChannels.filter((row) => row.enabled && ['Degraded', 'Misconfigured'].includes(row.health_state)).length;
    const failed24h = deliveries.filter((row) => ['failed', 'dead-letter'].includes(row.status)).length;
    const deadLetter = deliveries.filter((row) => row.status === 'dead-letter').length;
    return { active, healthy, degraded, failed24h, deadLetter, paused: Boolean(control[0]?.paused), pause: control[0] || null };
  }

  async function createChannel(actor, body) {
    const reason = auditReason(body?.reason);
    const parsed = channelInput(body);
    const id = newOpId();
    const now = new Date().toISOString();
    await restRequest('notification_channel', { method: 'POST', body: [{ id, name: parsed.name, provider: parsed.provider, channel_type: TYPE[parsed.provider], config: parsed.config, created_by: actor.sub, updated_by: actor.sub, created_at: now, updated_at: now }] });
    try {
      await dispatcherRequest(`/internal/channels/${id}/credentials`, { provider: parsed.provider, name: parsed.name, config: parsed.config, secret: parsed.secret });
    } catch (error) {
      await restRequest('notification_channel', { method: 'DELETE', query: `id=eq.${encodeURIComponent(id)}`, prefer: 'return=minimal' }).catch(() => undefined);
      throw error;
    }
    await logAudit(actor, 'notification-channel-create', id, 'ok', reason, { requestId: newOpId(), targetType: 'notification-channel' });
    const row = await restRequest('notification_channel', { query: `select=*&id=eq.${encodeURIComponent(id)}` });
    return publicChannel(row[0]);
  }

  async function smtpChannelConfiguration(id) {
    const rows = await restRequest('notification_channel', { query: `select=id,name,provider,config,credential_configured&id=eq.${encodeURIComponent(id)}&deleted_at=is.null` });
    if (!rows[0]) throw { code: 404, msg: 'notification channel not found' };
    if (rows[0].provider !== 'smtp') throw { code: 400, msg: 'only SMTP channel configuration can be edited' };
    return { id: rows[0].id, name: rows[0].name, provider: rows[0].provider, config: rows[0].config || {}, credentialConfigured: Boolean(rows[0].credential_configured) };
  }

  async function updateSmtpChannel(actor, id, body) {
    const reason = auditReason(body?.reason);
    if (String(body?.provider || '').toLowerCase() !== 'smtp') throw { code: 400, msg: 'only SMTP channel configuration can be edited' };
    const row = await dispatcherRequest(`/internal/channels/${id}/configuration`, body);
    await logAudit(actor, 'notification-channel-update', id, 'ok', reason, { requestId: newOpId(), targetType: 'notification-channel' });
    return row;
  }

  async function setChannelEnabled(actor, id, enabled, body) {
    const reason = auditReason(body?.reason);
    const rows = await restRequest('notification_channel', { query: `select=*&id=eq.${encodeURIComponent(id)}&deleted_at=is.null` });
    if (!rows[0]) throw { code: 404, msg: 'notification channel not found' };
    if (enabled && !rows[0].credential_configured) throw { code: 409, msg: 'notification credentials are not configured' };
    const state = enabled ? (rows[0].health_state === 'Draft' ? 'Healthy' : rows[0].health_state) : 'Disabled';
    await restRequest('notification_channel', { method: 'PATCH', query: `id=eq.${encodeURIComponent(id)}`, body: { enabled, health_state: state, updated_by: actor.sub, updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
    await logAudit(actor, enabled ? 'notification-channel-enable' : 'notification-channel-disable', id, 'ok', reason, { requestId: newOpId(), targetType: 'notification-channel' });
    return { ok: true };
  }

  async function testChannel(actor, id, body) {
    const reason = auditReason(body?.reason);
    const testRecipient = body?.testRecipient ? emailList([body.testRecipient])[0] : '';
    const row = await dispatcherRequest(`/internal/channels/${id}/test`, testRecipient ? { testRecipient } : {});
    await logAudit(actor, 'notification-channel-test', id, row.accepted ? 'ok' : 'error', reason, { requestId: newOpId(), targetType: 'notification-channel' });
    return row;
  }

  async function rules() {
    const [ruleRows, links, channelRows] = await Promise.all([
      restRequest('notification_rule', { query: 'select=*&deleted_at=is.null&order=priority.asc,name.asc' }),
      restRequest('notification_rule_channel', { query: 'select=rule_id,channel_id' }),
      restRequest('notification_channel', { query: 'select=id,name,provider,enabled,health_state&deleted_at=is.null' }),
    ]);
    const channelIndex = new Map(channelRows.map((row) => [row.id, row]));
    const linkIndex = new Map();
    for (const link of links) linkIndex.set(link.rule_id, [...(linkIndex.get(link.rule_id) || []), channelIndex.get(link.channel_id)].filter(Boolean));
    return ruleRows.map((row) => publicRule(row, linkIndex.get(row.id) || []));
  }

  async function createRule(actor, body) {
    const reason = auditReason(body?.reason);
    const input = normalizeRule(body);
    const created = await restRequest('notification_rule', { method: 'POST', body: [{ ...input, channelIds: undefined, created_by: actor.sub, updated_by: actor.sub }] });
    const row = created[0];
    await restRequest('notification_rule_channel', { method: 'POST', body: input.channelIds.map((channelId) => ({ rule_id: row.id, channel_id: channelId })) });
    await logAudit(actor, 'notification-rule-create', row.id, 'ok', reason, { requestId: newOpId(), targetType: 'notification-rule' });
    return { id: row.id };
  }

  async function deliveries(query = {}) {
    const limit = Math.min(250, Math.max(1, Number(query.limit || 100)));
    const rows = await restRequest('notification_delivery', { query: `select=*&order=updated_at.desc&limit=${limit}` });
    const eventIds = [...new Set(rows.map((row) => row.event_id))];
    const channelIds = [...new Set(rows.map((row) => row.channel_id))];
    const [events, channels] = await Promise.all([
      eventIds.length ? Promise.all(eventIds.map((id) => restRequest('notification_event', { query: `select=id,source,severity,title,route,occurred_at&id=eq.${encodeURIComponent(id)}` }).then((out) => out[0]))).then((out) => out.filter(Boolean)) : [],
      channelIds.length ? Promise.all(channelIds.map((id) => restRequest('notification_channel', { query: `select=id,name,provider&id=eq.${encodeURIComponent(id)}` }).then((out) => out[0]))).then((out) => out.filter(Boolean)) : [],
    ]);
    const eventIndex = new Map(events.map((row) => [row.id, row]));
    const channelIndex = new Map(channels.map((row) => [row.id, row]));
    return rows.map((row) => ({ id: row.id, status: row.status, attempts: row.attempt_count, providerMessageId: row.provider_message_id || '', lastErrorCode: row.last_error_code || '', updatedAt: row.updated_at, nextAttemptAt: row.next_attempt_at, event: eventIndex.get(row.event_id) || null, channel: channelIndex.get(row.channel_id) || null }));
  }

  async function retryDelivery(actor, id, body) {
    const reason = auditReason(body?.reason);
    const rows = await restRequest('notification_delivery', { query: `select=id,status,retry_generation&id=eq.${encodeURIComponent(id)}` });
    if (!rows[0]) throw { code: 404, msg: 'notification delivery not found' };
    if (!['failed', 'dead-letter'].includes(rows[0].status)) throw { code: 409, msg: 'only failed deliveries can be retried' };
    await restRequest('notification_delivery', { method: 'PATCH', query: `id=eq.${encodeURIComponent(id)}`, body: { status: 'queued', next_attempt_at: new Date().toISOString(), locked_at: null, lock_owner: null, retry_generation: Number(rows[0].retry_generation || 0) + 1, updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
    await logAudit(actor, 'notification-delivery-retry', id, 'ok', reason, { requestId: newOpId(), targetType: 'notification-delivery' });
    return { ok: true };
  }

  return { channels, createChannel, createRule, deliveries, retryDelivery, rules, setChannelEnabled, smtpChannelConfiguration, summary, testChannel, updateSmtpChannel };
}

module.exports = { auditReason, createNotificationApi, normalizeRule, publicChannel };
