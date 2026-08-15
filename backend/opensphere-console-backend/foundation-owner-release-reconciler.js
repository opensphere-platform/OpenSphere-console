'use strict';

const http = require('http');
const fs = require('fs');
const { createHash } = require('crypto');
const {
  FOUNDATION_OWNER_RELEASE_CONSUMER,
  FOUNDATION_OWNER_RELEASE_RECONCILER,
  FOUNDATION_OWNER_RELEASE_TARGET,
  validateFoundationOwnerDesiredState,
} = require('./foundation-owner-release');
const {
  INTERNAL_AUTHORITY_CA_FILE,
  requestJson: internalAuthorityRequest,
} = require('./platform-release-internal-transport');

const PORT = Number(process.env.PORT || 8080);
const GITEA_ORGANIZATION = process.env.GITEA_ORGANIZATION || 'opensphere';
const GITEA_REPOSITORY = process.env.GITEA_REPOSITORY || 'platform-declarations';
const GITEA_PATH = String(process.env.GITEA_PATH || 'foundation-owner-release').replace(/^\/+|\/+$/g, '');
const EXECUTOR_IMAGE = process.env.EXECUTOR_IMAGE || '';
const APISERVER = process.env.APISERVER || 'https://kubernetes.default.svc';
const SA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount';
const IDENTITY_TOKEN_PATH = process.env.IDENTITY_TOKEN_PATH
  || '/var/run/secrets/opensphere-foundation-owner-identity/token';
const POLL_INTERVAL_MS = Math.max(2000, Math.min(60000, Number(process.env.POLL_INTERVAL_MS || 5000)));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_RE = /^[0-9a-f]{40,64}$/i;
const EXECUTOR_IMAGE_RE = /^ghcr\.io\/opensphere-platform\/opensphere-console-backend@sha256:[a-f0-9]{64}$/;

let lastClaimAt = null;
let lastDispatchAt = null;
let lastError = null;
let activeRequestId = null;
let stopping = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const serviceAccountToken = () => fs.readFileSync(`${SA_PATH}/token`, 'utf8').trim();
const identityToken = () => fs.readFileSync(IDENTITY_TOKEN_PATH, 'utf8').trim();

async function jsonRequest(url, options = {}) {
  const { timeoutMs = 10000, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) { const error = new Error(body?.error || body?.message || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return body;
}

async function kubernetesRequest(method, path, body) {
  return jsonRequest(`${APISERVER}${path}`, {
    method,
    headers: { authorization: `Bearer ${serviceAccountToken()}`, accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 30000,
  });
}

function validateGovernedManifest(manifest, work) {
  if (manifest?.apiVersion !== 'platform.opensphere.io/v1alpha1' || manifest?.kind !== 'GovernedChange'
    || manifest?.metadata?.requestId !== work.request_id
    || manifest?.metadata?.consumerId !== FOUNDATION_OWNER_RELEASE_CONSUMER
    || !['apply', 'rollback'].includes(manifest?.spec?.action) || manifest?.spec?.target !== FOUNDATION_OWNER_RELEASE_TARGET
    || manifest.spec.action !== String(work.action || '').replace(/^gitea:/, '')
    || manifest.spec.target !== work.target || manifest.spec.reason !== work.reason) {
    throw new Error('Foundation owner governed manifest claim mismatch');
  }
  validateFoundationOwnerDesiredState(manifest.spec.desiredState);
  return manifest;
}

async function loadManifest(work) {
  if (!UUID_RE.test(String(work.request_id || '')) || !COMMIT_RE.test(String(work.git_commit_sha || ''))
    || work.git_repo !== `${GITEA_ORGANIZATION}/${GITEA_REPOSITORY}`) {
    throw new Error('claimed Foundation owner change reference is invalid');
  }
  const path = `${GITEA_PATH}/requests/${work.request_id}.json`;
  const file = await internalAuthorityRequest('/api/platform/reconcile/manifest', {
    method: 'POST', authorization: `Bearer ${identityToken()}`,
    body: { reconciler: FOUNDATION_OWNER_RELEASE_RECONCILER, requestId: work.request_id },
  });
  if (file.contract !== 'opensphere-platform-release-manifest-projection/v1'
    || file.requestId !== work.request_id || file.gitCommitSha !== work.git_commit_sha
    || file.gitRepo !== work.git_repo || file.path !== path
    || !/^sha256:[a-f0-9]{64}$/.test(String(file.contentSha256 || ''))) {
    throw new Error('internal Foundation manifest projection differs from the claimed work');
  }
  const raw = Buffer.from(String(file.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
  if (`sha256:${createHash('sha256').update(raw).digest('hex')}` !== file.contentSha256) {
    throw new Error('internal Foundation manifest projection hash mismatch');
  }
  return validateGovernedManifest(JSON.parse(raw), work);
}

function executorJob(work, manifest) {
  validateGovernedManifest(manifest, work);
  const attempt = Number(work.attempt);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 9999 || !EXECUTOR_IMAGE_RE.test(EXECUTOR_IMAGE)) {
    throw new Error('Foundation owner executor identity is invalid');
  }
  const requestHash = createHash('sha256').update(work.request_id).digest('hex').slice(0, 20);
  const name = `foundation-owner-release-${requestHash}-a${attempt}`;
  const job = {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name, namespace: 'opensphere-console', labels: {
      app: 'foundation-owner-release-executor', 'app.kubernetes.io/part-of': 'opensphere-console',
      'opensphere.io/request-id': work.request_id,
    } },
    spec: { backoffLimit: 0, activeDeadlineSeconds: 900, ttlSecondsAfterFinished: 86400,
      template: { metadata: { labels: { app: 'foundation-owner-release-executor', 'opensphere.io/request-id': work.request_id } },
        spec: { serviceAccountName: 'foundation-owner-release-executor', automountServiceAccountToken: false,
          restartPolicy: 'Never',
          imagePullSecrets: [{ name: 'opensphere-ghcr-pull' }],
          containers: [{ name: 'executor', image: EXECUTOR_IMAGE, imagePullPolicy: 'IfNotPresent',
            command: ['node', '/app/opensphere-console-backend/foundation-owner-release-executor.mjs'],
            env: [
              { name: 'NODE_EXTRA_CA_CERTS', value: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt' },
              { name: 'GITEA_ORGANIZATION', value: GITEA_ORGANIZATION }, { name: 'GITEA_REPOSITORY', value: GITEA_REPOSITORY },
              { name: 'GITEA_PATH', value: GITEA_PATH }, { name: 'REQUEST_ID', value: work.request_id },
              { name: 'GIT_COMMIT_SHA', value: work.git_commit_sha }, { name: 'ATTEMPT', value: String(attempt) },
              { name: 'IDENTITY_TOKEN_PATH', value: IDENTITY_TOKEN_PATH },
            ],
            volumeMounts: [
              { name: 'kube-api-access', mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', readOnly: true },
              { name: 'receipt-identity', mountPath: '/var/run/secrets/opensphere-foundation-owner-identity', readOnly: true },
              { name: 'release-control-ca', mountPath: '/var/run/opensphere-platform-release-control-ca', readOnly: true },
            ],
            resources: { requests: { cpu: '50m', memory: '96Mi' }, limits: { cpu: '1', memory: '384Mi' } },
            securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] } },
          }],
          volumes: [
            { name: 'kube-api-access', projected: { defaultMode: 256, sources: [
              { serviceAccountToken: { path: 'token', audience: 'https://kubernetes.default.svc', expirationSeconds: 600 } },
              { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
            ] } },
            { name: 'receipt-identity', projected: { defaultMode: 256, sources: [{ serviceAccountToken: {
              path: 'token', audience: 'opensphere-console-foundation-owner-release', expirationSeconds: 600,
            } }] } },
            { name: 'release-control-ca', configMap: { name: 'opensphere-platform-release-control-ca',
              items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
          ],
        } },
    },
  };
  const templateSha256 = `sha256:${createHash('sha256').update(JSON.stringify({
    labels: job.metadata.labels, spec: job.spec,
  })).digest('hex')}`;
  job.metadata.annotations = {
    'opensphere.io/executor-template-sha256': templateSha256,
    'opensphere.io/merge-revision': work.git_commit_sha,
  };
  return job;
}

async function claimWork() {
  const response = await internalAuthorityRequest('/api/platform/reconcile/next', { method: 'POST',
    authorization: `Bearer ${identityToken()}`,
    body: { reconciler: FOUNDATION_OWNER_RELEASE_RECONCILER, limit: 1 } });
  lastClaimAt = new Date().toISOString(); lastError = null;
  return Array.isArray(response.items) ? response.items[0] || null : null;
}

async function dispatch(work) {
  const manifest = await loadManifest(work);
  const intended = executorJob(work, manifest);
  try { await kubernetesRequest('POST', '/apis/batch/v1/namespaces/opensphere-console/jobs', intended); }
  catch (error) {
    if (error.status !== 409) throw error;
    const existing = await kubernetesRequest('GET',
      `/apis/batch/v1/namespaces/opensphere-console/jobs/${encodeURIComponent(intended.metadata.name)}`);
    if (!sameExecutorJob(existing, intended)) throw new Error('Foundation owner executor Job name is occupied by a different immutable template');
  }
  lastDispatchAt = new Date().toISOString(); lastError = null;
}

function sameExecutorJob(actual, intended) {
  const observed = normalizedExecutorJob(actual, true);
  const expected = normalizedExecutorJob(intended, false);
  return observed !== null && expected !== null
    && JSON.stringify(observed) === JSON.stringify(expected);
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

function normalizedExecutorJob(value, serverDefaulted) {
  if (!value || typeof value !== 'object') return null;
  const job = structuredClone(value);
  delete job.status;
  for (const key of ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields', 'selfLink']) {
    delete job.metadata?.[key];
  }
  if (serverDefaulted) {
    const selector = job.spec?.selector?.matchLabels;
    const controllerUid = selector?.['batch.kubernetes.io/controller-uid'] || selector?.['controller-uid'];
    const templateLabels = job.spec?.template?.metadata?.labels;
    const validSelector = typeof controllerUid === 'string' && controllerUid
      && Object.keys(selector || {}).every((key) =>
        ['batch.kubernetes.io/controller-uid', 'controller-uid'].includes(key))
      && ['batch.kubernetes.io/controller-uid', 'controller-uid'].every((key) =>
        !selector?.[key] || selector[key] === controllerUid)
      && templateLabels?.['batch.kubernetes.io/controller-uid'] === controllerUid
      && templateLabels?.['controller-uid'] === controllerUid
      && templateLabels?.['batch.kubernetes.io/job-name'] === job.metadata?.name
      && templateLabels?.['job-name'] === job.metadata?.name;
    if (!validSelector
      || job.spec.parallelism !== 1 || job.spec.completions !== 1
      || job.spec.completionMode !== 'NonIndexed' || job.spec.manualSelector !== false
      || job.spec.suspend !== false || job.spec.podReplacementPolicy !== 'TerminatingOrFailed') return null;
    for (const key of ['selector', 'parallelism', 'completions', 'completionMode', 'manualSelector',
      'suspend', 'podReplacementPolicy']) delete job.spec[key];
    for (const key of ['batch.kubernetes.io/controller-uid', 'controller-uid',
      'batch.kubernetes.io/job-name', 'job-name']) delete templateLabels[key];
    const podSpec = job.spec.template.spec;
    if (podSpec.serviceAccount !== podSpec.serviceAccountName
      || podSpec.schedulerName !== 'default-scheduler' || podSpec.dnsPolicy !== 'ClusterFirst'
      || podSpec.terminationGracePeriodSeconds !== 30) return null;
    delete podSpec.serviceAccount;
    delete podSpec.schedulerName;
    delete podSpec.dnsPolicy;
    delete podSpec.terminationGracePeriodSeconds;
    if (podSpec.securityContext && Object.keys(podSpec.securityContext).length === 0) delete podSpec.securityContext;
    for (const container of podSpec.containers || []) {
      if (container.terminationMessagePath !== '/dev/termination-log'
        || container.terminationMessagePolicy !== 'File') return null;
      delete container.terminationMessagePath;
      delete container.terminationMessagePolicy;
    }
  }
  return sorted(job);
}

async function failureReceipt(work, error) {
  return internalAuthorityRequest('/api/platform/reconcile/receipt', { method: 'POST',
    authorization: `Bearer ${identityToken()}`, body: { requestId: work.request_id,
      operationId: `${work.request_id}:${work.git_commit_sha}:dispatch:${work.attempt}`.slice(0, 255),
      reconciler: FOUNDATION_OWNER_RELEASE_RECONCILER, desiredRevision: work.desired_revision || null,
      appliedRevision: null, succeeded: false, result: String(error?.message || error).slice(0, 1800),
      evidence: { stage: 'dispatch', errorCode: 'foundation-owner-release-dispatch-failed' } } });
}

function readiness() {
  const ready = Boolean(fs.existsSync(`${SA_PATH}/token`) && fs.existsSync(IDENTITY_TOKEN_PATH)
    && fs.existsSync(INTERNAL_AUTHORITY_CA_FILE))
    && EXECUTOR_IMAGE_RE.test(EXECUTOR_IMAGE);
  return { ready, blocker: ready ? null : 'foundation_owner_release_reconciler_not_configured' };
}

async function pollLoop() {
  while (!stopping) {
    try {
      if (readiness().ready) {
        const work = await claimWork();
        if (work) { activeRequestId = work.request_id; try { await dispatch(work); }
          catch (error) { lastError = String(error?.message || error); await failureReceipt(work, error).catch(() => undefined); }
          finally { activeRequestId = null; } }
      }
    } catch (error) { lastError = String(error?.message || error).slice(0, 500); }
    await sleep(POLL_INTERVAL_MS);
  }
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const state = { service: FOUNDATION_OWNER_RELEASE_RECONCILER, ...readiness(), lastClaimAt, lastDispatchAt, activeRequestId, lastError };
  res.setHeader('content-type', 'application/json');
  if (path === '/healthz') { res.writeHead(200); return res.end(JSON.stringify({ ok: true })); }
  if (path === '/readyz') { res.writeHead(state.ready ? 200 : 503); return res.end(JSON.stringify(state)); }
  res.writeHead(404); return res.end(JSON.stringify({ error: 'not found' }));
});

if (require.main === module) {
  process.on('SIGTERM', () => { stopping = true; server.close(); });
  server.listen(PORT, () => { void pollLoop(); });
}

module.exports = { dispatch, executorJob, normalizedExecutorJob, readiness, sameExecutorJob, validateGovernedManifest };
