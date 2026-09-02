const SHA = /^[0-9a-f]{40,64}$/u;

function failure(code, message, status, sideEffect = 'none', details = {}) {
  return Object.assign(new Error(message), { code, status, sideEffect, details });
}

function boundedText(value, name, minimum, maximum) {
  const normalized = String(value ?? '').trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\r\n]/u.test(normalized)) {
    throw failure('ValidationFailed', `${name} must contain ${minimum}..${maximum} characters`, 400);
  }
  return normalized;
}

function segment(value, name) {
  const normalized = boundedText(value, name, 1, 128);
  if (!/^[A-Za-z0-9._-]+$/u.test(normalized)) {
    throw failure('ValidationFailed', `${name} contains invalid characters`, 400);
  }
  return normalized;
}

function encodedPath(value) {
  return value.split('/').map(encodeURIComponent).join('/');
}

async function responseBody(response, maximumResponseBytes) {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maximumResponseBytes) {
    throw failure('AuthorityUnavailable', 'Gitea response exceeds the configured limit', 503, 'none');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumResponseBytes) {
    throw failure('AuthorityUnavailable', 'Gitea response exceeds the configured limit', 503, 'none');
  }
  if (!bytes.length) return null;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw failure('AuthorityUnavailable', 'Gitea returned an invalid JSON response', 503, 'none');
  }
}

export function createGiteaChangeClient({
  baseUrl,
  controlToken,
  reviewToken,
  organization = 'opensphere-platform',
  repository = 'platform-declarations',
  defaultBranch = 'main',
  timeoutMs = 5000,
  maximumResponseBytes = 262144,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const origin = String(baseUrl || '').replace(/\/+$/u, '');
  const organizationName = segment(organization, 'Gitea organization');
  const repositoryName = segment(repository, 'Gitea repository');
  const branchName = segment(defaultBranch, 'Gitea default branch');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    throw new TypeError('Gitea timeout must be an integer between 100 and 30000 milliseconds');
  }
  if (!Number.isInteger(maximumResponseBytes) || maximumResponseBytes < 1024 || maximumResponseBytes > 1048576) {
    throw new TypeError('Gitea response limit must be an integer between 1024 and 1048576 bytes');
  }

  function configured() {
    return Boolean(origin && controlToken && reviewToken && controlToken !== reviewToken);
  }

  async function request(path, { method = 'GET', body, token = controlToken, mutation = false } = {}) {
    if (!origin) throw failure('AuthorityUnavailable', 'Gitea URL is not configured', 503, 'none');
    const url = new URL(path, `${origin}/`);
    if (url.origin !== new URL(origin).origin) {
      throw failure('ValidationFailed', 'Gitea request escaped the configured origin', 400, 'none');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `token ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw failure(
        error?.name === 'AbortError' ? 'DependencyTimeout' : 'AuthorityUnavailable',
        error?.name === 'AbortError' ? 'Gitea request timed out' : 'Gitea request failed',
        503,
        mutation ? 'unknown' : 'none',
      );
    } finally {
      clearTimeout(timer);
    }
    const parsed = await responseBody(response, maximumResponseBytes);
    if (!response.ok) {
      const sideEffect = mutation && response.status >= 500 ? 'unknown' : 'none';
      throw failure(
        response.status === 404 ? 'NotFound' : (response.status === 409 ? 'StaleRevision' : 'AuthorityUnavailable'),
        `Gitea request failed with HTTP ${response.status}`,
        response.status === 404 ? 404 : (response.status === 409 ? 409 : 503),
        sideEffect,
        { giteaStatus: response.status },
      );
    }
    return Object.freeze({ body: parsed, headers: response.headers });
  }

  const repoPath = `/api/v1/repos/${encodeURIComponent(organizationName)}/${encodeURIComponent(repositoryName)}`;

  async function supplyChainStatus() {
    const checkedAt = new Date().toISOString();
    if (!configured()) {
      return Object.freeze({
        configured: false,
        ready: false,
        checkedAt,
        repository: `${organizationName}/${repositoryName}`,
        defaultBranch: branchName,
        reason: !origin ? 'Gitea URL is not configured'
          : (!controlToken || !reviewToken ? 'Gitea control and review credentials are required'
            : 'Gitea control and review credentials must be distinct'),
      });
    }
    try {
      const [version, protections] = await Promise.all([
        request('/api/v1/version'),
        request(`${repoPath}/branch_protections`),
      ]);
      const protection = (Array.isArray(protections.body) ? protections.body : [])
        .find((item) => item?.branch_name === branchName) || null;
      const gates = {
        protected: Boolean(protection),
        requiredApprovals: Number(protection?.required_approvals || 0),
        directPushEnabled: protection?.enable_push === true,
        signedCommitsRequired: protection?.require_signed_commits === true,
        blockRejectedReviews: protection?.block_on_rejected_reviews === true,
      };
      const ready = gates.protected && gates.requiredApprovals >= 1
        && !gates.directPushEnabled && gates.signedCommitsRequired && gates.blockRejectedReviews;
      return Object.freeze({
        configured: true,
        ready,
        checkedAt,
        version: String(version.body?.version || ''),
        repository: `${organizationName}/${repositoryName}`,
        defaultBranch: branchName,
        ...gates,
        reason: ready ? '' : 'Gitea branch protection does not satisfy the Console change policy',
      });
    } catch (error) {
      return Object.freeze({
        configured: true,
        ready: false,
        checkedAt,
        repository: `${organizationName}/${repositoryName}`,
        defaultBranch: branchName,
        reason: String(error?.message || 'Gitea status is unavailable').slice(0, 300),
      });
    }
  }

  async function requireReady() {
    const status = await supplyChainStatus();
    if (!status.ready) throw failure('AuthorityUnavailable', status.reason, 503, 'none', { status });
    return status;
  }

  async function findPull(branch) {
    const pulls = await request(`${repoPath}/pulls?state=all&head=${encodeURIComponent(`${organizationName}:${branch}`)}&base=${encodeURIComponent(branchName)}&limit=10`);
    return (Array.isArray(pulls.body) ? pulls.body : []).find((pull) => pull?.head?.ref === branch || pull?.head?.label === `${organizationName}:${branch}`) || null;
  }

  async function ensureProposal({ operationId, consumerId, action, target, reason, desiredState, submittedAt }) {
    await requireReady();
    const operation = boundedText(operationId, 'operationId', 36, 36);
    if (!/^[0-9a-f-]{36}$/u.test(operation)) throw failure('ValidationFailed', 'operationId must be a UUID', 400);
    const consumer = segment(consumerId, 'consumerId');
    const operationAction = boundedText(action, 'action', 3, 16).toLowerCase();
    if (!['apply', 'configure', 'delete', 'rollback'].includes(operationAction)) {
      throw failure('ValidationFailed', 'unsupported governed change action', 400);
    }
    const targetRef = boundedText(target, 'target', 1, 300);
    const changeReason = boundedText(reason, 'reason', 8, 500);
    if (!desiredState || typeof desiredState !== 'object' || Array.isArray(desiredState)) {
      throw failure('ValidationFailed', 'desiredState must be an object', 400);
    }
    const branch = `control/${operation}`;
    const filePath = `${consumer}/requests/${operation}.json`;
    let existingBranch = null;
    try {
      existingBranch = (await request(`${repoPath}/branches/${encodeURIComponent(branch)}`)).body;
    } catch (error) {
      if (error?.code !== 'NotFound') throw error;
    }
    let desiredRevision = String(existingBranch?.commit?.id || existingBranch?.commit?.sha || '').toLowerCase();
    if (!existingBranch) {
      const manifest = {
        apiVersion: 'platform.opensphere.io/v1alpha1',
        kind: 'GovernedChange',
        metadata: { operationId: operation, consumerId: consumer, submittedAt },
        spec: { action: operationAction, target: targetRef, reason: changeReason, desiredState },
      };
      const title = `[Console] ${consumer}: ${operationAction} ${targetRef}`.slice(0, 180);
      const created = await request(`${repoPath}/contents/${encodedPath(filePath)}`, {
        method: 'POST',
        mutation: true,
        body: {
          branch: branchName,
          new_branch: branch,
          message: `${title} (${operation})`,
          content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString('base64'),
        },
      });
      desiredRevision = String(created.body?.commit?.sha || '').toLowerCase();
    }
    let pull = await findPull(branch);
    if (!pull) {
      const title = `[Console] ${consumer}: ${operationAction} ${targetRef}`.slice(0, 180);
      pull = (await request(`${repoPath}/pulls`, {
        method: 'POST',
        mutation: true,
        body: { title, head: branch, base: branchName, body: `Console operation ${operation}.\n\nReason: ${changeReason}` },
      })).body;
    }
    const pullNumber = Number(pull?.number);
    if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) {
      throw failure('AuthorityUnavailable', 'Gitea did not return a pull request number', 503, 'unknown');
    }
    if (desiredRevision && !SHA.test(desiredRevision)) {
      throw failure('AuthorityUnavailable', 'Gitea returned an invalid desired revision', 503, 'unknown');
    }
    return Object.freeze({
      repository: `${organizationName}/${repositoryName}`,
      defaultBranch: branchName,
      branch,
      filePath,
      desiredRevision: desiredRevision || null,
      pullRequest: Object.freeze({ number: pullNumber, url: String(pull?.html_url || '') || null }),
      replayed: Boolean(existingBranch),
    });
  }

  async function approveAndMerge({ operationId, branch, pullNumber, approverRef, reason }) {
    await requireReady();
    const operation = boundedText(operationId, 'operationId', 36, 36);
    const changeBranch = boundedText(branch, 'branch', 1, 200);
    if (changeBranch !== `control/${operation}`) throw failure('ValidationFailed', 'branch is not bound to operationId', 400);
    const number = Number(pullNumber);
    if (!Number.isSafeInteger(number) || number < 1) throw failure('ValidationFailed', 'pullNumber is invalid', 400);
    const approver = boundedText(approverRef, 'approverRef', 36, 36);
    const approvalReason = boundedText(reason, 'reason', 8, 500);
    let pull = (await request(`${repoPath}/pulls/${number}`)).body;
    if (pull?.head?.ref !== changeBranch || pull?.base?.ref !== branchName) {
      throw failure('StaleRevision', 'pull request is outside the bound change branch', 409);
    }
    if (!(pull?.state === 'closed' && pull?.merged === true)) {
      await request(`${repoPath}/pulls/${number}/reviews`, {
        method: 'POST',
        token: reviewToken,
        mutation: true,
        body: { event: 'APPROVED', body: `Approved by Console operator ${approver}; operation ${operation}. Reason: ${approvalReason}` },
      });
      await request(`${repoPath}/pulls/${number}/merge`, {
        method: 'POST',
        mutation: true,
        body: { Do: 'merge', delete_branch_after_merge: false },
      });
      pull = (await request(`${repoPath}/pulls/${number}`)).body;
    }
    const mergeRevision = String(pull?.merge_commit_sha || '').toLowerCase();
    if (pull?.state !== 'closed' || pull?.merged !== true || !SHA.test(mergeRevision)) {
      throw failure('AuthorityUnavailable', 'Gitea merge is not durably observable', 503, 'unknown');
    }
    return Object.freeze({ merged: true, mergeRevision, pullNumber: number, branch: changeBranch });
  }

  return Object.freeze({
    configured,
    supplyChainStatus,
    ensureProposal,
    approveAndMerge,
    repository: `${organizationName}/${repositoryName}`,
    defaultBranch: branchName,
  });
}
