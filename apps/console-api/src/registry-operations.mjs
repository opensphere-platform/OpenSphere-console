const REGISTRY_TARGET = 'registry-connection:opensphere-ghcr';
const IMAGE = /^ghcr\.io\/opensphere-platform\/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$/;
const DESCRIPTOR_ID = /^extension\.[a-z0-9][a-z0-9-]{0,62}$/;
const CATALOG_REVISION = /^sha256:[0-9a-f]{64}$/;

function fail(message) {
  throw Object.assign(new Error(message), { code: 'ValidationFailed', status: 400 });
}

function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object');
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length) fail(label + ' contains unknown fields: ' + unknown.join(', '));
}

function catalogRequest(body, includeReason) {
  exact(body, includeReason ? ['descriptorId', 'catalogRevision', 'reason'] : ['descriptorId', 'catalogRevision'], 'extension catalog request');
  const descriptorId = String(body.descriptorId || '').trim();
  const catalogRevision = String(body.catalogRevision || '').trim();
  if (!DESCRIPTOR_ID.test(descriptorId)) fail('canonical extension descriptorId is required');
  if (!CATALOG_REVISION.test(catalogRevision)) fail('exact catalogRevision is required');
  const reason = includeReason ? String(body.reason || '').trim() : '';
  if (includeReason && (reason.length < 3 || reason.length > 500)) fail('extension install reason is required');
  return { descriptorId, catalogRevision, reason };
}

function removalRequest(body) {
  exact(body, ['descriptorId', 'reason', 'confirmation'], 'extension removal request');
  const descriptorId = String(body.descriptorId || '').trim();
  const reason = String(body.reason || '').trim();
  if (!DESCRIPTOR_ID.test(descriptorId)) fail('canonical extension descriptorId is required');
  if (reason.length < 3 || reason.length > 500) fail('extension removal reason is required');
  if (String(body.confirmation || '') !== 'REMOVE ' + descriptorId) fail('canonical extension removal confirmation is required');
  return { descriptorId, reason, confirmation: 'REMOVE ' + descriptorId };
}

function requirePermission(session, permission) {
  if (!session?.authorityFresh || session.revokedAt || !session.permissions?.includes(permission)) {
    throw Object.assign(new Error('current extension permission is required'), { code: 'PermissionDenied', status: 403 });
  }
}

export function createRegistryOperations({ operationService, policyRevision, projectionStore, registryResolver, clock = () => new Date() }) {
  if (!operationService?.accept) throw new TypeError('operation service is required');
  return Object.freeze({
    async getRegistryConnection({ session, correlationId }) {
      if (!projectionStore?.getRegistryConnection) throw Object.assign(
        new Error('Registry connection projection is unavailable'),
        { code: 'AuthorityUnavailable', status: 503 },
      );
      return projectionStore.getRegistryConnection({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        correlationId,
      });
    },

    async listRevocations({ session, correlationId }) {
      if (!projectionStore?.listRevocations) throw Object.assign(
        new Error('Extension revocation projection is unavailable'),
        { code: 'AuthorityUnavailable', status: 503 },
      );
      return projectionStore.listRevocations({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        correlationId,
      });
    },

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

    async inspectCandidate({ session, body, correlationId }) {
      requirePermission(session, 'console.extension.install');
      if (!registryResolver?.resolveExtension) throw Object.assign(
        new Error('Registry resolution authority is unavailable'),
        { code: 'AuthorityUnavailable', status: 503 },
      );
      const request = catalogRequest(body, false);
      const candidate = await registryResolver.resolveExtension({
        descriptorId: request.descriptorId,
        catalogRevision: request.catalogRevision,
        correlationId,
      });
      return {
        schemaVersion: '1.0',
        data: { resolution: 'Eligible', candidate },
        authority: 'OpenSphereRegistry',
        observedAt: clock().toISOString(),
        freshness: 'fresh',
        correlationId,
        evidenceRefs: [`registry:${request.catalogRevision}`, ...candidate.evidenceRefs],
      };
    },

    async installCandidate({ session, body, idempotencyKey, correlationId }) {
      requirePermission(session, 'console.extension.install');
      if (session.aal !== 'aal2') {
        throw Object.assign(new Error('recent aal2 is required'), { code: 'StepUpRequired', status: 428 });
      }
      const request = catalogRequest(body, true);
      if (!registryResolver?.resolveExtension) throw Object.assign(
        new Error('Registry resolution authority is unavailable'),
        { code: 'AuthorityUnavailable', status: 503 },
      );
      const candidate = await registryResolver.resolveExtension({
        descriptorId: request.descriptorId,
        catalogRevision: request.catalogRevision,
        correlationId,
      });
      const executionPlan = {
        schemaVersion: '1.0',
        authority: 'OpenSphereRegistry',
        descriptorId: candidate.descriptorId,
        catalogRevision: request.catalogRevision,
        image: candidate.image,
      };
      return operationService.accept({
        session,
        idempotencyKey,
        correlationId,
        request: {
          schemaVersion: '1.0',
          actionId: 'console.extension.install',
          actionVersion: '1.0',
          targetRef: candidate.image,
          payload: {
            descriptorId: candidate.descriptorId,
            catalogRevision: request.catalogRevision,
            image: candidate.image,
          },
          reason: request.reason,
          risk: 'R2',
          planRevision: policyRevision,
        },
        executionPlan,
      });
    },

    async removeExtension({ session, body, idempotencyKey, correlationId }) {
      requirePermission(session, 'console.extension.remove');
      if (session.aal !== 'aal2') {
        throw Object.assign(new Error('recent aal2 is required'), { code: 'StepUpRequired', status: 428 });
      }
      const request = removalRequest(body);
      return operationService.accept({
        session,
        idempotencyKey,
        correlationId,
        request: {
          schemaVersion: '1.0',
          actionId: 'console.extension.remove',
          actionVersion: '1.0',
          targetRef: request.descriptorId,
          payload: { descriptorId: request.descriptorId, confirmation: request.confirmation },
          reason: request.reason,
          risk: 'R2',
          planRevision: policyRevision,
        },
      });
    },
  });
}
