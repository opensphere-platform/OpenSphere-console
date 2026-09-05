import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectRecoveryEvidence,createRecoveryEvidenceReader} from '../src/data-identity-evidence.mjs';
import {createDataIdentityOperations} from '../src/data-identity-operations.mjs';
const now=new Date('2026-09-05T06:00:00Z');
const migration={baselineRevision:'opensphere-console/20260905/0038',setDigest:'sha256:'+'a'.repeat(64),migrationCount:38};
function evidence(){
 const b=()=>({verified:true,verifiedAt:'2026-09-05T05:00:00Z',sha256:'b'.repeat(64),manifestKey:'private/do-not-forward/manifest.json'});
 const r=assertions=>({state:'Verified',verifiedAt:'2026-09-05T05:30:00Z',operationId:'11111111-1111-4111-8111-111111111111',checks:assertions.map(assertion=>({assertion,verdict:'Verified',observed:assertion==='console RLS tables restored'?'16':assertion==='console audit events restored'?'0':'1'}))});
 return {schemaVersion:'v3',generatedAt:'2026-09-05T05:30:00Z',policy:{maxEvidenceAgeSeconds:86400,targetMode:'isolated-non-destructive-drill'},
 backup:{supabase:{database:b(),storage:b()},gitea:b()},restore:{
 supabase:{...r(['auth.users restored','console authority subjects restored','console audit events restored','migration ledger restored','console RLS tables restored']),migration:{globalId:migration.baselineRevision,setDigest:migration.setDigest,count:migration.migrationCount}},
 storage:r(['restored object files']),gitea:r(['gitea users restored','gitea repositories restored','gitea repository git heads restored','gitea private configuration restored'])}};
}
test('current three-domain proof is projected without private archive metadata',()=>{
 const out=projectRecoveryEvidence(evidence(),{now,migration});assert.equal(out.state,'Ready');assert.equal(out.domains.length,3);assert.doesNotMatch(JSON.stringify(out),/do-not-forward|manifestKey|bbbbbbbb/);
});
for(const [name,change] of [
 ['empty assertions',e=>e.restore.supabase.checks=[]],['duplicate assertion',e=>e.restore.supabase.checks.push(e.restore.supabase.checks[0])],
 ['failed assertion',e=>e.restore.supabase.checks[0].verdict='Failed'],['missing table',e=>e.restore.supabase.checks[4].observed='15'],
 ['unknown migration',e=>delete e.restore.supabase.migration],['different migration',e=>e.restore.supabase.migration.count=37],
 ['new backup without new restore',e=>e.backup.supabase.database.verifiedAt='2026-09-05T05:45:00Z'],['stale assertion',e=>e.restore.supabase.verifiedAt='2026-09-01T05:30:00Z'],
 ['future evidence',e=>e.generatedAt='2099-09-05T05:30:00Z'],['stale evidence',e=>e.generatedAt='2026-09-01T05:30:00Z'],
 ['missing policy',e=>delete e.policy],['unbounded strings',e=>e.restore.supabase.checks[0].observed='secret-value'],
]) test('recovery fails closed: '+name,()=>{const e=evidence();change(e);const out=projectRecoveryEvidence(e,{now,migration});assert.notEqual(out.state,'Ready');assert.notEqual(out.domains.find(d=>d.domain==='supabaseDatabase')?.restoreState,'Ready');assert.doesNotMatch(JSON.stringify(out),/secret-value/);});
test('file projection distinguishes missing, invalid and updates; rejects oversized evidence',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'di-proof-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'proof.json');
 const reader=createRecoveryEvidenceReader({path,now:()=>now});assert.equal((await reader.observe(migration)).reasonCode,'RecoveryEvidenceUnavailable');
 await writeFile(path,'{');assert.equal((await reader.observe(migration)).reasonCode,'RecoveryEvidenceInvalid');
 await writeFile(path,JSON.stringify(evidence()));assert.equal((await reader.observe(migration)).state,'Ready');
 await writeFile(path,' '.repeat(128*1024+1));assert.equal((await reader.observe(migration)).reasonCode,'RecoveryEvidenceInvalid');
});
test('recovery files are not read when current DB authorization rejects the session',async()=>{
 let reads=0;const op=createDataIdentityOperations({store:{getSupabaseStatus:async()=>{throw Object.assign(new Error('denied'),{code:'PermissionDenied'});}},recoveryEvidence:{observe:async()=>{reads++;}}});
 await assert.rejects(op.getSupabaseStatus({session:{sessionId:'session',subjectId:'subject',permissionRevision:1,revokeEpoch:0},correlationId:'di-test-auth'}),{code:'PermissionDenied'});assert.equal(reads,0);
});
