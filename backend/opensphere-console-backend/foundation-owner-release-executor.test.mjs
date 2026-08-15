import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireLock, completeLock, failLock } from './foundation-owner-release-executor.mjs';

const previous = { image: `ghcr.io/opensphere-platform/opensphere-shell-foundation@sha256:${'1'.repeat(64)}`,
  sourceRevision: '2'.repeat(40), releaseTag: '202608140101' };
const target = { image: `ghcr.io/opensphere-platform/opensphere-shell-foundation@sha256:${'3'.repeat(64)}`,
  sourceRevision: '4'.repeat(40), releaseTag: '202608151420' };
const desired = { action: 'Apply', operationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', expectedCurrent: previous };
const sha = `sha256:${'5'.repeat(64)}`;

function deployment(release) {
  return { metadata: { name: 'foundation-oaa-owner', namespace: 'opensphere-console', uid: 'u', resourceVersion: '1', generation: 1 },
    spec: { replicas: 2, template: { metadata: { annotations: {
      'io.opensphere.source-revision': release.sourceRevision, 'io.opensphere.release-tag': release.releaseTag,
    } }, spec: { containers: [{ name: 'owner', image: release.image,
      env: [{ name: 'APP_VERSION', value: release.releaseTag }] }] } } }, status: {} };
}

test('lock Apply CAS completes, response-loss replay is idempotent, and changed publication is denied', async () => {
  let state = { contract: 'opensphere.foundation.owner.installation-lock/v1', revision: 0, phase: 'Uninitialized' };
  const cm = { metadata: { resourceVersion: '1' }, data: {} };
  const io = { readLock: async () => ({ cm, state }), checkedKubernetes: async () => deployment(previous),
    writeLock: async (_cm, next) => { state = structuredClone(next); return cm; } };
  const acquired = await acquireLock(desired, target, sha, io);
  assert.equal(state.phase, 'Applying'); assert.equal(state.publicationSha256, sha);
  await assert.rejects(acquireLock(desired, target, sha, io), /active exclusive executor attempt/);
  await completeLock(acquired, desired, target,
    { state: 'Applied', publicationSha256: sha, observedGeneration: 7 }, io);
  assert.equal(state.phase, 'Completed'); assert.equal(state.current.image, target.image);
  io.checkedKubernetes = async () => deployment(target);
  assert.equal((await acquireLock(desired, target, sha, io)).completed, true);
  await assert.rejects(acquireLock(desired, target, `sha256:${'6'.repeat(64)}`, io), /publication mismatch/);
});

test('Completed Rollback permanently fences a delayed original Apply attempt', async () => {
  let writes = 0;
  const state = { contract: 'opensphere.foundation.owner.installation-lock/v1', revision: 9,
    phase: 'Completed', action: 'Rollback', operationId: desired.operationId,
    current: previous, target: previous, publicationSha256: sha };
  const io = { readLock: async () => ({ cm: { data: {} }, state }),
    checkedKubernetes: async () => deployment(previous), writeLock: async () => { writes += 1; } };
  await assert.rejects(acquireLock(desired, target, sha, io), /durably rolled back/);
  assert.equal(writes, 0);
});

test('fenced execution failure records Failed and rollback-complete state for a new operation', async () => {
  let state = { contract: 'opensphere.foundation.owner.installation-lock/v1', revision: 3, phase: 'Applying',
    operationId: desired.operationId, requestId: '', mergeRevision: '', attempt: 0, current: previous };
  const io = { readLock: async () => ({ cm: { data: {} }, state }), checkedKubernetes: async () => deployment(previous),
    writeLock: async (_cm, next) => { state = structuredClone(next); } };
  await failLock(desired, new Error('fixture failure'), io);
  assert.equal(state.phase, 'Failed'); assert.equal(state.rollbackComplete, true);
  assert.equal(state.errorCode, 'foundation-owner-release-execution-failed');
});
