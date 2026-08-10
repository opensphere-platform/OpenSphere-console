'use strict';

function capacityBudget(input) {
  const daily = Math.max(0, Number(input.eventsPerSecond || 0)) * 86400;
  const rawBytes = daily * Math.max(1, Number(input.averageRowBytes || 1)) * Math.max(1, Number(input.retentionDays || 1));
  const indexedBytes = Math.ceil(rawBytes * Math.max(1, Number(input.indexAmplification || 1.5)));
  return { dailyRows: Math.ceil(daily), retainedRows: Math.ceil(daily * input.retentionDays), rawBytes: Math.ceil(rawBytes), indexedBytes,
    withinBudget: indexedBytes <= Number(input.storageBudgetBytes || 0) };
}

function retentionDecision(input) {
  if (!input.export?.verifiedAt || !/^sha256:[0-9a-f]{64}$/.test(String(input.export?.objectDigest || ''))) return { allowed: false, code: 'ExportProofRequired' };
  if (input.legalHold === true) return { allowed: false, code: 'LegalHoldActive' };
  if (Number(input.incidentEvidenceReferences || 0) > 0) return { allowed: false, code: 'EvidenceReferenced' };
  if (Date.parse(input.rangeEnd) > Date.now() - Number(input.minimumRetentionDays || 30) * 86400000) return { allowed: false, code: 'MinimumRetentionNotElapsed' };
  return { allowed: true, code: 'PurgeEligible' };
}

function selfModel(input) {
  const blockers = [];
  if (!input.observerEnabled) blockers.push('observer_disabled');
  if (input.sourceLagging) blockers.push('source_lagging');
  if (!input.snapshotComplete) blockers.push('reconcile_incomplete');
  if (Number(input.coverage || 0) < 1) blockers.push('coverage_incomplete');
  if (!input.ownerAvailable) blockers.push('owner_unavailable');
  return {
    observerState: !input.observerEnabled ? 'disabled' : input.sourceLagging ? 'degraded' : input.leader ? 'leader' : 'standby',
    graphState: !input.observerEnabled ? 'disabled' : !input.snapshotComplete ? 'partial' : input.sourceLagging ? 'stale' : 'fresh',
    incidentState: !input.incidentEnabled ? 'disabled' : blockers.includes('reconcile_incomplete') ? 'degraded' : 'ready',
    operationState: !input.operationEnabled ? 'disabled' : input.ownerAvailable ? 'ready' : 'degraded',
    remediationState: !input.remediationEnabled ? 'disabled' : input.r3Available ? 'ready' : 'proposal-only',
    coverage: Number(input.coverage || 0), blockers,
  };
}

function sloEvaluation(samples, targets) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
  const p95 = percentile(0.95);
  return { count: sorted.length, p50: percentile(0.5), p95, max: sorted.at(-1) ?? null, pass: p95 != null && p95 <= targets.p95 };
}

function replayContinuity(before, after) {
  const duplicateIncidents = after.incidentFingerprints.length - new Set(after.incidentFingerprints).size;
  const duplicateOperations = after.operationIdempotencyKeys.length - new Set(after.operationIdempotencyKeys).size;
  const lostOpenIncidents = before.openIncidentIds.filter((id) => !after.incidentIds.includes(id));
  const lostOperations = before.operationIds.filter((id) => !after.operationIds.includes(id));
  return { pass: duplicateIncidents === 0 && duplicateOperations === 0 && lostOpenIncidents.length === 0 && lostOperations.length === 0,
    duplicateIncidents, duplicateOperations, lostOpenIncidents, lostOperations };
}

module.exports = { capacityBudget, retentionDecision, selfModel, sloEvaluation, replayContinuity };
