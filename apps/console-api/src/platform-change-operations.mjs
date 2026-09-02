const CONSUMER = /^[a-z][a-z0-9._-]{1,127}$/u;
const ACTIONS = new Set(['apply', 'configure', 'delete', 'rollback']);
const MAX_DESIRED_STATE_BYTES = 64 * 1024;
const SECRET_FIELD = /(?:^|[_-])(authorization|credential|password|privatekey|secret|token)(?:$|[_-])/iu;

function fail(message) {
  throw Object.assign(new Error(message), { code: 'ValidationFailed', status: 400, sideEffect: 'none' });
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
  return Object.freeze({ consumerId, action, target, reason, desiredState: body.desiredState, templateId });
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

function statusProjection(status, giteaClient) {
  const repository = status.repositoryMetadata ? [status.repositoryMetadata] : [];
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
    contracts: Object.freeze([]),
    receipts: Object.freeze([]),
    changes: Object.freeze([]),
    byStatus: Object.freeze({ intent: 0, authorized: 0, committed: 0, applied: 0, failed: 0, unknown: 0 }),
    reason: status.ready
      ? 'Gitea proposal and protected merge are ready; post-merge owner reconciliation is not configured'
      : String(status.reason || 'Gitea status is unavailable'),
    managementReady: false,
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
  const plan = record?.execution_plan;
  if (!plan || plan.schemaVersion !== '1.0' || plan.authority !== 'Gitea'
      || plan.repository !== giteaClient.repository || plan.defaultBranch !== giteaClient.defaultBranch
      || !CONSUMER.test(String(plan.consumerId || '')) || !ACTIONS.has(String(plan.action || ''))
      || !plan.desiredState || typeof plan.desiredState !== 'object' || Array.isArray(plan.desiredState)) {
    throw Object.assign(new Error('stored Gitea execution plan is invalid'), {
      code: 'ClaimBindingMismatch', status: 409, sideEffect: 'none',
    });
  }
  return plan;
}

export function createPlatformChangeOperations({ operationService, policyRevision, projectionStore, giteaClient, clock = () => new Date() }) {
  if (!operationService?.accept || !operationService?.approve || !operationService?.assertApprovalAuthority) {
    throw new TypeError('operation service is required');
  }
  if (!projectionStore?.getGiteaOperationForApproval || !projectionStore?.recordGiteaProposal
      || !projectionStore?.recordGiteaMerge) {
    throw new TypeError('Gitea operation projection store is required');
  }
  if (!giteaClient?.supplyChainStatus || !giteaClient?.ensureProposal || !giteaClient?.approveAndMerge) {
    throw new TypeError('Gitea change client is required');
  }
  const planRevision = text(policyRevision, 'policyRevision', 1, 128);

  return Object.freeze({
    async status({ session }) {
      assertStatusAuthority(session);
      return statusProjection(await giteaClient.supplyChainStatus(), giteaClient);
    },

    async propose({ session, body, idempotencyKey, correlationId }) {
      const proposal = validateProposal(body);
      const supplyChain = await giteaClient.supplyChainStatus();
      if (!supplyChain.ready) {
        throw Object.assign(new Error(supplyChain.reason || 'Gitea change authority is unavailable'), {
          code: 'AuthorityUnavailable', status: 503, sideEffect: 'none', details: { supplyChain },
        });
      }
      const submittedAt = clock().toISOString();
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
        executionPlan,
        request: {
          schemaVersion: '1.0',
          actionId: 'console.platform.change.propose',
          actionVersion: '1.0',
          targetRef: `gitea-change:${proposal.consumerId}:${proposal.target}`,
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
      const authority = operationService.assertApprovalAuthority({ session, reason: approval.reason });
      const record = await projectionStore.getGiteaOperationForApproval({
        sessionId: session.sessionId,
        actorRef: authority.actorRef,
        expectedPermissionRevision: Number(session.permissionRevision),
        expectedRevokeEpoch: Number(session.revokeEpoch),
        operationId: text(operationId, 'operationId', 36, 36),
      });
      const plan = approvalPlan(record, giteaClient);
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
        const proposal = await giteaClient.ensureProposal({
          operationId,
          consumerId: plan.consumerId,
          action: plan.action,
          target: plan.target,
          reason: record.reason,
          desiredState: plan.desiredState,
          submittedAt: plan.submittedAt,
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
