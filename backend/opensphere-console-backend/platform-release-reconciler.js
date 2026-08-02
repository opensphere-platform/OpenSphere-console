'use strict';

const http = require('http');
const fs = require('fs');
const {
  PLATFORM_RELEASE_CONSUMER,
  PLATFORM_RELEASE_RECONCILER,
  PLATFORM_RELEASE_TARGET,
  validatePlatformReleaseDesiredState,
} = require('./platform-release-contract');

const PORT = Number(process.env.PORT || 8080);
const BACKEND_URL = (process.env.CONSOLE_BACKEND_URL
  || 'http://opensphere-console-backend.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const GITEA_URL = (process.env.GITEA_URL
  || 'http://opensphere-gitea.opensphere-console-change.svc.cluster.local:3000').replace(/\/$/, '');
const GITEA_ORGANIZATION = process.env.GITEA_ORGANIZATION || 'opensphere';
const GITEA_REPOSITORY = process.env.GITEA_REPOSITORY || 'platform-declarations';
const GITEA_PATH = String(process.env.GITEA_PATH || 'platform-release').replace(/^\/+|\/+$/g, '');
const GITEA_TOKEN = process.env.GITEA_TOKEN || '';
const RECONCILER_TOKEN = process.env.RECONCILER_TOKEN || '';
const EXECUTOR_IMAGE = process.env.EXECUTOR_IMAGE || '';
const APISERVER = process.env.APISERVER || 'https://kubernetes.default.svc';
const SA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount';
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
  if (!response.ok) {
    const error = new Error(body?.error || body?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

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
  const path = `${GITEA_PATH}/requests/${work.request_id}.json`;
  const file = await jsonRequest(
    `${GITEA_URL}/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}`
      + `/contents/${encodedPath(path)}?ref=${encodeURIComponent(work.git_commit_sha)}`,
    { headers: { authorization: `token ${GITEA_TOKEN}`, accept: 'application/json' } },
  );
  const raw = Buffer.from(String(file.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
  return validateGovernedManifest(JSON.parse(raw), work);
}

async function claimWork() {
  const response = await jsonRequest(`${BACKEND_URL}/api/platform/reconcile/next`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-opensphere-reconciler-token': RECONCILER_TOKEN,
    },
    body: JSON.stringify({ reconciler: PLATFORM_RELEASE_RECONCILER, limit: 1 }),
  });
  lastClaimAt = new Date().toISOString();
  lastError = null;
  return Array.isArray(response.items) ? response.items[0] || null : null;
}

function executorJob(work, manifest) {
  const desired = validatePlatformReleaseDesiredState(manifest.spec.desiredState);
  const name = `platform-release-${work.request_id}`;
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
              { name: 'CONSOLE_BACKEND_URL', value: BACKEND_URL },
              { name: 'GITEA_URL', value: GITEA_URL },
              { name: 'GITEA_ORGANIZATION', value: GITEA_ORGANIZATION },
              { name: 'GITEA_REPOSITORY', value: GITEA_REPOSITORY },
              { name: 'GITEA_PATH', value: GITEA_PATH },
              { name: 'REQUEST_ID', value: work.request_id },
              { name: 'GIT_COMMIT_SHA', value: work.git_commit_sha },
              { name: 'ATTEMPT', value: String(work.attempt) },
              { name: 'EXPECTED_PREVIOUS_RELEASE_DIGEST', value: desired.previousReleaseDigest },
              {
                name: 'GITEA_TOKEN',
                valueFrom: { secretKeyRef: { name: 'opensphere-gitea-control-plane', key: 'token' } },
              },
              {
                name: 'RECONCILER_TOKEN',
                valueFrom: { secretKeyRef: { name: 'opensphere-gitea-control-plane', key: 'reconciler-token' } },
              },
            ],
            volumeMounts: [
              { name: 'tmp', mountPath: '/tmp' },
              { name: 'ghcr', mountPath: '/var/run/secrets/opensphere-ghcr', readOnly: true },
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
            { name: 'tmp', emptyDir: {} },
            {
              name: 'ghcr',
              secret: {
                secretName: 'opensphere-ghcr-pull',
                optional: true,
                items: [{ key: '.dockerconfigjson', path: 'config.json' }],
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
  }
  lastDispatchAt = new Date().toISOString();
  lastError = null;
}

async function sendDispatchFailure(work, error) {
  const result = String(error?.message || error).slice(0, 1800);
  return jsonRequest(`${BACKEND_URL}/api/platform/reconcile/receipt`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-opensphere-reconciler-token': RECONCILER_TOKEN,
    },
    body: JSON.stringify({
      requestId: work.request_id,
      operationId: `${work.request_id}:${work.git_commit_sha}:dispatch:${work.attempt}`.slice(0, 255),
      reconciler: PLATFORM_RELEASE_RECONCILER,
      desiredRevision: work.desired_revision || null,
      appliedRevision: null,
      succeeded: false,
      result,
      evidence: { stage: 'dispatch', errorCode: 'platform-release-dispatch-failed' },
    }),
  });
}

function reconcilerReadiness() {
  const credentialsReady = Boolean(GITEA_TOKEN && RECONCILER_TOKEN && fs.existsSync(`${SA_PATH}/token`));
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
  validateGovernedManifest,
  executorJob,
  reconcilerReadiness,
};
