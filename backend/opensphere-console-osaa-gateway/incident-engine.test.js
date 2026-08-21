'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  incidentFingerprint, assertTransition, deriveIncidentTransition,
  boundedImpactTraversal, evidencePackage, transitionEnvelope,
} = require('./incident-engine');

test('fingerprint is replica independent and stable for the same cause and target', () => {
  const input = { clusterId: 'local', incidentType: 'workload-not-ready', primaryNodeId: 'node-1', causeCode: 'AvailableFalse', ruleRevision: 'r1' };
  assert.equal(incidentFingerprint(input), incidentFingerprint({ ...input, collectorId: 'replica-2' }));
});

test('source outage suspends but never resolves an active incident', () => {
  const current = { status: 'active', severity: 'high', lastObservedAt: '2026-08-10T00:00:00Z' };
  const next = deriveIncidentTransition(current, {
    receivedAt: '2026-08-10T00:00:10Z', sourceConfigured: true, sourceFresh: false,
    snapshotComplete: false, present: false,
  }, {});
  assert.equal(next.status, 'suspended');
  assert.equal(next.eventType, 'incident_suspended');
});

test('never configured source creates no incident', () => {
  const current = { status: 'active', severity: 'warning', lastObservedAt: '2026-08-10T00:00:00Z' };
  assert.equal(deriveIncidentTransition(current, { receivedAt: '2026-08-10T00:00:10Z', sourceConfigured: false }, {}), null);
});

test('a healthy clearing signal never creates a new incident', () => {
  assert.equal(deriveIncidentTransition(null, {
    receivedAt: '2026-08-10T00:00:10Z', sourceConfigured: true,
    sourceFresh: true, snapshotComplete: true, present: false,
  }, {}), null);
});

test('resolution requires complete fresh reconciliation, newer watermark and hysteresis', () => {
  assert.throws(() => assertTransition('recovering', 'resolved', {
    snapshotComplete: false, sourceFresh: true, freshAuthorityWatermark: '2026-08-10T00:01:00Z',
    lastCauseObservedAt: '2026-08-10T00:00:00Z', stableForMs: 60000, requiredStableMs: 30000,
  }), /complete/);
  assert.throws(() => assertTransition('recovering', 'resolved', {
    snapshotComplete: true, sourceFresh: true, freshAuthorityWatermark: '2026-08-10T00:00:00Z',
    lastCauseObservedAt: '2026-08-10T00:00:00Z', stableForMs: 60000, requiredStableMs: 30000,
  }), /newer/);
  assert.equal(assertTransition('recovering', 'resolved', {
    snapshotComplete: true, sourceFresh: true, freshAuthorityWatermark: '2026-08-10T00:01:00Z',
    lastCauseObservedAt: '2026-08-10T00:00:00Z', stableForMs: 60000, requiredStableMs: 30000,
    writerEpoch: 4, currentEpoch: 4,
  }), true);
});

test('old leader cannot transition after a fencing epoch changes', () => {
  assert.throws(() => assertTransition('active', 'recovering', { writerEpoch: 4, currentEpoch: 5 }), /stale/);
});

test('impact traversal is cycle safe and bounded', () => {
  const relations = [
    { fromNodeId: 'a', relationType: 'depends_on', toNodeId: 'b' },
    { fromNodeId: 'b', relationType: 'depends_on', toNodeId: 'c' },
    { fromNodeId: 'c', relationType: 'depends_on', toNodeId: 'a' },
  ];
  const result = boundedImpactTraversal('a', relations, { maxDepth: 8, maxNodes: 10 });
  assert.equal(result.impacts.length, 3);
  assert.equal(new Set(result.impacts.map((item) => item.nodeId)).size, 3);
});

test('evidence package separates facts from hypotheses and transition keys are material only', () => {
  const incident = { incidentId: 'i1', transitionSequence: 0, status: 'detected', severity: 'warning', causeStatus: 'unknown', confidence: 0.5, primaryNodeId: 'n1' };
  const pkg = evidencePackage(incident, [{ observationId: 'o1', source: 'kubernetes', fact: { ready: false }, evidenceRef: 'e1', observedAt: 't' }], []);
  assert.equal(pkg.facts.length, 1);
  assert.deepEqual(pkg.hypotheses, []);
  const envelope = transitionEnvelope(incident, { status: 'active', severity: 'warning', eventType: 'incident_activated' }, { primaryNodeId: 'n1', evidence: { o: 'o1' } });
  assert.equal(envelope.idempotencyKey, 'i1:1');
});
