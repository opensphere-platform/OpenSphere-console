import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'r2d2-risk.service.ts'), 'utf8');

test('incident stream refreshes are coalesced instead of fanning out requests', () => {
  assert.match(source, /const update = \(\) => this\.scheduleEventRefresh\(\)/);
  assert.match(source, /if \(this\.eventRefreshTimer\) return;/);
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]*void this\.refresh\(\);[\s\S]*\}, 250\)/);
  assert.doesNotMatch(source, /const update = \(\) => void this\.refresh\(\)/);
});

test('concurrent operational status reads share one in-flight request', () => {
  assert.match(source, /if \(this\.refreshInFlight\) return this\.refreshInFlight;/);
  assert.match(source, /const request = this\.loadRisk\(\)\.finally/);
  assert.match(source, /if \(this\.refreshInFlight === request\) this\.refreshInFlight = null;/);
  assert.match(source, /private async loadRisk\(\): Promise<void>/);
});

test('stop clears both interval and queued event refresh work', () => {
  assert.match(source, /if \(this\.timer\) clearInterval\(this\.timer\);/);
  assert.match(source, /if \(this\.eventRefreshTimer\) clearTimeout\(this\.eventRefreshTimer\);/);
  assert.match(source, /this\.eventRefreshTimer = null;/);
});
