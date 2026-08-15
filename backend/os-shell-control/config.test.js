'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig } = require('./config');

const MANAGED = [
  'OS_SHELL_CONTROL_ENABLED', 'OS_SHELL_ATTACH_ENABLED', 'OS_SHELL_RECONCILER_ENABLED',
  'OS_SHELL_RUNTIME_REGISTRATION_ENABLED', 'OS_SHELL_RUNTIME_CONTROL_ENABLED', 'OS_SHELL_RUNTIME_IMAGE',
  'OS_SHELL_OS_ARTIFACT_DIGEST', 'OS_SHELL_MANIFEST_SHA256', 'OS_SHELL_RELEASE_EVIDENCE_REF',
  'OS_SHELL_RELEASE_KEY_ID', 'OS_SHELL_SESSION_POLICY_REVISION', 'OS_SHELL_RUNTIME_TEMPLATE_REVISION',
  'OS_SHELL_ADMISSION_SECRET', 'OS_SHELL_DELEGATION_SECRET', 'OS_SHELL_INTERNAL_TLS_CERT_FILE',
  'OS_SHELL_INTERNAL_TLS_KEY_FILE', 'OS_SHELL_INTERNAL_CA_FILE', 'PGHOST', 'PGUSER', 'PGPASSWORD',
  'OS_SHELL_GATEWAY_READINESS_URL', 'OS_SHELL_RECONCILER_READINESS_URL',
  'OS_SHELL_CONSOLE_API_READINESS_URL', 'OS_SHELL_CREDENTIAL_AUTHORITY_READINESS_URL',
];
function environment(values, action) {
  const original = Object.fromEntries(MANAGED.map((name) => [name, process.env[name]]));
  for (const name of MANAGED) delete process.env[name]; Object.assign(process.env, values);
  try { return action(); } finally { for (const name of MANAGED) {
    if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
  } }
}
function enabled(files = {}) {
  return { OS_SHELL_CONTROL_ENABLED: 'true', OS_SHELL_RUNTIME_IMAGE: `ghcr.io/opensphere-platform/opensphere-os-shell-runtime@sha256:${'1'.repeat(64)}`,
    OS_SHELL_OS_ARTIFACT_DIGEST: `sha256:${'2'.repeat(64)}`, OS_SHELL_MANIFEST_SHA256: `sha256:${'3'.repeat(64)}`,
    OS_SHELL_RELEASE_EVIDENCE_REF: 'release://test', OS_SHELL_RELEASE_KEY_ID: 'test-key', OS_SHELL_SESSION_POLICY_REVISION: 'policy-v1',
    OS_SHELL_RUNTIME_TEMPLATE_REVISION: 'template-v1', OS_SHELL_ADMISSION_SECRET: 'a'.repeat(32), OS_SHELL_DELEGATION_SECRET: 'd'.repeat(32),
    PGHOST: 'postgres', PGUSER: 'role', PGPASSWORD: 'password', ...files };
}

test('all control modes are default-off and allocate no database authority', () => {
  environment({}, () => { for (const mode of ['api', 'gateway', 'reconciler']) {
    const value = loadConfig(mode); assert.equal(value.enabled, false); assert.equal(value.database, null);
    assert.equal(value.runtimeImage, '');
  } });
});

test('API runtime control and reconciler registration fail startup without their exact TLS leaf', () => {
  environment(enabled({ OS_SHELL_RUNTIME_CONTROL_ENABLED: 'true', OS_SHELL_INTERNAL_CA_FILE: __filename }), () => {
    assert.throws(() => loadConfig('api'), /certificate and private key/);
  });
  environment(enabled({ OS_SHELL_RUNTIME_REGISTRATION_ENABLED: 'true' }), () => {
    assert.throws(() => loadConfig('reconciler'), /certificate and private key/);
  });
});

test('enabled API requires a public internal CA and accepts only the canonical runtime image repository', () => {
  environment(enabled({ OS_SHELL_RUNTIME_IMAGE: `example.invalid/runtime@sha256:${'1'.repeat(64)}` }), () => {
    assert.throws(() => loadConfig('api'), /canonical exact-digest runtime image/);
  });
  environment(enabled(), () => { assert.throws(() => loadConfig('api'), /internal public CA/); });
  environment(enabled({ OS_SHELL_INTERNAL_CA_FILE: __filename }), () => {
    const value = loadConfig('api'); assert.equal(value.runtimeImageDigest, `sha256:${'1'.repeat(64)}`);
    assert.match(value.registrationURL, /opensphere-shell-reconciler/); assert.match(value.runtimeControlURL, /opensphere-shell-api/);
    assert.match(value.consoleAPIURL, /opensphere-shell-console-api/);
    assert.match(value.consoleAPIReadinessURL, /opensphere-shell-console-api/);
    assert.match(value.gatewayReadinessURL, /opensphere-shell-gateway/); assert.match(value.reconcilerReadinessURL, /opensphere-shell-reconciler/);
    assert.match(value.credentialAuthorityReadinessURL, /opensphere-shell-credential-authority/);
  });
});
