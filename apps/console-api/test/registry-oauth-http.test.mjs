import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createOperationService} from '../src/operation-service.mjs';
import {createRegistryOperations} from '../src/registry-operations.mjs';
import {createConsoleApiHandler} from '../src/http-handler.mjs';
import {initialRegistryState,publicRegistryState} from '../src/registry-lifecycle-contract.mjs';
const policies=JSON.parse(readFileSync(new URL('../../../packages/contracts/action-policies.json',import.meta.url)));
function fixture(){
 const session={sessionId:randomUUID(),subjectId:randomUUID(),expiresAt:new Date(Date.now()+3600000).toISOString(),authorityFresh:true,permissions:['console.registry.manage'],aal:'aal2',permissionRevision:1,revokeEpoch:0};
 let record;const order=[];
 const store={async accept(input){order.push('audited');if(record)return {operationRecord:record,replayed:true};record={operation_id:randomUUID(),action_id:input.actionId,action_version:input.actionVersion,actor_ref:input.actorRef,target_ref:input.targetRef,required_permission:input.requiredPermission,payload_digest:input.payloadDigest,request_digest:'sha256:'+'b'.repeat(64),reason:input.reason,risk:input.risk,aal:'aal2',permission_revision:1,approval_required:false,plan_revision:input.planRevision,idempotency_key:input.idempotencyKey,owner_ref:input.ownerRef,state:'Authorized',state_version:0,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),correlation_id:input.correlationId};return {operationRecord:record,replayed:false};},async approve(){},async verify(){},async get(){}};
 const operationService=createOperationService({store,policyCatalog:policies});
 const state=initialRegistryState(null,[]);
 const broker={async beginOAuth(){order.push('device-started');},async status(){return publicRegistryState(state,{clientId:'OpenSphereClientId'});}};
 const registryOperations=createRegistryOperations({operationService,policyRevision:policies.policyRevision,credentialBroker:broker});
 return {session,order,operationService,registryOperations,broker};
}
test('OAuth request requires current permission, aal2 and durable acceptance before starting device flow',async()=>{
 const f=fixture();const request={session:f.session,body:{reason:'Reconnect package registry'},idempotencyKey:'oauth-idempotency-key',correlationId:'oauth-correlation'};
 await assert.rejects(f.registryOperations.beginRegistryOAuth({...request,session:{...f.session,aal:'aal1'}}),{code:'StepUpRequired'});
 await assert.rejects(f.registryOperations.beginRegistryOAuth({...request,session:{...f.session,permissions:[]}}),{code:'PermissionDenied'});assert.deepEqual(f.order,[]);
 const first=await f.registryOperations.beginRegistryOAuth(request);assert.deepEqual(f.order,['audited','device-started']);assert.equal(first.receipt.state,'Authorized');
 const second=await f.registryOperations.beginRegistryOAuth(request);assert.equal(second.replayed,true);assert.equal(f.order.filter(x=>x==='device-started').length,1);
 await assert.rejects(f.registryOperations.beginRegistryOAuth({...request,body:{reason:'normal reason',token:'not-accepted'}}),{code:'ValidationFailed'});
});
test('OAuth HTTP endpoint uses CSRF session resolution and exact idempotency header; no provider secrets returned',async(t)=>{
 const f=fixture();const checks=[];
 const server=createServer(createConsoleApiHandler({...f,resolveSession:async(_request,options)=>{checks.push(options);return f.session;}}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+'/api/admin/extensions/registry-connections/opensphere-ghcr/oauth';
 let response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:'Reconnect package registry'})});assert.equal(response.status,400);assert.equal(f.order.length,0);
 response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-os-idempotency-key':'oauth-http-idempotency','x-os-correlation-id':'oauth-http-correlation'},body:JSON.stringify({reason:'Reconnect package registry'})});
 assert.equal(response.status,202);assert.ok(checks.every(o=>o.requireCsrf===true));
 const text=await response.text();assert.ok(!/access_token|refresh_token|device_code/.test(text));assert.equal(JSON.parse(text).connection.oauthAvailable,true);
});
test('disabled OAuth broker is unavailable and cannot claim authenticated readiness',async()=>{
 const f=fixture();const operations=createRegistryOperations({operationService:f.operationService,policyRevision:policies.policyRevision});
 await assert.rejects(operations.beginRegistryOAuth({session:f.session,body:{reason:'Reconnect packages'},idempotencyKey:'oauth-disabled-key',correlationId:'oauth-disabled-correlation'}),{code:'AuthorityUnavailable'});assert.equal(f.order.length,0);
});