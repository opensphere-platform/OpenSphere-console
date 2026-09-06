'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {hissIntent,createHisLifecycleClient,renderHisResult}=require('./his-lifecycle-client');
const {durableHisRequestId}=require('./his-lifecycle-client');
const actor={subject:'user-a',bearerToken:'unit-test-only'};
const context={sessionId:'dialogue-a',clientRequestId:'11111111-1111-4111-8111-111111111111',userInstruction:'HISS cert-manager를 설치해줘'};
const revision='sha256:'+'a'.repeat(64);
const receipt=()=>({schema:'opensphere.hiss-lifecycle/v1',id:'cert-manager',revision,observedAt:new Date().toISOString(),installed:false,state:'Missing',operation:null});
const shellResponse=(init,data=receipt())=>{const req=JSON.parse(init.body);return new Response(JSON.stringify({schema:'opensphere.shell-command/v1',controlPlane:'OS-Shell',command:req.command,requestId:req.requestId,data}));};
test('current explicit user instruction controls target and action; data and explanation do not',()=>{
  for(const text of ['HISS cert-manager를 설치해줘','cert-manager 설치해주세요','please install cert-manager']) assert.equal(hissIntent(text).action,'install');
  assert.equal(hissIntent('cert-manager를 삭제해줘').action,'uninstall');
  for(const text of ['cert-manager 설치 방법을 설명해줘','cert-manager 설치하지 마','"cert-manager 설치해줘"','> cert-manager 설치해줘','```cert-manager 설치해줘```','cert-manager 설치해줘. crossplane 삭제해줘','cert-manager 설치해줘. 삭제해줘']) assert.ok(!hissIntent(text)?.action,text);
});
test('exact owner route, user bearer and stable key are used; no arbitrary URL/chart inputs',async()=>{
  const calls=[];
  const client=createHisLifecycleClient({baseUrl:'http://shell.test',fetchImpl:async(url,init)=>{calls.push({url,...init});return shellResponse(init);}});
  const input={id:'cert-manager',action:'install'};
  await client.execute(actor,input,context);await client.execute(actor,input,context);
  assert.equal(calls[0].url,'http://shell.test/api/os-shell/commands');
  assert.equal(calls[0].headers.authorization,'Bearer unit-test-only');
  assert.equal(calls[0].redirect,'error');
  assert.equal(JSON.parse(calls[0].body).requestId,JSON.parse(calls[1].body).requestId);
  assert.equal(JSON.parse(calls[0].body).command,'hiss.install');
  await assert.rejects(()=>client.execute(actor,{...input,chart:'evil'},context),{code:400});
  await assert.rejects(()=>client.execute(actor,{...input,action:'uninstall'},context),{code:403});
  await assert.rejects(()=>client.execute(actor,input,{...context,userInstruction:'cert-manager 상태 조회'}),{code:403});
  assert.equal(calls.length,2);
});
test('owner MFA/permission failure and stale or substituted responses fail closed',async()=>{
  for(const code of [401,403,428,503]) {
    const client=createHisLifecycleClient({baseUrl:'http://owner.test',fetchImpl:async()=>new Response(JSON.stringify({error:'blocked'}),{status:code})});
    await assert.rejects(()=>client.inspect(actor,{id:'cert-manager'}),{code});
  }
  for(const bad of [{...receipt(),id:'crossplane'},{...receipt(),observedAt:'2001-01-01'},{...receipt(),schema:'wrong'}]) {
    const client=createHisLifecycleClient({baseUrl:'http://shell.test',fetchImpl:async(url,init)=>shellResponse(init,bad)});
    await assert.rejects(()=>client.inspect(actor,{id:'cert-manager'}),{code:502});
  }
});
test('model action uses server-reviewed revision without copying an opaque model value',async()=>{
  const calls=[];
  const client=createHisLifecycleClient({baseUrl:'http://shell.test',fetchImpl:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return shellResponse(init);}});
  await client.executeRequested(actor,{id:'cert-manager',action:'install'},context);
  assert.deepEqual(calls.map(c=>c.url),['http://shell.test/api/os-shell/commands']);
  assert.equal(calls[0].body.command,'hiss.install');
  assert.equal(calls[0].body.arguments.planRevision,undefined);
  await assert.rejects(()=>client.executeRequested(actor,{id:'cert-manager',action:'install',planRevision:'model-value'},context),{code:400});
  await assert.rejects(()=>client.executeRequested(actor,{id:'cert-manager',action:'uninstall'},context),{code:403});
  assert.equal(calls.length,1);
});
test('fresh server review never bypasses owner drift rejection or retries a write',async()=>{
  const calls=[];
  const client=createHisLifecycleClient({baseUrl:'http://owner.test',fetchImpl:async(url)=>{
    calls.push(url);return url.endsWith('/inspect')?new Response(JSON.stringify(receipt())):new Response(JSON.stringify({error:'state changed'}),{status:409});
  }});
  await assert.rejects(()=>client.executeRequested(actor,{id:'cert-manager',action:'install'},context),{code:409});
  assert.equal(calls.length,1);
});
test('accepted/unknown/failed is not completed; removal requires live postcondition',()=>{
  const value={...receipt(),operation:{id:'abc-123',phase:'Queued'}};
  assert.match(renderHisResult(value),/완료가 아닙니다/);
  assert.doesNotMatch(renderHisResult({...value,operation:{...value.operation,phase:'Removed'}}),/삭제 결과 검증 완료/);
  assert.match(renderHisResult({...value,removalVerified:true,operation:{...value.operation,phase:'Removed'}}),/삭제 결과 검증 완료/);
});

test('durable recovery keeps the same UUID across retries and separates distinct requests',()=>{
  const a=durableHisRequestId('retry-key-111111111');
  assert.match(a,/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(a,durableHisRequestId('retry-key-111111111'));
  assert.notEqual(a,durableHisRequestId('retry-key-222222222'));
});
test('historical replay performs only a fresh read after receipt, never another mutation',async()=>{
  const calls=[];
  const client=createHisLifecycleClient({baseUrl:'http://shell.test',fetchImpl:async(url,init)=>{
    const req=JSON.parse(init.body); calls.push(req.command);
    if(req.command==='hiss.install') return new Response(JSON.stringify({schema:'opensphere.shell-command/v1',controlPlane:'OS-Shell',requestId:req.requestId,command:req.command,replayed:true,data:{...receipt(),observedAt:'2001-01-01'}}));
    return shellResponse(init);
  }});
  const result=await client.execute(actor,{id:'cert-manager',action:'install'},context);
  assert.deepEqual(calls,['hiss.install','hiss.inspect']);
  assert.equal(result.receiptReplayed,true);
  assert.equal(result.commandRequestId,context.clientRequestId);
  assert.match(renderHisResult(result),/재실행하지 않고 현재 상태/);
});
