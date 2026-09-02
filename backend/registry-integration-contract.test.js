'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const dupa = read('dupa-control/controller.js');
const backend = read('../apps/console-api/runtime/server.js');
const gateway = read('../apps/osaa-gateway/server.js');
const nginx = read('../apps/console-web/nginx/default.conf.template');
const registrySource = read('registry/internal/registry/registry.go');
const registryManifest = read('registry/deploy/registry.yaml');

test('DUPA publishes lifecycle and navigation facts but does not serve a second Registry', () => {
  assert.match(dupa, /publishNavigationPreferences/);
  assert.match(dupa, /waitForRegistryArtifact/);
  assert.doesNotMatch(dupa, /extensionProjection/);
  assert.doesNotMatch(dupa, /app\.get\('\/api\/v1\/registry'/);
});

test('Console exposes only the independent public Registry read path', () => {
  assert.match(nginx, /location = \/api\/v1\/registry/);
  assert.match(nginx, /set \$registry_api_upstream opensphere-registry\.opensphere-console\.svc\.cluster\.local/);
  assert.match(nginx, /proxy_pass http:\/\/\$registry_api_upstream:8080\/api\/v1\/registry/);
  assert.match(nginx, /location = \/api\/v1\/registry\/resolve[\s\S]*return 404/);
  assert.doesNotMatch(nginx, /location \/registry\//);
});

test('OSCE revision-binds only installable module resolution to Registry evidence', () => {
  assert.match(backend, /resolveInstallableCatalogBinding/);
  assert.match(backend, /catalogBinding/);
  assert.match(backend, /CatalogBindingInvalid/);
  assert.match(backend, /kind: 'installableModule'/);
  assert.match(backend, /exactDigest/);
});

test('OSAA reads the same Registry and has a closed deterministic resolver tool', () => {
  assert.match(gateway, /id: 'osaa\.registry\.resolve'/);
  assert.match(gateway, /resolve_registry_candidate/);
  assert.match(gateway, /Registry & Catalog Service is unavailable/);
  assert.match(gateway, /instanceAbsent/);
  assert.doesNotMatch(gateway, /DUPA projection/);
});

test('Registry reads both public-key and navigation inputs from one namespace-scoped authority', () => {
  assert.doesNotMatch(registrySource, /opensphere-system/);
  assert.match(registrySource, /Namespace\(registryNamespace\)\.Get\(ctx, trustConfigMap/);
  assert.match(registryManifest, /kind: Role[\s\S]*name: opensphere-registry-config[\s\S]*resourceNames: \["dupa-trusted-keys", "opensphere-extension-navigation-v1", "opensphere-installation-lock"\]/);
  assert.match(registrySource, /ReleaseLock/);
  const clusterRole = registryManifest
    .split(/\r?\n---\r?\n/)
    .find((document) => /kind: ClusterRole\r?\n/.test(document));
  assert.ok(clusterRole);
  assert.doesNotMatch(clusterRole, /resources: \["configmaps"\]/);
});
