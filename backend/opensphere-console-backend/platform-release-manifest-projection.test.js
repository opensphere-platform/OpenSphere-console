'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { projectReconcileManifest } = require('./platform-release-manifest-projection');
const { PLATFORM_RELEASE_RECONCILER, PLATFORM_RELEASE_TARGET } = require('./platform-release-contract');

const requestId = '11111111-1111-4111-8111-111111111111';
const revision = 'a'.repeat(40);
const manifest = Buffer.from(JSON.stringify({ apiVersion: 'platform.opensphere.io/v1alpha1', kind: 'GovernedChange' }));

function fixture(overrides = {}) {
  return {
    readChange: async () => ({ request_id: requestId, target: PLATFORM_RELEASE_TARGET,
      status: 'committed', git_commit_sha: revision, git_repo: 'opensphere/platform-declarations',
      ...(overrides.change || {}) }),
    readConsumer: async () => ({ reconciler: PLATFORM_RELEASE_RECONCILER,
      gitea_repository: 'opensphere/platform-declarations', gitea_path: 'platform-release',
      ...(overrides.consumer || {}) }),
    readGiteaFile: async () => ({ content: manifest.toString('base64'), ...(overrides.file || {}) }),
  };
}

test('projects only one DB-bound reviewed exact-commit manifest without exposing a Gitea token', async () => {
  const result = await projectReconcileManifest({ reconciler: PLATFORM_RELEASE_RECONCILER, requestId }, fixture());
  assert.deepEqual(result, {
    contract: 'opensphere-platform-release-manifest-projection/v1',
    requestId,
    reconciler: PLATFORM_RELEASE_RECONCILER,
    gitRepo: 'opensphere/platform-declarations',
    gitCommitSha: revision,
    path: `platform-release/requests/${requestId}.json`,
    content: manifest.toString('base64'),
    contentSha256: `sha256:${createHash('sha256').update(manifest).digest('hex')}`,
  });
  assert.equal(JSON.stringify(result).includes('token'), false);
});

test('request, DB assignment, consumer path and canonical content mismatches fail closed', async () => {
  await assert.rejects(projectReconcileManifest({ reconciler: 'attacker', requestId }, fixture()), /closed/);
  await assert.rejects(projectReconcileManifest({ reconciler: PLATFORM_RELEASE_RECONCILER,
    requestId: '../escape' }, fixture()), /closed/);
  await assert.rejects(projectReconcileManifest({ reconciler: PLATFORM_RELEASE_RECONCILER, requestId },
    fixture({ change: { target: 'attacker' } })), /not bound/);
  await assert.rejects(projectReconcileManifest({ reconciler: PLATFORM_RELEASE_RECONCILER, requestId },
    fixture({ consumer: { gitea_path: 'attacker' } })), /not bound/);
  await assert.rejects(projectReconcileManifest({ reconciler: PLATFORM_RELEASE_RECONCILER, requestId },
    fixture({ file: { content: `${manifest.toString('base64')}\nignored` } })), /canonical/);
});
