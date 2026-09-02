'use strict';

// A knowledge question must not receive the full live-cluster tool inventory.
// Live tools are attached only when the human request contains an operational
// signal. This is deterministic so the decision can be tested and audited.
const LIVE_OPERATION_PATTERNS = [
  /\b(?:current|currently|live|runtime|status|health|healthy|readiness|ready|failure|failed|error|risk|incident|operation|postcondition|verification|log|logs|event|events|pod|pods|deployment|rollout|restart|scale|cluster|namespace|resource|diagnose|diagnosis|inspect|check)\b/i,
  /(?:현재|지금|실시간|실제\s*(?:운영|클러스터|환경)|운영\s*(?:상태|환경)|상태\s*(?:확인|점검|조회)|작업\s*(?:상태|결과|ID)|실행\s*(?:상태|결과)|사후\s*검증|정상\s*(?:인지|여부)|헬스|레디니스|장애|오류|에러|실패|위험|인시던트|로그|이벤트|파드|포드|디플로이먼트|배포\s*상태|롤아웃|재시작|스케일|클러스터|네임스페이스|리소스\s*(?:상태|목록|조회)|진단|원인\s*(?:분석|파악)|점검해|확인해|조회해)/u,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
];

const EXTENSION_PRESENTATION_PATTERNS = [
  /\bregistry\s+plugins?\b/i,
  /요청\s*시\s*적재/u,
  /(?:plugin|plugins|플러그인).*(?:화면|메뉴).*(?:표시|노출)/iu,
];

const CANONICAL_SOURCE_PATTERNS = [
  /\b(?:canonical\s+source|source\s+catalog|source\s+(?:revision|code|file)|exact\s+revision|repository\s+(?:source|code)|read_opensphere_source|search_opensphere_source)\b/i,
  /(?:정본\s*(?:소스|원문|코드)|소스\s*(?:코드|파일|원문).*(?:검색|조회|읽|확인)|(?:리포지토리|저장소).*(?:소스|코드|revision|리비전|커밋)|정확한\s*행\s*범위)/iu,
  /\b[0-9a-f]{40}\b/i,
];

const MANUAL_ACCESS_DIAGNOSIS_PATTERNS = [
  /Manual을\s*조회할\s*권한이\s*없/u,
  /(?:\/manual|manual).*(?:401|403|권한|접근|오류|에러|실패)/iu,
  /(?:401|403|권한|접근).*(?:\/manual|manual)/iu,
];

const OS_SHELL_DIAGNOSIS_PATTERNS = [
  /OsShellControlPlaneUnavailable/i,
  /OS\s*Shell.*(?:HTTP\s*500|readiness|시작할\s*수\s*없|연결\s*실패|터미널|WebSocket)/iu,
  /(?:HTTP\s*500|readiness|세션|attach|WebSocket|터미널).*(?:OS\s*Shell|OSS)/iu,
];

const REGISTRY_STATUS_PATTERNS = [
  /\b(?:registry|catalog)\b.*\b(?:revision|source|health|ready|stale|status|module|count|owner|ownership|authority)\b/i,
  /(?:레지스트리|카탈로그|registry|catalog).*(?:revision|리비전|source|소스|상태|모듈|개수|몇\s*개|소유|권위)/iu,
  /(?:revision|리비전|source|소스|상태|모듈|개수|몇\s*개|소유|권위).*(?:레지스트리|카탈로그|registry|catalog)/iu,
];

const FOUNDATION_POSTGRES_DOMAIN_PATTERN = /(?:\bPFSS\b|foundation).*(?:\bPostgreSQL\b|\bPostgres\b|포스트그레스)|(?:\bPostgreSQL\b|\bPostgres\b|포스트그레스).*?(?:\bPFSS\b|foundation)/iu;
const FOUNDATION_POSTGRES_STATUS_PATTERN = /(?:현재|운영\s*중|인스턴스|존재|있는가|있나|몇\s*개|상태|목록|조회|확인|current|running|instance|exist|status|list|check)/iu;
const FOUNDATION_POSTGRES_MUTATION_PATTERN = /(?:구성|설치|생성|프로비저닝|만들|create|configure|install|provision|delete|삭제)/iu;

function requiresExtensionPresentationStatus(query) {
  const text = String(query || '').trim();
  return text.length > 0 && EXTENSION_PRESENTATION_PATTERNS.some((pattern) => pattern.test(text));
}

function requiresCanonicalSourceTools(query) {
  const text = String(query || '').trim();
  return text.length > 0 && CANONICAL_SOURCE_PATTERNS.some((pattern) => pattern.test(text));
}

function requiresManualAccessDiagnosis(query) {
  const text = String(query || '').trim();
  return text.length > 0 && MANUAL_ACCESS_DIAGNOSIS_PATTERNS.some((pattern) => pattern.test(text));
}

function requiresOsShellDiagnosis(query) {
  const text = String(query || '').trim();
  return text.length > 0 && OS_SHELL_DIAGNOSIS_PATTERNS.some((pattern) => pattern.test(text));
}

function requiresRegistryStatus(query) {
  const text = String(query || '').trim();
  return text.length > 0 && REGISTRY_STATUS_PATTERNS.some((pattern) => pattern.test(text));
}

function requiresFoundationPostgresStatus(query) {
  const text = String(query || '').trim();
  return text.length > 0
    && !requiresRegistryStatus(text)
    && FOUNDATION_POSTGRES_DOMAIN_PATTERN.test(text)
    && FOUNDATION_POSTGRES_STATUS_PATTERN.test(text)
    && !FOUNDATION_POSTGRES_MUTATION_PATTERN.test(text);
}

function requiresLiveAgentTools(query) {
  const text = String(query || '').trim();
  return text.length > 0 && (
    LIVE_OPERATION_PATTERNS.some((pattern) => pattern.test(text)) ||
    requiresExtensionPresentationStatus(text) ||
    requiresCanonicalSourceTools(text) ||
    requiresManualAccessDiagnosis(text) ||
    requiresOsShellDiagnosis(text)
  );
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

module.exports = {
  configuredProviderModel,
  lexicalKnowledgeQuery,
  requiresCanonicalSourceTools,
  requiresExtensionPresentationStatus,
  requiresFoundationPostgresStatus,
  requiresManualAccessDiagnosis,
  requiresOsShellDiagnosis,
  requiresRegistryStatus,
  requiresLiveAgentTools,
};
