import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import contract from '../runtime/platform-release-contract.js';
import { createPlatformReleaseOperations } from '../src/platform-release-operations.mjs';

// Versioned provider evidence: the exact public edge lock installed by Setup
// edge.27. No runtime test imports or reads another repository's source.
const fixture = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/platform-release/current-edge-v1.json', import.meta.url), 'utf8'));
const session = Object.freeze({sessionId:'11111111-1111-4111-8111-111111111111',subjectId:'22222222-2222-4222-8222-222222222222',authorityFresh:true,permissionRevision:1,revokeEpoch:0,permissions:['console.git.change'],aal:'aal2'});
const operations = (lock) => createPlatformReleaseOperations({releaseStore:{readInstalled:async()=>structuredClone(lock)}});
const redigest = (lock) => { lock.releaseDigest = contract.calculateReleaseDigest(lock); return lock; };

test('CON-FR-014: current Setup lock is readable without asserting an active release executor', async () => {
  const status = await operations(fixture).status({session});
  assert.equal(status.current.releaseDigest, fixture.releaseDigest);
  assert.equal(status.current.componentCount, 18);
  assert.deepEqual(status.current.components, fixture.components);
  assert.equal(status.execution.ready, false);
  assert.equal(status.execution.blocker, 'platform_release_owner_not_target_ready');
});

test('CON-FR-014: current API/Beszel target generation preserves every unchanged component and auxiliary digest', async () => {
  const result = await operations(fixture).generateComponentTarget({session,body:{reason:'verified current owner component update',sourceRevision:'a'.repeat(40),components:{consoleApi:{image:'sha256:'+'b'.repeat(64)},beszelHub:{image:'sha256:'+'c'.repeat(64)}}}});
  assert.deepEqual(result.changedComponents,['beszelHub','consoleApi']);
  assert.equal(result.baseReleaseDigest, fixture.releaseDigest);
  assert.equal(result.targetLock.components.consoleApi.repository, 'opensphere-console-api');
  assert.equal(result.targetLock.components.beszelHub.repository, 'opensphere-console-beszel-hub');
  assert.deepEqual(result.targetLock.auxiliaryArtifacts, fixture.auxiliaryArtifacts);
  for (const name of Object.keys(fixture.components).filter(name=>!result.changedComponents.includes(name))) assert.deepEqual(result.targetLock.components[name], fixture.components[name]);
});

test('CON-FR-014: incomplete, expanded, mixed legacy, mutable and tampered current locks fail closed', async () => {
  const mutations = [
    lock=>delete lock.components.beszelHub,
    lock=>{lock.components.extra=structuredClone(lock.components.consoleApi);},
    lock=>{lock.components.backend=structuredClone(lock.components.consoleApi);delete lock.components.consoleApi;},
    lock=>delete lock.auxiliaryArtifacts,
    lock=>delete lock.auxiliaryArtifacts.osShellRuntime,
    lock=>{lock.auxiliaryArtifacts.extra=structuredClone(lock.auxiliaryArtifacts.cliArtifacts);},
    lock=>{lock.components.consoleApi.image='ghcr.io/opensphere-platform/opensphere-console-api:edge';},
    lock=>{lock.auxiliaryArtifacts.osShellControl.repository='attacker';},
    lock=>{lock.components.extensionController.sourceRevision='d'.repeat(40);},
    lock=>{lock.auxiliaryArtifacts.osShellRuntime.sourceRevision='d'.repeat(40);},
  ];
  for(const mutate of mutations){const lock=structuredClone(fixture);mutate(lock);redigest(lock);await assert.rejects(operations(lock).status({session}),{code:'AuthorityUnavailable',status:503,sideEffect:'none'});}
  const tampered=structuredClone(fixture);tampered.releaseDigest='sha256:'+'0'.repeat(64);
  await assert.rejects(operations(tampered).status({session}),/releaseDigest does not match/);
});

test('CON-FR-014: current target rejects legacy-only components, missing permissions and stale sessions', async () => {
  await assert.rejects(operations(fixture).generateComponentTarget({session,body:{reason:'reject historical owner substitution',sourceRevision:'a'.repeat(40),components:{backend:{image:'sha256:'+'b'.repeat(64)}}}}),{code:'ValidationFailed',status:400});
  await assert.rejects(operations(fixture).status({session:{...session,permissions:[]}}),{code:'PermissionDenied',status:403});
  await assert.rejects(operations(fixture).status({session:{...session,authorityFresh:false}}),{code:'AuthenticationRequired',status:401});
});