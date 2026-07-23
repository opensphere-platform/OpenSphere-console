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
  assert.match(authService, /jwtAssurance\(session\.access_token\) !== 'aal2'/);
  assert.match(login, /auth\.mfaRequired\(\)/);
  assert.match(login, /auth\.finishMfaLogin/);
  assert.match(setup, /auth\.beginTotpEnrollment/);
  assert.match(setup, /auth\.verifyTotpEnrollment/);
});

