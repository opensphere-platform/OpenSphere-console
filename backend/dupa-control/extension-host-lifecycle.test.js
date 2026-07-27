const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Extension Host reports initial loading and defines child plugins before the parent page', () => {
  const extensionHost = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'app', 'core', 'extension-host.service.ts'),
    'utf8',
  );
  const pluginHost = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'app', 'pages', 'plugin-host.ts'),
    'utf8',
  );

  assert.match(extensionHost, /readonly loadState = signal<'idle' \| 'loading' \| 'ready'>\('idle'\)/);
  assert.match(extensionHost, /this\.loadState\.set\('loading'\)/);
  assert.match(extensionHost, /finally \{\s*this\.loadState\.set\('ready'\)/);
  assert.match(extensionHost, /readonly pluginLoadStates = signal<Record<string, PluginLoadState>>\(\{\}\)/);
  assert.match(extensionHost, /this\.setPluginLoadState\(e\.id, 'loading'\)/);
  assert.match(extensionHost, /this\.setPluginLoadState\(e\.id, 'ready'\)/);
  assert.match(extensionHost, /this\.setPluginLoadState\(e\.id, 'failed'\)/);

  const childLoad = extensionHost.indexOf("if (manifest.kind === 'subShell')");
  const parentActivate = extensionHost.indexOf('await mod.activate(context)', childLoad);
  assert.ok(childLoad >= 0, 'subShell child loading block must exist');
  assert.ok(parentActivate > childLoad, 'children must load before the parent registers its page');

  assert.match(pluginHost, /@else if \(loading\(\)\)/);
  assert.match(pluginHost, /this\.ext\.pluginLoadState\(this\.id\(\)\)/);
  assert.match(pluginHost, /class="plugin-loading-surface"/);
  assert.doesNotMatch(
    pluginHost,
    /서명·권한·호환성을 확인하고 실행 모듈을 적재하고 있습니다/,
    'normal Extension loading must not be rendered as a top-level alert message',
  );
});
