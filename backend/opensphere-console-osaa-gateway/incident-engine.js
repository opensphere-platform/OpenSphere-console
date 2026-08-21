'use strict';

const { digest, stableJson } = require('./operational-graph');

const INCIDENT_STATES = Object.freeze(new Set(['detected', 'active', 'recovering', 'resolved', 'suspended']));
const SEVERITY_ORDER = Object.freeze({ unknown: 0, info: 1, warning: 2, high: 3, critical: 4 });
const TRANSITIONS = Object.freeze({
  detected: new Set(['detected', 'active', 'recovering', 'resolved', 'suspended']),
  active: new Set(['active', 'recovering', 'suspended']),
  recovering: new Set(['recovering', 'active', 'resolved', 'suspended']),
  suspended: new Set(['suspended', 'detected', 'active']),
  resolved: new Set(['resolved', 'detected']),
});

function incidentFingerprint({ clusterId, incidentType, primaryNodeId, causeCode = 'unknown', ruleRevision }) {
  return digest({ clusterId, incidentType, primaryNodeId, causeCode, ruleRevision });
}

function assertTransition(from, to, context = {}) {
  if (!INCIDENT_STATES.has(to)) throw new Error(`unsupported incident state ${to}`);
  if (from == null && to !== 'detected') throw new Error('new incident must start detected');
  if (from != null && !TRANSITIONS[from]?.has(to)) throw new Error(`invalid incident transition ${from}->${to}`);
  if (to === 'resolved') {
    if (!context.snapshotComplete) throw new Error('resolved requires complete reconciliation');
    if (!context.sourceFresh) throw new Error('resolved requires fresh authority');
    if (!context.freshAuthorityWatermark || !context.lastCauseObservedAt ||
        Date.parse(context.freshAuthorityWatermark) <= Date.parse(context.lastCauseObservedAt)) {
      throw new Error('resolved requires a newer fresh-authority watermark');
    }
    if (Number(context.stableForMs || 0) < Number(context.requiredStableMs || 0)) throw new Error('resolution hysteresis is not satisfied');
  }
  if (context.writerEpoch != null && context.currentEpoch != null && Number(context.writerEpoch) !== Number(context.currentEpoch)) {
    throw new Error('stale incident writer fencing epoch');
  }
  return true;
}

function deriveIncidentTransition(current, signal, policy) {
  const now = signal.receivedAt;
  if (!current && !signal.present) return null;
  if (!current) {
    return {
      status: 'detected', severity: signal.severity || 'unknown', confidence: signal.confidence ?? 0.5,
      causeStatus: signal.causeStatus || 'unknown', firstDetectedAt: now, lastObservedAt: now,
      eventType: 'incident_detected', reasonCode: signal.reasonCode || 'signal-detected',
    };
  }
  if (!signal.sourceConfigured) return null;
  if (!signal.sourceFresh || !signal.snapshotComplete) {
    if (current.status === 'resolved' || current.status === 'suspended') return null;
    return { ...current, status: 'suspended', suspendedAt: now, eventType: 'incident_suspended', reasonCode: 'source-unavailable' };
  }
  if (signal.present) {
    const repeated = Number(signal.repeatCount || 1) >= Number(policy.activationCount || 2);
    const nextStatus = current.status === 'suspended' ? (repeated ? 'active' : 'detected')
      : (current.status === 'detected' && repeated ? 'active' : current.status === 'recovering' ? 'active' : current.status);
    const severity = SEVERITY_ORDER[signal.severity] > SEVERITY_ORDER[current.severity] ? signal.severity : current.severity;
    const changedSeverity = severity !== current.severity;
    return { ...current, status: nextStatus, severity, lastObservedAt: now,
      eventType: changedSeverity ? 'incident_severity_changed' : (current.status === 'suspended' ? 'incident_resumed' : nextStatus === 'active' && current.status !== 'active' ? 'incident_activated' : null),
      reasonCode: signal.reasonCode || 'signal-present' };
  }
  if (current.status === 'active') {
    return { ...current, status: 'recovering', recoveringAt: now, eventType: 'incident_recovering', reasonCode: 'condition-cleared' };
  }
  if (current.status === 'detected') {
    return { ...current, status: 'recovering', recoveringAt: now, eventType: 'incident_recovering', reasonCode: 'condition-cleared' };
  }
  if (current.status === 'recovering') {
    const stableForMs = Date.parse(now) - Date.parse(current.recoveringAt || current.lastObservedAt);
    if (stableForMs < Number(policy.resolveStableMs || 30000)) return { ...current, eventType: null, reasonCode: 'recovery-hysteresis' };
    assertTransition(current.status, 'resolved', { snapshotComplete: signal.snapshotComplete, sourceFresh: signal.sourceFresh,
      freshAuthorityWatermark: signal.freshAuthorityWatermark, lastCauseObservedAt: current.lastObservedAt,
      stableForMs, requiredStableMs: policy.resolveStableMs || 30000,
      writerEpoch: signal.fencingEpoch, currentEpoch: signal.currentFencingEpoch });
    return { ...current, status: 'resolved', resolvedAt: now, lastObservedAt: now,
      eventType: 'incident_resolved', reasonCode: 'fresh-authority-stable' };
  }
  return null;
}

function boundedImpactTraversal(primaryNodeId, relations, options = {}) {
  const maxDepth = Math.max(0, Math.min(32, Number(options.maxDepth ?? 8)));
  const maxNodes = Math.max(1, Math.min(10000, Number(options.maxNodes ?? 1000)));
  const forward = new Map();
  for (const relation of relations) {
    if (!['depends_on', 'routes_to', 'serves', 'realizes', 'contains'].includes(relation.relationType)) continue;
    if (!forward.has(relation.fromNodeId)) forward.set(relation.fromNodeId, []);
    forward.get(relation.fromNodeId).push(relation.toNodeId);
  }
  const queue = [{ nodeId: primaryNodeId, distance: 0, path: [primaryNodeId] }];
  const visited = new Set();
  const impacts = [];
  while (queue.length && impacts.length < maxNodes) {
    const item = queue.shift();
    if (visited.has(item.nodeId)) continue;
    visited.add(item.nodeId);
    impacts.push({ nodeId: item.nodeId, distance: item.distance, impactType: item.distance === 0 ? 'direct' : 'downstream',
      confidence: Math.max(0.1, 1 - item.distance * 0.1), pathDigest: digest(item.path) });
    if (item.distance >= maxDepth) continue;
    for (const next of forward.get(item.nodeId) || []) {
      if (!visited.has(next)) queue.push({ nodeId: next, distance: item.distance + 1, path: [...item.path, next] });
    }
  }
  return { impacts, bounded: queue.length > 0, visited: visited.size };
}

function evidencePackage(incident, observations, impacts) {
  return {
    incident: {
      incidentId: incident.incidentId, status: incident.status, severity: incident.severity,
      causeStatus: incident.causeStatus, causeCode: incident.causeCode || null,
      confidence: incident.confidence, primaryNodeId: incident.primaryNodeId,
    },
    facts: observations.map((item) => ({ observationId: item.observationId, fact: item.fact,
      authority: item.source, evidenceRef: item.evidenceRef, observedAt: item.observedAt })),
    hypotheses: [],
    impacts,
    digest: digest({ incident, observations, impacts }),
  };
}

function transitionEnvelope(incident, next, signal, impacts = []) {
  if (!next?.eventType) return null;
  const transitionSequence = Number(incident?.transitionSequence || 0) + 1;
  const payload = {
    incidentId: incident?.incidentId || null,
    transitionSequence,
    status: next.status,
    severity: next.severity,
    primaryNodeId: signal.primaryNodeId,
    routeRefs: [...new Set(impacts.flatMap((item) => item.routeRefs || []))],
  };
  return { transitionSequence, eventType: next.eventType, idempotencyKey: `${incident?.incidentId || 'pending'}:${transitionSequence}`,
    evidenceDigest: digest(signal.evidence || {}), payload, payloadDigest: digest(payload), stablePayload: stableJson(payload) };
}

module.exports = {
  INCIDENT_STATES, SEVERITY_ORDER, incidentFingerprint, assertTransition,
  deriveIncidentTransition, boundedImpactTraversal, evidencePackage, transitionEnvelope,
};
