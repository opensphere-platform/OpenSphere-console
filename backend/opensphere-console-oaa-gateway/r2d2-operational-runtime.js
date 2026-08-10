'use strict';

const { createHash, randomUUID } = require('crypto');
const {
  runtimeRowToNode, buildRelations, digest, sanitizeOperationalValue,
  BoundedCoalescingQueue, graphCoverage,
} = require('./operational-graph');
const {
  incidentFingerprint, deriveIncidentTransition, boundedImpactTraversal, transitionEnvelope,
} = require('./incident-engine');
const { selfModel } = require('./r2d2-operational-resilience');

const RULE_REVISION = 'r2d2-correlation-v1';
const DEFAULT_CLUSTER = 'local';

function leaseBody(namespace, name, identity, now, durationSeconds, current = null) {
  const transitions = Number(current?.spec?.leaseTransitions || 0) + (current?.spec?.holderIdentity && current.spec.holderIdentity !== identity ? 1 : 0);
  return {
    apiVersion: 'coordination.k8s.io/v1', kind: 'Lease',
    metadata: { name, namespace, ...(current?.metadata?.resourceVersion ? { resourceVersion: current.metadata.resourceVersion } : {}) },
    spec: {
      holderIdentity: identity, leaseDurationSeconds: durationSeconds,
      acquireTime: current?.spec?.acquireTime || now, renewTime: now, leaseTransitions: transitions,
    },
  };
}

function leaseExpired(lease, nowMs = Date.now()) {
  const renew = Date.parse(lease?.spec?.renewTime || lease?.spec?.acquireTime || 0);
  return !Number.isFinite(renew) || renew + Number(lease?.spec?.leaseDurationSeconds || 0) * 1000 <= nowMs;
}

class KubernetesLeaseElector {
  constructor(options) {
    this.request = options.request;
    this.namespace = options.namespace;
    this.name = options.name || 'r2d2-operational-observer';
    this.identity = options.identity;
    this.durationSeconds = options.durationSeconds || 30;
    this.isLeader = false;
    this.leaseIdentity = null;
  }

  async acquire() {
    const path = `/apis/coordination.k8s.io/v1/namespaces/${this.namespace}/leases/${this.name}`;
    const read = await this.request('GET', path);
    const current = read.status === 404 ? null : read.json;
    if (!current && read.status !== 404 && !read.ok) return { acquired: false, reason: `lease_read_${read.status}` };
    if (current && current.spec?.holderIdentity !== this.identity && !leaseExpired(current)) {
      this.isLeader = false;
      return { acquired: false, reason: 'lease_held', holder: current.spec?.holderIdentity || null };
    }
    const now = new Date().toISOString();
    const body = leaseBody(this.namespace, this.name, this.identity, now, this.durationSeconds, current);
    const write = await this.request(current ? 'PUT' : 'POST', current ? path : path.replace(`/${this.name}`, ''), body);
    this.isLeader = Boolean(write.ok && write.json?.spec?.holderIdentity === this.identity);
    this.leaseIdentity = this.isLeader ? `${this.name}:${write.json?.metadata?.resourceVersion || 'unknown'}` : null;
    return { acquired: this.isLeader, reason: this.isLeader ? 'acquired' : `lease_write_${write.status}`, leaseIdentity: this.leaseIdentity };
  }
}

function nodeUpsertParams(node) {
  return [
    node.clusterId, node.nodeId, node.nodeType, node.canonicalId, node.authority, node.authorityUid,
    node.displayName, node.namespace, node.ownerRef, node.health, node.epistemicState,
    JSON.stringify(node.attributes), node.fencingEpoch, node.collectionEpoch, node.streamSequence,
    node.sourceRevision, node.reconcileSessionId, node.snapshotComplete, node.observedAt, node.expiresAt,
  ];
}

function reconcileCompletenessDigest({
  reconcileSessionId, expectedScopeCount, completedScopeCount,
  observedResourceCount, authorityRevision, nodeIds,
}) {
  const material = [
    'complete-reconcile-v2', String(reconcileSessionId), String(expectedScopeCount),
    String(completedScopeCount), String(observedResourceCount), String(authorityRevision),
    [...nodeIds].map(String).sort().join('\n'),
  ].join('\n');
  return `sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

class OperationalGraphStore {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.clusterId = options.clusterId || DEFAULT_CLUSTER;
    this.collectorId = options.collectorId || `collector-${process.pid}`;
  }

  async claimFence(leaseIdentity, ttlSeconds = 60) {
    const result = await this.pool.query('SELECT oaa.claim_observer_epoch($1,$2,$3,$4) AS epoch', [this.clusterId, this.collectorId, leaseIdentity, ttlSeconds]);
    return Number(result.rows[0]?.epoch || 0);
  }

  async renewFence(epoch, ttlSeconds = 60) {
    const result = await this.pool.query('SELECT oaa.renew_observer_epoch($1,$2,$3,$4) AS renewed', [this.clusterId, this.collectorId, epoch, ttlSeconds]);
    return result.rows[0]?.renewed === true;
  }

  async recordSelfModel(input, observedAt = new Date().toISOString()) {
    const model = selfModel(input);
    await this.pool.query(`INSERT INTO oaa.self_model(
      cluster_id,observer_state,graph_state,incident_state,operation_state,remediation_state,
      coverage,blockers,capability_revision,observed_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
    ON CONFLICT(cluster_id) DO UPDATE SET
      observer_state=EXCLUDED.observer_state,graph_state=EXCLUDED.graph_state,
      incident_state=EXCLUDED.incident_state,operation_state=EXCLUDED.operation_state,
      remediation_state=EXCLUDED.remediation_state,coverage=EXCLUDED.coverage,
      blockers=EXCLUDED.blockers,capability_revision=EXCLUDED.capability_revision,
      observed_at=EXCLUDED.observed_at,updated_at=clock_timestamp()`, [
      this.clusterId, model.observerState, model.graphState, model.incidentState,
      model.operationState, model.remediationState, model.coverage,
      JSON.stringify(model.blockers), RULE_REVISION, observedAt,
    ]);
    return model;
  }

  async reconcile(inventory, fencingEpoch) {
    if (!inventory?.snapshotComplete) throw Object.assign(new Error('incomplete inventory cannot cross the reconcile barrier'), { code: 'IncompleteReconcile' });
    const collectionEpoch = Date.now();
    const reconcileSessionId = inventory.reconcileSessionId || randomUUID();
    const observedAt = inventory.observedAt || new Date().toISOString();
    const expiresAt = new Date(Date.parse(observedAt) + 180000).toISOString();
    const context = { clusterId: this.clusterId, fencingEpoch, collectionEpoch, reconcileSessionId, snapshotComplete: true, observedAt, expiresAt };
    const nodes = (inventory.rows || []).filter((row) => row?.name).map((row) => runtimeRowToNode(row, context));
    const relations = buildRelations(nodes, context);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO oaa.reconcile_session(
        reconcile_session_id,cluster_id,source,collector_id,fencing_epoch,collection_epoch,expected_scope_count,completed_scope_count,snapshot_complete,started_at
      ) VALUES($1,$2,'kubernetes',$3,$4,$5,$6,$7,false,$8)`, [reconcileSessionId, this.clusterId, this.collectorId, fencingEpoch, collectionEpoch, inventory.expectedScopeCount, inventory.completedScopeCount, observedAt]);
      for (const node of nodes) {
        await client.query(`INSERT INTO oaa.resource_node(
          cluster_id,node_id,node_type,canonical_id,authority,authority_uid,display_name,namespace,owner_ref,health,epistemic_state,attributes,
          fencing_epoch,collection_epoch,stream_sequence,source_revision,reconcile_session_id,snapshot_complete,observed_at,expires_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT(cluster_id,node_id) DO UPDATE SET
          node_type=EXCLUDED.node_type,canonical_id=EXCLUDED.canonical_id,authority=EXCLUDED.authority,authority_uid=EXCLUDED.authority_uid,
          display_name=EXCLUDED.display_name,namespace=EXCLUDED.namespace,owner_ref=EXCLUDED.owner_ref,health=EXCLUDED.health,
          epistemic_state=EXCLUDED.epistemic_state,attributes=EXCLUDED.attributes,fencing_epoch=EXCLUDED.fencing_epoch,
          collection_epoch=EXCLUDED.collection_epoch,stream_sequence=EXCLUDED.stream_sequence,source_revision=EXCLUDED.source_revision,
          reconcile_session_id=EXCLUDED.reconcile_session_id,snapshot_complete=EXCLUDED.snapshot_complete,observed_at=EXCLUDED.observed_at,
          received_at=clock_timestamp(),expires_at=EXCLUDED.expires_at,revision=oaa.resource_node.revision+1,deleted_at=NULL
        WHERE (EXCLUDED.fencing_epoch,EXCLUDED.collection_epoch,coalesce(EXCLUDED.stream_sequence,-1)) >=
              (oaa.resource_node.fencing_epoch,oaa.resource_node.collection_epoch,coalesce(oaa.resource_node.stream_sequence,-1))`, nodeUpsertParams(node));
        const fact = {
          nodeType: node.nodeType, health: node.health, epistemicState: node.epistemicState,
          sourceRevision: node.sourceRevision, snapshotComplete: true,
        };
        await client.query(`INSERT INTO oaa.observation(
          cluster_id,source,source_event_id,subject_node_id,observation_type,severity,fact,payload_digest,evidence_ref,
          collector_id,fencing_epoch,collection_epoch,stream_sequence,source_revision,reconcile_session_id,snapshot_complete,observed_at,received_at
        ) VALUES($1,$2,$3,$4,'authority-snapshot',$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,$15)
        ON CONFLICT(cluster_id,source,source_event_id,received_at) DO NOTHING`, [
          this.clusterId, node.authority, `${collectionEpoch}:${node.nodeId}`, node.nodeId,
          ['Degraded', 'Failed', 'Unknown'].includes(node.health) ? 'warning' : 'info', JSON.stringify(fact), digest(fact),
          `node:${node.nodeId}@${node.sourceRevision || 'unknown'}`, this.collectorId, fencingEpoch, collectionEpoch,
          node.streamSequence, node.sourceRevision, reconcileSessionId, observedAt,
        ]);
      }
      for (const relation of relations) {
        await client.query(`INSERT INTO oaa.resource_relation(
          cluster_id,from_node_id,relation_type,to_node_id,authority,confidence,evidence_ref,fencing_epoch,collection_epoch,
          source_revision,reconcile_session_id,observed_at,expires_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(cluster_id,from_node_id,relation_type,to_node_id,authority) DO UPDATE SET
          confidence=EXCLUDED.confidence,evidence_ref=EXCLUDED.evidence_ref,fencing_epoch=EXCLUDED.fencing_epoch,
          collection_epoch=EXCLUDED.collection_epoch,source_revision=EXCLUDED.source_revision,reconcile_session_id=EXCLUDED.reconcile_session_id,
          observed_at=EXCLUDED.observed_at,received_at=clock_timestamp(),expires_at=EXCLUDED.expires_at,deleted_at=NULL
        WHERE (EXCLUDED.fencing_epoch,EXCLUDED.collection_epoch) >=
              (oaa.resource_relation.fencing_epoch,oaa.resource_relation.collection_epoch)`, [
          relation.clusterId, relation.fromNodeId, relation.relationType, relation.toNodeId, relation.authority,
          relation.confidence, relation.evidenceRef, relation.fencingEpoch, relation.collectionEpoch,
          relation.sourceRevision, relation.reconcileSessionId, relation.observedAt, relation.expiresAt,
        ]);
      }
      // Tombstones are legal only for an authority whose own snapshot is complete.
      const completeSources = (inventory.sources || [{ source: 'kubernetes', configured: true, snapshotComplete: true }])
        .filter((source) => source.configured !== false && source.snapshotComplete === true)
        .map((source) => String(source.source));
      await client.query(`UPDATE oaa.resource_node SET deleted_at=$4,epistemic_state='unknown',revision=revision+1
        WHERE cluster_id=$1 AND authority=ANY($5::text[]) AND deleted_at IS NULL AND reconcile_session_id<>$2
          AND fencing_epoch<=$3`, [this.clusterId, reconcileSessionId, fencingEpoch, observedAt, completeSources]);
      const relationSnapshotComplete = (inventory.sources || []).every((source) => source.configured === false || source.snapshotComplete === true);
      if (relationSnapshotComplete) {
        await client.query(`UPDATE oaa.resource_relation SET deleted_at=$4
          WHERE cluster_id=$1 AND deleted_at IS NULL AND reconcile_session_id<>$2 AND fencing_epoch<=$3`, [this.clusterId, reconcileSessionId, fencingEpoch, observedAt]);
      }
      const authorityRevision = String(inventory.authorityRevision || '');
      const completenessDigest = reconcileCompletenessDigest({
        reconcileSessionId,
        expectedScopeCount: inventory.expectedScopeCount,
        completedScopeCount: inventory.completedScopeCount,
        observedResourceCount: nodes.length,
        authorityRevision,
        nodeIds: nodes.map((node) => node.nodeId),
      });
      await client.query(
        'SELECT oaa.complete_reconcile_session_v2($1,$2,$3,$4,$5,$6)',
        [reconcileSessionId, inventory.completedScopeCount, nodes.length,
          inventory.pageTokenExhausted === true, authorityRevision, completenessDigest],
      );
      for (const source of inventory.sources || []) {
        if (source.source === 'kubernetes') continue;
        await client.query(`INSERT INTO oaa.source_health(cluster_id,source,epistemic_state,configured,snapshot_complete,
          last_complete_session_id,last_complete_at,last_received_at,lag_seconds,blocker_code,evidence_ref)
          VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $5 THEN $7::timestamptz ELSE NULL END,$7,$8,$9,$10)
          ON CONFLICT(cluster_id,source) DO UPDATE SET epistemic_state=EXCLUDED.epistemic_state,configured=EXCLUDED.configured,
          snapshot_complete=EXCLUDED.snapshot_complete,last_complete_session_id=CASE WHEN EXCLUDED.snapshot_complete THEN EXCLUDED.last_complete_session_id ELSE oaa.source_health.last_complete_session_id END,
          last_complete_at=CASE WHEN EXCLUDED.snapshot_complete THEN EXCLUDED.last_complete_at ELSE oaa.source_health.last_complete_at END,
          last_received_at=EXCLUDED.last_received_at,lag_seconds=EXCLUDED.lag_seconds,blocker_code=EXCLUDED.blocker_code,
          evidence_ref=EXCLUDED.evidence_ref,updated_at=clock_timestamp()`, [
          this.clusterId, source.source, source.epistemicState || 'unknown', source.configured !== false,
          source.snapshotComplete === true, reconcileSessionId, observedAt,
          source.snapshotComplete ? 0 : null, source.blockerCode || null, `adapter:${source.source}:${collectionEpoch}`,
        ]);
      }
      await client.query('COMMIT');
      return { reconcileSessionId, collectionEpoch, nodeCount: nodes.length, relationCount: relations.length, observedAt };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function correlationSignals(nodes, sourceHealth, now = new Date().toISOString()) {
  const signals = [];
  const sourceFresh = sourceHealth?.epistemic_state === 'known' && sourceHealth?.snapshot_complete === true;
  for (const node of nodes) {
    const a = node.attributes || {};
    const kind = String(node.node_type || '').toLowerCase();
    let incidentType = null; let severity = 'warning'; let reasonCode = null; let present = false; let causeCode = null;
    if (['deployment', 'statefulset', 'daemonset'].includes(kind)) {
      incidentType = 'rollout_not_progressing'; reasonCode = 'ready-below-desired'; causeCode = 'workload-not-ready';
      const desired = Number(a.spec?.replicas ?? a.status?.desiredNumberScheduled ?? 0);
      const ready = Number(a.status?.readyReplicas ?? a.status?.numberReady ?? 0);
      present = desired > ready;
      if (present) severity = ready === 0 ? 'high' : 'warning';
    } else if (kind === 'pod') {
      incidentType = 'crash_loop'; reasonCode = 'container-restart-loop'; causeCode = 'crash-loop';
      const statuses = a.status?.containerStatuses || [];
      present = statuses.some((s) => Number(s.restartCount || 0) > 2 || s.state?.waiting?.reason === 'CrashLoopBackOff');
      if (present) severity = 'high';
    } else if (kind === 'endpointslice') {
      incidentType = 'endpoint_unavailable'; reasonCode = 'no-ready-endpoints'; causeCode = 'endpoint-loss';
      const ready = (a.endpoints || []).filter((e) => e.conditions?.ready !== false).length;
      present = ready === 0;
      if (present) severity = 'high';
    }
    if (!incidentType) continue;
    signals.push({
      clusterId: node.cluster_id, incidentType, primaryNodeId: node.node_id, causeCode, ruleRevision: RULE_REVISION,
      title: `${node.display_name}: ${reasonCode}`, summary: `${node.node_type} ${node.namespace}/${node.display_name} authority condition ${reasonCode}`,
      present, severity, confidence: 0.9, causeStatus: 'confirmed', reasonCode, receivedAt: now,
      sourceConfigured: sourceHealth?.configured !== false, sourceFresh, snapshotComplete: sourceHealth?.snapshot_complete === true,
      freshAuthorityWatermark: sourceHealth?.last_complete_at || null, fencingEpoch: Number(node.fencing_epoch),
      currentFencingEpoch: Number(node.fencing_epoch), evidence: { nodeId: node.node_id, authority: node.authority, revision: node.source_revision },
    });
    if (['deployment', 'statefulset', 'daemonset'].includes(kind)) {
      const desiredDigest = String(a.metadata?.annotations?.['opensphere.io/desired-image-digest'] || '');
      const images = (a.spec?.template?.spec?.containers || []).map((container) => String(container.image || ''));
      if (/^sha256:[0-9a-f]{64}$/.test(desiredDigest)) {
        const digestPresent = images.length > 0 && images.some((image) => !image.endsWith(`@${desiredDigest}`));
        signals.push({
          clusterId: node.cluster_id, incidentType: 'digest_drift', primaryNodeId: node.node_id,
          causeCode: 'image-digest-mismatch', ruleRevision: RULE_REVISION,
          title: `${node.display_name}: desired image digest mismatch`, summary: 'Live workload image differs from the declared exact digest.',
          present: digestPresent, severity: 'high', confidence: 1, causeStatus: 'confirmed', reasonCode: 'exact-digest-drift', receivedAt: now,
          sourceConfigured: sourceHealth?.configured !== false, sourceFresh, snapshotComplete: sourceHealth?.snapshot_complete === true,
          freshAuthorityWatermark: sourceHealth?.last_complete_at || null, fencingEpoch: Number(node.fencing_epoch), currentFencingEpoch: Number(node.fencing_epoch),
          evidence: { nodeId: node.node_id, authority: node.authority, revision: node.source_revision, desiredDigest, actualImageDigests: images },
        });
      }
    }
  }
  return signals;
}

class IncidentRuntime {
  constructor(pool, options = {}) { this.pool = pool; this.clusterId = options.clusterId || DEFAULT_CLUSTER; }

  async correlate(fencingEpoch) {
    const client = await this.pool.connect();
    try {
      const [nodeResult, relationResult, sourceResult, currentResult] = await Promise.all([
        client.query("SELECT * FROM oaa.resource_node WHERE cluster_id=$1 AND deleted_at IS NULL", [this.clusterId]),
        client.query("SELECT * FROM oaa.resource_relation WHERE cluster_id=$1 AND deleted_at IS NULL", [this.clusterId]),
        client.query("SELECT * FROM oaa.source_health WHERE cluster_id=$1 AND source='kubernetes'", [this.clusterId]),
        client.query('SELECT * FROM oaa.incident WHERE cluster_id=$1', [this.clusterId]),
      ]);
      const byFingerprint = new Map(currentResult.rows.map((row) => [row.fingerprint, row]));
      const sourceHealth = sourceResult.rows[0] || { configured: false, snapshot_complete: false, epistemic_state: 'unknown' };
      const signals = correlationSignals(nodeResult.rows, sourceHealth);
      const represented = new Set(signals.map((signal) => incidentFingerprint(signal)));
      for (const row of currentResult.rows) {
        if (represented.has(row.fingerprint) || row.status === 'resolved') continue;
        signals.push({
          clusterId: row.cluster_id, incidentType: row.incident_type, primaryNodeId: row.primary_node_id,
          causeCode: row.cause_code, ruleRevision: row.rule_revision || RULE_REVISION,
          title: row.title, summary: row.summary, present: false, severity: row.severity,
          confidence: Number(row.confidence), causeStatus: row.cause_status, reasonCode: 'condition-absent-after-reconcile',
          receivedAt: new Date().toISOString(), sourceConfigured: sourceHealth.configured !== false,
          sourceFresh: sourceHealth.epistemic_state === 'known' && sourceHealth.snapshot_complete === true,
          snapshotComplete: sourceHealth.snapshot_complete === true, freshAuthorityWatermark: sourceHealth.last_complete_at || null,
          fencingEpoch, currentFencingEpoch: fencingEpoch,
          evidence: { nodeId: row.primary_node_id, authority: 'kubernetes', absenceConfirmed: sourceHealth.snapshot_complete === true },
        });
      }
      const outcomes = [];
      for (const signal of signals) {
        const fingerprint = incidentFingerprint(signal);
        const current = byFingerprint.get(fingerprint) || null;
        const next = deriveIncidentTransition(current && {
          ...current, incidentId: current.incident_id, transitionSequence: current.transition_sequence,
          lastObservedAt: current.last_observed_at, recoveringAt: current.recovering_at,
        }, signal, { activationCount: 1, resolveStableMs: 30000 });
        const impacts = boundedImpactTraversal(signal.primaryNodeId, relationResult.rows.map((r) => ({
          fromNodeId: r.from_node_id, toNodeId: r.to_node_id, relationType: r.relation_type,
        })), { maxDepth: 8, maxNodes: 1000 }).impacts;
        const envelope = transitionEnvelope(current && { incidentId: current.incident_id, transitionSequence: current.transition_sequence }, next, signal, impacts);
        if (!envelope) continue;
        const result = await client.query(`SELECT * FROM oaa.transition_incident(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19
        )`, [this.clusterId, fencingEpoch, fingerprint, signal.incidentType, next.status, next.severity, next.confidence,
          next.causeStatus, signal.causeCode, signal.title, signal.primaryNodeId, RULE_REVISION, signal.summary,
          next.reasonCode, envelope.evidenceDigest, envelope.eventType, JSON.stringify(envelope.payload), signal.receivedAt,
          signal.freshAuthorityWatermark]);
        const transitioned = result.rows[0];
        if (signal.incidentType === 'digest_drift') {
          const epistemicState = signal.sourceFresh && signal.snapshotComplete ? 'known' : 'stale';
          const actualDigest = digest([...(signal.evidence?.actualImageDigests || [])].sort());
          if (signal.present) {
            await client.query(`INSERT INTO oaa.mismatch(
              incident_id,cluster_id,subject_node_id,mismatch_type,epistemic_state,
              expected_digest,actual_digest,evidence_digest,detected_at
            ) VALUES($1,$2,$3,'exact_image_digest',$4,$5,$6,$7,$8)
            ON CONFLICT(cluster_id,subject_node_id,mismatch_type) WHERE resolved_at IS NULL
            DO UPDATE SET incident_id=EXCLUDED.incident_id,epistemic_state=EXCLUDED.epistemic_state,
              expected_digest=EXCLUDED.expected_digest,actual_digest=EXCLUDED.actual_digest,
              evidence_digest=EXCLUDED.evidence_digest`, [
              transitioned?.incident_id || current?.incident_id || null, this.clusterId,
              signal.primaryNodeId, epistemicState, signal.evidence.desiredDigest,
              actualDigest, envelope.evidenceDigest, signal.receivedAt,
            ]);
          } else if (signal.sourceFresh && signal.snapshotComplete) {
            await client.query(`UPDATE oaa.mismatch SET resolved_at=$4,epistemic_state='known'
              WHERE cluster_id=$1 AND subject_node_id=$2 AND mismatch_type='exact_image_digest'
                AND resolved_at IS NULL AND expected_digest=$3`, [
              this.clusterId, signal.primaryNodeId, signal.evidence.desiredDigest, signal.receivedAt,
            ]);
          }
        }
        if (transitioned?.incident_id) {
          for (const impact of impacts) {
            await client.query('SELECT oaa.attach_incident_impact($1,$2,$3,$4,$5,$6,$7,$8)', [
              this.clusterId, fencingEpoch, transitioned.incident_id, impact.nodeId,
              impact.impactType, impact.distance, impact.confidence, impact.pathDigest,
            ]);
          }
          const evidence = await client.query(`SELECT observation_id,received_at FROM oaa.observation
            WHERE cluster_id=$1 AND subject_node_id=$2 ORDER BY received_at DESC LIMIT 1`, [this.clusterId, signal.primaryNodeId]);
          if (evidence.rows[0]?.observation_id) {
            await client.query('SELECT oaa.attach_incident_evidence($1,$2,$3,$4,$5,$6,0)', [
              this.clusterId, fencingEpoch, transitioned.incident_id,
              evidence.rows[0].observation_id, evidence.rows[0].received_at,
              signal.causeStatus === 'confirmed' ? 'confirms' : 'supports',
            ]);
          }
        }
        outcomes.push(transitioned);
      }
      return outcomes;
    } finally { client.release(); }
  }
}

function projectNodeForActor(row, actor) {
  const privileged = actor?.groups?.includes('console-admins') || actor?.groups?.includes('console-operators');
  const attributes = privileged ? sanitizeOperationalValue(row.attributes || {}) : {};
  return {
    clusterId: row.cluster_id, nodeId: row.node_id, nodeType: row.node_type, canonicalId: row.canonical_id,
    displayName: row.display_name, namespace: row.namespace, authority: row.authority, health: row.health,
    epistemicState: row.epistemic_state, observedAt: row.observed_at, expiresAt: row.expires_at,
    sourceRevision: privileged ? row.source_revision : null, attributes,
  };
}

class OperationalQueryService {
  constructor(pool, options = {}) { this.pool = pool; this.clusterId = options.clusterId || DEFAULT_CLUSTER; }

  async status() {
    const [sources, nodes, incidents, fence] = await Promise.all([
      this.pool.query('SELECT * FROM oaa.source_health WHERE cluster_id=$1 ORDER BY source', [this.clusterId]),
      this.pool.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE epistemic_state='known' AND expires_at>clock_timestamp())::int AS fresh,max(observed_at) AS observed_at FROM oaa.resource_node WHERE cluster_id=$1 AND deleted_at IS NULL", [this.clusterId]),
      this.pool.query("SELECT count(*) FILTER(WHERE status IN('detected','active','recovering'))::int AS active,max(CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END)::int AS severity_rank FROM oaa.incident WHERE cluster_id=$1", [this.clusterId]),
      this.pool.query('SELECT fencing_epoch,collector_id,lease_expires_at,heartbeat_at FROM oaa.observer_fence WHERE cluster_id=$1', [this.clusterId]),
    ]);
    const row = nodes.rows[0] || {};
    return { clusterId: this.clusterId, graph: { total: Number(row.total || 0), fresh: Number(row.fresh || 0), observedAt: row.observed_at || null }, sources: sources.rows, risk: { active: Number(incidents.rows[0]?.active || 0), severityRank: Number(incidents.rows[0]?.severity_rank || 0) }, observer: fence.rows[0] || null };
  }

  async graph(actor, filters = {}) {
    const limit = Math.max(1, Math.min(1000, Number(filters.limit || 250)));
    const values = [this.clusterId, limit];
    const result = await this.pool.query(`SELECT * FROM oaa.resource_node WHERE cluster_id=$1 AND deleted_at IS NULL
      ${filters.namespace ? `AND namespace=$${values.push(String(filters.namespace))}` : ''}
      ORDER BY namespace,node_type,display_name LIMIT $2`, values);
    const nodeIds = result.rows.map((row) => row.node_id);
    const relations = nodeIds.length ? await this.pool.query(`SELECT * FROM oaa.resource_relation WHERE cluster_id=$1 AND deleted_at IS NULL AND from_node_id=ANY($2::text[]) AND to_node_id=ANY($2::text[])`, [this.clusterId, nodeIds]) : { rows: [] };
    return { nodes: result.rows.map((row) => projectNodeForActor(row, actor)), relations: relations.rows.map((row) => ({ fromNodeId: row.from_node_id, relationType: row.relation_type, toNodeId: row.to_node_id, confidence: row.confidence, evidenceRef: row.evidence_ref })) };
  }

  async node(nodeId, actor) {
    const row = await this.pool.query('SELECT * FROM oaa.resource_node WHERE cluster_id=$1 AND node_id=$2 AND deleted_at IS NULL', [this.clusterId, nodeId]);
    if (!row.rows[0]) return null;
    const relations = await this.pool.query(`SELECT * FROM oaa.resource_relation
      WHERE cluster_id=$1 AND deleted_at IS NULL AND (from_node_id=$2 OR to_node_id=$2)
      ORDER BY relation_type,from_node_id,to_node_id`, [this.clusterId, nodeId]);
    return { node: projectNodeForActor(row.rows[0], actor), relations: relations.rows.map((item) => ({ fromNodeId: item.from_node_id, relationType: item.relation_type, toNodeId: item.to_node_id, confidence: item.confidence, evidenceRef: item.evidence_ref })) };
  }

  async incidents(actor, options = {}) {
    const limit = Math.max(1, Math.min(200, Number(options.limit || 100)));
    const rows = await this.pool.query(`SELECT i.*,coalesce(jsonb_agg(DISTINCT jsonb_build_object('nodeId',ip.node_id,'impactType',ip.impact_type,'distance',ip.distance,'confidence',ip.confidence)) FILTER(WHERE ip.node_id IS NOT NULL),'[]'::jsonb) AS impacts
      FROM oaa.incident i LEFT JOIN oaa.incident_impact ip ON ip.incident_id=i.incident_id
      WHERE i.cluster_id=$1 ${options.status ? 'AND i.status=$3' : ''}
      GROUP BY i.incident_id ORDER BY i.updated_at DESC LIMIT $2`, options.status ? [this.clusterId, limit, String(options.status)] : [this.clusterId, limit]);
    return rows.rows.map((row) => ({ incidentId: row.incident_id, type: row.incident_type, status: row.status, severity: row.severity, confidence: Number(row.confidence), causeStatus: row.cause_status, causeCode: row.cause_code, title: row.title, summary: row.summary, primaryNodeId: row.primary_node_id, transitionSequence: Number(row.transition_sequence), firstDetectedAt: row.first_detected_at, lastObservedAt: row.last_observed_at, impacts: row.impacts }));
  }

  async incident(id, actor) {
    const incident = await this.pool.query('SELECT * FROM oaa.incident WHERE incident_id=$1 AND cluster_id=$2', [id, this.clusterId]);
    if (!incident.rows[0]) return null;
    const [timeline, evidence, impacts] = await Promise.all([
      this.pool.query('SELECT * FROM oaa.incident_timeline WHERE incident_id=$1 ORDER BY sequence', [id]),
      this.pool.query(`SELECT ie.evidence_role,o.observation_id,o.observation_type,o.severity,o.fact,o.evidence_ref,o.observed_at FROM oaa.incident_evidence ie JOIN oaa.observation o ON o.observation_id=ie.observation_id AND o.received_at=ie.observation_received_at WHERE ie.incident_id=$1 ORDER BY ie.rank`, [id]),
      this.pool.query('SELECT * FROM oaa.incident_impact WHERE incident_id=$1 ORDER BY distance,node_id', [id]),
    ]);
    return { ...(await this.incidents(actor, { limit: 200 })).find((item) => item.incidentId === id), timeline: timeline.rows, evidence: evidence.rows.map((row) => ({ ...row, fact: sanitizeOperationalValue(row.fact) })), impacts: impacts.rows };
  }

  async context(route, actor) {
    const normalized = String(route || '/').slice(0, 500);
    const incidents = await this.incidents(actor, { limit: 100 });
    const tokens = normalized.split('/').filter(Boolean);
    return { route: normalized, incidents: incidents.filter((item) => tokens.length === 0 || tokens.some((token) => `${item.title} ${item.summary}`.toLowerCase().includes(token.toLowerCase()))), epistemicState: incidents.length ? 'known' : 'unknown' };
  }

  async metacognition(options = {}) {
    const limit = Math.max(1, Math.min(200, Number(options.limit || 100)));
    const [model, mismatches, remediations] = await Promise.all([
      this.pool.query('SELECT * FROM oaa.self_model WHERE cluster_id=$1', [this.clusterId]),
      this.pool.query(`SELECT m.*,a.assessment_id,a.minimum_ladder_step,a.lower_steps,
          a.engineering_required,a.rationale,a.policy_revision,a.created_at AS assessed_at
        FROM oaa.mismatch m
        LEFT JOIN LATERAL (
          SELECT * FROM oaa.remediation_assessment ra WHERE ra.mismatch_id=m.mismatch_id
          ORDER BY ra.created_at DESC LIMIT 1
        ) a ON true
        WHERE m.cluster_id=$1 ORDER BY m.resolved_at NULLS FIRST,m.detected_at DESC LIMIT $2`, [this.clusterId, limit]),
      this.pool.query(`SELECT er.*,be.build_evidence_id,be.source_revision,be.image_digests,
          dv.verification_id,dv.status AS deployment_status,dv.verified_at
        FROM oaa.engineering_remediation_request er
        JOIN oaa.remediation_assessment ra ON ra.assessment_id=er.assessment_id
        JOIN oaa.mismatch m ON m.mismatch_id=ra.mismatch_id
        LEFT JOIN LATERAL (SELECT * FROM oaa.build_evidence b WHERE b.remediation_request_id=er.remediation_request_id ORDER BY b.created_at DESC LIMIT 1) be ON true
        LEFT JOIN LATERAL (SELECT * FROM oaa.deployment_verification d WHERE d.remediation_request_id=er.remediation_request_id ORDER BY d.verified_at DESC LIMIT 1) dv ON true
        WHERE m.cluster_id=$1 ORDER BY er.updated_at DESC LIMIT $2`, [this.clusterId, limit]),
    ]);
    const self = model.rows[0];
    return {
      clusterId: this.clusterId,
      selfModel: self ? {
        observerState: self.observer_state, graphState: self.graph_state,
        incidentState: self.incident_state, operationState: self.operation_state,
        remediationState: self.remediation_state, coverage: Number(self.coverage),
        blockers: self.blockers || [], capabilityRevision: self.capability_revision,
        observedAt: self.observed_at,
      } : null,
      mismatches: mismatches.rows.map((row) => ({
        mismatchId: row.mismatch_id, incidentId: row.incident_id, subjectNodeId: row.subject_node_id,
        mismatchType: row.mismatch_type, epistemicState: row.epistemic_state,
        expectedDigest: row.expected_digest, actualDigest: row.actual_digest,
        evidenceDigest: row.evidence_digest, detectedAt: row.detected_at, resolvedAt: row.resolved_at,
        assessment: row.assessment_id ? {
          assessmentId: row.assessment_id, minimumLadderStep: row.minimum_ladder_step,
          lowerSteps: row.lower_steps, engineeringRequired: row.engineering_required,
          rationale: row.rationale, policyRevision: row.policy_revision, assessedAt: row.assessed_at,
        } : null,
      })),
      remediations: remediations.rows.map((row) => ({
        remediationRequestId: row.remediation_request_id, assessmentId: row.assessment_id,
        incidentId: row.incident_id, operationId: row.operation_id, repository: row.repository,
        baseRevision: row.base_revision, allowedPaths: row.allowed_paths, patchDigest: row.patch_digest,
        reason: row.reason, riskLevel: row.risk_level, affectedComponents: row.affected_components,
        affectedImages: row.affected_images, requiredTests: row.required_tests,
        releaseScope: row.release_scope, targetChannel: row.target_channel,
        buildAuthority: row.build_authority, stage: row.stage,
        approvalExpiresAt: row.approval_expires_at, updatedAt: row.updated_at,
        buildEvidence: row.build_evidence_id ? { buildEvidenceId: row.build_evidence_id, sourceRevision: row.source_revision, imageDigests: row.image_digests } : null,
        deploymentVerification: row.verification_id ? { verificationId: row.verification_id, status: row.deployment_status, verifiedAt: row.verified_at } : null,
      })),
    };
  }
}

class OperationalIntelligenceRuntime {
  constructor(options) {
    this.enabled = options.enabled === true;
    this.graphEnabled = options.graphEnabled === true;
    this.incidentEnabled = options.incidentEnabled === true;
    this.elector = options.elector;
    this.collect = options.collect;
    this.store = options.store;
    this.incidents = options.incidents;
    this.operationEnabled = options.operationEnabled === true;
    this.ownerAvailable = options.ownerAvailable === true;
    this.remediationEnabled = options.remediationEnabled === true;
    this.r3Available = options.r3Available === true;
    this.queue = new BoundedCoalescingQueue(options.queueLimit || 2000);
    this.fencingEpoch = 0;
    this.running = false;
    this.lastResult = null;
  }

  async tick() {
    if (!this.enabled || this.running) return { skipped: true, reason: !this.enabled ? 'disabled' : 'running' };
    this.running = true;
    try {
      const lease = await this.elector.acquire();
      if (!lease.acquired) return { skipped: true, reason: lease.reason };
      if (!this.fencingEpoch) this.fencingEpoch = await this.store.claimFence(lease.leaseIdentity);
      else if (!await this.store.renewFence(this.fencingEpoch)) this.fencingEpoch = await this.store.claimFence(lease.leaseIdentity);
      const inventory = await this.collect();
      const expected = Math.max(1, Number(inventory.expectedScopeCount || 0));
      const coverage = Math.max(0, Math.min(1, Number(inventory.completedScopeCount || 0) / expected));
      const modelInput = {
        observerEnabled: this.enabled, leader: true,
        sourceLagging: !inventory.snapshotComplete || (inventory.sources || []).some((source) => source.configured !== false && (source.epistemicState !== 'known' || source.snapshotComplete !== true)),
        snapshotComplete: inventory.snapshotComplete === true, coverage,
        ownerAvailable: this.ownerAvailable, incidentEnabled: this.incidentEnabled,
        operationEnabled: this.operationEnabled, remediationEnabled: this.remediationEnabled,
        r3Available: this.r3Available,
      };
      if (!inventory.snapshotComplete) {
        await this.store.recordSelfModel?.(modelInput, inventory.observedAt);
        this.lastResult = { degraded: true, reason: 'incomplete_snapshot', completedScopeCount: inventory.completedScopeCount, expectedScopeCount: inventory.expectedScopeCount };
        return this.lastResult;
      }
      const graph = this.graphEnabled ? await this.store.reconcile(inventory, this.fencingEpoch) : null;
      const incidentTransitions = this.incidentEnabled && graph ? await this.incidents.correlate(this.fencingEpoch) : [];
      const model = await this.store.recordSelfModel?.(modelInput, inventory.observedAt);
      this.lastResult = { degraded: false, graph, incidentTransitions: incidentTransitions.length, fencingEpoch: this.fencingEpoch, selfModel: model || null };
      return this.lastResult;
    } finally { this.running = false; }
  }
}

module.exports = {
  RULE_REVISION, leaseBody, leaseExpired, KubernetesLeaseElector, OperationalGraphStore,
  correlationSignals, IncidentRuntime, projectNodeForActor, OperationalQueryService,
  OperationalIntelligenceRuntime, graphCoverage, reconcileCompletenessDigest,
};
