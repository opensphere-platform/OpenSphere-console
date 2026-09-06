import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createClusterManagerAudit, validateClusterManagerEvent} from '../src/cluster-manager-audit.mjs';
import {createConsoleApiHandler} from '../src/http-handler.mjs';

const event = {source:'cluster-manager',action:'HISCanaryValidationRequested',target:'HISS/network',outcome:'accepted',reason:'Verify the existing network',correlationId:'verify-network-1',metadataDigest:'sha256:'+'a'.repeat(64)};
const session = {authorityFresh:true,credentialType:'owner-access',sessionId:'22222222-2222-4222-8222-222222222222',subjectId:'11111111-1111-4111-8111-111111111111',permissions:['console.role.admin'],permissionRevision:'4',revokeEpoch:'2'};

test('owner audit binds current actor and revisions; no request-supplied actor or raw metadata',async()=>{
  let values;
  const append=createClusterManagerAudit({query:async(sql,args)=>{values=args;return {rows:[{receipt:{eventId:'event-1'}}]};}});
  assert.deepEqual(await append({session,body:event}),{eventId:'event-1'});
  assert.deepEqual(values.slice(0,4),[session.sessionId,session.subjectId,'4','2']);
  for(const body of [{...event,userActor:'someone'},{...event,metadata:{key:'secret'}},{...event,action:'GrantRole'},{...event,target:'Identity/admin'}]) assert.throws(()=>validateClusterManagerEvent(body));
  await assert.rejects(append({session:{...session,permissions:[]},body:event}));
  await assert.rejects(append({session:{...session,credentialType:'browser'},body:event}));
});

test('HTTP bridge parses the real POST, rejects cookies and other owner markers',async(t)=>{
  let recorded=0;
  const handler=createConsoleApiHandler({resolveSession:async()=>session,clusterManagerAudit:async({body})=>{assert.deepEqual(body,event);recorded++;return {eventId:'event-1'};}});
  const server=createServer(handler); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}/api/internal/cluster-manager/events`;
  const post=headers=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(event)});
  assert.equal((await post({'x-os-owner-admission':'extension-controller-v1'})).status,201);
  assert.equal((await post({'x-os-owner-admission':'osaa-gateway-v1'})).status,403);
  assert.equal((await post({'x-os-owner-admission':'extension-controller-v1',cookie:'browser=x'})).status,403);
  assert.equal(recorded,1);
});
