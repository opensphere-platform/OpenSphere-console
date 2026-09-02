import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..', '..');

test('target C_EXT server wires the governed management authority without legacy fallback', async () => {
  const server = await readFile(resolve(root, 'apps/extension-controller/src/server.mjs'), 'utf8');
  for (const symbol of [
    'createKubernetesExtensionManagementAuthority',
    'createExtensionManagementStore',
    'createExtensionManagementOperations',
    'createExtensionManagementHttpHandler',
  ]) {
    assert.match(server, new RegExp(`import \\{[^}]*${symbol}[^}]*\\}`, 'u'));
  }
  assert.match(server, /const managementAuthority = kubernetesToken[\s\S]*createKubernetesExtensionManagementAuthority/u);
  assert.match(server, /createExtensionManagementStore\(\{ query: pool[.]query[.]bind\(pool\) \}\)/u);
  assert.match(server, /createExtensionManagementOperations\(\{ authority: managementAuthority, store: managementStore \}\)/u);
  assert.match(server, /createExtensionManagementHttpHandler\(\{[\s\S]*ownerAdmission/u);
  assert.match(server, /if \(!isExtensionManagementRoute\(method, url[.]pathname\)\) return false;[\s\S]*await ownerAdmission\(request\);[\s\S]*AuthorityUnavailable/u);
  assert.ok(
    server.indexOf('await extensionManagementHandler(request, response, url)')
      < server.indexOf("url.pathname.startsWith('/api/plugins/')"),
    'management routing must be evaluated before the runtime plugin stream route',
  );
  assert.doesNotMatch(server, /extension-controller\/runtime|dupa-controller/iu);
});