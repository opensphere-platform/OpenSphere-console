'use strict';

const FOUNDATION_CONTRACT_CRDS = Object.freeze([
  'foundationmodels.foundation.opensphere.io',
  'foundationrecoveryevidences.foundation.opensphere.io',
  'foundationmoduledescriptors.foundation.opensphere.io',
  'foundationclaims.foundation.opensphere.io',
  'foundationbindings.foundation.opensphere.io',
  'identitydirectoryclaims.foundation.opensphere.io',
  'identitydirectorybindings.foundation.opensphere.io',
]);

const CONSUMER_PROTECT_FINALIZER = 'foundation.opensphere.io/consumer-protect';
const MODEL_EVIDENCE_MAX_AGE_MS = 2 * 60 * 1000;
const BINDING_EVIDENCE_MAX_AGE_MS = 2 * 60 * 1000;

function crdEstablished(item) {
  return Boolean(item)
    && Array.isArray(item?.status?.conditions)
    && item.status.conditions.some((condition) => condition?.type === 'Established' && condition?.status === 'True');
}

function deploymentReady(item) {
  if (!item) return false;
  const desired = Number(item?.spec?.replicas ?? 1);
  const status = item?.status || {};
  return Number(status.observedGeneration || 0) >= Number(item?.metadata?.generation || 0)
    && Number(status.updatedReplicas || 0) === desired
    && Number(status.availableReplicas || 0) === desired
    && Number(status.readyReplicas || 0) === desired;
}

function responseState(result, missingReason) {
  if (result?.ok) return { readable: true, missing: false, reason: '' };
  if (result?.status === 404) return { readable: true, missing: true, reason: missingReason };
  return {
    readable: false,
    missing: false,
    reason: result?.status ? `Kubernetes API HTTP ${result.status}` : 'Kubernetes API evidence unavailable',
  };
}

function listItems(result) {
  return result?.ok && Array.isArray(result?.json?.items) ? result.json.items : [];
}

function timestampFresh(value, nowMs, maxAgeMs) {
  const observed = Date.parse(String(value || ''));
  return Number.isFinite(observed)
    && observed <= nowMs + (30 * 1000)
    && nowMs - observed <= maxAgeMs;
}

function validModel(item, nowMs = Date.now()) {
  const name = String(item?.metadata?.name || '');
  const model = String(item?.spec?.model || '');
  return name !== ''
    && name === model
    && String(item?.spec?.desiredState || '') === 'Installed'
    && String(item?.status?.phase || '') === 'Installed'
    && item?.status?.operator?.deployed === true
    && timestampFresh(item?.status?.observedAt, nowMs, MODEL_EVIDENCE_MAX_AGE_MS);
}

function validDescriptor(item) {
  return String(item?.metadata?.name || '') !== ''
    && String(item?.spec?.model || '') === String(item?.metadata?.name || '');
}

function bindingConnected(item, nowMs = Date.now()) {
  const phase = String(item?.status?.phase || '');
  const conditions = Array.isArray(item?.status?.conditions) ? item.status.conditions : [];
  const connected = phase === 'Connected'
    || conditions.some((condition) => ['Connected', 'Ready'].includes(String(condition?.type || ''))
      && condition?.status === 'True');
  return connected
    && timestampFresh(item?.status?.connection?.lastCheck || item?.status?.observedAt, nowMs, BINDING_EVIDENCE_MAX_AGE_MS);
}

function protectedBinding(item) {
  return Array.isArray(item?.metadata?.finalizers)
    && item.metadata.finalizers.includes(CONSUMER_PROTECT_FINALIZER);
}

function evidenceCondition(key, label, ready, state, detail) {
  return { key, label, ready: Boolean(ready), state, detail: String(detail || '') };
}

function foundationEstablishmentProjection({
  now = Date.now(),
  supportReady = false,
  shellReady = false,
  bootstrapOwner = { ok: false, status: 503, json: null },
  crds = { ok: false, status: 503, json: null },
  controlPlane = { ok: false, status: 503, json: null },
  models = { ok: false, status: 503, json: null },
  descriptors = { ok: false, status: 503, json: null },
  bindings = { ok: false, status: 503, json: null },
} = {}) {
  const bootstrapOwnerState = responseState(bootstrapOwner, 'foundation-bootstrap-reconciler Deployment is missing');
  const bootstrapOwnerReady = bootstrapOwnerState.readable
    && !bootstrapOwnerState.missing
    && deploymentReady(bootstrapOwner.json);
  const crdState = responseState(crds, 'Foundation contract CRD inventory is unavailable');
  const crdByName = new Map(listItems(crds).map((item) => [String(item?.metadata?.name || ''), item]));
  const contractItems = FOUNDATION_CONTRACT_CRDS.map((name) => ({
    name,
    ready: crdState.readable && crdEstablished(crdByName.get(name)),
  }));
  const contractsReady = contractItems.every((item) => item.ready);

  const controlPlaneState = responseState(controlPlane, 'foundation-control-plane Deployment is missing');
  const controlPlaneReady = controlPlaneState.readable && !controlPlaneState.missing && deploymentReady(controlPlane.json);

  const modelState = responseState(models, 'FoundationModel API is missing');
  const modelItems = listItems(models);
  const modelsReady = modelState.readable && !modelState.missing
    && modelItems.length > 0 && modelItems.every((item) => validModel(item, now));

  const descriptorState = responseState(descriptors, 'FoundationModuleDescriptor API is missing');
  const descriptorItems = listItems(descriptors);
  const descriptorsReady = descriptorState.readable && !descriptorState.missing
    && descriptorItems.length > 0 && descriptorItems.every(validDescriptor);

  const bindingState = responseState(bindings, 'FoundationBinding API is missing');
  const bindingItems = listItems(bindings);
  const connected = bindingItems.filter((item) => bindingConnected(item, now));
  const protectedConnected = connected.filter(protectedBinding);
  const bindingReady = bindingState.readable && !bindingState.missing && protectedConnected.length > 0;

  const conditions = [
    evidenceCondition(
      'support-profile',
      'Platform Support Profile Ready',
      supportReady,
      supportReady ? 'Ready' : 'Blocked',
      supportReady ? 'Required support evidence is live' : 'HIS and all required support capabilities must be Ready',
    ),
    evidenceCondition(
      'foundation-shell',
      'Foundation management surface',
      shellReady,
      shellReady ? 'Ready' : 'Staged',
      shellReady ? 'Extension workload and serving projection are verified' : 'Foundation Extension is not serving as an activated management surface',
    ),
    evidenceCondition(
      'foundation-bootstrap-owner',
      'Governed Foundation bootstrap owner',
      bootstrapOwnerReady,
      !bootstrapOwnerState.readable ? 'Error' : bootstrapOwnerState.missing ? 'Missing' : 'NotReady',
      bootstrapOwnerReady
        ? 'Dedicated reviewed-change reconciler rollout is Ready'
        : bootstrapOwnerState.reason || 'Dedicated reviewed-change reconciler rollout is not Ready',
    ),
    evidenceCondition(
      'foundation-contracts',
      'Foundation contract APIs',
      contractsReady,
      !crdState.readable ? 'Error' : 'Missing',
      contractsReady
        ? `${contractItems.length}/${contractItems.length} CRDs Established`
        : `${contractItems.filter((item) => item.ready).length}/${contractItems.length} CRDs Established`,
    ),
    evidenceCondition(
      'foundation-control-plane',
      'Foundation Control Plane',
      controlPlaneReady,
      !controlPlaneState.readable ? 'Error' : controlPlaneState.missing ? 'Missing' : 'NotReady',
      controlPlaneReady ? 'Deployment rollout is fully observed and Ready' : controlPlaneState.reason || 'Deployment rollout is not Ready',
    ),
    evidenceCondition(
      'foundation-models',
      'Model and descriptor consistency',
      modelsReady && descriptorsReady,
      !modelState.readable || !descriptorState.readable ? 'Error' : 'Missing',
      modelsReady && descriptorsReady
        ? `${modelItems.length} model(s), ${descriptorItems.length} descriptor(s) are consistent`
        : `${modelItems.length} model(s), ${descriptorItems.length} descriptor(s); name/model and desiredState must be consistent`,
    ),
    evidenceCondition(
      'claim-binding-proof',
      'Claim→Binding consumer protection proof',
      bindingReady,
      !bindingState.readable ? 'Error' : 'Missing',
      bindingReady
        ? `${protectedConnected.length} Connected binding(s) retain ${CONSUMER_PROTECT_FINALIZER}`
        : `${connected.length} Connected binding(s), ${protectedConnected.length} protected by finalizer`,
    ),
  ];

  const evidenceUnavailable = [bootstrapOwnerState, crdState, controlPlaneState, modelState, descriptorState, bindingState]
    .some((state) => !state.readable);
  let phase = 'NotEstablished';
  if (supportReady) {
    phase = evidenceUnavailable ? 'Blocked'
      : conditions.every((condition) => condition.ready) ? 'Established'
        : 'Establishing';
  }

  return {
    schema: 'foundation-establishment.opensphere.io/v1alpha1',
    phase,
    established: phase === 'Established',
    shellReady: Boolean(shellReady),
    conditions,
    blockers: conditions.filter((condition) => !condition.ready).map((condition) => ({
      key: condition.key,
      state: condition.state,
      detail: condition.detail,
    })),
    evidence: {
      contractCRDs: contractItems,
      models: modelItems.length,
      descriptors: descriptorItems.length,
      bindings: bindingItems.length,
      connectedBindings: connected.length,
      protectedConnectedBindings: protectedConnected.length,
    },
  };
}

module.exports = {
  FOUNDATION_CONTRACT_CRDS,
  CONSUMER_PROTECT_FINALIZER,
  MODEL_EVIDENCE_MAX_AGE_MS,
  BINDING_EVIDENCE_MAX_AGE_MS,
  crdEstablished,
  deploymentReady,
  validModel,
  validDescriptor,
  bindingConnected,
  protectedBinding,
  foundationEstablishmentProjection,
};
