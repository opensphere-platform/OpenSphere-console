'use strict';

/**
 * Runtime wiring contract for the RCC minimal deployment.
 *
 * Stage 1 added modules, routes and environment variables across four layers
 * (backend, image, nginx, Kubernetes). Each layer is individually valid while
 * the seam between two of them is broken, and that class of defect only shows
 * up once deployed. These assertions check the seams.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const server = read('backend/opensphere-console-backend/server.js');
const nginx = read('nginx/rcc.conf.template');
const rccYaml = read('deploy/rcc/rcc.yaml');

/** Route prefixes Stage 1 introduced or depends on, and who must serve them. */
const STAGE1_ROUTES = [
  { prefix: '/api/manual/', servedBy: 'backend', reason: 'the Manual UI reads JSON from these paths' },
  { prefix: '/api/plugins/', servedBy: 'backend', reason: 'the subShell canonical API namespace' },
  { prefix: '/api/control-centers/', servedBy: 'backend', reason: 'host reads and signed agent heartbeat' },
  { prefix: '/plugins/', servedBy: 'static', reason: 'signed manifest, signature and entry bundle' },
];

test('every Stage 1 route has an nginx location and cannot fall through to the SPA', () => {
  const fallbackAt = nginx.indexOf('location / {');
  assert.ok(fallbackAt > 0, 'the SPA fallback must exist');
  for (const route of STAGE1_ROUTES) {
    const at = nginx.indexOf(`location ^~ ${route.prefix}`);
    assert.ok(at > 0, `${route.prefix} has no nginx location — ${route.reason}`);
    assert.ok(at < fallbackAt, `${route.prefix} is declared after the SPA fallback and would be swallowed`);
  }
});

test('backend-served Stage 1 routes are proxied, static ones are not', () => {
  for (const route of STAGE1_ROUTES) {
    const block = new RegExp(`location \\^~ ${route.prefix.replace(/\//g, '\\/')} \\{([\\s\\S]*?)\\n    \\}`).exec(nginx);
    assert.ok(block, `could not read the nginx block for ${route.prefix}`);
    const body = block[1];
    if (route.servedBy === 'backend') {
      assert.match(body, /proxy_pass http:\/\/\$backend:8080/, `${route.prefix} must reach the backend`);
      assert.match(body, /proxy_set_header Authorization \$http_authorization;/, `${route.prefix} is authenticated`);
    } else {
      assert.doesNotMatch(body, /proxy_pass/, `${route.prefix} must be served statically`);
      assert.match(body, /try_files/, `${route.prefix} must resolve to a real file or 404`);
    }
  }
});

test('no API path can fall through to the SPA', () => {
  // Verified against real nginx: the generic prefix is selected only when no
  // longer prefix and no exact match applies, so it cannot shadow the routes
  // above it. Without it, any unrouted /api/ prefix returns index.html with
  // HTTP 200 and the client fails parsing HTML as JSON.
  assert.match(nginx, /location \^~ \/api\/ \{/, 'a generic /api/ backend route must exist');
  assert.match(
    nginx,
    /location \^~ \/api\/ \{[\s\S]*?proxy_pass http:\/\/\$backend:8080\$request_uri;/,
    'the generic API route must reach the backend',
  );

  const genericAt = nginx.indexOf('location ^~ /api/ {');
  const fallbackAt = nginx.indexOf('location / {');
  assert.ok(genericAt < fallbackAt, 'the API catch-all must precede the SPA fallback');

  // Every prefix the frontend calls is now covered, either specifically or by
  // the catch-all.
  for (const prefix of [
    '/api/admin/', '/api/catalog/', '/api/cli/', '/api/external-channels/',
    '/api/kubernetes/', '/api/notifications/', '/api/oaa/', '/api/status/',
  ]) {
    const specific = nginx.includes(`location ^~ ${prefix}`) || nginx.includes(`location ${prefix}`);
    assert.ok(specific || genericAt > 0, `${prefix} is not covered by any API route`);
  }
});

test('the backend answers unknown API paths in JSON, never HTML', () => {
  // The catch-all sends unrouted prefixes to the backend, so the backend's own
  // fallback is now user-visible and must not be a text or HTML body.
  assert.match(
    server,
    /if \(p\.startsWith\('\/api\/'\)\) return json\(res, 404/,
    'unmatched /api/ paths must return a JSON 404',
  );
  const apiFallbackAt = server.indexOf("if (p.startsWith('/api/')) return json(res, 404");
  const plainFallbackAt = server.indexOf("res.end('not found')");
  assert.ok(apiFallbackAt > 0 && apiFallbackAt < plainFallbackAt,
    'the JSON API fallback must be reached before the plain-text one');
});

test('the registry endpoint is served and never cached', () => {
  assert.match(nginx, /location = \/api\/v1\/registry \{/);
  assert.match(nginx, /location = \/api\/v1\/registry \{[\s\S]*?Cache-Control "no-store"/);
});

test('every route the backend claims is reachable through nginx', () => {
  // A backend prefix with no nginx location returns index.html with HTTP 200,
  // which is far harder to diagnose than a 404. Read the prefixes from the
  // modules themselves so a renamed constant cannot desynchronise the check.
  const { MANUAL_ROUTE_PREFIX } = require('../opensphere-console-backend/manual-api');
  const { PLUGIN_API_NAMESPACE } = require('../opensphere-console-backend/host-api');

  const claimed = [MANUAL_ROUTE_PREFIX, `${PLUGIN_API_NAMESPACE}/`];
  for (const prefix of claimed) {
    assert.ok(
      server.includes('MANUAL_ROUTE_PREFIX') || server.includes(prefix),
      `server.js should route ${prefix}`,
    );
    const location = prefix.startsWith('/api/plugins/') ? '/api/plugins/' : prefix;
    assert.ok(nginx.includes(`location ^~ ${location}`), `${prefix} is served by the backend but not routed by nginx`);
  }

  // The backend must actually dispatch these prefixes, not merely import them.
  assert.match(server, /startsWith\(MANUAL_ROUTE_PREFIX\)/, 'manual routes must be dispatched');
  assert.match(server, /startsWith\(`\$\{HOST_PLUGIN_API_NAMESPACE\}\/`\)/, 'plugin namespace must be dispatched');
});

// RCC runs as two separate workloads so that the Kubernetes write credential
// never sits in the process that handles browsers and agents. Each therefore
// has its own environment, and a variable set on one must be read by that one.
const WORKLOADS = {
  'polyon-rcc-backend': [
    'backend/opensphere-console-backend/server.js',
    'backend/opensphere-console-backend/operation-api.js',
    'backend/opensphere-console-backend/host-api.js',
    'backend/opensphere-console-backend/beszel-metrics-api.js',
    'backend/opensphere-console-backend/maintenance-client.js',
  ],
  'polyon-rcc-maintenance': [
    'backend/rcc-maintenance/server.js',
    'backend/opensphere-console-backend/maintenance-coordinator.js',
  ],
};

function envOf(deploymentName) {
  const docs = require('js-yaml').loadAll(rccYaml).filter(Boolean);
  const deployment = docs.find((doc) => doc.kind === 'Deployment' && doc.metadata.name === deploymentName);
  assert.ok(deployment, `${deploymentName} must exist`);
  return (deployment.spec.template.spec.containers[0].env || []).map((entry) => entry.name);
}

test('every RCC_ environment variable is read by the workload it is set on', () => {
  for (const [deployment, modules] of Object.entries(WORKLOADS)) {
    const sources = modules.map((rel) => {
      assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist`);
      return read(rel);
    }).join('\n');
    const consumed = new Set([...sources.matchAll(/process\.env\.(RCC_[A-Z_]+)/g)].map((m) => m[1]));

    for (const name of envOf(deployment)) {
      if (!name.startsWith('RCC_')) continue;
      assert.ok(consumed.has(name), `${deployment} sets ${name} but none of its modules read it`);
    }
  }
});

test('every RCC_ variable a workload reads is deployed or safely defaulted', () => {
  const declared = new Set([...rccYaml.matchAll(/name: (RCC_[A-Z_]+)/g)].map((m) => m[1]));
  for (const modules of Object.values(WORKLOADS)) {
    for (const rel of modules) {
      const source = read(rel);
      for (const match of source.matchAll(/process\.env\.(RCC_[A-Z_]+)/g)) {
        const name = match[1];
        if (declared.has(name)) continue;
        // Undeployed variables must fall back, not read undefined at runtime.
        const usage = new RegExp(`process\\.env\\.${name}\\s*(\\r?\\n\\s*)?(\\|\\||,|\\))`);
        assert.match(source, usage, `${rel} reads ${name} but it is neither deployed nor defaulted`);
      }
    }
  }
});

test('the maintenance credential boundary is visible in the environment split', () => {
  // The backend is told where the maintenance service is and which shared key
  // to sign with. It is never told how to drain, because it cannot.
  const backend = envOf('polyon-rcc-backend');
  const maintenance = envOf('polyon-rcc-maintenance');
  assert.ok(backend.includes('RCC_MAINTENANCE_URL'));
  assert.ok(backend.includes('RCC_MAINTENANCE_KEY_FILE'));
  for (const name of ['RCC_ETCD_TOPOLOGY', 'RCC_DRAIN_DAEMONSET_PODS', 'RCC_DRAIN_STATIC_PODS',
    'RCC_DRAIN_EMPTYDIR_DATA', 'RCC_DRAIN_TIMEOUT_MS']) {
    assert.ok(maintenance.includes(name), `${name} belongs to the maintenance workload`);
    assert.ok(!backend.includes(name), `${name} must not be set on the backend`);
  }
});

test('the manual seed the backend defaults to exists in the repository', () => {
  const fallback = /RCC_MANUAL_SEED_FILE\s*\r?\n?\s*\|\|\s*path\.join\(__dirname, '\.\.', '([^']+)', '([^']+)', '([^']+)'\)/.exec(server);
  assert.ok(fallback, 'the manual seed default must be an explicit path join');
  const rel = path.join('backend', fallback[1], fallback[2], fallback[3]);
  assert.ok(fs.existsSync(path.join(repoRoot, rel)), `default manual seed ${rel} does not exist`);
});

test('the backend image build context can reach everything the backend loads', () => {
  // The image is built from `backend/`, so a runtime path outside that
  // directory cannot be packaged no matter what the Dockerfile says.
  const dockerfile = read('backend/opensphere-console-backend/Dockerfile');
  for (const match of dockerfile.matchAll(/^COPY\s+(?!--from)(\S+)/gm)) {
    const source = match[1];
    assert.ok(!source.startsWith('..'), `COPY ${source} escapes the backend build context`);
    assert.ok(
      fs.existsSync(path.join(repoRoot, 'backend', source)),
      `COPY source ${source} does not exist in the backend build context`,
    );
  }
});

test('no Stage 1 module is required but unpackaged', () => {
  const dockerfile = read('backend/opensphere-console-backend/Dockerfile');
  for (const moduleName of [
    'agent-signature.js', 'host-api.js', 'beszel-metrics-api.js', 'manual-api.js',
  ]) {
    assert.match(
      server,
      new RegExp(`require\\('\\./${moduleName.replace('.js', '')}'\\)`),
      `server.js should require ${moduleName}`,
    );
    assert.ok(
      dockerfile.includes(`opensphere-console-backend/${moduleName}`),
      `${moduleName} is required at runtime but never COPYd — the image would crash on start`,
    );
  }
});
