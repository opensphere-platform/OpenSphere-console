import assert from 'node:assert/strict';
import test from 'node:test';
import { createKubernetesRegistrationWriter } from '../src/kubernetes-registration-writer.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const manifest = 'b'.repeat(64);
function registration() {
  return {
    metadata: { name: 'sample' },
    spec: { packageRef: { name: 'sample' }, desiredState: 'Enabled' },
    status: {
      phase: 'Activated', workload: { phase: 'Ready' }, currentDigest: digest, currentManifestSha256: manifest,
      verification: { manifest: 'Verified', signature: 'Verified', entryDigest: 'Verified', permissions: 'Approved' },
      serving: { phase: 'Current', digest, manifestSha256: manifest, artifactServiceId: 'sample-r-abcdef' },
      revalidation: { phase: 'Passed' },
    },
  };
}
function pkg() {
  return { metadata: { name: 'sample' }, spec: {
    image: { digest }, manifest: { sha256: manifest },
    contributions: { api: { enabled: true, basePath: '/api/plugins/sample' } },
  } };
}
function writer(responses, calls = []) {
  return { calls, value: createKubernetesRegistrationWriter({
    baseUrl: 'http://127.0.0.1:8443', token: 'kubernetes-token-value',
    async fetchImpl(url) {
      calls.push(url);
      const next = responses.shift();
      return new Response(next?.body === undefined ? '' : JSON.stringify(next.body), {
        status: next?.status || 200, headers: { 'content-type': 'application/json' },
      });
    },
  }) };
}

test('C_EXT resolves canonical plugin API only from an activated exact serving registration', async () => {
  const subject = writer([{ body: registration() }, { body: pkg() }]);
  const target = await subject.value.resolvePluginProxyTarget({ serviceId: 'sample' });
  assert.equal(target.serviceId, 'sample');
  assert.equal(target.digest, digest);
  assert.equal(subject.calls.length, 2);
});

test('C_EXT resolves current immutable artifact service by scanning authoritative registrations', async () => {
  const subject = writer([{ status: 404 }, { body: { items: [registration()] } }, { body: pkg() }]);
  const target = await subject.value.resolvePluginProxyTarget({ serviceId: 'sample-r-abcdef' });
  assert.equal(target.packageId, 'sample');
  assert.equal(target.serviceId, 'sample-r-abcdef');
});

test('C_EXT rejects a disabled, unverified or package-drifted proxy target', async () => {
  const disabled = registration(); disabled.spec.desiredState = 'Disabled';
  await assert.rejects(writer([{ body: disabled }]).value.resolvePluginProxyTarget({ serviceId: 'sample' }),
    (error) => error.code === 'OwnerRejected');
  const stale = pkg(); stale.spec.image.digest = `sha256:${'c'.repeat(64)}`;
  await assert.rejects(writer([{ body: registration() }, { body: stale }]).value.resolvePluginProxyTarget({ serviceId: 'sample' }),
    (error) => error.code === 'StaleAuthorityRevision');
});