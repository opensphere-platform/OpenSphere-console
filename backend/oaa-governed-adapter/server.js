const http = require('http');
const fs = require('fs');
const { createHash } = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const BACKEND_URL = (process.env.CONSOLE_BACKEND_URL || 'http://opensphere-console-backend.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const GITEA_URL = (process.env.GITEA_URL || 'http://opensphere-gitea.opensphere-console-change.svc.cluster.local:3000').replace(/\/$/, '');
const GITEA_ORGANIZATION = process.env.GITEA_ORGANIZATION || 'opensphere';
const GITEA_REPOSITORY = process.env.GITEA_REPOSITORY || 'platform-declarations';
const GITEA_PATH = String(process.env.GITEA_PATH || 'oaa').replace(/^\/+|\/+$/g, '');
const GITEA_TOKEN = process.env.GITEA_TOKEN || '';
const RECONCILER_TOKEN = process.env.RECONCILER_TOKEN || '';
const RECONCILER_NAME = process.env.RECONCILER_NAME || 'oaa-governed-adapter';
const POLL_INTERVAL_MS = Math.max(2000, Math.min(60000, Number(process.env.POLL_INTERVAL_MS || 5000) || 5000));
const ROLLOUT_TIMEOUT_MS = Math.max(30000, Math.min(600000, Number(process.env.ROLLOUT_TIMEOUT_MS || 180000) || 180000));
const MAX_REPLICAS = Math.max(1, Math.min(100, Number(process.env.OAA_SCALE_MAX || 10) || 10));
const ALLOWED_NAMESPACES = new Set((process.env.ALLOWED_NAMESPACES || 'opensphere-console,opensphere-console-data,opensphere-console-change')
  .split(',').map((value) => value.trim()).filter(Boolean));
const APISERVER = process.env.APISERVER || 'https://kubernetes.default.svc';
const SA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount';
const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*@sha256:[0-9a-f]{64}$/;

const RESOURCE_CONTRACT = Object.freeze({
  configmap: resource('', 'v1', 'configmaps', 'ConfigMap'),
  service: resource('', 'v1', 'services', 'Service'),
  persistentvolumeclaim: resource('', 'v1', 'persistentvolumeclaims', 'PersistentVolumeClaim'),
  deployment: resource('apps', 'v1', 'deployments', 'Deployment', true, true),
  statefulset: resource('apps', 'v1', 'statefulsets', 'StatefulSet', true, true),
  daemonset: resource('apps', 'v1', 'daemonsets', 'DaemonSet', true, false),
  job: resource('batch', 'v1', 'jobs', 'Job'),
  cronjob: resource('batch', 'v1', 'cronjobs', 'CronJob'),
  ingress: resource('networking.k8s.io', 'v1', 'ingresses', 'Ingress'),
  networkpolicy: resource('networking.k8s.io', 'v1', 'networkpolicies', 'NetworkPolicy'),
  horizontalpodautoscaler: resource('autoscaling', 'v2', 'horizontalpodautoscalers', 'HorizontalPodAutoscaler'),
  poddisruptionbudget: resource('policy', 'v1', 'poddisruptionbudgets', 'PodDisruptionBudget'),
});
const WORKLOAD_KINDS = new Set(['deployment', 'statefulset', 'daemonset']);
const SCALABLE_KINDS = new Set(['deployment', 'statefulset']);
const APPLY_KINDS = new Set(Object.keys(RESOURCE_CONTRACT));
const DELETE_KINDS = new Set([...APPLY_KINDS].filter((kind) => kind !== 'persistentvolumeclaim'));

let startedAt = new Date().toISOString();
let lastClaimAt = null;
let lastSuccessAt = null;
let lastError = null;
let activeRequestId = null;
let stopping = false;

function resource(group, version, plural, kind, workload = false, scalable = false) { return Object.freeze({ group, version, plural, kind, workload, scalable }); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function serviceAccountToken() { return fs.readFileSync(`${SA_PATH}/token`, 'utf8').trim(); }
function encodedPath(value) { return String(value).split('/').map(encodeURIComponent).join('/'); }

function normalizedKind(value, allowed = APPLY_KINDS) {
  const key = String(value || '').trim().toLowerCase().replace(/[._-]/g, '');
  if (!allowed.has(key) || !RESOURCE_CONTRACT[key]) throw new Error('resource kind is outside the governed adapter allowlist');
  return key;
}

function targetName(value, label = 'resource name') {
  const name = String(value || '').trim();
  if (!NAME_RE.test(name)) throw new Error(`${label} is invalid`);
  return name;
}

function resourceTarget(desiredState, allowed = APPLY_KINDS) {
  const inputs = desiredState?.inputs && typeof desiredState.inputs === 'object' && !Array.isArray(desiredState.inputs) ? desiredState.inputs : {};
  const namespace = String(inputs.namespace || '').trim();
  const name = targetName(inputs.name || inputs.deployment);
  const kind = normalizedKind(inputs.kind || (desiredState.toolId?.startsWith('oaa.k8s.deployment.') ? 'deployment' : ''), allowed);
  if (!ALLOWED_NAMESPACES.has(namespace)) throw new Error('target namespace is not allowlisted');
  return { inputs, namespace, name, kind, contract: RESOURCE_CONTRACT[kind] };
}

function deploymentTarget(desiredState) {
  const inputs = desiredState?.inputs && typeof desiredState.inputs === 'object' ? desiredState.inputs : {};
  const target = resourceTarget({ ...desiredState, inputs: { ...inputs, kind: 'deployment' } }, new Set(['deployment']));
  return { inputs, namespace: target.namespace, name: target.name };
}

function resourcePath(kind, namespace, name = '', query = {}) {
  const contract = RESOURCE_CONTRACT[normalizedKind(kind)];
  let value = contract.group ? `/apis/${contract.group}/${contract.version}` : `/api/${contract.version}`;
  value += `/namespaces/${encodeURIComponent(namespace)}/${contract.plural}`;
  if (name) value += `/${encodeURIComponent(name)}`;
  const params = new URLSearchParams();
  for (const [key, item] of Object.entries(query)) if (item !== undefined && item !== null && item !== '') params.set(key, String(item));
  return `${value}${params.size ? `?${params.toString()}` : ''}`;
}

async function jsonRequest(url, options = {}) {
  const { timeoutMs = 10000, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    const error = new Error(body?.error || body?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function kubernetesRaw(method, path, body, contentType = 'application/json') {
  const headers = { authorization: `Bearer ${serviceAccountToken()}`, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = contentType;
  const response = await fetch(`${APISERVER}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text }; }
  return { ok: response.ok, status: response.status, value };
}

async function kubernetes(method, path, body, contentType) {
  const result = await kubernetesRaw(method, path, body, contentType);
  if (!result.ok) {
    const error = new Error(result.value?.message || `Kubernetes HTTP ${result.status}`);
    error.status = result.status;
    throw error;
  }
  return result.value;
}

async function getResource(kind, namespace, name, optional = false) {
  const result = await kubernetesRaw('GET', resourcePath(kind, namespace, name));
  if (optional && result.status === 404) return null;
  if (!result.ok) throw new Error(result.value?.message || `${kind} read HTTP ${result.status}`);
  return result.value;
}

function workloadRolloutComplete(value, kind = 'deployment') {
  const status = value?.status || {};
  const generationObserved = Number(status.observedGeneration || 0) >= Number(value?.metadata?.generation || 0);
  if (kind === 'daemonset') {
    const desired = Number(status.desiredNumberScheduled || 0);
    return generationObserved && Number(status.updatedNumberScheduled || 0) >= desired
      && Number(status.numberAvailable || 0) >= desired && Number(status.numberReady || 0) >= desired;
  }
  const desired = Number(value?.spec?.replicas || 0);
  return generationObserved && Number(status.updatedReplicas || 0) >= desired
    && Number(status.availableReplicas || 0) >= desired && Number(status.readyReplicas || 0) >= desired;
}

function rolloutComplete(value) { return workloadRolloutComplete(value, 'deployment'); }

async function waitForRollout(kind, namespace, name) {
  const deadline = Date.now() + ROLLOUT_TIMEOUT_MS;
  let observed;
  while (Date.now() < deadline) {
    observed = await getResource(kind, namespace, name);
    if (workloadRolloutComplete(observed, kind)) return observed;
    await sleep(2000);
  }
  const error = new Error(`${kind} rollout observation timed out`);
  error.observed = observed;
  throw error;
}

async function waitForDeletion(kind, namespace, name) {
  const deadline = Date.now() + ROLLOUT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await getResource(kind, namespace, name, true))) return true;
    await sleep(1000);
  }
  throw new Error(`${kind} deletion observation timed out`);
}

async function claimWork() {
  const body = await jsonRequest(`${BACKEND_URL}/api/platform/reconcile/next`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-opensphere-reconciler-token': RECONCILER_TOKEN }, body: JSON.stringify({ limit: 1 }),
  });
  lastClaimAt = new Date().toISOString();
  lastError = null;
  return Array.isArray(body.items) ? body.items[0] || null : null;
}

async function loadManifest(work) {
  if (!UUID_RE.test(String(work.request_id || ''))) throw new Error('claimed request id is invalid');
  if (!/^[0-9a-f]{40,64}$/i.test(String(work.git_commit_sha || ''))) throw new Error('claimed merge revision is invalid');
  if (work.git_repo !== `${GITEA_ORGANIZATION}/${GITEA_REPOSITORY}`) throw new Error('claimed repository is outside the adapter contract');
  const path = `${GITEA_PATH}/requests/${work.request_id}.json`;
  const url = `${GITEA_URL}/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/contents/${encodedPath(path)}?ref=${encodeURIComponent(work.git_commit_sha)}`;
  const file = await jsonRequest(url, { headers: { authorization: `token ${GITEA_TOKEN}`, accept: 'application/json' } });
  const raw = Buffer.from(String(file.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
  const manifest = JSON.parse(raw);
  if (manifest?.apiVersion !== 'platform.opensphere.io/v1alpha1' || manifest?.kind !== 'GovernedChange') throw new Error('unsupported governed manifest');
  if (manifest?.metadata?.requestId !== work.request_id || manifest?.metadata?.consumerId !== 'oaa-gateway') throw new Error('governed manifest identity mismatch');
  const desiredState = manifest?.spec?.desiredState;
  if (!desiredState || typeof desiredState !== 'object' || Array.isArray(desiredState)) throw new Error('desiredState must be an object');
  const digest = `sha256:${sha256(canonicalJson(desiredState))}`;
  if (manifest?.metadata?.payloadDigest !== digest) throw new Error('governed manifest payload digest mismatch');
  if (manifest?.spec?.target !== work.target || manifest?.spec?.reason !== work.reason) throw new Error('governed manifest claim mismatch');
  if (desiredState.requiredPermission !== 'oaa.action.execute.high') throw new Error('desiredState permission contract mismatch');
  if (!['apply', 'delete', 'configure', 'rollback'].includes(manifest.spec.action)) throw new Error('unsupported governed action');
  return manifest;
}

function exactConfirmation(inputs, expected) {
  if (String(inputs.confirm || '').trim() !== expected) throw new Error('confirmation contract mismatch');
}

function podSpecForManifest(kind, manifest) {
  if (['deployment', 'statefulset', 'daemonset', 'job'].includes(kind)) return manifest.spec?.template?.spec;
  if (kind === 'cronjob') return manifest.spec?.jobTemplate?.spec?.template?.spec;
  return null;
}

function validateManifest(kind, namespace, name, manifest) {
  const contract = RESOURCE_CONTRACT[kind];
  const apiVersion = contract.group ? `${contract.group}/${contract.version}` : contract.version;
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') throw new Error('resource manifest must be an object');
  if (manifest.kind !== contract.kind || manifest.apiVersion !== apiVersion) throw new Error('resource manifest apiVersion/kind mismatch');
  if (manifest.metadata?.namespace !== namespace || manifest.metadata?.name !== name) throw new Error('resource manifest target mismatch');
  if (manifest.status !== undefined) throw new Error('observed status may not be applied');
  if (Object.keys(manifest.metadata || {}).some((key) => !['name', 'namespace', 'labels', 'annotations'].includes(key))) throw new Error('resource manifest metadata contains forbidden fields');
  const encoded = canonicalJson(manifest);
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw new Error('resource manifest exceeds 64 KiB');
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const secretReferenceKey = /(?:secret(?:key)?ref|secretrefs|secretname|secretnames|imagepullsecrets)$/i.test(key);
      if (/(password|token|credential|private.?key|secret)/i.test(key) && !secretReferenceKey) throw new Error('resource manifest contains forbidden secret material');
      visit(child);
    }
  };
  visit(manifest);
  const podSpec = podSpecForManifest(kind, manifest);
  for (const container of [...(podSpec?.initContainers || []), ...(podSpec?.containers || [])]) {
    if (!NAME_RE.test(String(container.name || '')) || !DIGEST_IMAGE_RE.test(String(container.image || ''))) throw new Error('workload manifest images must be digest pinned');
  }
  return JSON.parse(JSON.stringify(manifest));
}

function workloadEvidence(toolId, kind, namespace, name, before, changed, observed) {
  return {
    toolId, kind: RESOURCE_CONTRACT[kind].kind, namespace, name,
    previousGeneration: before?.metadata?.generation || null,
    generation: changed?.metadata?.generation || observed?.metadata?.generation || null,
    resourceVersion: observed?.metadata?.resourceVersion || changed?.metadata?.resourceVersion || null,
    observedGeneration: observed?.status?.observedGeneration || null,
    readyReplicas: observed?.status?.readyReplicas ?? observed?.status?.numberReady ?? null,
    availableReplicas: observed?.status?.availableReplicas ?? observed?.status?.numberAvailable ?? null,
  };
}

async function patchWorkload(manifest, mode) {
  const desiredState = manifest.spec.desiredState;
  const allowed = mode === 'scale' ? SCALABLE_KINDS : WORKLOAD_KINDS;
  const { inputs, namespace, name, kind } = resourceTarget(desiredState, allowed);
  const before = await getResource(kind, namespace, name);
  let patch;
  let contentType = 'application/merge-patch+json';
  if (mode === 'restart') {
    exactConfirmation(inputs, `restart ${kind} ${namespace}/${name}`);
    const now = new Date().toISOString();
    patch = { spec: { template: { metadata: { annotations: {
      'kubectl.kubernetes.io/restartedAt': now, 'opensphere.io/oaa-restarted-at': now, 'opensphere.io/oaa-request-id': manifest.metadata.requestId,
    } } } } };
  } else if (mode === 'scale') {
    const replicas = Number(inputs.replicas);
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > MAX_REPLICAS) throw new Error(`replicas must be between 0 and ${MAX_REPLICAS}`);
    exactConfirmation(inputs, `scale ${kind} ${namespace}/${name} to ${replicas}`);
    patch = { spec: { replicas } };
  } else {
    const container = targetName(inputs.container, 'container name');
    const image = String(inputs.image || '').trim();
    if (!DIGEST_IMAGE_RE.test(image)) throw new Error('image is not digest pinned');
    exactConfirmation(inputs, `${mode} image ${kind} ${namespace}/${name} container ${container} to ${image}`);
    const containers = before.spec?.template?.spec?.containers || [];
    if (!containers.some((item) => item.name === container)) throw new Error('target container does not exist in workload');
    patch = { spec: { template: { metadata: { annotations: { 'opensphere.io/oaa-request-id': manifest.metadata.requestId } }, spec: { containers: [{ name: container, image }] } } } };
    contentType = 'application/strategic-merge-patch+json';
  }
  const changed = await kubernetes('PATCH', resourcePath(kind, namespace, name), patch, contentType);
  const observed = await waitForRollout(kind, namespace, name);
  if (mode === 'update' || mode === 'rollback') {
    const actual = (observed.spec?.template?.spec?.containers || []).find((item) => item.name === inputs.container)?.image;
    if (actual !== inputs.image) throw new Error('observed workload image does not match approved digest');
  }
  return workloadEvidence(desiredState.toolId, kind, namespace, name, before, changed, observed);
}

async function applyResource(manifest) {
  const desiredState = manifest.spec.desiredState;
  const { inputs, namespace, name, kind } = resourceTarget(desiredState, APPLY_KINDS);
  exactConfirmation(inputs, `apply ${kind} ${namespace}/${name}`);
  const approved = validateManifest(kind, namespace, name, inputs.manifest);
  approved.metadata.annotations = { ...(approved.metadata.annotations || {}), 'opensphere.io/oaa-request-id': manifest.metadata.requestId, 'opensphere.io/managed-by': RECONCILER_NAME };
  const before = await getResource(kind, namespace, name, true);
  const changed = await kubernetes('PATCH', resourcePath(kind, namespace, name, { fieldManager: RECONCILER_NAME, force: 'false' }), approved, 'application/apply-patch+yaml');
  const observed = RESOURCE_CONTRACT[kind].workload ? await waitForRollout(kind, namespace, name) : await getResource(kind, namespace, name);
  return {
    toolId: desiredState.toolId, operation: before ? 'updated' : 'created', kind: RESOURCE_CONTRACT[kind].kind, namespace, name,
    previousResourceVersion: before?.metadata?.resourceVersion || null, resourceVersion: observed.metadata?.resourceVersion || changed.metadata?.resourceVersion || null,
    generation: observed.metadata?.generation || null, observedGeneration: observed.status?.observedGeneration || null,
  };
}

async function deleteResource(manifest) {
  const desiredState = manifest.spec.desiredState;
  const { inputs, namespace, name, kind } = resourceTarget(desiredState, DELETE_KINDS);
  exactConfirmation(inputs, `delete ${kind} ${namespace}/${name}`);
  for (const [field, minimum] of [['impact', 8], ['recoveryPlan', 8], ['backupReference', 3]]) {
    if (String(inputs[field] || '').trim().length < minimum) throw new Error(`${field} evidence is required`);
  }
  const before = await getResource(kind, namespace, name);
  await kubernetes('DELETE', resourcePath(kind, namespace, name), {
    apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground',
    preconditions: { uid: before.metadata?.uid, resourceVersion: before.metadata?.resourceVersion },
  });
  await waitForDeletion(kind, namespace, name);
  return {
    toolId: desiredState.toolId, operation: 'deleted', kind: RESOURCE_CONTRACT[kind].kind, namespace, name,
    previousResourceVersion: before.metadata?.resourceVersion || null, deleted: true,
    impactDigest: `sha256:${sha256(inputs.impact)}`, recoveryPlanDigest: `sha256:${sha256(inputs.recoveryPlan)}`, backupReference: String(inputs.backupReference).slice(0, 300),
  };
}

async function runCronJob(manifest) {
  const desiredState = manifest.spec.desiredState;
  const { inputs, namespace, name } = resourceTarget({ ...desiredState, inputs: { ...(desiredState.inputs || {}), kind: 'cronjob' } }, new Set(['cronjob']));
  exactConfirmation(inputs, `run cronjob ${namespace}/${name}`);
  const cronjob = await getResource('cronjob', namespace, name);
  const jobName = `${name.slice(0, 43)}-oaa-${manifest.metadata.requestId.slice(0, 8)}`.replace(/-+$/g, '');
  const job = {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name: jobName, namespace, labels: { 'opensphere.io/oaa-source-cronjob': name }, annotations: { 'opensphere.io/oaa-request-id': manifest.metadata.requestId } },
    spec: cronjob.spec?.jobTemplate?.spec || {},
  };
  const existing = await getResource('job', namespace, jobName, true);
  const created = existing || await kubernetes('POST', resourcePath('job', namespace), job);
  return { toolId: desiredState.toolId, operation: existing ? 'already-created' : 'created', kind: 'Job', namespace, name: jobName, sourceCronJob: name, resourceVersion: created.metadata?.resourceVersion || null };
}

async function suspendCronJob(manifest) {
  const desiredState = manifest.spec.desiredState;
  const { inputs, namespace, name } = resourceTarget({ ...desiredState, inputs: { ...(desiredState.inputs || {}), kind: 'cronjob' } }, new Set(['cronjob']));
  if (typeof inputs.suspend !== 'boolean') throw new Error('suspend must be boolean');
  exactConfirmation(inputs, `set cronjob ${namespace}/${name} suspend ${inputs.suspend}`);
  const before = await getResource('cronjob', namespace, name);
  const changed = await kubernetes('PATCH', resourcePath('cronjob', namespace, name), { spec: { suspend: inputs.suspend } }, 'application/merge-patch+json');
  const observed = await getResource('cronjob', namespace, name);
  if (observed.spec?.suspend !== inputs.suspend) throw new Error('CronJob suspend state was not observed');
  return { toolId: desiredState.toolId, operation: 'configured', kind: 'CronJob', namespace, name, previousSuspend: Boolean(before.spec?.suspend), suspend: Boolean(changed.spec?.suspend), resourceVersion: observed.metadata?.resourceVersion || null };
}

async function applyManifest(manifest) {
  const desiredState = manifest.spec.desiredState;
  const toolId = desiredState.toolId;
  if (toolId === 'oaa.k8s.deployment.restart') {
    desiredState.inputs = { ...(desiredState.inputs || {}), kind: 'deployment' };
    exactConfirmation(desiredState.inputs, `restart deployment ${desiredState.inputs.namespace}/${desiredState.inputs.name || desiredState.inputs.deployment}`);
    desiredState.inputs.confirm = `restart deployment ${desiredState.inputs.namespace}/${desiredState.inputs.name || desiredState.inputs.deployment}`.replace('restart deployment', 'restart deployment');
    const evidence = await patchWorkload({ ...manifest, spec: { ...manifest.spec, desiredState: { ...desiredState, toolId, inputs: { ...desiredState.inputs, confirm: `restart deployment ${desiredState.inputs.namespace}/${desiredState.inputs.name || desiredState.inputs.deployment}` } } } }, 'restart');
    return evidence;
  }
  if (toolId === 'oaa.k8s.deployment.scale') {
    const original = desiredState.inputs || {};
    exactConfirmation(original, `scale deployment ${original.namespace}/${original.name || original.deployment} to ${Number(original.replicas)}`);
    return patchWorkload({ ...manifest, spec: { ...manifest.spec, desiredState: { ...desiredState, inputs: { ...original, kind: 'deployment', confirm: `scale deployment ${original.namespace}/${original.name || original.deployment} to ${Number(original.replicas)}` } } } }, 'scale');
  }
  if (toolId === 'oaa.k8s.workload.restart') return patchWorkload(manifest, 'restart');
  if (toolId === 'oaa.k8s.workload.scale') return patchWorkload(manifest, 'scale');
  if (toolId === 'oaa.k8s.workload.update-image') return patchWorkload(manifest, 'update');
  if (toolId === 'oaa.k8s.workload.rollback-image') {
    if (manifest.spec.action !== 'rollback' || manifest.spec.rollbackOf !== desiredState.inputs?.rollbackOf || manifest.metadata.rollbackOf !== desiredState.inputs?.rollbackOf) throw new Error('rollback correlation contract mismatch');
    return patchWorkload(manifest, 'rollback');
  }
  if (toolId === 'oaa.k8s.resource.apply') {
    if (manifest.spec.action !== 'apply') throw new Error('resource apply action mismatch');
    return applyResource(manifest);
  }
  if (toolId === 'oaa.k8s.resource.delete') {
    if (manifest.spec.action !== 'delete') throw new Error('resource delete action mismatch');
    return deleteResource(manifest);
  }
  if (toolId === 'oaa.k8s.cronjob.run') return runCronJob(manifest);
  if (toolId === 'oaa.k8s.cronjob.suspend') return suspendCronJob(manifest);
  throw new Error(`unsupported OAA governed tool: ${toolId}`);
}

async function sendReceipt(work, succeeded, result, evidence = {}) {
  const operationId = `${work.request_id}:${work.git_commit_sha}:${work.attempt}`.slice(0, 255);
  return jsonRequest(`${BACKEND_URL}/api/platform/reconcile/receipt`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-opensphere-reconciler-token': RECONCILER_TOKEN },
    body: JSON.stringify({
      requestId: work.request_id, operationId, reconciler: RECONCILER_NAME,
      desiredRevision: work.desired_revision || null, appliedRevision: succeeded ? work.git_commit_sha : null,
      observedGeneration: Number.isSafeInteger(Number(evidence.observedGeneration)) ? Number(evidence.observedGeneration) : null,
      succeeded, result: String(result).slice(0, 2000), evidence,
    }),
  });
}

async function reconcile(work) {
  activeRequestId = work.request_id;
  try {
    const manifest = await loadManifest(work);
    const evidence = await applyManifest(manifest);
    await sendReceipt(work, true, `${evidence.toolId} ${evidence.operation || 'applied'} ${evidence.kind || ''} ${evidence.namespace}/${evidence.name}`, evidence);
    lastSuccessAt = new Date().toISOString();
    lastError = null;
  } catch (error) {
    lastError = String(error?.message || error).slice(0, 500);
    try { await sendReceipt(work, false, lastError, { errorCode: 'reconcile-failed' }); }
    catch (receiptError) { console.error('[oaa-reconciler] failure receipt rejected:', receiptError.message || receiptError); }
    console.error('[oaa-reconciler] request failed:', work.request_id, lastError);
  } finally { activeRequestId = null; }
}

async function pollLoop() {
  while (!stopping) {
    try { const work = await claimWork(); if (work) await reconcile(work); }
    catch (error) { lastError = String(error?.message || error).slice(0, 500); console.error('[oaa-reconciler] poll failed:', lastError); }
    await sleep(POLL_INTERVAL_MS);
  }
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const body = {
    service: 'opensphere-oaa-governed-adapter', reconciler: RECONCILER_NAME,
    ready: Boolean(GITEA_TOKEN && RECONCILER_TOKEN), supportedTools: 10,
    startedAt, lastClaimAt, lastSuccessAt, activeRequestId, lastError: lastError ? 'reconciler_error' : null,
  };
  if (path === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
  if (path === '/readyz') { res.writeHead(body.ready ? 200 : 503, { 'content-type': 'application/json' }); return res.end(JSON.stringify(body)); }
  res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' }));
});

if (require.main === module) {
  process.on('SIGTERM', () => { stopping = true; server.close(); });
  server.listen(PORT, () => { console.log(`[oaa-reconciler] ${RECONCILER_NAME} listening :${PORT}`); void pollLoop(); });
}

module.exports = { canonicalJson, deploymentTarget, resourceTarget, resourcePath, rolloutComplete, workloadRolloutComplete, validateManifest, sha256 };
