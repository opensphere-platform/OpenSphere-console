'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createCommandService } = require('./commands');
const id = '11111111-1111-4111-8111-111111111111';
const input = { command: 'console.modules.install', arguments: { descriptorId: 'extension.platform-support', catalogRevision: 'sha256:' + 'a'.repeat(64), reason: 'requested L4 installation' }, requestId: id };
test('native installation works without an installed owner and preserves the caller and durable installation key', async () => {
  const calls = [], records = new Map();
  const service = createCommandService({ identityUrl: 'http://identity.test', loadProviders: async () => [],
    readProfile: () => JSON.stringify({ consoleUrl: 'https://localhost:1114', channel: 'edge' }),
    ledger: { async claim(a, key) { return records.has(key) ? { result: records.get(key) } : { claimed: true }; }, async finish(a, key, digest, value) { records.set(key, value); } },
    fetchImpl: async (url, init) => { calls.push({ url, init });
      if (url.endsWith('/api/identity/me')) return Response.json({ schemaVersion: '1.0', authority: 'SupabaseAuth', freshness: 'fresh', observedAt: new Date().toISOString(),
        data: { state: 'Active', subjectId: id, sessionId: id, permissions: ['console.role.admin', 'console.extension.install'], aal: 'aal1' } });
      return Response.json({ operationId: id, state: 'Submitted' }, { status: 202 });
    } });
  const req = { headers: { authorization: 'Bearer ' + 'u'.repeat(48) } };
  assert.ok((await service.catalog(req)).commands.some(c => c.id === 'console.modules.install' && c.allowed));
  assert.equal((await service.execute(req, input)).body.owner, 'console');
  assert.equal((await service.execute(req, input)).body.replayed, true);
  const sent = calls.filter(c => c.url.endsWith('/extensions/install'));
  assert.equal(sent.length, 1); assert.equal(sent[0].init.headers['x-os-owner-admission'], 'os-shell-control-v1');
  assert.match(sent[0].init.headers['x-os-idempotency-key'], /^os-shell-install-[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(sent[0].init.body), input.arguments);
});
