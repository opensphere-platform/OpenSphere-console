'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const server = readFileSync(join(__dirname, 'server.js'), 'utf8');
const deploy = readFileSync(join(__dirname, 'deploy.yaml'), 'utf8');
const targetRoutes = readFileSync(join(__dirname, '..', '..', 'console-web', 'nginx', 'target-api-routes.conf'), 'utf8');

test('Dialogue State admin control accepts only the closed four-stage mode set', () => {
  assert.match(server, /new Set\(\['off', 'shadow', 'read-enforce', 'mutation-enforce'\]\)/);
  assert.match(server, /unsupported OSDST mode/);
  assert.match(server, /Object\.keys\(body\).*\['mode', 'reason'\]/s);
});

test('Dialogue State change is admin, recent-AAL2 and audit-intent gated', () => {
  assert.match(server, /p === '\/api\/osaa\/admin\/dialogue-state'.*req\.method === 'POST'/s);
  assert.match(server, /verifyConsoleAdmin\(req, \{ requireAal2: true \}\)/);
  assert.match(server, /osaa-dialogue-state-mode-change/);
  assert.match(server, /phase: 'intent'/);
});

test('legacy Backend stays narrowly scoped while target nginx sends OSAA writes only to Gateway', () => {
  assert.match(deploy, /name: opensphere-console-backend-osaa-dialogue-state/);
  assert.match(deploy, /resourceNames: \["opensphere-osdst"\]/);
  assert.match(deploy, /verbs: \["get", "patch"\]/);
  const osaaRoute = targetRoutes.match(/location \/api\/osaa\/ \{[\s\S]*?\r?\n    \}/)?.[0] ?? '';
  assert.match(osaaRoute, /opensphere-console-osaa-gateway/);
  assert.doesNotMatch(osaaRoute, /opensphere-console-backend/);
});
