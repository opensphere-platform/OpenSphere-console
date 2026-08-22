import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyConsoleCompositionSource } from './verify-console-composition.mjs';
import './osaa-canonical-identity.test.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(repo, ...parts), 'utf8');

test('Main Shell composition is closed and system plugins are isolated from Registry lifecycle', () => {
  assert.deepEqual(verifyConsoleCompositionSource(), { coreSurfaces: 1, systemPlugins: 2 });

  const composition = read('src', 'app', 'core', 'console-composition.manifest.ts');
  const admin = read('src', 'app', 'pages', 'admin-plugins.ts');
  const verifier = read('scripts', 'verify-console-composition.mjs');
  assert.match(composition, /routes\.has\(surface\.route\)/);
  assert.match(composition, /routes\.has\(descriptor\.route\)/);
  assert.match(admin, /aria-label="Console Core Surfaces"/);
  assert.match(admin, /systemPluginFailures\(\)\.length/);
  assert.match(admin, /다른 Console 표면은 계속 사용할 수 있습니다/);
  assert.doesNotMatch(verifier, /read\('backend'/);
});

test('Manual remains core while R2D2 is a lazy Console-owned system plugin', () => {
  const routes = read('src', 'app', 'app.routes.ts');
  const r2d2 = read('src', 'app', 'system-plugins', 'r2d2', 'r2d2.route.ts');
  const unavailable = read('src', 'app', 'system-plugins', 'system-plugin-unavailable.ts');

  assert.match(routes, /path:\s*'manual',\s*component:\s*ManualPage/);
  assert.match(routes, /R2D2_ADMIN_ROUTE/);
  assert.match(r2d2, /loadComponent/);
  assert.match(r2d2, /recoverStaleLazyChunkOnce\(R2D2_SYSTEM_PLUGIN\.id, error\)/);
  assert.match(r2d2, /systemPluginId:\s*R2D2_SYSTEM_PLUGIN\.id/);
  assert.match(unavailable, /SYSTEM PLUGIN DEGRADED/);
  assert.match(unavailable, /Main Shell과 다른 Extension은 계속 사용할 수 있습니다/);
});

test('rolling Console revisions never cache a missing hashed asset as immutable', () => {
  const nginx = read('nginx', 'default.conf.template');

  assert.match(nginx, /location ~\* "-\[A-Za-z0-9\]\{8,\}\\\.\(\?:js\|css\)\$" \{[\s\S]*?try_files \$uri @missing_hashed_asset;/);
  assert.match(nginx, /location @missing_hashed_asset \{[\s\S]*?Cache-Control "no-store, max-age=0" always;[\s\S]*?return 404;/);
  assert.match(nginx, /Cache-Control "public, max-age=31536000, immutable" always;/);
});

test('OSAA admin exposes one bounded repair approval and exact-route browser verification flow', () => {
  const osaa = read('src', 'app', 'pages', 'admin-osaa.ts');

  assert.match(osaa, /\/api\/osaa\/remediations\/\$\{encodeURIComponent\(request\.remediationRequestId\)\}\/approvals\/source/u);
  assert.match(osaa, /승인하고 실행/u);
  assert.match(osaa, /verificationProfile:\s*'osaa-admin'/u);
  assert.match(osaa, /document\.querySelector\('os-admin-osaa'\)/u);
  assert.match(osaa, /request\.affectedComponents\.length/u);
  assert.match(osaa, /components\[component\]\?\.sourceRevision/u);
});
