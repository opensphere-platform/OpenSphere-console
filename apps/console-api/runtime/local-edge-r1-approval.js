'use strict';

const LOCAL_EDGE_R1_MODE = 'local-edge-r1-single-admin';
const LOCAL_EDGE_R1_TOOLS = new Set([
  'osaa.k8s.workload.restart',
  'osaa.k8s.workload.scale',
]);

function localhostHttps(publicUrl) {
  let value;
  try { value = new URL(String(publicUrl || '')); }
  catch { return false; }
  return value.protocol === 'https:'
    && ['localhost', '127.0.0.1', '::1'].includes(value.hostname);
}

function localEdgeR1ApprovalPolicy({
  publicUrl,
  installedSummary,
  descriptor,
  ownerRoute,
  consumerId,
  action,
  desiredState,
} = {}) {
  const eligible = localhostHttps(publicUrl)
    && installedSummary?.channel === 'edge'
    && installedSummary?.buildAuthority === 'localhost'
    && installedSummary?.releaseClass === 'pre-ga'
    && descriptor?.riskClass === 'R1'
    && descriptor?.assurance === 'aal2'
    && descriptor?.ownerRoute === 'cluster-manager/workloads'
    && ownerRoute === descriptor.ownerRoute
    && consumerId === 'osaa-gateway'
    && String(action || '').toLowerCase() === 'apply'
    && LOCAL_EDGE_R1_TOOLS.has(String(desiredState?.toolId || ''))
    && String(desiredState?.toolId || '') === String(descriptor?.governedToolId || '')
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(String(desiredState?.durableOperationId || ''))
    && String(desiredState?.inputs?.confirm || '').length > 0;
  if (!eligible) return null;
  return Object.freeze({
    mode: LOCAL_EDGE_R1_MODE,
    requiredHumanApprovals: 1,
    approvingHuman: 'requesting-admin',
    autoMerge: true,
    auditRequired: true,
    rationale: 'localhost edge R1 uses one recently AAL2-verified administrator and preserves the governed OSCE reconciliation path',
  });
}

module.exports = {
  LOCAL_EDGE_R1_MODE,
  LOCAL_EDGE_R1_TOOLS,
  localhostHttps,
  localEdgeR1ApprovalPolicy,
};
