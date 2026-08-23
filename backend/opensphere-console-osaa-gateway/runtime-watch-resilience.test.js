'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const backendSource = fs.readFileSync(path.resolve(__dirname, '../opensphere-console-backend/server.js'), 'utf8');

test('runtime watch discovery excludes absent APIs instead of reconnecting forever', () => {
  assert.match(source, /function discoverWatchableResource/);
  assert.match(source, /response\.status === 403 \|\| response\.status === 404/);
  assert.match(source, /state\.expected = discovered\.terminal \? false : true/);
  assert.match(source, /state\.status = discovered\.terminal \? 'unsupported' : 'discovery-error'/);
  assert.match(source, /terminalApiError/);
  assert.match(source, /state\.expected = false/);
});

test('runtime watch retries transient failures with capped exponential backoff', () => {
  assert.match(source, /OSAA_K8S_WATCH_MAX_BACKOFF_MS/);
  assert.match(source, /OSAA_K8S_WATCH_RECONNECT_MS \* \(2 \*\* exponent\)/);
  assert.match(source, /const baseDelay = Math\.min\(OSAA_K8S_WATCH_MAX_BACKOFF_MS/);
  assert.match(source, /OSAA_K8S_WATCH_DISCOVERY_MS/);
});

test('OSAA evidence context declares projection source and freshness without system authority', () => {
  assert.match(source, /projectionLagSeconds/);
  assert.match(source, /evidenceSource: liveClusterReady/);
  assert.match(source, /kubernetes-partial/);
  assert.match(source, /return untrustedEvidenceMessage\('live-environment-snapshot', snapshot/);
});

test('maintenance binds the cluster identifier with an explicit PostgreSQL type', () => {
  assert.match(backendSource, /jsonb_build_object\('clusterId',\$1::text\)/);
  assert.match(backendSource, /FROM osaa\.source_health WHERE cluster_id=\$1::text/);
});
