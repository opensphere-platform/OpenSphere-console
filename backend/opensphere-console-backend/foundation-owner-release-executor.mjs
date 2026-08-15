import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  FOUNDATION_OWNER_RELEASE_CONSUMER,
  FOUNDATION_OWNER_RELEASE_RECONCILER,
  FOUNDATION_OWNER_RELEASE_TARGET,
  MANIFEST_URL,
  REGISTRATION_PATH,
  deploymentProjection,
  executeFoundationOwnerRelease,
  mainRegistrationReady,
  validateFoundationOwnerDesiredState,
  verifyFoundationPublication,
} = require('./foundation-owner-release');
const { requestJson: internalAuthorityRequest } =
  require('./platform-release-internal-transport');

const APISERVER = process.env.APISERVER || 'https://kubernetes.default.svc';
const GITEA_ORGANIZATION = process.env.GITEA_ORGANIZATION || 'opensphere';
const GITEA_REPOSITORY = process.env.GITEA_REPOSITORY || 'platform-declarations';
const GITEA_PATH = String(process.env.GITEA_PATH || 'foundation-owner-release').replace(/^\/+|\/+$/g, '');
const REQUEST_ID = process.env.REQUEST_ID || '';
const GIT_COMMIT_SHA = process.env.GIT_COMMIT_SHA || '';
const ATTEMPT = Number(process.env.ATTEMPT || 0);
const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const IDENTITY_TOKEN_PATH = process.env.IDENTITY_TOKEN_PATH
  || '/var/run/secrets/opensphere-foundation-owner-identity/token';
const LOCK_PATH = '/api/v1/namespaces/opensphere-console/configmaps/foundation-owner-installation-lock';
const DEPLOYMENT_PATH = '/apis/apps/v1/namespaces/opensphere-console/deployments/foundation-oaa-owner';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_RE = /^[0-9a-f]{40,64}$/i;

const serviceAccountToken = () => fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
const identityToken = () => fs.readFileSync(IDENTITY_TOKEN_PATH, 'utf8').trim();

async function jsonRequest(url, options = {}) {
  const { timeoutMs = 15000, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { ok: response.ok, status: response.status, body };
}

async function kubernetesRequest(method, path, body, contentType = 'application/json') {
  return jsonRequest(`${APISERVER}${path}`, { method, headers: {
    authorization: `Bearer ${serviceAccountToken()}`, accept: 'application/json',
    ...(body === undefined ? {} : { 'content-type': contentType }),
  }, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 30000 });
}

async function checkedKubernetes(method, path, body, contentType) {
  const response = await kubernetesRequest(method, path, body, contentType);
  if (!response.ok) { const error = new Error(response.body?.message || `Kubernetes HTTP ${response.status}`); error.status = response.status; throw error; }
  return response.body;
}

function exactLockState(value) {
  if (!value || value.contract !== 'opensphere.foundation.owner.installation-lock/v1'
    || !Number.isInteger(value.revision) || value.revision < 0
    || !['Uninitialized', 'Applying', 'Completed', 'Failed'].includes(value.phase)) {
    throw new Error('Foundation owner installation lock is invalid');
  }
  return value;
}

async function readLock() {
  const cm = await checkedKubernetes('GET', LOCK_PATH);
  let state;
  try { state = exactLockState(JSON.parse(String(cm?.data?.['release.json'] || ''))); }
  catch (error) { throw new Error(`Foundation owner installation lock parse failed: ${error.message}`); }
  return { cm, state };
}

async function writeLock(cm, state) {
  const next = structuredClone(cm);
  next.data = { ...(next.data || {}), 'release.json': JSON.stringify(state) };
  return checkedKubernetes('PUT', LOCK_PATH, next);
}

function sameRelease(left, right) {
  return left?.image === right?.image && left?.sourceRevision === right?.sourceRevision;
}

async function acquireLock(desiredState, target, publicationSha256, io = {}) {
  const read = io.readLock || readLock;
  const get = io.checkedKubernetes || checkedKubernetes;
  const write = io.writeLock || writeLock;
  const { cm, state } = await read();
  const deployment = await get('GET', DEPLOYMENT_PATH);
  const current = deploymentProjection(deployment);
  if (!sameRelease(current, desiredState.expectedCurrent)
    && !(sameRelease(current, target)
      && state.operationId === desiredState.operationId)) {
    throw new Error('Foundation owner installation lock current workload precondition failed');
  }
  if (state.phase === 'Completed' && state.operationId === desiredState.operationId
    && sameRelease(state.current, target)) {
    if (state.publicationSha256 !== publicationSha256) {
      throw new Error('Foundation owner completed operation publication mismatch');
    }
    return { completed: true, cm, state };
  }
  if (state.operationId === desiredState.operationId && state.action === 'Rollback'
    && desiredState.action === 'Apply') {
    throw new Error('Foundation owner operation was durably rolled back and cannot be reapplied');
  }
  if (state.phase === 'Applying') {
    const leaseExpiresAt = Date.parse(String(state.leaseExpiresAt || ''));
    if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > Date.now()) {
      throw new Error('Foundation owner installation lock has an active exclusive executor attempt');
    }
  }
  if (state.phase !== 'Uninitialized' && state.phase !== 'Applying'
    && !sameRelease(state.current, desiredState.expectedCurrent)) {
    throw new Error('Foundation owner installation lock does not match the expected base release');
  }
  const nextState = {
    contract: 'opensphere.foundation.owner.installation-lock/v1', revision: state.revision + 1,
    phase: 'Applying', action: desiredState.action, operationId: desiredState.operationId, requestId: REQUEST_ID,
    attempt: ATTEMPT, leaseExpiresAt: new Date(Date.now() + 16 * 60 * 1000).toISOString(),
    mergeRevision: GIT_COMMIT_SHA, previous: desiredState.expectedCurrent, target,
    current: desiredState.expectedCurrent, publicationSha256, updatedAt: new Date().toISOString(),
  };
  const updated = await write(cm, nextState);
  return { completed: false, cm: updated, state: nextState };
}

async function completeLock(acquired, desiredState, target, result, io = {}) {
  const read = io.readLock || readLock;
  const write = io.writeLock || writeLock;
  const latest = await read();
  if (latest.state.phase !== 'Applying' || latest.state.operationId !== desiredState.operationId
    || latest.state.requestId !== REQUEST_ID || latest.state.mergeRevision !== GIT_COMMIT_SHA
    || latest.state.attempt !== ATTEMPT) {
    throw new Error('Foundation owner installation lock fencing was lost before completion');
  }
  const completed = { ...latest.state, revision: latest.state.revision + 1, phase: 'Completed',
    current: target, result: result.state,
    publicationSha256: result.publicationSha256, observedGeneration: result.observedGeneration,
    completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await write(latest.cm, completed);
  return completed;
}

async function failLock(desiredState, error, io = {}) {
  const read = io.readLock || readLock;
  const get = io.checkedKubernetes || checkedKubernetes;
  const write = io.writeLock || writeLock;
  const latest = await read();
  if (latest.state.phase !== 'Applying' || latest.state.operationId !== desiredState.operationId
    || latest.state.requestId !== REQUEST_ID || latest.state.mergeRevision !== GIT_COMMIT_SHA
    || latest.state.attempt !== ATTEMPT) return;
  const deployment = await get('GET', DEPLOYMENT_PATH);
  const current = deploymentProjection(deployment);
  const failed = { ...latest.state, revision: latest.state.revision + 1, phase: 'Failed',
    current: { image: current.image, sourceRevision: current.sourceRevision, releaseTag: current.releaseTag },
    rollbackComplete: sameRelease(current, desiredState.expectedCurrent),
    errorCode: 'foundation-owner-release-execution-failed', error: String(error?.message || error).slice(0, 500),
    failedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await write(latest.cm, failed);
}

async function loadGovernedManifest() {
  if (!UUID_RE.test(REQUEST_ID) || !COMMIT_RE.test(GIT_COMMIT_SHA) || !Number.isInteger(ATTEMPT) || ATTEMPT < 1
    || !fs.existsSync(SA_TOKEN_PATH) || !fs.existsSync(IDENTITY_TOKEN_PATH)) {
    throw new Error('Foundation owner executor environment is invalid');
  }
  const path = `${GITEA_PATH}/requests/${REQUEST_ID}.json`;
  const response = await internalAuthorityRequest('/api/platform/reconcile/manifest', {
    method: 'POST', authorization: `Bearer ${identityToken()}`,
    body: { reconciler: FOUNDATION_OWNER_RELEASE_RECONCILER, requestId: REQUEST_ID },
  });
  if (response.contract !== 'opensphere-platform-release-manifest-projection/v1'
    || response.requestId !== REQUEST_ID || response.gitCommitSha !== GIT_COMMIT_SHA
    || response.gitRepo !== `${GITEA_ORGANIZATION}/${GITEA_REPOSITORY}` || response.path !== path
    || !/^sha256:[a-f0-9]{64}$/.test(String(response.contentSha256 || ''))) {
    throw new Error('internal Foundation manifest projection differs from the executor binding');
  }
  const raw = Buffer.from(String(response.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
  if (`sha256:${createHash('sha256').update(raw).digest('hex')}` !== response.contentSha256) {
    throw new Error('internal Foundation manifest projection hash mismatch');
  }
  const manifest = JSON.parse(raw);
  if (manifest?.apiVersion !== 'platform.opensphere.io/v1alpha1' || manifest?.kind !== 'GovernedChange'
    || manifest?.metadata?.requestId !== REQUEST_ID || manifest?.metadata?.consumerId !== FOUNDATION_OWNER_RELEASE_CONSUMER
    || !['apply', 'rollback'].includes(manifest?.spec?.action) || manifest?.spec?.target !== FOUNDATION_OWNER_RELEASE_TARGET
    || manifest.spec.action !== String(manifest?.spec?.desiredState?.action || '').toLowerCase()) {
    throw new Error('Foundation owner executor governed manifest identity mismatch');
  }
  return validateFoundationOwnerDesiredState(manifest.spec.desiredState);
}

async function trustedPublicKey() {
  const cm = await checkedKubernetes('GET', '/api/v1/namespaces/opensphere-console/configmaps/dupa-trusted-keys');
  const document = JSON.parse(String(cm?.data?.['trusted-keys.json'] || ''));
  const value = document?.trustedKeys?.['opensphere-edge-local-v1'];
  if (typeof value !== 'string' || !value) throw new Error('Foundation owner executor trust key is unavailable');
  return value;
}

async function sendReceipt({ succeeded, result, desiredRevision, evidence }) {
  await internalAuthorityRequest('/api/platform/reconcile/receipt', { method: 'POST',
    authorization: `Bearer ${identityToken()}`,
    body: { requestId: REQUEST_ID, operationId: `${REQUEST_ID}:${GIT_COMMIT_SHA}:${ATTEMPT}`,
      reconciler: FOUNDATION_OWNER_RELEASE_RECONCILER, desiredRevision, appliedRevision: succeeded ? GIT_COMMIT_SHA : null,
      succeeded, result: String(result).slice(0, 1800), evidence } });
}

async function main() {
  const desiredState = await loadGovernedManifest();
  // Validate signature, canonical publication and the exact DUPA main release
  // before writing Applying. Invalid or stale input cannot poison the durable
  // owner installation lock.
  const trustedPublicKeySpkiBase64 = await trustedPublicKey();
  const verified = verifyFoundationPublication({
    publicationDocumentBase64: desiredState.publicationDocumentBase64,
    publicationSignature: desiredState.publicationSignature,
    trustedPublicKeySpkiBase64,
  });
  const signedBase = desiredState.action === 'Rollback'
    ? verified.publication.module : verified.publication.previousOwner;
  if (desiredState.expectedCurrent.image !== signedBase.image
    || desiredState.expectedCurrent.sourceRevision !== signedBase.sourceRevision) {
    throw new Error('Foundation owner desired base is not the signed publication previous owner release');
  }
  const mainTarget = { image: verified.publication.module.image, digest: verified.publication.module.digest,
    sourceRevision: verified.publication.module.sourceRevision, releaseTag: verified.publication.module.releaseTag };
  const selected = desiredState.action === 'Rollback'
    ? verified.publication.previousOwner : verified.publication.module;
  const target = { image: selected.image, digest: selected.digest,
    sourceRevision: selected.sourceRevision, releaseTag: selected.releaseTag };
  const mainRegistration = await checkedKubernetes('GET', REGISTRATION_PATH);
  if (!mainRegistrationReady(mainRegistration, mainTarget)) throw new Error('FoundationMainReleaseNotReady');
  const acquired = await acquireLock(desiredState, target, verified.documentSha256);
  try {
    let result;
    if (acquired.completed) {
      result = { state: 'AlreadyCompleted', publicationSha256: acquired.state.publicationSha256,
        observedGeneration: acquired.state.observedGeneration };
    } else {
      result = await executeFoundationOwnerRelease({ body: {
        action: desiredState.action, operationId: desiredState.operationId, reason: desiredState.reason,
        expectedCurrent: desiredState.expectedCurrent,
        publicationDocumentBase64: desiredState.publicationDocumentBase64,
        publicationSignature: desiredState.publicationSignature,
      }, trustedPublicKeySpkiBase64, kubernetesRequest,
      fetchManifest: async (url) => {
        if (url !== MANIFEST_URL) throw new Error('Foundation owner manifest URL is not canonical');
        const response = await jsonRequest(url, { headers: { accept: 'application/json' }, timeoutMs: 5000 });
        if (!response.ok) throw new Error(`Foundation owner manifest HTTP ${response.status}`);
        return response.body;
      } });
      await completeLock(acquired, desiredState, target, result);
    }
    await sendReceipt({ succeeded: true, result: result.state, desiredRevision: GIT_COMMIT_SHA,
      evidence: { stage: 'completed', installationLock: 'foundation-owner-installation-lock',
        operationId: desiredState.operationId, publicationSha256: result.publicationSha256,
        observedGeneration: result.observedGeneration } });
  } catch (error) {
    await failLock(desiredState, error).catch(() => undefined);
    await sendReceipt({ succeeded: false, result: error.message, desiredRevision: GIT_COMMIT_SHA,
      evidence: { stage: 'execution', errorCode: 'foundation-owner-release-execution-failed' } }).catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`))) {
  main().catch((error) => { console.error(`[foundation-owner-release-executor] ${error.message}`); process.exitCode = 1; });
}

export { acquireLock, completeLock, exactLockState, failLock, sameRelease };
