const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  releaseRevision,
  deploymentManifest,
  serviceManifest,
  hpaManifest,
  publishedPluginEntry,
  proxyIdsForPlugin,
} = require('./controller');

function pluginPackage({
  name = 'ai-workbench',
  image = `sha256:${'a'.repeat(64)}`,
  manifest = 'b'.repeat(64),
} = {}) {
  return {
    apiVersion: 'plugins.opensphere.io/v1alpha1',
    kind: 'UIPluginPackage',
    metadata: { name, uid: '00000000-0000-0000-0000-000000000001' },
    spec: {
      displayName: 'AI Workbench',
      kind: 'subShell',
      hostRef: 'main',
      hostCompat: '>=1.0.0 <2.0.0',
      image: { repository: 'ghcr.io/opensphere-platform/opensphere-shell-ai-workbench', digest: image },
      manifest: { sha256: manifest, signaturePath: '/plugins/ui-shell.manifest.json.sig' },
      trust: { keyId: 'opensphere-edge-local-v1' },
      contributions: { observability: { enabled: false } },
      runtime: { port: 8080, availability: { replicas: 2 } },
      resolution: { artifactVersion: '202608171027', revision: 'c'.repeat(40) },
    },
  };
}

test('a plugin release receives a deterministic bounded immutable revision identity', () => {
  const pkg = pluginPackage();
  const first = releaseRevision(pkg);
  const second = releaseRevision(structuredClone(pkg));
  assert.deepEqual(first, second);
  assert.match(first.token, /^[a-f0-9]{20}$/);
  assert.match(first.resourceName, /^ai-workbench-r-[a-f0-9]{20}$/);
  assert.ok(first.resourceName.length <= 63);
  assert.deepEqual(first.selector, {
    app: 'ai-workbench',
    'opensphere.io/dupa-revision': first.token,
  });

  const changed = releaseRevision(pluginPackage({ image: `sha256:${'d'.repeat(64)}` }));
  assert.notEqual(changed.token, first.token);
  assert.notEqual(changed.resourceName, first.resourceName);
});

test('staged Deployment and artifact Service select one exact release while the stable Service is only a pointer', () => {
  const pkg = pluginPackage();
  const revision = releaseRevision(pkg);
  const deployment = deploymentManifest(pkg, revision);
  const artifactService = serviceManifest(pkg, revision, { stable: false });
  const activeService = serviceManifest(pkg, revision, { stable: true });

  assert.equal(deployment.metadata.name, revision.deploymentName);
  assert.deepEqual(deployment.spec.selector.matchLabels, revision.selector);
  assert.deepEqual(deployment.spec.template.metadata.labels, revision.selector);
  assert.equal(deployment.spec.template.spec.containers[0].image,
    `${pkg.spec.image.repository}@${pkg.spec.image.digest}`);
  assert.equal(artifactService.metadata.name, revision.serviceName);
  assert.equal(activeService.metadata.name, pkg.metadata.name);
  assert.deepEqual(artifactService.spec.selector, revision.selector);
  assert.deepEqual(activeService.spec.selector, revision.selector);
  assert.equal(deployment.metadata.annotations['opensphere.io/release-image-digest'], pkg.spec.image.digest);
  assert.equal(activeService.metadata.annotations['opensphere.io/release-manifest-sha256'], pkg.spec.manifest.sha256);
});

test('autoscaling and Registry artifact URLs bind to the staged revision, retaining only one rollback artifact service', () => {
  const pkg = pluginPackage();
  const revision = releaseRevision(pkg);
  pkg.spec.runtime.availability.autoscaling = { enabled: true, minReplicas: 2, maxReplicas: 4 };
  assert.equal(hpaManifest(pkg, revision).spec.scaleTargetRef.name, revision.deploymentName);

  const previous = 'ai-workbench-r-' + 'd'.repeat(20);
  const manifestUrl = `/api/plugins/${revision.serviceName}/plugins/ui-shell.manifest.json`;
  const entry = publishedPluginEntry(pkg, manifestUrl, `${manifestUrl}.sig`, {}, {}, {
    artifactServiceId: revision.serviceName,
    releaseRevision: revision.token,
    retainedArtifactServiceIds: [previous, previous, revision.serviceName],
  });
  assert.equal(entry.manifest, manifestUrl);
  assert.equal(entry.artifactServiceId, revision.serviceName);
  assert.deepEqual(entry.retainedArtifactServiceIds, [previous]);
  assert.deepEqual(proxyIdsForPlugin(entry), ['ai-workbench', revision.serviceName, previous]);
});

test('reconcile verifies the immutable revision before the stable pointer and Registry move', () => {
  const source = fs.readFileSync(path.join(__dirname, 'controller.js'), 'utf8');
  const reconcileStart = source.indexOf('async function reconcile()');
  const staged = source.indexOf('const revision = await applyWorkload(pkg)', reconcileStart);
  const verified = source.indexOf('const v = await verifyPlugin(pkg, revision.serviceName)', staged);
  const cutover = source.indexOf('await activateWorkloadRevision(pkg, revision)', verified);
  const published = source.indexOf('published.push(publishedPluginEntry', cutover);
  const persisted = source.indexOf('const snapshot = await extensionProjection.persist', published);
  const reclaimed = source.indexOf('await garbageCollectWorkloadRevisions', persisted);
  assert.ok(staged > reconcileStart);
  assert.ok(verified > staged);
  assert.ok(cutover > verified);
  assert.ok(published > cutover);
  assert.ok(persisted > published);
  assert.ok(reclaimed > persisted);
});

test('edge publisher supports an exact affected-component subset and stays separate from the integrated publisher', () => {
  const publisher = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'Publish-LocalEdgeAtomicExtensions.ps1'), 'utf8');
  assert.match(publisher, /\[ValidateSet\('console', 'dupaController'\)\]/);
  assert.match(publisher, /\$componentNames = @\(\$Components \| Sort-Object -Unique\)/);
  assert.match(publisher, /if \(\$componentNames -contains 'console'\)/);
  assert.match(publisher, /if \(\$componentNames -contains 'dupaController'\)/);
  assert.match(publisher, /affectedImages = @\(\$componentNames \| ForEach-Object \{ \$repositories\[\$_\] \}\)/);
  assert.doesNotMatch(publisher, /\$components\s*=\s*\[ordered\]@\{/i);
  assert.match(publisher, /\$publicationComponents\s*=\s*\[ordered\]@\{/);
  assert.match(publisher, /releaseScope = 'component'/);
  assert.match(publisher, /fullReleaseJustification = \$null/);
  assert.doesNotMatch(publisher, /Publish-LocalEdge\.ps1|Read-Host|PromptForChoice|MessageBox/);
});

test('edge publisher builds every selected component before moving channel pointers', () => {
  const publisher = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'Publish-LocalEdgeAtomicExtensions.ps1'), 'utf8');
  assert.match(publisher, /Console main must equal fresh origin\/main/);
  assert.match(publisher, /Installed release source is not the canonical Console repository/);
  assert.match(publisher, /fetch --no-tags origin \$baseRevision/);
  assert.match(publisher, /cat-file -e "\$\{baseRevision\}\^\{commit\}"/);
  assert.match(publisher, /diff --name-only \$baseRevision \$sourceRevision/);
  assert.doesNotMatch(publisher, /merge-base --is-ancestor/);
  assert.match(publisher, /worktree add --detach/);
  const controllerDigest = publisher.indexOf('$digests.dupaController =');
  const firstTagMove = publisher.indexOf('Set-RemoteTag -Repository', controllerDigest);
  assert.ok(controllerDigest > 0);
  assert.ok(firstTagMove > controllerDigest);
  assert.match(publisher, /allAffectedImagesBuiltBeforeChannelMove = \$true/);
});
