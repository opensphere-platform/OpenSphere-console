const CONSUMER = /^[a-z][a-z0-9._-]{1,127}$/u;
const ACTIONS = new Set(['apply', 'configure', 'delete', 'rollback']);
const MAX_DESIRED_STATE_BYTES = 64 * 1024;

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
  const templateId = body.templateId == null ? null : text(body.templateId, 'templateId', 1, 128);
  return Object.freeze({ consumerId, action, target, reason, desiredState: body.desiredState, templateId });
}

export function createPlatformChangeOperations({ operationService, policyRevision, giteaClient, clock = () => new Date() }) {
  if (!operationService?.accept) throw new TypeError('operation service is required');
  if (!giteaClient?.ensureProposal) throw new TypeError('Gitea change client is required');
  const planRevision = text(policyRevision, 'policyRevision', 1, 128);

  return Object.freeze({
    async propose({ session, body, idempotencyKey, correlationId }) {
      const proposal = validateProposal(body);
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
        return Object.freeze({
          accepted: true,
          duplicate: Boolean(accepted.replayed || git.replayed),
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
  });
}
