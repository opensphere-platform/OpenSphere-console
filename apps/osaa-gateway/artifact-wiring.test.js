'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const root = join(__dirname, '..', '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

test('C_AI manifest uses the canonical OSAA gateway release artifact', () => {
  const manifest = read('apps', 'osaa-gateway', 'deploy.yaml');
  const dockerfile = read('apps', 'osaa-gateway', 'Dockerfile');
  const matrix = read('scripts', 'release-artifact-matrix.test.mjs');
  const publisher = read('scripts', 'Publish-LocalEdge.ps1');

  assert.equal((manifest.match(/__OPENSPHERE_OSAA_GATEWAY_IMAGE__/gu) || []).length, 1);
  assert.doesNotMatch(manifest, /opensphere-console-osaa-gateway@sha256:/u);
  assert.match(manifest, /podSelector: \{ matchLabels: \{ app[.]kubernetes[.]io\/name: opensphere-console-api \} \}/u);
  assert.doesNotMatch(manifest, /namespaceSelector|podSelector: \{\}/u);
  assert.match(dockerfile, /COPY console-identity-client[.]js \/app\/console-identity-client[.]js/u);
  assert.match(matrix, /\['osaaGateway', 'opensphere-console-osaa-gateway', 'apps\/osaa-gateway\/Dockerfile'\]/u);
  assert.match(publisher, /Key = 'osaaGateway'; Image = 'opensphere-console-osaa-gateway'/u);
});
