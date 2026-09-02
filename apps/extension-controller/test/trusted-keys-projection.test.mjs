import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseTrustedExtensionKeys } from '../src/extension-release.mjs';

const root = resolve(import.meta.dirname, '..', '..', '..');

function embeddedTrust(yaml) {
  const match = yaml.match(/trusted-keys[.]json:\s*[|]\r?\n([\s\S]+)$/u);
  assert.ok(match, 'trusted-keys.json block must exist');
  return JSON.parse(match[1].replace(/^ {4}/gmu, '')).trustedKeys;
}

test('target trust ConfigMap preserves every reviewed SPKI byte under its existing keyId', async () => {
  const [target, historical, lifecycle, server] = await Promise.all([
    readFile(resolve(root, 'apps/extension-controller/config/trusted-keys.yaml'), 'utf8'),
    readFile(resolve(root, 'apps/extension-controller/runtime/dupa-trusted-keys.yaml'), 'utf8'),
    readFile(resolve(root, 'apps/extension-controller/src/kubernetes-extension-lifecycle.mjs'), 'utf8'),
    readFile(resolve(root, 'apps/extension-controller/src/server.mjs'), 'utf8'),
  ]);
  assert.match(target, /name: opensphere-extension-trusted-keys/u);
  assert.match(target, /namespace: opensphere-console/u);
  assert.doesNotMatch(target, /dupa/iu);
  const targetKeys = embeddedTrust(target);
  const historicalKeys = embeddedTrust(historical);
  assert.deepEqual(targetKeys, historicalKeys);
  assert.deepEqual(Object.keys(targetKeys), [
    'opensphere-plugins-v1',
    'opensphere-plugins-v2',
    'opensphere-plugins-v3',
    'opensphere-plugins-v4',
    'opensphere-plugins-v5',
  ]);
  assert.deepEqual(parseTrustedExtensionKeys({ trustedKeys: targetKeys }), targetKeys);
  assert.match(lifecycle, /trustedKeysConfigMap = 'opensphere-extension-trusted-keys'/u);
  assert.match(server, /CONSOLE_EXTENSION_TRUSTED_KEYS_CONFIGMAP \|\| 'opensphere-extension-trusted-keys'/u);
});
