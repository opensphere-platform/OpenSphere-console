'use strict';

const {
  createHash,
  createHmac,
  randomBytes: secureRandomBytes,
  timingSafeEqual,
} = require('node:crypto');

const CONSOLE_ONLY = 'console-only';
const SESSION_INTENT_KEYS = new Set(['networkProfile']);
const PODSPEC_INJECTION_KEYS = new Set([
  'image',
  'command',
  'args',
  'env',
  'volume',
  'volumes',
  'volumeMounts',
  'serviceAccount',
  'serviceAccountName',
  'podSpec',
  'hostNetwork',
  'hostPID',
  'hostIPC',
  'privileged',
]);
const SECRET_QUERY_KEYS = new Set([
  'access_token',
  'authorization',
  'bearer',
  'credential',
  'id_token',
  'refresh_token',
  'token',
]);
const AUDIT_EVENTS = new Set([
  'SessionRequested',
  'SessionCreated',
  'SessionAttached',
  'SessionDetached',
  'SessionReconnected',
  'SessionTerminated',
  'SessionForceTerminated',
  'CredentialIssued',
  'CredentialRevoked',
  'PolicyDenied',
  'QuotaExceeded',
]);
const AUDIT_KEYS = new Set([
  'eventType',
  'actorId',
  'sessionId',
  'networkProfile',
  'runtimeImageDigest',
  'osArtifactDigest',
  'correlationId',
  'result',
  'reason',
  'at',
]);
const RAW_TERMINAL_KEYS = new Set([
  'command',
  'commandLine',
  'input',
  'keystroke',
  'output',
  'pty',
  'raw',
  'terminal',
  'terminalBytes',
  'terminalStream',
]);
const EXACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const STABLE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const CONTEXT_KEYS = new Set([
  'version',
  'sessionId',
  'actorId',
  'origin',
  'executionProfile',
  'nonce',
  'issuedAt',
  'expiresAt',
  'signature',
]);

function contractError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw contractError('ContractInvalid', `${label} must be a plain object`);
  }
  return value;
}

function requireText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw contractError('ContractInvalid', `${label} is required`);
  return normalized;
}

/**
 * Browser input is intentionally smaller than the server-owned runtime policy.
 * No field from this value may be copied into a PodSpec except the selected,
 * pre-admitted network profile identifier.
 */
function normalizeSessionIntent(input) {
  const value = requirePlainObject(input, 'SessionIntent');
  const keys = Object.keys(value);
  const injected = keys.filter((key) => PODSPEC_INJECTION_KEYS.has(key));
  if (injected.length) {
    throw contractError(
      'PrivilegeEscalationAttempt',
      `SessionIntent cannot supply runtime fields: ${injected.sort().join(', ')}`,
      403,
    );
  }
  const unknown = keys.filter((key) => !SESSION_INTENT_KEYS.has(key));
  if (unknown.length) {
    throw contractError('SessionIntentContractViolation', `unknown SessionIntent fields: ${unknown.sort().join(', ')}`);
  }
  const networkProfile = value.networkProfile === undefined
    ? CONSOLE_ONLY
    : requireText(value.networkProfile, 'networkProfile');
  if (networkProfile !== CONSOLE_ONLY) {
    throw contractError('NetworkProfileUnavailable', 'only the console-only network profile is admitted', 403);
  }
  return Object.freeze({ networkProfile: CONSOLE_ONLY });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function signaturePayload(context) {
  return [
    'opensphere-web-shell-context-v1',
    `sessionId=${context.sessionId}`,
    `actorId=${context.actorId}`,
    `origin=${context.origin}`,
    `executionProfile=${context.executionProfile}`,
    `nonce=${context.nonce}`,
    `issuedAt=${context.issuedAt}`,
    `expiresAt=${context.expiresAt}`,
  ].join('\n');
}

function safeSignatureEqual(expected, actual) {
  let left;
  let right;
  try {
    left = Buffer.from(String(expected || ''), 'base64url');
    right = Buffer.from(String(actual || ''), 'base64url');
  } catch {
    return false;
  }
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Only the trusted Broker/credential agent owns this attestation key. Shell
 * flags, environment variables, and user-written context files are therefore
 * unable to turn a Web Shell session into a desktop/local-host profile.
 */
function createWebShellContextAuthority({ key, now = () => Date.now(), ttlMs = 5 * 60_000, randomBytes = secureRandomBytes } = {}) {
  const secret = Buffer.isBuffer(key) ? Buffer.from(key) : Buffer.from(String(key || ''), 'base64');
  if (secret.length < 32) throw contractError('ContractInvalid', 'context attestation key must contain at least 32 bytes');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 10 * 60_000) {
    throw contractError('ContractInvalid', 'context TTL must be between 1 and 600000 milliseconds');
  }

  const sign = (context) => createHmac('sha256', secret)
    .update(signaturePayload(context), 'utf8')
    .digest('base64url');

  return Object.freeze({
    issue(binding) {
      const value = requirePlainObject(binding, 'Web Shell context binding');
      const issuedAt = now();
      const context = {
        version: 'web-shell-context-v1',
        sessionId: requireText(value.sessionId, 'sessionId'),
        actorId: requireText(value.actorId, 'actorId'),
        origin: normalizeOrigin(value.origin),
        executionProfile: 'web-shell',
        nonce: randomBytes(24).toString('base64url'),
        issuedAt,
        expiresAt: issuedAt + ttlMs,
      };
      return Object.freeze({ ...context, signature: sign(context) });
    },

    verify(attestation, expectedBinding) {
      const context = requirePlainObject(attestation, 'attested Web Shell context');
      const keys = Object.keys(context);
      if (
        keys.length !== CONTEXT_KEYS.size
        || keys.some((field) => !CONTEXT_KEYS.has(field))
        || [...CONTEXT_KEYS].some((field) => !Object.hasOwn(context, field) || context[field] === undefined)
      ) {
        throw contractError('WebShellContextInvalid', 'attested context has unknown or missing fields', 403);
      }
      if (context.version !== 'web-shell-context-v1' || context.executionProfile !== 'web-shell') {
        throw contractError('WebShellContextInvalid', 'attested context is not a Web Shell profile', 403);
      }
      if (!Number.isSafeInteger(context.issuedAt) || !Number.isSafeInteger(context.expiresAt) || context.expiresAt <= context.issuedAt) {
        throw contractError('WebShellContextInvalid', 'attested context lifetime is invalid', 403);
      }
      if (context.expiresAt <= now()) throw contractError('WebShellContextExpired', 'attested context has expired', 401);
      if (!safeSignatureEqual(sign(context), context.signature)) {
        throw contractError('WebShellContextInvalid', 'attested context signature is invalid', 403);
      }

      const expected = requirePlainObject(expectedBinding, 'expected Web Shell binding');
      const sessionId = requireText(expected.sessionId, 'sessionId');
      const actorId = requireText(expected.actorId, 'actorId');
      const origin = normalizeOrigin(expected.origin);
      if (context.sessionId !== sessionId || context.actorId !== actorId || context.origin !== origin) {
        throw contractError('WebShellContextBindingMismatch', 'attested context does not match session, actor, and origin', 403);
      }
      return Object.freeze({ sessionId, actorId, origin, executionProfile: 'web-shell', expiresAt: context.expiresAt });
    },
  });
}

/**
 * In-memory atomicity seam for the PoC. A production store must provide the
 * same consume-once transition durably across gateway replicas.
 */
function createAttachTicketStore({ now = () => Date.now(), ttlMs = 30_000, randomBytes = secureRandomBytes } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 60_000) {
    throw contractError('ContractInvalid', 'attach ticket TTL must be between 1 and 60000 milliseconds');
  }
  const tickets = new Map();

  return Object.freeze({
    issue(binding) {
      const value = requirePlainObject(binding, 'attach ticket binding');
      const sessionId = requireText(value.sessionId, 'sessionId');
      const actorId = requireText(value.actorId, 'actorId');
      const origin = normalizeOrigin(value.origin);
      const ticket = randomBytes(32).toString('base64url');
      const expiresAt = now() + ttlMs;
      tickets.set(sha256(ticket), Object.freeze({ sessionId, actorId, origin, expiresAt }));
      return Object.freeze({ ticket, expiresAt });
    },

    consume(ticket, binding) {
      const digest = sha256(requireText(ticket, 'attach ticket'));
      const record = tickets.get(digest);
      // Delete before validation so success, expiry, and a mismatched replay
      // all have one atomic terminal transition.
      tickets.delete(digest);
      if (!record) throw contractError('AttachTicketInvalid', 'attach ticket is invalid or already consumed', 401);
      if (record.expiresAt <= now()) throw contractError('AttachTicketExpired', 'attach ticket has expired', 401);

      const value = requirePlainObject(binding, 'attach binding');
      const sessionId = requireText(value.sessionId, 'sessionId');
      const actorId = requireText(value.actorId, 'actorId');
      const origin = normalizeOrigin(value.origin);
      if (record.sessionId !== sessionId || record.actorId !== actorId || record.origin !== origin) {
        throw contractError('AttachTicketBindingMismatch', 'attach ticket does not match session, actor, and origin', 403);
      }
      return Object.freeze({ sessionId, actorId, origin });
    },

    size() {
      return tickets.size;
    },
  });
}

function normalizeOrigin(value) {
  const text = requireText(value, 'origin');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw contractError('OriginInvalid', 'origin must be an absolute HTTP(S) origin', 403);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw contractError('OriginInvalid', 'origin must contain only scheme, host, and port', 403);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !loopback) {
    throw contractError('OriginInvalid', 'non-loopback Web Shell origins must use HTTPS', 403);
  }
  return url.origin;
}

/**
 * Returns a credential-free forwarding descriptor. The delegated bearer stays
 * inside the credential agent and is never returned to the shell process.
 */
function credentialFreeForwardingDescriptor({ consoleOrigin, targetUrl, method = 'GET' }) {
  const allowedOrigin = normalizeOrigin(consoleOrigin);
  let target;
  try {
    target = new URL(requireText(targetUrl, 'targetUrl'), `${allowedOrigin}/`);
  } catch {
    throw contractError('CredentialAgentTargetInvalid', 'credential agent target is invalid', 403);
  }
  if (target.origin !== allowedOrigin || target.username || target.password) {
    throw contractError('CredentialAgentOriginDenied', 'credential agent only forwards to the Console origin', 403);
  }
  for (const key of target.searchParams.keys()) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
      throw contractError('CredentialInUrlDenied', 'credential material is forbidden in URL query parameters', 403);
    }
  }
  const normalizedMethod = requireText(method, 'method').toUpperCase();
  if (!/^[A-Z]+$/.test(normalizedMethod)) throw contractError('CredentialAgentMethodInvalid', 'HTTP method is invalid');
  return Object.freeze({
    method: normalizedMethod,
    url: target.href,
    attachDelegatedCredential: true,
  });
}

/**
 * Credential-agent admission is bound to an attested session/user/origin and
 * a one-use request nonce. It returns routing metadata only, never a bearer.
 */
function createCredentialAgentAuthorizer({ contextAuthority, now = () => Date.now(), maxReplayEntries = 4096 } = {}) {
  if (!contextAuthority || typeof contextAuthority.verify !== 'function') {
    throw contractError('ContractInvalid', 'credential agent requires a Web Shell context authority');
  }
  if (!Number.isSafeInteger(maxReplayEntries) || maxReplayEntries < 1 || maxReplayEntries > 65_536) {
    throw contractError('ContractInvalid', 'credential agent replay cache bound is invalid');
  }
  const consumed = new Map();

  return Object.freeze({
    authorize(input) {
      const value = requirePlainObject(input, 'credential agent request');
      const binding = contextAuthority.verify(value.attestedContext, value.expectedBinding);
      const consoleOrigin = normalizeOrigin(value.consoleOrigin);
      if (consoleOrigin !== binding.origin) {
        throw contractError('CredentialAgentBindingMismatch', 'Console origin does not match the attested session origin', 403);
      }
      const requestNonce = requireText(value.requestNonce, 'requestNonce');
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(requestNonce)) {
        throw contractError('CredentialAgentNonceInvalid', 'request nonce format is invalid', 400);
      }
      for (const [key, expiresAt] of consumed) if (expiresAt <= now()) consumed.delete(key);
      const replayKey = sha256(`${binding.sessionId}\0${binding.actorId}\0${requestNonce}`);
      if (consumed.has(replayKey)) {
        throw contractError('CredentialAgentReplayDenied', 'credential agent request nonce was already consumed', 409);
      }
      if (consumed.size >= maxReplayEntries) {
        throw contractError('CredentialAgentReplayCacheFull', 'credential agent replay cache is at its fail-closed bound', 429);
      }
      // Consume before target validation so every admitted nonce has one
      // terminal transition even when the requested URL is forbidden.
      consumed.set(replayKey, binding.expiresAt);
      const descriptor = credentialFreeForwardingDescriptor({
        consoleOrigin,
        targetUrl: value.targetUrl,
        method: value.method,
      });
      return Object.freeze({
        ...descriptor,
        sessionId: binding.sessionId,
        actorId: binding.actorId,
      });
    },

    replayEntryCount() {
      return consumed.size;
    },
  });
}

function createSessionAuditEvent(input) {
  const value = requirePlainObject(input, 'session audit event');
  const keys = Object.keys(value);
  const rawFields = keys.filter((key) => RAW_TERMINAL_KEYS.has(key));
  if (rawFields.length) {
    throw contractError('RawTerminalAuditDenied', `raw terminal audit fields are forbidden: ${rawFields.sort().join(', ')}`);
  }
  const unknown = keys.filter((key) => !AUDIT_KEYS.has(key));
  if (unknown.length) throw contractError('AuditContractViolation', `unknown audit fields: ${unknown.sort().join(', ')}`);

  const eventType = requireText(value.eventType, 'eventType');
  if (!AUDIT_EVENTS.has(eventType)) throw contractError('AuditContractViolation', `unsupported lifecycle audit event: ${eventType}`);
  if (value.networkProfile !== CONSOLE_ONLY) {
    throw contractError('AuditContractViolation', 'session audit network profile must be console-only');
  }
  const result = requireText(value.result, 'result');
  if (!['allowed', 'denied', 'succeeded', 'failed'].includes(result)) {
    throw contractError('AuditContractViolation', 'session audit result is not a semantic result');
  }
  const reason = value.reason ? requireText(value.reason, 'reason') : null;
  if (reason && !STABLE_CODE.test(reason)) {
    throw contractError('AuditContractViolation', 'session audit reason must be a stable code');
  }
  const runtimeImageDigest = requireDigest(value.runtimeImageDigest, 'runtimeImageDigest');
  const osArtifactDigest = requireDigest(value.osArtifactDigest, 'osArtifactDigest');
  const at = requireText(value.at, 'at');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(at) || !Number.isFinite(Date.parse(at))) {
    throw contractError('AuditContractViolation', 'session audit timestamp must be RFC3339 UTC');
  }
  return Object.freeze({
    eventType,
    actorId: requireText(value.actorId, 'actorId'),
    sessionId: requireText(value.sessionId, 'sessionId'),
    networkProfile: CONSOLE_ONLY,
    runtimeImageDigest,
    osArtifactDigest,
    correlationId: requireText(value.correlationId, 'correlationId'),
    result,
    reason,
    at,
  });
}

function requireDigest(value, label) {
  const digest = requireText(value, label);
  if (!EXACT_DIGEST.test(digest)) throw contractError('MutableArtifactDenied', `${label} must be an exact sha256 digest`, 403);
  return digest;
}

function semanticIdentity(command) {
  const declared = command.semanticIdentity && typeof command.semanticIdentity === 'object' && !Array.isArray(command.semanticIdentity)
    ? command.semanticIdentity
    : {};
  const identity = {
    capabilityId: String(command.capabilityId || declared.capabilityId || '').trim(),
    actionId: String(command.actionId || declared.actionId || '').trim(),
    toolId: String(command.toolId || command.id || declared.toolId || '').trim(),
  };
  for (const field of ['capabilityId', 'actionId', 'toolId']) {
    if (!identity[field] || !STABLE_CODE.test(identity[field])) {
      return { ok: false, reasonCode: 'WebShellSemanticIdentityInvalid', blocker: `${field} is absent or invalid` };
    }
    if (declared[field] !== undefined && String(declared[field]) !== identity[field]) {
      return { ok: false, reasonCode: 'WebShellSemanticIdentityMismatch', blocker: `${field} conflicts with semanticIdentity` };
    }
  }
  return { ok: true, ...identity };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function schemaDigest(schema) {
  return sha256(JSON.stringify(canonicalValue(schema)));
}

function closedSchemaError(schema, path = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return `${path} schema must be an object`;
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) return `${path}.additionalProperties must be false`;
    const properties = schema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return `${path}.properties must be an object`;
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((field) => !Object.hasOwn(properties, field))) return `${path}.required references an unknown property`;
    for (const [field, child] of Object.entries(properties)) {
      const error = closedSchemaError(child, `${path}.${field}`);
      if (error) return error;
    }
    return '';
  }
  if (schema.type === 'array') {
    if (!schema.items) return `${path}.items is required`;
    return closedSchemaError(schema.items, `${path}[]`);
  }
  if (!['string', 'boolean', 'integer', 'number'].includes(schema.type)) return `${path}.type is unsupported`;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) return `${path}.enum is invalid`;
  return '';
}

function requestSchemaError(schema, value, path = '$') {
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) return `${path} is outside the declared enum`;
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        return `${path} must be an object`;
      }
      const properties = schema.properties || {};
      const unknown = Object.keys(value).find((field) => !Object.hasOwn(properties, field));
      if (unknown) return `${path}.${unknown} is not allowed`;
      const missing = (schema.required || []).find((field) => !Object.hasOwn(value, field));
      if (missing) return `${path}.${missing} is required`;
      for (const [field, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, field)) continue;
        const error = requestSchemaError(child, value[field], `${path}.${field}`);
        if (error) return error;
      }
      return '';
    }
    case 'array':
      if (!Array.isArray(value)) return `${path} must be an array`;
      for (let index = 0; index < value.length; index += 1) {
        const error = requestSchemaError(schema.items, value[index], `${path}[${index}]`);
        if (error) return error;
      }
      return '';
    case 'string': return typeof value === 'string' ? '' : `${path} must be a string`;
    case 'boolean': return typeof value === 'boolean' ? '' : `${path} must be a boolean`;
    case 'integer': return Number.isInteger(value) ? '' : `${path} must be an integer`;
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? '' : `${path} must be a finite number`;
    default: return `${path} has an unsupported schema type`;
  }
}

/**
 * Server policy, not the owner manifest, owns this allow-list. An owner may
 * advertise availability, but admission succeeds only when semantic identity
 * and the entire closed request schema match a pre-approved entry.
 */
function createWebShellActionPolicy(entries = []) {
  if (!Array.isArray(entries)) throw contractError('ContractInvalid', 'Web Shell action policy must be an array');
  const allowed = new Map();
  for (const raw of entries) {
    const entry = requirePlainObject(raw, 'Web Shell action policy entry');
    const identity = semanticIdentity(entry);
    if (!identity.ok) throw contractError('ContractInvalid', identity.blocker);
    const requestSchema = requirePlainObject(entry.requestSchema, 'policy requestSchema');
    const schemaError = closedSchemaError(requestSchema);
    if (schemaError) throw contractError('ContractInvalid', `policy requestSchema is not closed: ${schemaError}`);
    const key = `${identity.capabilityId}\0${identity.actionId}\0${identity.toolId}`;
    if (allowed.has(key)) throw contractError('ContractInvalid', 'duplicate Web Shell policy semantic identity');
    allowed.set(key, Object.freeze({
      ...identity,
      requestSchema: canonicalValue(requestSchema),
      requestSchemaDigest: schemaDigest(requestSchema),
    }));
  }

  return Object.freeze({
    admit(command, request) {
      const identity = semanticIdentity(command);
      if (!identity.ok) return identity;
      const key = `${identity.capabilityId}\0${identity.actionId}\0${identity.toolId}`;
      const policy = allowed.get(key);
      if (!policy) {
        return { ok: false, reasonCode: 'WebShellActionNotAllowed', blocker: 'semantic action identity is not in the Web Shell policy allow-list' };
      }
      const ownerSchema = command.inputSchema;
      const closedError = closedSchemaError(ownerSchema);
      if (closedError) {
        return { ok: false, reasonCode: 'WebShellOwnerRequestSchemaOpen', blocker: `owner request schema is not closed: ${closedError}` };
      }
      if (schemaDigest(ownerSchema) !== policy.requestSchemaDigest) {
        return { ok: false, reasonCode: 'WebShellRequestSchemaMismatch', blocker: 'owner request schema does not match the policy allow-list' };
      }
      const requestError = requestSchemaError(policy.requestSchema, request);
      if (requestError) {
        return { ok: false, reasonCode: 'WebShellRequestDenied', blocker: requestError };
      }
      return { ok: true, capabilityId: identity.capabilityId, actionId: identity.actionId, toolId: identity.toolId };
    },
  });
}

function unsupported(executionClass, reasonCode, blocker) {
  return Object.freeze({
    available: false,
    executionClass,
    failureCode: 'UnsupportedInWebShell',
    reasonCode,
    blocker,
    guidance: blocker,
  });
}

/**
 * The Web Shell consumes, but never invents, command availability. Domain
 * guidance (including PFSS/PostgreSQL guidance) is passed through from the
 * Console-native os command contract.
 */
function evaluateWebShellCommand(command, {
  contextAuthority,
  attestedContext,
  expectedBinding,
  actionPolicy,
  request = {},
} = {}) {
  if (!contextAuthority || typeof contextAuthority.verify !== 'function') {
    throw contractError('ContractInvalid', 'command policy requires a Web Shell context authority');
  }
  contextAuthority.verify(attestedContext, expectedBinding);
  const value = requirePlainObject(command, 'os command contract');
  const executionClass = typeof value.executionClass === 'string' && value.executionClass.trim()
    ? value.executionClass.trim()
    : 'unknown';
  const declared = value.webShell && typeof value.webShell === 'object' && !Array.isArray(value.webShell)
    ? value.webShell
    : {};
  if (executionClass !== 'console-api') {
    return unsupported(executionClass, 'WebShellExecutionClassDenied', 'executionClass must be console-api');
  }
  if (declared.available !== true) {
    const availabilityType = Object.hasOwn(declared, 'available') ? typeof declared.available : 'absent';
    const reasonCode = declared.available === false
      ? 'OwnerWebShellUnavailable'
      : availabilityType === 'absent' ? 'OwnerWebShellAvailabilityNotDeclared' : 'OwnerWebShellAvailabilityInvalid';
    const blocker = typeof declared.reason === 'string' && declared.reason.trim()
      ? declared.reason.trim()
      : 'Owner manifest did not explicitly declare Web Shell availability.';
    return unsupported(executionClass, reasonCode, blocker);
  }
  if (!actionPolicy || typeof actionPolicy.admit !== 'function') {
    return unsupported(executionClass, 'WebShellPolicyUnavailable', 'Web Shell action policy is unavailable');
  }
  const admission = actionPolicy.admit(value, request);
  if (!admission.ok) return unsupported(executionClass, admission.reasonCode, admission.blocker);
  return Object.freeze({
    available: true,
    executionClass,
    capabilityId: admission.capabilityId,
    actionId: admission.actionId,
    toolId: admission.toolId,
  });
}

module.exports = {
  createAttachTicketStore,
  createCredentialAgentAuthorizer,
  createSessionAuditEvent,
  createWebShellContextAuthority,
  createWebShellActionPolicy,
  evaluateWebShellCommand,
  normalizeSessionIntent,
};
