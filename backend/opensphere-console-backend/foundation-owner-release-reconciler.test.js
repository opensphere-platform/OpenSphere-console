'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

process.env.EXECUTOR_IMAGE = `ghcr.io/opensphere-platform/opensphere-console-backend@sha256:${'a'.repeat(64)}`;
process.env.GITEA_TOKEN = 'test-token';
process.env.RECONCILER_TOKEN = 'test-reconciler';

const { executorJob, sameExecutorJob, validateGovernedManifest } = require('./foundation-owner-release-reconciler');

const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const work = { request_id: requestId, git_commit_sha: 'b'.repeat(40), git_repo: 'opensphere/platform-declarations',
  action: 'gitea:apply', target: 'foundation-oaa-owner', reason: 'Publish exact Foundation owner release', attempt: 1 };
const desired = {
  contract: 'opensphere.foundation.owner.release/v1', action: 'Apply', operationId: requestId,
  reason: work.reason,
  expectedCurrent: { image: `ghcr.io/opensphere-platform/opensphere-shell-foundation@sha256:${'1'.repeat(64)}`,
    sourceRevision: '2'.repeat(40) },
  publicationDocumentBase64: Buffer.from('{}').toString('base64'),
  publicationSignature: {},
};
const manifest = { apiVersion: 'platform.opensphere.io/v1alpha1', kind: 'GovernedChange',
  metadata: { requestId, consumerId: 'foundation-owner-release' },
  spec: { action: 'apply', target: work.target, reason: work.reason, desiredState: desired } };

test('reviewed Foundation owner declaration creates one closed exact executor Job', () => {
  assert.equal(validateGovernedManifest(manifest, work), manifest);
  const job = executorJob(work, manifest);
  assert.equal(job.spec.template.spec.serviceAccountName, 'foundation-owner-release-executor');
  assert.equal(job.spec.template.spec.containers.length, 1);
  assert.equal(job.spec.template.spec.containers[0].command[1],
    '/app/opensphere-console-backend/foundation-owner-release-executor.mjs');
  assert.match(job.spec.template.spec.containers[0].image, /@sha256:[a-f0-9]{64}$/);
  assert.ok(job.metadata.name.length <= 63);
  assert.match(job.metadata.name, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  const maxAttempt = executorJob({ ...work, attempt: 9999 }, manifest);
  assert.ok(maxAttempt.metadata.name.length <= 63);
  assert.match(maxAttempt.metadata.name, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  assert.equal(maxAttempt.metadata.labels['opensphere.io/request-id'], requestId);
  assert.match(job.metadata.annotations['opensphere.io/executor-template-sha256'], /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => validateGovernedManifest({ ...manifest,
    metadata: { ...manifest.metadata, consumerId: 'platform-release' } }, work), /claim mismatch/);
});

test('response-loss retry accepts only the same defaulted executor Job identity and template digest', () => {
  const intended = executorJob(work, manifest);
  const observed = structuredClone(intended);
  observed.spec.selector = { matchLabels: { 'controller-uid': 'server-default' } };
  observed.spec.parallelism = 1;
  observed.spec.completions = 1;
  observed.spec.completionMode = 'NonIndexed';
  observed.spec.manualSelector = false;
  observed.spec.suspend = false;
  observed.spec.podReplacementPolicy = 'TerminatingOrFailed';
  observed.spec.template.metadata.labels['controller-uid'] = 'server-default';
  observed.spec.template.metadata.labels['batch.kubernetes.io/controller-uid'] = 'server-default';
  observed.spec.template.metadata.labels['job-name'] = observed.metadata.name;
  observed.spec.template.metadata.labels['batch.kubernetes.io/job-name'] = observed.metadata.name;
  observed.spec.template.spec.serviceAccount = observed.spec.template.spec.serviceAccountName;
  observed.spec.template.spec.schedulerName = 'default-scheduler';
  observed.spec.template.spec.dnsPolicy = 'ClusterFirst';
  observed.spec.template.spec.terminationGracePeriodSeconds = 30;
  observed.spec.template.spec.containers[0].terminationMessagePath = '/dev/termination-log';
  observed.spec.template.spec.containers[0].terminationMessagePolicy = 'File';
  assert.equal(sameExecutorJob(observed, intended), true);
  const wrongDigest = structuredClone(observed);
  wrongDigest.metadata.annotations['opensphere.io/executor-template-sha256'] = `sha256:${'0'.repeat(64)}`;
  assert.equal(sameExecutorJob(wrongDigest, intended), false);
  const wrongImage = structuredClone(observed);
  wrongImage.spec.template.spec.containers[0].image = `ghcr.io/opensphere-platform/opensphere-console-backend@sha256:${'c'.repeat(64)}`;
  assert.equal(sameExecutorJob(wrongImage, intended), false);
  const copiedAnnotation = structuredClone(observed);
  copiedAnnotation.spec.template.spec.containers[0].command = ['node', '/tmp/attacker.mjs'];
  assert.equal(sameExecutorJob(copiedAnnotation, intended), false);
  const changedCommit = structuredClone(observed);
  changedCommit.spec.template.spec.containers[0].env.find((entry) => entry.name === 'GIT_COMMIT_SHA').value = 'd'.repeat(40);
  assert.equal(sameExecutorJob(changedCommit, intended), false);
  const addedVolume = structuredClone(observed);
  addedVolume.spec.template.spec.volumes.push({ name: 'attacker', emptyDir: {} });
  assert.equal(sameExecutorJob(addedVolume, intended), false);
});

test('executor source uses installation-lock CAS, exact merge input and durable receipt', () => {
  const source = fs.readFileSync(path.join(__dirname, 'foundation-owner-release-executor.mjs'), 'utf8');
  assert.match(source, /foundation-owner-installation-lock/);
  assert.match(source, /phase: 'Applying'/);
  assert.match(source, /phase: 'Completed'/);
  assert.match(source, /mergeRevision: GIT_COMMIT_SHA/);
  assert.match(source, /api\/platform\/reconcile\/receipt/);
  assert.doesNotMatch(source, /kubectl|child_process|execSync/);
});
