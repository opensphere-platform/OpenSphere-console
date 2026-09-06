'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {hissIntent,createHisLifecycleClient,renderHisResult}=require('./his-lifecycle-client');
const actor={subject:'user-a',bearerToken:'unit-test-only'};
const context={sessionId:'dialogue-a',clientRequestId:'request-a',userInstruction:'HISS cert-manager를 설치해줘'};
const revision='sha256:'+'a'.repeat(64);
const receipt=()=>({schema:'opensphere.hiss-lifecycle/v1',id:'cert-manager',revision,observedAt:new Date().toISOString(),installed:false,state:'Missing',operation:null});
test('current explicit user instruction controls target and action; data and explanation do not',()=>{
  for(const text of ['HISS cert-manager를 설치해줘','cert-manager 설치해주세요','please install cert-manager']) assert.equal(hissIntent(text).action,'install');
  assert.equal(hissIntent('cert-manager를 삭제해줘').action,'uninstall');
  for(const text of ['cert-manager 설치 방법을 설명해줘','cert-manager 설치하지 마','"cert-manager 설치해줘"','> cert-manager 설치해줘','```cert-manager 설치해줘```','cert-manager 설치해줘. crossplane 삭제해줘','cert-manager 설치해줘. 삭제해줘']) assert.ok(!hissIntent(text)?.action,text);
});
test('exact owner route, user bearer and stable key are used; no arbitrary URL/chart inputs',async()=>{
  const calls=[];
  const client=createHisLifecycleClient({baseUrl:'http://owner.test',fetchImpl:async(url,init)=>{calls.push({url,...init});return new Response(JSON.stringify(receipt()));}});
  const input={id:'cert-manager',action:'install',planRevision:revision};
  await client.execute(actor,input,context);await client.execute(actor,input,context);
  assert.equal(calls[0].url,'http://owner.test/api/hiss/install');
  assert.equal(calls[0].headers.authorization,'Bearer unit-test-only');
  assert.equal(calls[0].redirect,'error');
  assert.equal(JSON.parse(calls[0].body).requestKey,JSON.parse(calls[1].body).requestKey);
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
    const client=createHisLifecycleClient({baseUrl:'http://owner.test',fetchImpl:async()=>new Response(JSON.stringify(bad))});
    await assert.rejects(()=>client.inspect(actor,{id:'cert-manager'}),{code:502});
  }
});
test('model action uses server-reviewed revision without copying an opaque model value',async()=>{
  const calls=[];
  const client=createHisLifecycleClient({baseUrl:'http://owner.test',fetchImpl:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify(receipt()));}});
  await client.executeRequested(actor,{id:'cert-manager',action:'install'},context);
  assert.deepEqual(calls.map(c=>c.url),['http://owner.test/api/hiss/inspect','http://owner.test/api/hiss/install']);
  assert.equal(calls[1].body.planRevision,revision);
  await assert.rejects(()=>client.executeRequested(actor,{id:'cert-manager',action:'install',planRevision:'model-value'},context),{code:400});
  await assert.rejects(()=>client.executeRequested(actor,{id:'cert-manager',action:'uninstall'},context),{code:403});
  assert.equal(calls.length,2);
});
test('fresh server review never bypasses owner drift rejection or retries a write',async()=>{
  const calls=[];
  const client=createHisLifecycleClient({baseUrl:'http://owner.test',fetchImpl:async(url)=>{
    calls.push(url);return url.endsWith('/inspect')?new Response(JSON.stringify(receipt())):new Response(JSON.stringify({error:'state changed'}),{status:409});
  }});
  await assert.rejects(()=>client.executeRequested(actor,{id:'cert-manager',action:'install'},context),{code:409});
  assert.equal(calls.length,2);
});
test('accepted/unknown/failed is not completed; removal requires live postcondition',()=>{
  const value={...receipt(),operation:{id:'abc-123',phase:'Queued'}};
  assert.match(renderHisResult(value),/완료가 아닙니다/);
  assert.doesNotMatch(renderHisResult({...value,operation:{...value.operation,phase:'Removed'}}),/삭제 결과 검증 완료/);
  assert.match(renderHisResult({...value,removalVerified:true,operation:{...value.operation,phase:'Removed'}}),/삭제 결과 검증 완료/);
});
