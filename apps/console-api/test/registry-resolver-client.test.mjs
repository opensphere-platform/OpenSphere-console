import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createRegistryResolver } from '../../../packages/registry-client/src/registry-resolver-client.mjs';

const catalogRevision = 'sha256:' + 'c'.repeat(64);
const imageDigest = 'sha256:' + 'e'.repeat(64);
const image = 'ghcr.io/opensphere-platform/opensphere-plugin-workspace@' + imageDigest;

function eligible(extraCandidate = {}) {
  return {
    result: 'Eligible', revision: catalogRevision,
    candidate: {
      kind: 'extension', descriptorId: 'extension.workspace', id: 'workspace', image, digest: imageDigest,
      channel: 'edge', catalogRevision, descriptorRevision: catalogRevision, executionRevision: image,
      sourceRevision: 'a'.repeat(40), manifestDigest: 'sha256:' + 'd'.repeat(64),
      compatibilityVersion: '1.0.0', buildAuthority: 'localhost', keyId: 'opensphere-release-key-1',
      evidenceRefs: [`oci:${image}#p256-module-signature`, `oci:${image}#local-edge-build-metadata`],
      packageResourceVersion: '17', packageGeneration: 1,
      verification: {
        catalog: 'Verified', manifest: 'Verified', signature: 'Verified', permissions: 'Approved',
        provenance: 'LocalEdgeSigned', sbom: 'NotRequiredLocalEdge',
      },
      ...extraCandidate,
    },
  };
}

async function service(t, responder) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, method: request.method, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    await responder(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: 'http://127.0.0.1:' + server.address().port, requests };
}

test('C_REG client binds a fixed internal request to a fully verified exact candidate', async (t) => {
  const { baseUrl, requests } = await service(t, async (response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(eligible()));
  });
  const candidate = await createRegistryResolver({ baseUrl }).resolveExtension({
    descriptorId: 'extension.workspace', catalogRevision, correlationId: 'registry-client-correlation-0001',
  });
  assert.equal(candidate.image, image);
  assert.equal(candidate.verification.signature, 'Verified');
  assert.deepEqual(requests[0].body, {
    kind: 'extension', id: 'extension.workspace', revision: catalogRevision,
    architecture: 'linux/amd64', channel: 'edge',
  });
  assert.equal(requests[0].url, '/api/v1/registry/resolve');
  assert.equal(requests[0].headers['x-correlation-id'], 'registry-client-correlation-0001');
});

test('C_REG client maps stale, ineligible, and unavailable authority results without a candidate', async () => {
  for (const [document, expected] of [
    [{ result: 'StaleRevision', revision: catalogRevision, blockerCode: 'CatalogRevisionChanged', message: 'changed' }, { code: 'StaleAuthorityRevision', status: 409 }],
    [{ result: 'Ineligible', revision: catalogRevision, blockerCode: 'CandidateNotFound', message: 'missing' }, { code: 'PolicyRejected', status: 422 }],
    [{ result: 'Unavailable', revision: catalogRevision, blockerCode: 'RegistryStale', message: 'stale' }, { code: 'AuthorityUnavailable', status: 503 }],
  ]) {
    const resolver = createRegistryResolver({ baseUrl: 'http://registry.test', fetchImpl: async () => new Response(JSON.stringify(document)) });
    await assert.rejects(resolver.resolveExtension({ descriptorId: 'extension.workspace', catalogRevision }), expected);
  }
});

test('C_REG client rejects mismatched, unverified, secret-bearing, and oversized authority responses', async () => {
  for (const document of [
    eligible({ descriptorId: 'extension.other' }),
    eligible({ buildAuthority: 'github-actions' }),
    eligible({ evidenceRefs: ['oci:provenance:workspace', 'oci:sbom:workspace'] }),
    eligible({ verification: { catalog: 'Verified', manifest: 'Verified', signature: 'Unknown', permissions: 'Approved', provenance: 'LocalEdgeSigned', sbom: 'NotRequiredLocalEdge' } }),
    eligible({ secretRef: 'must-not-cross-boundary' }),
  ]) {
    const resolver = createRegistryResolver({ baseUrl: 'http://registry.test', fetchImpl: async () => new Response(JSON.stringify(document)) });
    await assert.rejects(resolver.resolveExtension({ descriptorId: 'extension.workspace', catalogRevision }), { code: 'AuthorityContractViolation', status: 502 });
  }
  const oversized = createRegistryResolver({
    baseUrl: 'http://registry.test', maximumResponseBytes: 1024,
    fetchImpl: async () => new Response('x'.repeat(2048)),
  });
  await assert.rejects(oversized.resolveExtension({ descriptorId: 'extension.workspace', catalogRevision }), { code: 'AuthorityContractViolation', status: 502 });
});

test('C_REG client enforces a bounded timeout and rejects invalid configured origins', async () => {
  const resolver = createRegistryResolver({
    baseUrl: 'http://registry.test', timeoutMs: 100,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });
  await assert.rejects(resolver.resolveExtension({ descriptorId: 'extension.workspace', catalogRevision }), { code: 'DependencyTimeout', status: 504 });
  assert.throws(() => createRegistryResolver({ baseUrl: 'file:///etc/passwd' }), /HTTP\(S\) origin/);
  assert.throws(() => createRegistryResolver({ baseUrl: 'https://user:secret@registry.test' }), /without credentials/);
});
