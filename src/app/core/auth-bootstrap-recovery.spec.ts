import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  AUTH_BOOTSTRAP_RETRY_DELAYS_MS,
  authBootstrapRetryDelay,
  isRetryableAuthBootstrapStatus,
} from './auth-bootstrap-recovery.ts';

const authSource = fs.readFileSync(new URL('./auth.service.ts', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../app.ts', import.meta.url), 'utf8');
const appConfigSource = fs.readFileSync(new URL('../app.config.ts', import.meta.url), 'utf8');

test('재부팅 지연은 빠르게 재시도한 뒤 30초 간격으로 계속 수렴한다', () => {
  assert.deepEqual(AUTH_BOOTSTRAP_RETRY_DELAYS_MS, [1_000, 2_000, 5_000, 10_000, 15_000, 30_000]);
  assert.equal(authBootstrapRetryDelay(0), 1_000);
  assert.equal(authBootstrapRetryDelay(4), 15_000);
  assert.equal(authBootstrapRetryDelay(99), 30_000);
});

test('일시적인 네트워크와 서버 장애만 자동 재시도한다', () => {
  for (const status of [0, 408, 425, 429, 500, 503]) assert.equal(isRetryableAuthBootstrapStatus(status), true);
  for (const status of [400, 401, 403, 404]) assert.equal(isRetryableAuthBootstrapStatus(status), false);
});

test('인증 초기화는 수동 클릭 없이 자동 복구 루프를 유지한다', () => {
  assert.match(authSource, /startInitialization\(\): void/);
  assert.match(authSource, /scheduleInitializationRetry/);
  assert.match(authSource, /isRetryableAuthBootstrapStatus/);
  assert.match(appConfigSource, /auth\.startInitialization\(\)/);
  assert.doesNotMatch(appConfigSource, /ext\.load\(/);
});

test('Extension은 인증된 운영자 세션이 확인된 후에만 적재된다', () => {
  assert.match(appSource, /Boolean\(this\.auth\.subject\(\)\)/);
  assert.match(appSource, /!this\.auth\.loginRequired\(\)/);
  assert.match(appSource, /this\.ext\.load\(\)/);
  assert.match(appSource, /자동으로 다시 연결합니다/);
});
