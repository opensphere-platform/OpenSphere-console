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
test('C_EXT proxy rejects declared and streamed responses beyond the configured bound', async () => {
  const target = async ({ serviceId }) => ({ serviceId });
  const declared = createPluginProxy({
    resolveTarget: target,
    responseMaximumBytes: 1024,
    async fetchImpl() {
      return new Response('small', { headers: { 'content-length': '1025' } });
    },
  });
  await assert.rejects(declared({
    method: 'GET', url: new URL('http://owner/api/plugins/sample'), actor,
  }), (error) => error.status === 502 && /configured limit/u.test(error.message));

  const streamed = createPluginProxy({
    resolveTarget: target,
    responseMaximumBytes: 1024,
    async fetchImpl() {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(700));
          controller.enqueue(new Uint8Array(700));
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
    },
  });
  const result = await streamed({
    method: 'GET', url: new URL('http://owner/api/plugins/sample'), actor,
  });
  await assert.rejects(new Response(result.body).arrayBuffer(), /configured limit/u);
});

test('C_EXT proxy validates the configured response bound', () => {
  assert.throws(() => createPluginProxy({
    async resolveTarget() {}, async fetchImpl() {}, responseMaximumBytes: 1023,
  }), /response limit/u);
});
