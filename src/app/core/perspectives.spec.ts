import assert from 'node:assert/strict';
import test from 'node:test';
import { pluginIdFromRoute, routeForPlugin } from './perspectives';

test('Foundation uses its PFSS route and resolves back to the extension id', () => {
  assert.equal(routeForPlugin('foundation'), '/pfss/foundation');
  assert.equal(pluginIdFromRoute('/pfss/foundation'), 'foundation');
});

test('regular first-level plugin routes resolve their extension id', () => {
  assert.equal(pluginIdFromRoute('/p/gitlab'), 'gitlab');
  assert.equal(pluginIdFromRoute('/p/ai-workbench?view=models'), 'ai-workbench');
  assert.equal(pluginIdFromRoute('/manage/extensions'), '');
});
