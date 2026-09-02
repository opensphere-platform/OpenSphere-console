import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import platformReleaseContract from '../runtime/platform-release-contract.js';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import { createFileInstallationReleaseStore, createPlatformReleaseOperations } from '../src/platform-release-operations.mjs';

const { COMPONENT_REPOSITORIES, REQUIRED_COMPONENTS, calculateReleaseDigest } = platformReleaseContract;
const now = new Date('2026-09-02T12:00:00.000Z');
const revision = 'a'.repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;
const session = Object.freeze({
  sessionId: '11111111-1111-4111-8111-111111111111',
  subjectId: '22222222-2222-4222-8222-222222222222',
  authorityFresh: true,
  permissionRevision: 4,
  revokeEpoch: 1,
  permissions: Object.freeze(['console.git.change']),
  aal: 'aal2',
});

function releaseLock() {
  const characters = '0123456789abcdef';
  const lock = {
    apiVersion: 'release.opensphere.io/v1alpha1',
    kind: 'OpenSphereReleaseLock',
    channel: 'edge',
    releaseDigest: '',
    resolvedAt: '2026-09-01T00:00:00.000Z',
    source: 'https://github.com/opensphere-platform/OpenSphere-console',
    sourceRevision: revision,
    trust: {
      type: 'localhost-edge/v1',
      repository: 'opensphere-platform/OpenSphere-console',
      publisher: 'scripts/Publish-LocalEdge.ps1',
      buildAuthority: 'localhost',
      releaseClass: 'pre-ga',
      gaEligible: false,
    },
    components: Object.fromEntries(REQUIRED_COMPONENTS.map((name, index) => [name, {
      repository: COMPONENT_REPOSITORIES[name],
      image: `ghcr.io/opensphere-platform/${COMPONENT_REPOSITORIES[name]}@${digest(characters[index % characters.length])}`,
      sourceRevision: revision,
      registryCredentialsRequired: false,
    }])),
  };
  lock.releaseDigest = calculateReleaseDigest(lock);
  return lock;
}

function fixture(lock = releaseLock()) {
  return createPlatformReleaseOperations({
    releaseStore: { readInstalled: async () => structuredClone(lock) },
    clock: () => now,
  });
}

test('Platform Release status projects the exact installed lock without claiming executor readiness', async () => {
  const status = await fixture().status({ session });
  assert.equal(status.current.releaseDigest, releaseLock().releaseDigest);
  assert.equal(status.current.componentCount, REQUIRED_COMPONENTS.length);
  assert.equal(status.execution.ready, false);
  assert.equal(status.execution.blocker, 'platform_release_owner_not_target_ready');
  assert.equal(status.contract, null);
  assert.deepEqual(status.changes, []);
  assert.equal(status.authority.localKubeconfigExecution, false);
});

test('Installation release file store bounds input and fails closed on missing or invalid evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opensphere-release-store-'));
  const path = join(directory, 'release.json');
  try {
    const store = createFileInstallationReleaseStore({ path, maximumBytes: 1024 });
    await assert.rejects(store.readInstalled(), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'none' });
    await writeFile(path, '{broken');
    await assert.rejects(store.readInstalled(), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'none' });
    await writeFile(path, JSON.stringify(releaseLock()));
    await assert.rejects(store.readInstalled(), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'none' });
    const readable = createFileInstallationReleaseStore({ path });
    assert.equal((await readable.readInstalled()).releaseDigest, releaseLock().releaseDigest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Component target is generated from the installed base with an exact changed set', async () => {
  const changedName = 'console';
  const result = await fixture().generateComponentTarget({
    session,
    body: {
      reason: 'publish the verified Console component image',
      sourceRevision: 'b'.repeat(40),
      components: {
        [changedName]: { image: digest('f') },
      },
    },
  });
  assert.equal(result.baseReleaseDigest, releaseLock().releaseDigest);
  assert.deepEqual(result.changedComponents, [changedName]);
  assert.equal(result.targetLock.releaseScope, 'component');
  assert.equal(result.targetLock.sourceRevision, 'b'.repeat(40));
  assert.match(result.targetLock.components.console.image, /^ghcr\.io\/opensphere-platform\/opensphere-console@sha256:f{64}$/u);
  assert.equal(result.generatedAt, now.toISOString());
});

test('Component target rejects stale authority, missing AAL2, input expansion and invalid images', async () => {
  const operations = fixture();
  const body = {
    reason: 'publish the verified Console component image',
    sourceRevision: 'b'.repeat(40),
    components: { console: { image: digest('f') } },
  };
  await assert.rejects(operations.generateComponentTarget({ session: { ...session, authorityFresh: false }, body }), {
    code: 'AuthenticationRequired', status: 401,
  });
  await assert.rejects(operations.generateComponentTarget({ session: { ...session, aal: 'aal1' }, body }), {
    code: 'StepUpRequired', status: 428,
  });
  await assert.rejects(operations.generateComponentTarget({ session, body: { ...body, channel: 'ga' } }), {
    code: 'ValidationFailed', status: 400,
  });
  await assert.rejects(operations.generateComponentTarget({
    session,
    body: { ...body, components: { console: { image: 'ghcr.io/attacker/console@' + digest('f') } } },
  }), { code: 'ValidationFailed', status: 400 });
});

test('HTTP Platform Release routes use target session, CSRF and no query expansion', async () => {
  const sessionChecks = [];
  const handler = createConsoleApiHandler({
    resolveSession: async (_request, options) => { sessionChecks.push(options); return session; },
    platformReleaseOperations: fixture(),
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/platform/releases/status`, {
      headers: { 'x-os-correlation-id': 'release-status-correlation-0001' },
    });
    assert.equal(statusResponse.status, 200);

    const targetResponse = await fetch(`http://127.0.0.1:${port}/api/platform/releases/component-target`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-os-csrf-token': 'release-target-csrf-proof',
        'x-os-correlation-id': 'release-target-correlation-0001',
      },
      body: JSON.stringify({
        reason: 'publish the verified Console component image',
        sourceRevision: 'b'.repeat(40),
        components: { console: { image: digest('f') } },
      }),
    });
    assert.equal(targetResponse.status, 200);
    assert.deepEqual(sessionChecks, [
      { requireCsrf: false, correlationId: 'release-status-correlation-0001' },
      { requireCsrf: true, correlationId: 'release-target-correlation-0001' },
    ]);

    const invalid = await fetch(`http://127.0.0.1:${port}/api/platform/releases/status?details=all`);
    assert.equal(invalid.status, 400);
    assert.equal(sessionChecks.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
