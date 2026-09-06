import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyExtensionRelease, buildExtensionWorkloadPlan } from '../src/extension-release.mjs';
import { makeReleaseFixture, artifactFetch } from './extension-release-fixture.mjs';
const make = (changes = {}) => makeReleaseFixture({
  contributions: { api: { enabled: true, basePath: '/api/plugins/workspace' }, cli: { enabled: true, namespace: 'workspace', manifestPath: '/contracts/owner-commands.json', ...changes.cli } },
  assetSources: [{ id: 'owner-commands', path: '/contracts/owner-commands.json', type: 'data', source: '{"schema":"opensphere.owner-commands/v2","owner":"workspace"}', ...changes.asset }],
});
const verify = f => verifyExtensionRelease({ pkg: f.pkg, serviceName: 'workspace-r-0123456789abcdef0123', trustedKeys: f.trustedKeys, fetchImpl: artifactFetch(f) });
test('signed command JSON is verified as data and is not scanned or executed as JavaScript', async () => {
  const f = make(); const result = await verify(f);
  assert.equal(result.signature, 'Verified'); assert.equal(result.assets[0].id, 'owner-commands');
  f.assetBodies.set('/contracts/owner-commands.json', Buffer.from('{"tampered":true}'));
  await assert.rejects(verify(f), { code: 'AssetDigestMismatch' });
});
test('data allowance is exact to the signed owner namespace and path, never arbitrary files', async () => {
  for (const changes of [{ asset: { path: '/contracts/other.json' } }, { asset: { id: 'other' } }, { cli: { namespace: 'another-owner' } }, { cli: { enabled: false } }]) {
    await assert.rejects(verify(make(changes)), { code: 'AssetContractInvalid' });
  }
});
test('command providers receive the Pod selector required by the Shell network policy', () => {
  for (const enabled of [true, false]) {
    const f = make({ cli: { enabled } });
    const plan = buildExtensionWorkloadPlan(f.pkg);
    const pod = plan.resources.find(r => r.manifest.kind === 'Deployment').manifest.spec.template;
    assert.equal(pod.metadata.labels['opensphere.io/command-provider'], enabled ? 'true' : undefined);
    assert.equal(pod.metadata.labels['app.kubernetes.io/managed-by'], 'opensphere-extension-controller');
  }
});
