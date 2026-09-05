import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleCandidate, moduleCatalogFresh, moduleStatus, operationStage, operationInProgress, validInstallReceipt, type ModuleCandidate, type ModuleRegistration} from './module-installation-state.ts';
const candidate: ModuleCandidate = {id:'extension.cluster-manager', class:'extension', displayName:'Cluster Manager', release:{imageDigest:'sha256:'+'a'.repeat(64)}, installation:{mode:'extension-controller',eligible:true}};
const registration: ModuleRegistration = {name:'cluster-manager',desiredState:'Enabled',health:'Ready',status:{phase:'Activated',serving:{phase:'Current'},currentDigest:'sha256:'+'a'.repeat(64),verification:{manifest:'Verified',signature:'Verified',entryDigest:'Verified'}}};
test('first module installation does not depend on not-yet-installed Foundation, but real source failures remain blocking', () => {
  const required = Object.fromEntries(['extensions.packages','extensions.registrations','extensions.navigation','trust.keys','release.inventory'].map(name=>[name,{ready:true}]));
  const sources = {...required,'catalog.descriptors':{ready:false,reason:'NotInstalled'}};
  assert.equal(moduleCatalogFresh({stale:false,sources}),true);
  assert.equal(moduleCatalogFresh({stale:true,sources}),false);
  assert.equal(moduleCatalogFresh({stale:false,sources:{}}),false);
  assert.equal(moduleCatalogFresh({stale:false,sources:{...sources,'catalog.descriptors':{ready:false,reason:'Forbidden'}}}),false);
  for (const name of Object.keys(required)) assert.equal(moduleCatalogFresh({stale:false,sources:{...sources,[name]:{ready:false,reason:'NotInstalled'}}}),false);
});
test('planned products, ambiguous identities and mutable images cannot become install candidates', () => {
  assert.equal(moduleCandidate('cluster-manager', []), undefined);
  assert.equal(moduleCandidate('cluster-manager', [candidate,candidate]), undefined);
  assert.equal(moduleCandidate('cluster-manager', [{...candidate,class:'installableModule'}]), undefined);
  assert.equal(moduleCandidate('cluster-manager', [{...candidate,release:{imageDigest:'edge'}}]), undefined);
  assert.equal(moduleCandidate('cluster-manager', [candidate]), candidate);
});
test('catalog outage blocks new installation but preserves separately verified running module status', () => {
  assert.equal(moduleStatus(false,candidate,undefined,true).installable,false);
  assert.equal(moduleStatus(false,candidate,registration,true).ready,true);
  assert.equal(moduleStatus(true,candidate,registration,false).ready,false);
});
test('Pod readiness, last known good and incomplete signatures do not become completed module installation', () => {
  for(const bad of [
    {...registration,status:{...registration.status,phase:'Installing'}},
    {...registration,status:{...registration.status,serving:{phase:'LastKnownGood'}}},
    {...registration,status:{...registration.status,verification:{manifest:'Verified',signature:'Failed',entryDigest:'Verified'}}},
    {...registration,health:'NotReady'},
  ]) assert.equal(moduleStatus(true,candidate,bad).ready,false);
  assert.equal(moduleStatus(true,candidate,registration).ready,true);
});
test('Applied awaits verification; Failed and Unknown never render a completed progress bar', () => {
  assert.equal(operationInProgress('Applied'),true);
  assert.equal(operationStage('Applied'),3);
  assert.equal(operationStage('Verified'),4);
  for(const state of ['Failed','Unknown','RolledBack','Bogus']) assert.equal(operationStage(state),-1);
});
test('malformed or unrelated operation receipts cannot acknowledge an install', () => {
  const receipt={schemaVersion:'1.0',actionId:'console.extension.install',operationId:'a1ac7d21-897f-489f-8142-d8e7c4d6cddb',targetRef:'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:'+'a'.repeat(64),state:'Planned',stateVersion:0};
  assert.equal(validInstallReceipt(receipt),true);
  for(const change of [{actionId:'console.extension.remove'},{targetRef:'http://untrusted.invalid'},{operationId:'../secrets'},{state:'Success'},{stateVersion:-1}]) assert.equal(validInstallReceipt({...receipt,...change}),false);
});
