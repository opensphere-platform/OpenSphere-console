import {createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import contextVerifier from '../../os-shell-control/authority/os-shell-context.js';
const {verifyOsShellContextJws}=contextVerifier;
const fields=['sessionId','actorId','origin','sessionClass','runtimeAdapterId','networkProfile','runtimeUid','permissionRevision','aal','releaseEvidenceRef','generation','fencingEpoch'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=/^sha256:[a-f0-9]{64}$/;
function denied(message='active delegated Shell authority is required'){throw Object.assign(new Error(message),{code:'ShellDelegationRejected',status:401});}
function equal(a,b){const left=Buffer.from(String(a)),right=Buffer.from(String(b));return left.length===right.length && timingSafeEqual(left,right);}
function validBinding(b){return b && Object.keys(b).length===fields.length && fields.every(k=>Object.hasOwn(b,k))
 && uuid.test(b.sessionId) && uuid.test(b.actorId) && digest.test(b.permissionRevision)
 && b.sessionClass==='operator-interactive' && b.runtimeAdapterId==='cbss.kubernetes-pod' && b.networkProfile==='console-only'
 && ['aal1','aal2','aal3'].includes(b.aal) && ['origin','runtimeUid','releaseEvidenceRef'].every(k=>typeof b[k]==='string' && b[k].length>0 && b[k].length<=1024)
 && Number.isSafeInteger(b.generation) && b.generation>0 && Number.isSafeInteger(b.fencingEpoch) && b.fencingEpoch>0;}
function sameBinding(a,b){return validBinding(a) && validBinding(b) && fields.every(k=>a[k]===b[k]);}
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(part){if(!/^[A-Za-z0-9_-]+$/.test(part))denied();const bytes=Buffer.from(part,'base64url');if(bytes.toString('base64url')!==part)denied();try{return JSON.parse(bytes);}catch{denied();}}

export function createShellDelegationBroker({query,delegationSecret,signingKey,now=()=>Date.now()}){
 if(typeof query!=='function' || typeof delegationSecret!=='string' || delegationSecret.length<32 || !Buffer.isBuffer(signingKey) || signingKey.length!==32)throw new TypeError('Shell delegation requires a database, separate delegation secret and 32-byte signing key');
 const key=Buffer.from(signingKey);
 async function authority(binding){
  if(!validBinding(binding))denied();
  let projection;
  try{const result=await query('SELECT console_shell.resolve_native_shell_authority($1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::text,$6::text) AS authority',
    [binding.sessionId,binding.actorId,binding.generation,binding.fencingEpoch,binding.permissionRevision,binding.aal]);projection=result.rows[0]?.authority;}
  catch(error){if(['28000','40001','42501'].includes(error.code))denied();throw Object.assign(new Error('Shell authority database is unavailable'),{code:'ShellAuthorityUnavailable',status:503});}
  if(!projection || !sameBinding(binding,projection.binding) || !projection.session?.authorityFresh || projection.session.revokedAt
    || !projection.session.permissions?.includes('session:attach') || projection.session.subjectId!==binding.actorId
    || !(Date.parse(projection.credentialExpiresAt)>now()))denied();
  return projection;
 }
 const mac=input=>createHmac('sha256',key).update(input).digest('base64url');
 async function exchange({secret,body}){
  if(!equal(secret,delegationSecret))denied();
  if(!body || Object.keys(body).length!==2 || typeof body.contextJws!=='string' || body.contextJws.length>8192)denied();
  const projection=await authority(body.binding);
  try{verifyOsShellContextJws(body.contextJws,{...projection.binding,runtimePublicKeyPem:projection.runtimePublicKeyPem},{now});}catch{denied('runtime-signed Shell context is invalid');}
  const iat=Math.floor(now()/1000),exp=Math.min(iat+240,Math.floor(Date.parse(projection.credentialExpiresAt)/1000));
  if(exp<=iat)denied();
  const payload={iss:'opensphere-console-shell-authority',aud:'opensphere-shell-console-api',type:'web_shell',iat,nbf:iat,exp,jti:randomUUID(),binding:projection.binding};
  const input=encode({alg:'HS256',typ:'opensphere-shell-delegation+jwt'})+'.'+encode(payload);
  return {accessToken:input+'.'+mac(input),tokenExpiresAt:new Date(exp*1000).toISOString()};
 }
 async function resolveSession(request){
  if(request.headers.cookie || request.headers['x-os-csrf-token'])denied('browser credentials are not accepted on the private Shell API');
  const authorization=String(request.headers.authorization||'');
  if(!authorization.startsWith('Bearer ') || authorization.length>8192)denied();
  const parts=authorization.slice(7).split('.');if(parts.length!==3 || !equal(parts[2],mac(parts[0]+'.'+parts[1])))denied();
  const header=decode(parts[0]),claims=decode(parts[1]),current=Math.floor(now()/1000);
  if(header.alg!=='HS256' || header.typ!=='opensphere-shell-delegation+jwt' || claims.iss!=='opensphere-console-shell-authority'
   || claims.aud!=='opensphere-shell-console-api' || claims.type!=='web_shell' || !uuid.test(claims.jti)
   || !Number.isSafeInteger(claims.iat) || claims.iat>current+5 || claims.nbf!==claims.iat
   || !Number.isSafeInteger(claims.exp) || claims.exp<=current || claims.exp>claims.iat+240)denied();
  const projection=await authority(claims.binding);
  return Object.freeze({...projection.session,credentialKind:'web_shell',shellSessionId:claims.binding.sessionId,
    accessTokenExpiresAt:new Date(Math.min(claims.exp*1000,Date.parse(projection.credentialExpiresAt))).toISOString()});
 }
 async function health(){const result=await query("SELECT has_function_privilege(current_user,'console_shell.resolve_native_shell_authority(uuid,uuid,bigint,bigint,text,text)','EXECUTE') AS ready");return result.rows[0]?.ready===true;}
 return Object.freeze({exchange,resolveSession,health});
}

function send(response,status,body){response.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(body));}
function failure(response,error){send(response,error.status===401?401:503,{schemaVersion:'1.0',code:error.status===401?'AuthenticationRequired':'AuthorityUnavailable',message:error.status===401?'active delegated Shell authority is required':'Shell authority is unavailable',retryable:error.status!==401,sideEffect:'none',correlationId:randomUUID(),operationId:null,details:{}});}
export function createShellCredentialHandler(broker){return async(request,response)=>{
 try{
  if(request.url==='/readyz' && request.method==='GET'){const ready=await broker.health();return send(response,ready?200:503,{service:'opensphere-shell-credential-authority',ready,status:ready?'Ready':'Unavailable'});}
  if(request.url!=='/api/internal/os-shell/credential' || request.method!=='POST')return send(response,404,{code:'NotFound'});
  if(!String(request.headers['content-type']||'').startsWith('application/json'))denied();
  let size=0;const chunks=[];for await(const chunk of request){size+=chunk.length;if(size>16384)denied();chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{denied();}
  return send(response,200,await broker.exchange({secret:request.headers['x-os-shell-delegation-secret'],body}));
 }catch(error){failure(response,error);}
};}

// Explicit current operator routes. No login/enrollment, owner-admission, or arbitrary internal/proxy paths.
const readRoutes=[/^\/api\/identity(?:\/me|\/supabase\/status|\/audit)?$/, /^\/api\/platform\/(?:contracts|gitea\/status|releases\/(?:status|component-targets))$/,
 /^\/api\/platform\/changes(?:\/[0-9a-f-]{36})?$/, /^\/api\/monitoring\/baseline\/v1\/(?:data-health|nodes)$/,
 /^\/api\/catalog\/entities(?:\/[^/]+)?$/, /^\/api\/admin\/(?:plugins\/(?:events|registrations)|bindings|extensions\/(?:revocations|registry-credentials|registry-connections\/opensphere-ghcr))$/,
 /^\/api\/platform\/operations\/[0-9a-f-]{36}$/, /^\/api\/audit(?:\/events)?$/, /^\/api\/admin\/extensions\/catalog$/];
const writeRoutes=[['POST',/^\/api\/platform\/changes(?:\/[0-9a-f-]{36}\/(?:approve|reject))?$/],
 ['POST',/^\/api\/admin\/extensions\/(?:inspect|install|remove|revocations)$/],
 ['POST',/^\/api\/identity\/users(?:\/[0-9a-f-]{36}\/(?:group|enabled|onboarding))?$/]];
export function createShellConsoleHandler({broker,createHandler,handlerOptions}){
 const handler=createHandler({...handlerOptions,resolveSession:broker.resolveSession});
 return async(request,response)=>{try{
  if(request.method==='GET' && request.url==='/readyz'){const ready=await broker.health() && await handlerOptions.health();return send(response,ready?200:503,{service:'supabase-data-identity',ready,status:ready?'Ready':'Unavailable'});}
  const raw=String(request.url||'');if(!raw.startsWith('/api/') || raw.split('?')[0].includes('%') || raw.includes('\\') || raw.split(/[/?]/).some(p=>p==='.'||p==='..'))return send(response,404,{code:'NotFound'});
  const url=new URL(raw,'https://shell.invalid');
  const introspect=url.pathname==='/api/identity/cli/introspect' && request.method==='GET' && !url.search;
  if(!introspect && !(request.method==='GET' && readRoutes.some(r=>r.test(url.pathname))) && !writeRoutes.some(([method,r])=>request.method===method && r.test(url.pathname)))return send(response,404,{code:'NotFound'});
  const session=await broker.resolveSession(request);
  if(introspect)return send(response,200,{active:true,userId:session.subjectId,subject:session.subjectId,deviceId:null,
   groups:session.permissions.flatMap(p=>({'console.role.admin':['console-admins'],'console.role.operator':['console-operators'],'console.role.viewer':['console-viewers']})[p]||[]),permissions:session.permissions,type:'web_shell',expiresAt:session.accessTokenExpiresAt});
  // The regular handler revalidates authority immediately before its operation authorization.
  return await handler(request,response);
 }catch(error){failure(response,error);}};
}
