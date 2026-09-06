'use strict';

// CON-FR-007/018 · C_AI -> C_API -> C_EXT · CON-RT-08/13.
// This client owns no installation state, credentials or cluster privileges.
const { createHash } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const IMAGE = /^ghcr\.io\/opensphere-platform\/opensphere-shell-cluster-manager@sha256:[a-f0-9]{64}$/;
const DESCRIPTOR = 'extension.cluster-manager';
const STATES = new Set(['Planned', 'Authorized', 'Submitted', 'Reconciling', 'Applied', 'Verified', 'Failed', 'Unknown', 'RolledBack']);
const TOOL_NAMES = new Set(['inspect_module_installation', 'install_module', 'get_module_installation_operation']);
const JSON_LIMIT = 128 * 1024;

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code: status, errorCode: code, msg: message });
}

// Deliberately recognize only a direct request, never instructions in evidence,
// quoted documents, planning questions, negation or a model-generated argument.
function installationIntent(value) {
  const text = String(value || '').trim();
  const module = '(?:OpenSphere[- ]?)?(?:Cluster[- ]Manager|클러스터\\s*매니저)';
  const korean = new RegExp(`^(?:22[야,]?\\s*|R2D2[, ]+)?${module}(?:를|을)?\\s*(?:설치해(?:줘|주세요)?|설치해\\s*주세요|설치하자|설치 진행해(?:줘)?)[.!]?$`, 'iu');
  const english = new RegExp(`^(?:please\\s+)?install\\s+(?:the\\s+)?${module}(?:\\s+please)?[.!]?$`, 'iu');
  return korean.test(text) || english.test(text) ? Object.freeze({ descriptorId: DESCRIPTOR, instruction: text }) : null;
}

function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !fields.includes(key))) fail(400, 'ValidationFailed', '설치 도구 입력이 허용된 계약과 다릅니다.');
}

function requireActor(actor) {
  if (!actor?.bearerToken || !actor?.permissions?.includes('console.extension.install')) {
    fail(403, 'PermissionDenied', '현재 사용자의 모듈 설치 권한이 필요합니다.');
  }
}

function installationRequestKey(actor, context) {
  if (!installationIntent(context?.userInstruction) || !context?.sessionId || !context?.clientRequestId || !(actor?.subject || actor?.sub)) {
    fail(403, 'ExplicitInstallRequestRequired', '현재 대화에서 대상이 명확한 설치 지시가 필요합니다.');
  }
  return 'r2d2-install-' + createHash('sha256').update(JSON.stringify([actor.subject || actor.sub, context.sessionId, context.clientRequestId, DESCRIPTOR])).digest('hex');
}

function validateCandidate(value, revision) {
  const candidate = value?.data?.candidate;
  if (value?.freshness !== 'fresh' || value?.data?.resolution !== 'Eligible'
      || candidate?.descriptorId !== DESCRIPTOR || candidate?.catalogRevision !== revision || !IMAGE.test(candidate?.image || '')) {
    fail(502, 'InvalidOwnerResponse', '설치 후보의 제품·버전·출처를 확인하지 못했습니다.');
  }
  return candidate;
}

async function ownerJson(response) {
  if (!response.body) fail(502, 'InvalidOwnerResponse', '설치 API 응답이 비어 있습니다.');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > JSON_LIMIT) {
        await reader.cancel();
        fail(502, 'InvalidOwnerResponse', '설치 API 응답 크기가 제한을 초과했습니다.');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error.errorCode) throw error;
    fail(502, 'InvalidOwnerResponse', '설치 API 응답을 읽지 못했습니다. 같은 요청으로 상태를 확인하세요.');
  } finally { reader.releaseLock(); }
}

function projectReceipt(value, expected = {}) {
  if (value?.schemaVersion !== '1.0' || value.actionId !== 'console.extension.install'
      || !UUID.test(value.operationId || '') || !IMAGE.test(value.targetRef || '')
      || !STATES.has(value.state) || !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 0
      || expected.id && value.operationId !== expected.id || expected.image && value.targetRef !== expected.image
      || expected.actor && value.actorRef !== expected.actor) {
    fail(502, 'InvalidOwnerResponse', '설치 작업 응답의 식별자·대상·상태가 일치하지 않습니다.');
  }
  // Do not disclose arbitrary execution plans, credentials or owner errors to the LLM.
  return {
    schema: 'osaa.module-installation-operation/v1', operationId: value.operationId,
    descriptorId: DESCRIPTOR, state: value.state, stateVersion: value.stateVersion,
    targetRef: value.targetRef, updatedAt: value.updatedAt, observedAt: new Date().toISOString(),
    installationVerified: value.state === 'Verified', productFunctionsVerified: false,
    errorCode: typeof value.error?.code === 'string' ? value.error.code.slice(0, 120) : null,
    reviewPath: `/manage/extensions/catalog?operation=${value.operationId}`,
    nextAction: value.state === 'Verified' ? '원본 Kubernetes·HISS·Ceph 기능 검증 필요'
      : ['Failed', 'Unknown', 'RolledBack'].includes(value.state) ? '현재 작업 원인 확인; 자동 재설치하지 않음'
        : '같은 작업 ID로 진행 상태 조회',
  };
}

function createModuleInstallationClient({ baseUrl, fetchImpl = fetch, readRegistry, observeInstallation, signal = () => AbortSignal.timeout(15000) }) {
  const origin = new URL(baseUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new TypeError('fixed Console API origin is required');

  async function request(method, path, actor, body, key) {
    requireActor(actor);
    let response;
    try {
      response = await fetchImpl(origin.origin + path, {
        method, redirect: 'error', signal: signal(),
        headers: { authorization: `Bearer ${actor.bearerToken}`, 'x-os-owner-admission': 'osaa-gateway-v1', accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'x-os-idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { fail(503, 'AuthorityUnavailable', 'Console 설치 API에 연결하지 못했습니다. 같은 요청으로 확인하세요.'); }
    const value = await ownerJson(response);
    if (!response.ok) fail(response.status, typeof value?.code === 'string' ? value.code : 'InstallationRequestRejected',
      response.status === 428 ? 'MFA 인증 후 같은 설치 요청을 다시 진행하세요.'
        : `Console 설치 요청이 거부되었습니다 (HTTP ${response.status}).`);
    return value;
  }

  async function inspect(actor, input) {
    requireActor(actor); exact(input, ['descriptorId']);
    if (input.descriptorId !== DESCRIPTOR) fail(400, 'ValidationFailed', '현재 설치 대상은 OpenSphere-Cluster-Manager입니다.');
    const observation = await observeInstallation(actor);
    const state = observation?.clusterManager?.state;
    if (!['Ready', 'RegisteredNotReady', 'NotRegistered'].includes(state)) fail(503, 'RuntimeUnknown', '현재 등록 상태를 확인하지 못해 설치를 중단했습니다.');
    // Discovery expiry prevents a NEW install, not inspection of existing work.
    // Never use an unavailable candidate as a reason to reinstall or delete it.
    if (state !== 'NotRegistered') return { schema: 'osaa.module-installation-review/v1', descriptorId: DESCRIPTOR, runtimeState: state, installable: false, productFunctionsVerified: false, nextAction: state === 'Ready' ? '이미 등록·준비된 모듈입니다. 기능 상태를 확인하세요.' : '기존 등록의 작업 상태·실패 원인을 확인하세요. 자동 재설치하지 않습니다.' };
    const registry = await readRegistry();
    const required = ['extensions.packages', 'extensions.registrations', 'extensions.navigation', 'trust.keys', 'release.inventory'];
    if (registry?.schema !== 'opensphere.registry-catalog/v1' || registry.stale !== false || !REVISION.test(registry.revision || '')
        || !required.every(key => registry.sources?.[key]?.ready === true)
        || !Object.entries(registry.sources || {}).every(([key, value]) => value.ready === true || key === 'catalog.descriptors' && value.reason === 'NotInstalled')) {
      fail(503, 'CatalogNotReady', '공식 설치 목록의 필수 정보가 준비되지 않았습니다.');
    }
    const descriptors = (registry.inventory?.descriptors || []).filter(value => value.id === DESCRIPTOR && value.class === 'extension');
    if (descriptors.length !== 1) fail(409, 'CandidateUnavailable', '공식 Cluster Manager 후보가 없거나 중복되었습니다.');
    const descriptor = descriptors[0];
    if (descriptor.installation?.mode !== 'extension-controller' || descriptor.installation?.eligible !== true) fail(409, 'CandidateUnavailable', '현재 공식 배포본은 설치 가능한 후보가 아닙니다.');
    const candidate = validateCandidate(await request('POST', '/api/admin/extensions/inspect', actor, { descriptorId: DESCRIPTOR, catalogRevision: registry.revision }), registry.revision);
    return { schema: 'osaa.module-installation-review/v1', descriptorId: DESCRIPTOR, catalogRevision: registry.revision,
      image: candidate.image, version: descriptor.release?.version || descriptor.release?.artifactVersion || '버전 확인 필요',
      channel: descriptor.release?.channel || '확인 필요', runtimeState: state, installable: true, productFunctionsVerified: false };
  }

  async function install(actor, input, context) {
    requireActor(actor); exact(input, ['descriptorId', 'catalogRevision']);
    const intent = installationIntent(context?.userInstruction);
    if (!intent || intent.descriptorId !== input.descriptorId || !context?.sessionId || !context?.clientRequestId) {
      fail(403, 'ExplicitInstallRequestRequired', '현재 대화에서 대상이 명확한 설치 지시가 필요합니다.');
    }
    if (!REVISION.test(input.catalogRevision || '')) fail(400, 'ValidationFailed', '검토한 설치 목록 revision이 필요합니다.');
    const key = installationRequestKey(actor, context);
    const existing = await findCurrentRequest(actor, context);
    if (existing) return existing;
    const review = await inspect(actor, { descriptorId: input.descriptorId });
    if (!review.installable) return review;
    if (review.catalogRevision !== input.catalogRevision) fail(409, 'StaleRevision', '설치 목록이 변경되었습니다. 다시 검토하세요.');
    const value = await request('POST', '/api/admin/extensions/install', actor, {
      descriptorId: DESCRIPTOR, catalogRevision: review.catalogRevision, reason: '22 사용자 요청: ' + intent.instruction,
    }, key);
    return projectReceipt(value, { image: review.image, actor: actor.subject || actor.sub });
  }

  async function getOperation(actor, input) {
    exact(input, ['operationId']);
    if (!UUID.test(input.operationId || '')) fail(400, 'ValidationFailed', '설치 작업 UUID가 필요합니다.');
    const value = await request('GET', `/api/platform/operations/${input.operationId}`, actor);
    return projectReceipt(value, { id: input.operationId, actor: actor.subject || actor.sub });
  }
  async function findCurrentRequest(actor, context) {
    const key = installationRequestKey(actor, context);
    const value = await request('GET', `/api/admin/extensions/install-requests/${key}`, actor);
    if (value?.schemaVersion !== '1.0' || !Object.hasOwn(value, 'receipt')) fail(502, 'InvalidOwnerResponse', '기존 설치 요청의 결과를 확인하지 못했습니다.');
    return value.receipt === null ? null : { ...projectReceipt(value.receipt, { actor: actor.subject || actor.sub }), replayed: true };
  }
  return Object.freeze({ inspect, install, getOperation, findCurrentRequest });
}

function installationFailure(error) {
  const messages = {
    StepUpRequired: 'MFA 인증 후 같은 요청을 다시 진행하세요.',
    AuthenticationRequired: '현재 사용자 세션을 다시 확인하세요.',
    PermissionDenied: '현재 사용자에게 필요한 설치 권한이 없습니다.',
    ExplicitInstallRequestRequired: '현재 대화에서 대상이 명확한 설치 지시가 필요합니다.',
    ValidationFailed: '요청 형식이 설치 계약과 일치하지 않습니다.',
    CatalogNotReady: '공식 설치 목록의 필수 정보가 준비되지 않았습니다.',
    CandidateUnavailable: '검증된 공식 Cluster Manager 설치 후보가 없습니다.',
    RuntimeUnknown: '현재 등록 상태를 확인하지 못했습니다.',
    StaleRevision: '설치 목록이 변경되었습니다. 다시 검토하세요.',
    InvalidOwnerResponse: '설치 API 응답을 검증하지 못했습니다. 같은 요청으로 접수 여부를 확인하세요.',
    AuthorityUnavailable: '설치 API 조회에 실패했습니다. 새 설치를 제출하지 말고 같은 요청으로 확인하세요.',
  };
  const supplied = error?.errorCode || error?.code;
  const code = Object.hasOwn(messages, supplied) ? supplied : ({ 401: 'AuthenticationRequired', 403: 'PermissionDenied', 428: 'StepUpRequired' }[error?.status || error?.code] || 'AuthorityUnavailable');
  return { schema: 'osaa.module-installation-failure/v1', ok: false, errorCode: code, error: messages[code] };
}

function renderInstallationResult(result, failure = null) {
  const failed = failure?.schema === 'osaa.module-installation-failure/v1' ? `설치 절차를 멈췄습니다: ${failure.error}\n` : '';
  if (!result?.operationId) return failed || `OpenSphere-Cluster-Manager: ${result?.nextAction || (result?.installable ? '설치 검토 완료, 설치 실행은 아직 확인되지 않았습니다.' : '설치 상태 확인 필요')}\n전체 제품 기능 검증을 완료했다는 뜻은 아닙니다.`;
  const labels = { Planned: '검토 중', Authorized: '실행 대기', Submitted: '제출됨', Reconciling: '설치 중', Applied: '준비 상태 확인 중', Verified: '패키지 설치 검증됨', Failed: '실패', Unknown: '현재 상태 확인 필요', RolledBack: '되돌려짐' };
  return failed + `${failed ? '마지막으로 확인한 ' : ''}OpenSphere-Cluster-Manager 설치 작업: ${labels[result.state] || '확인 필요'}\n작업 ID: ${result.operationId}\n${result.nextAction}\n[설치 진행 보기](${result.reviewPath})\nHISS·Ceph를 포함한 전체 제품 기능의 검증은 아직 완료하지 않았습니다.`;
}

module.exports = { installationIntent, createModuleInstallationClient, projectReceipt, renderInstallationResult, installationFailure, MODULE_INSTALLATION_TOOL_NAMES: TOOL_NAMES };
