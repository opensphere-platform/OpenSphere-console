import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { verifyBrowserApiCutover } from './browser-api-cutover.mjs';

const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const CONSOLE_API_DATABASE_FUNCTIONS = Object.freeze([
  'console_audit.list_events',
  'console_extension.get_registry_connection',
  'console_extension.list_revocations',
  'console_identity.get_supabase_status',
  'console_identity.resolve_browser_session',
  'console_identity.revoke_browser_session',
  'console_operation.accept_operation',
  'console_operation.approve_operation',
  'console_operation.get_operation',
  'console_operation.verify_extension_operation',
]);

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function operationEntries(openapi) {
  const entries = [];
  for (const [path, pathItem] of Object.entries(openapi.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (HTTP_METHODS.has(method)) entries.push({ path, method, operation });
    }
  }
  return entries;
}

export function verifyConsoleApiAuthority({ storeSource, baselineSource }) {
  assert(
    !/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+console_(?:audit|extension|identity|operation)\./i.test(storeSource),
    'Console API store must use granted functions instead of direct authority-table mutation',
  );
  const databaseFunctions = [...new Set(
    [...storeSource.matchAll(/console_(?:audit|extension|identity|operation)\.[a-z_]+/g)].map((match) => match[0]),
  )].sort();
  assert(
    JSON.stringify(databaseFunctions) === JSON.stringify(CONSOLE_API_DATABASE_FUNCTIONS),
    'Console API database function set differs from the closed target contract',
  );
  const statements = baselineSource.split(';').map((statement) => statement.trim()).filter(Boolean);
  for (const name of databaseFunctions) {
    assert(baselineSource.includes(`CREATE OR REPLACE FUNCTION ${name}(`), `${name} is absent from the fresh baseline`);
    assert(
      statements.some((statement) => statement.includes(`GRANT EXECUTE ON FUNCTION ${name}(`)
        && /\)\s+TO\s+console_api$/s.test(statement)),
      `${name} is not granted exactly to the Console API runtime role`,
    );
  }
  return databaseFunctions;
}

function documentByKind(documents, kind) {
  return documents.filter((document) => document?.kind === kind);
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0 && endIndex > startIndex, `Console Web proxy boundary markers are missing: ${start}`);
  return source.slice(startIndex, endIndex);
}

export function verifyConsoleApiDeployment({ documents, nginxSource }) {
  assert(documentByKind(documents, 'Secret').length === 0, 'C_API manifest must consume, not create, its database Secret');
  assert(documentByKind(documents, 'Role').length === 0 && documentByKind(documents, 'ClusterRole').length === 0,
    'C_API must not acquire Kubernetes API authority');

  const [serviceAccount] = documentByKind(documents, 'ServiceAccount');
  const [deployment] = documentByKind(documents, 'Deployment');
  const [service] = documentByKind(documents, 'Service');
  const [networkPolicy] = documentByKind(documents, 'NetworkPolicy');
  assert(documentByKind(documents, 'ServiceAccount').length === 1, 'C_API must have one dedicated ServiceAccount');
  assert(documentByKind(documents, 'Deployment').length === 1, 'C_API must have one component-owned Deployment');
  assert(documentByKind(documents, 'Service').length === 1, 'C_API must have one internal Service');
  assert(documentByKind(documents, 'NetworkPolicy').length === 1, 'C_API must have one closed NetworkPolicy');
  assert(serviceAccount.automountServiceAccountToken === false, 'C_API ServiceAccount token automount must be disabled');
  assert(deployment.spec?.template?.spec?.automountServiceAccountToken === false, 'C_API Pod token automount must be disabled');
  assert(deployment.spec?.replicas === 1, 'C_API foundational deployment must not claim unverified HA');

  const container = deployment.spec?.template?.spec?.containers?.[0];
  assert(container?.image === '__OPENSPHERE_CONSOLE_API_IMAGE__', 'C_API image must remain an exact-digest render input');
  assert(container?.securityContext?.readOnlyRootFilesystem === true, 'C_API root filesystem must be read-only');
  assert(container?.securityContext?.allowPrivilegeEscalation === false, 'C_API privilege escalation must be disabled');
  assert(container?.securityContext?.capabilities?.drop?.includes('ALL'), 'C_API Linux capabilities must be dropped');
  assert(container?.readinessProbe?.httpGet?.path === '/healthz', 'C_API readiness must check its PostgreSQL authority');
  assert(container?.livenessProbe?.httpGet?.path === '/livez', 'C_API liveness must not restart the process for an authority outage');
  const databaseEnv = container?.env?.find((entry) => entry.name === 'CONSOLE_DATABASE_URL');
  assert(databaseEnv?.value === undefined, 'C_API database credential must not be a literal value');
  assert(databaseEnv?.valueFrom?.secretKeyRef?.name === 'opensphere-console-api-runtime', 'C_API database Secret name differs from the install contract');
  assert(databaseEnv?.valueFrom?.secretKeyRef?.key === 'database-url', 'C_API database Secret key differs from the install contract');
  assert(service.spec?.type === 'ClusterIP', 'C_API Service must remain cluster-internal');

  assert(JSON.stringify(networkPolicy.spec?.policyTypes) === JSON.stringify(['Ingress', 'Egress']), 'C_API NetworkPolicy must select both directions');
  const ingress = JSON.stringify(networkPolicy.spec?.ingress || []);
  const egress = JSON.stringify(networkPolicy.spec?.egress || []);
  assert(ingress.includes('opensphere-console') && !ingress.includes('namespaceSelector'), 'C_API ingress must be limited to Console Web pods');
  for (const destination of ['kube-system', 'opensphere-console-data', 'opensphere-supabase-postgres', 'opensphere-supabase-auth', 'opensphere-supabase-rest', 'opensphere-supabase-storage', 'opensphere-registry']) {
    assert(egress.includes(destination), `C_API NetworkPolicy omits required destination ${destination}`);
  }
  assert(!egress.includes('ipBlock'), 'C_API NetworkPolicy must not add an unbounded IP egress escape');

  assert(
    !nginxSource.includes('opensphere-console-api.opensphere-console.svc.cluster.local'),
    'Authenticated Web routes must not cut over before the target browser-session authority is complete',
  );
  const legacyPlatform = between(nginxSource, '# Temporary migration exception: /api/platform routes', '# Minimal module lifecycle receipts');
  const legacyAdmin = between(nginxSource, '# Reconstructed Extension routes remain direct-test-only', '# The target identity projection is direct-test-only');
  const legacyIdentity = between(nginxSource, '# Temporary migration exception for all browser identity routes', '# ADR-006 Supabase same-origin endpoints');
  for (const [name, boundary] of [['platform', legacyPlatform], ['admin', legacyAdmin], ['identity', legacyIdentity]]) {
    assert(boundary.includes('opensphere-console-backend.opensphere-console.svc.cluster.local'), `Legacy ${name} exception lost its explicit upstream`);
    assert(!boundary.includes('opensphere-console-api.opensphere-console.svc.cluster.local'), `Legacy ${name} exception leaked into C_API`);
  }
}

export async function verifyContracts(repoRoot = process.cwd(), { requireReleaseReady = false } = {}) {
  const root = resolve(repoRoot);
  const contractRoot = resolve(root, 'packages', 'contracts');
  const denominator = await json(resolve(contractRoot, 'contract-denominator.json'));
  const actionCatalog = await json(resolve(contractRoot, 'action-policies.json'));
  const boundary = await json(resolve(root, 'apps', 'component-boundaries.json'));
  const openapi = yaml.load(await readFile(resolve(contractRoot, 'openapi', 'console-v1.yaml'), 'utf8'));
  const schemas = await readdir(resolve(contractRoot, 'schemas'));
  const browserApiCutover = await verifyBrowserApiCutover({ root });

  assert(openapi.openapi === '3.1.0', 'Console OpenAPI must use 3.1.0');
  assert(openapi.info?.['x-opensphere-status'] === denominator.status, 'OpenAPI and denominator status differ');

  const entries = operationEntries(openapi);
  const operationIds = entries.map(({ operation }) => operation.operationId);
  assert(new Set(operationIds).size === operationIds.length, 'operationId values must be unique');
  assert(
    JSON.stringify([...operationIds].sort()) === JSON.stringify([...denominator.operations].sort()),
    'OpenAPI operations differ from contract-denominator.json',
  );

  assert(actionCatalog.schemaVersion === '1.0', 'action policy catalog schemaVersion must be 1.0');
  assert(actionCatalog.policyRevision, 'action policy catalog has no policyRevision');
  const actionPolicies = actionCatalog.actions || [];
  const actionPolicyIds = actionPolicies.map((policy) => `${policy.actionId}@${policy.actionVersion}`);
  assert(new Set(actionPolicyIds).size === actionPolicyIds.length, 'action policy identities must be unique');
  assert(
    JSON.stringify([...actionPolicyIds].sort()) === JSON.stringify([...(denominator.requiredActionPolicies || [])].sort()),
    'action policies differ from contract-denominator.json',
  );
  for (const policy of actionPolicies) {
    assert(policy.requirement?.startsWith('CON-FR-'), `${policy.actionId} has no CON-FR trace`);
    assert(policy.permission, `${policy.actionId} has no permission`);
    assert(['R0', 'R1', 'R2', 'R3'].includes(policy.risk), `${policy.actionId} has invalid risk`);
    assert(typeof policy.approvalRequired === 'boolean', `${policy.actionId} has no approval rule`);
    assert(
      ['fenced-outbox', 'credential-broker-required'].includes(policy.dispatchMode),
      `${policy.actionId} has no closed dispatch mode`,
    );
    assert(policy.ownerRef, `${policy.actionId} has no owner`);
    assert(policy.targetPattern, `${policy.actionId} has no target boundary`);
  }

  for (const { path, method, operation } of entries) {
    assert(operation.operationId, method.toUpperCase() + ' ' + path + ' has no operationId');
    assert(operation['x-opensphere-requirement'], operation.operationId + ' has no CON-FR trace');
    assert(operation.responses && Object.keys(operation.responses).length > 0, operation.operationId + ' has no responses');
    if (MUTATING_METHODS.has(method)) {
      assert(operation['x-opensphere-idempotency'], operation.operationId + ' has no idempotency policy');
      const parameters = operation.parameters || [];
      assert(
        parameters.some((entry) => entry.$ref === '#/components/parameters/CsrfToken'),
        operation.operationId + ' has no CSRF contract',
      );
    }
    if (operation['x-opensphere-action']) {
      assert(actionPolicyIds.includes(operation['x-opensphere-action']), operation.operationId + ' references an unknown action policy');
    }
  }

  const approvalOperation = entries.find(({ operation }) => operation.operationId === 'approveOperation')?.operation;
  const approvalSchema = approvalOperation?.requestBody?.content?.['application/json']?.schema;
  assert(approvalSchema?.required?.includes('expectedStateVersion'), 'approveOperation must require compare-and-set state version');
  assert(approvalSchema?.required?.includes('approvalRevision'), 'approveOperation must bind approval policy revision');

  const verificationOperation = entries.find(({ operation }) => operation.operationId === 'verifyOperation')?.operation;
  const verificationSchema = verificationOperation?.requestBody?.content?.['application/json']?.schema;
  assert(verificationSchema?.required?.includes('expectedStateVersion'), 'verifyOperation must require compare-and-set state version');

  const registryConnectionRead = entries.find(({ operation }) => operation.operationId === 'getRegistryConnection')?.operation;
  assert(
    registryConnectionRead?.['x-opensphere-authority'] === 'ConsoleRegistryConnectionMetadata',
    'getRegistryConnection must declare its no-secret metadata authority',
  );
  const auditRead = entries.find(({ operation }) => operation.operationId === 'listAuditEvents')?.operation;
  assert(auditRead?.['x-opensphere-authority'] === 'SupabaseAuditLedger', 'listAuditEvents must declare audit ledger authority');
  assert(
    auditRead?.parameters?.find((parameter) => parameter.name === 'limit')?.schema?.maximum === 200,
    'listAuditEvents must keep a bounded page size',
  );
  for (const operationId of ['getSession', 'deleteSession', 'getMe']) {
    const identityRead = entries.find(({ operation }) => operation.operationId === operationId)?.operation;
    assert(identityRead?.['x-opensphere-authority'] === 'SupabaseAuth', operationId + ' must declare Supabase Auth authority');
  }
  const supabaseStatus = entries.find(({ operation }) => operation.operationId === 'getSupabaseStatus')?.operation;
  assert(supabaseStatus?.['x-opensphere-authority'] === 'Supabase', 'getSupabaseStatus must declare Supabase authority');
  assert(supabaseStatus?.['x-opensphere-permission'] === 'console.data_identity.read', 'getSupabaseStatus must declare its read permission');
  const installOperation = entries.find(({ operation }) => operation.operationId === 'installExtensionCandidate')?.operation;
  assert(
    installOperation?.requestBody?.content?.['application/json']?.schema?.$ref === '../schemas/extension-install-request.schema.json',
    'installExtensionCandidate must require the exact catalog-binding install schema',
  );
  const inspectOperation = entries.find(({ operation }) => operation.operationId === 'inspectExtensionCandidate')?.operation;
  assert(inspectOperation?.['x-opensphere-authority'] === 'OpenSphereRegistry', 'inspectExtensionCandidate must declare C_REG authority');
  assert(inspectOperation?.['x-opensphere-permission'] === 'console.extension.install', 'inspectExtensionCandidate must require install visibility');
  const removeOperation = entries.find(({ operation }) => operation.operationId === 'removeExtension')?.operation;
  assert(
    removeOperation?.requestBody?.content?.['application/json']?.schema?.$ref === '../schemas/extension-remove-request.schema.json',
    'removeExtension must require the canonical descriptor and confirmation schema',
  );
  assert(removeOperation?.['x-opensphere-action'] === 'console.extension.remove@1.0', 'removeExtension must use the typed removal action');

  const referencedActions = entries.map(({ operation }) => operation['x-opensphere-action']).filter(Boolean);
  for (const actionPolicyId of actionPolicyIds) {
    assert(referencedActions.includes(actionPolicyId), actionPolicyId + ' is not referenced by OpenAPI');
  }

  for (const schema of denominator.requiredSchemas) {
    assert(schemas.includes(schema), 'Required schema missing: ' + schema);
    const document = await json(resolve(contractRoot, 'schemas', schema));
    assert(document.$schema?.includes('2020-12'), schema + ' must use JSON Schema 2020-12');
    assert(document.additionalProperties === false, schema + ' must fail closed on unknown properties');
  }

  const componentIds = boundary.components.map((component) => component.id);
  const componentPaths = boundary.components.map((component) => component.path);
  assert(new Set(componentIds).size === componentIds.length, 'component boundary IDs must be unique');
  assert(new Set(componentPaths).size === componentPaths.length, 'component paths must be unique');

  const consoleApiBoundary = boundary.components.find((component) => component.id === 'C_API');
  assert(consoleApiBoundary?.path === 'apps/console-api', 'C_API path differs from the target component boundary');
  assert(consoleApiBoundary?.artifact === 'opensphere-console-api', 'C_API artifact differs from the target component boundary');
  if (requireReleaseReady) {
    assert(boundary.status === 'release-ready', 'Official publication is blocked while component boundaries remain target-migration');
  }

  const consoleApiStore = await readFile(resolve(root, 'apps', 'console-api', 'src', 'postgres-operation-store.mjs'), 'utf8');
  const freshBaseline = await readFile(resolve(root, 'migrations', 'baseline', '0001_console_authority.sql'), 'utf8');
  const consoleApiDatabaseFunctions = verifyConsoleApiAuthority({ storeSource: consoleApiStore, baselineSource: freshBaseline });
  const consoleApiDockerfile = await readFile(resolve(root, 'apps', 'console-api', 'Dockerfile'), 'utf8');
  assert(consoleApiDockerfile.includes('COPY apps/console-api/src ./src'), 'C_API image does not copy the target runtime source');
  assert(consoleApiDockerfile.includes('USER 1001'), 'C_API image must run as the declared non-root identity');
  const consoleApiDeployment = [];
  yaml.loadAll(await readFile(resolve(root, 'apps', 'console-api', 'deploy.yaml'), 'utf8'), (document) => consoleApiDeployment.push(document));
  const consoleWebProxy = await readFile(resolve(root, 'nginx', 'default.conf.template'), 'utf8');
  verifyConsoleApiDeployment({ documents: consoleApiDeployment, nginxSource: consoleWebProxy });

  const candidateWorkflow = await readFile(resolve(root, '.github', 'workflows', 'publish-candidate-images.yml'), 'utf8');
  const promotionWorkflow = await readFile(resolve(root, '.github', 'workflows', 'promote-release.yml'), 'utf8');
  assert(candidateWorkflow.includes('node scripts/verify-console-contracts.mjs --release-ready'), 'Candidate workflow has no target-migration publication gate');
  assert(candidateWorkflow.includes('- image: opensphere-console-api'), 'Candidate workflow does not publish the C_API target artifact');
  assert(candidateWorkflow.includes('file: OpenSphere-console/apps/console-api/Dockerfile'), 'Candidate workflow does not build the C_API target Dockerfile');
  assert(candidateWorkflow.includes('consoleApi'), 'Candidate BOM has no consoleApi component identity');
  assert(!candidateWorkflow.includes('opensphere-console-backend'), 'Candidate workflow still publishes the legacy Backend artifact');
  assert(promotionWorkflow.includes('opensphere-console-api'), 'Promotion workflow omits the C_API target artifact');
  assert(!promotionWorkflow.includes('opensphere-console-backend'), 'Promotion workflow still promotes the legacy Backend artifact');

  const packageJson = await readFile(resolve(root, 'package.json'), 'utf8');
  const sourceFiles = [
    resolve(root, 'src', 'app', 'core', 'extension-host.service.ts'),
    resolve(root, 'src', 'app', 'core', 'search.types.ts'),
  ];
  assert(!packageJson.includes('file:../OpenSphere-SDK'), 'root package must not depend on sibling SDK source');
  for (const sourceFile of sourceFiles) {
    assert(!(await readFile(sourceFile, 'utf8')).includes('@opensphere/sdk'), 'legacy SDK import remains: ' + sourceFile);
  }

  return {
    status: 'passed',
    contractStatus: denominator.status,
    operations: entries.length,
    actionPolicies: actionPolicies.length,
    schemas: denominator.requiredSchemas.length,
    components: boundary.components.length,
    releaseBoundaryStatus: boundary.status,
    consoleApiDatabaseFunctions: consoleApiDatabaseFunctions.length,
    browserApiPatterns: browserApiCutover.routePatternCount,
    browserApiFamilies: browserApiCutover.familyCount,
    targetBrowserSessionReady: browserApiCutover.targetSessionReady,
    authenticatedBrowserCutoverReady: browserApiCutover.authenticatedCutoverReady,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyContracts(process.cwd(), { requireReleaseReady: process.argv.includes('--release-ready') });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
