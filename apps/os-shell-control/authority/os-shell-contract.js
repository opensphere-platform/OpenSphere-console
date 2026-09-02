'use strict';

const { createHash, randomBytes } = require('node:crypto');

const NETWORK_PROFILE = 'console-only';
const SESSION_CLASS = 'operator-interactive';
const RUNTIME_ADAPTER_ID = 'cbss.kubernetes-pod';
const ATTACH_PROTOCOL = 'opensphere.pty.v1';
const MAX_ATTACH_TICKET_TTL_MS = 30_000;
const EXACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const AUTHORITY_CODE = /^[a-z][a-z0-9_.:-]{2,127}$/;
const SESSION_INTENT_KEYS = new Set(['networkProfile']);
const FORBIDDEN_RUNTIME_KEYS = new Set([
  'args', 'command', 'container', 'containers', 'env', 'envFrom', 'hostIPC', 'hostNetwork',
  'hostPID', 'image', 'imagePullPolicy', 'kubeconfig', 'nodeName', 'nodeSelector', 'podSpec',
  'privileged', 'resourceClaims', 'resources', 'runtimeClass', 'runtimeClassName', 'secret',
  'secrets', 'securityContext', 'serviceAccount', 'serviceAccountName', 'tolerations', 'volume',
  'volumeMounts', 'volumes', 'vmiSpec',
]);
const RELEASE_EVIDENCE_KEYS = new Set([
  'keyId', 'manifestSha256', 'osArtifactDigest', 'releaseEvidenceRef', 'runtimeImageDigest',
  'sessionPolicyRevision',
]);
const RAW_TERMINAL_KEYS = new Set([
  'command', 'commandLine', 'input', 'keystroke', 'output', 'pty', 'raw', 'terminal',
  'terminalBytes', 'terminalStream',
]);

function contractError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw contractError('ContractInvalid', `${label} must be a plain object`);
  }
  return value;
}

function requiredText(value, label, maxLength = 512) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw contractError('ContractInvalid', `${label} is required and must be at most ${maxLength} characters`);
  }
  return normalized;
}

function exactDigest(value, label) {
  const normalized = requiredText(value, label, 80);
  if (!EXACT_DIGEST.test(normalized)) throw contractError('ContractInvalid', `${label} must be an exact SHA-256 digest`);
  return normalized;
}

function normalizeSessionIntent(input) {
  const value = plainObject(input, 'SessionIntent');
  const keys = Object.keys(value);
  const injected = keys.filter((key) => FORBIDDEN_RUNTIME_KEYS.has(key)).sort();
  if (injected.length) {
    throw contractError('PrivilegeEscalationAttempt', `SessionIntent cannot supply runtime fields: ${injected.join(', ')}`, 403);
  }
  const unknown = keys.filter((key) => !SESSION_INTENT_KEYS.has(key)).sort();
  if (unknown.length) {
    throw contractError('SessionIntentContractViolation', `unknown SessionIntent fields: ${unknown.join(', ')}`);
  }
  const networkProfile = value.networkProfile === undefined
    ? NETWORK_PROFILE
    : requiredText(value.networkProfile, 'networkProfile', 64);
  if (networkProfile !== NETWORK_PROFILE) {
    throw contractError('NetworkProfileUnavailable', 'only console-only is admitted', 403);
  }
  return Object.freeze({ networkProfile: NETWORK_PROFILE });
}

function normalizeOrigin(input, { allowLoopbackHttp = false } = {}) {
  const value = requiredText(input, 'origin', 512);
  let url;
  try { url = new URL(value); } catch { throw contractError('OriginInvalid', 'origin must be an absolute URL', 403); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw contractError('OriginInvalid', 'origin must contain only scheme, host, and optional port', 403);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) {
    throw contractError('OriginInvalid', 'production shell origins require HTTPS', 403);
  }
  return url.origin;
}

function normalizeCodes(values, label) {
  if (!Array.isArray(values)) throw contractError('AuthorityProjectionInvalid', `${label} must be an array`, 503);
  const normalized = values.map((value) => requiredText(value, label, 128));
  if (normalized.some((value) => !AUTHORITY_CODE.test(value))) {
    throw contractError('AuthorityProjectionInvalid', `${label} contains an invalid code`, 503);
  }
  return [...new Set(normalized)].sort();
}

function permissionRevisionPayload(input) {
  const value = plainObject(input, 'authority projection');
  const credentialRevision = Number(value.credentialRevision);
  if (!Number.isSafeInteger(credentialRevision) || credentialRevision < 1) {
    throw contractError('AuthorityProjectionInvalid', 'credentialRevision must be a positive integer', 503);
  }
  const roles = normalizeCodes(value.roles, 'roles');
  const permissions = normalizeCodes(value.permissions, 'permissions');
  return `credentialRevision=${credentialRevision}\nroles=${roles.join('\x1f')}\npermissions=${permissions.join('\x1f')}`;
}

function canonicalPermissionRevision(input) {
  return `sha256:${createHash('sha256').update(permissionRevisionPayload(input), 'utf8').digest('hex')}`;
}

function createAttachTicket() {
  const ticket = randomBytes(32).toString('base64url');
  return Object.freeze({ ticket, ticketHash: hashAttachTicket(ticket) });
}

function hashAttachTicket(ticket) {
  const normalized = requiredText(ticket, 'attach ticket', 128);
  let decoded;
  try { decoded = Buffer.from(normalized, 'base64url'); } catch { decoded = Buffer.alloc(0); }
  if (decoded.length !== 32 || decoded.toString('base64url') !== normalized) {
    throw contractError('AttachTicketInvalid', 'attach ticket must contain exactly 256 random bits', 401);
  }
  return `sha256:${createHash('sha256').update(decoded).digest('hex')}`;
}

function normalizeAttachTicketExpiry(expiresAt, { now = Date.now() } = {}) {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + MAX_ATTACH_TICKET_TTL_MS) {
    throw contractError('AttachTicketExpiryInvalid', 'attach ticket TTL must be greater than zero and at most 30 seconds');
  }
  return new Date(expiry).toISOString();
}

function normalizeReleaseEvidence(input) {
  const value = plainObject(input, 'release evidence');
  const unknown = Object.keys(value).filter((key) => !RELEASE_EVIDENCE_KEYS.has(key));
  if (unknown.length) throw contractError('ReleaseEvidenceInvalid', `unknown release evidence fields: ${unknown.sort().join(', ')}`);
  return Object.freeze({
    releaseEvidenceRef: requiredText(value.releaseEvidenceRef, 'releaseEvidenceRef', 512),
    manifestSha256: exactDigest(value.manifestSha256, 'manifestSha256'),
    keyId: requiredText(value.keyId, 'keyId', 128),
    runtimeImageDigest: exactDigest(value.runtimeImageDigest, 'runtimeImageDigest'),
    osArtifactDigest: exactDigest(value.osArtifactDigest, 'osArtifactDigest'),
    sessionPolicyRevision: requiredText(value.sessionPolicyRevision, 'sessionPolicyRevision', 128),
  });
}

function assertLifecycleEventSafe(input) {
  const value = plainObject(input, 'shell lifecycle event');
  const forbidden = Object.keys(value).filter((key) => RAW_TERMINAL_KEYS.has(key)).sort();
  if (forbidden.length) {
    throw contractError('RawTerminalAuditForbidden', `lifecycle audit cannot contain: ${forbidden.join(', ')}`, 403);
  }
  return value;
}

module.exports = {
  ATTACH_PROTOCOL,
  MAX_ATTACH_TICKET_TTL_MS,
  NETWORK_PROFILE,
  RUNTIME_ADAPTER_ID,
  SESSION_CLASS,
  assertLifecycleEventSafe,
  canonicalPermissionRevision,
  contractError,
  createAttachTicket,
  hashAttachTicket,
  normalizeAttachTicketExpiry,
  normalizeOrigin,
  normalizeReleaseEvidence,
  normalizeSessionIntent,
  permissionRevisionPayload,
};
