'use strict';
// OSDST receives only the C_AI-exchanged credential; C_API remains identity authority.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLE_MARKERS = Object.freeze({'console.role.admin':'console-admins','console.role.operator':'console-operators','console.role.viewer':'console-viewers'});
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
function createNativeIdentityVerifier({baseUrl, fetchImpl=globalThis.fetch, now=Date.now}) {
  const origin = new URL(baseUrl);
  if (!['http:','https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) throw new TypeError('Console identity authority must be an HTTP(S) origin');
  return async function verifyActor(req) {
    if (req.headers.cookie || req.headers['x-os-csrf-token'] || req.headers['x-os-owner-admission']!=='osaa-gateway-v1') fail(403,'OSDST requires the admitted C_AI caller');
    const match = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u);
    if (!match || match[1].length>16384) fail(401,'OSDST requires an exchanged Owner credential');
    let claims;
    try { claims=JSON.parse(Buffer.from(match[1].split('.')[1],'base64url').toString('utf8')); } catch { fail(401,'Invalid Owner credential coordinates'); }
    if (!UUID.test(claims?.sub || '') || typeof claims?.session_id!=='string' || !claims.session_id || claims.session_id.length>256 || !['aal1','aal2'].includes(claims?.aal)) fail(401,'Invalid Owner credential coordinates');
    let response;
    try { response=await fetchImpl(new URL('/api/identity/me',origin), {
      method:'GET',headers:{accept:'application/json',authorization:'Bearer '+match[1],'x-os-owner-admission':'osaa-gateway-v1'},
      redirect:'error',signal:AbortSignal.timeout(8000),
    }); } catch { fail(503,'Console identity authority unavailable'); }
    const body=await response.json().catch(()=>null);
    if (!response.ok) fail([401,403].includes(response.status)?response.status:503,'Console identity authority rejected the current credential');
    const value=body?.data, observed=Date.parse(body?.observedAt || '');
    const revision=x=>typeof x==='string' && /^(0|[1-9][0-9]*)$/u.test(x) && Number.isSafeInteger(Number(x));
    const permissions=value?.permissions;
    if (body?.schemaVersion!=='1.0' || body?.authority!=='SupabaseAuth' || body?.freshness!=='fresh' || !Number.isFinite(observed) || Math.abs(now()-observed)>60000
      || value?.state!=='Active' || !UUID.test(value?.sessionId || '') || value.subjectId!==claims.sub || value.aal!==claims.aal
      || !revision(value.permissionRevision) || !revision(value.revokeEpoch) || !Array.isArray(permissions) || permissions.length>256
      || !permissions.every(p=>typeof p==='string' && /^[a-z][a-z0-9._:-]{0,127}$/u.test(p))) fail(503,'Invalid current Console identity projection');
    return Object.freeze({subject:value.subjectId,username:value.subjectId,browserSessionId:value.sessionId,
      groups:Object.freeze([...new Set(permissions.map(p=>ROLE_MARKERS[p]).filter(Boolean))].sort()),
      permissions:Object.freeze([...new Set(permissions)].sort()),assurance:value.aal,
      authzRevision:value.permissionRevision,revokeEpoch:value.revokeEpoch});
  };
}
module.exports={createNativeIdentityVerifier};