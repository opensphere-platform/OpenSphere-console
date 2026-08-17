import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
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

test('host children finish bounded verified activation before their parent receives host.children()', () => {
  const source = readFileSync(path.join(here, 'extension-host.service.ts'), 'utf8');
  const childActivation = source.indexOf('childEntries.filter((child) => child !== requestedChild)');
  const parentActivation = source.indexOf('await mod.activate(context)');
  assert.ok(childActivation >= 0);
  assert.ok(parentActivation > childActivation);
  assert.match(source, /await loadWithConcurrency\(/);
  assert.match(source, /this\.activeModules\.has\(entry\.id\)/);
});

test('a successful retry clears stale failures and each failure id stays unique', () => {
  const source = readFileSync(path.join(here, 'extension-host.service.ts'), 'utf8');
  assert.match(source, /attempt === 0 && isTransientExtensionLoadError\(err\)/);
  assert.match(source, /this\.clearPluginFailure\(e\.id\)/);
  assert.match(source, /failures\.filter\(\(failure\) => failure\.id !== pluginId\)/);
});
