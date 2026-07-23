'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('runtime watch discovery excludes absent APIs instead of reconnecting forever', () => {
  assert.match(source, /function discoverWatchableResource/);
  assert.match(source, /response\.status === 403 \|\| response\.status === 404/);
  assert.match(source, /state\.expected = discovered\.terminal \? false : true/);
  assert.match(source, /state\.status = discovered\.terminal \? 'unsupported' : 'discovery-error'/);
  assert.match(source, /terminalApiError/);
  assert.match(source, /state\.expected = false/);
});

test('runtime watch retries transient failures with capped exponential backoff', () => {
  assert.match(source, /OAA_K8S_WATCH_MAX_BACKOFF_MS/);
  assert.match(source, /OAA_K8S_WATCH_RECONNECT_MS \* \(2 \*\* exponent\)/);
  assert.match(source, /const baseDelay = Math\.min\(OAA_K8S_WATCH_MAX_BACKOFF_MS/);
  assert.match(source, /OAA_K8S_WATCH_DISCOVERY_MS/);
});

test('OAA system context declares projection source and freshness', () => {
  assert.match(source, /projectionLagSeconds/);
  assert.match(source, /Evidence source: \$\{snapshot\.evidenceSource/);
  assert.match(source, /partial or cached projection data/);
});
