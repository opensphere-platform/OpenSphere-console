// Shared, non-secret last-known-good projection for every DUPA Controller replica.
// Registry, Catalog and Registration reads must never depend on which replica serves
// the request or turn a transient Kubernetes API failure into an empty success.
const PROJECTION_NAME = 'opensphere-extension-projection-v1';
const PROJECTION_KEY = 'projection.json';
const MAX_PROJECTION_BYTES = 900 * 1024;

function projectionError(message, reason = 'ExtensionProjectionUnavailable') {
  return Object.assign(new Error(message), { code: 503, reason });
}

function configMapPath(namespace, name) {
  return `/api/v1/namespaces/${namespace}/configmaps/${name}`;
}

function normalizedProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectionError('extension projection must be an object', 'InvalidExtensionProjection');
  }
  if (value.version !== 1 || !Number.isFinite(Date.parse(String(value.observedAt || '')))) {
    throw projectionError('extension projection version or observedAt is invalid', 'InvalidExtensionProjection');
  }
  const registry = value.registry;
  if (!registry || registry.version !== 3 || !registry.trustedKeys || typeof registry.trustedKeys !== 'object'
    || !Array.isArray(registry.plugins) || !Array.isArray(registry.capabilities) || !Array.isArray(registry.templates)) {
    throw projectionError('extension registry projection is invalid', 'InvalidExtensionProjection');
  }
  if (!Array.isArray(value.catalog?.items) || !Array.isArray(value.registrations?.items)) {
    throw projectionError('extension admin projection is invalid', 'InvalidExtensionProjection');
  }
  const normalized = {
    version: 1,
    observedAt: new Date(value.observedAt).toISOString(),
    registry: {
      version: 3,
      trustedKeys: { ...registry.trustedKeys },
      capabilities: [...registry.capabilities],
      plugins: [...registry.plugins],
      templates: [...registry.templates],
    },
    catalog: { items: [...value.catalog.items] },
    registrations: { items: [...value.registrations.items] },
  };
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROJECTION_BYTES) {
    throw projectionError('extension projection exceeds the ConfigMap safety limit', 'ExtensionProjectionTooLarge');
  }
  return { normalized, serialized };
}

class ExtensionProjectionCoordinator {
  constructor(options) {
    this.k8s = options.k8s;
    this.namespace = options.namespace;
    this.name = options.name || PROJECTION_NAME;
    this.now = options.now || (() => new Date());
    this.snapshot = null;
  }

  current() {
    return this.snapshot;
  }

  requireCurrent() {
    if (!this.snapshot) throw projectionError('no valid extension projection has been observed');
    return this.snapshot;
  }

  servingStatus(staleAfterMs = 10 * 60 * 1000) {
    if (!this.snapshot) {
      return { ready: false, state: 'unavailable', reason: 'NoValidProjection' };
    }
    const ageMs = Math.max(0, this.now().getTime() - Date.parse(this.snapshot.observedAt));
    return {
      ready: true,
      state: ageMs > staleAfterMs ? 'stale' : 'live',
      observedAt: this.snapshot.observedAt,
      ageSeconds: Math.round(ageMs / 1000),
      reason: ageMs > staleAfterMs ? 'ProjectionOlderThanFreshnessTarget' : '',
    };
  }

  async hydrate() {
    let result;
    try {
      result = await this.k8s('GET', configMapPath(this.namespace, this.name));
    } catch {
      return this.snapshot;
    }
    if (result.status === 404) return this.snapshot;
    if (!result.ok) return this.snapshot;
    try {
      const raw = result.json?.data?.[PROJECTION_KEY];
      const { normalized } = normalizedProjection(JSON.parse(String(raw || '')));
      this.snapshot = normalized;
    } catch {
      // Never replace a valid in-memory LKG with corrupt shared state.
    }
    return this.snapshot;
  }

  async persist(value) {
    const { normalized, serialized } = normalizedProjection(value);
    const path = configMapPath(this.namespace, this.name);
    const existing = await this.k8s('GET', path);
    const metadata = {
      name: this.name,
      namespace: this.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'opensphere-console',
        'opensphere.io/purpose': 'extension-serving-projection',
      },
    };
    let result;
    if (existing.status === 404) {
      result = await this.k8s('POST', `/api/v1/namespaces/${this.namespace}/configmaps`, {
        apiVersion: 'v1', kind: 'ConfigMap', metadata, data: { [PROJECTION_KEY]: serialized },
      });
      if (result.status === 409) {
        result = await this.k8s('PATCH', path, { metadata: { labels: metadata.labels }, data: { [PROJECTION_KEY]: serialized } });
      }
    } else if (existing.ok) {
      result = await this.k8s('PATCH', path, { metadata: { labels: metadata.labels }, data: { [PROJECTION_KEY]: serialized } });
    } else {
      throw projectionError(`extension projection read HTTP ${existing.status}`);
    }
    if (!result.ok) throw projectionError(`extension projection write HTTP ${result.status}`);
    this.snapshot = normalized;
    return this.snapshot;
  }
}

module.exports = {
  ExtensionProjectionCoordinator,
  normalizedProjection,
  projectionError,
  PROJECTION_NAME,
  PROJECTION_KEY,
  MAX_PROJECTION_BYTES,
};
