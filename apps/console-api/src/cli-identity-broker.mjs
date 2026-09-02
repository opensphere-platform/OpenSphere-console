import {
  createHash, createPublicKey, randomBytes as systemRandomBytes, verify as verifySignature,
} from 'node:crypto';

const ENROLLMENT_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_MS = 60 * 1000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function identifier(value, label) {
  const id = String(value || '');
  if (!UUID.test(id)) fail('ValidationFailed', `CLI ${label} is invalid`, 400);
  return id;
}

function label(value) {
  const normalized = String(value || '').trim();
  if (normalized.length < 1 || normalized.length > 128 || /[\r\n\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('ValidationFailed', 'CLI device label is invalid', 400);
  }
  return normalized;
}

function reason(value) {
  const normalized = String(value || '').trim();
  if (normalized.length < 8 || normalized.length > 500 || /[\r\n]/u.test(normalized)) {
    fail('ValidationFailed', 'CLI credential reason is invalid', 400);
  }
  return normalized;
}

function exactBody(body, keys, name) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !keys.includes(key))
      || keys.some((key) => !Object.hasOwn(body, key))) {
    fail('ValidationFailed', `${name} body is invalid`, 400);
  }
  return body;
}

function publicJwk(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['crv', 'kty', 'x', 'y'])
      || value.kty !== 'EC' || value.crv !== 'P-256'
      || typeof value.x !== 'string' || typeof value.y !== 'string'
      || value.x.length !== 43 || value.y.length !== 43
      || !BASE64URL.test(value.x) || !BASE64URL.test(value.y)) {
    fail('ValidationFailed', 'a closed P-256 publicJwk is required', 400);
  }
  const normalized = Object.freeze({ kty: 'EC', crv: 'P-256', x: value.x, y: value.y });
  try {
    createPublicKey({ key: normalized, format: 'jwk' });
  } catch {
    fail('ValidationFailed', 'P-256 publicJwk is invalid', 400);
  }
  return normalized;
}

function fingerprint(jwk) {
  return createHash('sha256')
    .update(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }), 'utf8')
    .digest('hex').match(/.{2}/gu).join(':');
}

function enrollmentCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-F0-9]{8}$/u.test(code)) fail('ValidationFailed', 'CLI enrollment code is invalid', 400);
  return code;
}

function pollToken(value) {
  const token = String(value || '');
  if (token.length < 32 || token.length > 128 || !BASE64URL.test(token)) {
    fail('ValidationFailed', 'CLI enrollment poll token is invalid', 400);
  }
  return token;
}

function bearerToken(request) {
  const authorization = String(request?.headers?.authorization || '');
  const match = /^Bearer ([A-Za-z0-9_-]{32,512})$/u.exec(authorization);
  return match?.[1] || null;
}

function nonce(value) {
  const token = String(value || '');
  if (token.length !== 43 || !BASE64URL.test(token)) fail('ValidationFailed', 'CLI challenge nonce is invalid', 400);
  return token;
}

function signature(value) {
  const encoded = String(value || '');
  if (encoded.length < 80 || encoded.length > 128 || !BASE64URL.test(encoded)) {
    fail('ValidationFailed', 'CLI device signature is invalid', 400);
  }
  return encoded;
}

function sessionInput(value) {
  exactBody(value, ['deviceId', 'challengeId', 'nonce', 'signature'], 'CLI session');
  return Object.freeze({
    deviceId: identifier(value.deviceId, 'device id'),
    challengeId: identifier(value.challengeId, 'challenge id'),
    nonce: nonce(value.nonce),
    signature: signature(value.signature),
  });
}

export function createCliIdentityBroker({
  store,
  resolveSession,
  publicOrigin,
  randomBytes = systemRandomBytes,
  clock = () => new Date(),
} = {}) {
  const required = [
    'createCliDeviceEnrollment', 'getCliDeviceEnrollment', 'approveCliDeviceEnrollment',
    'pollCliDeviceEnrollment', 'createCliDeviceChallenge', 'getCliDeviceChallenge',
    'completeCliDeviceSession', 'listOwnedCliDevices', 'revokeOwnedCliDevice',
    'listOwnedCliDevicesWithCliSession', 'revokeOwnedCliDeviceWithCliSession',
  ];
  if (!store || required.some((method) => typeof store[method] !== 'function')) {
    throw new TypeError('CLI identity-capable authority store is required');
  }
  if (typeof resolveSession !== 'function') throw new TypeError('CLI identity browser-session resolver is required');
  let origin;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new TypeError('CLI identity public origin is invalid');
  }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new TypeError('CLI identity public origin must be an HTTPS origin');
  }

  return Object.freeze({
    async createEnrollment({ body }) {
      exactBody(body, ['label', 'publicJwk'], 'CLI enrollment');
      const deviceLabel = label(body.label);
      const jwk = publicJwk(body.publicJwk);
      const userCode = randomBytes(4).toString('hex').toUpperCase();
      const enrollmentPollToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(clock().getTime() + ENROLLMENT_TTL_MS).toISOString();
      const created = await store.createCliDeviceEnrollment({
        label: deviceLabel,
        publicJwk: jwk,
        fingerprint: fingerprint(jwk),
        userCodeDigest: digest(userCode),
        pollTokenDigest: digest(enrollmentPollToken),
        expiresAt,
      });
      const verification = new URL('/me', origin);
      verification.searchParams.set('tab', 'credentials');
      verification.searchParams.set('cli_enrollment', created.enrollmentId);
      verification.searchParams.set('code', userCode);
      return Object.freeze({
        enrollmentId: created.enrollmentId,
        pollToken: enrollmentPollToken,
        userCode,
        verificationUriComplete: verification.toString(),
        expiresAt: new Date(created.expiresAt).toISOString(),
        pollInterval: 2,
      });
    },

    async getEnrollment(request, { enrollmentId, userCode }) {
      const session = await resolveSession(request, { requireCsrf: false });
      return store.getCliDeviceEnrollment({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        expectedPermissionRevision: session.permissionRevision,
        expectedRevokeEpoch: session.revokeEpoch,
        enrollmentId: identifier(enrollmentId, 'enrollment id'),
        userCodeDigest: digest(enrollmentCode(userCode)),
      });
    },

    async approveEnrollment(request, { enrollmentId, body, correlationId }) {
      exactBody(body, ['userCode'], 'CLI enrollment approval');
      const session = await resolveSession(request, { requireCsrf: true, correlationId });
      return store.approveCliDeviceEnrollment({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        expectedPermissionRevision: session.permissionRevision,
        expectedRevokeEpoch: session.revokeEpoch,
        enrollmentId: identifier(enrollmentId, 'enrollment id'),
        userCodeDigest: digest(enrollmentCode(body.userCode)),
        correlationId,
      });
    },

    async pollEnrollment({ enrollmentId, body }) {
      exactBody(body, ['pollToken'], 'CLI enrollment poll');
      return store.pollCliDeviceEnrollment({
        enrollmentId: identifier(enrollmentId, 'enrollment id'),
        pollTokenDigest: digest(pollToken(body.pollToken)),
      });
    },

    async createChallenge({ body }) {
      exactBody(body, ['deviceId'], 'CLI challenge');
      const deviceId = identifier(body.deviceId, 'device id');
      const challengeNonce = randomBytes(32).toString('base64url');
      const expiresAt = new Date(clock().getTime() + CHALLENGE_TTL_MS).toISOString();
      const created = await store.createCliDeviceChallenge({
        deviceId, nonceDigest: digest(challengeNonce), expiresAt,
      });
      return Object.freeze({
        challengeId: created.challengeId,
        nonce: challengeNonce,
        expiresAt: new Date(created.expiresAt).toISOString(),
      });
    },

    async createSession({ body, correlationId }) {
      const input = sessionInput(body);
      const proof = await store.getCliDeviceChallenge({
        deviceId: input.deviceId,
        challengeId: input.challengeId,
        nonceDigest: digest(input.nonce),
      });
      const message = `opensphere-cli-session-v2\n${input.deviceId}\n${input.challengeId}\n${input.nonce}`;
      let verified = false;
      try {
        verified = verifySignature(
          'sha256', Buffer.from(message, 'utf8'),
          createPublicKey({ key: proof.publicJwk, format: 'jwk' }),
          Buffer.from(input.signature, 'base64url'),
        );
      } catch {
        verified = false;
      }
      if (!verified) fail('AuthenticationRequired', 'CLI device signature was rejected', 401);
      const accessToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(clock().getTime() + SESSION_TTL_MS).toISOString();
      await store.completeCliDeviceSession({
        deviceId: input.deviceId,
        challengeId: input.challengeId,
        nonceDigest: digest(input.nonce),
        tokenDigest: digest(accessToken),
        expiresAt,
        correlationId,
      });
      return Object.freeze({ accessToken, expiresIn: SESSION_TTL_MS / 1000 });
    },

    async listDevices(request) {
      const token = bearerToken(request);
      if (token) return store.listOwnedCliDevicesWithCliSession({ tokenDigest: digest(token) });
      const session = await resolveSession(request, { requireCsrf: false });
      return store.listOwnedCliDevices({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        expectedPermissionRevision: session.permissionRevision,
        expectedRevokeEpoch: session.revokeEpoch,
      });
    },

    async revokeDevice(request, { deviceId, body, correlationId }) {
      exactBody(body, ['reason'], 'CLI device revocation');
      const targetDeviceId = identifier(deviceId, 'device id');
      const revocationReason = reason(body.reason);
      const token = bearerToken(request);
      if (token) {
        return store.revokeOwnedCliDeviceWithCliSession({
          tokenDigest: digest(token),
          deviceId: targetDeviceId,
          reason: revocationReason,
          correlationId,
        });
      }
      const session = await resolveSession(request, { requireCsrf: true, correlationId });
      return store.revokeOwnedCliDevice({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        expectedPermissionRevision: session.permissionRevision,
        expectedRevokeEpoch: session.revokeEpoch,
        deviceId: targetDeviceId,
        reason: revocationReason,
        correlationId,
      });
    },
  });
}
