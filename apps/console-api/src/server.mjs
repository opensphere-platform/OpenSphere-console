import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import pg from 'pg';
import { createOperationService } from './operation-service.mjs';
import { createAuditOperations } from './audit-operations.mjs';
import { createIdentityOperations } from './identity-operations.mjs';
import { createDataIdentityOperations } from './data-identity-operations.mjs';
import { createPostgresOperationStore } from './postgres-operation-store.mjs';
import { createRegistryOperations } from './registry-operations.mjs';
import { createDatabaseSessionResolver } from './session-resolver.mjs';
import { createConsoleApiHandler } from './http-handler.mjs';

const { Pool } = pg;
function positiveInteger(name, fallback, maximum) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(name + ' must be an integer between 1 and ' + maximum);
  }
  return value;
}

const databaseUrl = String(process.env.CONSOLE_DATABASE_URL || '');
if (!databaseUrl) throw new Error('CONSOLE_DATABASE_URL is required');
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');

const policyCatalog = JSON.parse(await readFile(
  new URL('../../../packages/contracts/action-policies.json', import.meta.url),
  'utf8',
));
const pool = new Pool({
  connectionString: databaseUrl,
  max: positiveInteger('CONSOLE_DATABASE_POOL_SIZE', 10, 100),
  connectionTimeoutMillis: positiveInteger('CONSOLE_DATABASE_CONNECT_TIMEOUT_MS', 3000, 60000),
  idleTimeoutMillis: positiveInteger('CONSOLE_DATABASE_IDLE_TIMEOUT_MS', 30000, 600000),
  application_name: 'opensphere-console-api',
});
const store = createPostgresOperationStore({ query: pool.query.bind(pool) });
const operationService = createOperationService({ store, policyCatalog });
const auditOperations = createAuditOperations({ store });
const identityOperations = createIdentityOperations({ store });
const dataIdentityOperations = createDataIdentityOperations({ store });
const registryOperations = createRegistryOperations({
  operationService,
  policyRevision: policyCatalog.policyRevision,
  projectionStore: store,
});
const handler = createConsoleApiHandler({
  resolveSession: createDatabaseSessionResolver({ store }),
  operationService,
  registryOperations,
  auditOperations,
  identityOperations,
  dataIdentityOperations,
  health: () => store.health(),
});
const server = createServer(handler);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;

let shutdownPromise;
function shutdown(signal) {
  if (!shutdownPromise) {
    shutdownPromise = new Promise((resolve) => server.close(resolve))
      .then(() => pool.end())
      .then(() => process.stdout.write(JSON.stringify({ event: 'console-api-stopped', signal }) + '\n'));
  }
  return shutdownPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown(signal).then(() => process.exit(0), () => process.exit(1));
  });
}

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(JSON.stringify({ event: 'console-api-listening', port }) + '\n');
});
