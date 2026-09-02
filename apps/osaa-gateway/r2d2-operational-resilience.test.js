'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { capacityBudget, retentionDecision, selfModel, sloEvaluation, replayContinuity } = require('./r2d2-operational-resilience');

test('30-day equivalent capacity includes index amplification and fails above budget', () => {
  const out = capacityBudget({ eventsPerSecond: 10, averageRowBytes: 500, retentionDays: 30, indexAmplification: 1.8, storageBudgetBytes: 10_000_000 });
  assert.equal(out.retainedRows, 25_920_000); assert.equal(out.withinBudget, false);
});
test('retention is fail-closed on missing export, legal hold, references and time window', () => {
  const old = '2020-01-01T00:00:00Z'; const proof = { verifiedAt: '2026-01-01T00:00:00Z', objectDigest: `sha256:${'a'.repeat(64)}` };
  assert.equal(retentionDecision({ export: {}, rangeEnd: old }).code, 'ExportProofRequired');
  assert.equal(retentionDecision({ export: proof, legalHold: true, rangeEnd: old }).code, 'LegalHoldActive');
  assert.equal(retentionDecision({ export: proof, incidentEvidenceReferences: 1, rangeEnd: old }).code, 'EvidenceReferenced');
  assert.equal(retentionDecision({ export: proof, rangeEnd: old, minimumRetentionDays: 30 }).allowed, true);
});
test('self model explicitly exposes unknown coverage and action blockers', () => {
  const model = selfModel({ observerEnabled: true, leader: true, sourceLagging: true, snapshotComplete: false, coverage: 0.8, ownerAvailable: false, incidentEnabled: true, operationEnabled: true, remediationEnabled: true, r3Available: false });
  assert.equal(model.graphState, 'partial'); assert.equal(model.remediationState, 'proposal-only');
  assert.deepEqual(model.blockers, ['source_lagging','reconcile_incomplete','coverage_incomplete','owner_unavailable']);
});
test('SLO and restore replay require p95 budget and zero loss/duplicates', () => {
  assert.equal(sloEvaluation([1,2,3,4,5], { p95: 5 }).pass, true);
  assert.equal(replayContinuity({ openIncidentIds: ['i'], operationIds: ['o'] }, { incidentIds: ['i'], incidentFingerprints: ['f'], operationIds: ['o'], operationIdempotencyKeys: ['k'] }).pass, true);
  assert.equal(replayContinuity({ openIncidentIds: ['i'], operationIds: [] }, { incidentIds: [], incidentFingerprints: [], operationIds: [], operationIdempotencyKeys: [] }).pass, false);
});
