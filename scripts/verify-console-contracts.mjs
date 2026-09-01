import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

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

export async function verifyContracts(repoRoot = process.cwd()) {
  const root = resolve(repoRoot);
  const contractRoot = resolve(root, 'packages', 'contracts');
  const denominator = await json(resolve(contractRoot, 'contract-denominator.json'));
  const actionCatalog = await json(resolve(contractRoot, 'action-policies.json'));
  const boundary = await json(resolve(root, 'apps', 'component-boundaries.json'));
  const openapi = yaml.load(await readFile(resolve(contractRoot, 'openapi', 'console-v1.yaml'), 'utf8'));
  const schemas = await readdir(resolve(contractRoot, 'schemas'));

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
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyContracts(process.cwd());
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
