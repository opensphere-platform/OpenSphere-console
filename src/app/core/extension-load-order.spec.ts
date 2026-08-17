import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CHILD_EXTENSION_ACTIVATION_CONCURRENCY,
  extensionRouteTarget,
  isTransientExtensionLoadError,
  loadWithConcurrency,
  prioritizeRequestedHost,
} from './extension-load-order.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

const registry = [
  { id: 'cluster-manager', hostRef: 'main' },
  { id: 'foundation', hostRef: 'main' },
  { id: 'postgres', hostRef: 'foundation' },
  { id: 'gitlab', hostRef: 'main' },
];

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

test('cold extension activation prioritizes only the requested main subShell', () => {
  assert.deepEqual(
    prioritizeRequestedHost(registry, '/p/foundation/postgres').map((entry) => entry.id),
    ['foundation', 'cluster-manager', 'postgres', 'gitlab'],
  );
  assert.deepEqual(
    prioritizeRequestedHost(registry, '/pfss/postgres/admin').map((entry) => entry.id),
    ['foundation', 'cluster-manager', 'postgres', 'gitlab'],
  );
  assert.deepEqual(
    prioritizeRequestedHost(registry, '/manage/extensions/subshells').map((entry) => entry.id),
    registry.map((entry) => entry.id),
  );
});

test('extension activation is bounded and completes every registry entry', async () => {
  let active = 0;
  let maximum = 0;
  const completed: number[] = [];
  await loadWithConcurrency([0, 1, 2, 3, 4, 5, 6], async (entry) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(entry);
    active -= 1;
  }, 3);
  assert.equal(maximum, 3);
  assert.deepEqual(completed.toSorted((left, right) => left - right), [0, 1, 2, 3, 4, 5, 6]);
  await assert.rejects(() => loadWithConcurrency([1], async () => undefined, 0), /positive integer/);
});

test('only transport interruption and timeout errors are retryable', () => {
  assert.equal(isTransientExtensionLoadError(new DOMException('signal is aborted without reason', 'AbortError')), true);
  assert.equal(isTransientExtensionLoadError({ name: 'HttpRequestTimeoutError', message: 'request timed out after 15000ms' }), true);
  assert.equal(isTransientExtensionLoadError(new TypeError('Failed to fetch')), true);
  assert.equal(isTransientExtensionLoadError(new Error('manifest 서명 검증 실패')), false);
  assert.equal(isTransientExtensionLoadError(new Error('번들 무결성 불일치')), false);
});

test('a parent subShell activates before hosted children continue in the background', () => {
  const source = readFileSync(path.join(here, 'extension-host.service.ts'), 'utf8');
  assert.equal(CHILD_EXTENSION_ACTIVATION_CONCURRENCY, 2);
  assert.match(source, /this\.loadState\.set\('ready'\);[\s\S]*this\.startBackgroundChildActivation\(backgroundChildren\)/);
  assert.match(source, /await atExtensionStage\('activation', async \(\) => \{ await mod!\.activate\(context\); \}\);[\s\S]*this\.activeModules\.set\(e\.id, mod\)/);
  assert.doesNotMatch(source, /const childEntries = manifest\.kind/);
  assert.match(source, /hostProjectionDeclarations\.set\(pluginId/);
  assert.match(source, /this\.activeModules\.has\(projection\.id\)/);
  assert.match(source, /children: \(\) => this\.registryEntries[\s\S]*\.filter\(\(entry\) => \(entry\.hostRef \?\? 'main'\) === pluginId\)/);
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
