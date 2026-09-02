import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..', '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

test('C_EXT target proxy and lifecycle are packaged without legacy runtime dependency', async () => {
  const [manifest, dockerfile, server, lifecycle, release, crds, matrix, publisher] = await Promise.all([
    read('apps/extension-controller/deploy.yaml'),
    read('apps/extension-controller/Dockerfile'),
    read('apps/extension-controller/src/server.mjs'),
    read('apps/extension-controller/src/kubernetes-extension-lifecycle.mjs'),
    read('apps/extension-controller/src/extension-release.mjs'),
    read('apps/extension-controller/crds/ui-plugin-crds.yaml'),
    read('scripts/release-artifact-matrix.test.mjs'),
    read('scripts/Publish-LocalEdge.ps1'),
  ]);
  assert.equal((manifest.match(/__OPENSPHERE_EXTENSION_CONTROLLER_IMAGE__/g) || []).length, 1);
  assert.match(manifest, /kind: Service[\s\S]*name: opensphere-extension-controller/u);
  assert.match(manifest, /app[.]kubernetes[.]io\/name: opensphere-console-api/u);
  assert.match(manifest, /NODE_EXTRA_CA_CERTS[\s\S]*serviceaccount\/ca[.]crt/u);
  assert.match(manifest, /CONSOLE_EXTENSION_LIFECYCLE_ENABLED[\s\S]*value: 'false'/u);
  assert.match(dockerfile, /COPY apps\/extension-controller\/src [.]\/src/u);
  assert.match(server, /createConsoleOwnerAdmission/u);
  assert.match(server, /createPluginProxy/u);
  assert.match(server, /createKubernetesExtensionLifecycle/u);
  assert.match(crds, /name: uipluginpackages[.]plugins[.]opensphere[.]io/u);
  assert.match(crds, /name: uipluginregistrations[.]plugins[.]opensphere[.]io/u);
  assert.match(crds, /enum: \[Pending, NotReady, Ready, Degraded, Removed\]/u);
  assert.match(crds, /enum: \[Pending, Current, LastKnownGood, Disabled, Unavailable\]/u);
  assert.match(crds, /currentArtifactVersion:[\s\S]*previousArtifactVersion:/u);
  assert.match(crds, /currentStaticContractSha256:[\s\S]*previousStaticContractSha256:/u);
  assert.doesNotMatch(
    `${manifest}\n${dockerfile}\n${server}\n${lifecycle}\n${release}\n${crds}`,
    /extension-controller\/runtime|dupa-controller|dupa admin/iu,
  );
  assert.match(matrix, /\['extensionController', 'opensphere-extension-controller', 'apps\/extension-controller\/Dockerfile'\]/u);
  assert.match(publisher, /Key = 'extensionController'; Image = 'opensphere-extension-controller'/u);
});
