import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdentitySessionBroker} from '../src/identity-session-broker.mjs';
import {createShellDelegationBroker} from '../src/shell-delegation.mjs';
import {createClusterManagerAudit} from '../src/cluster-manager-audit.mjs';
import {randomBytes} from 'node:crypto';

const noCall=async()=>{throw Error('unrelated credential flow invoked');};
function identity(resolveCommandShellSession){
 return createIdentitySessionBroker({
  store:Object.fromEntries(['resolveSession','issueSession','getPendingMfa','activateMfa','getRefreshCredentials','rotateCredentials','rejectRefresh','touchActivity','listOwnedSessions','revokeOwnedSession','revokeAllOwnedSessions'].map(k=>[k,noCall])),
  authClient:Object.fromEntries(['authenticatePassword','completeTotp','refreshSession','logout'].map(k=>[k,noCall])),
  credentialCipher:{encrypt:noCall,decrypt:noCall},publicOrigin:'https://localhost:1114',resolveCommandShellSession,
 });
}
const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'opensphere-shell-delegation+jwt'})).toString('base64url');
const request=(method,url,marker)=>({method,url,headers:{authorization:`Bearer ${header}.e30.invalid`, 'x-os-owner-admission':marker}});
test('public Shell introspection delegates to the signature verifier and cannot access other public routes',async()=>{
 let calls=0;
 const broker=identity(async()=>{calls++;return {authorityFresh:true,credentialKind:'web_shell'};});
 await broker.resolveSession(request('GET','/api/identity/me','os-shell-control-v1'));
 await broker.resolveSession(request('POST','/api/internal/cluster-manager/events','extension-controller-v1'));
 for(const [method,url,marker] of [['POST','/api/os-shell/commands','os-shell-control-v1'],['POST','/api/identity/users','extension-controller-v1'],['GET','/api/identity/me','untrusted']]) {
  await assert.rejects(()=>broker.resolveSession(request(method,url,marker)),{status:401});
 }
 assert.equal(calls,2);
 const verifier=createShellDelegationBroker({query:noCall,delegationSecret:randomBytes(32).toString('hex'),signingKey:randomBytes(32)});
 const real=identity(verifier.resolveSession);
 await assert.rejects(()=>real.resolveSession(request('GET','/api/identity/me','os-shell-control-v1')),{status:401});
 const revoked=identity(async()=>({authorityFresh:false,revokedAt:new Date().toISOString()}));
 await assert.rejects(()=>revoked.resolveSession(request('GET','/api/identity/me','os-shell-control-v1')),{status:401});
});

test('audit uses the verified credential family and never treats CLI AAL1 as browser AAL2',async()=>{
 const calls=[];const append=createClusterManagerAudit({query:async(sql,args)=>{calls.push({sql,args});return {rows:[{receipt:{eventId:'test'}}]};}});
 const body={source:'cluster-manager',action:'HISInstallRequested',target:'HISS/cert-manager',outcome:'accepted',reason:'approved test request',correlationId:'request-1',metadataDigest:'sha256:'+'a'.repeat(64)};
 const base={sessionId:'11111111-1111-4111-8111-111111111111',subjectId:'22222222-2222-4222-8222-222222222222',authorityFresh:true,permissions:['console.role.admin'],permissionRevision:'1',revokeEpoch:'0',aal:'aal1'};
 await append({session:{...base,credentialType:'cli-device'},body});
 await append({session:{...base,credentialKind:'web_shell'},body});
 assert.match(calls[0].sql,/append_cluster_manager_cli_event/);
 assert.match(calls[1].sql,/append_cluster_manager_event/);
 await assert.rejects(()=>append({session:{...base,credentialType:'cli-device',authorityFresh:false},body}),{status:403});
});
