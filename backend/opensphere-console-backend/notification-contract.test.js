'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizeRule, publicChannel } = require('./notification-api');

test('notification admin API never returns stored provider config or credentials', () => {
  const value = publicChannel({
    id: 'channel-1', name: 'On-call', provider: 'slack', channel_type: 'chat', enabled: true,
    health_state: 'Healthy', config: { target: '#ops', webhookUrl: 'https://hooks.slack.com/services/secret' },
    credential_configured: true, secret_version: 2, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(value.target, '#ops');
  assert.equal('config' in value, false);
  assert.equal(JSON.stringify(value).includes('hooks.slack.com'), false);
});

test('notification rules require a valid severity and at least one channel', () => {
  assert.throws(() => normalizeRule({ name: 'Errors', minSeverity: 'emergency', channelIds: ['a'.repeat(36)] }), { code: 400 });
  assert.throws(() => normalizeRule({ name: 'Errors', channelIds: [] }), { code: 400 });
  const rule = normalizeRule({ name: 'Errors', minSeverity: 'error', channelIds: ['a'.repeat(36), 'a'.repeat(36)], sources: ['audit', 'audit'] });
  assert.deepEqual(rule.channelIds, ['a'.repeat(36)]);
  assert.deepEqual(rule.sources, ['audit']);
});

test('Console UI uses an audited side-panel action instead of browser prompt dialogs', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/app/pages/admin-external-channels.ts'), 'utf8');
  assert.match(source, /pendingAction/);
  assert.match(source, /테스트 수신 메일 주소/);
  assert.match(source, /testRecipient/);
  assert.match(source, /editSmtp/);
  assert.match(source, /기존 자격 증명을 유지합니다/);
  assert.doesNotMatch(source, /window\.prompt|window\.confirm/);
});

test('Console Shell proxies notification administration to the Console Backend', () => {
  const nginx = fs.readFileSync(path.join(__dirname, '../../nginx/default.conf.template'), 'utf8');
  assert.match(nginx, /location \/api\/notifications\//);
  assert.match(nginx, /opensphere-console-backend\.opensphere-console\.svc\.cluster\.local/);
});

test('notification inbox reads Console audit without changing the plugin event contract', () => {
  const client = fs.readFileSync(path.join(__dirname, '../../src/app/core/plugin-control-client.service.ts'), 'utf8');
  const inbox = fs.readFileSync(path.join(__dirname, '../../src/app/core/notification.service.ts'), 'utf8');
  const pluginEvents = client.slice(client.indexOf('async events()'), client.indexOf('async auditEvents()'));
  const auditEvents = client.slice(client.indexOf('async auditEvents()'), client.indexOf('async bindings()'));

  assert.match(pluginEvents, /\/api\/admin\/plugins\/events/);
  assert.match(auditEvents, /\/api\/identity\/audit/);
  assert.match(inbox, /this\.control\.auditEvents\(\)/);
  assert.match(inbox, /실제 정본은 DUPA 런타임이 아니라 Supabase audit\.event/);
  assert.match(inbox, /기존 읽음 상태\(localStorage\)와 알림 ID를 보존/);
});

test('notification migration isolates ciphertext and dispatcher-only RPCs', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0011_notification_delivery.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS console\.notification_secret/);
  assert.match(migration, /notification_store_secret/);
  assert.match(migration, /notification_read_secret/);
  assert.match(migration, /opensphere_notification_dispatcher/);
  assert.match(migration, /GRANT opensphere_notification_dispatcher TO authenticator/);
  assert.match(migration, /dispatcher_notification_channel_update/);
  assert.match(migration, /GRANT UPDATE ON console\.notification_channel TO opensphere_notification_dispatcher/);
  assert.match(migration, /REVOKE ALL ON console\.notification_secret[\s\S]+opensphere_console_backend[\s\S]+opensphere_notification_dispatcher/);
});

test('OAA notification owner facade is sanitized, permission-gated, AAL2, and closed-schema', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const verify = source.slice(source.indexOf('async function verifyOaaNotificationOwner'), source.indexOf('async function publishNotificationEvent'));
  const status = source.slice(source.indexOf('async function oaaNotificationStatus'), source.indexOf('function requireClosedOaaNotificationBody'));
  const action = source.slice(source.indexOf('async function oaaNotificationOwnerAction'), source.indexOf('async function publishNotificationEvent'));
  assert.match(verify, /console\.notification\.read/);
  assert.match(verify, /console\.notification\.manage/);
  assert.match(verify, /actor\.assurance !== 'aal2'/);
  assert.match(status, /Message bodies, titles, routes, provider message IDs and recipients are/);
  assert.doesNotMatch(status, /title:|route:|providerMessageId:|target:/);
  assert.match(action, /requireClosedOaaNotificationBody/);
  assert.match(action, /requireExactOaaConfirmation/);
  assert.doesNotMatch(action, /testRecipient|smtp|password|secret/i);
  assert.match(source, /\/api\/oaa\/owner\/notifications\/status/);
  assert.match(source, /\/api\/oaa\/owner\/notifications\/actions/);
});
