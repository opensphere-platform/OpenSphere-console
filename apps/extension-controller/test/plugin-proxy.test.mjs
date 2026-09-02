import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginProxy, pluginRoute } from '../src/plugin-proxy.mjs';

const actor = Object.freeze({
  subjectId: '11111111-1111-4111-8111-111111111111',
  browserSessionId: '22222222-2222-4222-8222-222222222222',
  permissionRevision: 7, revokeEpoch: 4, assurance: 'aal2', permissions: ['console.role.viewer'],
});

test('C_EXT proxy resolves an exact governed service and never forwards browser or Owner credentials', async () => {
  const calls = [];
  const proxy = createPluginProxy({
    pluginNamespace: 'opensphere-console',
    async resolveTarget(input) { return { ...input, packageId: 'sample', servingMode: 'Current' }; },
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return new Response('export const ready = true;', {
        status: 200, headers: { 'content-type': 'text/javascript', 'set-cookie': 'forbidden=1', 'x-private': 'no' },
      });
    },
  });
  const result = await proxy({
    method: 'GET', url: new URL('http://owner/api/plugins/sample-r-abcdef/plugins/main.js?v=1'), actor,
    headers: { authorization: 'Bearer owner.secret.token', cookie: 'raw=1', accept: 'text/javascript', 'x-os-correlation-id': 'c-1' },
  });
  assert.equal(calls[0].url, 'http://sample-r-abcdef.opensphere-console.svc.cluster.local:8080/plugins/main.js?v=1');
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[0].options.headers.cookie, undefined);
  assert.equal(calls[0].options.headers['x-os-subject-id'], actor.subjectId);
  assert.equal(calls[0].options.headers['x-os-permission-revision'], '7');
  assert.deepEqual(result.headers, { 'content-type': 'text/javascript' });
  assert.equal(await new Response(result.body).text(), 'export const ready = true;');
});

test('C_EXT proxy closes method, path and resolver authority', async () => {
  assert.throws(() => pluginRoute('/api/plugins/os-cli'), (error) => error.status === 404);
  const proxy = createPluginProxy({ async resolveTarget() { return null; }, async fetchImpl() { throw new Error('must not run'); } });
  await assert.rejects(proxy({ method: 'TRACE', url: new URL('http://owner/api/plugins/sample'), actor }), (error) => error.status === 405);
  await assert.rejects(proxy({ method: 'GET', url: new URL('http://owner/api/plugins/sample'), actor }), (error) => error.status === 403);
});