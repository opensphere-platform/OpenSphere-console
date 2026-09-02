import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { createRegistryResolver } from '../../../packages/registry-client/src/registry-resolver-client.mjs';
import { createExtensionController } from './controller.mjs';
import { createKubernetesRegistrationWriter } from './kubernetes-registration-writer.mjs';
import { createConsoleOwnerAdmission } from './owner-admission.mjs';
import { createPluginProxy } from './plugin-proxy.mjs';
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
const maxObservationAttempts = integer('CONSOLE_EXTENSION_OBSERVATION_MAX_ATTEMPTS', 20, 1, 100);
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
const controller = createExtensionController({
  store, registryResolver, registrationWriter, workerId, leaseSeconds, maxObservationAttempts,
});
const ownerAdmission = createConsoleOwnerAdmission({
  baseUrl: String(process.env.CONSOLE_OWNER_AUTHORITY_URL || ''),
  timeoutMs: integer('CONSOLE_OWNER_AUTHORITY_TIMEOUT_MS', 8000, 100, 30000),
});
const pluginProxy = createPluginProxy({
  pluginNamespace: String(process.env.CONSOLE_EXTENSION_NAMESPACE || namespaceFromFile || 'opensphere-console'),
  timeoutMs: integer('CONSOLE_PLUGIN_PROXY_TIMEOUT_MS', 30000, 100, 120000),
  async resolveTarget(input) {
    if (!registrationWriter) {
      throw Object.assign(new Error('Kubernetes registration authority is unavailable'), { status: 503 });
    }
    return registrationWriter.resolvePluginProxyTarget(input);
  },
});
const pluginRequestMaximumBytes = integer('CONSOLE_PLUGIN_REQUEST_MAX_BYTES', 1048576, 1024, 16 * 1024 * 1024);

async function boundedRequestBody(request) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > pluginRequestMaximumBytes) {
    throw Object.assign(new Error('plugin request body exceeds the configured limit'), { status: 413 });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    length += value.length;
    if (length > pluginRequestMaximumBytes) {
      throw Object.assign(new Error('plugin request body exceeds the configured limit'), { status: 413 });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

async function handlePluginRequest(request, response, url) {
  const actor = await ownerAdmission(request);
  const method = String(request.method || '').toUpperCase();
  const body = ['GET', 'HEAD'].includes(method) ? undefined : await boundedRequestBody(request);
  const upstream = await pluginProxy({ method, url, headers: request.headers, body, actor });
  response.writeHead(upstream.status, upstream.headers);
  if (method === 'HEAD' || !upstream.body) return response.end();
  await pipeline(Readable.fromWeb(upstream.body), response);
}

function writeOwnerError(response, error) {
  const knownStatus = Number(error?.status || (typeof error?.code === 'number' ? error.code : 0));
  const status = knownStatus >= 400 && knownStatus <= 599 ? knownStatus
    : ['OwnerRejected', 'PolicyRejected'].includes(error?.code) ? 403
      : ['ResourceNotFound'].includes(error?.code) ? 404
        : ['StaleAuthorityRevision'].includes(error?.code) ? 409 : 503;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: error?.code || 'OwnerUnavailable', message: error?.message || 'C_EXT request failed' }));
}

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
  const url = new URL(request.url || '/', `http://${request.headers.host || 'extension.local'}`);
  if (url.pathname.startsWith('/api/plugins/')) {
    try { await handlePluginRequest(request, response, url); }
    catch (error) { if (!response.headersSent) writeOwnerError(response, error); else response.destroy(error); }
    return;
  }
  if (url.pathname === '/livez') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ state: 'Alive', workerId }));
    return;
  }
  if (url.pathname !== '/healthz') {
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
