'use strict';

const {createHash}=require('node:crypto');
const {readFileSync}=require('node:fs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION=/^sha256:[a-f0-9]{64}$/;
const MANAGED=['ingress-nginx','cert-manager','metrics-server','crossplane-core','kube-prometheus-stack'];
const definitions=Object.freeze({
  'hiss.status':{method:'GET',path:'status',fields:[],read:true},
  'hiss.inspect':{method:'POST',path:'inspect',fields:['id','chartVersion'],read:true,managed:true},
  'hiss.plan':{method:'POST',path:'plan',fields:['id','config','chartVersion'],read:true,managed:true},
  'hiss.install':{method:'POST',path:'install',fields:['id','reason','config','chartVersion'],managed:true,lifecycle:true},
  'hiss.uninstall':{method:'POST',path:'uninstall',fields:['id','reason','confirm','chartVersion'],managed:true,lifecycle:true},
  'hiss.upgrade':{method:'POST',path:'upgrade',fields:['id','reason','chartVersion'],managed:true,lifecycle:true},
  'hiss.recover':{method:'POST',path:'recover',fields:['id','reason','chartVersion'],managed:true,lifecycle:true},
  'hiss.rollback':{method:'POST',path:'rollback',fields:['id','reason','revision','confirm'],managed:true,lifecycle:true},
  'hiss.validate':{method:'POST',path:'validate',fields:['id','reason']},
  'hiss.profiles.set':{method:'POST',path:'profiles',fields:['profile','selected','reason']},
  'hiss.observability.config':{method:'GET',path:'observability/config',fields:[],read:true},
  'hiss.observability.plan':{method:'POST',path:'observability/plan',fields:['id','config'],read:true},
  'hiss.observability.configure':{method:'POST',path:'observability/configure',fields:['id','config','reason','resetData','resetConfirmation','publicConfirmation']},
});
function fail(status,code,message,sideEffect='none'){throw Object.assign(new Error(message),{status,code,sideEffect});}
function exact(value,fields){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k)))fail(400,'ValidationFailed','허용된 명령 필드만 사용할 수 있습니다.');}
function origin(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Command owner must be a configured HTTP(S) origin');return u.origin;}
function localEdge(read=readFileSync){try{const p=JSON.parse(read('/var/run/opensphere/installation/config.json','utf8'));const u=new URL(p.consoleUrl);return p.channel==='edge'&&u.protocol==='https:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/';}catch{return false;}}
function validate(body){
  exact(body,['command','arguments','requestId','reviewRevision']);
  const def=Object.hasOwn(definitions,body.command)?definitions[body.command]:null;if(!def)fail(404,'CommandNotFound','등록되지 않은 OS Shell 명령입니다.');
  if(!UUID.test(body.requestId||''))fail(400,'ValidationFailed','명령 requestId는 UUID여야 합니다.');
  exact(body.arguments,def.fields);
  if(def.managed&&!MANAGED.includes(body.arguments.id))fail(400,'ValidationFailed','서명된 HISS 관리 모듈 ID가 필요합니다.');
  if(!def.read&&(typeof body.arguments.reason!=='string'||body.arguments.reason.trim().length<8||body.arguments.reason.length>500))fail(400,'ValidationFailed','변경 사유를 8~500자로 입력하세요.');
  if(body.command==='hiss.uninstall'&&body.arguments.confirm!==body.arguments.id)fail(400,'ConfirmationRequired','삭제할 모듈 ID를 명시적으로 확인하세요.');
  if(body.reviewRevision!==undefined&&!REVISION.test(body.reviewRevision))fail(400,'ValidationFailed','검토 revision 형식이 올바르지 않습니다.');
  return def;
}
function createCommandService({identityUrl,clusterManagerUrl,ledger,fetchImpl=fetch,readProfile=readFileSync,now=()=>Date.now()}){
  const identity=origin(identityUrl),owner=origin(clusterManagerUrl);
  async function request(url,token,method,body,mutation=false,requestId){
    let response;try{response=await fetchImpl(url,{method,redirect:'error',signal:AbortSignal.timeout(25000),headers:{authorization:`Bearer ${token}`,accept:'application/json','content-type':'application/json','x-os-owner-admission':'os-shell-control-v1',...(requestId?{'x-os-command-request-id':requestId}:{})},...(body?{body:JSON.stringify(body)}:{})});}
    catch{fail(503,'OwnerUnavailable','OS Shell이 명령 실행 결과를 확인하지 못했습니다. 상태를 조회한 후 재시도하세요.',mutation?'unknown':'none');}
    let data;try{data=await response.json();}catch{fail(502,'OwnerContractInvalid','명령 소유자의 응답이 올바른 JSON이 아닙니다.',mutation?'unknown':'none');}
    if(!response.ok)fail(response.status,response.status===409?'StateConflict':'OwnerRejected',String(data.message||data.error||'명령 소유자가 요청을 거부했습니다.').slice(0,1000),mutation&&response.status>=500?'unknown':'none');
    return {status:response.status,data};
  }
  async function actor(req){
    if(req.headers.cookie||req.headers['x-os-csrf-token'])fail(403,'CredentialBoundaryRejected','브라우저 자격 증명은 Console 인증 경계를 통해야 합니다.');
    const token=String(req.headers.authorization||'').match(/^Bearer ([A-Za-z0-9_.-]{32,16384})$/)?.[1];
    if(!token)fail(401,'AuthenticationRequired','현재 사용자 자격 증명이 필요합니다.');
    const {data:b}=await request(identity+'/api/identity/me',token,'GET');const a=b.data,at=Date.parse(b.observedAt);
    if(b.schemaVersion!=='1.0'||b.authority!=='SupabaseAuth'||b.freshness!=='fresh'||!Number.isFinite(at)||now()-at>60000||at>now()+30000||a?.state!=='Active'||!UUID.test(a.subjectId||'')||!UUID.test(a.sessionId||'')||!Array.isArray(a.permissions)||!['aal1','aal2'].includes(a.aal))fail(503,'AuthorityUnavailable','현재 사용자 권한을 검증할 수 없습니다.');
    return {token,projection:a};
  }
  function authorize(a,write){if(!(write?['console.role.admin']:['console.role.admin','console.role.operator','console.role.viewer']).some(p=>a.permissions.includes(p)))fail(403,'PermissionDenied','현재 사용자에게 해당 관리 권한이 없습니다.');if(write&&a.aal!=='aal2'&&!localEdge(readProfile))fail(428,'MfaRequired','MFA 재인증이 필요합니다.');}
  return {
    async catalog(req){const a=await actor(req);authorize(a.projection,false);return {schema:'opensphere.shell-command-catalog/v1',controlPlane:'OS-Shell',commands:Object.entries(definitions).map(([id,d])=>({id,owner:'cluster-manager',mutation:!d.read,arguments:d.fields,allowed:d.read||a.projection.permissions.includes('console.role.admin')}))};},
    async execute(req,body){
      const def=validate(body),{token,projection:a}=await actor(req);authorize(a,!def.read);
      let args={...body.arguments};
      let digest;
      if(!def.read){
        if(!ledger)fail(503,'CommandLedgerUnavailable','OS Shell 실행 기록 저장소를 사용할 수 없습니다.');
        const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
        digest='sha256:'+createHash('sha256').update(JSON.stringify(canonical({command:body.command,arguments:body.arguments}))).digest('hex');
      }
      if(def.lifecycle){
        const {data:review}=await request(owner+'/api/hiss/inspect',token,'POST',{id:args.id,...(args.chartVersion?{chartVersion:args.chartVersion}:{})});
        if(review.schema!=='opensphere.hiss-lifecycle/v1'||review.id!==args.id||!REVISION.test(review.revision||'')||!Number.isFinite(Date.parse(review.observedAt))||now()-Date.parse(review.observedAt)>60000)fail(502,'OwnerContractInvalid','HISS 검토 결과를 검증할 수 없습니다.');
        if(body.reviewRevision&&body.reviewRevision!==review.revision)fail(409,'StateConflict','검토 이후 상태가 변경됐습니다. 다시 조회하세요.');
        if(args.chartVersion&&(typeof args.chartVersion!=='string'||typeof review.chartVersion!=='string'||args.chartVersion.replace(/^v/,'')!==review.chartVersion.replace(/^v/,'')))fail(409,'VersionConflict','현재 서명된 HISS 차트 버전과 다릅니다.');
        if(args.chartVersion)args.chartVersion=review.chartVersion;
        args={...args,planRevision:review.revision,requestKey:'os-shell-hiss-'+createHash('sha256').update(JSON.stringify([a.subjectId,body.requestId,body.command])).digest('hex'),controlRequestId:body.requestId};
      }
      if(!def.read){
        let claim;try{claim=await ledger.claim(a,body.requestId,body.command,digest);}catch{fail(503,'CommandLedgerUnavailable','실행 기록을 확보하지 못해 변경을 중단했습니다.');}
        if(claim.conflict)fail(409,'IdempotencyConflict','같은 requestId로 다른 명령 또는 입력을 실행할 수 없습니다.');
        if(!claim.claimed){
          if(!claim.result)fail(409,'CommandOutcomePending','이미 접수된 요청의 결과가 아직 확인되지 않았습니다. 상태를 조회하세요. 자동 재실행하지 않습니다.','unknown');
          return {...claim.result,body:{...claim.result.body,replayed:true}};
        }
      }
      let outcome;
      try {
        const result=await request(owner+'/api/hiss/'+def.path,token,def.method,def.method==='GET'?undefined:args,!def.read,body.requestId);
        outcome={status:result.status,body:{schema:'opensphere.shell-command/v1',controlPlane:'OS-Shell',command:body.command,requestId:body.requestId,owner:'cluster-manager',operationId:result.data.operation?.id||null,observedAt:new Date(now()).toISOString(),data:result.data}};
      } catch(error) {
        if(def.read)throw error;
        outcome={status:error.status||503,body:{controlPlane:'OS-Shell',requestId:body.requestId,code:error.code||'OwnerUnavailable',message:error.message,sideEffect:error.sideEffect||'unknown'}};
      }
      if(!def.read){try{await ledger.finish(a,body.requestId,digest,outcome);}catch{fail(503,'CommandRecordUnavailable','실행 결과 저장을 확인하지 못했습니다. 같은 요청을 자동 재실행하지 말고 상태를 조회하세요.','unknown');}}
      return outcome;
    },
  };
}
module.exports={createCommandService,definitions,validate,localEdge};
