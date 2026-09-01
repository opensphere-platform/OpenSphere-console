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
    schemas: denominator.requiredSchemas.length,
    components: boundary.components.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyContracts(process.cwd());
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
