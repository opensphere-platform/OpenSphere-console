'use strict';

const net = require('node:net');

const PROVIDERS = new Set(['slack', 'discord', 'smtp', 'twilio']);
const SEVERITIES = ['info', 'success', 'warning', 'error', 'critical'];

function asText(value, label, { min = 0, max = 255, required = false } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw { code: 400, msg: `${label} is required` };
  if (text.length < min || text.length > max) throw { code: 400, msg: `${label} must be ${min}-${max} characters` };
  return text;
}

function safeUrl(value, provider) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw { code: 400, msg: `${provider} webhook URL is invalid` }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw { code: 400, msg: `${provider} webhook must be an HTTPS URL without credentials` };
  const host = url.hostname.toLowerCase();
  if (provider === 'slack' && !['hooks.slack.com', 'hooks.slack-gov.com'].includes(host)) throw { code: 400, msg: 'Slack webhook host is not allowed' };
  if (provider === 'discord' && !['discord.com', 'discordapp.com'].includes(host)) throw { code: 400, msg: 'Discord webhook host is not allowed' };
  if (provider === 'discord' && !/^\/api\/webhooks\/[^/]+\/[^/]+/.test(url.pathname)) throw { code: 400, msg: 'Discord webhook path is invalid' };
  return url.toString();
}

function safeSmtpHost(value) {
  const host = asText(value, 'SMTP host', { required: true, max: 253 }).toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || net.isIP(host)) throw { code: 400, msg: 'SMTP host must be a configured DNS name' };
  return host;
}

function emailList(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [...new Set(entries.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  if (!out.length || out.length > 30 || out.some((item) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item))) throw { code: 400, msg: 'at least one valid email recipient is required' };
  return out;
}

function phoneList(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [...new Set(entries.map((item) => String(item).replace(/[\s()-]/g, '')).filter(Boolean))];
  if (!out.length || out.length > 30 || out.some((item) => !/^\+[1-9]\d{7,14}$/.test(item))) throw { code: 400, msg: 'SMS recipients must use E.164 format' };
  return out;
}

function redact(value) {
  const text = String(value || '');
  if (text.length <= 6) return '••••••';
  return `${text.slice(0, 3)}••••${text.slice(-3)}`;
}

function maskTarget(provider, config = {}) {
  if (provider === 'smtp') return (config.recipients || []).map(redact).join(', ');
  if (provider === 'twilio') return (config.recipients || []).map(redact).join(', ');
  return asText(config.target || '', 'target', { max: 160 }) || 'configured webhook';
}

function channelInput(input) {
  const provider = asText(input?.provider, 'provider', { required: true, max: 32 }).toLowerCase();
  if (!PROVIDERS.has(provider)) throw { code: 400, msg: 'unsupported notification provider' };
  const name = asText(input?.name, 'name', { required: true, min: 2, max: 80 });
  const raw = input?.config && typeof input.config === 'object' ? input.config : {};
  const secret = input?.secret && typeof input.secret === 'object' ? input.secret : {};
  let config;
  let normalizedSecret;
  if (provider === 'slack') {
    config = { target: asText(raw.target, 'Slack target', { max: 160 }) || 'Slack channel', titlePrefix: asText(raw.titlePrefix, 'title prefix', { max: 80 }) };
    normalizedSecret = { webhookUrl: safeUrl(secret.webhookUrl, 'slack') };
  } else if (provider === 'discord') {
    config = { target: asText(raw.target, 'Discord target', { max: 160 }) || 'Discord channel', threadId: asText(raw.threadId, 'Discord thread ID', { max: 32 }), titlePrefix: asText(raw.titlePrefix, 'title prefix', { max: 80 }) };
    normalizedSecret = { webhookUrl: safeUrl(secret.webhookUrl, 'discord') };
  } else if (provider === 'smtp') {
    const port = Number(raw.port || 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw { code: 400, msg: 'SMTP port is invalid' };
    config = { host: safeSmtpHost(raw.host), port, secure: raw.secure === true, starttls: raw.starttls !== false, from: emailList([raw.from])[0], recipients: emailList(raw.recipients), titlePrefix: asText(raw.titlePrefix, 'title prefix', { max: 80 }) };
    normalizedSecret = { username: asText(secret.username, 'SMTP username', { required: true, max: 255 }), password: asText(secret.password, 'SMTP password', { required: true, max: 1024 }) };
  } else {
    config = { accountSid: asText(raw.accountSid, 'Twilio account SID', { required: true, max: 64 }), messagingServiceSid: asText(raw.messagingServiceSid, 'Twilio messaging service SID', { max: 64 }), from: asText(raw.from, 'Twilio sender', { max: 32 }), recipients: phoneList(raw.recipients), titlePrefix: asText(raw.titlePrefix, 'title prefix', { max: 80 }) };
    if (!config.messagingServiceSid && !config.from) throw { code: 400, msg: 'Twilio sender or messaging service is required' };
    normalizedSecret = { authToken: asText(secret.authToken, 'Twilio auth token', { required: true, max: 255 }) };
  }
  return { name, provider, config, secret: normalizedSecret };
}

function normalizedEvent(input) {
  const severity = asText(input?.severity, 'severity', { required: true, max: 16 }).toLowerCase();
  if (!SEVERITIES.includes(severity)) throw { code: 400, msg: 'invalid notification severity' };
  return {
    sourceType: asText(input?.sourceType, 'source type', { required: true, max: 80 }),
    sourceId: asText(input?.sourceId, 'source ID', { required: true, max: 255 }),
    source: asText(input?.source, 'source', { required: true, max: 120 }),
    category: asText(input?.category, 'category', { max: 120 }),
    severity,
    title: asText(input?.title, 'title', { required: true, max: 240 }),
    body: asText(input?.body, 'body', { max: 4000 }),
    route: asText(input?.route, 'route', { max: 500 }),
    labels: input?.labels && typeof input.labels === 'object' && !Array.isArray(input.labels) ? input.labels : {},
    occurredAt: input?.occurredAt ? new Date(input.occurredAt).toISOString() : new Date().toISOString(),
  };
}

function messageFor(event, config = {}) {
  const prefix = config.titlePrefix ? `[${config.titlePrefix}] ` : '';
  const lines = [`${prefix}${event.title}`, `Severity: ${String(event.severity || 'info').toUpperCase()}`, `Source: ${event.source || 'Console'}`];
  if (event.body) lines.push(event.body);
  if (event.route) lines.push(event.route);
  return lines.join('\n').slice(0, 3500);
}

function retryAfterMs(headers, body) {
  const header = headers?.get ? headers.get('retry-after') : headers?.['retry-after'];
  const seconds = Number(header || body?.retry_after || 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : null;
}

function classifyHttp(response, body = {}) {
  if (response.ok) return { kind: 'accepted', code: String(response.status) };
  if (response.status === 429 || response.status >= 500) return { kind: 'retryable', code: String(response.status), retryAfterMs: retryAfterMs(response.headers, body) };
  return { kind: 'permanent', code: String(response.status) };
}

module.exports = { PROVIDERS, SEVERITIES, channelInput, classifyHttp, emailList, maskTarget, messageFor, normalizedEvent, redact, retryAfterMs, safeUrl };
