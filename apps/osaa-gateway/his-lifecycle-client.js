'use strict';
const {createHash} = require('node:crypto');
const IDS = ['ingress-nginx','cert-manager','metrics-server','crossplane-core','kube-prometheus-stack'];
const HISS_TOOL_NAMES = new Set(['inspect_hiss_module','execute_hiss_lifecycle']);
const REVISION = /^sha256:[a-f0-9]{64}$/;
const fail = (code, msg) => {throw Object.assign(new Error(msg), {code, msg});};

function hissIntent(text) {
  const instruction = String(text || '').trim();
  // Quoted examples, fetched documents and tool results cannot authorize writes.
  const direct = instruction.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
    .replace(/^[ \t]*>.*$/gm, '').replace(/"[^"\n]*"|“[^”]*”/g, '');
  const aliases = {'crossplane-core':'crossplane(?:-core)?','kube-prometheus-stack':'kube-prometheus-stack|observability'};
  const ids = IDS.filter(id => new RegExp(`\\b(?:${aliases[id] || id})\\b`, 'i').test(direct));
  if (ids.length !== 1) return null;
  const actions = new Set();
  if (/문서\s*(?:내용|인용)|다음\s*(?:문장|예시)|quoted\s+(?:text|example)/i.test(direct)) return {id:ids[0],action:null,instruction};
  for (const clause of direct.split(/[.!?\n;]/)) {
    if (/하지\s*마|하지\s*말|금지|do not|don't|never|예시|인용|번역|설명|방법/i.test(clause)) continue;
    if (/(?:설치)(?:를)?\s*(?:해\s*줘|해\s*주세요|해라|진행해|실행해)|\b(?:please\s+)?install\s+(?:HISS\s+)?(?:ingress-nginx|cert-manager|metrics-server|crossplane|observability)\b/i.test(clause)) actions.add('install');
    if (/(?:삭제|제거)(?:를)?\s*(?:해\s*줘|해\s*주세요|해라|진행해|실행해)|\b(?:please\s+)?(?:uninstall|remove)\s+(?:HISS\s+)?(?:ingress-nginx|cert-manager|metrics-server|crossplane|observability)\b/i.test(clause)) actions.add('uninstall');
  }
  const versions = [...new Set(direct.match(/\bv?\d+\.\d+\.\d+\b/g) || [])];
  return {id:ids[0], action:actions.size === 1 && versions.length<=1 ? [...actions][0] : null, instruction,version:versions[0]||null};
}
function exact(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))
      || !IDS.includes(input.id)) fail(400, 'HISS의 고정 모듈 ID와 허용된 입력만 사용할 수 있습니다.');
}
function project(value, id) {
  if (value?.schema !== 'opensphere.hiss-lifecycle/v1' || value.id !== id || !REVISION.test(value.revision || '')
      || !Number.isFinite(Date.parse(value.observedAt)) || Date.now()-Date.parse(value.observedAt)>60000
      || Date.parse(value.observedAt)>Date.now()+30000 || typeof value.installed !== 'boolean'
      || (value.operation && (!/^[a-z0-9]+-[a-f0-9]+$/.test(value.operation.id || '') || typeof value.operation.phase !== 'string'))) {
    fail(502, 'HISS 실행 응답을 검증하지 못했습니다. 설치 완료로 판단할 수 없습니다.');
  }
  return value;
}
function createHisLifecycleClient({baseUrl, fetchImpl = fetch, signal = () => AbortSignal.timeout(30000)}) {
  async function request(actor, route, body) {
    if (!actor?.bearerToken) fail(401, '로그인 사용자 세션이 필요합니다.');
    let response;
    try { response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/hiss/${route}`, {
      method:'POST', redirect:'error', signal:signal(),
      headers:{authorization:`Bearer ${actor.bearerToken}`, 'content-type':'application/json', accept:'application/json'},
      body:JSON.stringify(body),
    }); } catch { fail(503, 'HISS owner에 연결하지 못했습니다. 상태를 다시 조회하기 전에는 변경을 재제출하지 않습니다.'); }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) fail(response.status, String(value.error || `HISS HTTP ${response.status}`).slice(0,1000));
    return project(value, body.id);
  }
  async function inspect(actor, input) {
    exact(input, ['id']);
    return request(actor, 'inspect', input);
  }
  async function execute(actor, input, context) {
    exact(input, ['id','action','planRevision']);
    const intent = hissIntent(context?.userInstruction);
    if (!intent?.action || intent.id !== input.id || intent.action !== input.action
        || !context?.sessionId || !context?.clientRequestId || !actor.subject) fail(403, '현재 사용자 메시지에 한 모듈의 설치 또는 삭제 지시가 명확해야 합니다.');
    if (!REVISION.test(input.planRevision || '')) fail(400, '현재 상태를 검토한 revision이 필요합니다.');
    if (intent.version) {
      const current = await inspect(actor, {id:input.id});
      if (intent.version.replace(/^v/, '') !== String(current.chartVersion).replace(/^v/, '')) fail(409, '요청한 버전이 서명된 고정 HISS 차트 버전과 다릅니다. 다른 버전을 임의 설치하지 않습니다.');
    }
    const requestKey = 'r2d2-hiss-' + createHash('sha256').update(JSON.stringify([
      actor.subject,context.sessionId,context.clientRequestId,input.id,input.action,
    ])).digest('hex');
    return request(actor, input.action, {id:input.id, requestKey, planRevision:input.planRevision,
      reason:`22 사용자 요청: ${intent.instruction.slice(0,480)}`,
      ...(input.action === 'uninstall' ? {confirm:input.id} : {}),
    });
  }
  async function executeRequested(actor, input, context) {
    exact(input, ['id','action']);
    const intent = hissIntent(context?.userInstruction);
    if (!intent?.action || intent.id !== input.id || intent.action !== input.action)
      fail(403, '현재 사용자 메시지에 한 모듈의 설치 또는 삭제 지시가 명확해야 합니다.');
    // The model selects the authorized action, never copies an opaque authority
    // revision. The owner still rejects drift between this fresh review and write.
    const reviewed = await inspect(actor, {id:input.id});
    return execute(actor, {...input, planRevision:reviewed.revision}, context);
  }
  return {inspect, execute, executeRequested};
}
function hissFailure(error) {
  const clean = String(error?.msg || error?.message || 'HISS 상태 확인 실패').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|ghp_|gho_)[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0,1000);
  return {schema:'osaa.hiss-lifecycle-failure/v1', ok:false, code:Number(error?.code)||503, error:clean};
}
function renderHisResult(value, failure) {
  const prefix = failure ? `HISS 작업을 중단했습니다: ${failure.error}\n` : '';
  if (!value) return prefix || 'HISS 실행 결과를 확인하지 못했습니다. 설치·삭제 완료가 아닙니다.';
  const operation = value.operation;
  const completed = operation?.phase === 'Ready' && value.installed && value.state === 'Ready';
  const removed = operation?.phase === 'Removed' && !value.installed && value.removalVerified === true;
  const phases = {Queued:'실행 대기',Installing:'설치 중',Validating:'결과 검증 중',Uninstalling:'삭제 중',Failed:'실패',RollbackStalled:'복구 중단',Ready:'설치 작업 종료; 현재 상태 확인 필요',Removed:'삭제 작업 종료; 현재 상태 확인 필요'};
  const label = completed ? '설치 상태 검증 완료' : removed ? '삭제 결과 검증 완료'
    : operation ? `작업 단계: ${phases[operation.phase] || operation.phase}` : `현재 상태: ${value.state}`;
  return prefix + `${value.displayName || value.id} · ${value.chartVersion}\n${label}\n`
    + (operation ? `작업 ID: ${operation.id}\n` : '접수된 작업 없음\n')
    + (value.noChange || operation?.noChange ? '이미 요청한 상태로 확인되어 Helm 변경을 실행하지 않았습니다.\n' : '')
    + (operation?.error ? `오류: ${operation.error}\n` : '')
    + `Helm: ${value.releaseStatus} · revision ${value.releaseRevision}\n관측 시각: ${value.observedAt}\n`
    + (value.message ? `상태 설명: ${value.message}\n` : '')
    + (value.executionReady === false ? `실행 준비 미완료: ${value.executionBlocker}\n` : '')
    + (operation && !completed && !removed ? '요청 접수나 대기 상태는 완료가 아닙니다. 현재 상태를 다시 조회하세요.\n' : '')
    + `삭제 시 보존 대상: ${(value.retainedOnDelete || []).join(', ') || '소유자 정책 확인 필요'}\n[HISS에서 보기](/p/cluster-manager/his/hiss)`;
}
module.exports = {IDS, HISS_TOOL_NAMES, hissIntent, createHisLifecycleClient, hissFailure, renderHisResult};
