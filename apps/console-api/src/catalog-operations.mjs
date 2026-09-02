function validationFault(message) {
  return Object.assign(new Error(message), { code: 'ValidationFailed', status: 400 });
}

function positiveLimit(value) {
  if (value == null || value === '') return 200;
  if (!/^[1-9][0-9]*$/u.test(value)) throw validationFault('catalog limit must be an integer between 1 and 200');
  const limit = Number(value);
  if (limit > 200) throw validationFault('catalog limit must be an integer between 1 and 200');
  return limit;
}

function normalizedFilter(value) {
  if (value == null || value === '') return 'all';
  if (String(value).toLowerCase() === 'kind=api') return 'api';
  throw validationFault('catalog filter must be kind=api when present');
}

function componentEntity(descriptor, revision) {
  return Object.freeze({
    kind: 'Component',
    metadata: Object.freeze({
      name: descriptor.id,
      namespace: 'opensphere-console',
      description: descriptor.displayName,
      uid: `${descriptor.id}@${revision}`,
    }),
    spec: Object.freeze({
      type: descriptor.class === 'coreService' ? 'service' : descriptor.class,
      owner: descriptor.owner.id,
      lifecycle: 'production',
      system: descriptor.domain,
      capabilities: descriptor.capabilities,
    }),
  });
}

function apiEntity(descriptor, revision) {
  return Object.freeze({
    kind: 'API',
    metadata: Object.freeze({
      name: descriptor.id,
      namespace: 'opensphere-console',
      description: `${descriptor.displayName} — ${descriptor.owner.lifecycleApi}`,
      uid: `${descriptor.id}:api@${revision}`,
    }),
    spec: Object.freeze({
      type: 'http',
      owner: descriptor.owner.id,
      lifecycle: 'production',
      system: descriptor.domain,
      definition: descriptor.owner.lifecycleApi,
    }),
  });
}

export function createCatalogOperations({ registryResolver }) {
  if (!registryResolver?.readCatalogSnapshot) throw new TypeError('Registry catalog reader is required');
  return Object.freeze({
    async listEntities({ filter, limit, correlationId }) {
      const selected = normalizedFilter(filter);
      const bounded = positiveLimit(limit);
      const snapshot = await registryResolver.readCatalogSnapshot({ correlationId });
      const apis = snapshot.descriptors.filter((descriptor) => descriptor.owner.lifecycleApi)
        .map((descriptor) => apiEntity(descriptor, snapshot.revision));
      const entities = (selected === 'api'
        ? apis
        : [...snapshot.descriptors.map((descriptor) => componentEntity(descriptor, snapshot.revision)), ...apis])
        .sort((left, right) => left.metadata.name.localeCompare(right.metadata.name)
          || left.kind.localeCompare(right.kind)).slice(0, bounded);
      return Object.freeze({
        schemaVersion: '1.0',
        data: Object.freeze({
          revision: snapshot.revision,
          filter: selected,
          returned: entities.length,
          coverage: snapshot.coverage,
          items: Object.freeze(entities),
        }),
        authority: 'OpenSphereRegistry',
        observedAt: snapshot.observedAt,
        freshness: 'fresh',
        correlationId,
        evidenceRefs: Object.freeze(['registry-catalog:' + snapshot.revision]),
      });
    },

    async runtimeResources({ entityName, body }) {
      const name = String(entityName || '');
      if (!/^[a-z0-9][a-z0-9._-]{0,254}$/u.test(name)) throw validationFault('catalog entity name is invalid');
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => key !== 'entity')
        || !body.entity || typeof body.entity !== 'object' || Array.isArray(body.entity)
        || String(body.entity.metadata?.name || '') !== name) {
        throw validationFault('runtime resource request must identify the path entity');
      }
      // C_API deliberately has no Kubernetes authority. The current browser
      // contract is preserved until a dedicated runtime projection is defined.
      return Object.freeze({ items: Object.freeze([]) });
    },
  });
}
