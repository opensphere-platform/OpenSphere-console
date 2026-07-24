const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RegistryCredentialCoordinator, dockerConfig } = require('./registry-credentials');

function fakeCluster() {
  const state = { secret: null, configMaps: new Map(), pods: ['controller-a', 'controller-b'] };
  const result = (status, json = null) => ({ ok: status >= 200 && status < 300, status, json });
  const k8s = async (method, path, body) => {
    const configMatch = path.match(/\/configmaps\/([^/?]+)$/);
    if (path.includes('/pods?')) return result(200, { items: state.pods.map((name) => ({
      metadata: { name }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    })) });
    if (configMatch) {
      const name = configMatch[1];
      if (method === 'GET') return state.configMaps.has(name) ? result(200, state.configMaps.get(name)) : result(404);
      if (method === 'PATCH') {
        const current = state.configMaps.get(name);
        if (!current) return result(404);
        current.data = { ...current.data, ...(body.data || {}) };
        return result(200, current);
      }
    }
    if (path.endsWith('/configmaps') && method === 'POST') {
      if (state.configMaps.has(body.metadata.name)) return result(409);
      const item = { metadata: body.metadata, data: { ...(body.data || {}) } };
      state.configMaps.set(body.metadata.name, item);
      return result(201, item);
    }
    if (path.endsWith('/secrets/opensphere-ghcr-pull')) {
      if (method === 'GET') return state.secret ? result(200, state.secret) : result(404);
      if (method === 'PATCH') {
        if (!state.secret) return result(404);
        state.secret = { ...state.secret, ...body, metadata: { ...state.secret.metadata, ...body.metadata }, data: { ...state.secret.data, ...body.data } };
        return result(200, state.secret);
      }
      if (method === 'DELETE') { state.secret = null; return result(200); }
    }
    if (path.endsWith('/secrets') && method === 'POST') { state.secret = body; return result(201, body); }
    throw new Error(`unexpected Kubernetes call ${method} ${path}`);
  };
  return { state, k8s };
}

function coordinator(cluster, podName, mounts, options = {}) {
  return new RegistryCredentialCoordinator({
    k8s: cluster.k8s,
    namespace: 'opensphere-console', secretName: 'opensphere-ghcr-pull', podName,
    configPath: `/mount/${podName}/config.json`, generationPath: `/state/${podName}/generation`,
    readFile: (file) => mounts.get(file) || '',
    newGeneration: options.newGeneration || (() => 'generation-2'),
    now: options.now || (() => '2026-07-24T00:00:00.000Z'),
    waitTimeoutMs: options.waitTimeoutMs || 50, pollMs: 1,
    sleep: options.sleep || (() => new Promise((resolve) => setTimeout(resolve, 1))),
  });
}

function project(cluster, mounts, podName) {
  const config = Buffer.from(cluster.state.secret.data['.dockerconfigjson'], 'base64').toString('utf8');
  const generation = cluster.state.configMaps.get('opensphere-ghcr-credential-state').data.generation;
  mounts.set(`/mount/${podName}/config.json`, config);
  mounts.set(`/state/${podName}/generation`, generation);
}

test('login waits for controller B and then both replicas use the same mounted generation', async () => {
  const cluster = fakeCluster();
  const mounts = new Map();
  const b = coordinator(cluster, 'controller-b', mounts);
  const a = coordinator(cluster, 'controller-a', mounts, {
    sleep: async () => { project(cluster, mounts, 'controller-a'); project(cluster, mounts, 'controller-b'); await b.observe(); },
  });
  const stored = await a.store('opensphere-platform', 'test-token-not-a-real-secret');
  assert.equal(stored.converged, true);
  assert.deepEqual(await a.credentials(), { username: 'opensphere-platform', password: 'test-token-not-a-real-secret' });
  assert.deepEqual(await b.credentials(), { username: 'opensphere-platform', password: 'test-token-not-a-real-secret' });
  const metadata = JSON.stringify([...cluster.state.configMaps.values()]);
  assert.doesNotMatch(metadata, /test-token-not-a-real-secret|password|auth/);
});

test('a stale replica returns retryable propagation rather than a false 401', async () => {
  const cluster = fakeCluster();
  cluster.state.secret = {
    metadata: { name: 'opensphere-ghcr-pull' }, type: 'kubernetes.io/dockerconfigjson',
    data: { '.dockerconfigjson': Buffer.from(dockerConfig('opensphere-platform', 'old-token', 'generation-1')).toString('base64') },
  };
  cluster.state.configMaps.set('opensphere-ghcr-credential-state', { data: { phase: 'configured', generation: 'generation-2', updatedAt: '2026-07-24T00:00:00.000Z' } });
  const mounts = new Map([
    ['/mount/controller-a/config.json', dockerConfig('opensphere-platform', 'new-token', 'generation-2')],
    ['/state/controller-a/generation', 'generation-2'],
    ['/mount/controller-b/config.json', dockerConfig('opensphere-platform', 'old-token', 'generation-1')],
    ['/state/controller-b/generation', 'generation-1'],
  ]);
  const a = coordinator(cluster, 'controller-a', mounts);
  const b = coordinator(cluster, 'controller-b', mounts);
  assert.equal((await a.credentials()).username, 'opensphere-platform');
  await assert.rejects(b.credentials(), (error) => error.code === 503 && error.reason === 'RegistryCredentialsPropagating' && error.retryAfter === 1);
});

test('a replica observes the generation embedded in its Secret when the optional state volume is absent', async () => {
  const cluster = fakeCluster();
  cluster.state.configMaps.set('opensphere-ghcr-credential-state', { data: { phase: 'configured', generation: 'generation-2', updatedAt: '2026-07-24T00:00:00.000Z' } });
  const mounts = new Map([
    ['/mount/controller-a/config.json', dockerConfig('opensphere-platform', 'test-token-not-a-real-secret', 'generation-2')],
  ]);
  const a = coordinator(cluster, 'controller-a', mounts);
  assert.deepEqual(await a.credentials(), { username: 'opensphere-platform', password: 'test-token-not-a-real-secret' });
  assert.equal((await a.observe()).observed, 'configured:generation-2');
});

test('a mismatched optional state projection still blocks credential use', async () => {
  const cluster = fakeCluster();
  cluster.state.configMaps.set('opensphere-ghcr-credential-state', { data: { phase: 'configured', generation: 'generation-2', updatedAt: '2026-07-24T00:00:00.000Z' } });
  const mounts = new Map([
    ['/mount/controller-a/config.json', dockerConfig('opensphere-platform', 'test-token-not-a-real-secret', 'generation-2')],
    ['/state/controller-a/generation', 'generation-1'],
  ]);
  const a = coordinator(cluster, 'controller-a', mounts);
  await assert.rejects(a.credentials(), (error) => error.code === 503 && error.reason === 'RegistryCredentialsPropagating');
});

test('logout blocks all replica credential use before reporting success', async () => {
  const cluster = fakeCluster();
  const mounts = new Map();
  cluster.state.secret = {
    metadata: { name: 'opensphere-ghcr-pull' }, type: 'kubernetes.io/dockerconfigjson',
    data: { '.dockerconfigjson': Buffer.from(dockerConfig('opensphere-platform', 'old-token', 'generation-1')).toString('base64') },
  };
  cluster.state.configMaps.set('opensphere-ghcr-credential-state', { data: { phase: 'configured', generation: 'generation-1', updatedAt: '2026-07-23T00:00:00.000Z' } });
  project(cluster, mounts, 'controller-a'); project(cluster, mounts, 'controller-b');
  const b = coordinator(cluster, 'controller-b', mounts, { newGeneration: () => 'generation-1' });
  const a = coordinator(cluster, 'controller-a', mounts, {
    newGeneration: () => 'generation-1', sleep: async () => { await b.observe(); },
  });
  assert.equal((await a.credentials()).password, 'old-token');
  const removed = await a.remove();
  assert.equal(removed.converged, true);
  assert.equal(await a.credentials(), null);
  assert.equal(await b.credentials(), null);
});

test('rolling update does not claim convergence while a newly serving replica is unobserved', async () => {
  const cluster = fakeCluster();
  cluster.state.pods.push('controller-c');
  cluster.state.configMaps.set('opensphere-ghcr-credential-state', { data: { phase: 'configured', generation: 'generation-2', updatedAt: '2026-07-24T00:00:00.000Z' } });
  cluster.state.configMaps.set('opensphere-ghcr-credential-observations', { data: { 'controller-a': 'configured:generation-2', 'controller-b': 'configured:generation-2' } });
  const mounts = new Map([
    ['/mount/controller-a/config.json', dockerConfig('user', 'token', 'generation-2')],
    ['/state/controller-a/generation', 'generation-2'],
  ]);
  const a = coordinator(cluster, 'controller-a', mounts, { waitTimeoutMs: 5 });
  await assert.rejects(a.convergence('configured', 'generation-2'), (error) => error.code === 503 && error.servingReplicas.includes('controller-c') && !error.observedReplicas.includes('controller-c'));
});

test('controller keeps GHCR tokens file-only and mounts only lifecycle metadata beside them', () => {
  const root = __dirname;
  const controller = fs.readFileSync(path.join(root, 'controller.js'), 'utf8');
  const deployment = fs.readFileSync(path.join(root, 'opensphere-console-dupa-controller.yaml'), 'utf8');
  const lifecycle = fs.readFileSync(path.join(root, 'registry-credentials.js'), 'utf8');
  assert.doesNotMatch(controller, /runtimeGhcrCredentials/);
  assert.match(deployment, /name: POD_NAME/);
  assert.match(deployment, /name: opensphere-ghcr-state/);
  assert.match(lifecycle, /RegistryCredentialsPropagating/);
  assert.doesNotMatch(lifecycle, /GHCR_(?:TOKEN|PASSWORD)|process\.env\.[A-Z_]*TOKEN/);
});

test('registration approval serializes the authenticated actor to the CRD string field', () => {
  const controller = fs.readFileSync(path.join(__dirname, 'controller.js'), 'utf8');
  assert.match(controller, /approval:\s*\{\s*requestedBy:\s*auditActorLabel\(actor\),\s*reason:\s*approvalReason\s*\}/);
  assert.doesNotMatch(controller, /approval:\s*\{\s*requestedBy:\s*actor\s*\|\|\s*['"]unknown['"]/);
});
