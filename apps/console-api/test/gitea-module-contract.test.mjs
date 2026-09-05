import assert from 'node:assert/strict';
import test from 'node:test';
import { assertModuleDeclaration, createGiteaModuleOwner, MODULE_TEMPLATE, MODULE_CONSUMER, MODULE_DESCRIPTOR, MODULE_CONTRACT } from '../src/gitea-module-contract.mjs';
const image='ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:'+'a'.repeat(64);
const catalogRevision='sha256:'+'b'.repeat(64);
const proposal={ templateId: MODULE_TEMPLATE, consumerId:MODULE_CONSUMER, action:'apply', target:MODULE_DESCRIPTOR,
  desiredState:{contract:MODULE_CONTRACT, descriptorId:MODULE_DESCRIPTOR,catalogRevision,image} };
test('closed module declaration rejects generic Kubernetes resources, another module, mutable images and extra fields',()=>{
 for(const change of [p=>p.consumerId='ceph-prerequisites',p=>p.action='delete',p=>p.target='extension.other',p=>p.desiredState.image='image:edge',p=>p.desiredState.command='sh',p=>p.templateId='unknown']) {
  const p=structuredClone(proposal);change(p);assert.throws(()=>assertModuleDeclaration(p),{code:'PolicyRejected'});
 }
 assert.deepEqual(assertModuleDeclaration(proposal),proposal.desiredState);
});
test('module owner requires real healthy lifecycle observation and exact current Registry image',async()=>{
 let healthy=true,imageNow=image;
 const owner=createGiteaModuleOwner({registryResolver:{readCatalogSnapshot:async()=>({revision:catalogRevision}),resolveExtension:async()=>({image:imageNow})},
  fetchImpl:async()=>new Response(JSON.stringify({state:'Ready',lifecycleEnabled:true,lifecycleObserved:healthy}))});
 assert.equal(await owner.ready(),true);healthy=false;assert.equal(await owner.ready(),false);
 const plan=await owner.validate(proposal);assert.equal(plan.authority,'OpenSphereRegistry');assert.equal(plan.image,image);
 imageNow=image.replace(/a$/,'c');await assert.rejects(owner.validate(proposal),{code:'StaleAuthorityRevision'});
 imageNow=image;const template=await owner.template();assert.deepEqual(template.desiredState,proposal.desiredState);
});
