'use strict';

const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { channelInput, classifyHttp, emailList, messageFor } = require('./contract');

const PORT = Number(process.env.PORT || 8081);
const REST_URL = String(process.env.SUPABASE_REST_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const ISSUER = process.env.SUPABASE_AUTH_ISSUER || '';
const AUDIENCE = process.env.SUPABASE_AUTH_AUDIENCE || 'authenticated';
const INTERNAL_TOKEN = process.env.NOTIFICATION_DISPATCHER_TOKEN || '';
const WORKER_ID = process.env.HOSTNAME || `notification-dispatcher-${process.pid}`;
const POLL_MS = Math.max(1000, Number(process.env.NOTIFICATION_POLL_MS || 3000));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.NOTIFICATION_MAX_ATTEMPTS || 8));
const SMTP_ALLOWED_HOSTS = String(process.env.NOTIFICATION_SMTP_ALLOWED_HOSTS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);

function base64url(value) { return Buffer.from(value).toString('base64url'); }
function dispatcherToken() {
  if (!JWT_SECRET || !ISSUER) throw { code: 503, msg: 'dispatcher Supabase JWT configuration is missing' };
  const now = Math.floor(Date.now() / 1000);
  const head = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, role: 'opensphere_notification_dispatcher', sub: 'opensphere-notification-dispatcher', iat: now, exp: now + 3600 }));
  const signed = `${head}.${body}`;
  return `${signed}.${createHmac('sha256', JWT_SECRET).update(signed).digest('base64url')}`;
}

function headers() {
  if (!REST_URL || !SERVICE_KEY) throw { code: 503, msg: 'dispatcher Supabase REST configuration is missing' };
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${dispatcherToken()}`, accept: 'application/json', 'content-type': 'application/json', 'accept-profile': 'console', 'content-profile': 'console' };
}

async function rest(resource, { method = 'GET', query = '', body, prefer = 'return=representation' } = {}) {
  const url = new URL(`${REST_URL}/${resource}`);
  if (query) url.search = query;
  const response = await fetch(url, { method, headers: { ...headers(), Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  let output = [];
  try { output = text ? JSON.parse(text) : []; } catch { output = text; }
  if (!response.ok) throw { code: response.status, msg: `Supabase ${resource} ${method} failed`, detail: String(text).slice(0, 300) };
  return output;
}

function encryptionKey() {
  const raw = Buffer.from(process.env.NOTIFICATION_ENCRYPTION_KEY || '', 'base64');
  if (raw.length !== 32) throw { code: 503, msg: 'NOTIFICATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key' };
  return raw;
}

function cipherSecret(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const json = JSON.stringify(secret);
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), digest: `sha256:${createHash('sha256').update(json).digest('hex')}` };
}

function decipherSecret(row) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(row.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
  const json = Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  const digest = `sha256:${createHash('sha256').update(json).digest('hex')}`;
  if (!safeEqual(digest, row.plaintext_digest)) throw { code: 500, msg: 'notification secret integrity check failed' };
  return JSON.parse(json);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertAllowedSmtpHost(host) {
  const value = String(host || '').toLowerCase();
  const allowed = SMTP_ALLOWED_HOSTS.some((entry) => entry === value || (entry.startsWith('*.') && value.endsWith(entry.slice(1))));
  if (!allowed) throw { code: 400, msg: 'SMTP host is not in NOTIFICATION_SMTP_ALLOWED_HOSTS' };
}

async function storeSecret(channelId, input) {
  const parsed = channelInput(input);
  if (parsed.provider === 'smtp') assertAllowedSmtpHost(parsed.config.host);
  const current = await rest('notification_channel', { query: `select=secret_version&id=eq.${encodeURIComponent(channelId)}&deleted_at=is.null` });
  if (!current[0]) throw { code: 404, msg: 'notification channel not found' };
  const version = Number(current[0].secret_version || 0) + 1;
  const encrypted = cipherSecret(parsed.secret);
  await rest('rpc/notification_store_secret', { method: 'POST', body: { p_channel_id: channelId, p_version: version, p_iv: encrypted.iv, p_auth_tag: encrypted.authTag, p_ciphertext: encrypted.ciphertext, p_plaintext_digest: encrypted.digest } });
  await rest('notification_channel', { method: 'PATCH', query: `id=eq.${encodeURIComponent(channelId)}`, body: { credential_configured: true, secret_version: version, health_state: 'Draft', updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
  return { version };
}

async function updateChannelConfiguration(channelId, input) {
  const current = await rest('notification_channel', { query: `select=*&id=eq.${encodeURIComponent(channelId)}&deleted_at=is.null` });
  if (!current[0]) throw { code: 404, msg: 'notification channel not found' };
  if (current[0].provider !== 'smtp') throw { code: 400, msg: 'only SMTP channel configuration can be edited' };
  const suppliedSecret = input?.secret && typeof input.secret === 'object' && (String(input.secret.username || '').trim() || String(input.secret.password || '').trim());
  const secret = suppliedSecret ? input.secret : await secretFor(channelId);
  const parsed = channelInput({ name: input?.name, provider: current[0].provider, config: input?.config, secret });
  assertAllowedSmtpHost(parsed.config.host);
  if (suppliedSecret) await storeSecret(channelId, parsed);
  await rest('notification_channel', { method: 'PATCH', query: `id=eq.${encodeURIComponent(channelId)}`, body: { name: parsed.name, config: parsed.config, health_state: 'Draft', updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
  return { ok: true, credentialConfigured: true };
}

async function secretFor(channelId) {
  const rows = await rest('rpc/notification_read_secret', { method: 'POST', body: { p_channel_id: channelId } });
  if (!rows[0]) throw { code: 409, msg: 'notification credentials are not configured' };
  return decipherSecret(rows[0]);
}

async function sendSlack(config, secret, event) {
  const response = await fetch(secret.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: messageFor(event, config) }), signal: AbortSignal.timeout(10000), redirect: 'error' });
  const body = await response.text();
  return { ...classifyHttp(response), providerMessageId: '', detail: body.slice(0, 200) };
}

async function sendDiscord(config, secret, event) {
  const url = new URL(secret.webhookUrl);
  url.searchParams.set('wait', 'true');
  if (config.threadId) url.searchParams.set('thread_id', config.threadId);
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'OpenSphere-Notification-Dispatcher/0.1' }, body: JSON.stringify({ content: messageFor(event, config).slice(0, 2000), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10000), redirect: 'error' });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return { ...classifyHttp(response, body), providerMessageId: body.id || '', detail: text.slice(0, 200) };
}

async function sendTwilio(config, secret, event) {
  const form = new URLSearchParams({ To: config.recipients[0], Body: messageFor(event, config).slice(0, 1500) });
  const statusCallback = String(process.env.NOTIFICATION_TWILIO_STATUS_CALLBACK_URL || '').trim();
  if (statusCallback) form.set('StatusCallback', statusCallback);
  if (config.messagingServiceSid) form.set('MessagingServiceSid', config.messagingServiceSid); else form.set('From', config.from);
  const auth = Buffer.from(`${config.accountSid}:${secret.authToken}`).toString('base64');
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(10000), redirect: 'error' });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return { ...classifyHttp(response, body), providerMessageId: body.sid || '', detail: text.slice(0, 200) };
}

function smtpConnection(config) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject({ kind: 'retryable', code: 'smtp-connect', detail: error.message });
    const socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: true }, () => resolve(socket))
      : net.connect({ host: config.host, port: config.port }, () => resolve(socket));
    socket.once('error', onError);
  });
}

function smtpReader(socket) {
  let buffered = '';
  const waiting = [];
  socket.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    const lines = buffered.split('\r\n');
    buffered = lines.pop();
    for (const line of lines) {
      if (!/^\d{3}[ -]/.test(line) || !/^\d{3} /.test(line)) continue;
      const next = waiting.shift();
      if (next) next.resolve(line);
    }
  });
  socket.on('error', (error) => { while (waiting.length) waiting.shift().reject(error); });
  return () => new Promise((resolve, reject) => waiting.push({ resolve, reject }));
}

async function smtpSend(config, secret, event) {
  assertAllowedSmtpHost(config.host);
  let socket = await smtpConnection(config);
  let next = smtpReader(socket);
  const expect = async (accepted) => {
    const line = await next();
    const code = Number(line.slice(0, 3));
    if (!accepted.includes(code)) throw { kind: code >= 500 ? 'permanent' : 'retryable', code: `smtp-${code}`, detail: line };
    return line;
  };
  const command = async (line, accepted = [250]) => { socket.write(`${line}\r\n`); return expect(accepted); };
  try {
    await expect([220]);
    await command(`EHLO ${process.env.NOTIFICATION_SMTP_HELO || 'opensphere-console'}`);
    if (!config.secure && config.starttls) {
      await command('STARTTLS', [220]);
      socket = tls.connect({ socket, servername: config.host, rejectUnauthorized: true });
      await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
      next = smtpReader(socket);
      await command(`EHLO ${process.env.NOTIFICATION_SMTP_HELO || 'opensphere-console'}`);
    }
    const auth = Buffer.from(`\u0000${secret.username}\u0000${secret.password}`).toString('base64');
    await command(`AUTH PLAIN ${auth}`, [235]);
    await command(`MAIL FROM:<${config.from}>`);
    for (const recipient of config.recipients) await command(`RCPT TO:<${recipient}>`, [250, 251]);
    await command('DATA', [354]);
    const subject = `${config.titlePrefix ? `[${config.titlePrefix}] ` : ''}${event.title}`.replace(/[\r\n]/g, ' ');
    const body = messageFor(event, config).replace(/^\./gm, '..');
    socket.write(`From: <${config.from}>\r\nTo: ${config.recipients.join(', ')}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n.\r\n`);
    await expect([250]);
    socket.write('QUIT\r\n');
    socket.end();
    return { kind: 'accepted', code: 'smtp-250', providerMessageId: '' };
  } catch (error) {
    socket.destroy();
    if (error?.kind) return error;
    return { kind: 'retryable', code: 'smtp-error', detail: error?.message || String(error) };
  }
}

async function send(channel, secret, event) {
  const config = channel.config || {};
  if (channel.provider === 'slack') return sendSlack(config, secret, event);
  if (channel.provider === 'discord') return sendDiscord(config, secret, event);
  if (channel.provider === 'smtp') return smtpSend(config, secret, event);
  return sendTwilio(config, secret, event);
}

function nextAttempt(attemptCount, retryAfterMs) {
  const bounded = Math.min(60 * 60 * 1000, 1000 * (2 ** Math.min(attemptCount, 10)));
  const jitter = Math.floor(Math.random() * Math.max(250, bounded * 0.25));
  return new Date(Date.now() + Math.max(retryAfterMs || 0, bounded + jitter)).toISOString();
}

async function deliveryContext(id) {
  const rows = await rest('notification_delivery', { query: `select=*&id=eq.${encodeURIComponent(id)}` });
  const delivery = rows[0];
  if (!delivery) throw { code: 404, msg: 'notification delivery not found' };
  const [events, channels] = await Promise.all([
    rest('notification_event', { query: `select=*&id=eq.${encodeURIComponent(delivery.event_id)}` }),
    rest('notification_channel', { query: `select=*&id=eq.${encodeURIComponent(delivery.channel_id)}` }),
  ]);
  if (!events[0] || !channels[0]) throw { code: 409, msg: 'notification delivery references unavailable data' };
  return { delivery, event: { source: events[0].source, severity: events[0].severity, title: events[0].title, body: events[0].body, route: events[0].route }, channel: channels[0] };
}

async function completeDelivery(context, result, startedAt) {
  const attempt = Number(context.delivery.attempt_count || 0) + 1;
  const now = new Date().toISOString();
  const latency = Math.max(0, Date.now() - startedAt);
  const terminal = result.kind === 'accepted' || result.kind === 'delivered';
  const exhausted = result.kind === 'retryable' && attempt >= MAX_ATTEMPTS;
  const status = terminal ? result.kind : (result.kind === 'permanent' ? 'failed' : (exhausted ? 'dead-letter' : 'retrying'));
  await rest('notification_attempt', { method: 'POST', body: [{ delivery_id: context.delivery.id, attempt_number: attempt, worker_id: WORKER_ID, outcome: result.kind === 'permanent' ? 'permanent' : (terminal ? result.kind : 'retryable'), provider_code: result.code || null, provider_message_id: result.providerMessageId || null, retry_after_ms: result.retryAfterMs || null, latency_ms: latency, error_class: terminal ? null : result.kind, error_message: terminal ? null : String(result.detail || result.code || '').slice(0, 500), completed_at: now }] });
  const patch = { status, attempt_count: attempt, provider_message_id: result.providerMessageId || context.delivery.provider_message_id || null, last_error_class: terminal ? null : result.kind, last_error_code: terminal ? null : result.code || 'delivery-error', locked_at: null, lock_owner: null, updated_at: now };
  if (terminal) { patch.accepted_at = now; patch.completed_at = now; }
  if (status === 'retrying') patch.next_attempt_at = nextAttempt(attempt, result.retryAfterMs);
  if (status === 'dead-letter' || status === 'failed') patch.completed_at = now;
  await rest('notification_delivery', { method: 'PATCH', query: `id=eq.${encodeURIComponent(context.delivery.id)}`, body: patch, prefer: 'return=minimal' });
  const health = terminal ? 'Healthy' : (result.kind === 'permanent' ? 'Misconfigured' : 'Degraded');
  await rest('notification_channel', { method: 'PATCH', query: `id=eq.${encodeURIComponent(context.channel.id)}`, body: { health_state: health, last_success_at: terminal ? now : context.channel.last_success_at, updated_at: now }, prefer: 'return=minimal' });
}

let polling = false;
async function runOnce() {
  if (polling) return;
  polling = true;
  try {
    const events = await rest('rpc/notification_claim_events', { method: 'POST', body: { p_worker_id: WORKER_ID, p_limit: 25 } });
    for (const event of events) await rest('rpc/notification_materialize_deliveries', { method: 'POST', body: { p_event_id: event.id } });
    const deliveries = await rest('rpc/notification_claim_deliveries', { method: 'POST', body: { p_worker_id: WORKER_ID, p_limit: 25 } });
    for (const delivery of deliveries) {
      const startedAt = Date.now();
      try {
        const context = await deliveryContext(delivery.id);
        const result = await send(context.channel, await secretFor(context.channel.id), context.event);
        await completeDelivery(context, result, startedAt);
      } catch (error) {
        const context = await deliveryContext(delivery.id).catch(() => null);
        if (context) await completeDelivery(context, { kind: 'retryable', code: error?.code ? String(error.code) : 'worker-error', detail: error?.msg || error?.message || String(error) }, startedAt);
      }
    }
  } finally { polling = false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > 64 * 1024) { reject({ code: 413, msg: 'payload too large' }); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject({ code: 400, msg: 'invalid json body' }); } });
    req.on('error', reject);
  });
}
function json(res, code, value) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
function internal(req) { return Boolean(INTERNAL_TOKEN) && safeEqual(req.headers['x-notification-dispatcher-token'], INTERNAL_TOKEN); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (url.pathname === '/readyz') { encryptionKey(); headers(); return json(res, 200, { ready: true, workerId: WORKER_ID }); }
    const credential = url.pathname.match(/^\/internal\/channels\/([0-9a-fA-F-]+)\/credentials$/);
    if (credential && req.method === 'POST') {
      if (!internal(req)) return json(res, 401, { error: 'internal dispatcher authentication required' });
      return json(res, 200, await storeSecret(credential[1], await readBody(req)));
    }
    const configuration = url.pathname.match(/^\/internal\/channels\/([0-9a-fA-F-]+)\/configuration$/);
    if (configuration && req.method === 'POST') {
      if (!internal(req)) return json(res, 401, { error: 'internal dispatcher authentication required' });
      return json(res, 200, await updateChannelConfiguration(configuration[1], await readBody(req)));
    }
    const testPath = url.pathname.match(/^\/internal\/channels\/([0-9a-fA-F-]+)\/test$/);
    if (testPath && req.method === 'POST') {
      if (!internal(req)) return json(res, 401, { error: 'internal dispatcher authentication required' });
      const channels = await rest('notification_channel', { query: `select=*&id=eq.${encodeURIComponent(testPath[1])}&deleted_at=is.null` });
      if (!channels[0]) return json(res, 404, { error: 'notification channel not found' });
      const rawTestRecipient = String((await readBody(req))?.testRecipient || '').trim();
      const testRecipient = rawTestRecipient ? emailList([rawTestRecipient])[0] : '';
      if (testRecipient && channels[0].provider !== 'smtp') throw { code: 400, msg: 'a test recipient is supported only for SMTP channels' };
      const testChannel = testRecipient ? { ...channels[0], config: { ...(channels[0].config || {}), recipients: [testRecipient] } } : channels[0];
      const result = await send(testChannel, await secretFor(channels[0].id), { source: 'OpenSphere Console', severity: 'info', title: 'OpenSphere 외부 채널 테스트', body: '이 메시지는 채널 연결 검증용 테스트입니다.', route: '' });
      const accepted = result.kind === 'accepted' || result.kind === 'delivered';
      await rest('notification_channel', { method: 'PATCH', query: `id=eq.${encodeURIComponent(channels[0].id)}`, body: { last_test_status: accepted ? 'accepted' : 'failed', last_test_at: new Date().toISOString(), last_test_error_code: accepted ? null : result.code || 'test-failed', health_state: accepted ? 'Healthy' : (result.kind === 'permanent' ? 'Misconfigured' : 'Degraded'), updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
      return json(res, accepted ? 200 : 502, { accepted, code: result.code || '', providerMessageId: result.providerMessageId || '' });
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) { return json(res, error?.code || 500, { error: error?.msg || error?.message || 'dispatcher failed' }); }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`opensphere-notification-dispatcher listening :${PORT}`));
  void runOnce().catch((error) => console.error('[notification-dispatcher] initial poll failed', error));
  setInterval(() => void runOnce().catch((error) => console.error('[notification-dispatcher] poll failed', error)), POLL_MS).unref();
}

module.exports = { cipherSecret, decipherSecret, nextAttempt, runOnce, send, server };
