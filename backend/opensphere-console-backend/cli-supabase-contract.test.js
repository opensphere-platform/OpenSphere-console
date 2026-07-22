'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const server = read('backend/opensphere-console-backend/server.js');
const cli = read('backend/os-cli/cmd/os/main.go');
const migration = read('backend/supabase/migrations/0006_cli_identity.sql');
const deployment = read('deploy/opensphere-console.yaml');

test('CLI and Supabase backend share the v2 signed challenge contract', () => {
  assert.match(server, /opensphere-cli-session-v2\\n/);
  assert.match(cli, /opensphere-cli-session-v2\\n/);
  assert.doesNotMatch(cli, /opensphere-cli-session-v1/);
});

test('CLI enrollment validation preserves structured client error status', () => {
  assert.match(server, /if \(p === '\/api\/identity\/cli\/enrollments'[\s\S]{0,300}authErrorStatus\(e\)/);
  assert.match(server, /CLI label must be 1-128 characters/);
});

test('Supabase CLI trust is RLS protected and enrollment approval is atomic', () => {
  for (const table of ['cli_device', 'cli_enrollment', 'cli_challenge', 'cli_session', 'api_token']) {
    assert.match(migration, new RegExp(`ALTER TABLE console\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'));
  }
  assert.match(migration, /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, console/i);
  assert.match(migration, /FOR UPDATE;/i);
});

test('Console readiness rejects stale BFF CLI artifacts', () => {
  assert.match(deployment, /"version": "0\.5\.1"/);
  assert.match(deployment, /! grep -aRqs '\/bff\/cli'/);
  assert.match(deployment, /Authentication uses \/api\/identity\/cli\//);
});
