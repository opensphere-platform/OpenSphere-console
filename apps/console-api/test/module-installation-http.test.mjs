import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createOperationService } from '../src/operation-service.mjs';
import { createRegistryOperations } from '../src/registry-operations.mjs';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import shellClient from '../../osaa-gateway/shell-command-client.js';
import shellCommands from '../../os-shell-control/commands.js';
import {createShellCommandBridge} from '../src/shell-command-bridge.mjs';

const policyCatalog = JSON.parse(readFileSync(new URL('../../../packages/contracts/action-policies.json', import.meta.url)));
const subjectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const descriptorId = 'extension.cluster-manager';
const catalogRevision = 'sha256:' + 'a'.repeat(64);
const image = 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:' + 'b'.repeat(64);
const context = { sessionId, clientRequestId: '44444444-4444-4444-8444-444444444444', userInstruction: 'Cluster Manager 설치해' };

async function fixture(t) {
  const session = { sessionId, subjectId, expiresAt: new Date(Date.now() + 3600000).toISOString(), authorityFresh: true,
    permissions: ['console.extension.install','console.role.admin'], aal: 'aal1', permissionRevision: 7, revokeEpoch: 2 };
  const calls = []; let record = null; let local = true; let accepts = 0;
  const unexpected = async () => { throw new Error('unexpected mutation'); };
  const store = { approve: unexpected, verify: unexpected,
    async get({ actorRef }) { return actorRef === subjectId ? record : null; },
    async getByRequest({ actorRef, idempotencyKey }) { return record?.actor_ref === actorRef && record.idempotency_key === idempotencyKey ? record : null; },
    async accept(input) {
      accepts++;
      const replayed = record !== null;
      record ||= { operation_id: operationId, action_id: input.actionId, action_version: input.actionVersion,
        actor_ref: input.actorRef, target_ref: input.targetRef, required_permission: input.requiredPermission,
        payload_digest: input.payloadDigest, request_digest: 'sha256:' + 'c'.repeat(64), reason: input.reason, risk: input.risk,
        aal: session.aal, permission_revision: 7, approval_required: input.approvalRequired, plan_revision: input.planRevision,
        idempotency_key: input.idempotencyKey, owner_ref: input.ownerRef, state: 'Authorized', state_version: 0,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), correlation_id: input.correlationId };
      return { operationRecord: record, replayed };
    } };
  const operationService = createOperationService({ store, policyCatalog, moduleInstallationPolicy: async () => local });
  const candidate = { descriptorId, catalogRevision, image, channel: 'edge', evidenceRefs: [] };
  const registryOperations = createRegistryOperations({ operationService, policyRevision: policyCatalog.policyRevision,
    registryResolver: { async readCatalogSnapshot() { return { revision: catalogRevision, observedAt: new Date().toISOString(), descriptors: [{ id: descriptorId, class: 'extension', displayName: 'OpenSphere-Cluster-Manager' }] }; },
      async resolveExtension(input) { assert.equal(input.descriptorId, descriptorId); assert.equal(input.catalogRevision, catalogRevision); return candidate; } } });
  const resolveSession=async(request,options)=>{calls.push({method:request.method,path:request.url,requireCsrf:options.requireCsrf,marker:request.headers['x-os-owner-admission']});return session;};
  const shellServer=createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const result=req.method==='GET'?{status:200,body:await service.catalog(req)}:await service.execute(req,JSON.parse(Buffer.concat(chunks)));
      res.writeHead(result.status,{'content-type':'application/json'});res.end(JSON.stringify(result.body));
    }catch(e){res.writeHead(e.status||503,{'content-type':'application/json'});res.end(JSON.stringify({code:e.code,message:e.message}));}
  });
  await new Promise(resolve=>shellServer.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>shellServer.close(resolve)));
  const shellUrl='http://127.0.0.1:'+shellServer.address().port;
  const shellCommandBridge=createShellCommandBridge({baseUrl:shellUrl});
  const server=createServer(createConsoleApiHandler({operationService,registryOperations,resolveSession,shellCommandBridge,
    identityOperations:{getMe:()=>({schemaVersion:'1.0',authority:'SupabaseAuth',freshness:session.authorityFresh?'fresh':'stale',observedAt:new Date().toISOString(),
      data:{state:'Active',subjectId,sessionId,permissions:session.permissions,aal:session.aal}})},
  }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const baseUrl='http://127.0.0.1:'+server.address().port;
  const ledger=new Map();
  const service=shellCommands.createCommandService({identityUrl:baseUrl,readProfile:()=>JSON.stringify({consoleUrl:local?'https://localhost:1114':'https://production.test',channel:'edge'}),
    ledger:{async claim(actor,id,command,digest){if(ledger.has(id)){const old=ledger.get(id);return old.digest===digest?{claimed:false,result:old.result}:{conflict:true};}ledger.set(id,{digest});return {claimed:true};},
      async finish(actor,id,digest,result){ledger.set(id,{digest,result});}},
  });
  const client=shellClient.createShellCommandClient({baseUrl:shellUrl});
  const actor={subject:subjectId,bearerToken:'a'.repeat(48),permissions:session.permissions};
  async function run(command,args={}){
    const def=(await client.describe(actor,{command})).commands[0];
    return client.execute(actor,{command,argumentsJson:JSON.stringify(args),contractRevision:def.contractRevision},context);
  }
  return {session,calls,run,baseUrl,record:()=>record,accepts:()=>accepts,outsideLocal:()=>{local=false;}};
}

test('22 -> real OS Shell HTTP -> C_API: one current-user installation, replay and advancing owner state', async t=>{
  const f=await fixture(t);
  const catalog=await f.run('console.modules.catalog');
  assert.equal(catalog.data.data.revision,catalogRevision);
  const review=await f.run('console.modules.inspect',{descriptorId,catalogRevision});
  assert.equal(review.data.data.candidate.descriptorId,descriptorId);
  const args={descriptorId,catalogRevision,reason:'user requested module installation'};
  const accepted=await f.run('console.modules.install',args);
  assert.equal(accepted.data.state,'Authorized');assert.equal(f.record().approval_required,false);assert.equal(f.record().aal,'aal1');
  assert.equal(f.accepts(),1);assert.match(f.record().idempotency_key,/^os-shell-install-[a-f0-9]{64}$/);
  const replay=await f.run('console.modules.install',args);assert.equal(replay.replayed,true);assert.equal(f.accepts(),1);
  f.record().state='Reconciling';f.record().state_version++;
  assert.equal((await f.run('console.modules.operation',{operationId})).data.state,'Reconciling');
  f.record().state='Verified';f.record().state_version++;
  assert.equal((await f.run('console.modules.operation',{operationId})).data.state,'Verified');
  assert.ok(f.calls.filter(c=>c.path==='/api/admin/extensions/install').every(c=>c.marker==='os-shell-control-v1'));
});
test('shared HTTP path refuses MFA bypass, revoked permissions, changed request and direct installation',async t=>{
  const f=await fixture(t);f.outsideLocal();
  const args={descriptorId,catalogRevision,reason:'explicit module installation'};
  await assert.rejects(f.run('console.modules.install',args),e=>e.code===428);assert.equal(f.accepts(),0);
  f.session.aal='aal2';await f.run('console.modules.install',args);assert.equal(f.accepts(),1);
  f.session.permissions=[];await assert.rejects(f.run('console.modules.install',args));assert.equal(f.accepts(),1);
  f.session.permissions=['console.extension.install','console.role.admin'];
  const response=await fetch(f.baseUrl+'/api/admin/extensions/install',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)});
  assert.equal(response.status,409);assert.equal((await response.json()).code,'ShellCommandRequired');assert.equal(f.accepts(),1);
  f.session.authorityFresh=false;await assert.rejects(f.run('console.modules.catalog'));assert.equal(f.accepts(),1);
});
