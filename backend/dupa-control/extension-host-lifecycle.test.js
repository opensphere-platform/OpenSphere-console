const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Extension Host reports per-route loading and leaves unrelated guests inactive', () => {
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
  assert.match(extensionHost, /\[entry\.id, 'queued' as PluginLoadState\]/);
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
  assert.match(extensionHost, /child projection element 이름이 유효하지 않음/);
  assert.match(extensionHost, /Boolean\(customElements\.get\(projection\.element\)\)/);
  assert.match(extensionHost, /child projection route가 canonical PFSS 경로가 아님/);

  assert.match(extensionHost, /await this\.ensureRequestedRoute\(window\.location\.pathname\)/);
  assert.match(extensionHost, /if \(!target\.childId\) return;[\s\S]*this\.loadOne\(child/);
  assert.doesNotMatch(extensionHost, /startBackgroundChildActivation|backgroundChildren|CHILD_EXTENSION_ACTIVATION_CONCURRENCY/);
  assert.match(extensionHost, /readonly navigationSnapshot = signal<ConsoleNavigationSnapshot \| null>/);
  assert.match(extensionHost, /hostProjectionDeclarations\.set\(pluginId/);
  assert.match(extensionHost, /this\.activeModules\.has\(projection\.id\)/);
  assert.doesNotMatch(extensionHost, /const childEntries = manifest\.kind/);
  assert.match(extensionHost, /isTransientExtensionLoadError\(err\)/);
  assert.match(extensionHost, /this\.clearPluginFailure\(e\.id\)/);

  assert.match(pluginHost, /@else if \(loading\(\)\)/);
  assert.match(pluginHost, /this\.ext\.pluginLoadState\(this\.id\(\)\)/);
  assert.match(pluginHost, /class="plugin-loading-surface"/);
  assert.doesNotMatch(
    pluginHost,
    /서명·권한·호환성을 확인하고 실행 모듈을 적재하고 있습니다/,
    'normal Extension loading must not be rendered as a top-level alert message',
  );
});
