'use strict';

// A knowledge question must not receive the full live-cluster tool inventory.
// Live tools are attached only when the human request contains an operational
// signal. This is deterministic so the decision can be tested and audited.
const LIVE_OPERATION_PATTERNS = [
  /\b(?:current|currently|live|runtime|status|health|healthy|readiness|ready|failure|failed|error|risk|incident|log|logs|event|events|pod|pods|deployment|rollout|restart|scale|cluster|namespace|resource|diagnose|diagnosis|inspect|check)\b/i,
  /(?:현재|지금|실시간|실제\s*(?:운영|클러스터|환경)|운영\s*(?:상태|환경)|상태\s*(?:확인|점검|조회)|정상\s*(?:인지|여부)|헬스|레디니스|장애|오류|에러|실패|위험|인시던트|로그|이벤트|파드|포드|디플로이먼트|배포\s*상태|롤아웃|재시작|스케일|클러스터|네임스페이스|리소스\s*(?:상태|목록|조회)|진단|원인\s*(?:분석|파악)|점검해|확인해|조회해)/u,
];

function requiresLiveAgentTools(query) {
  const text = String(query || '').trim();
  return text.length > 0 && LIVE_OPERATION_PATTERNS.some((pattern) => pattern.test(text));
}

// PostgreSQL's `simple` text search does not split a Korean particle from an
// adjacent Latin identifier (`PFSS가` becomes one lexeme). Prefer explicit
// acronyms or dotted canonical identifiers when present, while retaining the
// complete query for ordinary natural-language searches.
function lexicalKnowledgeQuery(query) {
  const text = String(query || '').trim();
  if (!text) return '';
  const identifiers = text.match(/[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)+|\b[A-Z][A-Z0-9]{1,15}\b/g) || [];
  return [...new Set(identifiers.map((value) => value.trim()).filter(Boolean))].join(' ') || text;
}

// The configured credential owns the provider model. Browser response metadata
// (including the built-in `osaa-control-tools` execution profile) is display
// data and must never become model-selection authority for the next turn.
function configuredProviderModel(defaultModel, requestedModel = '') {
  const configured = String(defaultModel || '').trim();
  if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(configured)) {
    const error = new Error('configured provider model is unavailable');
    error.code = 503;
    error.errorCode = 'configured_provider_model_unavailable';
    throw error;
  }
  const requested = String(requestedModel || '').trim();
  if (requested && requested !== configured) {
    const error = new Error('requested model does not match the configured provider model');
    error.code = 400;
    error.errorCode = 'provider_model_override_rejected';
    throw error;
  }
  return configured;
}

module.exports = { configuredProviderModel, lexicalKnowledgeQuery, requiresLiveAgentTools };
