'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  kubernetesMicroTime, leaseBody, leaseExpired, KubernetesLeaseElector, correlationSignals,
  incidentRowToState, projectNodeForActor, OperationalQueryService, OperationalIntelligenceRuntime,
  reconcileCompletenessDigest, inactiveOperationalStatus, inactiveMetacognition,
} = require('./r2d2-operational-runtime');

const runtimeSource = fs.readFileSync(path.join(__dirname, 'r2d2-operational-runtime.js'), 'utf8');

test('Kubernetes Lease timestamps use the MicroTime wire format', () => {
  assert.equal(kubernetesMicroTime('2026-08-11T06:19:32.797Z'), '2026-08-11T06:19:32.797000Z');
  assert.equal(kubernetesMicroTime('2026-08-11T06:19:32Z'), '2026-08-11T06:19:32.000000Z');
  assert.equal(leaseBody('ns', 'r2d2', 'pod-a', '2026-08-11T06:19:32.797Z', 30).spec.renewTime,
    '2026-08-11T06:19:32.797000Z');
});

test('inactive operational capability is an explicit safe projection before Cluster Manager activation', () => {
  assert.deepEqual(inactiveOperationalStatus('local'), {
    clusterId: 'local',
    graph: { total: 0, fresh: 0, observedAt: null },
    sources: [],
    risk: { active: 0, severityRank: 0 },
    observer: null,
    runtime: { degraded: false, reason: 'disabled_until_cluster_manager_activation' },
    flags: { observer: false, graph: false, incident: false, globalRisk: false, incidentRelay: false },
  });
  assert.deepEqual(inactiveMetacognition('local'), {
    clusterId: 'local', selfModel: null, mismatches: [], remediations: [],
  });
});

test('tombstones advance to the current fence and collection epoch', () => {
  assert.match(runtimeSource, /resource_node SET deleted_at=\$4[\s\S]*fencing_epoch=\$3,collection_epoch=\$6/);
  assert.match(runtimeSource, /resource_relation SET deleted_at=\$4[\s\S]*fencing_epoch=\$3,collection_epoch=\$5/);
});

test('reconcile completeness evidence is deterministic and node-set bound', () => {
  const input = {
    reconcileSessionId: '11111111-1111-4111-8111-111111111111',
    expectedScopeCount: 2, completedScopeCount: 2, observedResourceCount: 2,
    authorityRevision: 'sha256:authority', nodeIds: ['node-b', 'node-a'],
  };
  const first = reconcileCompletenessDigest(input);
  assert.match(first, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(first, reconcileCompletenessDigest({ ...input, nodeIds: ['node-a', 'node-b'] }));
  assert.notEqual(first, reconcileCompletenessDigest({ ...input, nodeIds: ['node-a'] }));
});

test('lease expires deterministically and preserves Kubernetes resourceVersion fencing', () => {
  const current = { metadata: { resourceVersion: '7' }, spec: { holderIdentity: 'old', renewTime: '2026-08-10T00:00:00Z', leaseDurationSeconds: 30, leaseTransitions: 1 } };
  assert.equal(leaseExpired(current, Date.parse('2026-08-10T00:00:31Z')), true);
  const body = leaseBody('ns', 'r2d2', 'new', '2026-08-10T00:00:31Z', 30, current);
  assert.equal(body.metadata.resourceVersion, '7');
  assert.equal(body.spec.leaseTransitions, 2);
});

test('active lease owned by another replica is never overwritten', async () => {
  let writes = 0;
  const elector = new KubernetesLeaseElector({ namespace: 'ns', name: 'r2d2', identity: 'me', request: async (method) => {
    if (method !== 'GET') writes += 1;
    return { ok: true, status: 200, json: { metadata: { resourceVersion: '1' }, spec: { holderIdentity: 'other', renewTime: new Date().toISOString(), leaseDurationSeconds: 30 } } };
  } });
  const out = await elector.acquire();
  assert.equal(out.acquired, false);
  assert.equal(writes, 0);
});

test('correlation rules detect workload, crash loop and endpoint loss using authority facts', () => {
  const base = { cluster_id: 'local', fencing_epoch: 2, authority: 'kubernetes', source_revision: '10', namespace: 'opensphere-console' };
  const nodes = [
    { ...base, node_id: 'd', node_type: 'Deployment', display_name: 'console', attributes: { spec: { replicas: 2 }, status: { readyReplicas: 1 } } },
    { ...base, node_id: 'p', node_type: 'Pod', display_name: 'pod', attributes: { status: { containerStatuses: [{ restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } } },
    { ...base, node_id: 'e', node_type: 'EndpointSlice', display_name: 'ep', attributes: { endpoints: [] } },
  ];
  const signals = correlationSignals(nodes, { configured: true, epistemic_state: 'known', snapshot_complete: true, last_complete_at: new Date().toISOString() });
  assert.deepEqual(signals.map((s) => s.incidentType), ['rollout_not_progressing', 'crash_loop', 'endpoint_unavailable']);
  assert.ok(signals.every((s) => s.causeStatus === 'confirmed'));
});

test('persisted incident rows preserve cause status across runtime transitions', () => {
  const state = incidentRowToState({
    incident_id: 'incident-1', transition_sequence: 4, status: 'active', severity: 'high',
    confidence: 0.9, cause_status: 'confirmed', cause_code: 'workload-not-ready',
    first_detected_at: '2026-08-11T00:00:00Z', last_observed_at: '2026-08-11T00:01:00Z',
    recovering_at: null,
  });
  assert.equal(state.incidentId, 'incident-1');
  assert.equal(state.transitionSequence, 4);
  assert.equal(state.causeStatus, 'confirmed');
  assert.equal(state.causeCode, 'workload-not-ready');
  assert.equal(state.lastObservedAt, '2026-08-11T00:01:00Z');
});

test('healthy authority facts emit clearing signals and exact digest drift remains independent', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const node = { cluster_id: 'local', fencing_epoch: 2, authority: 'kubernetes', source_revision: '11',
    namespace: 'opensphere-console', node_id: 'd', node_type: 'Deployment', display_name: 'console',
    attributes: { metadata: { annotations: { 'opensphere.io/desired-image-digest': digest } }, spec: { replicas: 1,
      template: { spec: { containers: [{ image: `ghcr.io/opensphere-platform/console@${`sha256:${'b'.repeat(64)}`}` }] } } },
      status: { readyReplicas: 1 } } };
  const signals = correlationSignals([node], { configured: true, epistemic_state: 'known', snapshot_complete: true, last_complete_at: new Date().toISOString() });
  assert.equal(signals.find((item) => item.incidentType === 'rollout_not_progressing').present, false);
  assert.equal(signals.find((item) => item.incidentType === 'digest_drift').present, true);
});

test('viewer projection never includes source attributes or revision', () => {
  const row = { cluster_id: 'c', node_id: 'n', node_type: 'Pod', canonical_id: 'x', display_name: 'p', namespace: 'n', authority: 'kubernetes', health: 'Ready', epistemic_state: 'known', source_revision: 'secret-ish-revision', attributes: { metadata: { labels: { app: 'x' } } } };
  const viewer = projectNodeForActor(row, { groups: ['console-viewers'] });
  assert.deepEqual(viewer.attributes, {});
  assert.equal(viewer.sourceRevision, null);
  assert.equal(projectNodeForActor(row, { groups: ['console-admins'] }).sourceRevision, 'secret-ish-revision');
});

test('runtime claims DB fencing only after Lease and refuses incomplete snapshots', async () => {
  const calls = [];
  const runtime = new OperationalIntelligenceRuntime({
    enabled: true, graphEnabled: true, incidentEnabled: true,
    elector: { acquire: async () => { calls.push('lease'); return { acquired: true, leaseIdentity: 'lease:1' }; } },
    store: { claimFence: async () => { calls.push('fence'); return 3; }, renewFence: async () => true, reconcile: async () => { calls.push('reconcile'); },
      recordSelfModel: async (model) => { calls.push('self-model'); return model; } },
    collect: async () => { calls.push('collect'); return { snapshotComplete: false, completedScopeCount: 1, expectedScopeCount: 2 }; },
    incidents: { correlate: async () => { calls.push('incidents'); return []; } },
  });
  const out = await runtime.tick();
  assert.deepEqual(calls, ['lease', 'fence', 'collect', 'self-model']);
  assert.equal(out.reason, 'incomplete_snapshot');
});

test('complete runtime records a fresh self model after graph and incident correlation', async () => {
  const calls = []; let recorded;
  const runtime = new OperationalIntelligenceRuntime({
    enabled: true, graphEnabled: true, incidentEnabled: true, operationEnabled: true,
    ownerAvailable: true, remediationEnabled: true, r3Available: false,
    elector: { acquire: async () => ({ acquired: true, leaseIdentity: 'lease:1' }) },
    store: {
      claimFence: async () => 4, renewFence: async () => true,
      reconcile: async () => { calls.push('graph'); return { nodeCount: 1 }; },
      recordSelfModel: async (input) => { calls.push('self'); recorded = input; return { graphState: 'fresh' }; },
    },
    collect: async () => ({ snapshotComplete: true, completedScopeCount: 2, expectedScopeCount: 2,
      observedAt: '2026-08-10T00:00:00Z', sources: [{ configured: true, epistemicState: 'known', snapshotComplete: true }] }),
    incidents: { correlate: async () => { calls.push('incident'); return []; } },
  });
  const out = await runtime.tick();
  assert.deepEqual(calls, ['graph', 'incident', 'self']);
  assert.equal(recorded.coverage, 1);
  assert.equal(recorded.sourceLagging, false);
  assert.equal(out.selfModel.graphState, 'fresh');
});

test('metacognition projects self model, latest assessment and immutable engineering evidence', async () => {
  const results = [
    { rows: [{ observer_state: 'leader', graph_state: 'fresh', incident_state: 'active', operation_state: 'ready',
      remediation_state: 'proposal-only', coverage: '0.98', blockers: ['r3-unavailable'], capability_revision: 'cap-7',
      observed_at: '2026-08-10T01:00:00Z' }] },
    { rows: [{ mismatch_id: 'm-1', incident_id: 'i-1', subject_node_id: 'node-1', mismatch_type: 'exact_image_digest',
      epistemic_state: 'known', expected_digest: 'sha256:a', actual_digest: 'sha256:b', evidence_digest: 'sha256:c',
      detected_at: '2026-08-10T00:00:00Z', resolved_at: null, assessment_id: 'a-1', minimum_ladder_step: 5,
      lower_steps: [1, 2, 3, 4], engineering_required: true, rationale: 'runtime repair exhausted',
      policy_revision: 'policy-1', assessed_at: '2026-08-10T00:30:00Z' }] },
    { rows: [{ remediation_request_id: 'r-1', assessment_id: 'a-1', incident_id: 'i-1', operation_id: 'o-1',
      repository: 'opensphere/console', base_revision: 'rev-1', allowed_paths: ['backend/**'], patch_digest: 'sha256:d',
      reason: 'repair', risk_level: 'R3', affected_components: ['gateway'], affected_images: ['gateway'],
      required_tests: ['npm test'], release_scope: 'component', target_channel: 'edge', build_authority: 'local',
      stage: 'proposed', approval_expires_at: '2026-08-10T02:00:00Z', updated_at: '2026-08-10T01:00:00Z',
      build_evidence_id: 'b-1', source_revision: 'rev-2', image_digests: ['sha256:e'], verification_id: 'v-1',
      deployment_status: 'verified', verified_at: '2026-08-10T01:30:00Z' }] },
  ];
  const pool = { query: async () => results.shift() };
  const out = await new OperationalQueryService(pool, 'local').metacognition({ limit: 5 });
  assert.equal(out.selfModel.coverage, 0.98);
  assert.equal(out.mismatches[0].assessment.minimumLadderStep, 5);
  assert.equal(out.remediations[0].buildEvidence.sourceRevision, 'rev-2');
  assert.equal(out.remediations[0].deploymentVerification.status, 'verified');
});
