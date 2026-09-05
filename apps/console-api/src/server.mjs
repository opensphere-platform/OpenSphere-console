import {GITHUB_OAUTH_CLIENT_ID} from './github-oauth-app.mjs';
import {requiredImages as requiredRegistryImages} from './registry-lifecycle-contract.mjs';
import {createGitHubRegistryAuth} from './github-registry-auth.mjs';
import {createRegistrySecretStore,registryKubernetesOrigin} from './registry-secret-store.mjs';
import {createRegistryCredentialBroker} from './registry-credential-broker.mjs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import {createServer as createTlsServer} from 'node:https';
import {createShellDelegationBroker,createShellCredentialHandler,createShellConsoleHandler} from './shell-delegation.mjs';
import pg from 'pg';
import { createOperationService } from './operation-service.mjs';
import { createModuleInstallationPolicy } from './module-installation-policy.mjs';
import { createGiteaModuleOwner } from './gitea-module-contract.mjs';
import { createAuditOperations } from './audit-operations.mjs';
import { createIdentityOperations } from './identity-operations.mjs';
import { createDataIdentityOperations, createSupabaseLiveProbes } from './data-identity-operations.mjs';
import { createRecoveryEvidenceReader } from './data-identity-evidence.mjs';
import { createPostgresOperationStore } from './postgres-operation-store.mjs';
import { createRegistryOperations } from './registry-operations.mjs';
import { createRegistryResolver } from '../../../packages/registry-client/src/registry-resolver-client.mjs';
import { createConsoleApiHandler } from './http-handler.mjs';
import { createIdentitySessionBroker } from './identity-session-broker.mjs';
import { createSessionCredentialCipher } from './session-credential-cipher.mjs';
import { createSupabaseAuthClient } from './supabase-auth-client.mjs';
import { createSupabaseStorageClient } from './supabase-storage-client.mjs';
import { createCliIdentityBroker } from './cli-identity-broker.mjs';
import { createGiteaChangeClient } from './gitea-change-client.mjs';
import { createPlatformChangeOperations } from './platform-change-operations.mjs';
import { createCatalogOperations } from './catalog-operations.mjs';
import { createOwnerAdmissionOperations } from './owner-admission-operations.mjs';
import { createFileInstallationReleaseStore, createPlatformReleaseOperations } from './platform-release-operations.mjs';
import { createPlatformChangeTemplateOperations } from './platform-change-template-operations.mjs';
import { createBaselineMonitoringOperations } from './baseline-monitoring-operations.mjs';

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
const publicOrigin = String(process.env.CONSOLE_PUBLIC_ORIGIN || '');
if (!publicOrigin) throw new Error('CONSOLE_PUBLIC_ORIGIN is required');
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
const operationService = createOperationService({ store, policyCatalog, moduleInstallationPolicy: createModuleInstallationPolicy(publicOrigin) });
const auditOperations = createAuditOperations({ store });
const identityOperations = createIdentityOperations({ store });
const supabaseAuthUrl = String(process.env.CONSOLE_SUPABASE_AUTH_URL || 'http://opensphere-supabase-auth.opensphere-console-data.svc.cluster.local:9999');
const supabaseStorageUrl = String(process.env.CONSOLE_SUPABASE_STORAGE_URL || 'http://opensphere-supabase-storage.opensphere-console-data.svc.cluster.local:5000');
const supabaseServiceRoleKey = String(process.env.CONSOLE_SUPABASE_SERVICE_ROLE_KEY || '');
const identitySessionBroker = createIdentitySessionBroker({
  store,
  authClient: createSupabaseAuthClient({
    baseUrl: supabaseAuthUrl,
    serviceRoleKey: supabaseServiceRoleKey,
    timeoutMs: positiveInteger('CONSOLE_SUPABASE_AUTH_TIMEOUT_MS', 5000, 30000),
    maximumResponseBytes: positiveInteger('CONSOLE_SUPABASE_AUTH_MAX_RESPONSE_BYTES', 65536, 1024 * 1024),
  }),
  storageClient: createSupabaseStorageClient({
    baseUrl: supabaseStorageUrl,
    serviceRoleKey: supabaseServiceRoleKey,
    timeoutMs: positiveInteger('CONSOLE_SUPABASE_STORAGE_TIMEOUT_MS', 5000, 30000),
  }),
  credentialCipher: createSessionCredentialCipher({
    encryptionKey: String(process.env.CONSOLE_SESSION_ENCRYPTION_KEY || ''),
  }),
  publicOrigin,
});
const cliIdentityBroker = createCliIdentityBroker({
  store,
  resolveSession: identitySessionBroker.resolveSession,
  publicOrigin,
});
const supabaseLiveProbes = createSupabaseLiveProbes({
  authUrl: supabaseAuthUrl,
  dataApiUrl: String(process.env.CONSOLE_SUPABASE_REST_URL || 'http://opensphere-supabase-rest.opensphere-console-data.svc.cluster.local:3000'),
  storageUrl: supabaseStorageUrl,
  timeoutMs: positiveInteger('CONSOLE_SUPABASE_PROBE_TIMEOUT_MS', 1500, 10000),
  maximumResponseBytes: positiveInteger('CONSOLE_SUPABASE_PROBE_MAX_RESPONSE_BYTES', 131072, 1024 * 1024),
});
const dataIdentityOperations = createDataIdentityOperations({ store, liveProbes: supabaseLiveProbes,
  recoveryEvidence: createRecoveryEvidenceReader(),
  expectedMigration: JSON.parse(await readFile(new URL('../../../migrations/manifest.json', import.meta.url), 'utf8')),
});
const registryResolver = createRegistryResolver({
  baseUrl: String(process.env.CONSOLE_REGISTRY_URL || 'http://opensphere-registry.opensphere-console.svc.cluster.local:8080'),
  timeoutMs: positiveInteger('CONSOLE_REGISTRY_TIMEOUT_MS', 8000, 30000),
  maximumResponseBytes: positiveInteger('CONSOLE_REGISTRY_MAX_RESPONSE_BYTES', 65536, 1024 * 1024),
});
// registry-auth/v1 requires the approved six-Secret RBAC and Setup-rendered API egress.
const credentialBroker = process.env.CONSOLE_REGISTRY_AUTH_CONTRACT==='registry-auth/v1' ? createRegistryCredentialBroker({
  store:createRegistrySecretStore({baseUrl:registryKubernetesOrigin()}),
  provider:createGitHubRegistryAuth(),
  installationImages:async()=>requiredRegistryImages(JSON.parse(await readFile(String(process.env.CONSOLE_INSTALLATION_RELEASE_PATH || '/var/run/opensphere/release/release.json'),'utf8'))),
  clientId:String(process.env.OPENSPHERE_GITHUB_OAUTH_CLIENT_ID || GITHUB_OAUTH_CLIENT_ID),
  assertAuthority:store.assertRegistryCredentialAuthority,
  recordResult:store.recordRegistryCredentialResult,
}) : null;
let credentialTickRunning=false;
async function reconcileCredentials(){
  if(!credentialBroker || credentialTickRunning)return;
  credentialTickRunning=true;
  try{await credentialBroker.tick();}catch{process.stderr.write('{"event":"registry-credential-reconcile-unavailable"}\n');}
  finally{credentialTickRunning=false;}
}
const credentialTimer=credentialBroker ? setInterval(reconcileCredentials,5000) : null;
credentialTimer?.unref();
const registryOperations = createRegistryOperations({
  credentialBroker,
  operationService,
  policyRevision: policyCatalog.policyRevision,
  projectionStore: store,
  registryResolver,
});
const catalogOperations = createCatalogOperations({ registryResolver });
const ownerAdmissionOperations = createOwnerAdmissionOperations({ identitySessionBroker });
const giteaChangeClient = createGiteaChangeClient({
  baseUrl: String(process.env.CONSOLE_GITEA_URL || ''),
  controlToken: String(process.env.CONSOLE_GITEA_CONTROL_TOKEN || ''),
  reviewToken: String(process.env.CONSOLE_GITEA_REVIEW_TOKEN || ''),
  organization: String(process.env.CONSOLE_GITEA_ORGANIZATION || 'opensphere'),
  repository: String(process.env.CONSOLE_GITEA_REPOSITORY || 'platform-declarations'),
  defaultBranch: String(process.env.CONSOLE_GITEA_DEFAULT_BRANCH || 'main'),
  timeoutMs: positiveInteger('CONSOLE_GITEA_TIMEOUT_MS', 5000, 30000),
  maximumResponseBytes: positiveInteger('CONSOLE_GITEA_MAX_RESPONSE_BYTES', 262144, 1048576),
});
const giteaModuleOwner = createGiteaModuleOwner({ registryResolver });
const platformChangeOperations = createPlatformChangeOperations({
  operationService,
  policyRevision: policyCatalog.policyRevision,
  projectionStore: store,
  giteaClient: giteaChangeClient,
  moduleOwner: giteaModuleOwner,
});
const platformReleaseOperations = createPlatformReleaseOperations({
  releaseStore: createFileInstallationReleaseStore({
    path: String(process.env.CONSOLE_INSTALLATION_RELEASE_PATH || '/var/run/opensphere/release/release.json'),
  }),
});
const platformChangeTemplateOperations = createPlatformChangeTemplateOperations({ moduleOwner: giteaModuleOwner });
const baselineMonitoringOperations = createBaselineMonitoringOperations({
  baseUrl: String(process.env.CONSOLE_BESZEL_URL || ''),
  email: String(process.env.CONSOLE_BESZEL_READER_EMAIL || ''),
  password: String(process.env.CONSOLE_BESZEL_READER_PASSWORD || ''),
  timeoutMs: positiveInteger('CONSOLE_BESZEL_TIMEOUT_MS', 5000, 30000),
  maximumResponseBytes: positiveInteger('CONSOLE_BESZEL_MAX_RESPONSE_BYTES', 524288, 1048576),
});
const handlerOptions = {
  resolveSession: identitySessionBroker.resolveSession,
  operationService,
  registryOperations,
  catalogOperations,
  ownerAdmissionOperations,
  auditOperations,
  identityOperations,
  identitySessionBroker,
  cliIdentityBroker,
  dataIdentityOperations,
  platformChangeOperations,
  platformChangeTemplateOperations,
  platformReleaseOperations,
  baselineMonitoringOperations,
  health: () => store.health(),
};
const server = createServer(createConsoleApiHandler(handlerOptions));
const listeners=[{server,port}];
const shellEnabled=String(process.env.OS_SHELL_CREDENTIAL_AUTHORITY_ENABLED || 'false');
if(!['true','false'].includes(shellEnabled))throw new Error('OS_SHELL_CREDENTIAL_AUTHORITY_ENABLED must be true or false');
if(shellEnabled==='true'){
  const encodedKey=String(process.env.OS_SHELL_DELEGATION_SIGNING_KEY || '');
  if(!/^[A-Za-z0-9+/]{43}=$/.test(encodedKey))throw new Error('a dedicated 32-byte Shell signing key is required');
  const broker=createShellDelegationBroker({query:pool.query.bind(pool),delegationSecret:String(process.env.OS_SHELL_DELEGATION_SECRET || ''),signingKey:Buffer.from(encodedKey,'base64')});
  if(!await broker.health())throw new Error('current Shell authority migration is required before activation');
  for(const [privatePort,prefix,handler] of [
    [8444,'OS_SHELL_CREDENTIAL_AUTHORITY',createShellCredentialHandler(broker)],
    [8445,'OS_SHELL_CONSOLE_API',createShellConsoleHandler({broker,createHandler:createConsoleApiHandler,handlerOptions})],
  ]){
    const cert=await readFile(String(process.env[prefix+'_CERT_FILE'] || ''));
    const key=await readFile(String(process.env[prefix+'_KEY_FILE'] || ''));
    listeners.push({server:createTlsServer({cert,key,minVersion:'TLSv1.3'},handler),port:privatePort});
  }
}
for(const listener of listeners){
  listener.server.requestTimeout=15000;
  listener.server.headersTimeout=10000;
  listener.server.keepAliveTimeout=5000;
}

let shutdownPromise;
function shutdown(signal) {
  if (!shutdownPromise) {
    if(credentialTimer)clearInterval(credentialTimer);
    shutdownPromise = Promise.all(listeners.map(({server})=>new Promise((resolve)=>server.close(resolve))))
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

for(const {server,port} of listeners){
  server.on('error',()=>{process.stderr.write('{"event":"console-api-listener-failed"}\n');shutdown('listener-error').finally(()=>process.exit(1));});
  server.listen(port,'0.0.0.0',()=>process.stdout.write(JSON.stringify({event:'console-api-listening',port})+'\n'));
}
