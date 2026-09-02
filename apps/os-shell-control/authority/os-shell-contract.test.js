'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ATTACH_PROTOCOL,
  canonicalPermissionRevision,
  createAttachTicket,
  hashAttachTicket,
  normalizeAttachTicketExpiry,
  normalizeOrigin,
  normalizeReleaseEvidence,
  normalizeSessionIntent,
  permissionRevisionPayload,
} = require('./os-shell-contract');

test('SessionIntent is the closed console-only client contract', () => {
  assert.deepEqual(normalizeSessionIntent({}), { networkProfile: 'console-only' });
  assert.deepEqual(normalizeSessionIntent({ networkProfile: 'console-only' }), { networkProfile: 'console-only' });
  assert.throws(() => normalizeSessionIntent({ image: 'alpine' }), { code: 'PrivilegeEscalationAttempt' });
  assert.throws(() => normalizeSessionIntent({ runtimeClassName: 'kata' }), { code: 'PrivilegeEscalationAttempt' });
  assert.throws(() => normalizeSessionIntent({ networkProfile: 'internet' }), { code: 'NetworkProfileUnavailable' });
  assert.equal(ATTACH_PROTOCOL, 'opensphere.pty.v1');
});

test('permission revision is deterministic, sorted, deduplicated, and credential-bound', () => {
  const a = { credentialRevision: 7, roles: ['console-operators', 'console-admins'], permissions: ['session:attach', 'console.read'] };
  const b = { credentialRevision: 7, roles: ['console-admins', 'console-operators', 'console-admins'], permissions: ['console.read', 'session:attach'] };
  assert.equal(permissionRevisionPayload(a), 'credentialRevision=7\nroles=console-admins\x1fconsole-operators\npermissions=console.read\x1fsession:attach');
  assert.equal(canonicalPermissionRevision(a), canonicalPermissionRevision(b));
  assert.notEqual(canonicalPermissionRevision(a), canonicalPermissionRevision({ ...a, credentialRevision: 8 }));
  assert.notEqual(canonicalPermissionRevision(a), canonicalPermissionRevision({ ...a, permissions: ['console.read'] }));
});

test('attach tickets are 256-bit, hash-only, and limited to 30 seconds', () => {
  const issued = createAttachTicket();
  assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.match(issued.ticketHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(hashAttachTicket(issued.ticket), issued.ticketHash);
  assert.throws(() => hashAttachTicket('short'), { code: 'AttachTicketInvalid' });
  assert.equal(normalizeAttachTicketExpiry('2026-08-15T00:00:29.000Z', { now: Date.parse('2026-08-15T00:00:00.000Z') }), '2026-08-15T00:00:29.000Z');
  assert.throws(() => normalizeAttachTicketExpiry('2026-08-15T00:00:31.000Z', { now: Date.parse('2026-08-15T00:00:00.000Z') }), { code: 'AttachTicketExpiryInvalid' });
});

test('production origins and release evidence are strict', () => {
  assert.equal(normalizeOrigin('https://console.example.test'), 'https://console.example.test');
  assert.throws(() => normalizeOrigin('http://localhost:4200'), { code: 'OriginInvalid' });
  assert.equal(normalizeOrigin('http://localhost:4200', { allowLoopbackHttp: true }), 'http://localhost:4200');
  const digest = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(normalizeReleaseEvidence({
    releaseEvidenceRef: 'release://console/202608150100', manifestSha256: digest, keyId: 'edge-local-1',
    runtimeImageDigest: digest, osArtifactDigest: digest, sessionPolicyRevision: 'shell-policy-v1',
  }), {
    releaseEvidenceRef: 'release://console/202608150100', manifestSha256: digest, keyId: 'edge-local-1',
    runtimeImageDigest: digest, osArtifactDigest: digest, sessionPolicyRevision: 'shell-policy-v1',
  });
});
