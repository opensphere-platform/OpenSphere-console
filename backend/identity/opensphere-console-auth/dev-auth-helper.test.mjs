import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const files = ['_oidc-login.mjs', '_mint-token.mjs'];

test('local OIDC helpers require injected credentials and contain no fallback secret', () => {
  for (const file of files) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, /OPENSPHERE_TEST_TOTP_SECRET/);
    assert.match(source, /OPENSPHERE_TEST_USERNAME/);
    assert.match(source, /OPENSPHERE_TEST_PASSWORD/);
    assert.doesNotMatch(source, /process\.argv\[2\]\s*\|\|/);
  }
});
