'use strict';

const { createHash } = require('crypto');

const TERMINAL = new Set([
  'succeeded', 'failed', 'verification_failed', 'inconclusive',
  'authorization_expired', 'preflight_blocked', 'cancelled', 'timed_out', 'rolled_back',
]);

const PHASE_TRANSITIONS = Object.freeze({
  accepted: new Set(['awaiting_approval', 'claimed', 'cancelled', 'timed_out']),
  awaiting_approval: new Set(['claimed', 'cancelled', 'timed_out']),
  claimed: new Set(['preflighting', 'timed_out']),
  preflighting: new Set(['executing', 'authorization_expired', 'preflight_blocked', 'timed_out']),
  executing: new Set(['verifying', 'ambiguous', 'failed', 'timed_out']),
  ambiguous: new Set(['reconciling', 'failed', 'timed_out']),
  reconciling: new Set(['verifying', 'failed', 'inconclusive', 'timed_out']),
  verifying: new Set(['succeeded', 'verification_failed', 'inconclusive', 'rolling_back', 'timed_out']),
  rolling_back: new Set(['rolled_back', 'failed', 'inconclusive']),
});

const DESCRIPTORS = Object.freeze({
  'restart-workload': Object.freeze({
    descriptorId: 'opensphere.workload.restart', revision: '1', toolId: 'owner.workload.restart',
    verifierId: 'authority.workload.rollout', riskClass: 'R1', assurance: 'aal1',
    targetKind: 'Deployment', confirmationTemplate: 'restart <kind> <namespace>/<name>',
    ownerRoute: 'cluster-manager/workloads', allowedNamespaces: ['opensphere-*'],
    permission: 'oaa.action.execute.high',
  }),
  'scale-workload': Object.freeze({
    descriptorId: 'opensphere.workload.scale', revision: '1', toolId: 'owner.workload.scale',
    verifierId: 'authority.workload.replicas', riskClass: 'R1', assurance: 'aal1',
    targetKind: 'Deployment', confirmationTemplate: 'scale <kind> <namespace>/<name> to <replicas>',
    ownerRoute: 'cluster-manager/workloads', allowedNamespaces: ['opensphere-*'], permission: 'oaa.action.execute.high',
  }),
  'rollback-image': Object.freeze({
    descriptorId: 'opensphere.release.rollback', revision: '1', toolId: 'owner.release.rollback',
    verifierId: 'authority.release.exact-digest', riskClass: 'R2', assurance: 'aal2',
    targetKind: 'Deployment', confirmationTemplate: 'rollback image <kind> <namespace>/<name> container <container> to <image>',
    ownerRoute: 'foundation/platform-release', allowedNamespaces: ['opensphere-*'],
    permission: 'oaa.action.execute.high',
  }),
  'run-cronjob': Object.freeze({
    descriptorId: 'opensphere.cronjob.run', revision: '1', toolId: 'owner.cronjob.run-once',
    verifierId: 'authority.job.completed', riskClass: 'R2', assurance: 'aal2',
    targetKind: 'CronJob', confirmationTemplate: 'run cronjob <namespace>/<name>',
    ownerRoute: 'cluster-manager/workloads', allowedNamespaces: ['opensphere-*'],
    permission: 'oaa.action.execute.high',
  }),
  'owner-recover': Object.freeze({
    descriptorId: 'opensphere.owner.recover', revision: '1', toolId: 'owner.recovery.execute',
    verifierId: 'owner.recovery.postcondition', riskClass: 'R2', assurance: 'aal2',
    targetKind: 'Capability', confirmationTemplate: 'recover HIS <name>',
    ownerRoute: 'cluster-manager/his', allowedNamespaces: [''],
    permission: 'oaa.action.execute.high',
  }),
  'retry-delivery': Object.freeze({
    descriptorId: 'opensphere.notification.retry', revision: '1', toolId: 'owner.notification.retry',
    verifierId: 'owner.notification.delivery', riskClass: 'R2', assurance: 'aal2',
    targetKind: 'NotificationDelivery', confirmationTemplate: 'retry notification delivery <name>',
    ownerRoute: 'owner/notifications', allowedNamespaces: [''],
    permission: 'console.notification.manage',
  }),
  'create-postgres-cluster': Object.freeze({
    descriptorId: 'foundation.postgres.cluster.create', revision: '1', toolId: 'owner.foundation.postgres.create',
    verifierId: 'owner.foundation.postgres.ready', riskClass: 'R2', assurance: 'aal2',
    targetKind: 'FoundationClaim',
    confirmationTemplate: 'create PostgreSQL cluster <namespace>/<name> plan <plan> version <postgresVersion>',
    ownerRoute: 'foundation/postgres', allowedNamespaces: ['opensphere-*'],
    permission: 'oaa.action.execute.high',
  }),
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function exactConfirmation(descriptor, target) {
  return descriptor.confirmationTemplate
    .replace(/<kind>/g, String(target.kind || '').toLowerCase())
    .replace(/<namespace>/g, String(target.namespace || ''))
    .replace(/<name>/g, String(target.name || ''))
    .replace(/<container>/g, String(target.container || ''))
    .replace(/<image>/g, String(target.image || ''))
    .replace(/<uid>/g, String(target.uid || ''))
    .replace(/<digest>/g, String(target.digest || ''))
    .replace(/<revision>/g, String(target.desiredRevision || ''))
    .replace(/<replicas>/g, String(target.replicas ?? ''))
    .replace(/<plan>/g, String(target.request?.plan || ''))
    .replace(/<postgresVersion>/g, String(target.request?.postgresVersion || ''));
}

function namespaceAllowed(namespace, patterns) {
  return patterns.some((pattern) => {
    if (pattern === '') return namespace === '';
    if (pattern.endsWith('*')) return namespace.startsWith(pattern.slice(0, -1));
    return namespace === pattern;
  });
}

/**
 * Deterministic binder. Evidence is deliberately not accepted as an input: only
 * the authenticated user's request and the release-bound descriptor can select
 * an owner route, tool, verifier, target or confirmation.
 */
function planOperation(request, registry = DESCRIPTORS) {
  const action = String(request?.action || '');
  const descriptor = registry[action];
  if (!descriptor) throw Object.assign(new Error('unsupported management action'), { code: 'DescriptorNotFound' });
  const target = request?.target || {};
  for (const field of ['kind', 'name', 'uid']) {
    if (!String(target[field] || '').trim()) throw Object.assign(new Error(`exact target ${field} is required`), { code: 'TargetIncomplete' });
  }
  if (String(target.kind) !== descriptor.targetKind) throw Object.assign(new Error('target kind is not permitted'), { code: 'TargetKindMismatch' });
  if (!namespaceAllowed(String(target.namespace || ''), descriptor.allowedNamespaces)) {
    throw Object.assign(new Error('target namespace is not permitted'), { code: 'NamespaceDenied' });
  }
  if (action === 'rollback-image' && !/^sha256:[0-9a-f]{64}$/.test(String(target.digest || ''))) {
    throw Object.assign(new Error('rollback requires an exact image digest'), { code: 'ExactDigestRequired' });
  }
  if (action === 'rollback-image' && (!String(target.container || '') || !String(target.image || '').endsWith(`@${String(target.digest)}`))) {
    throw Object.assign(new Error('rollback requires container and repository@exact-digest image'), { code: 'ExactImageRequired' });
  }
  if (action === 'scale-workload' && (!Number.isInteger(Number(target.replicas)) || Number(target.replicas) < 0 || Number(target.replicas) > 50)) {
    throw Object.assign(new Error('scale requires replicas between 0 and 50'), { code: 'ReplicaTargetRequired' });
  }
  if (action === 'owner-recover' && !String(target.desiredRevision || '')) {
    throw Object.assign(new Error('owner recovery requires a desired revision'), { code: 'DesiredRevisionRequired' });
  }
  if (action === 'create-postgres-cluster') {
    const request = target.request || {};
    for (const field of ['name', 'namespace', 'alias', 'database', 'owner', 'plan', 'postgresVersion', 'deletionPolicy']) {
      if (!String(request[field] || '').trim()) throw Object.assign(new Error(`PostgreSQL request ${field} is required`), { code: 'PostgresRequestIncomplete' });
    }
    if (request.name !== target.name || request.namespace !== target.namespace) {
      throw Object.assign(new Error('PostgreSQL request target does not match the resolved FoundationClaim'), { code: 'PostgresTargetMismatch' });
    }
    if (!String(target.resourceVersion || '')) {
      throw Object.assign(new Error('PostgreSQL owner target revision is required'), { code: 'TargetRevisionRequired' });
    }
  }
  const expected = exactConfirmation(descriptor, target);
  const immutableDescriptor = { ...descriptor };
  return {
    action,
    descriptorId: descriptor.descriptorId,
    descriptorRevision: descriptor.revision,
    descriptorDigest: digest(immutableDescriptor),
    toolId: descriptor.toolId,
    verifierId: descriptor.verifierId,
    ownerRoute: descriptor.ownerRoute,
    riskClass: descriptor.riskClass,
    requiredAssurance: descriptor.assurance,
    requiredPermission: descriptor.permission,
    expectedConfirmation: expected,
    target: {
      kind: String(target.kind), namespace: String(target.namespace || ''), name: String(target.name),
      uid: String(target.uid), generation: target.generation == null ? null : Number(target.generation),
      resourceVersion: target.resourceVersion == null ? null : String(target.resourceVersion),
      desiredRevision: target.desiredRevision == null ? null : String(target.desiredRevision),
      digest: target.digest == null ? null : String(target.digest),
      image: target.image == null ? null : String(target.image), container: target.container == null ? null : String(target.container),
      replicas: target.replicas == null ? null : Number(target.replicas),
      request: target.request == null ? null : JSON.parse(JSON.stringify(target.request)),
    },
  };
}

function bindOperation(request, registry = DESCRIPTORS) {
  const planned = planOperation(request, registry);
  const expected = planned.expectedConfirmation;
  if (!String(request.confirmation || '') || String(request.confirmation) !== expected) {
    throw Object.assign(new Error('human-supplied exact confirmation does not match'), { code: 'ExactConfirmationRequired', expected });
  }
  if (String(request.reason || '').trim().length < 8) {
    throw Object.assign(new Error('reason must contain at least eight characters'), { code: 'ReasonRequired' });
  }
  return {
    ...planned,
    reason: String(request.reason).trim(),
    confirmationDigest: digest(String(request.confirmation)),
  };
}

function expectedPostcondition(operation) {
  const target = operation.target;
  const common = { verifierId: operation.verifierId, targetUid: target.uid };
  switch (operation.verifierId) {
    case 'authority.workload.rollout':
      return { ...common, generationGreaterThan: target.generation };
    case 'authority.workload.replicas':
      return { ...common, replicas: target.replicas, generationAtLeast: target.generation };
    case 'authority.release.exact-digest':
      return { ...common, container: target.container, exactDigest: target.digest };
    case 'authority.job.completed':
      return { ...common, ownerReceiptRequired: true, terminalCondition: 'Complete' };
    case 'owner.recovery.postcondition':
      return { ...common, desiredRevision: target.desiredRevision, allowedStates: ['ready', 'deployed', 'healthy'] };
    case 'owner.notification.delivery':
      return { ...common, allowedStates: ['accepted', 'delivered'] };
    case 'owner.foundation.postgres.ready':
      return { ...common, foundationClaim: { phase: 'Bound', observedGenerationMatches: true },
        postgresClaim: { ready: true, observedGenerationMatches: true }, sgClusterReady: true, bindingSecretIssued: true };
    default:
      throw Object.assign(new Error('descriptor verifier has no closed postcondition'), { code: 'PostconditionNotRegistered' });
  }
}

function authorizeAtExecution(operation, session, approvals = []) {
  if (!session?.active || String(session.actorId) !== String(operation.actorId)) {
    return { allowed: false, phase: 'authorization_expired', code: 'AuthorizationExpired' };
  }
  if (String(session.authzRevision || '') !== String(operation.authzRevision || '')) {
    return { allowed: false, phase: 'authorization_expired', code: 'AuthorizationRevisionChanged' };
  }
  if (!new Set(session.permissions || []).has(operation.requiredPermission || `r2d2:${operation.action}`)) {
    return { allowed: false, phase: 'preflight_blocked', code: 'PermissionDenied' };
  }
  if (operation.requiredAssurance === 'aal2' && session.assurance !== 'aal2') {
    return { allowed: false, phase: 'authorization_expired', code: 'AssuranceExpired' };
  }
  const activeApprovers = [...new Set(approvals.filter((item) => !item.revokedAt && item.assurance === 'aal2').map((item) => String(item.approverId)))];
  if (operation.riskClass === 'R2' && activeApprovers.length < 1) {
    return { allowed: false, phase: 'preflight_blocked', code: 'ApprovalRequired' };
  }
  if (operation.riskClass === 'R3' && activeApprovers.length < 2) {
    return { allowed: false, phase: 'preflight_blocked', code: 'TwoPersonApprovalRequired' };
  }
  return { allowed: true, phase: 'preflighting', code: 'Authorized', accessToken: session.accessToken };
}

function checkLivePreconditions(operation, live) {
  if (!live?.fresh || !live?.snapshotComplete) return { ok: false, code: 'AuthorityUnavailable' };
  if (String(live.uid || '') !== String(operation.target.uid || '')) return { ok: false, code: 'TargetUidChanged' };
  if (operation.target.generation != null && Number(live.generation) !== Number(operation.target.generation)) return { ok: false, code: 'TargetGenerationChanged' };
  if (operation.target.resourceVersion && String(live.resourceVersion) !== String(operation.target.resourceVersion)) return { ok: false, code: 'TargetRevisionChanged' };
  if (operation.target.desiredRevision && String(live.desiredRevision) !== String(operation.target.desiredRevision)) return { ok: false, code: 'DesiredRevisionChanged' };
  return { ok: true, code: 'PreconditionsSatisfied', digest: digest(live) };
}

function transitionPhase(current, next) {
  if (current === next) return current;
  if (TERMINAL.has(current) || !PHASE_TRANSITIONS[current]?.has(next)) throw new Error(`invalid operation transition ${current}->${next}`);
  return next;
}

class DurableOperationWorker {
  constructor(deps) {
    for (const name of ['store', 'sessions', 'authority', 'owners', 'verifiers']) {
      if (!deps?.[name]) throw new Error(`${name} dependency is required`);
    }
    this.deps = deps;
    this.workerId = deps.workerId || `worker-${process.pid}`;
    this.now = deps.now || (() => new Date());
  }

  async process(operation) {
    let phase = operation.phase;
    let leaseLost = false;
    const heartbeat = async () => {
      if (!this.deps.store.heartbeat) return true;
      const kept = await this.deps.store.heartbeat(operation.operationId);
      if (!kept) leaseLost = true;
      return kept;
    };
    const requireLease = async () => {
      if (leaseLost || !(await heartbeat())) {
        throw Object.assign(new Error('durable operation claim lease was lost'), { code: 'ClaimLeaseLost' });
      }
    };
    const heartbeatTimer = this.deps.store.heartbeat
      ? setInterval(() => { void heartbeat().catch(() => { leaseLost = true; }); }, 10000)
      : null;
    heartbeatTimer?.unref?.();
    const step = async (next, type, status, evidence = {}) => {
      await requireLease();
      phase = transitionPhase(phase, next);
      await this.deps.store.appendStep(operation.operationId, { type, phase, status, evidence: { ...evidence, digest: digest(evidence) } });
      await this.deps.store.setPhase(operation.operationId, next);
    };
    const deadlineExceeded = () => {
      if (!operation.deadlineAt) return false;
      const deadline = new Date(operation.deadlineAt).getTime();
      return Number.isFinite(deadline) && this.now().getTime() >= deadline;
    };
    const stopBeforeMutationIfExpired = async () => {
      if (!deadlineExceeded()) return false;
      await step('timed_out', 'terminal', 'blocked', {
        code: 'OperationDeadlineExceeded', deadlineAt: operation.deadlineAt,
      });
      return true;
    };
    try {
      if (phase === 'accepted' || phase === 'awaiting_approval') await step('claimed', 'claim', 'succeeded', { workerId: this.workerId });
      const resumingUncertainOwnerCall = ['executing', 'ambiguous', 'reconciling', 'verifying'].includes(phase);
      // A deadline prevents a new mutation. Once a downstream call may have happened,
      // reconciliation and verification continue so timeout cannot hide real state.
      if (!resumingUncertainOwnerCall && await stopBeforeMutationIfExpired()) {
        return { phase, ownerCalled: false, code: 'OperationDeadlineExceeded' };
      }
      if (phase === 'claimed') await step('preflighting', 'authorization', 'running');
      const [session, approvals] = await Promise.all([
        this.deps.sessions.resolve(operation.authSessionId, operation.actorId), this.deps.store.getApprovals(operation.operationId),
      ]);
      let authorization = authorizeAtExecution(operation, session, approvals);
      // A CLI credential is intentionally aal1. For R2/R3, an independent AAL2
      // approver may become the execution identity only after the original
      // actor/session/permission/revision checks passed up to AssuranceExpired.
      if (!authorization.allowed && authorization.code === 'AssuranceExpired' && ['R2', 'R3'].includes(operation.riskClass)) {
        const activeApprovalCount = new Set(approvals.filter((item) => !item.revokedAt && item.assurance === 'aal2')
          .map((item) => String(item.approverId))).size;
        const requiredApprovalCount = operation.riskClass === 'R3' ? 2 : 1;
        for (const approval of activeApprovalCount >= requiredApprovalCount ? approvals : []) {
          if (approval.revokedAt || approval.assurance !== 'aal2' || !approval.authSessionId
              || String(approval.approverId) === String(operation.actorId)) continue;
          const approverSession = await this.deps.sessions.resolve(approval.authSessionId, approval.approverId);
          if (!approverSession?.active || approverSession.assurance !== 'aal2'
              || String(approverSession.authzRevision || '') !== String(approval.authzRevision || '')
              || !new Set(approverSession.permissions || []).has(operation.requiredPermission)) continue;
          authorization = { allowed: true, phase: 'preflighting', code: 'AuthorizedByIndependentApprover',
            accessToken: approverSession.accessToken, executionActorId: approval.approverId };
          break;
        }
      }
      if (!authorization.allowed) {
        if (!resumingUncertainOwnerCall) await step(authorization.phase, 'authorization', 'blocked', { code: authorization.code });
        else {
          if (phase === 'executing') await step('ambiguous', 'owner-call', 'inconclusive', { code: 'RecoveredExecutingLease' });
          await step('inconclusive', 'authorization', 'blocked', { code: `${authorization.code}AfterOwnerCall` });
        }
        return { phase, ownerCalled: false, code: authorization.code };
      }
      if (authorization.executionActorId) {
        await step(phase, 'authorization-delegation', 'succeeded', {
          actorId: operation.actorId, executionActorId: authorization.executionActorId, code: authorization.code,
        });
      }
      const downstreamKey = `${operation.operationId}:${operation.descriptorDigest}`;
      let receipt;
      let ownerCalled = false;
      if (!resumingUncertainOwnerCall) {
        const live = await this.deps.authority.read(operation.target, authorization.accessToken);
        const preflight = checkLivePreconditions(operation, live);
        if (!preflight.ok) {
          await step('preflight_blocked', 'precondition', 'blocked', { code: preflight.code });
          return { phase, ownerCalled: false, code: preflight.code };
        }
        if (await stopBeforeMutationIfExpired()) {
          return { phase, ownerCalled: false, code: 'OperationDeadlineExceeded' };
        }
        await step('executing', 'precondition', 'succeeded', { preconditionDigest: preflight.digest });
        if (await stopBeforeMutationIfExpired()) {
          return { phase, ownerCalled: false, code: 'OperationDeadlineExceeded' };
        }
        await requireLease();
        await this.deps.store.recordDownstreamIntent?.(operation.operationId, downstreamKey);
        try {
          ownerCalled = true;
          receipt = await this.deps.owners.invoke(operation.ownerRoute, {
          operationId: operation.operationId, idempotencyKey: downstreamKey,
            toolId: operation.toolId, target: operation.target, reason: operation.reason, confirmation: operation.confirmation,
          }, authorization.accessToken);
          await requireLease();
        } catch (error) {
          if (error?.code === 'ClaimLeaseLost') throw error;
          if (error?.ambiguous === true) {
            await step('ambiguous', 'owner-call', 'inconclusive', { downstreamKey, code: 'AmbiguousOwnerOutcome' });
          } else {
            await step('failed', 'owner-call', 'failed', { code: error?.code || 'OwnerCallFailed' });
            return { phase, ownerCalled: true, code: error?.code || 'OwnerCallFailed' };
          }
        }
      }
      if (phase === 'executing') {
        await step('verifying', 'receipt', 'succeeded', { receiptDigest: digest(receipt), downstreamKey });
      } else if (phase === 'verifying') {
        receipt = await this.deps.owners.reconcile(operation.ownerRoute, downstreamKey, operation.target, authorization.accessToken);
        if (!receipt) {
          await step('inconclusive', 'reconcile', 'inconclusive', { code: 'OwnerReceiptUnavailableDuringVerificationResume' });
          return { phase, ownerCalled, code: 'OwnerReceiptUnavailableDuringVerificationResume' };
        }
      } else if (phase !== 'verifying') {
        if (phase === 'ambiguous') await step('reconciling', 'reconcile', 'running', { downstreamKey });
        await requireLease();
        receipt = await this.deps.owners.reconcile(operation.ownerRoute, downstreamKey, operation.target, authorization.accessToken);
        if (!receipt) {
          await step('inconclusive', 'reconcile', 'inconclusive', { code: 'OwnerOutcomeUnknown' });
          return { phase, ownerCalled, code: 'OwnerOutcomeUnknown' };
        }
        await step('verifying', 'receipt', 'succeeded', { receiptDigest: digest(receipt), downstreamKey });
      }
      await requireLease();
      const verified = await this.deps.verifiers.verify(operation.verifierId, operation.target, receipt, authorization.accessToken);
      if (verified?.status === 'succeeded') await step('succeeded', 'verification', 'succeeded', { verifier: operation.verifierId, observed: verified.observed });
      else if (verified?.status === 'failed') await step('verification_failed', 'verification', 'failed', { verifier: operation.verifierId, observed: verified.observed });
      else await step('inconclusive', 'verification', 'inconclusive', { verifier: operation.verifierId, observed: verified?.observed });
      return { phase, ownerCalled, code: verified?.status || 'inconclusive' };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // Short-lived access tokens are never assigned to operation/store state.
    }
  }
}

module.exports = {
  DESCRIPTORS, TERMINAL, PHASE_TRANSITIONS, stableJson, digest, exactConfirmation,
  planOperation, bindOperation, expectedPostcondition, authorizeAtExecution, checkLivePreconditions, transitionPhase,
  DurableOperationWorker,
};
