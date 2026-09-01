import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import pg from 'pg';
import { createRegistryResolver } from '../../../packages/registry-client/src/registry-resolver-client.mjs';
import { createExtensionController } from './controller.mjs';
import { createKubernetesRegistrationWriter } from './kubernetes-registration-writer.mjs';
import { createExtensionPostgresStore } from './postgres-store.mjs';

const { Pool } = pg;
function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + ' must be an integer between ' + minimum + ' and ' + maximum);
  }
  return value;
}

const databaseUrl = String(process.env.CONSOLE_EXTENSION_DATABASE_URL || '');
if (!databaseUrl) throw new Error('CONSOLE_EXTENSION_DATABASE_URL is required');
const workerId = String(process.env.CONSOLE_EXTENSION_WORKER_ID || randomUUID());
const leaseSeconds = integer('CONSOLE_EXTENSION_LEASE_SECONDS', 30, 5, 300);
const pollMilliseconds = integer('CONSOLE_EXTENSION_POLL_MS', 1000, 100, 60000);
const port = integer('PORT', 8080, 1, 65535);
const pool = new Pool({
  connectionString: databaseUrl,
  max: integer('CONSOLE_EXTENSION_DATABASE_POOL_SIZE', 4, 1, 20),
  connectionTimeoutMillis: integer('CONSOLE_EXTENSION_DATABASE_CONNECT_TIMEOUT_MS', 3000, 100, 60000),
  application_name: 'opensphere-extension-controller',
});
const store = createExtensionPostgresStore({ query: pool.query.bind(pool) });
const registryResolver = createRegistryResolver({
  baseUrl: String(process.env.CONSOLE_REGISTRY_URL || 'http://opensphere-registry.opensphere-console.svc.cluster.local:8080'),
  timeoutMs: integer('CONSOLE_REGISTRY_TIMEOUT_MS', 8000, 100, 30000),
  maximumResponseBytes: integer('CONSOLE_REGISTRY_MAX_RESPONSE_BYTES', 65536, 1024, 1024 * 1024),
});
const serviceAccountDirectory = String(process.env.KUBERNETES_SERVICE_ACCOUNT_DIRECTORY || '/var/run/secrets/kubernetes.io/serviceaccount');
const kubernetesToken = await readFile(`${serviceAccountDirectory}/token`, 'utf8').then((value) => value.trim()).catch(() => '');
const namespaceFromFile = await readFile(`${serviceAccountDirectory}/namespace`, 'utf8').then((value) => value.trim()).catch(() => '');
const registrationWriter = kubernetesToken ? createKubernetesRegistrationWriter({
  baseUrl: String(process.env.KUBERNETES_API_URL
    || `https://${process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc'}:${process.env.KUBERNETES_SERVICE_PORT_HTTPS || '443'}`),
  token: kubernetesToken,
  namespace: String(process.env.CONSOLE_EXTENSION_NAMESPACE || namespaceFromFile || 'opensphere-console'),
  timeoutMs: integer('CONSOLE_KUBERNETES_TIMEOUT_MS', 8000, 100, 30000),
  maximumResponseBytes: integer('CONSOLE_KUBERNETES_MAX_RESPONSE_BYTES', 131072, 1024, 1024 * 1024),
}) : null;
const controller = createExtensionController({ store, registryResolver, registrationWriter, workerId, leaseSeconds });

let stopping = false;
let lastError = null;
let timer;
async function cycle() {
  if (stopping) return;
  try {
    const result = await controller.runOnce();
    lastError = null;
    if (result.state !== 'Idle') process.stdout.write(JSON.stringify({ event: 'extension-operation-applied', ...result }) + '\n');
  } catch (error) {
    lastError = { code: error?.code || 'AuthorityUnavailable', at: new Date().toISOString() };
    process.stderr.write(JSON.stringify({ event: 'extension-controller-cycle-failed', ...lastError }) + '\n');
  } finally {
    if (!stopping) timer = setTimeout(cycle, pollMilliseconds);
  }
}

const healthServer = createServer(async (request, response) => {
  if (request.url !== '/healthz') {
    response.writeHead(404).end();
    return;
  }
  let ready = false;
  try { ready = await store.health(); } catch { ready = false; }
  response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ state: ready ? 'Ready' : 'Unavailable', workerId, lastError }));
});

let shutdownPromise;
function shutdown(signal) {
  if (!shutdownPromise) {
    stopping = true;
    clearTimeout(timer);
    shutdownPromise = new Promise((resolve) => healthServer.close(resolve))
      .then(() => pool.end())
      .then(() => process.stdout.write(JSON.stringify({ event: 'extension-controller-stopped', signal }) + '\n'));
  }
  return shutdownPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => shutdown(signal).then(() => process.exit(0), () => process.exit(1)));
}

healthServer.listen(port, '0.0.0.0', () => {
  process.stdout.write(JSON.stringify({ event: 'extension-controller-listening', port, workerId }) + '\n');
  void cycle();
});
