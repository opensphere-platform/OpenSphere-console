import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canonicalComponents = [
  'console', 'consoleApi', 'extensionController', 'registry',
  'osaaGateway', 'osdst', 'osaaGovernedAdapter', 'notificationDispatcher',
  'gitea', 'supabasePostgres', 'supabaseAuth', 'supabaseRest',
  'supabaseStorage', 'giteaPostgres', 'recovery',
  'beszelHub', 'beszelAgent', 'beszelBootstrap',
];

test('component target schema names exactly the canonical 18-component release', async () => {
  const schema = JSON.parse(await readFile(
    new URL('../packages/contracts/schemas/platform-release-component-target-request.schema.json', import.meta.url),
    'utf8',
  ));
  assert.equal(schema.properties.components.maxProperties, canonicalComponents.length);
  assert.deepEqual(schema.properties.components.propertyNames.enum, canonicalComponents);
  assert(!schema.properties.components.propertyNames.enum.includes('backend'));
  assert(!schema.properties.components.propertyNames.enum.includes('dupaController'));
});

test('Registry metadata covers the same canonical release without legacy component identities', async () => {
  const source = await readFile(
    new URL('../backend/registry/internal/registry/registry.go', import.meta.url),
    'utf8',
  );
  const block = source.match(/var coreServices = map\[string\]coreServiceMetadata\{([\s\S]*?)\n\}/u)?.[1] ?? '';
  const keys = [...block.matchAll(/^\s*"([^"]+)":/gmu)].map((match) => match[1]).sort();
  assert.deepEqual(keys, [...canonicalComponents].sort());
  assert(!block.includes('"backend":') && !block.includes('"dupaController":'));
});
