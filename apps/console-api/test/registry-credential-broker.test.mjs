import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRegistryCredentialBroker} from '../src/registry-credential-broker.mjs';
import {initialRegistryState,registryStateSecret,parseRegistryState,pullSecretData,publicRegistryState,REGISTRY_NAMESPACES} from '../src/registry-lifecycle-contract.mjs';
import {createRegistrySecretStore,registryKubernetesOrigin} from '../src/registry-secret-store.mjs';
const credential=()=>({username:'opensphere',token:randomBytes(32).toString('hex'),lifecycle:{schemaVersion:'1.0',mode:'github-device',userId:'42',scopes:['read:packages'],clientId:'OpenSphereClientId',expiresAt:new Date(Date.now()+300000).toISOString(),refreshToken:randomBytes(32).toString('hex'),refreshExpiresAt:new Date(Date.now()+86400000).toISOString(),verifiedAt:new Date().toISOString(),refreshPolicy:'automatic'}});
const image='ghcr.io/opensphere-platform/opensphere-console@sha256:'+'a'.repeat(64);
function fixture({refreshDue=false}={}){
 let time=Date.now(),version=1;const cred=credential();if(!refreshDue)cred.lifecycle.expiresAt=new Date(time+28800000).toISOString();
 let state=initialRegistryState(cred,[image]);const events=[];let refreshes=0,syncs=0;
 const store={async read(){return {state:structuredClone(state),version};},async write(snapshot,next){if(snapshot.version!==version)throw Object.assign(new Error('conflict'),{code:'CredentialConflict'});state=structuredClone(next);version++;return this.read();},async synchronize(c,generation){syncs++;assert.equal(state.credentials?.token,c?.token);assert.equal(state.generation,generation);return [...REGISTRY_NAMESPACES];}};
 const provider={async inspect(){},async verifyImages(){},async refresh(){refreshes++;const next=credential();next.lifecycle.expiresAt=new Date(time+28800000).toISOString();return next;},async pat(c){return c;}};
 const broker=createRegistryCredentialBroker({store,provider,now:()=>time,assertAuthority:async()=>{},recordResult:async(e)=>events.push(e)});
 return {broker,store,provider,events,get state(){return state;},get refreshes(){return refreshes;},get syncs(){return syncs;},advance(ms){time+=ms;}};
}
test('handoff secret keeps refresh credential out of every image pull secret and public status',()=>{
 const c=credential(),state=initialRegistryState(c,[image]);assert.equal(parseRegistryState(registryStateSecret(state)).credentials.lifecycle.refreshToken,c.lifecycle.refreshToken);
 const docker=Buffer.from(pullSecretData(c,state.generation)['.dockerconfigjson'],'base64').toString();assert.ok(docker.includes(c.token));assert.ok(!docker.includes(c.lifecycle.refreshToken));
 const response=JSON.stringify(publicRegistryState(state));assert.ok(!response.includes(c.token));assert.ok(!response.includes(c.lifecycle.refreshToken));
});
test('runtime verifies and observes all five secret generations before Ready',async()=>{
 const f=fixture();assert.equal((await f.broker.status()).verified,false);await f.broker.tick();assert.equal(f.state.phase,'Ready');assert.equal(f.syncs,1);assert.equal(f.events[0].code,'PullSecretsVerified');assert.equal((await f.broker.status()).verified,true);
 f.advance(21*60000);assert.equal((await f.broker.status()).phase,'Stale');assert.equal((await f.broker.status()).verified,false);
});
test('two replicas never redeem the same refresh token concurrently',async()=>{
 const f=fixture({refreshDue:true});const old=f.state.credentials.token;
 await Promise.allSettled([f.broker.tick(),f.broker.tick()]);assert.equal(f.refreshes,1);assert.notEqual(f.state.credentials.token,old);assert.equal(f.state.phase,'Pending');assert.equal(f.syncs,0);
 await f.broker.tick();assert.equal(f.state.phase,'Ready');assert.equal(f.syncs,1);
});
test('ambiguous refresh failure requires reauthorization, with no blind retry',async()=>{
 const f=fixture({refreshDue:true});let called=0;f.provider.refresh=async()=>{called++;throw Object.assign(new Error('network after provider consumed token'),{code:'ProviderUnavailable'});};
 await f.broker.tick();assert.equal(f.state.phase,'ReauthorizationRequired');f.advance(300000);await f.broker.tick();assert.equal(called,1);assert.equal((await f.broker.status()).verified,false);
});
test('abandoned refresh fence becomes Unknown rather than redeeming again',async()=>{
 const f=fixture();const snapshot=await f.store.read();await f.store.write(snapshot,{...snapshot.state,work:{id:randomUUID(),kind:'refresh',startedAt:Date.now()-121000}});
 await f.broker.tick();assert.equal(f.state.phase,'ReauthorizationRequired');assert.equal(f.refreshes,0);assert.equal(f.events[0].outcome,'unknown');
});
test('partial secret propagation is Degraded, never Ready',async()=>{
 const f=fixture();f.store.synchronize=async()=>{throw Object.assign(new Error('unavailable'),{code:'CredentialAuthorityUnavailable'});};
 await f.broker.tick();assert.equal(f.state.phase,'Degraded');assert.equal(f.state.observation,null);assert.equal((await f.broker.status()).verified,false);
});
test('device code is redacted, user code is visible only to initiating actor',()=>{
 const c=credential(),state=initialRegistryState(c,[image]);state.pending={actorRef:'actor-a',flow:{deviceCode:randomBytes(32).toString('hex'),userCode:'ABCD-1234',verificationUri:'https://github.com/login/device',expiresAt:new Date(Date.now()+60000).toISOString()}};
 assert.equal(publicRegistryState(state,{actorRef:'actor-b'}).authorization,null);
 const output=publicRegistryState(state,{actorRef:'actor-a'});assert.equal(output.authorization.userCode,'ABCD-1234');assert.ok(!JSON.stringify(output).includes(state.pending.flow.deviceCode));
});
test('Kubernetes store accesses only named Secrets, preserving resourceVersion and public client ID',async()=>{
 const c=credential(),state=initialRegistryState(c,[image]);let source=registryStateSecret(state);source.metadata.resourceVersion='1';source.data['oauth-client-id']=Buffer.from('OpenSphereClientId').toString('base64');const calls=[];
 const store=createRegistrySecretStore({requestImpl:async(method,path,body)=>{calls.push({method,path,body});if(method==='GET')return structuredClone(source);assert.equal(body.metadata.resourceVersion,'1');source={...body,metadata:{...body.metadata,resourceVersion:'2'}};return source;}});
 const snapshot=await store.read();await store.write(snapshot,{...state,phase:'Pending'});assert.ok(source.data['oauth-client-id']);assert.ok(calls.every(c=>c.path==='/api/v1/namespaces/opensphere-console/secrets/opensphere-registry-auth'));assert.equal(calls[1].method,'PUT');
});
test('stale fan-out fence cannot overwrite a successor credential generation',async()=>{
 const c=credential(),state=initialRegistryState(c,[image]);const owner=registryStateSecret(state);owner.metadata.resourceVersion='new-owner-version';let puts=0;
 const store=createRegistrySecretStore({requestImpl:async(method,path)=>{
   if(method==='PUT'){puts++;throw new Error('must not write');}
   if(path.endsWith('/opensphere-registry-auth'))return owner;
   return {metadata:{name:'opensphere-ghcr-pull',resourceVersion:'old-pull-version'},type:'kubernetes.io/dockerconfigjson',data:pullSecretData(null,'previous')};
 }});
 await assert.rejects(store.synchronize(c,state.generation,{secret:{metadata:{resourceVersion:'old-owner-version'}}}),{code:'CredentialConflict'});assert.equal(puts,0);
});
test('revoked actor cannot complete a pending browser authorization',async()=>{
 const f=fixture();const snap=await f.store.read();await f.store.write(snap,{...snap.state,pending:{sessionId:randomUUID(),actorRef:randomUUID(),flow:{nextPollAt:0,expiresAt:new Date(Date.now()+60000).toISOString()}}});let polls=0;
 f.provider.poll=async()=>{polls++;};
 const broker=createRegistryCredentialBroker({store:f.store,provider:f.provider,assertAuthority:async()=>{throw Object.assign(new Error('revoked'),{code:'PermissionDenied'});},recordResult:async()=>{}});
 await broker.tick();assert.equal(polls,0);assert.equal(f.state.phase,'ReauthorizationRequired');
});
test('runtime revalidates newly installed image digests after a release change',async()=>{
 const f=fixture();await f.broker.tick();const added='ghcr.io/opensphere-platform/opensphere-registry@sha256:'+'b'.repeat(64);let checked;
 f.provider.verifyImages=async(_credential,images)=>{checked=images;};
 const broker=createRegistryCredentialBroker({store:f.store,provider:f.provider,installationImages:async()=>[image,added],recordResult:async()=>{},assertAuthority:async()=>{}});
 await broker.tick();assert.deepEqual(f.state.images,[image,added]);assert.deepEqual(checked,[image,added]);assert.equal(f.state.phase,'Ready');
});

test('Kubernetes authority origin supports IPv6 and rejects URL injection or invalid ports',()=>{
 assert.equal(registryKubernetesOrigin({}), 'https://kubernetes.default.svc:443');
 assert.equal(registryKubernetesOrigin({KUBERNETES_SERVICE_HOST:'10.96.0.1'}),'https://10.96.0.1:443');
 assert.equal(registryKubernetesOrigin({KUBERNETES_SERVICE_HOST:'fd00::1',KUBERNETES_SERVICE_PORT_HTTPS:'7443'}),'https://[fd00::1]:7443');
 for(const env of [{KUBERNETES_SERVICE_HOST:'evil.example/path'},{KUBERNETES_SERVICE_HOST:'user@example.com'},{KUBERNETES_SERVICE_PORT_HTTPS:'0'},{KUBERNETES_SERVICE_PORT_HTTPS:'65536'}])assert.throws(()=>registryKubernetesOrigin(env),/Invalid Kubernetes registry authority/);
});
