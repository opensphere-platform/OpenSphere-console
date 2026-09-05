import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import { localDevelopmentModuleInstall } from '../src/module-installation-policy.mjs';
import { authorizeOperation } from '../../../packages/authz/src/authorize-operation.mjs';
import {createOperationService} from '../src/operation-service.mjs';
import {createRegistryOperations} from '../src/registry-operations.mjs';

test('MFA exception requires exact local development origin, channel, action and immutable module', () => {
  const config = { channel: 'edge', authEnvironment: 'development', consoleUrl: 'https://localhost:1114' };
  const target = 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:' + 'a'.repeat(64);
  const allowed = (c=config, action='console.extension.install', t=target, origin='https://localhost:1114') => localDevelopmentModuleInstall(c,origin,action,t);
  assert.equal(allowed(), true);
  for (const c of [{...config,channel:'stable'},{...config,authEnvironment:'production'},{...config,consoleUrl:'http://localhost:1114'},{...config,consoleUrl:'https://external.example'},{}]) assert.equal(allowed(c),false);
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

test('actual Registry intake reaches the dedicated store with real AAL1 and required independent approval', async () => {
  const policyCatalog=JSON.parse(await readFile(new URL('../../../packages/contracts/action-policies.json',import.meta.url),'utf8'));
  const config={channel:'edge',authEnvironment:'development',consoleUrl:'https://localhost:1114'};
  const image='ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:'+'a'.repeat(64);
  const session={subjectId:'10000000-0000-4000-8000-000000000361',sessionId:'10000000-0000-4000-8000-000000000362',
    authorityFresh:true,expiresAt:new Date(Date.now()+60000).toISOString(),permissions:['console.extension.install'],aal:'aal1',permissionRevision:'1',revokeEpoch:'0'};
  let accepted=0;
  const store={get:async()=>null,approve:async()=>null,verify:async()=>null,accept:async input=>{
    accepted++;
    assert.equal(input.localDevelopmentModuleInstall,true);
    assert.equal(input.approvalRequired,true); assert.equal(input.risk,'R2'); assert.equal(input.ownerRef,'C_EXT');
    return {operationRecord:{operation_id:'10000000-0000-4000-8000-000000000363',action_id:input.actionId,
      target_ref:input.targetRef,aal:session.aal,approval_required:true,state:'Planned',state_version:0,created_at:new Date(),updated_at:new Date()}};
  }};
  const service=createOperationService({store,policyCatalog,moduleInstallationPolicy:(action,target)=>localDevelopmentModuleInstall(config,config.consoleUrl,action,target)});
  const operations=createRegistryOperations({operationService:service,policyRevision:policyCatalog.policyRevision,
    registryResolver:{resolveExtension:async input=>({...input,image})}});
  const request={session,body:{descriptorId:'extension.cluster-manager',catalogRevision:'sha256:'+'b'.repeat(64),reason:'install the reviewed module'},idempotencyKey:'module-intake-test',correlationId:'module-intake-correlation'};
  const result=await operations.installCandidate(request);
  assert.equal(result.receipt.aal,'aal1'); assert.equal(result.receipt.state,'Planned');
  assert.equal(result.receipt.assertExtensionInstallIntake,undefined);
  await assert.rejects(()=>operations.installCandidate({...request,body:{...request.body,descriptorId:'extension.other'}}),{code:'StepUpRequired'});
  assert.equal(accepted,1);
});
