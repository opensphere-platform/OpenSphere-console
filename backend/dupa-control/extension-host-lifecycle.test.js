const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Extension Host reports loading and activates verified children before their host overview', () => {
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
  assert.match(extensionHost, /readonly hostChildProjections = signal/);
  assert.match(extensionHost, /readonly registryUpdatePending = signal\(false\)/);
  assert.match(extensionHost, /Registry update staged for the next document/);
  assert.match(extensionHost, /if \(this\.registryUpdatePending\(\)\) return/);
  assert.doesNotMatch(extensionHost, /window\.location\.reload\(\)/);
  assert.match(extensionHost, /const artifactBase = `\/api\/plugins\/\$\{artifactServiceId\}`/);
  assert.match(extensionHost, /entry가 검증된 release namespace 밖에 있음/);
  assert.match(extensionHost, /apiBase: artifactBase/);
  assert.match(extensionHost, /this\.verifyAssets\(artifactBase, e\.manifest, manifest\.assets\)/);
  assert.match(extensionHost, /reportProjections: reportChildProjections/);
  assert.match(extensionHost, /child projection element가 정의되지 않음/);
  assert.match(extensionHost, /child projection route가 canonical PFSS 경로가 아님/);

  const childSelection = extensionHost.indexOf("const childEntries = manifest.kind === 'subShell'");
  const requestedChildLoad = extensionHost.indexOf('if (requestedChild)', childSelection);
  const remainingChildLoad = extensionHost.indexOf('await Promise.all(childEntries', requestedChildLoad);
  const parentActivate = extensionHost.indexOf('await mod.activate(context)', remainingChildLoad);
  assert.ok(childSelection >= 0, 'subShell child selection block must exist');
  assert.ok(requestedChildLoad > childSelection, 'a directly requested child must be selected explicitly');
  assert.ok(remainingChildLoad > requestedChildLoad, 'remaining children must join the verified host projection');
  assert.ok(parentActivate > remainingChildLoad, 'the parent must receive only the completed child activation projection');

  assert.match(pluginHost, /@else if \(loading\(\)\)/);
  assert.match(pluginHost, /this\.ext\.pluginLoadState\(this\.id\(\)\)/);
  assert.match(pluginHost, /class="plugin-loading-surface"/);
  assert.doesNotMatch(
    pluginHost,
    /서명·권한·호환성을 확인하고 실행 모듈을 적재하고 있습니다/,
    'normal Extension loading must not be rendered as a top-level alert message',
  );
});
