'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {generateKeyPairSync,sign,createHash}=require('node:crypto');
const {createRegistryCommandProviders,parseContract}=require('./command-providers');
const {createCommandService}=require('./commands');
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const owner='example-owner';
 const empty={type:'object',additionalProperties:false,properties:{},required:[]};
 const contract=JSON.stringify({schema:'opensphere.owner-commands/v2',owner,version:'2.0.0',commands:[
  {id:owner+'.configure',description:'Configure an existing owned object',mutation:true,statusCommand:owner+'.inspect',arguments:{type:'object',additionalProperties:false,required:['reason'],properties:{reason:{type:'string',minLength:8,maxLength:500}}}},
  {id:owner+'.inspect',description:'Observe the owned object',mutation:false,arguments:empty}]});
 const manifest=JSON.stringify({id:owner,contributions:{cli:{enabled:true,namespace:owner,manifestPath:'/contracts/owner-commands.json'}},assets:[{id:'owner-commands',path:'/contracts/owner-commands.json',type:'data',sha256:sha(contract)}]});
 const signature=sign('sha256',Buffer.from(manifest),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
 const snapshot={observedAt:new Date().toISOString(),stale:false,trustedKeys:{test:publicKey.export({format:'der',type:'spki'}).toString('base64')},plugins:[{id:owner,available:true,hostRef:'main',keyId:'test',installedDigest:'sha256:'+'a'.repeat(64),artifactServiceId:owner+'-r-'+'b'.repeat(20),manifestSha256:sha(manifest),contributions:{cli:{enabled:true,namespace:owner,manifestPath:'/contracts/owner-commands.json'}}}]};
 let bad=false;const calls=[];
 const load=createRegistryCommandProviders({registryUrl:'http://registry.test',fetchImpl:async url=>{calls.push(url);if(url.endsWith('/api/v1/registry'))return Response.json(snapshot);if(url.endsWith('.sig'))return new Response(signature);if(url.endsWith('ui-shell.manifest.json'))return new Response(manifest);return new Response(bad?contract+' ':contract);}});
 return {snapshot,load,calls,tamper:()=>{bad=true;}};
}
test('only signed, active owner contracts are discovered; disabling removes commands',async()=>{
 const f=fixture();const commands=await f.load();assert.equal(commands.length,2);assert.match(commands[0].origin,/^http:\/\/example-owner-r-[b]{20}\.opensphere-console\.svc\.cluster\.local:8080$/);
 f.snapshot.plugins[0].available=false;assert.deepEqual(await f.load(),[]);
});
test('contract tamper, stale snapshot and foreign service coordinates fail closed',async()=>{
 for(const mutate of [f=>f.tamper(),f=>f.snapshot.stale=true,f=>f.snapshot.plugins[0].artifactServiceId='foreign-service']){
  const f=fixture();mutate(f);await assert.rejects(f.load(),{code:'CommandProviderUnavailable'});
 }
});
test('owner cannot publish another namespace or override shared permission policy',()=>{
 assert.throws(()=>parseContract({schema:'opensphere.owner-commands/v2',owner:'x',version:'1.0.0',commands:[{id:'y.install',description:'x',mutation:false,arguments:{}}]},'x'));
 assert.throws(()=>parseContract({schema:'opensphere.owner-commands/v2',owner:'x',version:'1.0.0',commands:[{id:'x.install',description:'x',mutation:true,arguments:{}}]},'x'));
});
test('owner-contributed mutation shares actor authority, MFA and durable replay across clients',async()=>{
 const f=fixture(),providers=await f.load(),records=new Map();let writes=0;
 const subjectId='11111111-1111-4111-8111-111111111111',sessionId='22222222-2222-4222-8222-222222222222';
 const service=createCommandService({identityUrl:'http://identity.test',clusterManagerUrl:'http://cm.test',loadProviders:async()=>providers,
  readProfile:()=>JSON.stringify({consoleUrl:'https://localhost:1114',channel:'edge'}),
  ledger:{claim:async(a,id,cmd,digest)=>{const old=records.get(id);if(old)return old.digest===digest?{claimed:false,result:old.result}:{conflict:true};records.set(id,{digest});return {claimed:true};},finish:async(a,id,d,r)=>{records.get(id).result=r;}},
  fetchImpl:async (url,init)=>{if(url.includes('identity.test'))return Response.json({schemaVersion:'1.0',authority:'SupabaseAuth',freshness:'fresh',observedAt:new Date().toISOString(),data:{state:'Active',subjectId,sessionId,permissions:['console.role.admin'],aal:'aal1'}});writes++;const body=JSON.parse(init.body);return Response.json({schema:'opensphere.owner-command-result/v1',owner:'example-owner',command:body.command,requestId:body.requestId,observedAt:new Date().toISOString(),data:{state:'Accepted'}});}});
 const input={command:'example-owner.configure',arguments:{reason:'reviewed owner operation'},requestId:'33333333-3333-4333-8333-333333333333'};
 for(const client of ['gui','cli','r2d2']){const r=await service.execute({headers:{authorization:'Bearer '+client.repeat(40)}},input);assert.equal(r.body.owner,'example-owner');assert.equal(r.body.controlPlane,'OS-Shell');}
 assert.equal(writes,1);
 await assert.rejects(service.execute({headers:{authorization:'Bearer '+'x'.repeat(48)}},{...input,arguments:{...input.arguments,url:'https://other'}}),{code:'ValidationFailed'});
});
