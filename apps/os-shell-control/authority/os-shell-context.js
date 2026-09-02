'use strict';

const { createHash, createPublicKey, verify } = require('node:crypto');

function invalid(message = 'OS Shell context JWS rejected') { const error = new Error(message); error.code = 401; throw error; }
function decode(part) {
  try {
    if (typeof part !== 'string' || !part || !/^[A-Za-z0-9_-]+$/.test(part)) invalid();
    const value = Buffer.from(part, 'base64url');
    if (!value.length || value.toString('base64url') !== part) invalid();
    return value;
  } catch { invalid(); }
}
function parse(part) { try { return JSON.parse(decode(part).toString('utf8')); } catch { invalid(); } }
function exact(value, expected) { return String(value ?? '') === String(expected ?? ''); }

function verifyOsShellContextJws(compact, binding, { now = () => Date.now(), audience = 'opensphere-os-cli' } = {}) {
  const parts = String(compact || '').split('.');
  if (parts.length !== 3) invalid();
  const header = parse(parts[0]); const claims = parse(parts[1]);
  let key;
  try { key = createPublicKey(String(binding.runtime_public_key_pem || binding.runtimePublicKeyPem)); } catch { invalid('runtime public key rejected'); }
  if (key.asymmetricKeyType !== 'ed25519') invalid('runtime signing key must be Ed25519');
  const jwk = key.export({ format: 'jwk' });
  const keyId = createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('base64url');
  const signature = decode(parts[2]);
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || header.kid !== keyId
      || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)) invalid();
  const current = Math.floor(now() / 1000);
  if (claims.contract !== 'opensphere-web-shell-context/v2'
      || claims.iss !== 'opensphere-shell-credential-agent' || claims.aud !== audience
      || claims.profile !== 'web-shell' || claims.executionProfile !== 'web-shell'
      || claims.authority !== 'delegated-credential-agent' || claims.sessionClass !== 'operator-interactive'
      || claims.runtimeAdapterId !== 'cbss.kubernetes-pod' || !claims.jti
      || !exact(claims.sessionId, binding.session_id || binding.sessionId)
      || !exact(claims.actorId, binding.actor_id || binding.actorId)
      || !exact(claims.runtimeUid, binding.runtime_uid || binding.runtimeUid)
      || !exact(claims.origin, binding.origin)
      || !exact(claims.permissionRevision, binding.permission_revision || binding.permissionRevision)
      || !exact(claims.aal, binding.aal)
      || !exact(claims.releaseEvidenceRef, binding.release_evidence_ref || binding.releaseEvidenceRef)
      || Number(claims.generation) !== Number(binding.generation)
      || Number(claims.fencingEpoch) !== Number(binding.fencing_epoch || binding.fencingEpoch)
      || !Number.isSafeInteger(claims.iat) || claims.iat < current - 60 || claims.iat > current + 5
      || !Number.isSafeInteger(claims.nbf) || claims.nbf > current + 5
      || !Number.isSafeInteger(claims.exp) || claims.exp <= current || claims.exp > current + 120) invalid();
  return Object.freeze(claims);
}

module.exports = { verifyOsShellContextJws };
