'use strict';

const { createHash, randomUUID } = require('crypto');

const TERMINAL_PHASES = new Set(['Succeeded', 'Failed', 'RolledBack']);
const ACTIVE_OWNER_PHASES = new Set([
  'Queued', 'Recovering', 'Installing', 'Upgrading', 'RollingBack',
  'Configuring', 'Migrating', 'Validating', 'Uninstalling',
]);

const MODULES = Object.freeze({
  'shared-observability': Object.freeze({
    id: 'shared-observability',
    displayName: 'Shared Observability',
    owner: 'cluster-manager/HISS',
    adapter: 'his:kube-prometheus-stack',
    status: 'Available',
    actions: ['install', 'verify', 'delete-runtime', 'reinstall'],
    unavailableActions: Object.freeze({
      purge: 'Shared Observability runtime deletion does not purge retained PVC data.',
    }),
  }),
  argocd: Object.freeze({
    id: 'argocd',
    displayName: 'Argo CD',
    owner: 'foundation/platform-delivery',
    adapter: null,
    status: 'NotAvailable',
    actions: [],
    unavailableReason: 'Console owner adapter is not implemented yet.',
  }),
  crossplane: Object.freeze({
    id: 'crossplane',
    displayName: 'Crossplane',
    owner: 'foundation/platform-delivery',
    adapter: null,
    status: 'NotAvailable',
    actions: [],
    unavailableReason: 'Console owner adapter is not implemented yet.',
  }),
  postgres: Object.freeze({
    id: 'postgres',
    displayName: 'PostgreSQL',
    owner: 'foundation/postgres',
    adapter: null,
    status: 'NotAvailable',
    actions: [],
    unavailableReason: 'Console owner adapter is not implemented yet.',
  }),
});

const RISK_TABLE = Object.freeze({
  'shared-observability:install': Object.freeze({ riskClass: 'R1', assurance: 'aal2', approvalMode: 'single-admin' }),
  'shared-observability:verify': Object.freeze({ riskClass: 'R1', assurance: 'aal2', approvalMode: 'single-admin' }),
  'shared-observability:delete-runtime': Object.freeze({ riskClass: 'R1', assurance: 'aal2', approvalMode: 'single-admin' }),
  'shared-observability:reinstall': Object.freeze({ riskClass: 'R1', assurance: 'aal2', approvalMode: 'single-admin' }),
  'shared-observability:purge': Object.freeze({ riskClass: 'R3', assurance: 'aal2', approvalMode: 'not-available' }),
});

function sha256Json(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function reasonFrom(value) {
  const reason = String(value || '').trim();
  if (reason.length < 8 || reason.length > 1000) {
    throw { code: 400, errorCode: 'reason_required', msg: 'reason must be between 8 and 1000 characters' };
  }
  return reason;
}

function idempotencyKeyFrom(req, body) {
  const key = String(req.headers['x-os-idempotency-key'] || body?.idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(key)) {
    throw {
      code: 400,
      errorCode: 'idempotency_key_required',
      msg: 'x-os-idempotency-key or idempotencyKey (8-160 safe characters) is required',
    };
  }
  return key;
}

function publicModuleDescriptor(module) {
  return {
    id: module.id,
    displayName: module.displayName,
    owner: module.owner,
    adapter: module.adapter,
    status: module.status,
    actions: [...module.actions],
    unavailableActions: module.unavailableActions || {},
    ...(module.unavailableReason ? { unavailableReason: module.unavailableReason } : {}),
  };
}

function observabilityItem(status) {
  return (Array.isArray(status?.items) ? status.items : [])
    .find((item) => item?.id === 'kube-prometheus-stack') || null;
}

function observabilityProjection(status) {
  const item = observabilityItem(status);
  const profile = (Array.isArray(status?.profiles) ? status.profiles : [])
    .find((candidate) => candidate?.name === 'Observability') || null;
  const release = item?.release || null;
  const operation = item?.operation || null;
  const observedAt = status?.checkedAt || item?.check?.checkedAt || new Date().toISOString();
  const current = {
    installed: release?.managed === true,
    activated: profile?.selected === true,
    ready: item?.check?.state === 'Ready',
    state: item?.check?.state || (release?.managed ? 'Unknown' : 'Absent'),
    reason: item?.check?.reason || item?.check?.message || '',
    release: release ? {
      status: release.status || '',
      revision: Number(release.revision || 0),
      chart: release.chart || item?.chartName || '',
      chartVersion: release.chartVersion || item?.chartVersion || '',
      appVersion: release.appVersion || item?.appVersion || '',
    } : null,
    operation: operation ? {
      id: String(operation.id || ''),
      action: String(operation.action || ''),
      phase: String(operation.phase || ''),
      updatedAt: operation.updatedAt || operation.completedAt || operation.startedAt || '',
      error: operation.error || '',
    } : null,
    evidence: item?.check?.details || null,
    observedAt,
  };
  return {
    current,
    targetFingerprint: sha256Json({
      module: 'shared-observability',
      release: current.release,
      state: current.state,
      operation: current.operation ? {
        id: current.operation.id,
        phase: current.operation.phase,
      } : null,
    }),
  };
}

function ownerRequestBody(action, reason, body) {
  if (action === 'install' || action === 'reinstall') {
    return {
      path: '/api/hiss/install',
      body: {
        id: 'kube-prometheus-stack',
        reason,
        ...(body?.config ? { config: body.config } : {}),
        ...(body?.chartVersion ? { chartVersion: body.chartVersion } : {}),
      },
    };
  }
  if (action === 'verify') {
    return {
      path: '/api/hiss/validate',
      body: { id: 'kube-prometheus-stack', reason },
    };
  }
  if (action === 'delete-runtime') {
    if (String(body?.confirm || '') !== 'kube-prometheus-stack') {
      throw { code: 400, errorCode: 'confirmation_required', msg: "confirm must equal 'kube-prometheus-stack'" };
    }
    return {
      path: '/api/hiss/uninstall',
      body: { id: 'kube-prometheus-stack', reason, confirm: 'kube-prometheus-stack' },
    };
  }
  throw { code: 400, errorCode: 'unsupported_action', msg: `unsupported action: ${action}` };
}

function ownerTerminalResult(row, projection) {
  const ownerOperationId = String(row.evidence_ref || '').replace(/^his-operation:/, '');
  const ownerOperation = projection.current.operation;
  if (ownerOperationId && ownerOperation?.id === ownerOperationId) {
    if (ownerOperation.phase === 'Failed' || ownerOperation.phase === 'RollbackStalled') {
      return { phase: 'Failed', errorCode: 'owner_operation_failed' };
    }
    if (ownerOperation.phase === 'Ready' || ownerOperation.phase === 'Removed') {
      return { phase: 'Succeeded', errorCode: null };
    }
    if (ACTIVE_OWNER_PHASES.has(ownerOperation.phase)) {
      return { phase: row.action === 'verify' ? 'Verifying' : 'Running', errorCode: null };
    }
  }
  if (row.action === 'delete-runtime' && projection.current.installed === false) {
    return { phase: 'Succeeded', errorCode: null };
  }
  if (['install', 'reinstall'].includes(row.action) && projection.current.installed && projection.current.ready) {
    return { phase: 'Succeeded', errorCode: null };
  }
  if (row.action === 'verify' && projection.current.ready) {
    return { phase: 'Succeeded', errorCode: null };
  }
  return null;
}

function normalizeRow(row) {
  return {
    operationId: row.operation_id,
    idempotencyKey: row.idempotency_key,
    moduleId: row.module_id,
    action: row.action,
    actorId: row.actor_id,
    reason: row.reason,
    assurance: row.assurance,
    riskClass: row.risk_class,
    targetFingerprint: row.target_fingerprint,
    phase: row.phase,
    executionState: row.execution_state || null,
    verificationState: row.verification_state || null,
    result: row.result || {},
    errorCode: row.error_code || null,
    evidenceRef: row.evidence_ref || null,
    rollbackResult: row.rollback_result || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function moduleOperationState(phase) {
  switch (String(phase || '')) {
    case 'Queued': return { execution_state: 'accepted', verification_state: 'pending' };
    case 'AwaitingApproval': return { execution_state: 'awaiting_approval', verification_state: 'pending' };
    case 'Running': return { execution_state: 'executing', verification_state: 'pending' };
    case 'Verifying': return { execution_state: 'complete', verification_state: 'verifying' };
    case 'Succeeded': return { execution_state: 'complete', verification_state: 'succeeded' };
    case 'VerificationFailed': return { execution_state: 'complete', verification_state: 'failed' };
    case 'Inconclusive': return { execution_state: 'complete', verification_state: 'inconclusive' };
    case 'Failed': return { execution_state: 'failed', verification_state: 'not_required' };
    case 'RollingBack': return { execution_state: 'rolling_back', verification_state: 'failed' };
    case 'RolledBack': return { execution_state: 'rolled_back', verification_state: 'failed' };
    default: return {};
  }
}

function createModuleOperationApi({
  restRequest,
  authenticate,
  readBody,
  ownerRequest,
  logAudit,
}) {
  async function getOwnerProjection(authorization) {
    const status = await ownerRequest('/api/hiss/status', { method: 'GET', authorization });
    return observabilityProjection(status);
  }

  async function findByIdempotencyKey(key) {
    const rows = await restRequest('module_operation', {
      query: `select=*&idempotency_key=eq.${encodeURIComponent(key)}&limit=1`,
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  async function findOperation(operationId) {
    const rows = await restRequest('module_operation', {
      query: `select=*&operation_id=eq.${encodeURIComponent(operationId)}&limit=1`,
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  async function patchOperation(operationId, patch) {
    const rows = await restRequest('module_operation', {
      method: 'PATCH',
      query: `operation_id=eq.${encodeURIComponent(operationId)}&select=*`,
      body: { ...patch, updated_at: new Date().toISOString() },
      prefer: 'return=representation',
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  async function reconcileOperation(row, authorization) {
    if (!row || TERMINAL_PHASES.has(row.phase) || row.module_id !== 'shared-observability') return row;
    const projection = await getOwnerProjection(authorization);
    const outcome = ownerTerminalResult(row, projection);
    if (!outcome || (outcome.phase === row.phase && outcome.errorCode === row.error_code)) return row;
    return patchOperation(row.operation_id, {
      phase: outcome.phase,
      ...moduleOperationState(outcome.phase),
      error_code: outcome.errorCode,
      result: {
        ...(row.result || {}),
        observed: projection.current,
        verifiedAt: new Date().toISOString(),
      },
    });
  }

  async function submit(req, moduleId, body, authorization, actor) {
    const module = MODULES[moduleId];
    if (!module) throw { code: 404, errorCode: 'module_not_found', msg: 'module not found' };
    const action = String(body?.action || '').trim();
    const policy = RISK_TABLE[`${moduleId}:${action}`];
    if (!policy || !module.actions.includes(action)) {
      const unavailableReason = module.unavailableActions?.[action] || module.unavailableReason;
      throw {
        code: unavailableReason ? 409 : 400,
        errorCode: unavailableReason ? 'not_available' : 'unsupported_action',
        msg: unavailableReason || `unsupported action: ${action}`,
      };
    }
    if (policy.approvalMode === 'not-available') {
      throw { code: 409, errorCode: 'not_available', msg: 'this R3 action is not available' };
    }
    const reason = reasonFrom(body?.reason);
    const idempotencyKey = idempotencyKeyFrom(req, body);
    const existing = await findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.module_id !== moduleId || existing.action !== action || existing.actor_id !== actor.sub) {
        throw { code: 409, errorCode: 'idempotency_conflict', msg: 'idempotency key belongs to a different operation intent' };
      }
      const reconciled = await reconcileOperation(existing, authorization).catch(() => existing);
      return { duplicate: true, receipt: normalizeRow(reconciled) };
    }

    const projection = await getOwnerProjection(authorization);
    if (action === 'reinstall' && projection.current.installed) {
      throw { code: 409, errorCode: 'runtime_present', msg: 'delete runtime and verify absence before reinstall' };
    }
    if (action === 'install' && projection.current.installed) {
      throw { code: 409, errorCode: 'already_installed', msg: 'Shared Observability is already installed' };
    }
    const operationId = randomUUID();
    let inserted;
    try {
      const rows = await restRequest('module_operation', {
        method: 'POST',
        query: 'select=*',
        body: [{
          operation_id: operationId,
          idempotency_key: idempotencyKey,
          module_id: moduleId,
          action,
          actor_id: actor.sub,
          reason,
          assurance: actor.assurance || 'aal1',
          risk_class: policy.riskClass,
          target_fingerprint: projection.targetFingerprint,
          phase: 'Queued',
          ...moduleOperationState('Queued'),
          result: { acceptedAt: new Date().toISOString(), owner: module.owner },
        }],
        prefer: 'return=representation',
      });
      inserted = rows[0];
    } catch (error) {
      if (error?.code !== 409) throw error;
      inserted = await findByIdempotencyKey(idempotencyKey);
      if (!inserted) throw error;
    }
    if (inserted.operation_id !== operationId) {
      if (inserted.module_id !== moduleId || inserted.action !== action || inserted.actor_id !== actor.sub) {
        throw { code: 409, errorCode: 'idempotency_conflict', msg: 'idempotency key belongs to a different operation intent' };
      }
      return { duplicate: true, receipt: normalizeRow(inserted) };
    }

    const ownerCall = ownerRequestBody(action, reason, body);
    try {
      const ownerResult = await ownerRequest(ownerCall.path, {
        method: 'POST',
        authorization,
        body: ownerCall.body,
      });
      const ownerOperation = ownerResult?.operation || null;
      const row = await patchOperation(operationId, {
        phase: action === 'verify' ? 'Verifying' : 'Running',
        ...moduleOperationState(action === 'verify' ? 'Verifying' : 'Running'),
        evidence_ref: ownerOperation?.id ? `his-operation:${ownerOperation.id}` : null,
        result: {
          ...(inserted.result || {}),
          ownerAcceptedAt: new Date().toISOString(),
          ownerOperation,
        },
      });
      await logAudit(actor, `module.${action}`, moduleId, 'accepted', reason, {
        requestId: operationId,
        phase: 'requested',
        targetType: 'module-operation',
      });
      return { duplicate: false, receipt: normalizeRow(row), ownerOperation };
    } catch (error) {
      await patchOperation(operationId, {
        phase: 'Failed',
        ...moduleOperationState('Failed'),
        error_code: error?.errorCode || `owner_http_${error?.code || 500}`,
        result: {
          ...(inserted.result || {}),
          failedAt: new Date().toISOString(),
          message: String(error?.msg || 'owner request failed').slice(0, 500),
        },
      }).catch(() => {});
      throw error;
    }
  }

  async function handle(req, res, pathname, json) {
    const listPath = pathname === '/api/modules';
    const moduleMatch = pathname.match(/^\/api\/modules\/([a-z0-9-]+)$/);
    const operationCreateMatch = pathname.match(/^\/api\/modules\/([a-z0-9-]+)\/operations$/);
    const verifyMatch = pathname.match(/^\/api\/modules\/([a-z0-9-]+)\/verify$/);
    const operationMatch = pathname.match(/^\/api\/module-operations\/([0-9a-f-]{36})$/i);
    if (!listPath && !moduleMatch && !operationCreateMatch && !verifyMatch && !operationMatch) return false;

    try {
      const mutation = req.method === 'POST';
      let operationBody = null;
      if ((operationCreateMatch || verifyMatch) && mutation) {
        operationBody = await readBody(req);
        if (verifyMatch) operationBody.action = 'verify';
      }
      const auth = await authenticate(req, {
        mutation,
        action: String(operationBody?.action || '').trim(),
      });
      if (listPath && req.method === 'GET') {
        const descriptors = Object.values(MODULES).map(publicModuleDescriptor);
        const projection = await getOwnerProjection(auth.authorization).catch((error) => ({
          error: String(error?.msg || 'Shared Observability owner unavailable'),
        }));
        return json(res, 200, {
          items: descriptors.map((item) => item.id === 'shared-observability'
            ? { ...item, current: projection.current || null, targetFingerprint: projection.targetFingerprint || null, ownerError: projection.error || null }
            : item),
        }), true;
      }
      if (moduleMatch && req.method === 'GET') {
        const module = MODULES[moduleMatch[1]];
        if (!module) return json(res, 404, { error: 'module not found', errorCode: 'module_not_found' }), true;
        const projection = module.id === 'shared-observability'
          ? await getOwnerProjection(auth.authorization)
          : null;
        return json(res, 200, {
          ...publicModuleDescriptor(module),
          current: projection?.current || null,
          targetFingerprint: projection?.targetFingerprint || null,
        }), true;
      }
      if (operationMatch && req.method === 'GET') {
        let row = await findOperation(operationMatch[1]);
        if (!row) return json(res, 404, { error: 'module operation not found', errorCode: 'operation_not_found' }), true;
        row = await reconcileOperation(row, auth.authorization);
        return json(res, 200, { receipt: normalizeRow(row) }), true;
      }
      if ((operationCreateMatch || verifyMatch) && req.method === 'POST') {
        const body = operationBody;
        const result = await submit(req, (operationCreateMatch || verifyMatch)[1], body, auth.authorization, auth.actor);
        const action = result.receipt.action === 'delete-runtime' ? 'uninstall'
          : result.receipt.action === 'verify' ? 'validate'
            : result.receipt.action;
        return json(res, result.duplicate ? 200 : 202, {
          ok: true,
          duplicate: result.duplicate,
          receipt: result.receipt,
          operation: result.ownerOperation || {
            id: result.receipt.operationId,
            action,
            phase: result.receipt.phase,
          },
        }), true;
      }
      return json(res, 405, { error: 'method not allowed' }), true;
    } catch (error) {
      return json(res, Number(error?.code) >= 400 ? Number(error.code) : 500, {
        error: error?.msg || 'module operation unavailable',
        errorCode: error?.errorCode || null,
      }), true;
    }
  }

  return { handle };
}

module.exports = {
  MODULES,
  RISK_TABLE,
  createModuleOperationApi,
  idempotencyKeyFrom,
  observabilityProjection,
  ownerRequestBody,
  ownerTerminalResult,
  moduleOperationState,
  reasonFrom,
};
