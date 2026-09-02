import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const {
  EngineeringRemediationWorker, deploymentApprovalBinding, patchTextDigest,
} = require('../apps/console-api/runtime/r2d2-engineering-remediation.js');
const {
  COMPONENT_RULES, CONSOLE_REPOSITORY, safeSandboxRoot, sha256, validateLocalEdgeRepair,
} = require('../apps/console-api/runtime/r2d2-repair-runner-contract.js');

const consoleUrl = String(process.env.OPENSPHERE_CONSOLE_URL || 'https://localhost:1114').replace(/\/$/, '');
const once = process.argv.includes('--once');
const runnerSourceRevision = String(process.env.OPENSPHERE_REPAIR_RUNNER_REVISION || '').trim();
const runnerId = `local-edge-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32)}-${process.pid}`;
const claimEpoch = Date.now();
const sandboxBase = path.join(os.tmpdir(), 'opensphere-r2d2-repair');
const artifactBase = path.join(os.tmpdir(), 'opensphere-r2d2-repair-artifacts');
const tokenState = { value: '', refreshAt: 0 };
const activeClaims = new Set();

function retryDelayMs(consecutiveFailures) {
  return Math.min(30_000, 1_000 * (2 ** Math.max(0, Math.min(5, consecutiveFailures - 1))));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function exactSha(value, label) {
  const revision = String(value || '').trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`${label} must be an exact source revision`);
  return revision;
}

function exactDigest(value, label) {
  const digest = String(value || '').trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${label} must be an exact digest`);
  return digest;
}

function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd, env: options.env || process.env, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = []; const stderr = []; let outBytes = 0; let errBytes = 0;
    child.stdout.on('data', (chunk) => { outBytes += chunk.length; if (outBytes <= (options.maxOutput || 4 * 1024 * 1024)) stdout.push(chunk); });
    child.stderr.on('data', (chunk) => { errBytes += chunk.length; if (errBytes <= 512 * 1024) stderr.push(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8'); const errors = Buffer.concat(stderr).toString('utf8');
      if (code === 0 && outBytes <= (options.maxOutput || 4 * 1024 * 1024)) return resolve({ stdout: output, stderr: errors });
      reject(Object.assign(new Error(`${program} failed (${code}): ${errors.slice(-1200)}`), { code: options.errorCode || 'RepairRunnerCommandFailed' }));
    });
  });
}

async function currentToken() {
  if (tokenState.value && tokenState.refreshAt > Date.now()) return tokenState.value;
  const result = await run('kubectl', ['-n','opensphere-console','create','token','opensphere-local-edge-release',
    '--audience','opensphere-local-edge-release','--duration=10m'], { errorCode: 'RepairRunnerTokenUnavailable' });
  tokenState.value = result.stdout.trim(); tokenState.refreshAt = Date.now() + 7 * 60 * 1000;
  if (!tokenState.value) throw new Error('Kubernetes did not issue a Repair Runner token');
  return tokenState.value;
}

async function api(pathname, body) {
  const token = await currentToken(); const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
  const target = new URL(`${consoleUrl}${pathname}`);
  if (target.protocol !== 'https:' || target.hostname !== 'localhost') throw new Error('Repair Runner Console URL must be HTTPS localhost');
  return new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: 'POST', rejectUnauthorized: false,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length },
    }, (response) => {
      const chunks = []; let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; if (bytes <= 1024 * 1024) chunks.push(chunk); });
      response.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* handled below */ }
        if (response.statusCode >= 200 && response.statusCode < 300 && bytes <= 1024 * 1024) return resolve(parsed);
        reject(Object.assign(new Error(parsed.error || `Repair Runner API returned HTTP ${response.statusCode}`), { code: `HTTP${response.statusCode}` }));
      });
    });
    request.on('error', reject); request.end(payload);
  });
}

async function withLease(requestId, work) {
  let stopped = false; let failure = null;
  const pulse = async () => {
    try {
      const result = await api(`/api/osaa/remediations/local-edge-runner/${requestId}/heartbeat`, { runnerId, claimEpoch });
      if (result.alive !== true) failure = Object.assign(new Error('Repair Runner lease was lost'), { code: 'ClaimLeaseLost' });
    } catch (error) { failure = error; }
  };
  const timer = setInterval(() => { if (!stopped) pulse(); }, 10_000); timer.unref();
  try {
    const result = await work(); if (failure) throw failure; return result;
  } finally { stopped = true; clearInterval(timer); }
}

async function validateHost() {
  if (process.platform !== 'win32') throw new Error('Repair Runner is restricted to the Windows Docker Desktop host');
  if (!/^[0-9a-f]{40}$/.test(runnerSourceRevision)) throw new Error('OPENSPHERE_REPAIR_RUNNER_REVISION must be the deployed exact Console revision');
  const context = (await run('kubectl', ['config','current-context'])).stdout.trim();
  if (context !== 'docker-desktop') throw new Error('Repair Runner requires Kubernetes context docker-desktop');
  const docker = JSON.parse((await run('docker', ['info','--format','{{json .}}'])).stdout);
  if (String(docker.OSType).toLowerCase() !== 'linux' || !['amd64','x86_64'].includes(String(docker.Architecture).toLowerCase())) {
    throw new Error('Repair Runner requires Docker Desktop Linux/amd64');
  }
  const hostDigest = sha256(JSON.stringify({ hostname: os.hostname(), platform: process.platform, arch: process.arch, context }));
  await api('/api/osaa/remediations/local-edge-runner/register', { runnerId, claimEpoch, hostDigest, sourceRevision: runnerSourceRevision });
}

function apiStore() {
  return {
    async heartbeat(id) {
      const result = await api(`/api/osaa/remediations/local-edge-runner/${id}/heartbeat`, { runnerId, claimEpoch });
      return result.alive === true;
    },
    async block(id, code) {
      const expectedStage = claimStages.get(id) || 'approved';
      return this.stage(id, 'failed', { code }, expectedStage);
    },
    async stage(id, nextStage, evidence, explicitExpected) {
      const expectedStage = explicitExpected || claimStages.get(id);
      const row = await api(`/api/osaa/remediations/local-edge-runner/${id}/stage`, {
        runnerId, claimEpoch, expectedStage, nextStage, evidence,
      });
      claimStages.set(id, nextStage); return row;
    },
    async recordBuildEvidence(id, evidence) {
      return api(`/api/osaa/remediations/local-edge-runner/${id}/build-evidence`, { runnerId, claimEpoch, evidence });
    },
    async recordDeploymentVerification(id, evidence) {
      return api(`/api/osaa/remediations/local-edge-runner/${id}/verification`, { runnerId, claimEpoch, evidence });
    },
  };
}

const claimStages = new Map();

function authorizer() {
  return { authorize: (request, scope, bindingDigest) => api(
    `/api/osaa/remediations/local-edge-runner/${request.remediationRequestId}/authorize`,
    { runnerId, claimEpoch, scope, bindingDigest },
  ) };
}

function sourceAdapter(scope) {
  return {
    async currentRevision(repository) {
      if (repository !== CONSOLE_REPOSITORY) throw new Error('unexpected repository');
      const output = (await run('git', ['ls-remote', repository, 'refs/heads/main'])).stdout.trim().split(/\s+/)[0];
      return exactSha(output, 'canonical main');
    },
    async applyPatch(workspace, artifact) {
      const patchPath = path.join(workspace.root, '.opensphere-approved.patch');
      await fs.writeFile(patchPath, artifact.patchText, { encoding: 'utf8', mode: 0o600 });
      if (patchTextDigest(artifact.patchText) !== artifact.patchDigest) throw Object.assign(new Error('patch bytes changed'), { code: 'PatchDigestChanged' });
      await run('git', ['-C',workspace.root,'apply','--check','--whitespace=error-all',patchPath], { errorCode: 'PatchCheckFailed' });
      await run('git', ['-C',workspace.root,'apply','--index','--whitespace=error-all',patchPath], { errorCode: 'PatchApplyFailed' });
      await fs.rm(patchPath, { force: true });
      const changedFiles = (await run('git', ['-C',workspace.root,'diff','--cached','--name-only','--diff-filter=ACMRT'])).stdout.split(/\r?\n/).filter(Boolean);
      await run('git', ['-C',workspace.root,'diff','--cached','--check']);
      return { changedFiles, patchDigest: artifact.patchDigest };
    },
    async commit(workspace, input) {
      await run('git', ['-C',workspace.root,'config','user.name','OpenSphere R2D2']);
      await run('git', ['-C',workspace.root,'config','user.email','r2d2@opensphere.local']);
      await run('git', ['-C',workspace.root,'commit','-m',`fix(osaa): apply repair ${input.remediationRequestId}`]);
      const sourceRevision = exactSha((await run('git', ['-C',workspace.root,'rev-parse','HEAD'])).stdout.trim(), 'repair commit');
      const parent = exactSha((await run('git', ['-C',workspace.root,'rev-parse','HEAD^'])).stdout.trim(), 'repair parent');
      if (parent !== input.baseRevision) throw Object.assign(new Error('repair commit parent changed'), { code: 'BaseRevisionChanged' });
      await withLease(input.remediationRequestId, () => run('git', ['-C',workspace.root,'push','origin',
        `HEAD:refs/heads/main`,`--force-with-lease=refs/heads/main:${input.baseRevision}`], { errorCode: 'CanonicalPushFailed' }));
      return { sourceRevision };
    },
  };
}

function sandboxAdapter(request) {
  return {
    async create() {
      const root = safeSandboxRoot(sandboxBase, request.remediationRequestId);
      await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(path.dirname(root), { recursive: true });
      await run('git', ['clone','--no-tags','--branch','main','--single-branch',CONSOLE_REPOSITORY,root], { errorCode: 'CanonicalCloneFailed' });
      const revision = exactSha((await run('git', ['-C',root,'rev-parse','HEAD'])).stdout.trim(), 'sandbox revision');
      const origin = (await run('git', ['-C',root,'remote','get-url','origin'])).stdout.trim();
      if (revision !== request.baseRevision || origin !== CONSOLE_REPOSITORY) throw Object.assign(new Error('sandbox source authority differs from approval'), { code: 'BaseRevisionChanged' });
      return { root };
    },
    async destroy(workspace) {
      const root = safeSandboxRoot(sandboxBase, request.remediationRequestId);
      if (workspace?.root !== root) throw new Error('sandbox destroy target differs from request');
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function testAdapter(request) {
  let shared = null;
  return { async run(workspace, testId) {
    if (!shared) shared = withLease(request.remediationRequestId, async () => {
      await run('npm', ['ci','--no-audit','--no-fund','--legacy-peer-deps'], { cwd: workspace.root, errorCode: 'DependencyInstallFailed', maxOutput: 8 * 1024 * 1024 });
      const result = await run('npm', ['test'], { cwd: workspace.root, errorCode: 'RegisteredTestsFailed', maxOutput: 16 * 1024 * 1024 });
      return sha256(`${result.stdout}\n${result.stderr}`);
    });
    const evidenceDigest = await shared;
    return { status: 'passed', evidenceDigest: sha256(`${testId}:${evidenceDigest}`) };
  } };
}

async function parsePublication(stdout) {
  const candidates = stdout.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.endsWith('.json'));
  for (const candidate of candidates.reverse()) {
    try { const parsed = JSON.parse(await fs.readFile(candidate, 'utf8')); return { path: candidate, document: parsed }; } catch { /* next */ }
  }
  throw new Error('component publisher did not return publication evidence');
}

function componentRequest(publication) {
  return Object.fromEntries(Object.entries(publication.components || {}).map(([name, item]) => [name, { image: item.image }]));
}

function builderAdapter(request, scope, artifactRootRef) {
  return { async build(workspace) {
    const records = [];
    for (const publisher of scope.publishers) {
      const result = await withLease(request.remediationRequestId, () => run('pwsh', ['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(workspace.root, publisher)], {
        cwd: workspace.root, errorCode: 'ComponentPublicationFailed', maxOutput: 8 * 1024 * 1024,
      }));
      records.push(await parsePublication(result.stdout));
    }
    const artifactRoot = path.join(artifactBase, request.remediationRequestId);
    await fs.rm(artifactRoot, { recursive: true, force: true }); await fs.mkdir(artifactRoot, { recursive: true });
    const components = {}; const affectedImages = [];
    for (const record of records) {
      Object.assign(components, record.document.components || {});
      affectedImages.push(...(record.document.affectedImages || []));
    }
    const publication = {
      apiVersion: 'release.opensphere.io/v1alpha1', kind: 'OpenSphereEdgeComponentPublication',
      publicationScope: 'ComponentSet', channel: 'edge', status: 'Active',
      requestIntent: `R2D2 approved repair ${request.remediationRequestId}`,
      changedPaths: scope.changedPaths, affectedImages: [...new Set(affectedImages)].sort(),
      releaseScope: 'component', fullReleaseJustification: null,
      releaseTag: records[0].document.releaseTag, immutableTag: records[0].document.immutableTag || records[0].document.releaseTag,
      source: 'https://github.com/opensphere-platform/OpenSphere-console',
      sourceRevision: records[0].document.sourceRevision, buildAuthority: 'localhost',
      releaseClass: 'pre-ga', gaEligible: false, supportedPlatforms: ['linux/amd64'],
      components, verification: { repairRunner: 'PASS', exactAffectedComponentSet: scope.releaseComponents },
    };
    const publicationPath = path.join(artifactRoot, 'opensphere-r2d2-component-publication.json');
    await fs.writeFile(publicationPath, `${JSON.stringify(publication, null, 2)}\n`, 'utf8');
    const preview = await api('/api/platform/releases/local-edge-automation/preview', {
      reason: request.reason, sourceRevision: publication.sourceRevision, components: componentRequest(publication),
    });
    const imageDigests = Object.values(components).map((item) => exactDigest(String(item.image).split('@')[1], 'published image'));
    const provenanceDigest = sha256(await fs.readFile(publicationPath, 'utf8'));
    artifactRootRef.value = artifactRoot;
    return {
      buildAuthority: 'localhost', imageDigests, sbomDigest: null, signatureDigest: null,
      provenanceDigest, releaseLockDigest: exactDigest(preview.targetReleaseDigest, 'target release lock'),
      publicationPath,
    };
  } };
}

function deployerAdapter(request, scope, artifactRootRef) {
  async function publicationForBuild(build) {
    const existing = build.publicationPath || (artifactRootRef.value
      ? path.join(artifactRootRef.value, 'opensphere-r2d2-component-publication.json') : '');
    if (existing) {
      try { await fs.access(existing); return existing; } catch { /* reconstruct below */ }
    }
    const rule = COMPONENT_RULES.find((candidate) => candidate.sourceComponent === scope.sourceComponents[0]);
    const artifactRoot = path.join(artifactBase, request.remediationRequestId);
    await fs.mkdir(artifactRoot, { recursive: true }); artifactRootRef.value = artifactRoot;
    const image = `ghcr.io/opensphere-platform/${rule.image}@${exactDigest(build.imageDigests[0], 'published image')}`;
    const publication = {
      apiVersion: 'release.opensphere.io/v1alpha1', kind: 'OpenSphereEdgeComponentPublication',
      publicationScope: 'ComponentSet', channel: 'edge', status: 'Active',
      requestIntent: `R2D2 approved repair ${request.remediationRequestId}`, changedPaths: scope.changedPaths,
      affectedImages: [`ghcr.io/opensphere-platform/${rule.image}`], releaseScope: 'component', fullReleaseJustification: null,
      releaseTag: 'repair-resume', immutableTag: 'repair-resume', source: 'https://github.com/opensphere-platform/OpenSphere-console',
      sourceRevision: build.sourceRevision, buildAuthority: 'localhost', releaseClass: 'pre-ga', gaEligible: false,
      supportedPlatforms: ['linux/amd64'],
      components: { [rule.releaseComponent]: { repository: rule.image, image, sourceRevision: build.sourceRevision } },
      verification: { repairRunnerResume: 'PASS' },
    };
    const target = path.join(artifactRoot, 'opensphere-r2d2-component-publication.json');
    await fs.writeFile(target, `${JSON.stringify(publication, null, 2)}\n`, 'utf8'); return target;
  }
  return {
    async deploy({ build }) {
      const publicationPath = await publicationForBuild(build);
      await withLease(request.remediationRequestId, () => run('pwsh', ['-NoLogo','-NoProfile','-NonInteractive','-File',
        path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'Invoke-LocalEdgePlatformRelease.ps1'),
        '-PublicationEvidence',publicationPath,'-Reason',request.reason], { errorCode: 'ComponentDeploymentFailed', maxOutput: 4 * 1024 * 1024 }));
      return { releaseLockDigest: build.releaseLockDigest, publicationPath };
    },
    async rollback() {
      const rule = COMPONENT_RULES.find((candidate) => candidate.sourceComponent === scope.sourceComponents[0]);
      const digestValue = exactDigest(request.rollbackImageDigests[0], 'rollback image');
      const image = `ghcr.io/opensphere-platform/${rule.image}@${digestValue}`;
      const publication = {
        apiVersion: 'release.opensphere.io/v1alpha1', kind: 'OpenSphereEdgeComponentPublication',
        publicationScope: 'ComponentSet', channel: 'edge', status: 'Active',
        requestIntent: `R2D2 rollback ${request.remediationRequestId}`, changedPaths: scope.changedPaths,
        affectedImages: [`ghcr.io/opensphere-platform/${rule.image}`], releaseScope: 'component', fullReleaseJustification: null,
        releaseTag: 'rollback', immutableTag: 'rollback', source: 'https://github.com/opensphere-platform/OpenSphere-console',
        sourceRevision: request.rollbackRevision, buildAuthority: 'localhost', releaseClass: 'pre-ga', gaEligible: false,
        supportedPlatforms: ['linux/amd64'], components: { [rule.releaseComponent]: { repository: rule.image, image, sourceRevision: request.rollbackRevision } },
        verification: { repairRunnerRollback: 'PASS' },
      };
      const rollbackPath = path.join(artifactRootRef.value, 'opensphere-r2d2-rollback-publication.json');
      await fs.writeFile(rollbackPath, `${JSON.stringify(publication, null, 2)}\n`, 'utf8');
      await withLease(request.remediationRequestId, () => run('pwsh', ['-NoLogo','-NoProfile','-NonInteractive','-File',
        path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'Invoke-LocalEdgePlatformRelease.ps1'),
        '-PublicationEvidence',rollbackPath,'-Reason',`Rollback ${request.remediationRequestId}`], { errorCode: 'RepairRollbackFailed' }));
      return { rollbackPath, rollbackRevision: request.rollbackRevision, imageDigests: request.rollbackImageDigests };
    },
  };
}

async function installedLock() {
  const raw = (await run('kubectl', ['-n','opensphere-console','get','configmap','opensphere-installation-lock','-o','jsonpath={.data.release\\.json}'])).stdout;
  return JSON.parse(raw);
}

function verifierAdapter(request, scope) {
  async function observedImages() {
    const images = [];
    for (const workload of scope.workloads) {
      const raw = (await run('kubectl', ['-n',workload.namespace,'get',workload.kind,workload.name,'-o','json'])).stdout;
      const row = JSON.parse(raw); const container = row.spec?.template?.spec?.containers?.find((item) => item.name === workload.container);
      images.push(exactDigest(String(container?.image || '').split('@')[1], 'observed workload image'));
    }
    return images;
  }
  async function browserEvidence() {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const result = await api(`/api/osaa/remediations/local-edge-runner/${request.remediationRequestId}/browser-verification`, { runnerId, claimEpoch });
      if (result.ready) return result;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return { ready: false, passed: false, code: 'AuthenticatedBrowserVerificationTimeout' };
  }
  return {
    async observe({ build }) {
      const [lock, imageDigests, browser] = await Promise.all([installedLock(), observedImages(), browserEvidence()]);
      const apiHealth = await new Promise((resolve) => {
        const target = new URL(`${consoleUrl}/api/health`);
        https.get(target, { rejectUnauthorized: false }, (response) => {
          response.resume(); resolve({ passed: response.statusCode === 200, status: response.statusCode });
        }).on('error', (error) => resolve({ passed: false, code: error.code || 'HealthRequestFailed' }));
      });
      return {
        imageDigests, lockDigest: lock.releaseDigest, authorityFresh: true, api: apiHealth,
        ui: { passed: browser.ready === true && browser.passed === true
          && browser.observedSourceRevision === build.sourceRevision, evidenceDigest: browser.evidenceDigest || null,
          profile: request.verificationProfile, route: request.verificationRoute },
      };
    },
    async verifyRollback() {
      const [lock, imageDigests] = await Promise.all([installedLock(), observedImages()]);
      return { verified: imageDigests.length === 1 && imageDigests[0] === request.rollbackImageDigests[0],
        lockDigest: lock.releaseDigest, imageDigests };
    },
  };
}

async function processClaim(item) {
  const request = item.request; claimStages.set(request.remediationRequestId, request.stage); activeClaims.add(request.remediationRequestId);
  const artifactRootRef = { value: '' }; const store = apiStore();
  try {
    let scope;
    try { scope = validateLocalEdgeRepair(request); }
    catch (error) {
      await store.block(request.remediationRequestId, error.code || 'UnsupportedRepairScope');
      return { status: 'failed', code: error.code || 'UnsupportedRepairScope' };
    }
    const worker = new EngineeringRemediationWorker({
      executionRepositories: [CONSOLE_REPOSITORY], store, sessions: {}, authorizer: authorizer(),
      sources: sourceAdapter(scope), sandbox: sandboxAdapter(request), tests: testAdapter(request),
      builder: builderAdapter(request, scope, artifactRootRef), deployer: deployerAdapter(request, scope, artifactRootRef),
      verifier: verifierAdapter(request, scope), sandboxRoot: sandboxBase,
    });
    if (request.stage === 'approved') {
      const built = await worker.build(request, request.patchArtifact);
      if (built.status !== 'deploying') return built;
      return worker.deploy({ ...request, stage: 'deploying' }, built.build);
    }
    if (request.stage === 'deploying' && item.build) return worker.deploy(request, item.build);
    throw new Error(`unsupported claimed stage: ${request.stage}`);
  } finally {
    activeClaims.delete(request.remediationRequestId); claimStages.delete(request.remediationRequestId);
    if (artifactRootRef.value) await fs.rm(artifactRootRef.value, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  await validateHost();
  const registerTimer = setInterval(() => validateHost().catch((error) => process.stderr.write(`${error.message}\n`)), 20_000);
  registerTimer.unref();
  let consecutiveFailures = 0;
  try {
    do {
      try {
        const claimed = await api('/api/osaa/remediations/local-edge-runner/claim', { runnerId, claimEpoch, limit: 1 });
        if (claimed.items?.length) {
          for (const item of claimed.items) await processClaim(item);
        } else if (!once) await delay(5000);
        consecutiveFailures = 0;
      } catch (error) {
        if (once) throw error;
        consecutiveFailures += 1;
        const retryInMs = retryDelayMs(consecutiveFailures);
        process.stderr.write(`RepairRunnerRetry ${error.code || 'TransientFailure'}: ${error.message}; retryInMs=${retryInMs}\n`);
        await delay(retryInMs);
      }
    } while (!once);
  } finally { clearInterval(registerTimer); tokenState.value = ''; }
}

main().catch((error) => {
  process.stderr.write(`${error.code || 'RepairRunnerFailed'}: ${error.message}\n`);
  process.exitCode = 1;
});
