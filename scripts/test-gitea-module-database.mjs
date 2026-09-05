import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {migrationTransactionSql} from './console-migrations.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const docker=process.env.OPHERE_TEST_DOCKER || 'docker';
const container='opensphere-gitea-flow-test-'+process.pid+'-'+Date.now();
let created=false;
process.on('exit',()=>{
 if(!created)return;
 const metadata=JSON.parse(execFileSync(docker,['inspect',container],{encoding:'utf8'}))[0];
 assert.equal(metadata.HostConfig.NetworkMode,'none');
 assert.equal(metadata.Config.Labels['opensphere.task'],'gitea-flow-20260905');
 execFileSync(docker,['rm','-f','-v',container],{stdio:'pipe'});
});
execFileSync(docker,['run','-d','--name',container,'--label','opensphere.task=gitea-flow-20260905','--network','none','--tmpfs','/var/lib/postgresql/data:rw','--tmpfs','/work:rw,mode=1777','-e','POSTGRES_HOST_AUTH_METHOD=trust','pgvector/pgvector:0.8.2-pg17','-c','unix_socket_directories=/var/run/postgresql,/work'],{stdio:'pipe'});
created=true;
for(let attempt=0;attempt<40;attempt++){
 try{execFileSync(docker,['exec',container,'pg_isready','-h','/work','-U','postgres'],{stdio:'pipe'});break;}
 catch{if(attempt===39)throw new Error('isolated database did not start');await new Promise(r=>setTimeout(r,250));}
}
const database='flow_test_'+Date.now();
function sql(text,db=database){try{return execFileSync(docker,['exec','-i',container,'psql','-X','-h','/work','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-Atq'],{input:text,encoding:'utf8',maxBuffer:8e6,stdio:['pipe','pipe','pipe']}).trim();}catch(e){throw new Error(e.stderr||e.message);}}
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
if(process.argv[2]!=='reuse') {
 sql('CREATE DATABASE '+database+';','postgres');
 sql("DO $$DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['authenticated','authenticator','supabase_auth_admin','supabase_storage_admin','supabase_admin','anon','service_role'] LOOP IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=n) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',n);END IF;END LOOP;END$$;"+readFileSync(root+'migrations/baseline/verify/supabase-test-prerequisites.sql','utf8').replace('CREATE ROLE authenticated NOLOGIN;','')+'CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;');
 const manifest=JSON.parse(readFileSync(root+'migrations/manifest.json','utf8'));
 for(const entry of manifest.migrations)sql('BEGIN;'+migrationTransactionSql(root,entry)+'COMMIT;');
 if(manifest.migrationCount===38)sql(readFileSync(root+'migrations/versions/0039_gitea_module_dispatch.sql','utf8'));
 sql(readFileSync(root+'migrations/baseline/verify/0001_console_authority.verify.sql','utf8').split('SET ROLE console_api;')[0]);
 sql("INSERT INTO console_identity.permission_grant(subject_id,permission,grant_revision,granted_by) VALUES('11111111-1111-4111-8111-111111111111','console.git.change',7,'11111111-1111-4111-8111-111111111111');");
}
const actor='11111111-1111-4111-8111-111111111111',session='22222222-2222-4222-8222-222222222222';
const image='ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:'+'a'.repeat(64);
const desired={contract:'opensphere.console.git-reviewed-module/v1',descriptorId:'extension.cluster-manager',catalogRevision:'sha256:'+'b'.repeat(64),image};
const binding={schemaVersion:'1.0',authority:'Gitea',repository:'opensphere/platform-declarations',defaultBranch:'main',consumerId:'console-modules',action:'apply',target:'extension.cluster-manager',templateId:'console-cluster-manager-install',desiredState:desired};
const input={sessionId:session,actorRef:actor,expectedPermissionRevision:7,expectedRevokeEpoch:2,requiredPermission:'console.extension.install',actionId:'console.extension.install',actionVersion:'1.0',targetRef:image,payloadDigest:'sha256:'+'c'.repeat(64),risk:'R2',reason:'Test the Git-reviewed installation',planRevision:'flow-test-policy',approvalRequired:true,idempotencyKey:'flow-native-accept',correlationId:'flow-native-correlation',sourceRevision:null,ownerRef:'C_EXT',expectedPostcondition:{declaration:binding},executionPlan:{schemaVersion:'1.0',authority:'OpenSphereRegistry',descriptorId:desired.descriptorId,catalogRevision:desired.catalogRevision,image},declarationBinding:binding,localDevelopmentModuleInstall:false};
const api=text=>'SET ROLE console_api;'+text;
const accept=x=>`SELECT jsonb_build_object('record',operation_record,'replayed',replayed) FROM console_operation.accept_gitea_module(${q(JSON.stringify(x))}::jsonb);`;
function rejects(name,text,pattern){assert.throws(()=>sql('BEGIN;'+text+'ROLLBACK;'),pattern,name);console.log('PASS '+name);}
for(const [name,edit] of [['another module',x=>x.declarationBinding.target='extension.other'],['mutable image',x=>x.declarationBinding.desiredState.image='image:latest'],['unknown desired field',x=>x.declarationBinding.desiredState.shell='sh'],['no approval',x=>x.approvalRequired=false]]) {const x=structuredClone(input);edit(x);rejects(name,api(accept(x)),/PolicyRejected/);}
rejects('missing Git permission',"UPDATE console_identity.permission_grant SET revoked_at=now() WHERE permission='console.git.change';"+api(accept(input)),/PermissionDenied/);
rejects('stale session',api(accept({...input,expectedRevokeEpoch:3})),/StaleAuthorityRevision/);
const accepted=JSON.parse(sql(api(accept(input))));const id=accepted.record.operation_id;
assert.equal(accepted.record.state,'Planned');assert.equal(accepted.record.owner_ref,'C_EXT');assert.deepEqual(accepted.record.declaration_binding,binding);
assert.equal(JSON.parse(sql(api(accept(input)))).record.operation_id,id);
const claim="SET ROLE console_extension_controller;SELECT console_operation.claim_owner_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','C_EXT',ARRAY['console.extension.install','console.extension.remove','console.extension.revocation.create'],30);";
assert.equal(sql(claim),'');console.log('PASS unapproved operation cannot be claimed');
const approved=`SELECT operation_record FROM console_operation.approve_operation('66666666-6666-4666-8666-666666666666','55555555-5555-4555-8555-555555555555',3,0,${q(id)},0,'Independent review of exact module','flow-test-policy',NULL,'flow-independent-approval','flow-native-correlation');`;
rejects('self approval',api(approved.replaceAll('66666666-6666-4666-8666-666666666666',session).replaceAll('55555555-5555-4555-8555-555555555555',actor).replace(',3,0,',',7,2,')),/SelfApprovalDenied/);
sql(api(approved));assert.equal(sql(claim),'');console.log('PASS independently approved operation cannot run before protected merge');
const merge=`SELECT operation_record FROM console_operation.record_gitea_merge(${q(id)},${q('d'.repeat(40))},${q('control/'+id)},7,'flow-native-correlation');`;
rejects('merge without recorded proposal',api(merge),/ClaimBindingMismatch/);
sql(api(`SELECT * FROM console_operation.record_gitea_proposal(${q(id)},${q('e'.repeat(40))},${q('control/'+id)},7,'flow-native-correlation');`));
const merged=JSON.parse(sql(api(merge)));assert.equal(merged.declaration_merge_revision,'d'.repeat(40));assert.equal(merged.source_revision,null);
assert.equal(JSON.parse(sql(api(merge))).state,'Submitted');
const picked=JSON.parse(sql(claim));assert.equal(picked.operationId,id);assert.deepEqual(picked.executionPlan,input.executionPlan);
assert.equal(sql(claim),'');console.log('PASS only committed exact operation is claimed once with lease fencing');
rejects('conflicting merge revision',api(merge.replace('d'.repeat(40),'f'.repeat(40))),/InvalidOperationState/);
rejects('stale worker lease',"SET ROLE console_extension_controller;SELECT console_operation.renew_owner_claim('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',"+picked.outboxId+','+picked.claimEpoch+',30);',/StaleClaim/);
const inventory=JSON.parse(sql(api(`SELECT console_operation.list_gitea_changes(${q(session)},${q(actor)},7,2);`)));
assert.equal(inventory.items[0].operationId,id);assert.equal(inventory.items[0].nativeOwner,'C_EXT');assert.equal(inventory.items[0].sourceRevision,'d'.repeat(40));
const local={...input,sessionId:'44444444-4444-4444-8444-444444444444',idempotencyKey:'flow-native-local',localDevelopmentModuleInstall:true};
sql("INSERT INTO console_operation.module_installation_environment VALUES(true,'edge','development','docker-desktop','https://localhost:1114',now());");
rejects('retired local Git approval intake cannot create new work',api(accept(local)),/PolicyRejected/);
console.log(JSON.stringify({status:'passed',isolated:true,network:'none',historicalGitLineagePreserved:true,localGitIntakeRetired:true}));
