const REQUIRED_OBSERVABILITY_CAPABILITIES = Object.freeze(['metrics', 'alerting', 'dashboards', 'logs', 'traces', 'otlp']);
const REQUIRED_HIS_OWNER_CAPABILITIES = Object.freeze(['observability-config-read', 'observability-plan', 'observability-configure']);
const REQUIRED_CEPH_OWNER_CAPABILITIES = Object.freeze(['status-read', 'plan-from-import', 'connect-from-import', 'disconnect']);
const REQUIRED_RECOVERY_OWNER_CAPABILITIES = Object.freeze(['status-read', 'plan-read', 'drill-request', 'evidence-promote']);

function normalizedSet(values) {
  return new Set(Array.from(values || []).map((value) => String(value).trim()).filter(Boolean));
}

function missingCapabilities(required, actual) {
  const have = normalizedSet(actual);
  return required.filter((capability) => !have.has(capability));
}

function buildAgentControlReadiness(input = {}) {
  const core = input.coreReadiness || {};
  const semanticSearch = core.capabilities?.semanticSearch || { ready: false, reason: 'embedding_readiness_unknown' };
  const runtimeProjection = core.capabilities?.runtimeProjection || { ready: false, reason: 'runtime_projection_unknown' };
  const mutationLifecycle = input.mutationLifecycle || { ready: false, reason: 'mutation_lifecycle_unknown' };
  const platformReadiness = input.platformReadiness || { ready: false, phase: 'Unknown' };
  const missing = {
    observability: missingCapabilities(REQUIRED_OBSERVABILITY_CAPABILITIES, input.observabilityCapabilities),
    hisOwner: missingCapabilities(REQUIRED_HIS_OWNER_CAPABILITIES, input.hisOwnerCapabilities),
    cephOwner: missingCapabilities(REQUIRED_CEPH_OWNER_CAPABILITIES, input.cephOwnerCapabilities),
    recoveryOwner: missingCapabilities(REQUIRED_RECOVERY_OWNER_CAPABILITIES, input.recoveryOwnerCapabilities),
  };
  const blockers = [];
  if (!core.ready) blockers.push(String(core.reason || 'oaa_core_not_ready'));
  if (!input.llmConfigured) blockers.push('llm_key_not_configured');
  if (!semanticSearch.ready) blockers.push(String(semanticSearch.reason || 'semantic_search_not_ready'));
  if (!runtimeProjection.ready) blockers.push(String(runtimeProjection.reason || 'runtime_projection_not_ready'));
  if (!mutationLifecycle.ready) blockers.push(String(mutationLifecycle.reason || 'mutation_lifecycle_not_ready'));
  if (!platformReadiness.ready) blockers.push(`platform_support_${String(platformReadiness.phase || 'not_ready').toLowerCase()}`);
  for (const capability of Array.isArray(platformReadiness.capabilities) ? platformReadiness.capabilities : []) {
    if (!capability?.ready && capability?.type) blockers.push(`platform_support_${String(capability.type).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_not_ready`);
  }
  if (Array.isArray(input.ownerApisUnavailable) && input.ownerApisUnavailable.length) blockers.push('owner_api_unavailable');
  if (missing.observability.length) blockers.push('observability_capability_incomplete');
  if (missing.hisOwner.length) blockers.push('his_owner_capability_incomplete');
  if (missing.cephOwner.length) blockers.push('ceph_owner_capability_incomplete');
  if (missing.recoveryOwner.length) blockers.push('recovery_owner_capability_incomplete');

  return {
    apiVersion: 'opensphere.io/oaa-agent-readiness/v1',
    fullyOperational: blockers.length === 0,
    blockers: [...new Set(blockers)],
    core: { ready: Boolean(core.ready), reason: core.reason || null },
    llm: { configured: Boolean(input.llmConfigured) },
    knowledge: { lexicalReady: Boolean(core.ready), semanticSearch },
    runtimeProjection,
    actionSubmission: {
      ready: Boolean(mutationLifecycle.ready),
      reason: mutationLifecycle.reason || null,
      clusterManagerActivated: Boolean(mutationLifecycle.clusterManagerActivated),
      hisPreflightReady: Boolean(mutationLifecycle.hisPreflightReady),
    },
    platformSupport: {
      ready: Boolean(platformReadiness.ready),
      phase: platformReadiness.phase || 'Unknown',
      capabilities: Array.isArray(platformReadiness.capabilities)
        ? platformReadiness.capabilities.map((value) => ({ type: value.type, ready: Boolean(value.ready), reason: value.reason || null }))
        : [],
    },
    ownerApis: { ready: !(input.ownerApisUnavailable || []).length, unavailable: input.ownerApisUnavailable || [] },
    requiredCapabilities: {
      observability: REQUIRED_OBSERVABILITY_CAPABILITIES,
      hisOwner: REQUIRED_HIS_OWNER_CAPABILITIES,
      cephOwner: REQUIRED_CEPH_OWNER_CAPABILITIES,
      recoveryOwner: REQUIRED_RECOVERY_OWNER_CAPABILITIES,
    },
    observedCapabilities: {
      observability: [...normalizedSet(input.observabilityCapabilities)].sort(),
      hisOwner: [...normalizedSet(input.hisOwnerCapabilities)].sort(),
      cephOwner: [...normalizedSet(input.cephOwnerCapabilities)].sort(),
      recoveryOwner: [...normalizedSet(input.recoveryOwnerCapabilities)].sort(),
    },
    missingCapabilities: missing,
  };
}

module.exports = {
  REQUIRED_CEPH_OWNER_CAPABILITIES,
  REQUIRED_HIS_OWNER_CAPABILITIES,
  REQUIRED_OBSERVABILITY_CAPABILITIES,
  REQUIRED_RECOVERY_OWNER_CAPABILITIES,
  buildAgentControlReadiness,
  missingCapabilities,
};
