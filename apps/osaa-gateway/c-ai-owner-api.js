'use strict';

const { createHash, randomUUID } = require('crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const KEY_ID = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;
const DIALOGUE_MODES = new Set(['off', 'shadow', 'read-enforce', 'mutation-enforce']);
const BROWSER_MARKERS = Object.freeze({
  'authenticated-health': 'os-shell',
  'manual-route': '[data-manual-contract="console-help-center-v2"]',
  'registry-plugins': 'os-admin-plugins',
  'osaa-admin': 'os-admin-osaa',
});
const CANONICAL_REPAIR_REPOSITORY = 'https://github.com/opensphere-platform/OpenSphere-console.git';
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

function fail(code, msg, errorCode) {
  throw { code, status: code, msg, message: msg, ...(errorCode ? { errorCode } : {}) };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function closedObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, `${label} must be an object`);
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) fail(400, `${label} contains unsupported fields: ${extra.join(', ')}`);
  return value;
}

function boundedLimit(value, fallback = 20) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^[0-9]{1,3}$/.test(String(value))) fail(400, 'limit must be an integer from 1 to 50');
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) fail(400, 'limit must be an integer from 1 to 50');
  return n;
}

function requireUuid(value, label) {
  const normalized = String(value || '');
  if (!UUID.test(normalized)) fail(400, `${label} must be a UUID`);
  return normalized;
}

function requireAal2Actor(actor, purpose) {
  const subject = String(actor?.subject || actor?.sub || '');
  const sessionId = String(actor?.browserSessionId || '');
  if (actor?.assurance !== 'aal2') fail(403, `AAL2 ${purpose} required`);
  if (!UUID.test(subject) || !UUID.test(sessionId)) fail(401, `stable actor and browser session are required for ${purpose}`);
  return { subject, sessionId, authzRevision: String(actor?.authzRevision || actor?.credentialRevision || '0') };
}

function field(row, snake, camel = snake) {
  return row?.[camel] ?? row?.[snake] ?? null;
}

function publicOperation(row) {
  return {
    operationId: field(row, 'operation_id', 'operationId'),
    action: field(row, 'action'),
    target: field(row, 'precondition')?.target || null,
    phase: field(row, 'phase'),
    executionState: field(row, 'execution_state', 'executionState'),
    verificationState: field(row, 'verification_state', 'verificationState'),
    riskClass: field(row, 'requested_risk_class', 'requestedRiskClass') || field(row, 'risk_class', 'riskClass'),
    requiredAssurance: field(row, 'required_assurance', 'requiredAssurance'),
    incidentId: field(row, 'incident_id', 'incidentId'),
    descriptorRevision: field(row, 'descriptor_revision', 'descriptorRevision'),
    descriptorDigest: field(row, 'descriptor_digest', 'descriptorDigest'),
    toolId: field(row, 'tool_id', 'toolId'),
    verifierId: field(row, 'verifier_id', 'verifierId'),
    attempt: Number(field(row, 'attempt') || 0),
    result: field(row, 'result') || {},
    errorCode: field(row, 'error_code', 'errorCode'),
    createdAt: field(row, 'created_at', 'createdAt'),
    updatedAt: field(row, 'updated_at', 'updatedAt'),
    deadlineAt: field(row, 'deadline_at', 'deadlineAt'),
    approvalConfirmation: field(row, 'phase') === 'AwaitingApproval' && field(row, 'action') !== 'engineering-remediation'
      ? `approve R2D2 operation ${field(row, 'operation_id', 'operationId')} ${field(row, 'descriptor_digest', 'descriptorDigest')}`
      : null,
  };
}

function publicApproval(row) {
  return {
    approverId: field(row, 'approver_id', 'approverId'),
    assurance: field(row, 'assurance'),
    approvalDigest: field(row, 'approval_digest', 'approvalDigest'),
    approvalScope: field(row, 'approval_scope', 'approvalScope'),
    bindingDigest: field(row, 'binding_digest', 'bindingDigest'),
    approvedAt: field(row, 'approved_at', 'approvedAt'),
    revokedAt: field(row, 'revoked_at', 'revokedAt'),
  };
}

function publicStep(row) {
  return {
    sequence: Number(field(row, 'sequence') || 0),
    attempt: Number(field(row, 'attempt') || 0),
    stepType: field(row, 'step_type', 'stepType'),
    toolId: field(row, 'tool_id', 'toolId'),
    verifierId: field(row, 'verifier_id', 'verifierId'),
    status: field(row, 'status'),
    errorCode: field(row, 'error_code', 'errorCode'),
    observedAt: field(row, 'observed_at', 'observedAt'),
    evidence: field(row, 'evidence') || {},
  };
}

function publicRemediation(row, executionEnabled = false, workerReady = false) {
  return {
    remediationRequestId: field(row, 'remediation_request_id', 'remediationRequestId'),
    assessmentId: field(row, 'assessment_id', 'assessmentId'),
    incidentId: field(row, 'incident_id', 'incidentId'),
    operationId: field(row, 'operation_id', 'operationId'),
    operatorId: field(row, 'operator_id', 'operatorId'),
    repository: field(row, 'repository'),
    baseRevision: field(row, 'base_revision', 'baseRevision'),
    allowedPaths: field(row, 'allowed_paths', 'allowedPaths') || [],
    changedPaths: field(row, 'changed_paths', 'changedPaths') || [],
    patchDigest: field(row, 'patch_digest', 'patchDigest'),
    reason: field(row, 'reason'),
    riskLevel: field(row, 'risk_level', 'riskLevel'),
    affectedComponents: field(row, 'affected_components', 'affectedComponents') || [],
    affectedImages: field(row, 'affected_images', 'affectedImages') || [],
    requiredTests: field(row, 'required_tests', 'requiredTests') || [],
    releaseScope: field(row, 'release_scope', 'releaseScope'),
    fullReleaseJustification: field(row, 'full_release_justification', 'fullReleaseJustification'),
    targetChannel: field(row, 'target_channel', 'targetChannel'),
    buildAuthority: field(row, 'build_authority', 'buildAuthority'),
    rollbackRevision: field(row, 'rollback_revision', 'rollbackRevision'),
    rollbackImageDigests: field(row, 'rollback_image_digests', 'rollbackImageDigests') || [],
    approvalBindingDigest: field(row, 'approval_binding_digest', 'approvalBindingDigest'),
    approvalMode: field(row, 'approval_mode', 'approvalMode'),
    verificationProfile: field(row, 'verification_profile', 'verificationProfile'),
    verificationRoute: field(row, 'verification_route', 'verificationRoute'),
    approvalExpiresAt: field(row, 'approval_expires_at', 'approvalExpiresAt'),
    stage: field(row, 'stage'),
    createdAt: field(row, 'created_at', 'createdAt'),
    updatedAt: field(row, 'updated_at', 'updatedAt'),
    activation: {
      proposalOnly: !executionEnabled,
      approvalApi: executionEnabled,
      workerReady,
      repositoryWrite: executionEnabled && workerReady,
      build: executionEnabled && workerReady,
      publish: executionEnabled && workerReady,
      deploy: executionEnabled && workerReady,
    },
  };
}

function dialogueProjection(deployment) {
  const spec = deployment?.spec || {};
  const status = deployment?.status || {};
  const annotations = spec.template?.metadata?.annotations || {};
  const mode = DIALOGUE_MODES.has(annotations['opensphere.io/osdst-mode'])
    ? annotations['opensphere.io/osdst-mode'] : 'off';
  const desiredReplicas = Number(spec.replicas || 0);
  const generation = Number(deployment?.metadata?.generation || 0);
  const observedGeneration = Number(status.observedGeneration || 0);
  const updatedReplicas = Number(status.updatedReplicas || 0);
  const readyReplicas = Number(status.readyReplicas || 0);
  return {
    mode,
    source: annotations['opensphere.io/osdst-mode'] ? 'deployment-annotation' : 'safe-default',
    rollout: {
      ready: observedGeneration >= generation && updatedReplicas === desiredReplicas && readyReplicas === desiredReplicas,
      generation, observedGeneration, desiredReplicas, updatedReplicas, readyReplicas,
    },
    updatedAt: String(deployment?.metadata?.annotations?.['opensphere.io/osdst-updated-at'] || ''),
    updatedBy: String(deployment?.metadata?.annotations?.['opensphere.io/osdst-updated-by'] || ''),
  };
}

function safeValidationMessage(value) {
  return String(value || '')
    .replace(/\b(?:sk|rk|pk|ghp|glpat)-[A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 240);
}

async function boundedJson(response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES) {
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('provider response exceeded the bounded response size');
      }
      chunks.push(Buffer.from(value));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('provider response exceeded the bounded response size');
  return text ? JSON.parse(text) : {};
}

function providerBase(meta, allowedOrigins) {
  const defaultBase = meta.provider === 'openai' ? 'https://api.openai.com/v1'
    : meta.provider === 'deepseek' ? 'https://api.deepseek.com' : '';
  const raw = String(meta.baseUrl || defaultBase).replace(/\/+$/, '');
  let url;
  try { url = new URL(raw); } catch { fail(400, 'LLM provider base URL is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    fail(400, 'LLM provider base URL must be an HTTPS URL without credentials, query, or fragment');
  }
  if (!allowedOrigins.has(url.origin)) fail(503, 'LLM provider origin is not in the C_AI egress allowlist', 'provider_origin_not_allowed');
  return raw;
}

async function probeProviderCredential(meta, apiKey, { fetchImpl, allowedOrigins, embeddingDim, timeoutSignal }) {
  const validatedAt = new Date().toISOString();
  if (!meta.enabled) return { status: 'disabled', message: 'Key is disabled.', validatedAt, latencyMs: 0 };
  if (!apiKey) return { status: 'invalid', message: 'Secret has no API key material.', validatedAt, latencyMs: 0 };
  if (!['openai', 'deepseek', 'custom'].includes(meta.provider)) {
    return { status: 'unsupported', message: `Gateway connector validation is not implemented for ${meta.provider}.`, validatedAt, latencyMs: 0 };
  }
  let base;
  try { base = providerBase(meta, allowedOrigins); }
  catch (error) {
    if (error?.code === 503) throw error;
    return { status: 'invalid-config', message: error.msg || error.message || 'Base URL is invalid.', validatedAt, latencyMs: 0 };
  }
  const started = Date.now();
  try {
    const modelsResponse = await fetchImpl(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      redirect: 'error', signal: timeoutSignal(10000),
    });
    const modelsBody = await boundedJson(modelsResponse);
    const latencyMs = Date.now() - started;
    if (modelsResponse.status === 401 || modelsResponse.status === 403) {
      return { status: 'invalid', message: 'Provider rejected the credential.', validatedAt, latencyMs };
    }
    if (!modelsResponse.ok) {
      const detail = safeValidationMessage(modelsBody?.error?.message || modelsBody?.message || `Provider HTTP ${modelsResponse.status}`);
      return { status: modelsResponse.status === 429 ? 'degraded' : 'provider-error', message: detail, validatedAt, latencyMs };
    }
    const modelIds = Array.isArray(modelsBody?.data)
      ? modelsBody.data.slice(0, 10000).map((item) => String(item?.id || '')).filter((id) => id.length <= 160 && id)
      : [];
    if (meta.defaultModel && modelIds.length && !modelIds.includes(meta.defaultModel)) {
      return { status: 'model-missing', message: `Credential is valid, but model ${meta.defaultModel} was not advertised by the provider.`, validatedAt, latencyMs };
    }
    const probeEmbedding = meta.embeddingModel && (meta.provider === 'openai' || meta.provider === 'custom');
    if (probeEmbedding) {
      const request = { model: meta.embeddingModel, input: 'OpenSphere embedding readiness probe' };
      if (meta.provider === 'openai' || /text-embedding-3/i.test(meta.embeddingModel)) request.dimensions = embeddingDim;
      const embeddingResponse = await fetchImpl(`${base}/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(request), redirect: 'error', signal: timeoutSignal(15000),
      });
      const embeddingBody = await boundedJson(embeddingResponse);
      const embeddingLatencyMs = Date.now() - started;
      if (!embeddingResponse.ok) {
        const detail = safeValidationMessage(embeddingBody?.error?.message || embeddingBody?.message || `HTTP ${embeddingResponse.status}`);
        return { status: 'embedding-unavailable', message: `Chat credential is valid, but embedding model ${meta.embeddingModel} is unavailable (${detail}).`, validatedAt, latencyMs: embeddingLatencyMs };
      }
      const vector = embeddingBody?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== embeddingDim || vector.some((value) => !Number.isFinite(Number(value)))) {
        return { status: 'embedding-invalid', message: `Embedding model ${meta.embeddingModel} returned an invalid vector dimension; expected ${embeddingDim}.`, validatedAt, latencyMs: embeddingLatencyMs };
      }
      return { status: 'ready', message: `Chat and embedding access verified (${vector.length} dimensions).`, validatedAt, latencyMs: embeddingLatencyMs };
    }
    return { status: 'ready', message: 'Provider credential and chat model access verified.', validatedAt, latencyMs };
  } catch (error) {
    return {
      status: 'unreachable',
      message: safeValidationMessage(error?.name === 'TimeoutError' ? 'Provider validation timed out.' : 'Provider could not be reached.'),
      validatedAt,
      latencyMs: Date.now() - started,
    };
  }
}

function keyMeta(secret) {
  const a = secret?.metadata?.annotations || {};
  return {
    id: a['opensphere.io/osaa-key-id'] || String(secret?.metadata?.name || '').replace(/^osaa-llm-/, ''),
    provider: a['opensphere.io/osaa-provider'] || '',
    displayName: a['opensphere.io/osaa-display-name'] || '',
    baseUrl: a['opensphere.io/osaa-base-url'] || '',
    defaultModel: a['opensphere.io/osaa-default-model'] || '',
    embeddingModel: a['opensphere.io/osaa-embedding-model'] || '',
    validationStatus: a['opensphere.io/osaa-validation-status'] || 'untested',
    validationMessage: a['opensphere.io/osaa-validation-message'] || '',
    validatedAt: a['opensphere.io/osaa-validated-at'] || '',
    enabled: a['opensphere.io/osaa-enabled'] !== 'false',
    keyFingerprint: a['opensphere.io/osaa-key-fingerprint'] || '',
    secretRef: secret?.metadata?.name || '',
    updatedAt: a['opensphere.io/osaa-updated-at'] || secret?.metadata?.creationTimestamp || '',
    updatedBy: a['opensphere.io/osaa-updated-by'] || '',
  };
}

function dbFailure(error) {
  const message = String(error?.message || error || '');
  if (/not found/i.test(message)) fail(404, 'requested C_AI ledger record was not found');
  if (/confirmation/i.test(message)) fail(400, 'approval confirmation does not match the current binding');
  if (/not awaiting|independent|deadline|expired|changed|different|lost/i.test(message)) fail(409, 'C_AI ledger state changed; reload before retrying');
  fail(503, 'C_AI Supabase owner store is unavailable', 'c_ai_owner_store_unavailable');
}

function createCAiOwnerApi({
  getPool,
  k8s,
  osdstStatus,
  auditMutation,
  fetchImpl = globalThis.fetch,
  timeoutSignal = (ms) => AbortSignal.timeout(ms),
  namespace = 'opensphere-console',
  keyNamespace = 'opensphere-osaa-credentials',
  dialogueDeployment = 'opensphere-osdst',
  repairRepository = CANONICAL_REPAIR_REPOSITORY,
  durableOperationsEnabled = false,
  remediationProposalEnabled = false,
  remediationExecutionEnabled = false,
  embeddingDim = 1536,
  providerAllowedOrigins = ['https://api.openai.com', 'https://api.deepseek.com'],
} = {}) {
  if (typeof getPool !== 'function' || typeof k8s !== 'function' || typeof osdstStatus !== 'function'
      || typeof auditMutation !== 'function' || typeof fetchImpl !== 'function') {
    throw new TypeError('C_AI owner API dependencies are incomplete');
  }
  const allowedOrigins = new Set(providerAllowedOrigins.map((origin) => {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
      throw new TypeError('C_AI provider allowlist entries must be credential-free HTTPS origins');
    }
    return parsed.origin;
  }));
  const deploymentPath = `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(dialogueDeployment)}`;

  function pool() {
    const value = getPool();
    if (!value) fail(503, 'C_AI Supabase owner store is not configured', 'c_ai_owner_store_unavailable');
    return value;
  }

  async function rpc(name, params = []) {
    try {
      const placeholders = params.map((_, index) => `$${index + 1}`).join(',');
      const result = await pool().query(`SELECT osaa.${name}(${placeholders}) AS value`, params);
      return result.rows?.[0]?.value ?? null;
    } catch (error) { return dbFailure(error); }
  }

  async function getDialogueState() {
    const [deployment, runtime] = await Promise.all([
      k8s('GET', deploymentPath),
      osdstStatus().catch((error) => ({ service: 'opensphere-osdst', ready: false, error: String(error?.msg || error?.message || error) })),
    ]);
    if (!deployment.ok) fail(502, `OSDST deployment unavailable (Kubernetes HTTP ${deployment.status})`);
    const exactImage = String(deployment.json?.spec?.template?.spec?.containers?.find((item) => item.name === 'osdst')?.image || '');
    return { ...dialogueProjection(deployment.json), runtime: { ...runtime, exactImage } };
  }

  async function setDialogueState(actor, input) {
    const body = closedObject(input, ['mode', 'reason'], 'Dialogue State settings');
    const mode = String(body.mode || '').trim().toLowerCase();
    const reason = String(body.reason || '').trim();
    if (!DIALOGUE_MODES.has(mode)) fail(400, 'unsupported OSDST mode');
    if (reason.length < 8 || reason.length > 500) fail(400, 'management reason must be 8 to 500 characters');
    requireAal2Actor(actor, 'Dialogue State change');
    const current = await getDialogueState();
    if (current.mode === mode && current.rollout.ready) return { changed: false, ...current };
    const requestId = randomUUID();
    const payloadDigest = digest({ from: current.mode, to: mode });
    await auditMutation(actor, {
      action: 'osaa-dialogue-state-mode-change', target: dialogueDeployment, result: 'attempt', reason,
      requestId, phase: 'intent', targetType: 'osaa-dialogue-state-policy', payloadDigest,
    });
    const updatedAt = new Date().toISOString();
    const updatedBy = String(actor?.username || actor?.subject || '').slice(0, 200);
    const patched = await k8s('PATCH', deploymentPath, {
      metadata: { annotations: {
        'opensphere.io/osdst-updated-at': updatedAt,
        'opensphere.io/osdst-updated-by': updatedBy,
        'opensphere.io/osdst-change-reason': reason,
        'opensphere.io/osdst-request-id': requestId,
      } },
      spec: { template: { metadata: { annotations: { 'opensphere.io/osdst-mode': mode } } } },
    });
    if (!patched.ok) {
      await auditMutation(actor, {
        action: 'osaa-dialogue-state-mode-change', target: dialogueDeployment, result: 'failed', reason,
        requestId, phase: 'failed', targetType: 'osaa-dialogue-state-policy', payloadDigest,
      }).catch(() => undefined);
      fail(502, `OSDST mode apply failed (Kubernetes HTTP ${patched.status})`);
    }
    await auditMutation(actor, {
      action: 'osaa-dialogue-state-mode-change', target: dialogueDeployment, result: 'ok', reason,
      requestId, phase: 'applied', targetType: 'osaa-dialogue-state-policy', payloadDigest,
    });
    return { changed: true, requestId, ...dialogueProjection(patched.json) };
  }

  async function listOperations(limit) {
    const rows = await rpc('c_ai_list_module_operations', [boundedLimit(limit, 50)]);
    if (!Array.isArray(rows)) fail(503, 'C_AI operation projection is invalid', 'c_ai_owner_projection_invalid');
    return { operations: rows.map(publicOperation) };
  }

  async function operationDetails(operationId) {
    const id = requireUuid(operationId, 'operationId');
    const value = await rpc('c_ai_get_module_operation', [id]);
    if (!value?.operation) fail(404, 'operation not found');
    return {
      ...publicOperation(value.operation),
      steps: Array.isArray(value.steps) ? value.steps.map(publicStep) : [],
      approvals: Array.isArray(value.approvals) ? value.approvals.map(publicApproval) : [],
    };
  }

  async function approveOperation(actor, operationId, input) {
    if (!durableOperationsEnabled) fail(503, 'R2D2 durable operation approval is not activated', 'durable_operation_approval_disabled');
    const body = closedObject(input, ['confirmation'], 'operation approval');
    const id = requireUuid(operationId, 'operationId');
    const coordinates = requireAal2Actor(actor, 'operation approval');
    const value = await rpc('c_ai_get_module_operation', [id]);
    const operation = value?.operation;
    if (!operation) fail(404, 'operation not found');
    if (field(operation, 'action') === 'engineering-remediation') fail(409, 'Engineering Remediation uses its separately bound source approval');
    const risk = field(operation, 'requested_risk_class', 'requestedRiskClass') || field(operation, 'risk_class', 'riskClass');
    if (['R2', 'R3'].includes(risk) && coordinates.subject === String(field(operation, 'actor_id', 'actorId') || '')) {
      fail(409, 'R2/R3 operation requires an independent approver');
    }
    const descriptorDigest = String(field(operation, 'descriptor_digest', 'descriptorDigest') || '');
    if (!SHA256.test(descriptorDigest)) fail(409, 'operation has no exact descriptor binding');
    const confirmation = String(body.confirmation || '');
    const expected = `approve R2D2 operation ${id} ${descriptorDigest}`;
    if (confirmation !== expected) fail(400, `confirmation required: ${expected}`);
    const approvalDigest = digest({ operationId: id, approverId: coordinates.subject, descriptorDigest, confirmation });
    const result = await rpc('c_ai_approve_module_operation', [
      id, coordinates.subject, coordinates.sessionId, coordinates.authzRevision, confirmation, approvalDigest,
    ]);
    if (!result || result.operationId !== id) fail(503, 'operation approval was not durably persisted', 'c_ai_owner_persistence_failed');
    return result;
  }

  async function remediationStatus() {
    const store = await rpc('c_ai_engineering_remediation_status', [repairRepository]);
    const workerReady = store?.workerReady === true;
    const ready = remediationExecutionEnabled && workerReady;
    return {
      schema: 'osaa-engineering-remediation-status.opensphere.io/v1alpha1',
      proposalEnabled: remediationProposalEnabled,
      executionEnabled: remediationExecutionEnabled,
      workerReady: ready,
      repositories: [repairRepository],
      approvalMode: remediationExecutionEnabled ? 'local-edge-supervised' : 'disabled',
      capabilities: {
        diagnose: true,
        propose: remediationProposalEnabled,
        approveExactWorkUnit: remediationExecutionEnabled,
        repositoryWrite: ready,
        componentBuild: ready,
        exactDigestDeploy: ready,
        browserVerification: ready,
        rollback: ready,
      },
    };
  }

  async function listRemediations(limit) {
    const [rows, status] = await Promise.all([
      rpc('c_ai_list_engineering_remediations', [boundedLimit(limit)]), remediationStatus(),
    ]);
    if (!Array.isArray(rows)) fail(503, 'C_AI remediation projection is invalid', 'c_ai_owner_projection_invalid');
    return {
      schema: 'osaa-engineering-remediation-list.opensphere.io/v1alpha1',
      remediations: rows.map((row) => publicRemediation(row, status.executionEnabled, status.workerReady)),
    };
  }

  async function remediationDetails(remediationRequestId) {
    const id = requireUuid(remediationRequestId, 'remediationRequestId');
    const [value, status] = await Promise.all([
      rpc('c_ai_get_engineering_remediation', [id]), remediationStatus(),
    ]);
    if (!value?.request) fail(404, 'Engineering Remediation request not found');
    const request = { ...value.request, changed_paths: value.changedPaths || [] };
    const build = value.latestBuild || null;
    const requiredConfirmation = field(request, 'stage') === 'proposed' || field(request, 'stage') === 'awaiting_approval'
      ? `approve R2D2 source patch ${id} ${field(request, 'approval_binding_digest', 'approvalBindingDigest')}` : null;
    return {
      ...publicRemediation(request, status.executionEnabled, status.workerReady),
      requiredConfirmation,
      latestBuild: build ? {
        sourceRevision: field(build, 'source_revision', 'sourceRevision'),
        patchDigest: field(build, 'patch_digest', 'patchDigest'),
        buildAuthority: field(build, 'build_authority', 'buildAuthority'),
        imageDigests: field(build, 'image_digests', 'imageDigests') || [],
        releaseLockDigest: field(build, 'release_lock_digest', 'releaseLockDigest'),
      } : null,
    };
  }

  async function approveRemediationSource(actor, remediationRequestId, input) {
    if (!remediationExecutionEnabled) fail(503, 'R2D2 Engineering Remediation execution is not activated', 'engineering_remediation_execution_disabled');
    const body = closedObject(input, ['confirmation', 'approvalExpiresAt'], 'source approval');
    const id = requireUuid(remediationRequestId, 'remediationRequestId');
    const coordinates = requireAal2Actor(actor, 'Engineering Remediation source approval');
    const value = await rpc('c_ai_get_engineering_remediation', [id]);
    const request = value?.request;
    if (!request) fail(404, 'Engineering Remediation request not found');
    if (coordinates.subject === String(value.operationActorId || '')) fail(409, 'Engineering Remediation requires an independent approver');
    const bindingDigest = String(field(request, 'approval_binding_digest', 'approvalBindingDigest') || '');
    if (!SHA256.test(bindingDigest)) fail(409, 'Engineering Remediation has no exact source binding');
    const expected = `approve R2D2 source patch ${id} ${bindingDigest}`;
    const confirmation = String(body.confirmation || '');
    if (confirmation !== expected) fail(400, `confirmation required: ${expected}`);
    const requestExpiry = Date.parse(field(request, 'approval_expires_at', 'approvalExpiresAt') || '');
    const requestedExpiry = body.approvalExpiresAt ? Date.parse(body.approvalExpiresAt) : requestExpiry;
    if (!Number.isFinite(requestExpiry) || !Number.isFinite(requestedExpiry) || requestedExpiry <= Date.now()) {
      fail(400, 'approval expiry must be in the future');
    }
    const expiresAt = new Date(Math.min(requestExpiry, requestedExpiry)).toISOString();
    const approvalDigest = digest({
      remediationRequestId: id, scope: 'source_patch', approverId: coordinates.subject,
      bindingDigest, confirmation, expiresAt,
    });
    const persisted = await rpc('c_ai_approve_engineering_source', [
      id, coordinates.subject, coordinates.sessionId, coordinates.authzRevision,
      bindingDigest, approvalDigest, expiresAt,
    ]);
    if (!persisted) fail(503, 'Engineering Remediation approval was not durably persisted', 'c_ai_owner_persistence_failed');
    const status = await remediationStatus();
    return publicRemediation(persisted, status.executionEnabled, status.workerReady);
  }

  async function recordBrowserVerification(actor, remediationRequestId, input) {
    if (!remediationExecutionEnabled) fail(503, 'R2D2 Engineering Remediation execution is not activated', 'engineering_remediation_execution_disabled');
    const body = closedObject(input, [
      'verificationProfile', 'verificationRoute', 'observedSourceRevision', 'marker', 'markerPresent',
      'consoleErrorCount', 'networkFailureCount',
    ], 'browser verification');
    const id = requireUuid(remediationRequestId, 'remediationRequestId');
    const { subject } = requireAal2Actor(actor, 'Engineering Remediation browser verification');
    const value = await rpc('c_ai_get_engineering_remediation', [id]);
    const request = value?.request;
    if (!request) fail(404, 'Engineering Remediation request not found');
    if (subject !== String(field(request, 'operator_id', 'operatorId') || '')) fail(403, 'only the approving operator browser may verify this repair');
    if (field(request, 'stage') !== 'verifying') fail(409, 'repair is not awaiting browser verification');
    const profile = String(body.verificationProfile || '');
    const route = String(body.verificationRoute || '');
    const revision = String(body.observedSourceRevision || '');
    const marker = String(body.marker || '');
    const consoleErrors = Number(body.consoleErrorCount);
    const networkFailures = Number(body.networkFailureCount);
    if (profile !== field(request, 'verification_profile', 'verificationProfile')
        || route !== field(request, 'verification_route', 'verificationRoute')
        || marker !== BROWSER_MARKERS[profile]
        || !REVISION.test(revision)
        || revision !== String(field(value.latestBuild, 'source_revision', 'sourceRevision') || '')
        || !Number.isInteger(consoleErrors) || consoleErrors < 0 || consoleErrors > 10000
        || !Number.isInteger(networkFailures) || networkFailures < 0 || networkFailures > 10000
        || typeof body.markerPresent !== 'boolean') {
      fail(400, 'browser verification differs from the approved fixed profile or exact source revision');
    }
    const evidence = {
      remediationRequestId: id, operatorId: subject, verificationProfile: profile,
      verificationRoute: route, observedSourceRevision: revision, marker,
      markerPresent: body.markerPresent, consoleErrorCount: consoleErrors, networkFailureCount: networkFailures,
    };
    const passed = evidence.markerPresent && consoleErrors === 0 && networkFailures === 0;
    const evidenceDigest = digest({ ...evidence, passed });
    const persisted = await rpc('c_ai_record_engineering_browser_verification', [
      id, subject, profile, route, revision, marker, body.markerPresent,
      consoleErrors, networkFailures, passed, evidenceDigest,
    ]);
    if (!persisted) fail(503, 'browser verification was not durably persisted', 'c_ai_owner_persistence_failed');
    return {
      accepted: true,
      passed: persisted.passed === true,
      evidenceDigest: persisted.evidenceDigest || evidenceDigest,
      observedAt: persisted.observedAt || null,
    };
  }

  async function testLlmKey(actor, keyId, input = {}) {
    closedObject(input, [], 'LLM key validation');
    const id = String(keyId || '');
    if (!KEY_ID.test(id)) fail(400, 'invalid LLM key id');
    const secretPath = `/api/v1/namespaces/${encodeURIComponent(keyNamespace)}/secrets/${encodeURIComponent(`osaa-llm-${id}`)}`;
    const response = await k8s('GET', secretPath);
    if (response.status === 404) fail(404, 'llm key not found');
    if (!response.ok) fail(502, `credential Secret read failed (Kubernetes HTTP ${response.status})`);
    const secret = response.json;
    const meta = keyMeta(secret);
    if (secret?.metadata?.labels?.['opensphere.io/osaa-llm-key'] !== 'true'
        || secret?.metadata?.name !== `osaa-llm-${id}` || meta.id !== id) {
      fail(409, 'credential Secret does not match the exact C_AI key binding');
    }
    const resourceVersion = String(secret?.metadata?.resourceVersion || '');
    if (!resourceVersion || resourceVersion.length > 128 || /[\u0000-\u001f\u007f]/u.test(resourceVersion)) {
      fail(409, 'credential Secret has no stable Kubernetes resource version');
    }
    const apiKey = Buffer.from(String(secret?.data?.api_key || ''), 'base64').toString('utf8');
    const reason = 'Operator requested provider credential validation';
    const requestId = randomUUID();
    const payloadDigest = digest({
      id, provider: meta.provider, baseUrl: meta.baseUrl, defaultModel: meta.defaultModel,
      embeddingModel: meta.embeddingModel, resourceVersion,
    });
    await auditMutation(actor, {
      action: 'osaa-llm-key-validate', target: id, result: 'attempt', reason,
      requestId, phase: 'intent', targetType: 'osaa-llm-credential', payloadDigest,
    });
    let validation;
    try {
      validation = await probeProviderCredential(meta, apiKey, {
        fetchImpl, allowedOrigins, embeddingDim, timeoutSignal,
      });
    } catch (error) {
      await auditMutation(actor, {
        action: 'osaa-llm-key-validate', target: id, result: 'failed', reason,
        requestId, phase: 'failed', targetType: 'osaa-llm-credential', payloadDigest,
      }).catch(() => undefined);
      throw error;
    }
    const validationAnnotations = {
      'opensphere.io/osaa-validation-status': validation.status,
      'opensphere.io/osaa-validation-message': safeValidationMessage(validation.message),
      'opensphere.io/osaa-validated-at': validation.validatedAt,
      'opensphere.io/osaa-validation-latency-ms': String(validation.latencyMs || 0),
    };
    const patched = await k8s('PATCH', secretPath, { metadata: { resourceVersion, annotations: validationAnnotations } });
    if (!patched.ok) {
      await auditMutation(actor, {
        action: 'osaa-llm-key-validate', target: id, result: 'failed', reason,
        requestId, phase: 'failed', targetType: 'osaa-llm-credential', payloadDigest,
      }).catch(() => undefined);
      fail(502, `credential validation state write failed (Kubernetes HTTP ${patched.status})`);
    }
    await auditMutation(actor, {
      action: 'osaa-llm-key-validate', target: id, result: validation.status, reason,
      requestId, phase: 'applied', targetType: 'osaa-llm-credential', payloadDigest,
    });
    const projected = {
      ...secret,
      metadata: { ...secret.metadata, annotations: { ...(secret.metadata?.annotations || {}), ...validationAnnotations } },
    };
    return { validation, item: keyMeta(projected), auditRecorded: true };
  }

  return {
    getDialogueState, setDialogueState,
    listOperations, operationDetails, approveOperation,
    remediationStatus, listRemediations, remediationDetails,
    approveRemediationSource, recordBrowserVerification,
    testLlmKey,
  };
}

module.exports = {
  createCAiOwnerApi,
  publicOperation,
  publicRemediation,
  dialogueProjection,
  probeProviderCredential,
  digest,
};
