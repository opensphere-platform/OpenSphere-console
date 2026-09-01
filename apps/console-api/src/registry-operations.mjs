const REGISTRY_TARGET = 'registry-connection:opensphere-ghcr';
const IMAGE = /^ghcr\.io\/opensphere-platform\/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$/;

function fail(message) {
  throw Object.assign(new Error(message), { code: 'ValidationFailed', status: 400 });
}

function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object');
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length) fail(label + ' contains unknown fields: ' + unknown.join(', '));
}

export function createRegistryOperations({ operationService, policyRevision }) {
  if (!operationService?.accept) throw new TypeError('operation service is required');
  return Object.freeze({
    async replaceCredential({ session, body, idempotencyKey, correlationId }) {
      exact(body, ['username', 'credential', 'reason'], 'registry credential request');
      const username = String(body.username || '').trim();
      const credential = String(body.credential || '');
      const reason = String(body.reason || '').trim();
      if (!username || username.length > 128) fail('registry username is required');
      if (credential.length < 16 || credential.length > 4096) fail('registry credential length is invalid');
      if (reason.length < 3 || reason.length > 500) fail('registry credential reason is required');
      return operationService.accept({
        session,
        idempotencyKey,
        correlationId,
        request: {
          schemaVersion: '1.0',
          actionId: 'console.registry.connection.replace',
          actionVersion: '1.0',
          targetRef: REGISTRY_TARGET,
          payload: { username, credential },
          reason,
          risk: 'R2',
          planRevision: policyRevision,
        },
      });
    },

    async removeCredential({ session, reason, confirmation, idempotencyKey, correlationId }) {
      if (String(confirmation || '') !== 'REMOVE opensphere-ghcr') fail('canonical registry removal confirmation is required');
      return operationService.accept({
        session,
        idempotencyKey,
        correlationId,
        request: {
          schemaVersion: '1.0',
          actionId: 'console.registry.connection.remove',
          actionVersion: '1.0',
          targetRef: REGISTRY_TARGET,
          payload: { confirmation: 'REMOVE opensphere-ghcr' },
          reason: String(reason || '').trim(),
          risk: 'R2',
          planRevision: policyRevision,
        },
      });
    },

    async createRevocation({ session, body, idempotencyKey, correlationId }) {
      exact(body, ['image', 'reason', 'confirmation'], 'registry revocation request');
      const image = String(body.image || '').trim();
      if (!IMAGE.test(image)) fail('exact OpenSphere GHCR digest is required');
      if (String(body.confirmation || '') !== 'REVOKE ' + image) fail('canonical revocation confirmation is required');
      return operationService.accept({
        session,
        idempotencyKey,
        correlationId,
        request: {
          schemaVersion: '1.0',
          actionId: 'console.extension.revocation.create',
          actionVersion: '1.0',
          targetRef: image,
          payload: { image, confirmation: body.confirmation },
          reason: String(body.reason || '').trim(),
          risk: 'R2',
          planRevision: policyRevision,
        },
      });
    },
  });
}
