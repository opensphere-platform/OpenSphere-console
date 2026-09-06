'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCommandService}=require('./commands');
const requestId='11111111-1111-4111-8111-111111111111';
const subjectId='22222222-2222-4222-8222-222222222222';
const sessionId='33333333-3333-4333-8333-333333333333';
const revision='sha256:'+'a'.repeat(64);
const input=()=>({command:'sample-owner.install',arguments:{id:'cert-manager',reason:'operator lifecycle test'},requestId});
function fixture(options={}){
 const records=options.records||new Map();
 const ledger={async claim(a,id,command,digest){const key=a.subjectId+id;const old=records.get(key);if(old)return old.digest!==digest||old.command!==command?{conflict:true}:{claimed:false,result:old.result};records.set(key,{digest,command});return {claimed:true};},async finish(a,id,digest,result){records.get(a.subjectId+id).result=result;}};
 const calls=[];const actor={state:'Active',subjectId,sessionId,permissions:['console.role.admin'],aal:'aal1',...options.actor};
 const providers=['install','uninstall'].map(action=>({id:'sample-owner.'+action,owner:'sample-owner',origin:'http://cm.test',provider:true,read:false,
  contractSha256:'sha256:'+'a'.repeat(64),fields:['id','reason',...(action==='uninstall'?['confirm']:[])],
  argumentSchema:{type:'object',additionalProperties:false,required:['id','reason',...(action==='uninstall'?['confirm']:[])],properties:{id:{type:'string',maxLength:64,enum:['cert-manager']},reason:{type:'string',minLength:8,maxLength:500},...(action==='uninstall'?{confirm:{type:'string',maxLength:64,enum:['cert-manager']}}:{})}}}));
 const service=createCommandService({identityUrl:'http://identity.test',ledger,loadProviders:async()=>providers,
  readProfile:()=>JSON.stringify(options.profile||{consoleUrl:'https://localhost:1114',channel:'edge'}),
  fetchImpl:async(url,init)=>{
   const body=init.body?JSON.parse(init.body):null;calls.push({url,body,authorization:init.headers.authorization});
   if(url.includes('identity.test'))return new Response(JSON.stringify({schemaVersion:'1.0',authority:'SupabaseAuth',freshness:'fresh',observedAt:new Date().toISOString(),data:actor}));
   if(body?.reviewRevision&&body.reviewRevision!==revision)return new Response(JSON.stringify({error:'review changed'}),{status:409});
   if(options.writeFailure)throw Error('connection lost after send');
   if(options.conflict)return new Response(JSON.stringify({error:'review changed'}),{status:409});
   return Response.json({schema:'opensphere.owner-command-result/v1',owner:'sample-owner',command:body.command,requestId:options.foreignReceipt?sessionId:body.requestId,observedAt:new Date().toISOString(),data:{operation:{id:'op-abc',phase:'Queued'},installed:false}},{status:202});
  }});
 return {service,calls,records,request:{headers:{authorization:'Bearer '+'u'.repeat(48)}}};
}
test('GUI, CLI and 22 credentials use the same policy, owner and durable request key',async()=>{
 const f=fixture();let key;
 for(const source of ['gui','cli','r2d2']){
  const result=await f.service.execute({headers:{authorization:'Bearer '+source.repeat(40)}},input());
  assert.equal(result.status,202);assert.equal(result.body.controlPlane,'OS-Shell');assert.equal(result.body.operationId,'op-abc');assert.equal(result.body.data.operation.phase,'Queued');
  const write=f.calls.find(c=>c.url.endsWith('/api/commands'));assert.equal(write.url,'http://cm.test/api/commands');assert.deepEqual(write.body,input());
  assert.equal(write.body.requestId,requestId);if(key)assert.equal(write.body.requestId,key);key=write.body.requestId;
 }
 assert.equal(f.calls.filter(c=>c.url.endsWith('/api/commands')).length,1);
 const restarted=fixture({records:f.records});assert.equal((await restarted.service.execute(restarted.request,input())).body.replayed,true);
 assert.equal(restarted.calls.filter(c=>c.url.endsWith('/api/commands')).length,0);
 await assert.rejects(()=>restarted.service.execute(restarted.request,{...input(),arguments:{...input().arguments,reason:'different request reason'}}),{status:409,code:'IdempotencyConflict'});
});
test('all consumers obey current roles and trusted localhost edge MFA policy',async()=>{
 for(const actor of [{permissions:['console.role.viewer']},{permissions:[]}]){
  const f=fixture({actor});await assert.rejects(()=>f.service.execute(f.request,input()),{status:403});assert.equal(f.calls.length,1);
 }
 for(const profile of [{consoleUrl:'https://production.example',channel:'edge'},{consoleUrl:'https://localhost:1114',channel:'stable'},{consoleUrl:'http://localhost:1114',channel:'edge'}]){
  const f=fixture({profile});await assert.rejects(()=>f.service.execute(f.request,input()),{status:428});assert.equal(f.calls.length,1);
 }
 const f=fixture({actor:{aal:'aal2'},profile:{consoleUrl:'https://production.example',channel:'stable'}});
 assert.equal((await f.service.execute(f.request,input())).status,202);
});
test('unknown command, arbitrary endpoint, unconfirmed delete and raw cookies never reach an owner',async()=>{
 const f=fixture();
 for(const body of [{...input(),command:'toString'},{...input(),url:'http://other'},{...input(),arguments:{...input().arguments,url:'http://other'}},{...input(),command:'hiss.uninstall'}])await assert.rejects(()=>f.service.execute(f.request,body));
 await assert.rejects(()=>f.service.execute({headers:{...f.request.headers,cookie:'session=bad'}},input()),{status:403});
 assert.equal(f.calls.length,0);
});
test('stale client review and owner drift stay conflicts; indeterminate writes are never silently retried',async()=>{
 const stale=fixture();assert.equal((await stale.service.execute(stale.request,{...input(),reviewRevision:'sha256:'+'b'.repeat(64)})).status,409);assert.equal(stale.calls.length,2);
 for(const options of [{conflict:true},{writeFailure:true}]){
  const f=fixture(options);const outcome=await f.service.execute(f.request,input());assert.equal(outcome.status,options.conflict?409:503);
  if(options.writeFailure)assert.equal(outcome.body.sideEffect,'unknown');
  assert.equal((await f.service.execute(f.request,input())).body.replayed,true);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/api/commands')).length,1);
 }
});

test('a persisted dispatch with no receipt stays uncertain and cannot execute again',async()=>{
 const f=fixture();await f.service.execute(f.request,input());
 for(const record of f.records.values())delete record.result;
 const restarted=fixture({records:f.records});
 await assert.rejects(()=>restarted.service.execute(restarted.request,input()),{status:409,code:'CommandOutcomePending',sideEffect:'unknown'});
 assert.equal(restarted.calls.filter(c=>c.url.endsWith('/api/commands')).length,0);
});
test('a foreign owner receipt cannot become success or cause an automatic retry',async()=>{
 const f=fixture({foreignReceipt:true});
 const result=await f.service.execute(f.request,input());
 assert.equal(result.status,502); assert.equal(result.body.code,'OwnerContractInvalid');
 assert.equal(result.body.sideEffect,'unknown');
 assert.equal((await f.service.execute(f.request,input())).body.replayed,true);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/api/commands')).length,1);
});
