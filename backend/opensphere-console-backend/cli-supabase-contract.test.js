'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const server = read('backend/opensphere-console-backend/server.js');
const cli = read('backend/os-cli/cmd/os/main.go');
const myInfo = read('src/app/pages/my-info.ts');
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

test('CLI whoami returns human identity and explicit user and device identifiers', () => {
  assert.match(server, /select=status,credential_revision,display_name&user_id/);
  assert.match(server, /userId: actor\.sub/);
  assert.match(server, /email: identity\.email/);
  assert.match(server, /username: identity\.username/);
  assert.match(server, /displayName: actor\.displayName \|\| identity\.displayName \|\| identity\.username/);
  assert.match(server, /deviceId: actor\.deviceId \|\| null/);
});

test('Console credential history renders the real CLI device trust state', () => {
  assert.match(myInfo, /status: 'active' \| 'revoked'/);
  assert.match(myInfo, /device\.status === 'active'/);
  assert.match(myInfo, /<span class="label label-danger">폐기됨<\/span>/);
  assert.match(myInfo, /\{\{ fmt\(device\.revokedAt\) \}\}/);
  assert.match(myInfo, /활성 장치 \{\{ activeDeviceCount\(\) \}\}/);
  assert.match(myInfo, />검색 초기화<\/button>/);
  assert.doesNotMatch(myInfo, /<clr-dg-cell><span class="label label-success">신뢰됨<\/span><\/clr-dg-cell>/);
  assert.match(server, /restRequest\('cli_device',[\s\S]{0,260}last_used_at: usedAt/);
  assert.match(server, /owner_id=eq\.\$\{encodeURIComponent\(claims\.sub\)\}&status=eq\.active/);
});

test('Supabase CLI trust is RLS protected and enrollment approval is atomic', () => {
  for (const table of ['cli_device', 'cli_enrollment', 'cli_challenge', 'cli_session', 'api_token']) {
    assert.match(migration, new RegExp(`ALTER TABLE console\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'));
  }
  assert.match(migration, /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, console/i);
  assert.match(migration, /FOR UPDATE;/i);
});

test('Console readiness rejects stale BFF CLI artifacts', () => {
  assert.match(deployment, /"version": "0\.8\.0"/);
  assert.match(deployment, /! grep -aRqs '\/bff\/cli'/);
  assert.match(deployment, /Authentication uses \/api\/identity\/cli\//);
});
