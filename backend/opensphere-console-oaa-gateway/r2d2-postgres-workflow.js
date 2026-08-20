'use strict';

const TERMINAL_FAILURES = new Set([
  'Failed', 'VerificationFailed', 'AuthorizationExpired', 'PreflightBlocked', 'Cancelled', 'TimedOut', 'RolledBack',
]);

// This is intentionally a coverage denominator, not a second capability
// registry. PFSS remains the only owner that can make a row available by
// advertising the required closed Owner API action. Keeping unavailable rows
// here makes an omission visible to a natural-language client without giving
// it a fallback (CLI, kubectl, SQL, or a guessed HTTP route).
const POSTGRES_LIFECYCLE_MATRIX = Object.freeze([
  Object.freeze({ id: 'capability.read', requestType: 'Instance', ownerAction: 'capability.read', ownerToolId: 'foundation.capabilities', r2d2Tool: 'oaa.foundation.postgres.capabilities', cliCommand: 'os foundation capabilities', riskClass: 'R0', lifecycle: ['discovery'] }),
  Object.freeze({ id: 'readiness.read', requestType: 'Instance', ownerAction: 'readiness.read', ownerToolId: 'foundation.readiness', r2d2Tool: 'oaa.foundation.postgres.readiness', cliCommand: 'os foundation readiness', riskClass: 'R0', lifecycle: ['health'] }),
  Object.freeze({ id: 'catalog.read', requestType: 'Instance', ownerAction: 'catalog.read', ownerToolId: 'foundation.postgres.catalog', r2d2Tool: 'oaa.foundation.postgres.catalog', cliCommand: 'os foundation postgres catalog', riskClass: 'R0', lifecycle: ['catalog'] }),
  Object.freeze({ id: 'cluster.plan', requestType: 'Instance', ownerAction: 'cluster.plan', ownerToolId: 'foundation.postgres.plan.create', r2d2Tool: 'oaa.foundation.postgres.plan', cliCommand: 'os foundation postgres plan create', riskClass: 'R2', lifecycle: ['create.plan', 'create.validate'] }),
  Object.freeze({ id: 'cluster.create', requestType: 'Instance', ownerAction: 'cluster.create', ownerToolId: 'foundation.postgres.apply', r2d2Tool: 'oaa.foundation.postgres.claim.create', cliCommand: 'os foundation postgres apply <planId>', riskClass: 'R2', lifecycle: ['create.approval', 'create.apply'], ownerRoute: '/api/foundation/oaa/postgres/durable-apply/{planId}' }),
  Object.freeze({ id: 'cluster.status', requestType: 'Instance', ownerAction: 'cluster.status', ownerToolId: 'foundation.postgres.status', r2d2Tool: 'oaa.foundation.postgres.status', cliCommand: 'os foundation postgres status <namespace> <name>', riskClass: 'R0', lifecycle: ['status'] }),
  Object.freeze({ id: 'operation.watch', requestType: 'Instance', ownerAction: 'operation.watch', ownerToolId: 'foundation.operation.watch', r2d2Tool: 'oaa.foundation.postgres.operation.watch', cliCommand: 'os foundation operation watch <operationId>', riskClass: 'R0', lifecycle: ['postcondition', 'receipt.history'] }),
  Object.freeze({ id: 'database', requestType: 'Database', ownerAction: null, ownerToolId: null, r2d2Tool: null, cliCommand: null, riskClass: 'R2', lifecycle: ['database.plan', 'database.apply', 'database.status'], proposed: true }),
  Object.freeze({ id: 'access', requestType: 'Access', ownerAction: null, ownerToolId: null, r2d2Tool: null, cliCommand: null, riskClass: 'R2', lifecycle: ['access.plan', 'access.apply', 'access.status'], proposed: true }),
  Object.freeze({ id: 'update', requestType: 'Instance', ownerAction: null, ownerToolId: null, r2d2Tool: null, cliCommand: null, riskClass: 'R2', lifecycle: ['update.plan', 'update.apply'], proposed: true }),
  Object.freeze({ id: 'delete', requestType: 'Instance', ownerAction: null, ownerToolId: null, r2d2Tool: null, cliCommand: null, riskClass: 'R3', lifecycle: ['delete.plan', 'delete.apply'], proposed: true }),
  Object.freeze({ id: 'cancel', requestType: 'Instance', ownerAction: null, ownerToolId: null, r2d2Tool: null, cliCommand: null, riskClass: 'R2', lifecycle: ['cancel'], proposed: true }),
  Object.freeze({ id: 'rollback', requestType: 'Instance', ownerAction: null, ownerToolId: null, r2d2Tool: null, cliCommand: null, riskClass: 'R3', lifecycle: ['rollback'], proposed: true }),
]);

function operationRisk(capabilities, actionId) {
  const action = Array.isArray(capabilities?.actions)
    ? capabilities.actions.find((item) => item && String(item.actionId) === actionId)
    : null;
  return action ? String(action.riskClass || '') : null;
}

function lifecycleCoverage(capabilities) {
  const operations = new Set([
    ...(Array.isArray(capabilities?.operations) ? capabilities.operations.map(String) : []),
    ...(Array.isArray(capabilities?.actions) ? capabilities.actions.map((item) => String(item?.actionId || '')).filter(Boolean) : []),
  ]);
  const requestTypes = new Set(Array.isArray(capabilities?.supportedRequestTypes)
    ? capabilities.supportedRequestTypes.map(String)
    : []);
  return POSTGRES_LIFECYCLE_MATRIX.map((entry) => {
    const requestTypePublished = requestTypes.size === 0 || requestTypes.has(entry.requestType);
    const published = entry.proposed !== true && requestTypePublished && operations.has(entry.ownerAction);
    const advertisedRisk = operationRisk(capabilities, entry.ownerAction);
    // An older Owner projection may not include action detail.  Once it does,
    // an R0/R1 advertisement may never lower this matrix's canonical risk.
    const riskMismatch = advertisedRisk !== null && advertisedRisk !== entry.riskClass;
    const available = published && !riskMismatch;
    return {
      ...entry,
      available,
      supportState: available ? 'owner-facade' : 'unavailable',
      ...(available ? {} : {
        blocker: {
          code: riskMismatch ? 'POSTGRES_OWNER_RISK_MISMATCH' : 'POSTGRES_OWNER_OPERATION_UNAVAILABLE',
          message: riskMismatch
            ? `PFSS advertises ${entry.ownerAction} as ${advertisedRisk || 'unknown'}, not canonical ${entry.riskClass}.`
            : entry.proposed === true
              ? `PFSS has not published a typed ${entry.id} lifecycle operation.`
              : `PFSS does not publish the typed ${entry.ownerAction} operation.`,
        },
      }),
    };
  });
}

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
    lifecycle: lifecycleCoverage(capabilities),
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
    || identity?.requestType !== 'Instance'
    || identity?.actionId !== 'cluster.create'
    || identity?.toolId !== 'foundation.postgres.apply') reasons.push('semantic_identity_mismatch');
  const binding = receiptObject?.actionBinding;
  if (binding?.method !== 'POST'
    || binding?.path !== '/api/foundation/oaa/postgres/durable-apply/{planId}'
    || !Array.isArray(binding?.pathParams)
    || binding.pathParams.length !== 1
    || binding.pathParams[0] !== 'planId'
    || binding?.approval !== 'exact-confirmation') reasons.push('action_binding_mismatch');
  const evidenceRevision = String(completion?.evidenceRevision || '').trim();
  if (completion?.stale !== false) reasons.push('completion_stale_or_missing');
  if (!evidenceRevision
    || String(receiptObject?.ownerEvidenceRevision || '').trim() !== evidenceRevision) reasons.push('evidence_revision_mismatch');
  return { valid: reasons.length === 0, receipt: receiptObject, reasons };
}

function canonicalCreateEvidence(operation, receipt) {
  const planId = String(operation?.planId || '').trim();
  const planDigest = String(operation?.planDigest || '').trim();
  const actionDigest = String(operation?.actionDigest || operation?.descriptorDigest || '').trim();
  return {
    semanticIdentity: receipt?.semanticIdentity || null,
    actionBinding: receipt?.actionBinding || null,
    ...(planId ? { planId } : {}),
    ...(planDigest ? { planDigest } : {}),
    ...(actionDigest ? { actionDigest } : {}),
  };
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
    ownerEvidence: canonicalCreateEvidence(operation, receipt),
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

module.exports = {
  POSTGRES_LIFECYCLE_MATRIX, capabilityAvailability, completionReceiptValidation,
  canonicalCreateEvidence, lifecycleCoverage, readinessDecision, operationWorkflow,
};
