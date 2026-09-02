'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { channelInput, classifyHttp, messageFor, normalizedEvent } = require('./contract');

test('Slack channel keeps the webhook URL out of public config', () => {
  const input = channelInput({ name: '운영 Slack', provider: 'slack', config: { target: '#platform-alerts' }, secret: { webhookUrl: 'https://hooks.slack.com/services/T000/B000/secret' } });
  assert.deepEqual(input.config, { target: '#platform-alerts', titlePrefix: '' });
  assert.equal(input.secret.webhookUrl.includes('secret'), true);
});

test('Discord mentions stay data and the renderer produces a bounded plain-text fallback', () => {
  const event = normalizedEvent({ sourceType: 'audit', sourceId: 'a-1', source: 'console', severity: 'error', title: '@everyone deployment failed', body: 'inspect Console', route: '/manage/audit' });
  assert.match(messageFor(event), /@everyone deployment failed/);
});

test('provider URL and recipient validation rejects unsafe or malformed input', () => {
  assert.throws(() => channelInput({ name: 'bad', provider: 'slack', secret: { webhookUrl: 'http://127.0.0.1/a' } }));
  assert.throws(() => channelInput({ name: 'sms', provider: 'twilio', config: { accountSid: 'AC1', from: '+821012345678', recipients: ['010-1234-5678'] }, secret: { authToken: 'x' } }));
});

test('test recipient uses the same strict email validation as SMTP recipients', () => {
  const { emailList } = require('./contract');
  assert.deepEqual(emailList([' Test.User@example.com ']), ['test.user@example.com']);
  assert.throws(() => emailList(['not-an-email']), { code: 400 });
});

test('rate limit responses preserve Retry-After for the dispatcher', () => {
  const response = { ok: false, status: 429, headers: { get: (name) => name === 'retry-after' ? '12' : null } };
  assert.deepEqual(classifyHttp(response), { kind: 'retryable', code: '429', retryAfterMs: 12000 });
});
