'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const gateway = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const backend = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'opensphere-console-backend', 'server.js'), 'utf8');
const authority = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'opensphere-console-backend', 'osaa-source-authority.js'), 'utf8');
const gatewayImage = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');

test('OSAA exposes canonical source catalog, revision, read and search as read-only knowledge tools', () => {
  for (const tool of [
    'get_opensphere_source_catalog',
    'resolve_opensphere_source_revision',
    'read_opensphere_source',
    'search_opensphere_source',
  ]) assert.match(gateway, new RegExp(`'${tool}'`));
  assert.match(gateway, /'osaa\.source\.catalog': 'osaa\.knowledge\.read'/);
  assert.match(gateway, /\/api\/osaa\/tools\/source\/catalog/);
  assert.match(gateway, /\/api\/osaa\/tools\/source\/head/);
  assert.match(gateway, /\/api\/osaa\/tools\/source\/read/);
  assert.match(gateway, /\/api\/osaa\/tools\/source\/search/);
  assert.match(gateway, /first read the canonical source catalog, resolve the repository branch to an exact GitHub revision/);
  assert.match(gateway, /groundCanonicalSourceAnswer/);
  assert.match(gateway, /requiresCanonicalSourceTools/);
  assert.match(gateway, /filter\(\(tool\) => SOURCE_TOOL_NAMES\.has\(tool\.function\.name\)\)/);
  assert.match(gateway, /required: canonicalSourceIntent/);
  assert.match(gatewayImage, /COPY r2d2-source-grounding\.js \/app\/r2d2-source-grounding\.js/);
});

test('Console Backend owns source credential custody and exact-revision materialization', () => {
  assert.match(backend, /GITHUB_SOURCE_TOKEN = process\.env\.GITHUB_SOURCE_TOKEN \|\| ''/);
  assert.match(backend, /createCanonicalSourceEvidence\(\{ githubToken: GITHUB_SOURCE_TOKEN \}\)/);
  assert.match(backend, /\/api\/osaa\/source\/catalog/);
  assert.match(backend, /\/api\/osaa\/source\/head/);
  assert.match(backend, /\/api\/osaa\/source\/read/);
  assert.match(backend, /\/api\/osaa\/source\/search/);
  assert.match(authority, /https:\/\/github\.com\/opensphere-platform\/OpenSphere-console\.git/);
  assert.doesNotMatch(authority, /gitea\.opensphere\.local/i);
  assert.match(authority, /revision must be an exact 40-character canonical GitHub commit SHA/);
  assert.match(authority, /maximumArchiveBytes/);
  assert.match(authority, /source-evidence allowlist/);
});
