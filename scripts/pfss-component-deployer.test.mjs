import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const deployer = readFileSync(resolve(root, 'scripts', 'Deploy-LocalEdgeBackendComponent.ps1'), 'utf8');

test('PFSS deployer accepts only the signed Backend and OAA Gateway publication', () => {
  assert.match(deployer, /\$expectedComponents = @\('backend','oaaGateway'\)/);
  assert.match(deployer, /Test-OsShellEdgeSignedDocument/);
  assert.match(deployer, /componentPublication=\$binding/);
  assert.match(deployer, /publicationDocument=\$publicationJson/);
  assert.match(deployer, /publicationSignature=\$signatureJson/);
  assert.match(deployer, /opensphere-console-backend/);
  assert.match(deployer, /opensphere-console-oaa-gateway/);
  assert.match(deployer, /exact two-component local-edge contract/);
  assert.match(deployer, /component publication binding is not exact/);
});

test('PFSS deployer submits one governed request and resumes response loss without raw mutation', async () => {
  assert.match(deployer, /\/api\/platform\/releases\/local-edge-automation\/pfss/);
  assert.match(deployer, /never replay a mutation/);
  assert.match(deployer, /Invoke-RestMethod -Method Get/);
  assert.match(deployer, /receipt does not bind the signed target digest/);
  assert.match(deployer, /create','token','opensphere-local-edge-release/);
  assert.doesNotMatch(deployer, /kubectl\s+(?:apply|patch|set|replace|delete)/i);
  assert.doesNotMatch(deployer, /api\/platform\/reconcile\/receipt/);
  assert.doesNotMatch(deployer, /Invoke-LocalEdgePlatformRelease\.ps1/);

  let posts = 0;
  const operationId = `pfss:${'a'.repeat(64)}`;
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      posts += 1;
      res.writeHead(202, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ operationId, requestId }));
    }
    assert.equal(req.method, 'GET');
    assert.equal(req.url, `/api/platform/releases/local-edge-automation/pfss/${encodeURIComponent(operationId)}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ operationId, requestId, status: 'committed' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    async function submitOnceAndResume() {
      await fetch(`${url}/api/platform/releases/local-edge-automation/pfss`, { method: 'POST' });
      // Model a response loss after the server durably accepted the POST.
      return (await fetch(`${url}/api/platform/releases/local-edge-automation/pfss/${encodeURIComponent(operationId)}`)).json();
    }
    const resumed = await submitOnceAndResume();
    assert.equal(posts, 1, 'response loss reconciliation must not replay POST');
    assert.deepEqual(resumed, { operationId, requestId, status: 'committed' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
