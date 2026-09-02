'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const server = readFileSync(join(__dirname, 'server.js'), 'utf8');
const deploy = readFileSync(join(__dirname, 'deploy.yaml'), 'utf8');
const nginx = readFileSync(join(__dirname, '..', '..', 'apps', 'console-web', 'nginx', 'default.conf.template'), 'utf8');

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

test('Backend can patch only the OSDST deployment and nginx keeps the write out of Gateway', () => {
  assert.match(deploy, /name: opensphere-console-backend-osaa-dialogue-state/);
  assert.match(deploy, /resourceNames: \["opensphere-osdst"\]/);
  assert.match(deploy, /verbs: \["get", "patch"\]/);
  assert.match(nginx, /location = \/api\/osaa\/admin\/dialogue-state[\s\S]*opensphere-console-backend/);
});
