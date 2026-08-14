'use strict';

const TERMINAL_FAILURES = new Set([
  'Failed', 'VerificationFailed', 'AuthorizationExpired', 'PreflightBlocked', 'Cancelled', 'TimedOut', 'RolledBack',
]);

function nextActionFromBlocker(blocker, fallback) {
  const remediation = blocker?.remediation || {};
  return {
    owner: String(remediation.owner || fallback.owner || 'PFSS'),
    action: String(remediation.action || fallback.action || 'Restore PFSS PostgreSQL owner readiness'),
    automatic: remediation.automatic === true,
  };
}

function capabilityAvailability(capabilities) {
  const operations = new Set(Array.isArray(capabilities?.operations) ? capabilities.operations.map(String) : []);
  const area = (name, supported) => supported
    ? { available: true, blocker: null, nextAction: null }
    : {
      available: false,
      blocker: { code: `POSTGRES_${name.toUpperCase()}_CAPABILITY_NOT_AVAILABLE`, message: `PFSS owner does not publish a typed ${name} operation.` },
      nextAction: { owner: 'PFSS', action: `Publish the typed ${name} Owner API operation and R2D2 descriptor`, automatic: false },
    };
  return {
    database: area('database', ['database.plan', 'database.create'].some((id) => operations.has(id))),
    access: area('access', ['access.plan', 'access.create', 'credential.create'].some((id) => operations.has(id))),
    day2: area('day2', [...operations].some((id) => /^(?:cluster\.(?:scale|upgrade|failover)|extension\.|backup\.|restore\.)/.test(id))),
  };
}

function readinessDecision(readiness, capabilities, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const maxAgeMs = Math.max(1000, Number(options.maxAgeMs || 60000));
  const fallback = { owner: 'PFSS', action: 'Refresh the data.sql.postgres owner contract' };
  if (!capabilities || capabilities.capability !== 'data.sql.postgres' || !Array.isArray(capabilities.operations)) {
    return { readyToPlan: false, readyToExecute: false, stale: true,
      blocker: { code: 'POSTGRES_CAPABILITIES_MISSING', message: 'PFSS PostgreSQL capabilities are missing or invalid.' },
      nextAction: nextActionFromBlocker(null, fallback) };
  }
  if (!capabilities.operations.includes('cluster.plan') || !capabilities.operations.includes('operation.watch')) {
    return { readyToPlan: false, readyToExecute: false, stale: false,
      blocker: { code: 'POSTGRES_CAPABILITY_NOT_AVAILABLE', message: 'PFSS owner does not publish cluster.plan and operation.watch.' },
      nextAction: { owner: 'PFSS', action: 'Publish the missing typed owner operations', automatic: false } };
  }
  if (!readiness || readiness.capability !== 'data.sql.postgres') {
    return { readyToPlan: false, readyToExecute: false, stale: true,
      blocker: { code: 'POSTGRES_READINESS_MISSING', message: 'PFSS PostgreSQL readiness evidence is missing.' },
      nextAction: nextActionFromBlocker(null, fallback) };
  }
  const explicitlyStale = readiness.stale === true
    || readiness.staleness?.stale === true
    || (Array.isArray(readiness.evidence) && readiness.evidence.some((item) => item?.stale === true));
  const observedMs = Date.parse(readiness.observedAt || '');
  if (explicitlyStale || !Number.isFinite(observedMs) || observedMs > nowMs + 5000 || nowMs - observedMs > maxAgeMs) {
    return { readyToPlan: false, readyToExecute: false, stale: true, observedAt: readiness.observedAt || null,
      blocker: { code: 'POSTGRES_READINESS_STALE', message: 'PFSS PostgreSQL readiness evidence is stale or has no trustworthy timestamp.' },
      nextAction: { owner: 'PFSS', action: 'Refresh authoritative readiness and retry', automatic: false } };
  }
  if (!String(readiness.evidenceRevision || '').trim() || !String(readiness.sourceRevision || '').trim()) {
    return { readyToPlan: false, readyToExecute: false, stale: false, observedAt: readiness.observedAt,
      blocker: { code: 'POSTGRES_READINESS_PROVENANCE_MISSING', message: 'PFSS PostgreSQL readiness is missing evidenceRevision or sourceRevision provenance.' },
      nextAction: { owner: 'PFSS', action: 'Publish a complete v1 readiness envelope with evidence and owner source revisions', automatic: false } };
  }
  const blocker = Array.isArray(readiness.blockers) ? readiness.blockers[0] : null;
  if (readiness.readyToPlan !== true) {
    return { readyToPlan: false, readyToExecute: false, stale: false, observedAt: readiness.observedAt,
      blocker: blocker || { code: 'POSTGRES_NOT_READY_TO_PLAN', message: 'PFSS PostgreSQL is not ready to plan.' },
      nextAction: nextActionFromBlocker(blocker, fallback) };
  }
  return {
    readyToPlan: true, readyToExecute: readiness.readyToExecute === true, stale: false,
    state: String(readiness.state || (readiness.readyToExecute ? 'Ready' : 'Blocked')),
    observedAt: readiness.observedAt, blocker: readiness.readyToExecute ? null : blocker,
    nextAction: readiness.readyToExecute ? null : nextActionFromBlocker(blocker, fallback),
  };
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function completionReceiptValidation(operation, completion) {
  const receipt = completion?.receipt;
  const reasons = [];
  const receiptObject = receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : null;
  if (!receiptObject || Object.keys(receiptObject).length === 0) reasons.push('receipt_object_missing');
  const operationId = String(operation?.operationId || '').trim();
  if (!operationId || String(receiptObject?.operationId || '').trim() !== operationId) reasons.push('operation_id_mismatch');
  if (!String(receiptObject?.verifierId || '').trim()) reasons.push('verifier_id_missing');
  if (String(operation?.verificationState || '') !== 'succeeded'
    || String(receiptObject?.verificationState || '') !== 'succeeded') reasons.push('verification_not_succeeded');
  if (!validIsoTimestamp(receiptObject?.verifiedAt)) reasons.push('verified_at_invalid');
  const identity = receiptObject?.semanticIdentity;
  if (identity?.capabilityId !== 'data.sql.postgres'
    || identity?.actionId !== 'cluster.create'
    || identity?.toolId !== 'foundation.postgres.apply') reasons.push('semantic_identity_mismatch');
  const binding = receiptObject?.actionBinding;
  if (binding?.method !== 'POST'
    || binding?.path !== '/api/foundation/oaa/postgres/durable-apply/{planId}') reasons.push('action_binding_mismatch');
  const evidenceRevision = String(completion?.evidenceRevision || '').trim();
  if (completion?.stale !== false) reasons.push('completion_stale_or_missing');
  if (!evidenceRevision
    || String(receiptObject?.ownerEvidenceRevision || '').trim() !== evidenceRevision) reasons.push('evidence_revision_mismatch');
  return { valid: reasons.length === 0, receipt: receiptObject, reasons };
}

function operationWorkflow(operation) {
  const phase = String(operation?.operationPhase || operation?.phase || 'Unknown');
  const stage = String(operation?.stage || phase || 'Unknown');
  const completion = operation?.completion && typeof operation.completion === 'object' ? operation.completion : null;
  const receiptValidation = completionReceiptValidation(operation, completion);
  const receipt = receiptValidation.receipt;
  const verificationState = String(operation?.verificationState || operation?.verification?.state || '').trim().toLowerCase();
  const verificationPending = ['pending', 'running', 'verifying'].includes(verificationState);
  const canonicallyComplete = completion?.terminal === true
    && completion?.success === true
    && completion?.verified === true
    && receiptValidation.valid
    && !verificationPending;
  if (canonicallyComplete) return {
    phase: 'Ready', terminal: true, success: true,
    verified: true, receipt,
    message: 'Canonical owner completion and its non-empty verified receipt prove that postconditions are satisfied.',
  };
  if (completion?.terminal === true && completion?.success === false) {
    return { phase: 'Failed', terminal: true, success: false, verified: completion?.verified === true,
      message: 'The canonical owner completion reports terminal failure.', receipt: receipt || null,
      blocker: { code: String(operation?.errorCode || 'POSTGRES_OPERATION_FAILED'), message: 'PFSS PostgreSQL operation failed.' },
      nextAction: 'Inspect the owner operation steps and follow its remediation before creating a new plan.' };
  }
  if (completion?.terminal === true || phase === 'Succeeded') {
    return { phase: 'Unknown', terminal: true, success: false, verified: false,
      message: 'A terminal or success-like state lacks canonical verified completion evidence and must not be reported as success.',
      blocker: { code: 'POSTGRES_COMPLETION_RECEIPT_UNVERIFIED', message: 'Canonical completion receipt identity or verification evidence is missing or inconsistent.',
        details: receiptValidation.reasons },
      nextAction: 'Reconcile the same operationId until the owner publishes completion.terminal/success/verified and a non-empty receipt.' };
  }
  if (TERMINAL_FAILURES.has(phase) || ['Failed', 'VerificationFailed'].includes(stage)) {
    return { phase: 'Failed', terminal: true, success: false,
      message: 'The owner reported a terminal failure.',
      blocker: { code: String(operation?.errorCode || stage || phase), message: 'PFSS PostgreSQL operation failed.' },
      nextAction: 'Inspect the owner operation steps and follow its remediation before creating a new plan.' };
  }
  if (['Inconclusive', 'Unknown'].includes(phase) || ['Inconclusive', 'Unknown'].includes(stage)) {
    return { phase: 'Unknown', terminal: true, success: false,
      message: 'Operation completion cannot be proven and must not be reported as success.',
      blocker: { code: 'POSTGRES_OPERATION_UNKNOWN', message: 'Operation completion cannot be proven.' },
      nextAction: 'Reconcile the same operationId through the owner; do not submit a duplicate mutation.' };
  }
  if (phase === 'AwaitingApproval') return {
    phase: 'AwaitingApproval', terminal: false, success: false,
    message: 'No mutation runs until an independent AAL2 administrator approves this exact operation.',
    nextAction: 'Collect the independent approval bound to this operationId and descriptor digest.',
  };
  if (['Queued', 'Claimed', 'Preflighting'].includes(phase) || stage === 'Accepted') return {
    phase: 'Accepted', terminal: false, success: false,
    message: 'The durable operation was accepted but completion has not been proven.',
    nextAction: 'Continue watching this operationId until an authoritative terminal receipt is available.',
  };
  return {
    phase: 'Reconciling', terminal: false, success: false,
    message: 'The owner is reconciling desired and observed state; this is not completion.',
    nextAction: 'Continue watching the same operationId.',
  };
}

module.exports = { capabilityAvailability, completionReceiptValidation, readinessDecision, operationWorkflow };
