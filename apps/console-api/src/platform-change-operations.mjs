import {
  ARGOCD_VERIFICATION_CONFIRMATION,
  ARGOCD_VERIFICATION_PATH,
  ARGOCD_VERIFICATION_TEMPLATE_ID,
  argocdVerificationDeclaration,
  isArgocdVerificationDeclaration,
} from './argocd-verification-contract.mjs';

const CONSUMER = /^[a-z][a-z0-9._-]{1,127}$/u;
const ACTIONS = new Set(['apply', 'configure', 'delete', 'rollback']);
const MAX_DESIRED_STATE_BYTES = 64 * 1024;
const SECRET_FIELD = /(?:^|[_-])(authorization|credential|password|privatekey|secret|token)(?:$|[_-])/iu;
const POST_MERGE_OWNER_UNAVAILABLE = 'post-merge platform change owner is not configured; status remains read-only';

function fail(message) {
  throw Object.assign(new Error(message), { code: 'ValidationFailed', status: 400, sideEffect: 'none' });
}

function assertPostMergeOwnerReady(postMergeOwnerReady) {
  let ready = false;
  try {
    ready = postMergeOwnerReady() === true;
  } catch {
    ready = false;
  }
  if (!ready) {
    throw Object.assign(new Error(POST_MERGE_OWNER_UNAVAILABLE), {
      code: 'AuthorityUnavailable', status: 503, sideEffect: 'none',
      details: { managementReady: false },
    });
  }
}

function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object');
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length) fail(label + ' contains unknown fields: ' + unknown.join(', '));
}

function text(value, name, minimum, maximum) {
  const normalized = String(value ?? '').trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\r\n]/u.test(normalized)) {
    fail(`${name} must contain ${minimum}..${maximum} characters`);
  }
  return normalized;
}

function validateProposal(body) {
  exact(body, ['consumerId', 'action', 'target', 'reason', 'desiredState', 'templateId'], 'platform change request');
  const consumerId = text(body.consumerId, 'consumerId', 2, 128);
  if (!CONSUMER.test(consumerId)) fail('consumerId is invalid');
  const action = text(body.action || 'apply', 'action', 3, 16).toLowerCase();
  if (!ACTIONS.has(action)) fail('action must be apply, configure, delete, or rollback');
  const target = text(body.target || consumerId, 'target', 1, 300);
  const reason = text(body.reason, 'reason', 8, 500);
  if (!body.desiredState || typeof body.desiredState !== 'object' || Array.isArray(body.desiredState)) {
    fail('desiredState must be an object');
  }
  let encoded;
  try {
    encoded = JSON.stringify(body.desiredState);
  } catch {
    fail('desiredState must be JSON serializable');
  }
  if (!encoded || Buffer.byteLength(encoded) > MAX_DESIRED_STATE_BYTES) {
    fail(`desiredState must not exceed ${MAX_DESIRED_STATE_BYTES} bytes`);
  }
  const pending = [{ value: body.desiredState, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    visited += 1;
    if (visited > 2048 || depth > 16) fail('desiredState structure exceeds the bounded declaration policy');
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.replaceAll(/([a-z])([A-Z])/gu, '$1_$2');
      if (SECRET_FIELD.test(normalizedKey)) fail('desiredState must not contain credential material');
      if (child && typeof child === 'object') pending.push({ value: child, depth: depth + 1 });
    }
  }
  const templateId = body.templateId == null ? null : text(body.templateId, 'templateId', 1, 128);
  if (templateId === ARGOCD_VERIFICATION_TEMPLATE_ID || target === ARGOCD_VERIFICATION_PATH) {
    fail('templateId and target are reserved for the fixed Console bootstrap contract');
  }
  return Object.freeze({ consumerId, action, target, reason, desiredState: body.desiredState, templateId });
}

function validateArgocdVerificationBootstrap(body) {
  exact(body, ['reason', 'confirm'], 'Argo CD verification bootstrap request');
  const reason = text(body.reason, 'reason', 8, 500);
  if (String(body.confirm || '').trim() !== ARGOCD_VERIFICATION_CONFIRMATION) {
    throw Object.assign(new Error(`confirmation must exactly equal: ${ARGOCD_VERIFICATION_CONFIRMATION}`), {
      code: 'Conflict', status: 409, sideEffect: 'none',
    });
  }
  return Object.freeze({ reason });
}

function validateApproval(body) {
  exact(body, ['reason'], 'platform change approval');
  return Object.freeze({ reason: text(body.reason, 'reason', 8, 500) });
}

function assertStatusAuthority(session) {
  const permissionRevision = Number(session?.permissionRevision);
  const revokeEpoch = Number(session?.revokeEpoch);
  if (!session?.sessionId || !session?.subjectId || session.authorityFresh !== true
      || !Number.isSafeInteger(permissionRevision) || permissionRevision < 0
      || !Number.isSafeInteger(revokeEpoch) || revokeEpoch < 0) {
    throw Object.assign(new Error('active current Console session is required'), {
      code: 'AuthenticationRequired', status: 401, sideEffect: 'none',
    });
  }
  if (!Array.isArray(session.permissions) || !session.permissions.includes('console.git.change')) {
    throw Object.assign(new Error('console.git.change permission is required'), {
      code: 'PermissionDenied', status: 403, sideEffect: 'none',
    });
  }
}

function changeStatus(state) {
  if (state === 'Planned') return 'intent';
  if (state === 'Authorized') return 'authorized';
  if (['Submitted', 'Reconciling'].includes(state)) return 'committed';
  if (['Applied', 'Verified'].includes(state)) return 'applied';
  if (state === 'Failed') return 'failed';
  return 'unknown';
}

function changeProjection(item, observedAt) {
  const status = changeStatus(item.state);
  const completed = ['applied', 'failed'].includes(status) ? item.updatedAt : null;
  const proposal = item.proposal || null;
  const outbox = item.outbox || null;
  const activeClaim = Boolean(outbox?.claimedAt && outbox?.leaseExpiresAt
    && Date.parse(outbox.leaseExpiresAt) > Date.parse(observedAt));
  const ownerObserved = (item.ownerReceipts || []).some((receipt) => receipt.postcondition === 'InstallReady' && receipt.phase === 'Verified');
  const reconcilerStatus = item.state === 'Verified' ? 'Verified'
    : item.nativeOwner && ownerObserved ? 'ReadyForVerification'
    : item.nativeOwner && ['Applied', 'Reconciling', 'Submitted'].includes(item.state) ? 'Applying'
    : status === 'intent' ? 'AwaitingApproval'
    : status === 'authorized' ? 'AwaitingMerge'
      : status === 'committed' ? 'AwaitingConsumer' : status;
  return Object.freeze({
    request_id: item.operationId,
    actor_id: item.actorRef,
    actor_type: 'supabase-user',
    action: item.action,
    target: item.target,
    reason: item.reason,
    status,
    git_repo: item.repository,
    git_ref: proposal?.branch || null,
    git_commit_sha: item.sourceRevision || null,
    k8s_operation_id: ownerObserved ? item.operationId : null,
    state_version: Number(item.stateVersion || 0),
    created_at: item.createdAt,
    completed_at: completed,
    approvalPolicy: 'cross-operator',
    approval_assurance: item.localDevelopmentModuleInstall === true ? 'local-development' : 'recent-aal2',
    execution: Object.freeze({
      branch: proposal?.branch || '',
      pull_number: proposal?.pullNumber ?? null,
      pull_url: null,
      desired_revision: proposal?.desiredRevision || null,
      merge_revision: item.sourceRevision || null,
      reconciler: item.nativeOwner || 'NotConfigured',
      reconciler_status: reconcilerStatus,
      drift_status: 'Unknown',
      attempt_count: Number(outbox?.attemptCount || 0),
      last_error: item.errorCode || null,
      updated_at: item.updatedAt,
    }),
    outbox: outbox ? Object.freeze({
      status: outbox.deliveredAt ? 'delivered' : activeClaim ? 'claimed' : 'pending',
      attempts: Number(outbox.attemptCount || 0),
      next_attempt_at: null,
      last_error: item.errorCode || null,
      updated_at: outbox.createdAt,
    }) : null,
    approvals: Object.freeze((item.approvals || []).map((approval) => Object.freeze({
      approver_id: approval.approverId,
      status: 'applied',
      created_at: approval.createdAt,
      completed_at: approval.createdAt,
      error_code: null,
    }))),
  });
}

function statusProjection(status, inventory, giteaClient, ownerReady = false) {
  const repository = status.repositoryMetadata ? [status.repositoryMetadata] : [];
  const changes = Object.freeze(inventory.items.map((item) => changeProjection(item, inventory.observedAt)));
  const byStatus = { intent: 0, authorized: 0, committed: 0, applied: 0, failed: 0, unknown: 0 };
  for (const change of changes) byStatus[change.status] += 1;
  const policyObserved = ['protected', 'requiredApprovals', 'directPushEnabled', 'signedCommitsRequired', 'blockRejectedReviews']
    .every((field) => Object.hasOwn(status, field));
  return Object.freeze({
    meta: Object.freeze({
      source: 'gitea',
      checkedAt: status.checkedAt,
      organization: giteaClient.organization,
      tokenConfigured: status.configured === true,
    }),
    configured: status.configured === true,
    ready: status.ready === true,
    version: String(status.version || ''),
    repositoryCount: repository.length || null,
    repositories: Object.freeze(repository),
    contracts: Object.freeze([
      { consumer_id: 'console-modules', display_name: 'Cluster Manager 설치', owner_kind: 'Console native owner',
        supabase_schemas: ['console_operation'], storage_buckets: [], gitea_repository: giteaClient.repository,
        gitea_path: 'console-modules/requests', reconciler: 'C_EXT', status: ownerReady ? 'Ready' : 'Unavailable',
        desired_revision: null, applied_revision: null, observability: null },
      ...[['foundation-bootstrap', 'Foundation 기초 모듈'], ['ceph-prerequisites', 'Ceph 선행요소']].map(([id, name]) => ({
        consumer_id: id, display_name: name, owner_kind: 'Module owner not deployed', supabase_schemas: [], storage_buckets: [],
        gitea_repository: giteaClient.repository, gitea_path: `${id}/requests`, reconciler: 'NotConfigured',
        status: 'NotConfigured', desired_revision: null, applied_revision: null, observability: null,
      })),
    ]),
    receipts: Object.freeze(inventory.items.flatMap((item) => (item.ownerReceipts || []).map((receipt) => ({
      delivery_id: receipt.id, event_type: receipt.postcondition || receipt.phase,
      repository: item.repository, request_id: item.operationId, signature_valid: null,
      disposition: receipt.phase, error_code: null, received_at: receipt.createdAt,
      authority: receipt.owner, evidence_digest: receipt.digest,
    }))).slice(-100)),
    changes,
    byStatus: Object.freeze(byStatus),
    reason: status.ready && ownerReady ? 'Cluster Manager 설치: Git 검토·보호 병합 이후 Extension Controller 적용 및 실측 검증을 사용합니다. Foundation·Ceph 실행기는 아직 연결되지 않았습니다.' : status.ready
      ? 'Gitea proposal and protected merge are ready; post-merge owner reconciliation is not configured'
      : String(status.reason || 'Gitea status is unavailable'),
    managementReady: status.ready === true && ownerReady,
    supplyChain: policyObserved ? Object.freeze({
      repository: status.repository,
      defaultBranch: status.defaultBranch,
      protected: status.protected === true,
      requiredApprovals: Number(status.requiredApprovals || 0),
      directPushEnabled: status.directPushEnabled === true,
      signedCommitsRequired: status.signedCommitsRequired === true,
      blockRejectedReviews: status.blockRejectedReviews === true,
    }) : null,
  });
}

function approvalPlan(record, giteaClient) {
  const plan = record?.declaration_binding
    ? { ...record.declaration_binding, submittedAt: new Date(record.created_at).toISOString() } : record?.execution_plan;
  if (!plan || plan.schemaVersion !== '1.0' || plan.authority !== 'Gitea'
      || plan.repository !== giteaClient.repository || plan.defaultBranch !== giteaClient.defaultBranch
      || !CONSUMER.test(String(plan.consumerId || '')) || !ACTIONS.has(String(plan.action || ''))
      || !plan.desiredState || typeof plan.desiredState !== 'object' || Array.isArray(plan.desiredState)) {
    throw Object.assign(new Error('stored Gitea execution plan is invalid'), {
      code: 'ClaimBindingMismatch', status: 409, sideEffect: 'none',
    });
  }
  if ((plan.templateId === ARGOCD_VERIFICATION_TEMPLATE_ID || plan.target === ARGOCD_VERIFICATION_PATH)
      && (plan.consumerId !== 'platform-delivery' || plan.action !== 'configure'
        || plan.target !== ARGOCD_VERIFICATION_PATH || plan.templateId !== ARGOCD_VERIFICATION_TEMPLATE_ID
        || !isArgocdVerificationDeclaration(plan.desiredState))) {
    throw Object.assign(new Error('stored fixed Argo CD verification plan is invalid'), {
      code: 'ClaimBindingMismatch', status: 409, sideEffect: 'none',
    });
  }
  return plan;
}

function ensurePlanProposal(giteaClient, plan, input) {
  if (plan.templateId === ARGOCD_VERIFICATION_TEMPLATE_ID) {
    return giteaClient.ensureArgocdVerificationProposal({
      operationId: input.operationId,
      reason: input.reason,
      sourceSha: input.sourceSha,
    });
  }
  return giteaClient.ensureProposal({
    operationId: input.operationId,
    consumerId: plan.consumerId,
    action: plan.action,
    target: plan.target,
    reason: input.reason,
    desiredState: plan.desiredState,
    submittedAt: plan.submittedAt,
  });
}

export function createPlatformChangeOperations({
  operationService,
  policyRevision,
  projectionStore,
  giteaClient,
  postMergeOwnerReady = () => false,
  moduleOwner = null,
  clock = () => new Date(),
}) {
  if (!operationService?.accept || !operationService?.approve || !operationService?.assertApprovalAuthority) {
    throw new TypeError('operation service is required');
  }
  if (!projectionStore?.getGiteaOperationForApproval || !projectionStore?.listGiteaChanges
      || !projectionStore?.recordGiteaProposal
      || !projectionStore?.recordGiteaMerge) {
    throw new TypeError('Gitea operation projection store is required');
  }
  if (!giteaClient?.supplyChainStatus || !giteaClient?.ensureProposal || !giteaClient?.approveAndMerge
      || !giteaClient?.argocdVerificationStatus || !giteaClient?.ensureArgocdVerificationProposal) {
    throw new TypeError('Gitea change client is required');
  }
  if (typeof postMergeOwnerReady !== 'function') throw new TypeError('post-merge owner readiness probe is required');
  const planRevision = text(policyRevision, 'policyRevision', 1, 128);

  return Object.freeze({
    async status({ session }) {
      assertStatusAuthority(session);
      const inventory = await projectionStore.listGiteaChanges({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        expectedPermissionRevision: Number(session.permissionRevision),
        expectedRevokeEpoch: Number(session.revokeEpoch),
      });
      return statusProjection(await giteaClient.supplyChainStatus(), inventory, giteaClient, moduleOwner ? await moduleOwner.ready() : false);
    },

    async propose({ session, body, idempotencyKey, correlationId }) {
      if (moduleOwner && body && Object.keys(body).length === 1 && Object.hasOwn(body, 'operationId')) {
        assertStatusAuthority(session);
        const operationId = text(body.operationId, 'operationId', 36, 36);
        const record = await projectionStore.get({ sessionId: session.sessionId, actorRef: session.subjectId, operationId });
        if (!record?.declaration_binding || record.actor_ref !== session.subjectId || !['Planned', 'Authorized'].includes(record.state)) {
          throw Object.assign(new Error('요청자 본인의 병합 전 설치 선언만 재개할 수 있습니다.'), { code: 'PermissionDenied', status: 403, sideEffect: 'none' });
        }
        const plan = approvalPlan(record, giteaClient);
        await moduleOwner.validate(plan, correlationId);
        const ready = await moduleOwner.ready();
        assertPostMergeOwnerReady(() => ready);
        const git = await ensurePlanProposal(giteaClient, plan, { operationId, reason: record.reason });
        await projectionStore.recordGiteaProposal({ operationId, desiredRevision: git.desiredRevision,
          branch: git.branch, pullNumber: git.pullRequest.number, correlationId });
        return { accepted: true, duplicate: true, requestId: operationId,
          operation: await operationService.get({ session, operationId }), status: changeStatus(record.state),
          branch: git.branch, pullRequest: git.pullRequest, desiredRevision: git.desiredRevision };
      }
      const proposal = validateProposal(body);
      assertStatusAuthority(session);
      const nativePlan = moduleOwner ? await moduleOwner.validate(proposal, correlationId) : null;
      const moduleReady = moduleOwner ? await moduleOwner.ready() : false;
      if (moduleOwner) assertPostMergeOwnerReady(() => moduleReady);
      else assertPostMergeOwnerReady(postMergeOwnerReady);
      const supplyChain = await giteaClient.supplyChainStatus();
      if (!supplyChain.ready) {
        throw Object.assign(new Error(supplyChain.reason || 'Gitea change authority is unavailable'), {
          code: 'AuthorityUnavailable', status: 503, sideEffect: 'none', details: { supplyChain },
        });
      }
      let submittedAt = clock().toISOString();
      const executionPlan = {
        schemaVersion: '1.0',
        authority: 'Gitea',
        repository: giteaClient.repository,
        defaultBranch: giteaClient.defaultBranch,
        consumerId: proposal.consumerId,
        action: proposal.action,
        target: proposal.target,
        desiredState: proposal.desiredState,
        templateId: proposal.templateId,
        submittedAt,
      };
      const accepted = await operationService.accept({
        session,
        idempotencyKey,
        correlationId,
        executionPlan: nativePlan || executionPlan,
        ...(nativePlan ? { declarationBinding: Object.fromEntries(Object.entries(executionPlan).filter(([key]) => key !== 'submittedAt')) } : {}),
        request: {
          schemaVersion: '1.0',
          actionId: nativePlan ? 'console.extension.install' : 'console.platform.change.propose',
          actionVersion: '1.0',
          targetRef: nativePlan ? nativePlan.image : `gitea-change:${proposal.consumerId}:${proposal.target}`,
          payload: {
            consumerId: proposal.consumerId,
            action: proposal.action,
            target: proposal.target,
            desiredState: proposal.desiredState,
            templateId: proposal.templateId,
          },
          reason: proposal.reason,
          risk: 'R2',
          planRevision,
        },
      });
      if (nativePlan) submittedAt = accepted.receipt.createdAt;
      try {
        const git = await giteaClient.ensureProposal({
          operationId: accepted.receipt.operationId,
          consumerId: proposal.consumerId,
          action: proposal.action,
          target: proposal.target,
          reason: proposal.reason,
          desiredState: proposal.desiredState,
          submittedAt,
        });
        let proposalReceipt;
        try {
          proposalReceipt = await projectionStore.recordGiteaProposal({
            operationId: accepted.receipt.operationId,
            desiredRevision: git.desiredRevision,
            branch: git.branch,
            pullNumber: git.pullRequest.number,
            correlationId,
          });
        } catch (error) {
          error.operationId = accepted.receipt.operationId;
          error.sideEffect = 'present';
          throw error;
        }
        return Object.freeze({
          accepted: true,
          duplicate: Boolean(accepted.replayed || git.replayed || proposalReceipt.replayed),
          requestId: accepted.receipt.operationId,
          operation: accepted.receipt,
          status: nativePlan ? changeStatus(accepted.receipt.state) : 'authorized',
          branch: git.branch,
          pullRequest: git.pullRequest,
          desiredRevision: git.desiredRevision,
        });
      } catch (error) {
        error.operationId = accepted.receipt.operationId;
        throw error;
      }
    },

    async bootstrapArgocdVerification({ session, body, idempotencyKey, correlationId }) {
      const request = validateArgocdVerificationBootstrap(body);
      assertStatusAuthority(session);
      if (session.aal !== 'aal2') {
        throw Object.assign(new Error('Argo CD verification bootstrap requires MFA assurance aal2'), {
          code: 'StepUpRequired', status: 428, sideEffect: 'none',
        });
      }
      const currentStatus = await giteaClient.argocdVerificationStatus();
      if (currentStatus.ready) {
        return Object.freeze({
          ready: true,
          changed: false,
          path: ARGOCD_VERIFICATION_PATH,
          mergeRevision: currentStatus.mainRevision,
        });
      }
      assertPostMergeOwnerReady(postMergeOwnerReady);
      const submittedAt = clock().toISOString();
      const plan = {
        schemaVersion: '1.0',
        authority: 'Gitea',
        repository: giteaClient.repository,
        defaultBranch: giteaClient.defaultBranch,
        consumerId: 'platform-delivery',
        action: 'configure',
        target: ARGOCD_VERIFICATION_PATH,
        desiredState: argocdVerificationDeclaration(),
        templateId: ARGOCD_VERIFICATION_TEMPLATE_ID,
        submittedAt,
      };
      const accepted = await operationService.accept({
        session,
        idempotencyKey,
        correlationId,
        executionPlan: plan,
        request: {
          schemaVersion: '1.0',
          actionId: 'console.platform.change.propose',
          actionVersion: '1.0',
          targetRef: `gitea-change:platform-delivery:${ARGOCD_VERIFICATION_PATH}`,
          payload: {
            consumerId: plan.consumerId,
            action: plan.action,
            target: plan.target,
            desiredState: plan.desiredState,
            templateId: plan.templateId,
          },
          reason: request.reason,
          risk: 'R2',
          planRevision,
        },
      });
      try {
        const git = await ensurePlanProposal(giteaClient, plan, {
          operationId: accepted.receipt.operationId,
          reason: request.reason,
          sourceSha: currentStatus.sourceSha,
        });
        let proposalReceipt;
        try {
          proposalReceipt = await projectionStore.recordGiteaProposal({
            operationId: accepted.receipt.operationId,
            desiredRevision: git.desiredRevision,
            branch: git.branch,
            pullNumber: git.pullRequest.number,
            correlationId,
          });
        } catch (error) {
          error.operationId = accepted.receipt.operationId;
          error.sideEffect = 'present';
          throw error;
        }
        return Object.freeze({
          ready: false,
          changed: true,
          path: ARGOCD_VERIFICATION_PATH,
          accepted: true,
          duplicate: Boolean(accepted.replayed || git.replayed || proposalReceipt.replayed),
          requestId: accepted.receipt.operationId,
          operation: accepted.receipt,
          status: 'authorized',
          branch: git.branch,
          pullRequest: git.pullRequest,
          desiredRevision: git.desiredRevision,
        });
      } catch (error) {
        error.operationId = accepted.receipt.operationId;
        throw error;
      }
    },

    async approve({ session, operationId, body, idempotencyKey, correlationId }) {
      const approval = validateApproval(body);
      const authority = moduleOwner
        ? await operationService.assertGiteaModuleApprovalAuthority({ session, reason: approval.reason, operationId })
        : operationService.assertApprovalAuthority({ session, reason: approval.reason });
      if (!moduleOwner) assertPostMergeOwnerReady(postMergeOwnerReady);
      const record = await projectionStore.getGiteaOperationForApproval({
        sessionId: session.sessionId,
        actorRef: authority.actorRef,
        expectedPermissionRevision: Number(session.permissionRevision),
        expectedRevokeEpoch: Number(session.revokeEpoch),
        operationId: text(operationId, 'operationId', 36, 36),
      });
      const plan = approvalPlan(record, giteaClient);
      if (moduleOwner) {
        if (!record.declaration_binding) throw Object.assign(new Error('이 변경 대상의 실행기가 연결되지 않았습니다.'), { code: 'AuthorityUnavailable', status: 503 });
        await moduleOwner.validate(plan, correlationId);
        const ready = await moduleOwner.ready();
        assertPostMergeOwnerReady(() => ready);
      }
      let approved = null;
      if (record.state === 'Planned') {
        approved = await operationService.approve({
          session,
          operationId,
          idempotencyKey,
          correlationId,
          request: {
            reason: approval.reason,
            approvalRevision: record.plan_revision,
            expectedStateVersion: Number(record.state_version),
            confirmation: null,
          },
        });
      } else if (!['Authorized', 'Submitted'].includes(record.state)) {
        throw Object.assign(new Error('platform change is not awaiting merge'), {
          code: 'InvalidOperationState', status: 409, sideEffect: 'none', operationId,
        });
      }
      try {
        const proposal = await ensurePlanProposal(giteaClient, plan, {
          operationId,
          reason: record.reason,
        });
        try {
          await projectionStore.recordGiteaProposal({
            operationId,
            desiredRevision: proposal.desiredRevision,
            branch: proposal.branch,
            pullNumber: proposal.pullRequest.number,
            correlationId,
          });
        } catch (error) {
          error.operationId = operationId;
          error.sideEffect = 'present';
          throw error;
        }
        const merged = await giteaClient.approveAndMerge({
          operationId,
          branch: proposal.branch,
          pullNumber: proposal.pullRequest.number,
          approverRef: authority.actorRef,
          reason: approval.reason,
          expectedRevision: proposal.desiredRevision,
          ...(record.declaration_binding ? { declaration: { ...plan, operationId, reason: record.reason } } : {}),
        });
        let bound;
        try {
          bound = await projectionStore.recordGiteaMerge({
            operationId,
            sourceRevision: merged.mergeRevision,
            branch: merged.branch,
            pullNumber: merged.pullNumber,
            correlationId,
          });
        } catch (error) {
          error.operationId = operationId;
          error.sideEffect = 'present';
          throw error;
        }
        return Object.freeze({
          requestId: operationId,
          approved: true,
          merged: true,
          mergeRevision: merged.mergeRevision,
          pullNumber: merged.pullNumber,
          state: bound.operationRecord.state,
          stateVersion: Number(bound.operationRecord.state_version),
          duplicate: Boolean(approved?.replayed || bound.replayed || record.state === 'Submitted'),
        });
      } catch (error) {
        error.operationId = operationId;
        throw error;
      }
    },
  });
}
