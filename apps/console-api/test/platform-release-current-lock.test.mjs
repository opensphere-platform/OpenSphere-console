import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';
import contract from '../runtime/platform-release-contract.js';
import { createPlatformReleaseOperations } from '../src/platform-release-operations.mjs';

// Versioned provider evidence: the exact public edge lock installed by Setup
// edge.27. No runtime test imports or reads another repository's source.
const fixture = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/platform-release/current-edge-v1.json', import.meta.url), 'utf8'));
const session = Object.freeze({sessionId:'11111111-1111-4111-8111-111111111111',subjectId:'22222222-2222-4222-8222-222222222222',authorityFresh:true,permissionRevision:1,revokeEpoch:0,permissions:['console.git.change'],aal:'aal2'});
const operations = (lock) => createPlatformReleaseOperations({releaseStore:{readInstalled:async()=>structuredClone(lock)}});
const redigest = (lock) => { lock.releaseDigest = contract.calculateReleaseDigest(lock); return lock; };
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

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

test('CON-FR-014: an independent CLI update records exactly its artifact and preserves installed owners', async () => {
  const body = { reason: 'publish verified module installation CLI', sourceRevision: 'a'.repeat(40),
    auxiliaryArtifacts: { cliArtifacts: { image: 'sha256:' + 'b'.repeat(64) } } };
  const result = await operations(fixture).generateComponentTarget({ session, body });
  assert.deepEqual(result.changedComponents, []);
  assert.deepEqual(result.changedAuxiliaryArtifacts, ['cliArtifacts']);
  assert.deepEqual(result.targetLock.components, fixture.components);
  assert.deepEqual(result.targetLock.auxiliaryArtifacts.osShellRuntime, fixture.auxiliaryArtifacts.osShellRuntime);
  assert.deepEqual(result.targetLock.auxiliaryArtifacts.osShellControl, fixture.auxiliaryArtifacts.osShellControl);
  assert.equal(result.targetLock.auxiliaryArtifacts.cliArtifacts.image, 'ghcr.io/opensphere-platform/opensphere-os-cli@sha256:' + 'b'.repeat(64));
  const schema = name => readFile(new URL('../../../packages/contracts/schemas/' + name + '.schema.json', import.meta.url), 'utf8').then(JSON.parse);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const lockSchema = await schema('platform-release-lock');
  const responseSchema = await schema('platform-release-component-target-response');
  // Register the response's relative reference under its explicit schema key.
  ajv.addSchema(lockSchema, './platform-release-lock.schema.json');
  responseSchema.properties.targetLock = { $ref: lockSchema.$id };
  for (const [definition, value] of [[await schema('platform-release-component-target-request'), body], [responseSchema, result], [lockSchema, result.targetLock]]) {
    const validate = ajv.getSchema(definition.$id) || ajv.compile(definition);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  for (const auxiliaryArtifacts of [
    { cliArtifacts: { image: 'ghcr.io/other/opensphere-os-cli@sha256:' + 'b'.repeat(64) } },
    { cliArtifacts: { image: 'ghcr.io/opensphere-platform/opensphere-os-cli:edge' } },
    { osShellRuntime: { image: 'sha256:' + 'b'.repeat(64) } },
  ]) await assert.rejects(operations(fixture).generateComponentTarget({ session, body: { ...body, auxiliaryArtifacts } }), { code: 'ValidationFailed' });
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

test('CON-FR-014: Console renderer and independently updatable index content form one governed transition', async () => {
  const introduced = await operations(fixture).generateComponentTarget({
    session,
    body: {
      reason: 'install the governed Console index renderer and content',
      sourceRevision: 'a'.repeat(40),
      components: { console: { image: 'sha256:' + 'b'.repeat(64) } },
      auxiliaryArtifacts: { consoleIndexContent: { image: 'sha256:' + 'c'.repeat(64) } },
    },
  });
  assert.deepEqual(introduced.changedComponents, ['console']);
  assert.deepEqual(introduced.changedAuxiliaryArtifacts, ['consoleIndexContent']);
  assert.equal(
    introduced.targetLock.auxiliaryArtifacts.consoleIndexContent.image,
    'ghcr.io/opensphere-platform/opensphere-console-index-content@sha256:' + 'c'.repeat(64),
  );

  const contentOnly = await operations(introduced.targetLock).generateComponentTarget({
    session,
    body: {
      reason: 'publish a reviewed Main Index content revision',
      sourceRevision: 'd'.repeat(40),
      auxiliaryArtifacts: { consoleIndexContent: { image: 'sha256:' + 'e'.repeat(64) } },
    },
  });
  assert.deepEqual(contentOnly.changedComponents, []);
  assert.deepEqual(contentOnly.changedAuxiliaryArtifacts, ['consoleIndexContent']);
  assert.deepEqual(contentOnly.targetLock.components, introduced.targetLock.components);
  assert.deepEqual(contract.releaseSummary(contentOnly.targetLock).changedAuxiliaryArtifacts, ['consoleIndexContent']);
});
