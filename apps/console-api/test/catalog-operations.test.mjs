import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createCatalogOperations } from '../src/catalog-operations.mjs';
import { createConsoleApiHandler } from '../src/http-handler.mjs';

const revision = 'sha256:' + 'a'.repeat(64);
const descriptors = [
  {
    id: 'cbss.opensphere-console', class: 'coreService', displayName: 'OpenSphere Console', domain: 'console',
    owner: { id: 'cbss.console', lifecycleApi: '/api/health' }, capabilities: ['main-shell'],
  },
  {
    id: 'module.postgresql', class: 'installableModule', displayName: 'PostgreSQL', domain: 'data',
    owner: { id: 'pfss.postgresql', lifecycleApi: '' }, capabilities: ['database'],
  },
];

function fixture() {
  const reads = [];
  const operations = createCatalogOperations({
    registryResolver: {
      async readCatalogSnapshot(input) {
        reads.push(input);
        return { schema: 'opensphere.registry-catalog/v1', revision, descriptors };
      },
    },
  });
  return { operations, reads };
}

test('Catalog projection maps Registry descriptors without Kubernetes authority', async () => {
  const { operations, reads } = fixture();
  const all = await operations.listEntities({ limit: '200', correlationId: 'catalog-correlation-0001' });
  assert.deepEqual(all.map(({ kind, metadata }) => `${kind}:${metadata.name}`), [
    'API:cbss.opensphere-console', 'Component:cbss.opensphere-console', 'Component:module.postgresql',
  ]);
  assert.equal(all[0].spec.definition, '/api/health');
  assert.deepEqual(reads, [{ correlationId: 'catalog-correlation-0001' }]);

  const apis = await operations.listEntities({ filter: 'kind=api', limit: '1' });
  assert.deepEqual(apis.map(({ kind }) => kind), ['API']);
  await assert.rejects(operations.listEntities({ filter: 'kind=component' }), { code: 'ValidationFailed', status: 400 });
  await assert.rejects(operations.listEntities({ limit: '201' }), { code: 'ValidationFailed', status: 400 });
});

test('Runtime Resources preserves the empty read projection and rejects a mismatched entity', async () => {
  const { operations } = fixture();
  assert.deepEqual(await operations.runtimeResources({
    entityName: 'cbss.opensphere-console', body: { entity: { metadata: { name: 'cbss.opensphere-console' } } },
  }), { items: [] });
  await assert.rejects(operations.runtimeResources({
    entityName: 'cbss.opensphere-console', body: { entity: { metadata: { name: 'different' } } },
  }), { code: 'ValidationFailed', status: 400 });
});

test('HTTP Catalog and Runtime Resources routes use the target session authority', async (t) => {
  const { operations } = fixture();
  const sessions = [];
  const server = createServer(createConsoleApiHandler({
    async resolveSession(_request, input) { sessions.push(input); return { subjectId: 'operator-1' }; },
    catalogOperations: operations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const catalog = await fetch(base + '/api/catalog/entities?filter=kind=api&limit=200', {
    headers: { 'x-os-correlation-id': 'catalog-correlation-0002' },
  });
  assert.equal(catalog.status, 200);
  assert.deepEqual((await catalog.json()).map(({ kind }) => kind), ['API']);

  const runtime = await fetch(base + '/api/kubernetes/services/cbss.opensphere-console', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-os-correlation-id': 'runtime-correlation-0001' },
    body: JSON.stringify({ entity: { metadata: { name: 'cbss.opensphere-console' } } }),
  });
  assert.equal(runtime.status, 200);
  assert.deepEqual(await runtime.json(), { items: [] });
  assert.equal(sessions.length, 2);
  assert(sessions.every(({ requireCsrf }) => requireCsrf === false));
});
