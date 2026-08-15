'use strict';

const { createHash } = require('node:crypto');
const {
  PLATFORM_RELEASE_RECONCILER,
  PLATFORM_RELEASE_TARGET,
} = require('./platform-release-contract');
const {
  FOUNDATION_OWNER_RELEASE_RECONCILER,
  FOUNDATION_OWNER_RELEASE_TARGET,
} = require('./foundation-owner-release');

const PROJECTION_CONTRACT = 'opensphere-platform-release-manifest-projection/v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_RE = /^[a-f0-9]{40,64}$/;
const AUTHORITIES = Object.freeze({
  [PLATFORM_RELEASE_RECONCILER]: Object.freeze({
    target: PLATFORM_RELEASE_TARGET,
    pathPrefix: 'platform-release',
  }),
  [FOUNDATION_OWNER_RELEASE_RECONCILER]: Object.freeze({
    target: FOUNDATION_OWNER_RELEASE_TARGET,
    pathPrefix: 'foundation-owner-release',
  }),
});

function closedRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join(',') !== 'reconciler,requestId'
    || !Object.hasOwn(AUTHORITIES, body.reconciler)
    || !UUID_RE.test(String(body.requestId || ''))) {
    throw new Error('internal manifest request is outside the closed release authority contract');
  }
  return { reconciler: body.reconciler, requestId: body.requestId };
}

async function projectReconcileManifest(body, {
  readChange,
  readConsumer,
  readGiteaFile,
} = {}) {
  const request = closedRequest(body);
  if (typeof readChange !== 'function' || typeof readConsumer !== 'function'
    || typeof readGiteaFile !== 'function') {
    throw new Error('internal manifest projection authority is unavailable');
  }
  const authority = AUTHORITIES[request.reconciler];
  const [change, consumer] = await Promise.all([
    readChange(request.requestId),
    readConsumer(request.reconciler),
  ]);
  if (!change || change.request_id !== request.requestId || change.target !== authority.target
    || !['committed', 'applied'].includes(String(change.status || ''))
    || !COMMIT_RE.test(String(change.git_commit_sha || ''))
    || change.git_repo !== 'opensphere/platform-declarations'
    || !consumer || consumer.reconciler !== request.reconciler
    || consumer.gitea_repository !== change.git_repo
    || consumer.gitea_path !== authority.pathPrefix) {
    throw new Error('internal manifest request is not bound to one reviewed release change');
  }
  const path = `${authority.pathPrefix}/requests/${request.requestId}.json`;
  const file = await readGiteaFile({
    repository: change.git_repo,
    path,
    revision: change.git_commit_sha,
  });
  const encoded = String(file?.content || '').replace(/\s/g, '');
  let content;
  try {
    content = Buffer.from(encoded, 'base64');
    if (!encoded || content.toString('base64') !== encoded) throw new Error('noncanonical');
    JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error('reviewed release manifest content is not canonical base64 JSON');
  }
  return {
    contract: PROJECTION_CONTRACT,
    requestId: request.requestId,
    reconciler: request.reconciler,
    gitRepo: change.git_repo,
    gitCommitSha: change.git_commit_sha,
    path,
    content: encoded,
    contentSha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
}

module.exports = {
  AUTHORITIES,
  PROJECTION_CONTRACT,
  closedRequest,
  projectReconcileManifest,
};
