'use strict';

const fs = require('node:fs');

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUNTIME_IMAGE = /^ghcr[.]io\/opensphere-platform\/opensphere-os-shell-runtime@sha256:[a-f0-9]{64}$/;
function on(name) { return process.env[name] === 'true'; }
function required(name) { const value = String(process.env[name] || '').trim(); if (!value) throw new Error(`${name} is required`); return value; }
function digest(name) { const value = required(name); if (!DIGEST.test(value)) throw new Error(`${name} must be an exact SHA-256 digest`); return value; }
function runtimeImage() { const value = required('OS_SHELL_RUNTIME_IMAGE'); if (!RUNTIME_IMAGE.test(value)) throw new Error('OS_SHELL_RUNTIME_IMAGE must be the canonical exact-digest runtime image'); return value; }
function database() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL, max: 8 };
  return {
    host: required('PGHOST'), port: Number(process.env.PGPORT || 5432), database: process.env.PGDATABASE || 'postgres',
    user: required('PGUSER'), password: required('PGPASSWORD'), max: 8,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: true } : false,
  };
}

function loadConfig(mode = process.env.OS_SHELL_MODE) {
  if (!['api', 'gateway', 'reconciler'].includes(mode)) throw new Error('OS_SHELL_MODE must be api, gateway, or reconciler');
  const enabled = on('OS_SHELL_CONTROL_ENABLED');
  const config = {
    mode, enabled, attachEnabled: on('OS_SHELL_ATTACH_ENABLED'),
    reconcilerEnabled: on('OS_SHELL_RECONCILER_ENABLED'), registrationEnabled: on('OS_SHELL_RUNTIME_REGISTRATION_ENABLED'),
    runtimeControlEnabled: on('OS_SHELL_RUNTIME_CONTROL_ENABLED'),
    allowLoopbackHttp: on('OS_SHELL_DEV_HTTP_LOOPBACK'), port: Number(process.env.PORT || (mode === 'reconciler' ? 8443 : 8080)),
    database: enabled ? database() : null, admissionSecret: enabled && mode !== 'reconciler' ? required('OS_SHELL_ADMISSION_SECRET') : '',
    worker: process.env.OS_SHELL_WORKER_ID || process.env.HOSTNAME || `shell-${process.pid}`,
    namespace: process.env.OS_SHELL_SESSION_NAMESPACE || 'opensphere-shell-sessions',
    runtimeServiceAccount: process.env.OS_SHELL_RUNTIME_SERVICE_ACCOUNT || 'opensphere-shell-runtime',
    runtimeMaxProcesses: Number(process.env.OS_SHELL_RUNTIME_MAX_PROCESSES || 256),
    runtimeGlobalPodLimit: Number(process.env.OS_SHELL_RUNTIME_GLOBAL_POD_LIMIT || 8),
    runtimeImage: enabled ? runtimeImage() : '',
    runtimeImageDigest: enabled ? `sha256:${required('OS_SHELL_RUNTIME_IMAGE').split('@sha256:')[1]}` : '',
    osArtifactDigest: enabled ? digest('OS_SHELL_OS_ARTIFACT_DIGEST') : '',
    manifestSha256: enabled ? digest('OS_SHELL_MANIFEST_SHA256') : '',
    releaseEvidenceRef: enabled ? required('OS_SHELL_RELEASE_EVIDENCE_REF') : '',
    releaseKeyId: enabled ? required('OS_SHELL_RELEASE_KEY_ID') : '',
    sessionPolicyRevision: enabled ? required('OS_SHELL_SESSION_POLICY_REVISION') : '',
    runtimeTemplateRevision: enabled ? required('OS_SHELL_RUNTIME_TEMPLATE_REVISION') : '',
    registrationURL: process.env.OS_SHELL_REGISTRATION_URL || 'https://opensphere-shell-reconciler.opensphere-console.svc.cluster.local:8443/internal/runtime/register',
    runtimeControlURL: process.env.OS_SHELL_RUNTIME_CONTROL_URL || 'https://opensphere-shell-api.opensphere-console.svc.cluster.local:8443/api/os-shell/runtime',
    consoleAPIURL: process.env.OS_SHELL_CONSOLE_API_URL || 'https://opensphere-shell-console-api.opensphere-console.svc.cluster.local:8445',
    consoleAPIReadinessURL: process.env.OS_SHELL_CONSOLE_API_READINESS_URL || 'https://opensphere-shell-console-api.opensphere-console.svc.cluster.local:8445/readyz',
    gatewayReadinessURL: process.env.OS_SHELL_GATEWAY_READINESS_URL || 'http://opensphere-shell-gateway.opensphere-console.svc.cluster.local:8080/readyz',
    reconcilerReadinessURL: process.env.OS_SHELL_RECONCILER_READINESS_URL || 'http://opensphere-shell-reconciler.opensphere-console.svc.cluster.local:8080/readyz',
    credentialAuthorityReadinessURL: process.env.OS_SHELL_CREDENTIAL_AUTHORITY_READINESS_URL || 'https://opensphere-shell-credential-authority.opensphere-console.svc.cluster.local:8444/readyz',
    tlsCertFile: process.env.OS_SHELL_INTERNAL_TLS_CERT_FILE || '', tlsKeyFile: process.env.OS_SHELL_INTERNAL_TLS_KEY_FILE || '',
    delegationSecret: enabled && mode === 'api' ? required('OS_SHELL_DELEGATION_SECRET') : '',
    consoleBackendURL: process.env.OS_SHELL_CONSOLE_BACKEND_URL || 'https://opensphere-shell-credential-authority.opensphere-console.svc.cluster.local:8444',
    internalCAFile: process.env.OS_SHELL_INTERNAL_CA_FILE || '',
  };
  if (config.runtimeMaxProcesses !== 256) throw new Error('OS_SHELL_RUNTIME_MAX_PROCESSES must be the closed value 256');
  if (config.runtimeGlobalPodLimit !== 8) throw new Error('OS_SHELL_RUNTIME_GLOBAL_POD_LIMIT must be the closed value 8');
  if (enabled && ((mode === 'reconciler' && config.registrationEnabled) || (mode === 'api' && config.runtimeControlEnabled))) {
    if (!config.tlsCertFile || !config.tlsKeyFile || !fs.existsSync(config.tlsCertFile) || !fs.existsSync(config.tlsKeyFile)) {
      throw new Error('runtime registration requires an exact internal HTTPS certificate and private key');
    }
  }
  if (enabled && mode === 'api' && !config.consoleBackendURL.startsWith('https://')) throw new Error('OS Shell credential authority URL must use HTTPS');
  if (enabled && mode === 'api' && (!config.internalCAFile || !fs.existsSync(config.internalCAFile))) throw new Error('OS Shell API requires the internal public CA file');
  return Object.freeze(config);
}

module.exports = { DIGEST, loadConfig };
