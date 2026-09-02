'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const root = join(__dirname, '..', '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

test('C_NOTIFY and C_BAK manifests use canonical release artifacts and C_API-only ingress', () => {
  const notificationManifest = read('apps', 'notification-dispatcher', 'deploy.yaml');
  const notificationDockerfile = read('apps', 'notification-dispatcher', 'Dockerfile');
  const recoveryManifest = read('apps', 'recovery-owner', 'external-channel-service.yaml');
  const recoveryDockerfile = read('apps', 'recovery-owner', 'Dockerfile');
  const matrix = read('scripts', 'release-artifact-matrix.test.mjs');
  const publisher = read('scripts', 'Publish-LocalEdge.ps1');

  assert.equal((notificationManifest.match(/__OPENSPHERE_NOTIFICATION_DISPATCHER_IMAGE__/g) || []).length, 1);
  assert.doesNotMatch(notificationManifest, /opensphere-console-notification-dispatcher@sha256:/u);
  assert.match(notificationDockerfile, /COPY contract[.]js browser-api[.]js owner-admission[.]js owner-policy[.]js server[.]js/u);
  assert.match(matrix, /\['notificationDispatcher', 'opensphere-console-notification-dispatcher', 'apps\/notification-dispatcher\/Dockerfile'\]/u);
  assert.match(publisher, /Key = 'notificationDispatcher'; Image = 'opensphere-console-notification-dispatcher'/u);

  assert.equal((recoveryManifest.match(/__OPENSPHERE_RECOVERY_IMAGE__/g) || []).length, 1);
  assert.match(recoveryDockerfile, /COPY external-channel-api[.]js external-channel-server[.]js owner-admission[.]js owner-policy[.]js/u);
  assert.match(matrix, /\['recovery', 'opensphere-console-recovery', 'apps\/recovery-owner\/Dockerfile'\]/u);
  assert.match(publisher, /Key = 'recovery'; Image = 'opensphere-console-recovery'/u);

  for (const manifest of [notificationManifest, recoveryManifest]) {
    assert.match(manifest, /app[.]kubernetes[.]io\/name: opensphere-console-api/u);
    assert.doesNotMatch(manifest, /matchLabels: \{ app: opensphere-console \}/u);
  }
});
