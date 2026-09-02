import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createGiteaChangeClient } from '../src/gitea-change-client.mjs';

const operationId = '33333333-3333-4333-8333-333333333333';
const desiredRevision = 'a'.repeat(40);
const mergeRevision = 'b'.repeat(40);

async function withGitea(run, { protectedBranch = true } = {}) {
  const calls = [];
  let branchExists = false;
  let pullExists = false;
  let merged = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    const send = (status, value) => {
      const payload = value == null ? '' : JSON.stringify(value);
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
    };
    if (request.url === '/api/v1/version') return send(200, { version: '1.24.0' });
    if (request.url === '/api/v1/repos/opensphere-platform/platform-declarations/branch_protections') {
      return send(200, protectedBranch ? [{
        branch_name: 'main', required_approvals: 1, enable_push: false,
        require_signed_commits: true, block_on_rejected_reviews: true,
      }] : []);
    }
    if (request.url === `/api/v1/repos/opensphere-platform/platform-declarations/branches/control%2F${operationId}`) {
      return branchExists ? send(200, { name: `control/${operationId}`, commit: { id: desiredRevision } }) : send(404, { message: 'not found' });
    }
    if (request.url?.startsWith('/api/v1/repos/opensphere-platform/platform-declarations/pulls?')) {
      return send(200, pullExists ? [{
        number: 17, html_url: 'https://gitea.example/pulls/17',
        head: { ref: `control/${operationId}`, label: `opensphere-platform:control/${operationId}` },
        base: { ref: 'main' }, state: merged ? 'closed' : 'open', merged, merge_commit_sha: merged ? mergeRevision : null,
      }] : []);
    }
    if (request.method === 'POST' && request.url?.includes('/contents/')) {
      branchExists = true;
      return send(201, { commit: { sha: desiredRevision } });
    }
    if (request.method === 'POST' && request.url === '/api/v1/repos/opensphere-platform/platform-declarations/pulls') {
      pullExists = true;
      return send(201, { number: 17, html_url: 'https://gitea.example/pulls/17' });
    }
    if (request.method === 'GET' && request.url === '/api/v1/repos/opensphere-platform/platform-declarations/pulls/17') {
      return send(200, {
        number: 17, head: { ref: `control/${operationId}` }, base: { ref: 'main' },
        state: merged ? 'closed' : 'open', merged, merge_commit_sha: merged ? mergeRevision : null,
      });
    }
    if (request.method === 'POST' && request.url === '/api/v1/repos/opensphere-platform/platform-declarations/pulls/17/reviews') {
      return send(201, { id: 31 });
    }
    if (request.method === 'POST' && request.url === '/api/v1/repos/opensphere-platform/platform-declarations/pulls/17/merge') {
      merged = true;
      return send(200, { merged: true });
    }
    return send(404, { message: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const client = createGiteaChangeClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    controlToken: 'control-token-secret',
    reviewToken: 'review-token-secret',
    timeoutMs: 1000,
  });
  try {
    return await run({ client, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function proposalInput() {
  return {
    operationId,
    consumerId: 'opensphere-console',
    action: 'configure',
    target: 'console/settings',
    reason: 'apply the reviewed Console settings declaration',
    desiredState: { replicas: 2 },
    submittedAt: '2026-09-02T00:00:00.000Z',
  };
}

test('Gitea proposal checks branch policy before mutation and resumes without duplicate branch or pull request', async () => {
  await withGitea(async ({ client, calls }) => {
    const first = await client.ensureProposal(proposalInput());
    assert.equal(first.pullRequest.number, 17);
    assert.equal(first.desiredRevision, desiredRevision);
    assert.equal(first.replayed, false);
    const mutationStart = calls.findIndex((call) => call.method === 'POST');
    assert.ok(mutationStart > 1);
    assert.ok(calls.slice(0, mutationStart).some((call) => call.url === '/api/v1/version'));
    assert.ok(calls.slice(0, mutationStart).some((call) => call.url?.endsWith('/branch_protections')));

    const mutationCount = calls.filter((call) => call.method === 'POST').length;
    const replay = await client.ensureProposal(proposalInput());
    assert.equal(replay.replayed, true);
    assert.equal(replay.pullRequest.number, 17);
    assert.equal(calls.filter((call) => call.method === 'POST').length, mutationCount);
    assert.doesNotMatch(JSON.stringify(first), /control-token-secret|review-token-secret/u);
  });
});

test('Gitea proposal performs no mutation when the protected branch policy is insufficient', async () => {
  await withGitea(async ({ client, calls }) => {
    await assert.rejects(client.ensureProposal(proposalInput()), {
      code: 'AuthorityUnavailable', status: 503, sideEffect: 'none',
    });
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  }, { protectedBranch: false });
});

test('Gitea approval uses the distinct review credential and observes the merged revision', async () => {
  await withGitea(async ({ client, calls }) => {
    const proposal = await client.ensureProposal(proposalInput());
    const merged = await client.approveAndMerge({
      operationId,
      branch: proposal.branch,
      pullNumber: proposal.pullRequest.number,
      approverRef: '44444444-4444-4444-8444-444444444444',
      reason: 'approve the reviewed declaration and protected merge',
    });
    assert.equal(merged.mergeRevision, mergeRevision);
    const review = calls.find((call) => call.url?.endsWith('/reviews'));
    const merge = calls.find((call) => call.url?.endsWith('/merge'));
    assert.equal(review.authorization, 'token review-token-secret');
    assert.equal(merge.authorization, 'token control-token-secret');

    const reviewCount = calls.filter((call) => call.url?.endsWith('/reviews')).length;
    const mergeCount = calls.filter((call) => call.url?.endsWith('/merge')).length;
    const replay = await client.approveAndMerge({
      operationId,
      branch: proposal.branch,
      pullNumber: proposal.pullRequest.number,
      approverRef: '44444444-4444-4444-8444-444444444444',
      reason: 'resume the already approved protected merge',
    });
    assert.equal(replay.mergeRevision, mergeRevision);
    assert.equal(calls.filter((call) => call.url?.endsWith('/reviews')).length, reviewCount);
    assert.equal(calls.filter((call) => call.url?.endsWith('/merge')).length, mergeCount);
  });
});

test('Gitea mutation transport failure is reported as an ambiguous side effect', async () => {
  const fetchImpl = async (_url, options) => {
    if (options.method === 'POST') {
      const error = new Error('connection reset');
      error.name = 'TypeError';
      throw error;
    }
    const path = new URL(_url).pathname;
    if (path === '/api/v1/version') return new Response(JSON.stringify({ version: '1.24.0' }));
    if (path.endsWith('/branch_protections')) return new Response(JSON.stringify([{
      branch_name: 'main', required_approvals: 1, enable_push: false,
      require_signed_commits: true, block_on_rejected_reviews: true,
    }]));
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
  const client = createGiteaChangeClient({
    baseUrl: 'https://gitea.example', controlToken: 'control', reviewToken: 'review', fetchImpl,
  });
  await assert.rejects(client.ensureProposal(proposalInput()), {
    code: 'AuthorityUnavailable', status: 503, sideEffect: 'unknown',
  });
});

test('Gitea change management is disabled when control and review credentials are identical', async () => {
  const client = createGiteaChangeClient({
    baseUrl: 'https://gitea.example', controlToken: 'same-token', reviewToken: 'same-token',
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  const status = await client.supplyChainStatus();
  assert.equal(status.configured, false);
  assert.equal(status.ready, false);
  assert.match(status.reason, /distinct/u);
});
