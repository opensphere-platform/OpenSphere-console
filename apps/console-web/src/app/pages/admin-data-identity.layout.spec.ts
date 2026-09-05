import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {parseIdentityStatus,identityRuntimeReady,isIdentityFresh,identityFailure} from './data-identity-state.ts';
import {createDataIdentityOperations} from '../../../../console-api/src/data-identity-operations.mjs';
import {projectRecoveryEvidence} from '../../../../console-api/src/data-identity-evidence.mjs';
const root=new URL('../../../../../',import.meta.url);
const fixture=JSON.parse(readFileSync(new URL('apps/console-api/test/fixtures/data-identity-sql.json',root),'utf8'));
const manifest=JSON.parse(readFileSync(new URL('migrations/manifest.json',root),'utf8'));
const schema=JSON.parse(readFileSync(new URL('packages/contracts/schemas/supabase-status-response.schema.json',root),'utf8'));
const validator=new Ajv2020({strict:false,allErrors:true});addFormats(validator);const validate=validator.compile(schema);
const now=new Date();
async function response(modify=(x:any)=>x){const data=structuredClone(fixture);modify(data);
 return createDataIdentityOperations({store:{getSupabaseStatus:async()=>data},expectedMigration:manifest,now:()=>now,
 liveProbes:{observe:async()=>['auth','dataApi','storage'].map(component=>({component,state:'Ready',authority:'TestHealth',reasonCode:null,observedAt:now.toISOString()}))},
 recoveryEvidence:{observe:async()=>projectRecoveryEvidence(null,{now})}}).getSupabaseStatus({session:{sessionId:'test',subjectId:'test',permissionRevision:7,revokeEpoch:2},correlationId:'di-contract-test'});
}
test('real SQL DTO through API aggregation validates schema and seven view inventories',async()=>{
 const raw=await response();assert.equal(validate(raw),true,JSON.stringify(validate.errors));const value=parseIdentityStatus(raw);
 assert.equal(value.data.inventory.operators,3);assert.equal(value.data.inventory.activeSessions,5);assert.ok(value.data.inventory.roles.length>0);
 assert.equal(value.data.components.find(c=>c.component==='rls')?.checks?.length,17);assert.equal(identityRuntimeReady(value),true);
 assert.equal(value.data.recovery.state,'Unknown');assert.equal(value.data.state,'Degraded');assert.equal(isIdentityFresh(value,now.getTime()),true);
});
test('migration target mismatch blocks operational readiness even when services answer',async()=>{
 const v=parseIdentityStatus(await response(x=>x.data.components.find((c:any)=>c.component==='migration').migrationCount--));
 assert.equal(identityRuntimeReady(v),false);assert.equal(v.data.components.find(c=>c.component==='migration')?.reasonCode,'MigrationTargetMismatch');
});
test('stale, future and failed RLS observations cannot be reported Ready',async()=>{
 const v=parseIdentityStatus(await response(x=>x.data.components.find((c:any)=>c.component==='rls').state='Blocked'));
 assert.equal(identityRuntimeReady(v),false);assert.equal(isIdentityFresh(v,now.getTime()+46000),false);assert.equal(isIdentityFresh(v,now.getTime()-6000),false);
});
for(const [name,change] of [
 ['empty components',(v:any)=>v.data.components=[]],['duplicate component',(v:any)=>v.data.components[7]=v.data.components[0]],
 ['missing inventory',(v:any)=>delete v.data.inventory],['missing recovery',(v:any)=>delete v.data.recovery],
 ['malformed date',(v:any)=>v.observedAt='invalid'],['invalid role',(v:any)=>v.data.inventory.roles=[{name:3}]],
] as const)test('UI rejects '+name+' before rendering',async()=>{const v=await response();change(v);assert.throws(()=>parseIdentityStatus(v),/DataIdentityContractInvalid/);assert.equal(validate(v),false);});
test('old API shape, first-load 401/403 and invalid responses have explicit failure states',()=>{
 assert.throws(()=>parseIdentityStatus({meta:{checkedAt:now.toISOString()},components:[]}));
 assert.match(identityFailure(401),/다시 로그인/);assert.match(identityFailure(403),/console.data_identity.read/);assert.match(identityFailure('contract'),/응답 형식/);
 const html=readFileSync(new URL('./admin-data-identity.html',import.meta.url),'utf8');assert.ok(html.indexOf('@if (error())')<html.indexOf('@if (status();'));
 assert.match(html,/role="tablist"/);assert.match(html,/role="tabpanel"/);assert.match(html,/aria-selected/);assert.match(html,/\(keydown\)="tabKey/);
});
