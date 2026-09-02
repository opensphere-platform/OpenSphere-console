'use strict';

const http = require('http');
const fs = require('fs');
const {
  FOUNDATION_BOOTSTRAP_RECONCILER,
  FOUNDATION_BOOTSTRAP_CONSUMER,
  FOUNDATION_BOOTSTRAP_TARGET,
  FOUNDATION_BOOTSTRAP_CATALOG_VERSION,
  FOUNDATION_BOOTSTRAP_CATALOG_SHA256,
  FOUNDATION_BOOTSTRAP_DESIRED_STATE,
  canonicalJson,
  desiredStateDigest,
} = require('./foundation-bootstrap-contract');
const {
  loadFoundationBootstrapCatalog,
} = require('./foundation-bootstrap-bundle');

const PORT = Number(process.env.PORT || 8080);
const BACKEND_URL = (process.env.CONSOLE_BACKEND_URL
  || 'http://opensphere-console-backend.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const GITEA_URL = (process.env.GITEA_URL
  || 'http://opensphere-gitea.opensphere-console-change.svc.cluster.local:3000').replace(/\/$/, '');
const GITEA_ORGANIZATION = process.env.GITEA_ORGANIZATION || 'opensphere';
const GITEA_REPOSITORY = process.env.GITEA_REPOSITORY || 'platform-declarations';
const GITEA_PATH = String(process.env.GITEA_PATH || 'foundation-bootstrap').replace(/^\/+|\/+$/g, '');
const GITEA_TOKEN = process.env.GITEA_TOKEN || '';
const RECONCILER_TOKEN = process.env.RECONCILER_TOKEN || '';
const APISERVER = process.env.APISERVER || 'https://kubernetes.default.svc';
const SA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount';
const POLL_INTERVAL_MS = clamp(Number(process.env.POLL_INTERVAL_MS || 5000), 2000, 60000);
const ROLLOUT_TIMEOUT_MS = clamp(Number(process.env.ROLLOUT_TIMEOUT_MS || 600000), 60000, 900000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_RE = /^[0-9a-f]{40,64}$/i;
const PLATFORM_SUPPORT_PROFILE_PATH =
  '/apis/platform.opensphere.io/v1alpha1/namespaces/opensphere-console/platformsupportprofiles/default';
const FOUNDATION_CRDS = Object.freeze([
  'foundationmodels.foundation.opensphere.io',
  'foundationmoduledescriptors.foundation.opensphere.io',
  'foundationclaims.foundation.opensphere.io',
  'foundationbindings.foundation.opensphere.io',
  'identitydirectoryclaims.foundation.opensphere.io',
  'identitydirectorybindings.foundation.opensphere.io',
]);
const OFFICIAL_FOUNDATION_IMAGE_RE =
  /^ghcr\.io\/opensphere-platform\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*@sha256:[a-f0-9]{64}$/;
const CONSUMER_PROTECT_FINALIZER = 'foundation.opensphere.io/consumer-protect';
const BOOTSTRAP_CANARY_NAME = 'foundation-bootstrap-observability';
const BOOTSTRAP_CANARY_NAMESPACE = 'opensphere-system';

let lastClaimAt = null;
let lastSuccessAt = null;
let lastError = null;
let activeRequestId = null;
let stopping = false;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function serviceAccountToken() { return fs.readFileSync(`${SA_PATH}/token`, 'utf8').trim(); }
function encodedPath(value) { return String(value).split('/').map(encodeURIComponent).join('/'); }

async function jsonRequest(url, options = {}) {
  const { timeoutMs = 10000, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { raw: text }; }
  if (!response.ok) throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
  return body;
}

async function kubernetesRequest(method, path, body, contentType = 'application/json') {
  const response = await fetch(`${APISERVER}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${serviceAccountToken()}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': contentType }),
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; }
  catch { parsed = { raw: text }; }
  if (!response.ok) {
    const error = new Error(parsed?.message || `Kubernetes HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

async function kubernetesGet(path) {
  return kubernetesRequest('GET', path);
}

function crdEstablished(crd) {
  return Array.isArray(crd?.status?.conditions)
    && crd.status.conditions.some((condition) => condition?.type === 'Established' && condition?.status === 'True');
}

function deploymentReady(deployment) {
  const desired = Number(deployment?.spec?.replicas ?? 1);
  const generation = Number(deployment?.metadata?.generation ?? 0);
  const status = deployment?.status || {};
  return Number(status.observedGeneration ?? 0) >= generation
    && Number(status.updatedReplicas ?? 0) === desired
    && Number(status.availableReplicas ?? 0) === desired
    && Number(status.readyReplicas ?? 0) === desired;
}

function supportProfileReady(profile) {
  const generation = Number(profile?.metadata?.generation ?? 0);
  const status = profile?.status || {};
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  return status.phase === 'Ready'
    && Number(status.observedGeneration ?? 0) >= generation
    && conditions.length > 0
    && conditions.every((condition) => condition?.status === 'True');
}

function hasConsumerProtectFinalizer(resource) {
  return Array.isArray(resource?.metadata?.finalizers)
    && resource.metadata.finalizers.includes(CONSUMER_PROTECT_FINALIZER);
}

function foundationModelInstalled(model, expectedName) {
  return model?.metadata?.name === expectedName
    && model?.spec?.model === expectedName
    && model?.status?.phase === 'Installed';
}

function bootstrapCanaryReady(claim, binding) {
  return claim?.metadata?.name === BOOTSTRAP_CANARY_NAME
    && claim?.metadata?.namespace === BOOTSTRAP_CANARY_NAMESPACE
    && claim?.spec?.model === 'observability'
    && claim?.status?.phase === 'Bound'
    && hasConsumerProtectFinalizer(claim)
    && binding?.metadata?.name === `${BOOTSTRAP_CANARY_NAME}-binding`
    && binding?.metadata?.namespace === BOOTSTRAP_CANARY_NAMESPACE
    && binding?.status?.phase === 'Connected'
    && hasConsumerProtectFinalizer(binding)
    && binding?.spec?.claimRef?.name === BOOTSTRAP_CANARY_NAME
    && binding?.spec?.claimRef?.namespace === BOOTSTRAP_CANARY_NAMESPACE;
}

function validateCatalogDocument(resource) {
  const kind = new RegExp(`^kind:\\s*${resource.kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const name = new RegExp(`^\\s*name:\\s*${resource.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const inlineName = new RegExp(`^metadata:\\s*\\{[^\\n}]*\\bname:\\s*${resource.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*[,}])`, 'm');
  if (!kind.test(resource.document) || (!name.test(resource.document) && !inlineName.test(resource.document))) {
    throw new Error(`closed catalog identity mismatch for ${resource.kind}/${resource.name}`);
  }
  if (resource.kind === 'Deployment') {
    const imageRefs = [...resource.document.matchAll(/(?:image:\s*|--[a-z-]+-image=)([^\s"']+)/g)]
      .map((match) => match[1]);
    const mutableImages = imageRefs.filter((image) => !/@sha256:[a-f0-9]{64}$/.test(image));
    if (mutableImages.length > 0) throw new Error('Foundation catalog contains a mutable workload or operand image');
  }
}

function catalogImageReferences(catalog) {
  return catalog.flatMap((resource) => (
    resource.kind === 'Deployment'
      ? [...resource.document.matchAll(/(?:image:\s*|--[a-z-]+-image=)([^\s"']+)/g)].map((match) => match[1])
      : []
  ));
}

function catalogSupplyChainStatus(catalog) {
  const images = catalogImageReferences(catalog);
  const blockers = images
    .filter((image) => !OFFICIAL_FOUNDATION_IMAGE_RE.test(image))
    .map((image) => ({
      code: 'FoundationImageOutsideOfficialRegistry',
      image,
      requiredPattern: 'ghcr.io/opensphere-platform/<repository>@sha256:<digest>',
    }));
  return {
    ready: blockers.length === 0,
    checkedImages: images.length,
    blockers,
  };
}

function assertCatalogSupplyChain(catalog) {
  const status = catalogSupplyChainStatus(catalog);
  if (!status.ready) {
    const error = new Error(
      `Foundation bootstrap catalog requires an official immutable GHCR mirror: ${status.blockers.map((item) => item.image).join(', ')}`,
    );
    error.code = 'FoundationSupplyChainBlocked';
    error.supplyChain = status;
    throw error;
  }
  return status;
}

async function applyCatalogResource(resource, dependencies = {}) {
  validateCatalogDocument(resource);
  const request = dependencies.request || kubernetesRequest;
  const get = dependencies.get || kubernetesGet;

  // FoundationModel is the operator-owned desired-state object. The bootstrap
  // catalog may seed it once, but must never re-apply defaults over a live
  // model. In particular spec.parameters.engines is operational data, not a
  // release field. Every other closed-catalog resource remains reconciled.
  if (resource.kind === 'FoundationModel') {
    try {
      return { operation: 'preserved', object: await get(resource.path) };
    } catch (error) {
      if (Number(error?.status) !== 404) throw error;
    }
    const createQuery = `fieldManager=${encodeURIComponent(FOUNDATION_BOOTSTRAP_RECONCILER)}`;
    const object = await request(
      'PATCH',
      `${resource.path}?${createQuery}`,
      resource.document,
      'application/apply-patch+yaml',
    );
    return { operation: 'created', object };
  }

  const query = `fieldManager=${encodeURIComponent(FOUNDATION_BOOTSTRAP_RECONCILER)}&force=true`;
  const object = await request(
    'PATCH',
    `${resource.path}?${query}`,
    resource.document,
    'application/apply-patch+yaml',
  );
  return { operation: 'applied', object };
}

async function waitForContracts() {
  const deadline = Date.now() + ROLLOUT_TIMEOUT_MS;
  let observed = [];
  while (Date.now() < deadline) {
    try {
      observed = await Promise.all(FOUNDATION_CRDS.map((name) =>
        kubernetesGet(`/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${name}`)));
      if (observed.every(crdEstablished)) return observed;
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 500);
    }
    await sleep(2000);
  }
  throw new Error('Foundation contract CRD establishment timed out');
}

async function waitForBootstrapReady() {
  const deadline = Date.now() + ROLLOUT_TIMEOUT_MS;
  let deployment;
  let identity;
  let data;
  let observability;
  let descriptor;
  let observabilityDeployment;
  let canaryClaim;
  let canaryBinding;
  while (Date.now() < deadline) {
    try {
      [
        deployment,
        identity,
        data,
        observability,
        descriptor,
        observabilityDeployment,
        canaryClaim,
        canaryBinding,
      ] = await Promise.all([
        kubernetesGet('/apis/apps/v1/namespaces/opensphere-system/deployments/foundation-control-plane'),
        kubernetesGet('/apis/foundation.opensphere.io/v1alpha1/foundationmodels/identity'),
        kubernetesGet('/apis/foundation.opensphere.io/v1alpha1/foundationmodels/data'),
        kubernetesGet('/apis/foundation.opensphere.io/v1alpha1/foundationmodels/observability'),
        kubernetesGet('/apis/foundation.opensphere.io/v1alpha1/foundationmoduledescriptors/identity'),
        kubernetesGet('/apis/apps/v1/namespaces/opensphere-foundation/deployments/foundation-observability-collector'),
        kubernetesGet(`/apis/foundation.opensphere.io/v1alpha1/namespaces/${BOOTSTRAP_CANARY_NAMESPACE}/foundationclaims/${BOOTSTRAP_CANARY_NAME}`),
        kubernetesGet(`/apis/foundation.opensphere.io/v1alpha1/namespaces/${BOOTSTRAP_CANARY_NAMESPACE}/foundationbindings/${BOOTSTRAP_CANARY_NAME}-binding`),
      ]);
      if (deploymentReady(deployment)
        && deploymentReady(observabilityDeployment)
        && foundationModelInstalled(identity, 'identity')
        && foundationModelInstalled(data, 'data')
        && foundationModelInstalled(observability, 'observability')
        && descriptor?.spec?.model === 'identity'
        && bootstrapCanaryReady(canaryClaim, canaryBinding)) {
        return {
          deployment,
          identity,
          data,
          observability,
          descriptor,
          observabilityDeployment,
          canaryClaim,
          canaryBinding,
        };
      }
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 500);
    }
    await sleep(3000);
  }
  throw new Error('Foundation Control Plane, required observability and Claim→Binding canary verification timed out');
}

async function assertPlatformSupportReady() {
  const profile = await kubernetesGet(PLATFORM_SUPPORT_PROFILE_PATH);
  if (!supportProfileReady(profile)) {
    throw new Error('PlatformSupportProfile/default is not Ready at its current generation');
  }
  return profile;
}

async function claimWork() {
  const response = await jsonRequest(`${BACKEND_URL}/api/platform/reconcile/next`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-opensphere-reconciler-token': RECONCILER_TOKEN,
    },
    body: JSON.stringify({ reconciler: FOUNDATION_BOOTSTRAP_RECONCILER, limit: 1 }),
  });
  lastClaimAt = new Date().toISOString();
  lastError = null;
  return Array.isArray(response.items) ? response.items[0] || null : null;
}

function validateGovernedManifest(manifest, work) {
  if (manifest?.apiVersion !== 'platform.opensphere.io/v1alpha1' || manifest?.kind !== 'GovernedChange') {
    throw new Error('unsupported governed manifest');
  }
  if (manifest?.metadata?.requestId !== work.request_id
    || manifest?.metadata?.consumerId !== FOUNDATION_BOOTSTRAP_CONSUMER) {
    throw new Error('governed manifest identity mismatch');
  }
  if (manifest?.spec?.action !== 'apply' || manifest?.spec?.target !== FOUNDATION_BOOTSTRAP_TARGET) {
    throw new Error('Foundation bootstrap target is outside the closed contract');
  }
  if (manifest.spec.target !== work.target || manifest.spec.reason !== work.reason) {
    throw new Error('governed manifest claim mismatch');
  }
  if (canonicalJson(manifest.spec.desiredState) !== canonicalJson(FOUNDATION_BOOTSTRAP_DESIRED_STATE)) {
    throw new Error('Foundation desired state does not match the embedded release catalog');
  }
  if (manifest.metadata.payloadDigest !== `sha256:${desiredStateDigest()}`) {
    throw new Error('governed manifest payload digest mismatch');
  }
  return manifest;
}

async function loadManifest(work) {
  if (!UUID_RE.test(String(work.request_id || '')) || !COMMIT_RE.test(String(work.git_commit_sha || ''))) {
    throw new Error('claimed Foundation change reference is invalid');
  }
  if (work.git_repo !== `${GITEA_ORGANIZATION}/${GITEA_REPOSITORY}`) {
    throw new Error('claimed repository is outside the Foundation bootstrap contract');
  }
  const path = `${GITEA_PATH}/requests/${work.request_id}.json`;
  const file = await jsonRequest(
    `${GITEA_URL}/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}`
      + `/contents/${encodedPath(path)}?ref=${encodeURIComponent(work.git_commit_sha)}`,
    { headers: { authorization: `token ${GITEA_TOKEN}`, accept: 'application/json' } },
  );
  const raw = Buffer.from(String(file.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
  return validateGovernedManifest(JSON.parse(raw), work);
}

async function applyFoundationBootstrap() {
  const catalog = loadFoundationBootstrapCatalog();
  catalog.forEach(validateCatalogDocument);
  const supplyChain = assertCatalogSupplyChain(catalog);
  const profile = await assertPlatformSupportReady();
  const contracts = catalog.filter((resource) => resource.stage === 'contracts');
  const remaining = catalog.filter((resource) => resource.stage !== 'contracts');
  for (const resource of contracts) await applyCatalogResource(resource);
  await waitForContracts();
  for (const resource of remaining) await applyCatalogResource(resource);
  const observed = await waitForBootstrapReady();
  return {
    contract: FOUNDATION_BOOTSTRAP_DESIRED_STATE.contract,
    catalogVersion: FOUNDATION_BOOTSTRAP_CATALOG_VERSION,
    catalogSha256: FOUNDATION_BOOTSTRAP_CATALOG_SHA256,
    supplyChain,
    platformSupportProfile: {
      name: profile.metadata?.name || 'default',
      generation: profile.metadata?.generation || null,
      observedGeneration: profile.status?.observedGeneration || null,
      phase: profile.status?.phase || null,
    },
    contracts: FOUNDATION_CRDS,
    controlPlane: {
      image: observed.deployment?.spec?.template?.spec?.containers?.[0]?.image || null,
      generation: observed.deployment?.metadata?.generation || null,
      observedGeneration: observed.deployment?.status?.observedGeneration || null,
      readyReplicas: observed.deployment?.status?.readyReplicas || 0,
    },
    models: [
      observed.identity?.metadata?.name,
      observed.data?.metadata?.name,
      observed.observability?.metadata?.name,
    ].filter(Boolean),
    descriptors: [observed.descriptor?.metadata?.name].filter(Boolean),
    observability: {
      deployment: observed.observabilityDeployment?.metadata?.name || null,
      image: observed.observabilityDeployment?.spec?.template?.spec?.containers?.[0]?.image || null,
      readyReplicas: observed.observabilityDeployment?.status?.readyReplicas || 0,
    },
    canary: {
      claim: `${observed.canaryClaim?.metadata?.namespace}/${observed.canaryClaim?.metadata?.name}`,
      claimPhase: observed.canaryClaim?.status?.phase || null,
      binding: `${observed.canaryBinding?.metadata?.namespace}/${observed.canaryBinding?.metadata?.name}`,
      bindingPhase: observed.canaryBinding?.status?.phase || null,
      protected: hasConsumerProtectFinalizer(observed.canaryBinding),
    },
    nextGate: 'PFS establishment evidence is complete; Console may project Established',
  };
}

async function sendReceipt(work, succeeded, result, evidence = {}) {
  return jsonRequest(`${BACKEND_URL}/api/platform/reconcile/receipt`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-opensphere-reconciler-token': RECONCILER_TOKEN,
    },
    body: JSON.stringify({
      requestId: work.request_id,
      operationId: `${work.request_id}:${work.git_commit_sha}:${work.attempt}`.slice(0, 255),
      reconciler: FOUNDATION_BOOTSTRAP_RECONCILER,
      desiredRevision: work.desired_revision || null,
      appliedRevision: succeeded ? work.git_commit_sha : null,
      observedGeneration: Number.isSafeInteger(Number(evidence?.controlPlane?.observedGeneration))
        ? Number(evidence.controlPlane.observedGeneration) : null,
      succeeded,
      result: String(result).slice(0, 2000),
      evidence,
    }),
  });
}

async function reconcile(work) {
  activeRequestId = work.request_id;
  try {
    await loadManifest(work);
    const evidence = await applyFoundationBootstrap();
    await sendReceipt(
      work,
      true,
      'Foundation contracts, dedicated owner RBAC, Control Plane, required observability and protected Connected Binding canary are Ready',
      evidence,
    );
    lastSuccessAt = new Date().toISOString();
    lastError = null;
  } catch (error) {
    lastError = String(error?.message || error).slice(0, 500);
    try {
      await sendReceipt(work, false, lastError, {
        errorCode: 'foundation-bootstrap-reconcile-failed',
        catalogVersion: FOUNDATION_BOOTSTRAP_CATALOG_VERSION,
        catalogSha256: FOUNDATION_BOOTSTRAP_CATALOG_SHA256,
      });
    } catch (receiptError) {
      console.error('[foundation-bootstrap-reconciler] failure receipt rejected:', receiptError.message || receiptError);
    }
    console.error('[foundation-bootstrap-reconciler] request failed:', work.request_id, lastError);
  } finally {
    activeRequestId = null;
  }
}

async function pollLoop() {
  while (!stopping) {
    try {
      const readiness = reconcilerReadiness();
      if (!readiness.ready) {
        lastError = readiness.reason;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const work = await claimWork();
      if (work) await reconcile(work);
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 500);
      console.error('[foundation-bootstrap-reconciler] poll failed:', lastError);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function reconcilerReadiness() {
  try {
    const catalog = loadFoundationBootstrapCatalog();
    catalog.forEach(validateCatalogDocument);
    const supplyChain = catalogSupplyChainStatus(catalog);
    if (!supplyChain.ready) {
      return {
        ready: false,
        reason: 'foundation_supply_chain_blocked',
        supplyChain,
      };
    }
    const credentialsReady = Boolean(GITEA_TOKEN && RECONCILER_TOKEN && fs.existsSync(`${SA_PATH}/token`));
    return {
      ready: credentialsReady,
      reason: credentialsReady ? '' : 'foundation_reconciler_credentials_unavailable',
      supplyChain,
    };
  } catch (error) {
    return {
      ready: false,
      reason: String(error?.message || error).slice(0, 500),
      supplyChain: { ready: false, checkedImages: 0, blockers: [] },
    };
  }
}

function reconcilerReady() {
  return reconcilerReadiness().ready;
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const readiness = reconcilerReadiness();
  const ready = readiness.ready;
  const body = {
    service: FOUNDATION_BOOTSTRAP_RECONCILER,
    ready,
    catalogVersion: FOUNDATION_BOOTSTRAP_CATALOG_VERSION,
    catalogSha256: FOUNDATION_BOOTSTRAP_CATALOG_SHA256,
    lastClaimAt,
    lastSuccessAt,
    activeRequestId,
    supplyChain: readiness.supplyChain,
    blocker: ready ? null : readiness.reason,
    lastError: lastError || null,
  };
  res.setHeader('content-type', 'application/json');
  if (path === '/healthz') { res.writeHead(200); return res.end(JSON.stringify({ ok: true })); }
  if (path === '/readyz') { res.writeHead(ready ? 200 : 503); return res.end(JSON.stringify(body)); }
  res.writeHead(404);
  return res.end(JSON.stringify({ error: 'not found' }));
});

if (require.main === module) {
  process.on('SIGTERM', () => { stopping = true; server.close(); });
  server.listen(PORT, () => {
    console.log(`[foundation-bootstrap-reconciler] listening :${PORT}`);
    void pollLoop();
  });
}

module.exports = {
  FOUNDATION_CRDS,
  supportProfileReady,
  crdEstablished,
  deploymentReady,
  foundationModelInstalled,
  bootstrapCanaryReady,
  validateCatalogDocument,
  catalogSupplyChainStatus,
  assertCatalogSupplyChain,
  validateGovernedManifest,
  applyCatalogResource,
  applyFoundationBootstrap,
  reconcilerReadiness,
};
