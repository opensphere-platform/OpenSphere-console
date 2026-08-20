import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  extensionRouteTarget,
  isTransientExtensionLoadError,
} from './extension-load-order.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

test('canonical plugin deep links identify both host and child ownership', () => {
  assert.deepEqual(extensionRouteTarget('/p/foundation/postgres/install'), {
    hostId: 'foundation',
    childId: 'postgres',
  });
  assert.deepEqual(extensionRouteTarget('/pfss/postgres/admin'), {
    hostId: 'foundation',
    childId: 'postgres',
  });
  assert.deepEqual(extensionRouteTarget('/pfss/foundation'), {
    hostId: 'foundation',
    childId: '',
  });
  assert.deepEqual(extensionRouteTarget('/manage/extensions/plugins'), { hostId: '', childId: '' });
});

test('only transport interruption and timeout errors are retryable', () => {
  assert.equal(isTransientExtensionLoadError(new DOMException('signal is aborted without reason', 'AbortError')), true);
  assert.equal(isTransientExtensionLoadError({ name: 'HttpRequestTimeoutError', message: 'request timed out after 15000ms' }), true);
  assert.equal(isTransientExtensionLoadError(new TypeError('Failed to fetch')), true);
  assert.equal(isTransientExtensionLoadError(new Error('manifest 서명 검증 실패')), false);
  assert.equal(isTransientExtensionLoadError(new Error('번들 무결성 불일치')), false);
});

test('only the requested subShell route activates while unrelated guests remain queued', () => {
  const source = readFileSync(path.join(here, 'extension-host.service.ts'), 'utf8');
  assert.match(source, /await this\.ensureRequestedRoute\(window\.location\.pathname\)/);
  assert.match(source, /NavigationEnd\) void this\.ensureRequestedRoute\(event\.urlAfterRedirects\)/);
  assert.doesNotMatch(source, /startBackgroundChildActivation|backgroundChildren/);
  assert.doesNotMatch(source, /orderedMainPlugins|loadWithConcurrency\(\s*mainPlugins/);
  assert.match(source, /await atExtensionStage\('activation', async \(\) => \{ await mod!\.activate\(context\); \}\);[\s\S]*this\.activeModules\.set\(e\.id, mod\)/);
  assert.doesNotMatch(source, /const childEntries = manifest\.kind/);
  assert.match(source, /hostProjectionDeclarations\.set\(pluginId/);
  assert.match(source, /this\.activeModules\.has\(projection\.id\)/);
  assert.match(source, /children: \(\) => this\.registryEntries[\s\S]*\.filter\(\(entry\) => \(entry\.hostRef \?\? 'main'\) === pluginId\)/);
});

test('first-level navigation is hydrated and atomically replaced without guest activation', () => {
  const source = readFileSync(path.join(here, 'extension-host.service.ts'), 'utf8');
  assert.match(source, /navigationSnapshot = signal<ConsoleNavigationSnapshot \| null>\(this\.cachedNavigationSnapshot\)/);
  assert.match(source, /buildConsoleNavigationSnapshot\([\s\S]*this\.navigationSnapshot\.set\(snapshot\)/);
  assert.match(source, /localStorage\.setItem\(CONSOLE_NAVIGATION_STORAGE_KEY, JSON\.stringify\(snapshot\)\)/);
  assert.match(source, /It never grants execution/);
});

test('immutable artifacts reuse browser cache but remain digest verified', () => {
  const source = readFileSync(path.join(here, 'extension-host.service.ts'), 'utf8');
  assert.match(source, /fetchWithTimeout\(url, \{ cache: 'force-cache' \}\)/);
  assert.match(source, /fetchWithTimeout\(url, \{ cache: 'reload' \}\)/);
  assert.match(source, /sha256Hex\(text\)\) !== expectedSha256/);
  assert.match(source, /Promise\.all\(declarations\.map/);
  assert.match(source, /const \[mText, sigB64\] = await Promise\.all/);
  assert.match(source, /const \[code, verifiedAssets\] = await Promise\.all/);
});

test('a successful retry clears stale failures and each failure id stays unique', () => {
  const source = readFileSync(path.join(here, 'extension-host.service.ts'), 'utf8');
  assert.match(source, /const retryable = isTransientExtensionLoadError\(err\);[\s\S]*attempt === 0 && retryable/);
  assert.match(source, /this\.clearPluginFailure\(e\.id\)/);
  assert.match(source, /failures\.filter\(\(failure\) => failure\.id !== pluginId\)/);
});
