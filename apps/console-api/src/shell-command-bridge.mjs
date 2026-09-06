// C_API is only the credential boundary. OS Shell owns command policy/dispatch.
export function createShellCommandBridge({baseUrl,fetchImpl=fetch}) {
  const base=new URL(baseUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('OS Shell origin is invalid');
  return async function bridge({request,body,resolveSession,identitySessionBroker,correlationId}) {
    const session=await resolveSession(request,{requireCsrf:request.method==='POST',correlationId});
    if(!session?.subjectId||!session?.sessionId||session.revokedAt||session.authorityFresh!==true)throw Object.assign(new Error('Current user authority is unavailable'),{status:401,code:'AuthenticationRequired'});
    const authorization=request.headers.authorization || (await identitySessionBroker.exchangeOwnerAccessCredential(request,{requireCsrf:request.method==='POST',correlationId})).authorization;
    let response;try{response=await fetchImpl(base.origin+'/api/os-shell/commands',{method:request.method,redirect:'error',signal:AbortSignal.timeout(28000),headers:{authorization,accept:'application/json','content-type':'application/json','x-os-correlation-id':correlationId},...(body?{body:JSON.stringify(body)}:{})});}
    catch{throw Object.assign(new Error('OS Shell command result is unavailable; query state before retrying'),{status:503,code:'AuthorityUnavailable',sideEffect:request.method==='POST'?'unknown':'none'});}
    let data;try{data=await response.json();}catch{throw Object.assign(new Error('Invalid OS Shell command response'),{status:502,code:'DependencyFailed',sideEffect:request.method==='POST'?'unknown':'none'});}
    return {status:response.status,body:data};
  };
}
