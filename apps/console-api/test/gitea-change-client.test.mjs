import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createGiteaChangeClient } from '../src/gitea-change-client.mjs';
import {
  ARGOCD_VERIFICATION_PATH,
  argocdVerificationDeclaration,
} from '../src/argocd-verification-contract.mjs';

const operationId = '33333333-3333-4333-8333-333333333333';
const desiredRevision = 'a'.repeat(40);
const mergeRevision = 'b'.repeat(40);

async function withGitea(run, {
  protectedBranch = true, privateRepository = true, omitDesiredRevision = false, argocdState = 'missing', tamperDeclaration = false, extraFile = false, changedHead = false,
} = {}) {
  const calls = [];
  let branchExists = false;
  let pullExists = false;
  let merged = false;
  let declarationContent;
  let declarationPath;
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
    if (request.url === '/api/v1/repos/opensphere/platform-declarations') {
      return send(200, {
        name: 'platform-declarations', full_name: 'opensphere/platform-declarations',
        private: privateRepository, archived: false, empty: false, default_branch: 'main',
        updated_at: '2026-09-02T00:00:00.000Z', size: 42,
      });
    }
    if (request.url === '/api/v1/repos/opensphere/platform-declarations/branch_protections') {
      return send(200, protectedBranch ? [{
        branch_name: 'main', required_approvals: 1, enable_push: false,
        require_signed_commits: true, block_on_rejected_reviews: true,
      }] : []);
    }
    if (request.url === '/api/v1/repos/opensphere/platform-declarations/branches/main') {
      return send(200, { name: 'main', commit: { id: 'c'.repeat(40) } });
    }
    const fixedPath = `/api/v1/repos/opensphere/platform-declarations/contents/${ARGOCD_VERIFICATION_PATH}?ref=main`;
    if (request.method === 'GET' && request.url === fixedPath) {
      if (argocdState === 'missing') return send(404, { message: 'not found' });
      const value = argocdState === 'ready' ? argocdVerificationDeclaration() : { drifted: true };
      return send(200, { sha: 'd'.repeat(40), content: Buffer.from(`${JSON.stringify(value)}\n`).toString('base64') });
    }
    if (request.url === `/api/v1/repos/opensphere/platform-declarations/branches/control%2F${operationId}`) {
      return branchExists ? send(200, {
        name: `control/${operationId}`, commit: { id: omitDesiredRevision ? null : desiredRevision },
      }) : send(404, { message: 'not found' });
    }
    if (request.url?.startsWith('/api/v1/repos/opensphere/platform-declarations/pulls?')) {
      return send(200, pullExists ? [{
        number: 17, html_url: 'https://gitea.example/pulls/17',
        head: { ref: `control/${operationId}`, label: `opensphere:control/${operationId}` },
        base: { ref: 'main' }, state: merged ? 'closed' : 'open', merged, merge_commit_sha: merged ? mergeRevision : null,
      }] : []);
    }
    if (['POST', 'PUT'].includes(request.method) && request.url?.includes('/contents/')) {
      branchExists = true;
      declarationContent = body.content;
      declarationPath = request.url.split('/contents/')[1];
      return send(201, { commit: { sha: omitDesiredRevision ? null : desiredRevision } });
    }
    if (request.method === 'GET' && request.url?.includes('/contents/') && declarationContent) {
      return send(200, { content: tamperDeclaration ? Buffer.from('{"tampered":true}').toString('base64') : declarationContent });
    }
    if (request.method === 'GET' && request.url?.includes('/pulls/17/files?')) {
      return send(200, [{ filename: declarationPath, status: 'added' }, ...(extraFile ? [{ filename: 'unapproved.json', status: 'added' }] : [])]);
    }
    if (request.method === 'POST' && request.url === '/api/v1/repos/opensphere/platform-declarations/pulls') {
      pullExists = true;
      return send(201, { number: 17, html_url: 'https://gitea.example/pulls/17' });
    }
    if (request.method === 'GET' && request.url === '/api/v1/repos/opensphere/platform-declarations/pulls/17') {
      return send(200, {
        number: 17, head: { ref: `control/${operationId}`, sha: changedHead ? 'c'.repeat(40) : desiredRevision }, base: { ref: 'main' },
        state: merged ? 'closed' : 'open', merged, merge_commit_sha: merged ? mergeRevision : null,
      });
    }
    if (request.method === 'POST' && request.url === '/api/v1/repos/opensphere/platform-declarations/pulls/17/reviews') {
      return send(201, { id: 31 });
    }
    if (request.method === 'POST' && request.url === '/api/v1/repos/opensphere/platform-declarations/pulls/17/merge') {
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

test('Gitea proposal rejects a missing desired revision after an ambiguous mutation', async () => {
  await withGitea(async ({ client }) => {
    await assert.rejects(client.ensureProposal({
      operationId,
      consumerId: 'opensphere-console',
      action: 'configure',
      target: 'console/settings',
      reason: 'apply reviewed settings declaration',
      desiredState: { replicas: 2 },
      submittedAt: '2026-09-02T00:00:00.000Z',
    }), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'unknown' });
  }, { omitDesiredRevision: true });
});

test('Gitea status binds the fixed repository identity and safe metadata', async () => {
  await withGitea(async ({ client }) => {
    const status = await client.supplyChainStatus();
    assert.equal(status.ready, true);
    assert.equal(status.repository, 'opensphere/platform-declarations');
    assert.deepEqual(status.repositoryMetadata, {
      name: 'platform-declarations', private: true, archived: false, empty: false,
      defaultBranch: 'main', updatedAt: '2026-09-02T00:00:00.000Z', sizeKiB: 42,
    });
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

test('Gitea public declaration repository is observable but never ready for governed mutation', async () => {
  await withGitea(async ({ client, calls }) => {
    const status = await client.supplyChainStatus();
    assert.equal(status.ready, false);
    assert.equal(status.repositoryMetadata.private, false);
    await assert.rejects(client.ensureProposal(proposalInput()), {
      code: 'AuthorityUnavailable', status: 503, sideEffect: 'none',
    });
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  }, { privateRepository: false });
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
    if (path === '/api/v1/repos/opensphere/platform-declarations') {
      return new Response(JSON.stringify({
        name: 'platform-declarations', full_name: 'opensphere/platform-declarations',
        private: true, archived: false, empty: false, default_branch: 'main',
        updated_at: '2026-09-02T00:00:00.000Z', size: 42,
      }));
    }
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

test('Fixed Argo CD verification inspection recognizes the exact declaration on main without mutation', async () => {
  await withGitea(async ({ client, calls }) => {
    const status = await client.argocdVerificationStatus();
    assert.deepEqual(status, {
      ready: true,
      path: ARGOCD_VERIFICATION_PATH,
      mainRevision: 'c'.repeat(40),
      sourceSha: 'd'.repeat(40),
    });
    assert.equal(calls.filter((call) => ['POST', 'PUT'].includes(call.method)).length, 0);
  }, { argocdState: 'ready' });
});

test('Fixed Argo CD verification proposal replaces drift only through an operation-bound branch', async () => {
  await withGitea(async ({ client, calls }) => {
    const status = await client.argocdVerificationStatus();
    assert.equal(status.ready, false);
    const proposal = await client.ensureArgocdVerificationProposal({
      operationId,
      reason: 'restore the fixed Argo CD verification declaration',
      sourceSha: status.sourceSha,
    });
    assert.equal(proposal.filePath, ARGOCD_VERIFICATION_PATH);
    assert.equal(proposal.branch, `control/${operationId}`);
    const write = calls.find((call) => call.method === 'PUT' && call.url?.includes('/contents/'));
    assert.ok(write);
    assert.equal(write.body.branch, 'main');
    assert.equal(write.body.new_branch, `control/${operationId}`);
    assert.equal(write.body.sha, 'd'.repeat(40));
    assert.deepEqual(
      JSON.parse(Buffer.from(write.body.content, 'base64').toString('utf8')),
      argocdVerificationDeclaration(),
    );
  }, { argocdState: 'drifted' });
});

test('Fixed Argo CD verification bootstrap refuses a configurable repository substitution', async () => {
  const client = createGiteaChangeClient({
    baseUrl: 'https://gitea.example',
    controlToken: 'control',
    reviewToken: 'review',
    repository: 'operator-selected',
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  await assert.rejects(client.argocdVerificationStatus(), {
    code: 'AuthorityUnavailable', status: 503, sideEffect: 'none',
  });
});

test('native module merge binds reviewed head, sole changed file and canonical declaration at head and merge', async () => {
  await withGitea(async ({client,calls}) => {
    const declaration=proposalInput(); await client.ensureProposal(declaration);
    const result=await client.approveAndMerge({operationId,branch:`control/${operationId}`,pullNumber:17,
      approverRef:'55555555-5555-4555-8555-555555555555',reason:'Independent exact module approval',expectedRevision:desiredRevision,declaration});
    assert.equal(result.mergeRevision,mergeRevision);
    const merge=calls.find(x=>x.url.endsWith('/merge'));
    assert.equal(merge.body.head_commit_id,desiredRevision);
    assert.ok(calls.some(x=>x.url.includes('ref='+mergeRevision)));
  });
});
for(const [name,options,code] of [['changed head',{changedHead:true},'StaleRevision'],['extra file',{extraFile:true},'ClaimBindingMismatch'],['tampered declaration',{tamperDeclaration:true},'ClaimBindingMismatch']]) {
  test('native module merge rejects '+name+' before any review/merge write',async()=>{
    await withGitea(async ({client,calls})=>{
      const declaration=proposalInput();await client.ensureProposal(declaration);
      await assert.rejects(client.approveAndMerge({operationId,branch:`control/${operationId}`,pullNumber:17,
        approverRef:'55555555-5555-4555-8555-555555555555',reason:'Independent exact module approval',expectedRevision:desiredRevision,declaration}),{code});
      assert.equal(calls.filter(x=>x.url.endsWith('/reviews')||x.url.endsWith('/merge')).length,0);
    },options);
  });
}
