'use strict';

const { digest } = require('./dialogue-state');

const EPISTEMIC_STATES = Object.freeze(new Set([
  'known', 'unknown', 'stale', 'conflicting', 'inferred', 'unobservable',
]));
const SECRET_KEY_RE = /(?:password|passwd|passphrase|token|api[_-]?key|access[_-]?key|secret|credential|private[_-]?key|kubeconfig|connection[_-]?(?:string|uri)|dsn)/i;
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function secretFailure(reason) {
  return {
    ok: false, epistemicState: 'unobservable', modelVisible: false,
    reason, value: null, redactedFields: [],
  };
}

function redactUriUserInfo(value) {
  if (!URI_RE.test(value) || !value.includes('@')) return { value, redacted: false };
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('uri_userinfo_redaction_failed'); }
  if (!parsed.username && !parsed.password) return { value, redacted: false };
  parsed.username = '';
  parsed.password = '';
  return { value: parsed.toString(), redacted: true };
}

function redactOwnerEvidence(value) {
  const seen = new WeakSet();
  const redactedFields = [];
  let entries = 0;
  const walk = (item, path = '$', depth = 0) => {
    if (depth > 12 || entries++ > 4000) throw new Error('evidence_budget_exceeded');
    if (item === null || item === undefined || typeof item === 'number' || typeof item === 'boolean') return item ?? null;
    if (typeof item === 'string') {
      if (item.length > 16000) throw new Error('evidence_string_budget_exceeded');
      const uri = redactUriUserInfo(item);
      if (uri.redacted) redactedFields.push(path);
      return uri.value;
    }
    if (typeof item !== 'object') throw new Error('unsupported_evidence_value');
    if (seen.has(item)) throw new Error('cyclic_evidence');
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 500).map((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
    const output = {};
    for (const [key, entry] of Object.entries(item)) {
      const childPath = `${path}.${key}`;
      if (SECRET_KEY_RE.test(key)) {
        output[key] = '[REDACTED]';
        redactedFields.push(childPath);
      } else output[key] = walk(entry, childPath, depth + 1);
    }
    return output;
  };
  try {
    const sanitized = walk(value);
    return {
      ok: true, epistemicState: 'known', modelVisible: true, value: sanitized,
      redactedFields, digest: digest(sanitized),
    };
  } catch (error) {
    return secretFailure(String(error?.message || 'evidence_redaction_failed'));
  }
}

function observeOwnerEvidence(payload, options = {}) {
  const observedAt = new Date(options.observedAt || Date.now());
  const ttlSeconds = Number(options.ttlSeconds);
  if (!Number.isFinite(observedAt.getTime()) || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) {
    return secretFailure('owner_ttl_invalid');
  }
  const redacted = redactOwnerEvidence(payload);
  if (!redacted.ok) return redacted;
  const expiresAt = new Date(observedAt.getTime() + ttlSeconds * 1000);
  const state = expiresAt.getTime() > Number(options.now || Date.now()) ? 'known' : 'stale';
  const evidenceMaterial = {
    schema: String(options.schema || 'owner-evidence/v1'), owner: String(options.owner || ''),
    observedAt: observedAt.toISOString(), expiresAt: expiresAt.toISOString(),
    payloadDigest: redacted.digest,
  };
  const evidenceDigest = digest(evidenceMaterial);
  return {
    ...redacted, epistemicState: state, observedAt: observedAt.toISOString(),
    expiresAt: expiresAt.toISOString(), evidenceDigest,
    evidenceRef: `${String(options.owner || 'owner')}@${evidenceDigest}`,
  };
}

function buildPfssPostgresClaimSet(observation) {
  const base = {
    schema: 'osaa.claim-set/pfss-postgresql-v1',
    epistemicState: EPISTEMIC_STATES.has(observation?.epistemicState)
      ? observation.epistemicState : 'unobservable',
    evidenceRef: observation?.evidenceRef || null,
    observedAt: observation?.observedAt || null,
    expiresAt: observation?.expiresAt || null,
    claims: [],
  };
  if (base.epistemicState !== 'known' || !observation?.value) return base;
  const status = observation.value;
  const claims = Array.isArray(status.claims) ? status.claims : [];
  const clusters = Array.isArray(status.clusters) ? status.clusters : [];
  base.claims = claims.filter((claim) => claim?.ready === true
      && Number(claim?.observedGeneration || 0) >= Number(claim?.generation || 0))
    .map((claim) => {
      const clusterName = String(claim?.clusterRef?.name || `pgc-${claim?.name || ''}`);
      const clusterNamespace = String(claim?.clusterRef?.namespace || claim?.namespace || '');
      const cluster = clusters.find((item) => item?.name === clusterName && item?.namespace === clusterNamespace);
      return {
        type: 'pfss.postgresql.instance.ready', namespace: String(claim?.namespace || ''),
        name: String(claim?.name || ''), ready: true,
        postgresVersion: String(claim?.postgresVersion || cluster?.postgresVersion || ''),
        instances: Math.max(0, Number(cluster?.instances || 0)),
      };
    }).filter((claim) => claim.namespace && claim.name);
  return base;
}

function renderPfssPostgresClaimSet(claimSet) {
  if (claimSet?.epistemicState === 'stale') {
    return 'PFSS PostgreSQL의 최근 관측은 만료되어 현재 운영 인스턴스 수를 확정할 수 없습니다.';
  }
  if (claimSet?.epistemicState !== 'known') {
    return 'PFSS PostgreSQL Owner를 현재 관측할 수 없어 운영 인스턴스 존재 여부를 확정할 수 없습니다.';
  }
  const claims = Array.isArray(claimSet.claims) ? claimSet.claims : [];
  if (!claims.length) return '현재 PFSS PostgreSQL에서 Ready로 검증된 운영 인스턴스는 없습니다.';
  const details = claims.map((claim) => {
    const version = claim.postgresVersion ? `PostgreSQL ${claim.postgresVersion}` : 'PostgreSQL 버전 미표시';
    const instances = claim.instances > 0 ? `, ${claim.instances}개 인스턴스` : '';
    return `- ${claim.namespace}/${claim.name}: Ready, ${version}${instances}`;
  });
  return [
    `현재 PFSS PostgreSQL 운영 인스턴스가 ${claims.length}개 있습니다.`,
    ...details,
    `확인 기준: PFSS Owner ${claimSet.observedAt}`,
  ].join('\n');
}

function buildPfssPostgresOperationClaim(observation) {
  const base = {
    schema: 'osaa.operation-claim/pfss-postgresql-v1',
    epistemicState: EPISTEMIC_STATES.has(observation?.epistemicState)
      ? observation.epistemicState : 'unobservable',
    evidenceRef: observation?.evidenceRef || null,
    observedAt: observation?.observedAt || null,
    expiresAt: observation?.expiresAt || null,
    operation: null,
  };
  if (base.epistemicState !== 'known' || !observation?.value) return base;
  const value = observation.value;
  const target = value.target && typeof value.target === 'object' ? value.target : {};
  base.operation = {
    operationId: String(value.operationId || ''),
    stage: String(value.stage || value.operationPhase || value.phase || 'Unknown'),
    operationPhase: String(value.operationPhase || value.phase || 'Unknown'),
    verificationState: String(value.verificationState || 'pending'),
    target: {
      kind: String(target.kind || 'FoundationClaim'),
      namespace: String(target.namespace || ''),
      name: String(target.name || ''),
    },
  };
  return base;
}

function renderPfssPostgresOperationClaim(claim) {
  if (claim?.epistemicState === 'stale') return 'PFSS PostgreSQL 작업 관측이 만료되어 현재 진행 상태를 확정할 수 없습니다.';
  if (claim?.epistemicState !== 'known' || !claim?.operation) return 'PFSS PostgreSQL 작업을 현재 관측할 수 없습니다.';
  const operation = claim.operation;
  const target = operation.target || {};
  return [
    `PFSS PostgreSQL 작업 ${operation.operationId}`,
    `상태: ${operation.stage} (원장 ${operation.operationPhase})`,
    `대상: ${target.kind}/${target.namespace}/${target.name}`,
    `검증: ${operation.verificationState}`,
    `확인 기준: PFSS Owner ${claim.observedAt}`,
  ].join('\n');
}

function isOperationalQuery(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const conceptual = /(개념|정의|뜻|설명|architecture|설계\s*원칙|왜\s*(?:필요|사용)|what\s+is)/i.test(text);
  const liveMarker = /(현재|지금|운영\s*중|실시간|live|ready|running|status|상태|버전|version|몇\s*개|존재|가능|삭제|생성|적용|실행|완료|실패|오류|인스턴스|replicas?|목록|다시\s*확인)/i.test(text);
  if (conceptual && !liveMarker) return false;
  if (liveMarker) return true;
  if (/^(?:postgres(?:ql)?|pfss|인스턴스|그거|그것|이거|이것)(?:은|는|이|가)?\s*(?:\?|어때|어떻게|있어|없어)?$/i.test(text)) return true;
  return false;
}

function isCurrentSystemFactQuery(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const deicticCurrentFact = /^(?:몇\s*개(?:야|인가|있어)?|상태(?:는|가)?|지금(?:은)?|현재(?:는)?|가능(?:해|한가)?|있어|없어|how\s+many|what(?:'s|\s+is)\s+(?:its|the)\s+(?:status|version)|is\s+it\s+(?:ready|running|available))\s*[?.!]*$/i.test(text);
  if (deicticCurrentFact) return true;
  const liveMarker = /(?:현재|지금|운영\s*중|실시간|몇\s*개|상태|버전|존재|가능|준비|활성|비활성|설치|오류|실패|완료|정상|동기화|됐(?:어|나)|되나|로그인|목록|수\s*알려|current|now|live|how\s+many|status|version|exist|available|ready|running|healthy|enabled|disabled|installed|failed|completed|synced)/i.test(text);
  const conceptual = /(?:개념|정의|뜻|설명|architecture|설계\s*원칙|왜\s*(?:필요|사용)|what\s+is)/i.test(text);
  return liveMarker && !conceptual;
}

function providerClaimsCurrentSystemFact(value) {
  const text = String(value || '');
  const conceptual = /(?:개념|정의|뜻|일반적|보통|architecture|설계\s*원칙|what\s+is)/i.test(text);
  const explicitCurrent = /(?:현재|지금|운영\s*중|실시간|currently|right\s+now)/i.test(text);
  const observedState = /(?:정상\s*(?:동작|상태|입니다)|준비(?:됨|되었습니다)|사용\s*가능|사용\s*불가|있습니다|없습니다|가능합니다|불가능합니다|ready|running|healthy|unavailable|available|enabled|disabled|failed|synced|outofsync|degraded)/i.test(text);
  const observedCount = /(?:인스턴스|파드|pod|replica|deployment|service|클러스터|노드)[^\n.]{0,40}(?:\d+\s*개|\d+\s*\/\s*\d+)/i.test(text);
  if (conceptual && !explicitCurrent) return false;
  return explicitCurrent || observedState || observedCount;
}

function isPfssContextualFollowupQuery(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 160) return false;
  if (/(?:pfss|postgres(?:ql)?|postgresclaim|foundation-data-pg)/i.test(text)) return true;
  return /^(?:(?:그거|그것|이거|이것)(?:은|는|이|가)?\s*)?(?:몇\s*개(?:야|인가|있어)?|상태(?:는|가)?|다시\s*확인(?:해줘)?|인스턴스\s*(?:목록(?:\s*보여줘)?|수(?:\s*알려줘)?)|replicas?\s*(?:수|목록)?(?:\s*알려줘)?|목록\s*보여줘|삭제\s*가능(?:해|한가)?|생성\s*가능(?:해|한가)?)\s*[?.!]*$/i.test(text);
}

function hasExplicitNonPfssDomainQuery(value) {
  const text = String(value || '');
  const hasPfss = /(?:pfss|postgres(?:ql)?|postgresclaim|foundation-data-pg)/i.test(text);
  if (hasPfss) return false;
  return /(?:gitlab|gitea|os\s*shell|\boss\b|manual|cluster\s*manager|kubernetes|\bk8s\b|pod|deployment|service|psmdb|mongo(?:db)?|valkey|opensearch|rustfs|ceph|supabase|subshell|plugin|registry)/i.test(text);
}

function isOsaaSelfIdentityQuery(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 120) return false;
  const namesOsaa = /(?:너|넌|네\s|당신|\byou\b|\byour\b|r2d2|osaa|opensphere\s+ai\s+agent)/i.test(text);
  const asksIdentity = /(?:이름(?:은|이|이야|인가|뭐|뭔)|누구(?:야|니|인가)?|who\s+are\s+you|what(?:'s|\s+is)\s+your\s+name)/i.test(text);
  return namesOsaa && asksIdentity;
}

function renderOsaaSelfIdentity() {
  return '저는 OpenSphere AI Agent(OSAA), 별칭 R2D2입니다.';
}

function guardProviderCurrentFactResponse(query, content, options = {}) {
  const currentFact = isCurrentSystemFactQuery(query) || providerClaimsCurrentSystemFact(content);
  const verifiedDeterministic = options.verifiedDeterministic === true;
  if (!currentFact || verifiedDeterministic) {
    return { applied: false, state: currentFact ? 'verified' : 'not-current-fact', content: String(content || '') };
  }
  return {
    applied: true,
    state: 'unobservable',
    content: '이 질문은 OpenSphere의 현재 시스템 사실 확인이 필요하지만, 이 응답 경로에는 답을 확정할 수 있는 Owner의 typed projection과 결정적 렌더러가 없습니다. 추정해서 답하지 않습니다.',
  };
}

module.exports = {
  EPISTEMIC_STATES,
  buildPfssPostgresClaimSet,
  buildPfssPostgresOperationClaim,
  guardProviderCurrentFactResponse,
  hasExplicitNonPfssDomainQuery,
  isCurrentSystemFactQuery,
  isOsaaSelfIdentityQuery,
  isOperationalQuery,
  isPfssContextualFollowupQuery,
  providerClaimsCurrentSystemFact,
  observeOwnerEvidence,
  redactOwnerEvidence,
  renderPfssPostgresClaimSet,
  renderPfssPostgresOperationClaim,
  renderOsaaSelfIdentity,
};
