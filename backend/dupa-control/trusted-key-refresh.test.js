import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const controller = readFileSync(new URL('./controller.js', import.meta.url), 'utf8');

test('module verification reloads the live trusted-key ConfigMap', () => {
  const loader = controller.match(/async function loadTrustedKeys\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(loader, /k8s\('GET', `\/api\/v1\/namespaces\/\$\{NS\}\/configmaps\/dupa-trusted-keys`\)/);
  assert.doesNotMatch(loader, /if \(_trustedKeys\)/);
  assert.doesNotMatch(controller, /let _trustedKeys\s*=/);
});
