'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const deploy = fs.readFileSync(path.join(__dirname, 'deploy.yaml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');

test('legacy backend exposes only the approved interactive CLI credential flow', () => {
  assert.doesNotMatch(server, /\/api\/identity\/cli\/tokens/);
  assert.doesNotMatch(server, /restRequest\('api_token'/);
  assert.doesNotMatch(server, /claims\.typ === 'pat'|typ: 'pat'/);
  assert.doesNotMatch(deploy, /CLI_PAT_TTL_SEC/);
  assert.doesNotMatch(dockerfile, /cli-token-policy/);
  assert.match(server, /\['cli_session', 'web_shell'\]\.includes\(claims\.typ\)/);
  assert.match(server, /restRequest\('cli_session'/);
});
