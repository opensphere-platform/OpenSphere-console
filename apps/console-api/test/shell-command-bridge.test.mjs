import test from 'node:test';import assert from 'node:assert/strict';
import {createShellCommandBridge} from '../src/shell-command-bridge.mjs';
test('browser CSRF exchange and CLI/delegated bearer converge on OS Shell only',async()=>{
 const calls=[];const resolutions=[];let exchanges=0;
 const bridge=createShellCommandBridge({baseUrl:'http://shell.test',fetchImpl:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({controlPlane:'OS-Shell'}),{status:202});}});
 for(const authorization of [undefined,'Bearer cli-credential','Bearer delegated-shell-credential']){
  const result=await bridge({request:{method:'POST',headers:authorization?{authorization}:{cookie:'session-only'}},body:{command:'hiss.install'},correlationId:'trace',
   resolveSession:async(req,options)=>{resolutions.push(options);return {subjectId:'user',sessionId:'session',authorityFresh:true};},
   identitySessionBroker:{exchangeOwnerAccessCredential:async(req,options)=>{assert.equal(options.requireCsrf,true);exchanges++;return {authorization:'Bearer owner-credential'};}}});
  assert.equal(result.status,202);
 }
 assert.equal(exchanges,1);assert.ok(resolutions.every(o=>o.requireCsrf));assert.ok(calls.every(c=>c.url==='http://shell.test/api/os-shell/commands'&&!c.init.headers.cookie));
});
test('revoked identity fails before dispatch and timeout keeps unknown side effects',async()=>{
 let calls=0;const bridge=createShellCommandBridge({baseUrl:'http://shell.test',fetchImpl:async()=>{calls++;throw Error('timeout');}});
 const args={request:{method:'POST',headers:{authorization:'Bearer user'}},body:{},correlationId:'trace'};
 await assert.rejects(()=>bridge({...args,resolveSession:async()=>({subjectId:'u',sessionId:'s',revokedAt:'now',authorityFresh:true})}),{status:401});assert.equal(calls,0);
 await assert.rejects(()=>bridge({...args,resolveSession:async()=>({subjectId:'u',sessionId:'s',authorityFresh:true})}),{sideEffect:'unknown'});assert.equal(calls,1);
});
