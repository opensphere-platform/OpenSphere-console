'use strict';

/**
 * Evidence for the maintenance credential boundary.
 *
 * Cordoning a node and evicting pods require Kubernetes write verbs. The
 * Console backend must never hold them: it is the process that terminates
 * browser sessions, proxies Kubernetes reads and parses agent payloads, and a
 * flaw there would otherwise reach the whole cluster with write access.
 *
 * These assertions prove the two halves of that boundary:
 *   1. RBAC — the write-capable role binds only to the maintenance identity.
 *   2. Runtime — the backend has no code path to the Kubernetes write API and
 *      reaches maintenance only over a signed internal call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const docs = yaml.loadAll(read('deploy/rcc/rcc.yaml')).filter(Boolean);

const byKind = (kind) => docs.filter((doc) => doc.kind === kind);
const named = (kind, name) => byKind(kind).find((doc) => doc.metadata.name === name);

const BACKEND_SA = 'polyon-rcc-backend';
const MAINTENANCE_SA = 'polyon-rcc-maintenance';
const WRITE_VERBS = ['create', 'update', 'patch', 'delete', 'deletecollection', '*'];

/** Every ClusterRole a ServiceAccount is bound to. */
function rolesFor(serviceAccount) {
  const roleNames = byKind('ClusterRoleBinding')
    .filter((binding) => (binding.subjects || [])
      .some((subject) => subject.kind === 'ServiceAccount' && subject.name === serviceAccount))
    .map((binding) => binding.roleRef.name);
  return byKind('ClusterRole').filter((role) => roleNames.includes(role.metadata.name));
}

function writeRulesOf(roles) {
  return roles.flatMap((role) => role.rules)
    .filter((rule) => (rule.verbs || []).some((verb) => WRITE_VERBS.includes(verb)))
    .map((rule) => `${(rule.resources || []).join('/')}:${(rule.verbs || []).join(',')}`);
}

// ── 1. RBAC boundary ─────────────────────────────────────────────────────────

test('the Console backend holds no Kubernetes write verb at all', () => {
  const writes = writeRulesOf(rolesFor(BACKEND_SA));
  assert.deepEqual(writes, [], `the backend must stay read-only, but holds: ${writes.join(' | ')}`);
});

test('the backend cannot cordon a node or evict a pod', () => {
  for (const rule of rolesFor(BACKEND_SA).flatMap((role) => role.rules)) {
    const resources = rule.resources || [];
    const verbs = rule.verbs || [];
    if (resources.includes('nodes')) {
      assert.ok(!verbs.includes('patch'), 'the backend must not be able to cordon a node');
    }
    assert.ok(!resources.includes('pods/eviction'), 'the backend must not be able to evict pods');
  }
});

test('the write-capable maintenance role binds to the maintenance identity only', () => {
  const binding = named('ClusterRoleBinding', 'polyon-rcc-cc2-maintenance');
  assert.ok(binding, 'the maintenance binding must exist');
  const subjects = binding.subjects.map((subject) => `${subject.kind}/${subject.name}`);
  assert.deepEqual(subjects, [`ServiceAccount/${MAINTENANCE_SA}`],
    'only the maintenance ServiceAccount may hold the write role');
});

test('the maintenance role grants exactly the two write verbs it needs', () => {
  const writes = writeRulesOf(rolesFor(MAINTENANCE_SA)).sort();
  assert.deepEqual(writes, ['nodes:get,list,patch', 'pods/eviction:create'].sort(),
    `unexpected maintenance write surface: ${writes.join(' | ')}`);
});

test('neither identity can read Secrets or reach an exec surface', () => {
  for (const serviceAccount of [BACKEND_SA, MAINTENANCE_SA]) {
    for (const rule of rolesFor(serviceAccount).flatMap((role) => role.rules)) {
      for (const resource of rule.resources || []) {
        assert.ok(!/^secrets?$/i.test(resource), `${serviceAccount} must not reach ${resource}`);
        // Match the Kubernetes subresources exactly. A substring test would
        // also flag `volumeattachments`, which is an unrelated read-only
        // storage resource.
        assert.ok(
          !/^pods\/(exec|attach|portforward|proxy)$/i.test(resource),
          `${serviceAccount} must not reach ${resource}`,
        );
      }
    }
  }
});

test('the two ServiceAccounts are genuinely distinct identities', () => {
  assert.ok(named('ServiceAccount', BACKEND_SA), 'the backend ServiceAccount must exist');
  assert.ok(named('ServiceAccount', MAINTENANCE_SA), 'the maintenance ServiceAccount must exist');
  const backendDeployment = named('Deployment', 'polyon-rcc-backend');
  const maintenanceDeployment = named('Deployment', 'polyon-rcc-maintenance');
  assert.equal(backendDeployment.spec.template.spec.serviceAccountName, BACKEND_SA);
  assert.equal(maintenanceDeployment.spec.template.spec.serviceAccountName, MAINTENANCE_SA);
  assert.notEqual(
    backendDeployment.spec.template.spec.serviceAccountName,
    maintenanceDeployment.spec.template.spec.serviceAccountName,
  );
});

// ── 2. Network and runtime boundary ──────────────────────────────────────────

test('only the backend may reach the maintenance service', () => {
  const policy = named('NetworkPolicy', 'polyon-rcc-maintenance-ingress');
  assert.ok(policy, 'the maintenance service must be network-isolated');
  assert.deepEqual(policy.spec.podSelector.matchLabels, { 'app.kubernetes.io/name': 'polyon-rcc-maintenance' });
  const sources = policy.spec.ingress.flatMap((rule) => rule.from || []);
  assert.equal(sources.length, 1, 'exactly one source may reach it');
  assert.deepEqual(sources[0].podSelector.matchLabels, { 'app.kubernetes.io/name': 'polyon-rcc-backend' });
});

test('the maintenance service runs under the restricted posture', () => {
  const deployment = named('Deployment', 'polyon-rcc-maintenance');
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  // It must expose no ingress route: it is internal only.
  const ingress = byKind('Ingress');
  for (const route of ingress) {
    const backends = JSON.stringify(route.spec);
    assert.ok(!backends.includes('polyon-rcc-maintenance'),
      'the maintenance service must never be published through the ingress');
  }
});

test('the backend reaches maintenance only over the signed internal call', () => {
  const server = read('backend/opensphere-console-backend/server.js');
  // The backend must not construct an in-cluster Kubernetes maintenance client.
  assert.ok(!server.includes('createInClusterMaintenanceClient'),
    'the backend must not build a Kubernetes write client');
  assert.ok(server.includes('createMaintenanceServiceClient'),
    'the backend must use the internal service client');

  const deployment = named('Deployment', 'polyon-rcc-backend');
  const env = Object.fromEntries(
    deployment.spec.template.spec.containers[0].env
      .filter((entry) => typeof entry.value === 'string')
      .map((entry) => [entry.name, entry.value]),
  );
  assert.ok(env.RCC_MAINTENANCE_URL?.includes('polyon-rcc-maintenance'),
    'the backend must point at the maintenance service');
  assert.ok(env.RCC_MAINTENANCE_KEY_FILE, 'the backend must be given the shared internal key path');
});

test('internal calls are signed and bound to the request body', () => {
  const client = read('backend/opensphere-console-backend/maintenance-client.js');
  const service = read('backend/rcc-maintenance/server.js');
  for (const source of [client, service]) {
    assert.ok(source.includes('RCC-MAINT-V1'), 'both sides must use the same scheme');
    assert.ok(source.includes('bodySha256'), 'the signature must bind the body');
  }
  assert.ok(service.includes('timingSafeEqual'), 'verification must be constant time');
  assert.ok(service.includes('replay detected'), 'replays must be refused');
  assert.ok(service.includes('browser credentials are not accepted'),
    'a browser session must never authenticate a maintenance call');
});

test('the maintenance service refuses to start without its internal key', () => {
  const service = read('backend/rcc-maintenance/server.js');
  assert.match(service, /refusing to start without an internal key/,
    'an unauthenticated maintenance API must not be possible');
  assert.match(service, /process\.exit\(2\)/);
});

test('the maintenance service exposes no general Kubernetes surface', async () => {
  // Behavioural, not textual: run the real server and prove that anything
  // outside its four routes is a 404 that never reaches Kubernetes.
  const { createServer } = require(path.join(repoRoot, 'backend/rcc-maintenance/server.js'));
  const reached = [];
  const coordinator = {
    preflight: async (...args) => { reached.push(['preflight', args]); return {}; },
    prepare: async (...args) => { reached.push(['prepare', args]); return {}; },
    uncordon: async (...args) => { reached.push(['uncordon', args]); return {}; },
  };
  const server = createServer({ coordinator, key: Buffer.alloc(32, 7) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // Kubernetes-shaped paths are not routes here at all.
    const notRoutes = [
      '/api/v1/secrets',
      '/api/v1/namespaces/kube-system/secrets/rcc-agent-keys',
      '/api/v1/namespaces/default/pods/web-1/exec',
      '/api/v1/namespaces/default/pods/web-1/attach',
      '/api/v1/namespaces/default/pods/web-1/portforward',
      '/api/v1/nodes/cc2/proxy/run',
      '/apis/apps/v1/deployments',
      '/internal/maintenance/preflight/../../../api/v1/secrets',
      '/internal/maintenance',
      '/internal/maintenance/evict',
      '/',
    ];
    for (const route of notRoutes) {
      for (const method of ['GET', 'POST']) {
        const response = await fetch(`${base}${route}`, { method });
        assert.equal(response.status, 404,
          `${method} ${route} must be an unknown route, got ${response.status}`);
        assert.equal((await response.json()).error, 'unknown maintenance route');
      }
    }
    assert.deepEqual(reached, [], 'no unknown path may reach the Kubernetes coordinator');

    // The four real routes exist, and three of them demand a signature.
    for (const action of ['preflight', 'prepare', 'uncordon']) {
      const response = await fetch(`${base}/internal/maintenance/${action}`, {
        method: 'POST',
        body: '{}',
      });
      assert.equal(response.status, 401,
        `${action} must exist but refuse an unsigned call`);
    }
    assert.deepEqual(reached, [], 'an unsigned call must not reach Kubernetes either');

    // A browser credential is never an accepted alternative.
    const withCookie = await fetch(`${base}/internal/maintenance/prepare`, {
      method: 'POST',
      headers: { cookie: 'sb-access-token=stolen' },
      body: '{}',
    });
    assert.equal(withCookie.status, 401);
    assert.match((await withCookie.json()).error, /browser credentials/);
    assert.deepEqual(reached, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the maintenance image ships the service and its coordinator', () => {
  const dockerfile = read('backend/opensphere-console-backend/Dockerfile');
  assert.ok(dockerfile.includes('rcc-maintenance/server.js'),
    'the maintenance entrypoint must be packaged');
  assert.ok(dockerfile.includes('maintenance-coordinator.js'),
    'the coordinator the service uses must be packaged');
  const deployment = named('Deployment', 'polyon-rcc-maintenance');
  assert.deepEqual(deployment.spec.template.spec.containers[0].command,
    ['node', '/app/rcc-maintenance/server.js']);
});
