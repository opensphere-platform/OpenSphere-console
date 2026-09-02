import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..', '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

test('C_EXT target proxy is packaged in the canonical controller without legacy runtime dependency', async () => {
  const [manifest, dockerfile, server, matrix, publisher] = await Promise.all([
    read('apps/extension-controller/deploy.yaml'),
    read('apps/extension-controller/Dockerfile'),
    read('apps/extension-controller/src/server.mjs'),
    read('scripts/release-artifact-matrix.test.mjs'),
    read('scripts/Publish-LocalEdge.ps1'),
  ]);
  assert.equal((manifest.match(/__OPENSPHERE_EXTENSION_CONTROLLER_IMAGE__/g) || []).length, 1);
  assert.match(manifest, /kind: Service[\s\S]*name: opensphere-extension-controller/u);
  assert.match(manifest, /app[.]kubernetes[.]io\/name: opensphere-console-api/u);
  assert.match(dockerfile, /COPY apps\/extension-controller\/src [.]\/src/u);
  assert.match(server, /createConsoleOwnerAdmission/u);
  assert.match(server, /createPluginProxy/u);
  assert.doesNotMatch(`${manifest}\n${dockerfile}\n${server}`, /extension-controller\/runtime|dupa-controller/u);
  assert.match(matrix, /\['extensionController', 'opensphere-extension-controller', 'apps\/extension-controller\/Dockerfile'\]/u);
  assert.match(publisher, /Key = 'extensionController'; Image = 'opensphere-extension-controller'/u);
});
