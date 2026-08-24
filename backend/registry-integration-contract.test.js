'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const dupa = read('dupa-control/controller.js');
const backend = read('opensphere-console-backend/server.js');
const gateway = read('opensphere-console-osaa-gateway/server.js');
const nginx = read('../nginx/default.conf.template');

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

test('OSCE revision-binds PFSS create operations to Registry resolution', () => {
  assert.match(backend, /resolvePostgresCatalogBinding/);
  assert.match(backend, /catalogBinding/);
  assert.match(backend, /CatalogBindingInvalid/);
  assert.match(backend, /POST', '\/api\/v1\/registry\/resolve'/);
});

test('OSAA reads the same Registry and has a closed deterministic resolver tool', () => {
  assert.match(gateway, /id: 'osaa\.registry\.resolve'/);
  assert.match(gateway, /resolve_registry_candidate/);
  assert.match(gateway, /Registry & Catalog Service is unavailable/);
  assert.doesNotMatch(gateway, /DUPA projection/);
});
