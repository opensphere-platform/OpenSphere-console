import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import yaml from 'js-yaml';
import Ajv from 'ajv/dist/2020.js';
const require=createRequire(import.meta.url);
const {definitions}=require('../apps/os-shell-control/commands.js');
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const schema=p=>JSON.parse(read('packages/contracts/schemas/'+p));

test('published command contract covers the fixed runtime catalog and refuses foreign command inputs',()=>{
 const validate=new Ajv({strict:false,validateFormats:false}).compile(schema('shell-command-request.schema.json'));
 const request={command:'hiss.install',arguments:{id:'cert-manager',reason:'operator installation request'},requestId:'11111111-1111-4111-8111-111111111111'};
 assert.equal(validate(request),true,JSON.stringify(validate.errors));
 for(const bad of [{...request,command:'exec'},{...request,arguments:{...request.arguments,command:'kubectl'}},{...request,actor:'someone'},{...request,arguments:{...request.arguments,chartVersion:'untrusted'}}])assert.equal(validate(bad),false);
 const api=yaml.load(read('packages/contracts/openapi/console-v1.yaml'));
 assert.equal(api.paths['/api/os-shell/commands'].post.operationId,'executeShellCommand');
 assert.deepEqual(schema('shell-command-request.schema.json').properties.command.enum,Object.keys(definitions));
});

test('signed Cluster Manager GUI uses same-origin Shell transport; unrelated plugin URLs remain confined',async()=>{
 const ts=require('typescript');
 const source=read('apps/console-web/src/app/core/extension-host.service.ts');
 const method=source.slice(source.indexOf('  private async fetchForPlugin('),source.indexOf('  private normalizeManualContribution('));
 const compiled=ts.transpileModule('class Host { http:any; '+method+' }; globalThis.Host=Host;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const ctx={URL,Request,Headers,location:{origin:'https://localhost:1114'}};vm.runInNewContext(compiled,ctx);
 const host=new ctx.Host();const calls=[];host.http={request:async(...args)=>{calls.push(args);return 'response';}};
 const manifest={id:'cluster-manager',apiBase:'/api/plugins/cluster-manager/versions/current',contributions:{api:{basePath:'/api/plugins/cluster-manager'}}};
 const init={method:'POST',body:JSON.stringify({command:'hiss.status',arguments:{},requestId:'request'})};
 assert.equal(await host.fetchForPlugin(manifest,'/api/os-shell/commands',init),'response');
 assert.equal(calls[0][0],'/api/os-shell/commands');
 await assert.rejects(()=>host.fetchForPlugin(manifest,'/api/os-shell/commands',{...init,method:'DELETE'}));
 await assert.rejects(()=>host.fetchForPlugin(manifest,'/api/os-shell/commands',{...init,body:'{"command":"arbitrary.exec"}'}));
 await host.fetchForPlugin({...manifest,id:'other'},'/api/os-shell/commands',init);
 assert.ok(String(calls.at(-1)[0]).startsWith('https://localhost:1114/api/plugins/cluster-manager/'));
 assert.equal(calls.filter(c=>String(c[0])==='/api/os-shell/commands').length,1);
});
