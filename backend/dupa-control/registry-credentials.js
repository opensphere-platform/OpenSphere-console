// Shared GHCR credential lifecycle coordination for every DUPA Controller replica.
// The token only ever enters the projected Secret file; ConfigMaps contain lifecycle
// generation and acknowledgement metadata, never credential material.
const { randomUUID } = require('node:crypto');

const STATE_NAME = 'opensphere-ghcr-credential-state';
const OBSERVATIONS_NAME = 'opensphere-ghcr-credential-observations';
const GENERATION_FILE = 'credential-generation';
const GENERATION_ANNOTATION = 'opensphere.io/credential-generation';
const UPDATED_AT_ANNOTATION = 'opensphere.io/credential-updated-at';

function propagationError(message = 'registry credentials are propagating across serving replicas') {
  return Object.assign(new Error(message), {
    code: 503,
    reason: 'RegistryCredentialsPropagating',
    retryAfter: 1,
  });
}

function storeError(message) {
  return Object.assign(new Error(message), { code: 503, reason: 'RegistryCredentialStoreUnavailable' });
}

function dockerCredentials(raw) {
  if (!raw) return null;
  try {
    const config = JSON.parse(raw);
    const entry = config?.auths?.['ghcr.io'] || config?.auths?.['https://ghcr.io'];
    if (!entry) return null;
    const generation = String(config?.['x-opensphere-credential-generation'] || '').trim();
    if (entry.username && entry.password) return { username: String(entry.username), password: String(entry.password), generation };
    const decoded = Buffer.from(String(entry.auth || ''), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator > 0 ? { username: decoded.slice(0, separator), password: decoded.slice(separator + 1), generation } : null;
  } catch {
    return null;
  }
}

function dockerConfig(username, password, generation) {
  return JSON.stringify({ 'x-opensphere-credential-generation': generation, auths: { 'ghcr.io': {
    username,
    password,
    auth: Buffer.from(`${username}:${password}`).toString('base64'),
  } } });
}

function secretPath(namespace, secretName) {
  return `/api/v1/namespaces/${namespace}/secrets/${secretName}`;
}

function configMapPath(namespace, name) {
  return `/api/v1/namespaces/${namespace}/configmaps/${name}`;
}

function readyPodNames(items) {
  return (items || []).filter((pod) => pod?.metadata?.name
    && !pod.metadata.deletionTimestamp
    && pod.status?.phase === 'Running'
    && (pod.status.conditions || []).some((condition) => condition.type === 'Ready' && condition.status === 'True'))
    .map((pod) => pod.metadata.name)
    .sort();
}

class RegistryCredentialCoordinator {
  constructor(options) {
    this.k8s = options.k8s;
    this.readFile = options.readFile;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now || (() => new Date().toISOString());
    this.newGeneration = options.newGeneration || randomUUID;
    this.namespace = options.namespace;
    this.secretName = options.secretName;
    this.podName = options.podName || 'unknown';
    this.configPath = options.configPath;
    this.generationPath = options.generationPath || `${this.configPath}.generation`;
    this.controllerLabel = options.controllerLabel || 'opensphere-console-dupa-controller';
    this.waitTimeoutMs = options.waitTimeoutMs || 45_000;
    this.pollMs = options.pollMs || 250;
    this.lastObservation = undefined;
  }

  async configMap(name) {
    const result = await this.k8s('GET', configMapPath(this.namespace, name));
    if (result.status === 404) return null;
    if (!result.ok) throw storeError(`registry lifecycle ConfigMap HTTP ${result.status}`);
    return result.json;
  }

  async patchConfigMap(name, data) {
    const path = configMapPath(this.namespace, name);
    const existing = await this.k8s('GET', path);
    const body = {
      apiVersion: 'v1', kind: 'ConfigMap',
      metadata: { name, namespace: this.namespace, labels: { 'app.kubernetes.io/managed-by': 'opensphere-console', 'opensphere.io/purpose': 'registry-credential-lifecycle' } },
      data,
    };
    let result;
    if (existing.status === 404) {
      result = await this.k8s('POST', `/api/v1/namespaces/${this.namespace}/configmaps`, body);
      if (result.status === 409) result = await this.k8s('PATCH', path, { data });
    } else if (existing.ok) {
      result = await this.k8s('PATCH', path, { data });
    } else {
      throw storeError(`registry lifecycle ConfigMap HTTP ${existing.status}`);
    }
    if (!result.ok) throw storeError(`registry lifecycle ConfigMap write HTTP ${result.status}`);
    return result.json;
  }

  async state() {
    const configMap = await this.configMap(STATE_NAME);
    const data = configMap?.data || {};
    return {
      phase: ['configured', 'configuring', 'revoking', 'revoked'].includes(data.phase) ? data.phase : 'revoked',
      generation: String(data.generation || ''),
      updatedAt: String(data.updatedAt || ''),
    };
  }

  async writeState(phase, generation, updatedAt = this.now()) {
    await this.patchConfigMap(STATE_NAME, { phase, generation, updatedAt });
    return { phase, generation, updatedAt };
  }

  mounted() {
    const credentials = dockerCredentials(this.readFile(this.configPath));
    const generation = String(this.readFile(this.generationPath) || '').trim();
    return credentials && generation ? { ...credentials, generation } : null;
  }

  async credentials() {
    const state = await this.state();
    if (state.phase === 'configuring' || state.phase === 'revoking') throw propagationError();
    if (state.phase !== 'configured' || !state.generation) return null;
    const mounted = this.mounted();
    if (!mounted || mounted.generation !== state.generation) throw propagationError();
    return { username: mounted.username, password: mounted.password };
  }

  async observe() {
    const state = await this.state();
    let observed = '';
    if (state.generation) {
      if (state.phase === 'configured') {
        const mounted = this.mounted();
        if (mounted?.generation === state.generation) observed = `configured:${state.generation}`;
      } else if (state.phase === 'revoked') {
        const secret = await this.k8s('GET', secretPath(this.namespace, this.secretName));
        if (secret.status === 404) observed = `revoked:${state.generation}`;
        else if (!secret.ok) throw storeError(`registry credential observe HTTP ${secret.status}`);
      }
    }
    if (this.lastObservation !== observed) {
      await this.patchConfigMap(OBSERVATIONS_NAME, { [this.podName]: observed });
      this.lastObservation = observed;
    }
    return { ...state, observed };
  }

  async servingPodNames() {
    const result = await this.k8s('GET', `/api/v1/namespaces/${this.namespace}/pods?labelSelector=${encodeURIComponent(`app=${this.controllerLabel}`)}`);
    if (!result.ok) throw storeError(`registry credential replica list HTTP ${result.status}`);
    return readyPodNames(result.json?.items);
  }

  async convergence(phase, generation) {
    const expected = `${phase}:${generation}`;
    const deadline = Date.now() + this.waitTimeoutMs;
    let last = { servingReplicas: [], observedReplicas: [] };
    while (Date.now() <= deadline) {
      await this.observe();
      const [pods, observations] = await Promise.all([this.servingPodNames(), this.configMap(OBSERVATIONS_NAME)]);
      const data = observations?.data || {};
      const observed = pods.filter((name) => data[name] === expected);
      last = { servingReplicas: pods, observedReplicas: observed };
      if (pods.length > 0 && observed.length === pods.length) return { converged: true, ...last };
      await this.sleep(this.pollMs);
    }
    throw Object.assign(propagationError(), { ...last, generation, phase });
  }

  async status() {
    const [state, secret] = await Promise.all([
      this.state(), this.k8s('GET', secretPath(this.namespace, this.secretName)),
    ]);
    if (!secret.ok && secret.status !== 404) throw storeError(`registry credential status HTTP ${secret.status}`);
    const encoded = secret.json?.data?.['.dockerconfigjson'];
    const config = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
    const credentials = dockerCredentials(config);
    return {
      registry: 'ghcr.io',
      configured: state.phase === 'configured' && secret.ok && Boolean(credentials),
      ...(credentials ? { username: credentials.username } : {}),
      secretName: this.secretName,
      updatedAt: state.updatedAt,
      credentialGeneration: state.generation || undefined,
      phase: state.phase,
    };
  }

  async store(username, password) {
    const generation = this.newGeneration();
    const updatedAt = this.now();
    await this.writeState('configuring', generation, updatedAt);
    const path = secretPath(this.namespace, this.secretName);
    const existing = await this.k8s('GET', path);
    const body = {
      apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/dockerconfigjson',
      metadata: {
        name: this.secretName, namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'opensphere-console', 'opensphere.io/purpose': 'registry-read' },
        annotations: { [GENERATION_ANNOTATION]: generation, [UPDATED_AT_ANNOTATION]: updatedAt },
      },
      data: {
        '.dockerconfigjson': Buffer.from(dockerConfig(username, password, generation)).toString('base64'),
      },
    };
    const result = existing.ok
      ? await this.k8s('PATCH', path, { type: body.type, metadata: { labels: body.metadata.labels, annotations: body.metadata.annotations }, data: body.data })
      : await this.k8s('POST', `/api/v1/namespaces/${this.namespace}/secrets`, body);
    if (!result.ok) throw storeError(`registry credential store HTTP ${result.status}`);
    await this.writeState('configured', generation, updatedAt);
    const convergence = await this.convergence('configured', generation);
    return { registry: 'ghcr.io', configured: true, username, secretName: this.secretName, updatedAt, credentialGeneration: generation, ...convergence };
  }

  async remove() {
    const current = await this.state();
    const generation = current.generation || this.newGeneration();
    const updatedAt = this.now();
    await this.writeState('revoking', generation, updatedAt);
    const result = await this.k8s('DELETE', secretPath(this.namespace, this.secretName));
    if (!result.ok && result.status !== 404) throw storeError(`registry credential delete HTTP ${result.status}`);
    await this.writeState('revoked', generation, updatedAt);
    const convergence = await this.convergence('revoked', generation);
    return { registry: 'ghcr.io', configured: false, secretName: this.secretName, updatedAt, credentialGeneration: generation, ...convergence };
  }
}

module.exports = {
  RegistryCredentialCoordinator,
  dockerCredentials,
  dockerConfig,
  propagationError,
  readyPodNames,
  GENERATION_FILE,
  GENERATION_ANNOTATION,
  UPDATED_AT_ANNOTATION,
};
