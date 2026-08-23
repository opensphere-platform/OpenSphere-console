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
  if (!text) return true;
  if (/(현재|지금|운영|상태|ready|running|version|버전|instance|인스턴스|삭제|생성|적용|실행)/i.test(text)) return true;
  if (/(개념|정의|뜻|설명|architecture|설계 원칙)/i.test(text)) return false;
  return true;
}

module.exports = {
  EPISTEMIC_STATES,
  buildPfssPostgresClaimSet,
  buildPfssPostgresOperationClaim,
  isOperationalQuery,
  observeOwnerEvidence,
  redactOwnerEvidence,
  renderPfssPostgresClaimSet,
  renderPfssPostgresOperationClaim,
};
