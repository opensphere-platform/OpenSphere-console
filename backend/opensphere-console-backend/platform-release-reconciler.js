'use strict';

const http = require('http');
const { createHash } = require('node:crypto');
const fs = require('fs');
const {
  PLATFORM_RELEASE_CONSUMER,
  PLATFORM_RELEASE_RECONCILER,
  PLATFORM_RELEASE_TARGET,
  validatePlatformReleaseDesiredState,
} = require('./platform-release-contract');
const {
  INTERNAL_AUTHORITY_CA_FILE,
  requestJson: internalAuthorityRequest,
} = require('./platform-release-internal-transport');

const PORT = Number(process.env.PORT || 8080);
const GITEA_ORGANIZATION = process.env.GITEA_ORGANIZATION || 'opensphere';
const GITEA_REPOSITORY = process.env.GITEA_REPOSITORY || 'platform-declarations';
const GITEA_PATH = String(process.env.GITEA_PATH || 'platform-release').replace(/^\/+|\/+$/g, '');
const EXECUTOR_IMAGE = process.env.EXECUTOR_IMAGE || '';
const APISERVER = process.env.APISERVER || 'https://kubernetes.default.svc';
const SA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount';
const IDENTITY_TOKEN_PATH = process.env.IDENTITY_TOKEN_PATH
  || '/var/run/secrets/opensphere-platform-release-identity/token';
const POLL_INTERVAL_MS = Math.max(2000, Math.min(60000, Number(process.env.POLL_INTERVAL_MS || 5000)));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_RE = /^[0-9a-f]{40,64}$/i;
const EXECUTOR_IMAGE_RE =
  /^ghcr\.io\/opensphere-platform\/opensphere-console-backend@sha256:[a-f0-9]{64}$/;

let lastClaimAt = null;
let lastDispatchAt = null;
let lastError = null;
let activeRequestId = null;
let stopping = false;
let authorityReadyAt = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function serviceAccountToken() { return fs.readFileSync(`${SA_PATH}/token`, 'utf8').trim(); }
function receiptIdentityToken() { return fs.readFileSync(IDENTITY_TOKEN_PATH, 'utf8').trim(); }

async function kubernetesRequest(method, path, body) {
  const response = await fetch(`${APISERVER}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${serviceAccountToken()}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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

function validateGovernedManifest(manifest, work) {
  if (manifest?.apiVersion !== 'platform.opensphere.io/v1alpha1'
    || manifest?.kind !== 'GovernedChange') {
    throw new Error('unsupported governed manifest');
  }
  if (manifest?.metadata?.requestId !== work.request_id
    || manifest?.metadata?.consumerId !== PLATFORM_RELEASE_CONSUMER) {
    throw new Error('Platform Release governed manifest identity mismatch');
  }
  if (!['apply', 'rollback'].includes(manifest?.spec?.action)
    || manifest?.spec?.target !== PLATFORM_RELEASE_TARGET
    || manifest.spec.action !== String(work.action || '').replace(/^gitea:/, '')
    || manifest.spec.target !== work.target
    || manifest.spec.reason !== work.reason) {
    throw new Error('Platform Release governed manifest claim mismatch');
  }
  validatePlatformReleaseDesiredState(manifest.spec.desiredState);
  return manifest;
}

async function loadManifest(work) {
  if (!UUID_RE.test(String(work.request_id || '')) || !COMMIT_RE.test(String(work.git_commit_sha || ''))) {
    throw new Error('claimed Platform Release change reference is invalid');
  }
  if (work.git_repo !== `${GITEA_ORGANIZATION}/${GITEA_REPOSITORY}`) {
    throw new Error('claimed repository is outside the Platform Release contract');
  }
  const file = await internalAuthorityRequest('/api/platform/reconcile/manifest', {
    method: 'POST',
    authorization: `Bearer ${receiptIdentityToken()}`,
    body: { reconciler: PLATFORM_RELEASE_RECONCILER, requestId: work.request_id },
  });
  if (file.contract !== 'opensphere-platform-release-manifest-projection/v1'
    || file.requestId !== work.request_id || file.gitCommitSha !== work.git_commit_sha
    || file.gitRepo !== work.git_repo || file.path !== `${GITEA_PATH}/requests/${work.request_id}.json`
    || !/^sha256:[a-f0-9]{64}$/.test(String(file.contentSha256 || ''))) {
    throw new Error('internal release manifest projection differs from the claimed work');
  }
  const raw = Buffer.from(String(file.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
  const observed = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  if (observed !== file.contentSha256) throw new Error('internal release manifest projection hash mismatch');
  return validateGovernedManifest(JSON.parse(raw), work);
}

async function ensureInternalAuthorityReady(request = internalAuthorityRequest) {
  if (authorityReadyAt) return authorityReadyAt;
  const response = await request('/readyz', { method: 'GET' });
  if (response?.ready !== true
    || response?.service !== 'opensphere-platform-release-authority'
    || response?.tls !== 'TLSv1.3') {
    throw new Error('Platform Release TLS authority is not exactly ready for mutation claims');
  }
  authorityReadyAt = new Date().toISOString();
  return authorityReadyAt;
}

async function claimWork(request = internalAuthorityRequest, identityToken = receiptIdentityToken) {
  const response = await request('/api/platform/reconcile/next', {
    method: 'POST',
    authorization: `Bearer ${identityToken()}`,
    body: { reconciler: PLATFORM_RELEASE_RECONCILER, limit: 1 },
  });
  lastClaimAt = new Date().toISOString();
  lastError = null;
  return Array.isArray(response.items) ? response.items[0] || null : null;
}

function executorJob(work, manifest) {
  const desired = validatePlatformReleaseDesiredState(manifest.spec.desiredState);
  const attempt = Number(work.attempt);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 9999) {
    throw new Error('claimed Platform Release attempt is invalid');
  }
  const name = `platform-release-${work.request_id}-a${attempt}`;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: 'opensphere-console',
      labels: {
        app: 'platform-release-executor',
        'app.kubernetes.io/part-of': 'opensphere-console',
        'opensphere.io/request-id': work.request_id,
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 2700,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: {
          labels: {
            app: 'platform-release-executor',
            'opensphere.io/request-id': work.request_id,
          },
        },
        spec: {
          serviceAccountName: 'platform-release-executor',
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
          imagePullSecrets: [{ name: 'opensphere-ghcr-pull' }],
          containers: [{
            name: 'executor',
            image: EXECUTOR_IMAGE,
            imagePullPolicy: 'IfNotPresent',
            command: ['node', '/app/opensphere-console-backend/platform-release-executor.mjs'],
            env: [
              { name: 'HOME', value: '/tmp/home' },
              { name: 'NODE_EXTRA_CA_CERTS', value: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt' },
              { name: 'GITEA_ORGANIZATION', value: GITEA_ORGANIZATION },
              { name: 'GITEA_REPOSITORY', value: GITEA_REPOSITORY },
              { name: 'GITEA_PATH', value: GITEA_PATH },
              { name: 'REQUEST_ID', value: work.request_id },
              { name: 'GIT_COMMIT_SHA', value: work.git_commit_sha },
              { name: 'ATTEMPT', value: String(attempt) },
              { name: 'EXPECTED_PREVIOUS_RELEASE_DIGEST', value: desired.previousReleaseDigest },
              {
                name: 'IDENTITY_TOKEN_PATH',
                value: '/var/run/secrets/opensphere-platform-release-identity/token',
              },
            ],
            volumeMounts: [
              {
                name: 'kube-api-access',
                mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
                readOnly: true,
              },
              {
                name: 'receipt-identity',
                mountPath: '/var/run/secrets/opensphere-platform-release-identity',
                readOnly: true,
              },
              { name: 'tmp', mountPath: '/tmp' },
              { name: 'ghcr', mountPath: '/var/run/secrets/opensphere-ghcr', readOnly: true },
              {
                name: 'release-control-ca',
                mountPath: '/var/run/opensphere-platform-release-control-ca',
                readOnly: true,
              },
            ],
            resources: {
              requests: { cpu: '100m', memory: '192Mi' },
              limits: { cpu: '2', memory: '1Gi' },
            },
            securityContext: {
              runAsNonRoot: true,
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] },
            },
          }],
          volumes: [
            {
              name: 'kube-api-access',
              projected: {
                defaultMode: 256,
                sources: [
                  {
                    serviceAccountToken: {
                      path: 'token',
                      audience: 'https://kubernetes.default.svc',
                      expirationSeconds: 600,
                    },
                  },
                  {
                    configMap: {
                      name: 'kube-root-ca.crt',
                      items: [{ key: 'ca.crt', path: 'ca.crt' }],
                    },
                  },
                ],
              },
            },
            {
              name: 'receipt-identity',
              projected: {
                defaultMode: 256,
                sources: [{
                  serviceAccountToken: {
                    path: 'token',
                    audience: 'opensphere-console-platform-release',
                    expirationSeconds: 600,
                  },
                }],
              },
            },
            { name: 'tmp', emptyDir: {} },
            {
              name: 'ghcr',
              secret: {
                secretName: 'opensphere-ghcr-pull',
                optional: true,
                items: [{ key: '.dockerconfigjson', path: 'config.json' }],
              },
            },
            {
              name: 'release-control-ca',
              configMap: {
                name: 'opensphere-platform-release-control-ca',
                items: [{ key: 'ca.crt', path: 'ca.crt' }],
              },
            },
          ],
        },
      },
    },
  };
}

async function dispatch(work) {
  const manifest = await loadManifest(work);
  const job = executorJob(work, manifest);
  try {
    await kubernetesRequest(
      'POST',
      '/apis/batch/v1/namespaces/opensphere-console/jobs',
      job,
    );
  } catch (error) {
    if (error.status !== 409) throw error;
    const existing = await kubernetesRequest(
      'GET',
      `/apis/batch/v1/namespaces/opensphere-console/jobs/${encodeURIComponent(job.metadata.name)}`,
    );
    if (!sameExecutorJob(existing, job)) {
      throw new Error('Platform Release executor Job name is occupied by a different immutable template');
    }
  }
  lastDispatchAt = new Date().toISOString();
  lastError = null;
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
    const labels = job.spec?.template?.metadata?.labels;
    const validSelector = typeof controllerUid === 'string' && controllerUid
      && Object.keys(selector || {}).every((key) =>
        ['batch.kubernetes.io/controller-uid', 'controller-uid'].includes(key))
      && ['batch.kubernetes.io/controller-uid', 'controller-uid'].every((key) =>
        !selector?.[key] || selector[key] === controllerUid)
      && labels?.['batch.kubernetes.io/controller-uid'] === controllerUid
      && labels?.['controller-uid'] === controllerUid
      && labels?.['batch.kubernetes.io/job-name'] === job.metadata?.name
      && labels?.['job-name'] === job.metadata?.name;
    if (!validSelector
      || job.spec.parallelism !== 1 || job.spec.completions !== 1
      || job.spec.completionMode !== 'NonIndexed' || job.spec.manualSelector !== false
      || job.spec.suspend !== false || job.spec.podReplacementPolicy !== 'TerminatingOrFailed') return null;
    for (const key of ['selector', 'parallelism', 'completions', 'completionMode', 'manualSelector',
      'suspend', 'podReplacementPolicy']) delete job.spec[key];
    for (const key of ['batch.kubernetes.io/controller-uid', 'controller-uid',
      'batch.kubernetes.io/job-name', 'job-name']) delete labels[key];
    const podSpec = job.spec.template.spec;
    if (podSpec.serviceAccount !== podSpec.serviceAccountName
      || podSpec.schedulerName !== 'default-scheduler' || podSpec.dnsPolicy !== 'ClusterFirst'
      || podSpec.terminationGracePeriodSeconds !== 30) return null;
    delete podSpec.serviceAccount;
    delete podSpec.schedulerName;
    delete podSpec.dnsPolicy;
    delete podSpec.terminationGracePeriodSeconds;
    if (podSpec.securityContext && Object.keys(podSpec.securityContext).length === 0) {
      delete podSpec.securityContext;
    }
    for (const container of podSpec.containers || []) {
      if (container.terminationMessagePath !== '/dev/termination-log'
        || container.terminationMessagePolicy !== 'File') return null;
      delete container.terminationMessagePath;
      delete container.terminationMessagePolicy;
    }
  }
  return sorted(job);
}

function sameExecutorJob(actual, intended) {
  const observed = normalizedExecutorJob(actual, true);
  const expected = normalizedExecutorJob(intended, false);
  return observed !== null && expected !== null
    && JSON.stringify(observed) === JSON.stringify(expected);
}

async function sendDispatchFailure(work, error) {
  const result = String(error?.message || error).slice(0, 1800);
  return internalAuthorityRequest('/api/platform/reconcile/receipt', {
    method: 'POST',
    authorization: `Bearer ${receiptIdentityToken()}`,
    body: {
      requestId: work.request_id,
      operationId: `${work.request_id}:${work.git_commit_sha}:dispatch:${work.attempt}`.slice(0, 255),
      reconciler: PLATFORM_RELEASE_RECONCILER,
      desiredRevision: work.desired_revision || null,
      appliedRevision: null,
      succeeded: false,
      result,
      evidence: { stage: 'dispatch', errorCode: 'platform-release-dispatch-failed' },
    },
  });
}

function reconcilerReadiness() {
  const credentialsReady = Boolean(fs.existsSync(`${SA_PATH}/token`)
    && fs.existsSync(IDENTITY_TOKEN_PATH)
    && fs.existsSync(INTERNAL_AUTHORITY_CA_FILE));
  const imageReady = EXECUTOR_IMAGE_RE.test(EXECUTOR_IMAGE);
  return {
    ready: credentialsReady && imageReady,
    blocker: !credentialsReady
      ? 'platform_release_reconciler_credentials_unavailable'
      : (!imageReady ? 'platform_release_executor_image_not_exact_digest' : null),
  };
}

async function pollLoop() {
  while (!stopping) {
    try {
      const readiness = reconcilerReadiness();
      if (!readiness.ready) {
        lastError = readiness.blocker;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      await ensureInternalAuthorityReady();
      const work = await claimWork();
      if (work) {
        activeRequestId = work.request_id;
        try { await dispatch(work); }
        catch (error) {
          lastError = String(error?.message || error).slice(0, 500);
          await sendDispatchFailure(work, error).catch((receiptError) => {
            console.error('[platform-release-reconciler] failure receipt rejected:', receiptError.message || receiptError);
          });
          console.error('[platform-release-reconciler] dispatch failed:', work.request_id, lastError);
        } finally {
          activeRequestId = null;
        }
      }
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 500);
      console.error('[platform-release-reconciler] poll failed:', lastError);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const readiness = reconcilerReadiness();
  const body = {
    service: PLATFORM_RELEASE_RECONCILER,
    ready: readiness.ready,
    blocker: readiness.blocker,
    executorImage: EXECUTOR_IMAGE_RE.test(EXECUTOR_IMAGE) ? EXECUTOR_IMAGE : null,
    lastClaimAt,
    lastDispatchAt,
    activeRequestId,
    lastError,
  };
  res.setHeader('content-type', 'application/json');
  if (path === '/healthz') { res.writeHead(200); return res.end(JSON.stringify({ ok: true })); }
  if (path === '/readyz') { res.writeHead(readiness.ready ? 200 : 503); return res.end(JSON.stringify(body)); }
  res.writeHead(404);
  return res.end(JSON.stringify({ error: 'not found' }));
});

if (require.main === module) {
  process.on('SIGTERM', () => { stopping = true; server.close(); });
  server.listen(PORT, () => {
    console.log(`[platform-release-reconciler] listening :${PORT}`);
    void pollLoop();
  });
}

module.exports = {
  dispatch,
  validateGovernedManifest,
  executorJob,
  ensureInternalAuthorityReady,
  claimWork,
  normalizedExecutorJob,
  reconcilerReadiness,
  sameExecutorJob,
};
