import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  readInstallationLock,
  upgrade,
} from '/app/opensphere-setup-cli/src/bootstrap.mjs';

const require = createRequire(import.meta.url);
const {
  PLATFORM_RELEASE_CONSUMER,
  PLATFORM_RELEASE_RECONCILER,
  PLATFORM_RELEASE_TARGET,
  validatePlatformReleaseDesiredState,
} = require('./platform-release-contract.js');

const BACKEND_URL = (process.env.CONSOLE_BACKEND_URL
  || 'http://opensphere-console-backend.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const GITEA_URL = (process.env.GITEA_URL
  || 'http://opensphere-gitea.opensphere-console-change.svc.cluster.local:3000').replace(/\/$/, '');
const GITEA_ORGANIZATION = process.env.GITEA_ORGANIZATION || 'opensphere';
const GITEA_REPOSITORY = process.env.GITEA_REPOSITORY || 'platform-declarations';
const GITEA_PATH = String(process.env.GITEA_PATH || 'platform-release').replace(/^\/+|\/+$/g, '');
const GITEA_TOKEN = process.env.GITEA_TOKEN || '';
const RECONCILER_TOKEN = process.env.RECONCILER_TOKEN || '';
const REQUEST_ID = process.env.REQUEST_ID || '';
const GIT_COMMIT_SHA = process.env.GIT_COMMIT_SHA || '';
const ATTEMPT = Number(process.env.ATTEMPT || 1);
const EXPECTED_PREVIOUS_RELEASE_DIGEST = process.env.EXPECTED_PREVIOUS_RELEASE_DIGEST || '';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_RE = /^[0-9a-f]{40,64}$/i;

function encodedPath(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonRequest(url, options = {}) {
  const { timeoutMs = 15000, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { raw: text }; }
  if (!response.ok) throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
  return body;
}

function validateManifest(manifest) {
  if (manifest?.apiVersion !== 'platform.opensphere.io/v1alpha1'
    || manifest?.kind !== 'GovernedChange'
    || manifest?.metadata?.requestId !== REQUEST_ID
    || manifest?.metadata?.consumerId !== PLATFORM_RELEASE_CONSUMER
    || !['apply', 'rollback'].includes(manifest?.spec?.action)
    || manifest?.spec?.target !== PLATFORM_RELEASE_TARGET) {
    throw new Error('Platform Release governed manifest identity or action is invalid');
  }
  const desired = validatePlatformReleaseDesiredState(manifest.spec.desiredState);
  if (desired.previousReleaseDigest !== EXPECTED_PREVIOUS_RELEASE_DIGEST) {
    throw new Error('Platform Release dispatch precondition differs from the reviewed declaration');
  }
  return desired;
}

async function loadDesiredState() {
  if (!UUID_RE.test(REQUEST_ID) || !COMMIT_RE.test(GIT_COMMIT_SHA)
    || !GITEA_TOKEN || !RECONCILER_TOKEN) {
    throw new Error('Platform Release executor identity or credentials are unavailable');
  }
  const path = `${GITEA_PATH}/requests/${REQUEST_ID}.json`;
  const file = await jsonRequest(
    `${GITEA_URL}/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}`
      + `/contents/${encodedPath(path)}?ref=${encodeURIComponent(GIT_COMMIT_SHA)}`,
    { headers: { authorization: `token ${GITEA_TOKEN}`, accept: 'application/json' } },
  );
  const raw = Buffer.from(String(file.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
  return validateManifest(JSON.parse(raw));
}

function registryCredentials() {
  const path = '/var/run/secrets/opensphere-ghcr/config.json';
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return undefined; }
  const entry = config?.auths?.['ghcr.io'];
  if (!entry) return undefined;
  if (typeof entry.auth === 'string' && entry.auth) {
    const decoded = Buffer.from(entry.auth, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator > 0 && separator < decoded.length - 1) {
      return { username: decoded.slice(0, separator), token: decoded.slice(separator + 1) };
    }
  }
  if (typeof entry.username === 'string' && typeof entry.password === 'string'
    && entry.username && entry.password) {
    return { username: entry.username, token: entry.password };
  }
  return undefined;
}

function requiredPlatforms() {
  const raw = execFileSync('kubectl', ['get', 'nodes', '-o', 'json'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const nodes = JSON.parse(raw).items || [];
  const platforms = [...new Set(nodes.map((node) => {
    const os = String(node?.status?.nodeInfo?.operatingSystem || '').toLowerCase();
    const architecture = String(node?.status?.nodeInfo?.architecture || '').toLowerCase();
    return os && architecture ? `${os}/${architecture}` : '';
  }).filter(Boolean))].sort();
  if (!platforms.length) throw new Error('Platform Release executor cannot determine cluster node platforms');
  return platforms;
}

async function sendReceipt({ succeeded, result, desiredRevision, appliedRevision, evidence }) {
  const payload = {
    requestId: REQUEST_ID,
    operationId: `${REQUEST_ID}:${GIT_COMMIT_SHA}:${ATTEMPT}`.slice(0, 255),
    reconciler: PLATFORM_RELEASE_RECONCILER,
    desiredRevision,
    appliedRevision,
    succeeded,
    result: String(result).slice(0, 2000),
    evidence,
  };
  let last;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      return await jsonRequest(`${BACKEND_URL}/api/platform/reconcile/receipt`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-opensphere-reconciler-token': RECONCILER_TOKEN,
        },
        body: JSON.stringify(payload),
        timeoutMs: 20000,
      });
    } catch (error) {
      last = error;
      if (attempt < 60) await sleep(5000);
    }
  }
  throw new Error(`Platform Release receipt was not accepted after Console recovery: ${last?.message || last}`);
}

async function main() {
  const desired = await loadDesiredState();
  const current = readInstallationLock();
  if (!current || current.releaseDigest !== desired.previousReleaseDigest) {
    throw new Error('Platform Release request is stale; installation lock changed before execution');
  }
  const platforms = requiredPlatforms();
  const result = await upgrade(current, desired.targetLock, {
    registryCredentials: registryCredentials(),
    requiredPlatforms: platforms,
  });
  const installed = readInstallationLock();
  if (!installed || installed.releaseDigest !== desired.targetLock.releaseDigest) {
    throw new Error('Platform Release executor finished without the requested installation lock');
  }
  await sendReceipt({
    succeeded: true,
    result: result.changed
      ? 'signed Platform Release applied and verified'
      : 'requested Platform Release was already current and verified',
    desiredRevision: GIT_COMMIT_SHA,
    appliedRevision: installed.sourceRevision,
    evidence: {
      stage: 'observed',
      channel: installed.channel,
      previousReleaseDigest: current.releaseDigest,
      installedReleaseDigest: installed.releaseDigest,
      sourceRevision: installed.sourceRevision,
      platforms,
      changed: result.changed,
      podCount: result.evidence?.podCount ?? null,
      serviceCount: result.evidence?.serviceCount ?? null,
      rollbackContract: 'Setup upgrade restores the previously verified release on failed target verification',
    },
  });
}

try {
  await main();
} catch (error) {
  let observedReleaseDigest = null;
  let observedSourceRevision = null;
  try {
    const observed = readInstallationLock();
    observedReleaseDigest = observed?.releaseDigest || null;
    observedSourceRevision = observed?.sourceRevision || null;
  } catch {
    // The failure receipt remains explicit even if the observed lock is unreadable.
  }
  await sendReceipt({
    succeeded: false,
    result: String(error?.message || error),
    desiredRevision: GIT_COMMIT_SHA || null,
    appliedRevision: observedSourceRevision,
    evidence: {
      stage: 'failed',
      errorCode: 'platform-release-execution-failed',
      expectedPreviousReleaseDigest: EXPECTED_PREVIOUS_RELEASE_DIGEST || null,
      observedReleaseDigest,
      rollbackObserved: observedReleaseDigest === EXPECTED_PREVIOUS_RELEASE_DIGEST,
    },
  }).catch((receiptError) => {
    console.error('[platform-release-executor] failure receipt rejected:', receiptError.message || receiptError);
  });
  console.error('[platform-release-executor] failed:', error?.stack || error);
  process.exitCode = 1;
}
