import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import yaml from 'js-yaml';
import Ajv from 'ajv/dist/2020.js';
const require=createRequire(import.meta.url);
const {definitions,validate:validateCommand}=require('../apps/os-shell-control/commands.js');
const {parseContract}=require('../apps/os-shell-control/command-providers.js');
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const schema=p=>JSON.parse(read('packages/contracts/schemas/'+p));

test('published envelope is owner-independent while current command schemas reject foreign inputs',()=>{
 const validate=new Ajv({strict:false,validateFormats:false}).compile(schema('shell-command-request.schema.json'));
 const request={command:'console.modules.install',arguments:{descriptorId:'extension.cluster-manager',catalogRevision:'sha256:'+'a'.repeat(64),reason:'operator installation request'},requestId:'11111111-1111-4111-8111-111111111111'};
 assert.equal(validate(request),true,JSON.stringify(validate.errors));
 for(const bad of [{...request,command:'exec'},{...request,actor:'someone'}])assert.equal(validate(bad),false);
 for(const bad of [{...request,arguments:{...request.arguments,command:'kubectl'}},{...request,arguments:{...request.arguments,chartVersion:'untrusted'}}])assert.throws(()=>validateCommand(bad),{code:'ValidationFailed'});
 for(const def of Object.values(definitions))assert.equal(validate({...request,command:def.id,arguments:{}}),true);
 const api=yaml.load(read('packages/contracts/openapi/console-v1.yaml'));
 assert.equal(api.paths['/api/os-shell/commands'].post.operationId,'executeShellCommand');
 assert.equal(schema('shell-command-request.schema.json').properties.command.enum,undefined);
 assert.equal(api.paths['/api/commands'].post.operationId,'executeInstalledOwnerCommand');
});

test('signed Cluster Manager GUI uses same-origin Shell transport; unrelated plugin URLs remain confined',async()=>{
 const ts=require('typescript');
 const source=read('apps/console-web/src/app/core/extension-host.service.ts');
 const method=source.slice(source.indexOf('  private async fetchForPlugin('),source.indexOf('  private normalizeManualContribution('));
 const compiled=ts.transpileModule('class Host { http:any; '+method+' }; globalThis.Host=Host;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const ctx={URL,Request,Headers,location:{origin:'https://localhost:1114'}};vm.runInNewContext(compiled,ctx);
 const host=new ctx.Host();const calls=[];host.http={request:async(...args)=>{calls.push(args);return 'response';}};
 const manifest={id:'cluster-manager',apiBase:'/api/plugins/cluster-manager/versions/current',contributions:{api:{basePath:'/api/plugins/cluster-manager'},cli:{enabled:true,namespace:'cluster-manager',manifestPath:'/contracts/owner-commands.json'}}};
 const init={method:'POST',body:JSON.stringify({command:'cluster-manager.hiss.status',arguments:{},requestId:'request'})};
 assert.equal(await host.fetchForPlugin(manifest,'/api/os-shell/commands',init),'response');
 assert.equal(calls[0][0],'/api/os-shell/commands');
 await assert.rejects(()=>host.fetchForPlugin(manifest,'/api/os-shell/commands',{...init,method:'DELETE'}));
 await assert.rejects(()=>host.fetchForPlugin(manifest,'/api/os-shell/commands',{...init,body:'{"command":"arbitrary.exec"}'}));
 await host.fetchForPlugin({...manifest,id:'other'},'/api/os-shell/commands',init);
 assert.ok(String(calls.at(-1)[0]).startsWith('https://localhost:1114/api/plugins/cluster-manager/'));
 assert.equal(calls.filter(c=>String(c[0])==='/api/os-shell/commands').length,1);
});

test('versioned original-product fixtures conform without importing sibling source',()=>{
 const validate=new Ajv({strict:false,validateFormats:false}).compile(schema('owner-command-contract.schema.json'));
 for(const owner of ['cluster-manager','platform-support']){
  const fixture=JSON.parse(read('packages/contracts/fixtures/owner-commands/'+owner+'.v2.json'));
  assert.equal(validate(fixture),true,JSON.stringify(validate.errors));
  const commands=parseContract(fixture,owner);assert.ok(commands.length>0);
  assert.ok(commands.every(c=>c.id.startsWith(owner+'.')));
  if(owner==='cluster-manager')assert.ok(commands.every(c=>!JSON.stringify(c.argumentSchema).includes('crossplane-core')));
 }
});
