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

  const childLoad = extensionHost.indexOf("if (manifest.kind === 'subShell')");
  const parentActivate = extensionHost.indexOf('await mod.activate(context)', childLoad);
  assert.ok(childLoad >= 0, 'subShell child loading block must exist');
  assert.ok(parentActivate > childLoad, 'children must load before the parent registers its page');

  assert.match(pluginHost, /@else if \(loading\(\)\)/);
  assert.match(pluginHost, /this\.ext\.loadState\(\) === 'loading'/);
});
