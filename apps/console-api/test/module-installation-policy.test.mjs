import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import { localDevelopmentModuleInstall } from '../src/module-installation-policy.mjs';
import { authorizeOperation } from '../../../packages/authz/src/authorize-operation.mjs';
import {createOperationService} from '../src/operation-service.mjs';
import {createRegistryOperations} from '../src/registry-operations.mjs';

test('MFA exception requires BOTH exact localhost AND edge, plus the authorized action and immutable module', () => {
  const config = { channel: 'edge', authEnvironment: 'development', consoleUrl: 'https://localhost:1114' };
  const target = 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:' + 'a'.repeat(64);
  const allowed = (c=config, action='console.extension.install', t=target, origin='https://localhost:1114') => localDevelopmentModuleInstall(c,origin,action,t);
  assert.equal(allowed(), true);
  assert.equal(allowed({...config,authEnvironment:'production'}),true, 'localhost AND edge is the user-defined exception');
  for (const c of [{...config,channel:'stable'},{...config,channel:'candidate'},{...config,consoleUrl:'http://localhost:1114'},{...config,consoleUrl:'https://external.example'},{}]) assert.equal(allowed(c),false);
  for (const origin of ['https://external.example','https://localhost.example','https://192.168.1.10']) {
    assert.equal(allowed({...config,consoleUrl:origin},'console.extension.install',target,origin),false, 'non-local edge must still require MFA');
  }
  assert.equal(allowed(config,'console.extension.remove'),false);
  assert.equal(allowed(config,'console.extension.install',target.replace('cluster-manager','other')),false);
  assert.equal(allowed(config,'console.extension.install',target,'https://localhost:1115'),false);
});

test('exception never invents AAL2, expands to R3 or bypasses permission/current authority', () => {
  const session = {subjectId:'test',authorityFresh:true,expiresAt:new Date(Date.now()+60000).toISOString(),permissions:['console.extension.install'],aal:'aal1'};
  const input = {session,permission:'console.extension.install',risk:'R2',reason:'install reviewed module',localDevelopmentModuleInstall:true};
  assert.equal(authorizeOperation(input).aal,'aal1');
  assert.throws(()=>authorizeOperation({...input,risk:'R3'}),{code:'StepUpRequired'});
  assert.throws(()=>authorizeOperation({...input,localDevelopmentModuleInstall:false}),{code:'StepUpRequired'});
  assert.throws(()=>authorizeOperation({...input,session:{...session,permissions:[]}}),{code:'PermissionDenied'});
  assert.throws(()=>authorizeOperation({...input,session:{...session,authorityFresh:false}}),{code:'AuthorizationAuthorityUnavailable'});
});

test('exact Cluster Manager intake uses requester confirmation with real AAL1 at localhost edge', async () => {
  const policyCatalog=JSON.parse(await readFile(new URL('../../../packages/contracts/action-policies.json',import.meta.url),'utf8'));
  const config={channel:'edge',authEnvironment:'development',consoleUrl:'https://localhost:1114'};
  const image='ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:'+'a'.repeat(64);
  const session={subjectId:'10000000-0000-4000-8000-000000000361',sessionId:'10000000-0000-4000-8000-000000000362',
    authorityFresh:true,expiresAt:new Date(Date.now()+60000).toISOString(),permissions:['console.extension.install'],aal:'aal1',permissionRevision:'1',revokeEpoch:'0'};
  let accepted=0;
  const store={get:async()=>null,approve:async()=>null,verify:async()=>null,accept:async input=>{
    accepted++;
    assert.equal(input.localDevelopmentModuleInstall,true);
    assert.equal(input.approvalRequired,false); assert.equal(input.risk,'R2'); assert.equal(input.ownerRef,'C_EXT');
    return {operationRecord:{operation_id:'10000000-0000-4000-8000-000000000363',action_id:input.actionId,
      target_ref:input.targetRef,aal:session.aal,approval_required:false,state:'Authorized',state_version:0,created_at:new Date(),updated_at:new Date()}};
  }};
  const service=createOperationService({store,policyCatalog,moduleInstallationPolicy:(action,target)=>localDevelopmentModuleInstall(config,config.consoleUrl,action,target)});
  const operations=createRegistryOperations({operationService:service,policyRevision:policyCatalog.policyRevision,
    registryResolver:{resolveExtension:async input=>({...input,image})}});
  const request={session,body:{descriptorId:'extension.cluster-manager',catalogRevision:'sha256:'+'b'.repeat(64),reason:'install the reviewed module'},idempotencyKey:'module-intake-test',correlationId:'module-intake-correlation'};
  const result=await operations.installCandidate(request);
  assert.equal(result.receipt.aal,'aal1'); assert.equal(result.receipt.state,'Authorized');
  assert.equal(result.receipt.assertExtensionInstallIntake,undefined);
  await assert.rejects(()=>operations.installCandidate({...request,body:{...request.body,descriptorId:'extension.other'}}),{code:'StepUpRequired'});
  assert.equal(accepted,1);
});

test('requester confirmation does not bypass non-local or non-edge MFA and leaves other module policies intact',async()=>{
 const policyCatalog=JSON.parse(await readFile(new URL('../../../packages/contracts/action-policies.json',import.meta.url),'utf8'));
 const image='ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:'+'a'.repeat(64);
 const session={subjectId:'10000000-0000-4000-8000-000000000371',sessionId:'10000000-0000-4000-8000-000000000372',authorityFresh:true,
   expiresAt:new Date(Date.now()+60000).toISOString(),permissions:['console.extension.install'],aal:'aal1',permissionRevision:1,revokeEpoch:0};
 const accepted=[];
 const store={get:async()=>null,approve:async()=>null,verify:async()=>null,accept:async input=>{accepted.push(input);return {operationRecord:{created_at:new Date(),updated_at:new Date()},replayed:false};}};
 for(const config of [{channel:'edge',consoleUrl:'https://remote.example'},{channel:'stable',consoleUrl:'https://localhost:1114'},{channel:'candidate',consoleUrl:'https://localhost:1114'}]) {
   const service=createOperationService({store,policyCatalog,moduleInstallationPolicy:(a,t)=>localDevelopmentModuleInstall(config,config.consoleUrl,a,t)});
   const request={schemaVersion:'1.0',actionId:'console.extension.install',actionVersion:'1.0',targetRef:image,payload:{},risk:'R2',reason:'Drawer installation confirmation',planRevision:policyCatalog.policyRevision};
   const input={session,request,idempotencyKey:'strict-install-test',correlationId:'strict-install-test'};
   await assert.rejects(service.accept(input),{code:'StepUpRequired'});
   await service.accept({...input,session:{...session,aal:'aal2'}});
   assert.equal(accepted.at(-1).approvalRequired,false);
   assert.equal(accepted.at(-1).localDevelopmentModuleInstall,false);
   await service.accept({...input,session:{...session,aal:'aal2'},request:{...request,targetRef:image.replace('cluster-manager','other')}});
   assert.equal(accepted.at(-1).approvalRequired,true,'unrelated module policy is unchanged');
 }
 assert.equal(accepted.length,6,'AAL1 attempts never reach the store');
});
