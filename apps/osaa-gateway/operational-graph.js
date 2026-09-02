'use strict';

const { createHash } = require('crypto');

const RELATION_TYPES = Object.freeze(new Set([
  'owns', 'contains', 'selects', 'serves', 'routes_to', 'depends_on',
  'optionally_depends_on', 'declares', 'realizes', 'observes', 'affects', 'executed_by',
]));
const EPISTEMIC_STATES = Object.freeze(new Set([
  'known', 'unknown', 'stale', 'conflicting', 'inferred', 'unobservable',
]));
const FORBIDDEN_KEYS = /^(data|stringData|env|envFrom|token|password|secret|credentials?|authorization|cookie|privateKey|clientSecret)$/i;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function sanitizeOperationalValue(value, depth = 0) {
  if (depth > 8) return '[depth-limited]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 1000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeOperationalValue(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 1000);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    if (FORBIDDEN_KEYS.test(key)) continue;
    out[key] = sanitizeOperationalValue(item, depth + 1);
  }
  return out;
}

function canonicalNodeId(clusterId, authority, kind, namespace, name, authorityUid = '') {
  const cluster = String(clusterId || '').trim();
  const source = String(authority || '').trim();
  const type = String(kind || '').trim();
  const ns = String(namespace || '').trim();
  const resourceName = String(name || '').trim();
  const uid = String(authorityUid || '').trim();
  if (!cluster || !source || !type || !resourceName) throw new Error('node identity fields are required');
  if (source === 'kubernetes' && !uid) throw new Error('Kubernetes authority UID is required');
  return `${source}://${cluster}/${encodeURIComponent(type)}/${encodeURIComponent(ns)}/${encodeURIComponent(uid || resourceName)}`;
}

function runtimeRowToNode(row, context) {
  const payload = sanitizeOperationalValue(row.payload || {});
  const metadata = payload.metadata || {};
  const authority = String(row.source || 'unknown');
  const authorityUid = String(row.authority_uid || metadata.uid || (authority === 'kubernetes' ? '' : `${row.kind}/${row.namespace || ''}/${row.name}`));
  const nodeId = canonicalNodeId(context.clusterId, authority, row.kind, row.namespace || '', row.name, authorityUid);
  const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at || context.expiresAt);
  const observedAt = row.observed_at instanceof Date ? row.observed_at.toISOString() : String(row.observed_at || context.observedAt);
  return {
    clusterId: context.clusterId,
    nodeId,
    nodeType: String(row.kind),
    canonicalId: authority === 'kubernetes'
      ? `k8s://${context.clusterId}/${row.kind}/${row.namespace || ''}/${row.name}`
      : `${authority}://${context.clusterId}/${row.kind}/${row.namespace || ''}/${row.name}`,
    authority,
    authorityUid,
    displayName: String(row.name),
    namespace: String(row.namespace || ''),
    ownerRef: metadata.ownerReferences?.[0] ? `${metadata.ownerReferences[0].kind}/${metadata.ownerReferences[0].name}` : null,
    health: String(row.health || 'Unknown'),
    epistemicState: Date.parse(expiresAt) > Date.now() ? 'known' : 'stale',
    attributes: payload,
    fencingEpoch: context.fencingEpoch,
    collectionEpoch: context.collectionEpoch,
    streamSequence: row.stream_sequence == null ? null : Number(row.stream_sequence),
    sourceRevision: row.resource_version || row.source_revision || null,
    reconcileSessionId: context.reconcileSessionId,
    snapshotComplete: Boolean(context.snapshotComplete),
    observedAt,
    expiresAt,
  };
}

function relationKey(relation) {
  return [relation.clusterId, relation.fromNodeId, relation.relationType, relation.toNodeId, relation.authority].join('|');
}

function buildRelations(nodes, context) {
  const byAlias = new Map();
  for (const node of nodes) byAlias.set(`${node.nodeType.toLowerCase()}|${node.namespace}|${node.displayName}`, node);
  const relations = new Map();
  for (const node of nodes) {
    const owners = node.attributes?.metadata?.ownerReferences || [];
    for (const owner of owners) {
      const target = byAlias.get(`${String(owner.kind || '').toLowerCase()}|${node.namespace}|${owner.name || ''}`);
      if (!target) continue;
      const relation = graphRelation(node, 'owned_by', target, context);
      // The persisted vocabulary expresses the owner direction.
      relation.fromNodeId = target.nodeId;
      relation.relationType = 'owns';
      relation.toNodeId = node.nodeId;
      relations.set(relationKey(relation), relation);
    }
    if (node.namespace) {
      const namespaceNode = byAlias.get(`namespace||${node.namespace}`);
      if (namespaceNode) {
        const relation = graphRelation(namespaceNode, 'contains', node, context);
        relations.set(relationKey(relation), relation);
      }
    }
  }
  return [...relations.values()];
}

function graphRelation(from, relationType, to, context) {
  if (relationType === 'owned_by') relationType = 'owns';
  if (!RELATION_TYPES.has(relationType)) throw new Error(`unsupported relation type ${relationType}`);
  if (from.nodeId === to.nodeId) throw new Error('self relation is not allowed');
  return {
    clusterId: context.clusterId,
    fromNodeId: from.nodeId,
    relationType,
    toNodeId: to.nodeId,
    authority: 'materializer',
    confidence: 'confirmed',
    evidenceRef: `node:${from.nodeId}@${from.sourceRevision || 'unknown'}=>node:${to.nodeId}@${to.sourceRevision || 'unknown'}`,
    fencingEpoch: context.fencingEpoch,
    collectionEpoch: context.collectionEpoch,
    sourceRevision: context.sourceRevision || null,
    reconcileSessionId: context.reconcileSessionId,
    observedAt: context.observedAt,
    expiresAt: context.expiresAt,
  };
}

function compareProjectionVersion(current, incoming) {
  for (const field of ['fencingEpoch', 'collectionEpoch', 'streamSequence']) {
    const a = current?.[field] == null ? -1 : Number(current[field]);
    const b = incoming?.[field] == null ? -1 : Number(incoming[field]);
    if (a !== b) return Math.sign(b - a);
  }
  return 0;
}

class CompleteReconcileBarrier {
  constructor(expectedScopes) {
    this.expected = new Set(expectedScopes);
    this.complete = new Set();
    this.failed = new Set();
  }
  mark(scope, result) {
    if (!this.expected.has(scope)) throw new Error(`unexpected reconcile scope ${scope}`);
    if (result === true) { this.complete.add(scope); this.failed.delete(scope); }
    else { this.failed.add(scope); this.complete.delete(scope); }
  }
  get snapshotComplete() { return this.failed.size === 0 && this.complete.size === this.expected.size; }
  assertComplete() {
    if (!this.snapshotComplete) throw new Error(`incomplete reconcile barrier ${this.complete.size}/${this.expected.size}`);
    return true;
  }
}

class BoundedCoalescingQueue {
  constructor(limit = 1000) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('queue limit must be positive');
    this.limit = limit;
    this.items = new Map();
    this.order = [];
    this.dropped = 0;
    this.lagging = false;
  }
  push(key, value, priority = 'normal') {
    if (this.items.has(key)) { this.items.set(key, { value, priority }); return { coalesced: true, dropped: false }; }
    if (this.order.length >= this.limit) {
      const removable = this.order.findIndex((candidate) => this.items.get(candidate)?.priority !== 'high');
      if (removable < 0 && priority !== 'high') { this.dropped += 1; this.lagging = true; return { coalesced: false, dropped: true }; }
      const index = removable < 0 ? 0 : removable;
      const removed = this.order.splice(index, 1)[0];
      this.items.delete(removed);
      this.dropped += 1;
      this.lagging = true;
    }
    this.order.push(key); this.items.set(key, { value, priority });
    return { coalesced: false, dropped: false };
  }
  shift() {
    const key = this.order.shift();
    if (key == null) return null;
    const item = this.items.get(key); this.items.delete(key);
    return { key, ...item };
  }
  get size() { return this.order.length; }
}

function graphCoverage(nodes, canonicalComponents, mandatoryRelations = []) {
  const realized = new Set(nodes.map((node) => node.canonicalId));
  const componentMissing = canonicalComponents.filter((id) => !realized.has(id));
  const relationKeys = new Set(mandatoryRelations.filter((item) => item.present).map((item) => item.key));
  const dangling = mandatoryRelations.filter((item) => !relationKeys.has(item.key)).map((item) => item.key);
  return {
    denominator: canonicalComponents.length,
    matched: canonicalComponents.length - componentMissing.length,
    coverage: canonicalComponents.length ? (canonicalComponents.length - componentMissing.length) / canonicalComponents.length : 1,
    componentMissing,
    dangling,
  };
}

module.exports = {
  RELATION_TYPES, EPISTEMIC_STATES, stableJson, digest, sanitizeOperationalValue,
  canonicalNodeId, runtimeRowToNode, buildRelations, graphRelation, compareProjectionVersion,
  CompleteReconcileBarrier, BoundedCoalescingQueue, graphCoverage,
};
