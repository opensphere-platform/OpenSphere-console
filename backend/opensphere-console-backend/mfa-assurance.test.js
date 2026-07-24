'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const backend = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const deploy = fs.readFileSync(path.join(__dirname, 'deploy.yaml'), 'utf8');
const authService = fs.readFileSync(path.join(root, 'src/app/core/auth.service.ts'), 'utf8');
const login = fs.readFileSync(path.join(root, 'src/app/pages/login.ts'), 'utf8');
const setup = fs.readFileSync(path.join(root, 'src/app/pages/initial-setup.ts'), 'utf8');

test('administrator mutations require a real AAL2 session by default', () => {
  assert.match(backend, /SUPABASE_REQUIRE_AAL2 \|\| 'true'/);
  assert.match(backend, /SUPABASE_REQUIRE_AAL2 && isMutationRequest\(req\)/);
  assert.match(backend, /admin mutation requires MFA assurance aal2/);
  assert.match(deploy, /name: SUPABASE_REQUIRE_AAL2, value: "true"/);
  assert.match(deploy, /name: NOTIFICATION_REQUIRE_AAL2, value: "true"/);
});

test('CLI sessions and PATs cannot manufacture Supabase AAL2 assurance', () => {
  const actorProjection = backend.slice(
    backend.indexOf('async function resolveConsoleActor'),
    backend.indexOf('async function verifyManagedCliToken'),
  );
  assert.match(actorProjection, /assurance: 'aal1'/);
  assert.doesNotMatch(actorProjection, /assurance: 'aal2'/);
});

test('browser login and bootstrap complete the Supabase TOTP challenge', () => {
  assert.match(authService, /finishMfaLogin/);
  assert.match(authService, /beginTotpEnrollment/);
  assert.match(authService, /challengeAndVerify/);
  assert.match(authService, /authJson<SupabaseUser>\('\/auth\/v1\/user', \{ method: 'GET' \}, token\)/);
  assert.doesNotMatch(authService, /authJson<SupabaseMfaFactors>\('\/auth\/v1\/factors', \{ method: 'GET' \}, token\)/);
  assert.match(authService, /item\.factor_type === 'totp' && item\.status === 'unverified'/);
  assert.match(authService, /`\/auth\/v1\/factors\/\$\{encodeURIComponent\(factor\.id\)\}`[\s\S]*method: 'DELETE'/);
  assert.match(authService, /jwtAssurance\(session\.access_token\) !== 'aal2'/);
  assert.match(login, /auth\.mfaRequired\(\)/);
  assert.match(login, /auth\.finishMfaLogin/);
  assert.match(setup, /auth\.beginTotpEnrollment/);
  assert.match(setup, /auth\.verifyTotpEnrollment/);
});

test('browser sessions rotate the GoTrue refresh token before access-token expiry', () => {
  assert.match(authService, /grant_type=refresh_token/);
  assert.match(authService, /JSON\.stringify\(\{ refresh_token: session\.refresh_token \}\)/);
  assert.match(authService, /scheduleSessionRefresh\(session\)/);
  assert.match(authService, /exp - Math\.floor\(Date\.now\(\) \/ 1000\) - 60/);
  assert.match(authService, /previousAssurance === 'aal2'[\s\S]*jwtAssurance\(body\.access_token\) !== 'aal2'/);
  assert.match(authService, /if \(existing\.refresh_token\)[\s\S]*await this\.refreshSession\(existing\)/);
});
