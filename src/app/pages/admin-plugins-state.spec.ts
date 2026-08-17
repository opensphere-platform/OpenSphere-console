import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./admin-plugins.ts', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../core/plugin-control-client.service.ts', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../app.routes.ts', import.meta.url), 'utf8');
const extensionHost = fs.readFileSync(new URL('../core/extension-host.service.ts', import.meta.url), 'utf8');
const shell = fs.readFileSync(new URL('../os/os-shell.ts', import.meta.url), 'utf8');
const navIcon = fs.readFileSync(new URL('../os/os-nav-icon.ts', import.meta.url), 'utf8');
const perspectives = fs.readFileSync(new URL('../core/perspectives.ts', import.meta.url), 'utf8');
const systemPluginRegistry = fs.readFileSync(new URL('../core/system-plugin-registry.service.ts', import.meta.url), 'utf8');
const compositionManifest = fs.readFileSync(new URL('../core/console-composition.manifest.ts', import.meta.url), 'utf8');
const osShellDescriptor = fs.readFileSync(new URL('../system-plugins/os-shell/os-shell.descriptor.ts', import.meta.url), 'utf8');
const r2d2Descriptor = fs.readFileSync(new URL('../system-plugins/r2d2/r2d2.descriptor.ts', import.meta.url), 'utf8');
const r2d2Route = fs.readFileSync(new URL('../system-plugins/r2d2/r2d2.route.ts', import.meta.url), 'utf8');

test('Extension operations separate user intent, serving state, and verification', () => {
  assert.match(source, /<span>서비스 중<\/span>/);
  assert.match(source, /<span>사용자 비활성<\/span>/);
  assert.match(source, /desiredStateLabel\(r\)/);
  assert.match(source, /verificationGate\(r\)/);
  assert.match(source, /label: phase === 'Failed' \? '서비스 차단'/);
  assert.match(source, /this\.menuState\(r\)\.visible/);
  assert.match(source, /this\.effectiveState\(registration\)\.tone === 'danger'/);
});

test('a currently visible page wins over a stale transient host failure', () => {
  assert.match(source, /const menu = this\.menuState\(r\);[\s\S]*if \(hostFailure && !menu\.visible\)/);
  assert.match(extensionHost, /this\.clearPluginFailure\(e\.id\)/);
});

test('Enabled registrations never present Enable as their primary lifecycle action', () => {
  assert.match(source, /@if \(r\.desiredState === 'Enabled'\)/);
  assert.match(source, /검증 다시 시도/);
  assert.match(source, /명시적 비활성 요청 없음/);
});

test('an unavailable control projection is unknown or stale, never a false zero', () => {
  assert.match(source, /return '—'/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /마지막 정상 값을 유지합니다/);
  assert.match(client, /ExtensionProjectionStatus/);
  assert.match(client, /catalogSnapshot/);
  assert.match(client, /registrationsSnapshot/);
});

test('Extension management separates first-level subShells from host-owned plugins', () => {
  assert.match(source, /SubShell 관리/);
  assert.match(source, /Plugin 관리/);
  assert.match(source, /subShellRegistrations\(\)/);
  assert.match(source, /pluginHostGroups\(\)/);
  assert.match(source, /group\.hostRef/);
  assert.match(source, /plugin은 1단 메뉴 객체가 아닙니다/);
  assert.doesNotMatch(source, /@for \(r of registrations\(\); track r\.name\)/);
});

test('Plugin management lists Console-owned system plugins separately from Registry lifecycle controls', () => {
  assert.match(source, /systemPluginDescriptors = computed\(\(\) => this\.systemPlugins\.list\(\)\)/);
  assert.match(source, /registryPluginCount = computed\(\(\) =>/);
  assert.match(source, /systemPluginCount = computed\(\(\) => this\.systemPluginDescriptors\(\)\.length\)/);
  assert.match(source, /totalPluginCount = computed\(\(\) => this\.registryPluginCount\(\) \+ this\.systemPluginCount\(\)\)/);
  assert.match(source, /<h3>System Plugins<\/h3>/);
  assert.match(source, /descriptor\.displayName/);
  assert.match(source, /descriptor\.category/);
  assert.match(source, /Console exact digest에 결속된 읽기 전용 항목/);
  assert.match(source, /<h2>Registry Plugins<\/h2>/);
  assert.match(systemPluginRegistry, /validateConsoleComposition\(CONSOLE_COMPOSITION_MANIFEST\)/);
  assert.match(compositionManifest, /systemPlugins:\s*Object\.freeze\(\[OS_SHELL_SYSTEM_PLUGIN, R2D2_SYSTEM_PLUGIN\]\)/);
  assert.match(osShellDescriptor, /displayName:\s*'OS Shell'/);
  assert.match(osShellDescriptor, /category:\s*'Developer Tools'/);
  assert.match(r2d2Descriptor, /id:\s*'r2d2'/);
  assert.match(r2d2Descriptor, /displayName:\s*'R2D2'/);
  assert.match(r2d2Descriptor, /category:\s*'AI Orchestration'/);
  assert.match(r2d2Descriptor, /route:\s*'\/manage\/oaa'/);
  assert.match(r2d2Descriptor, /runtimeAdapterId:\s*'cbss\.oaa-gateway'/);
  assert.match(r2d2Route, /loadComponent/);
  assert.match(r2d2Route, /catch\(\(error: unknown\) =>/);
  assert.match(r2d2Route, /return SystemPluginUnavailable/);
  const systemSection = source.slice(source.indexOf('aria-label="System Plugins"'), source.indexOf('<h2>Registry Plugins<\/h2>'));
  assert.doesNotMatch(systemSection, /run\('(?:enable|disable|uninstall)'/);
});

test('Topology includes Console-owned system plugins without treating them as installable Registry extensions', () => {
  assert.match(source, /SystemPluginRegistryService/);
  assert.match(source, /this\.systemPlugins\.list\(\)/);
  assert.match(source, /id: 'system-plugins'/);
  assert.match(source, /label: 'System Plugins'/);
  assert.match(source, /label: descriptor\.displayName/);
  assert.match(source, /descriptor\.category/);
  assert.match(source, /type: 'systemPlugin'/);
  assert.match(source, /Console release-bound/);
  assert.match(source, /actionable: false/);
  assert.match(systemPluginRegistry, /list\(\): readonly SystemPluginDescriptor\[\]/);
  assert.match(systemPluginRegistry, /Object\.freeze\(\[\.\.\.this\.descriptors\.values\(\)\]\)/);
  assert.match(source, /id: 'core-surfaces'/);
  assert.match(source, /label: 'Core Surfaces'/);
  assert.match(source, /type: 'core'/);
  assert.match(compositionManifest, /MANUAL_CORE_SURFACE/);
  assert.match(compositionManifest, /kind:\s*'coreSurface'/);
  assert.match(compositionManifest, /route:\s*'\/manual'/);
});

test('SubShell management projects the selected Carbon icon without a redundant Host column', () => {
  assert.match(source, /let-showHost="showHost" let-showIcon="showIcon"/);
  assert.match(source, /subShellRegistrations\(\)[\s\S]*showHost: false, showIcon: true/);
  assert.match(source, /group\.items[\s\S]*showHost: true, showIcon: false/);
  assert.match(source, /@if \(showHost\) \{ <th class="left">소속 Host<\/th> \}/);
  assert.match(source, /<os-rawicon \[svg\]="extensionIconSvg\(r\.name\)" \[size\]="20" \/>/);
  assert.match(source, /extensionIconToken\(name: string\)/);
});

test('the catalog icon selected in management wins when first-level navigation is composed', () => {
  assert.match(extensionHost, /await this\.loadManagementInventory\(\)/);
  assert.match(extensionHost, /\.\.\.Object\.fromEntries\(activePlugins\.map[\s\S]*\.\.\.current/);
  assert.match(extensionHost, /\.\.\.current,[\s\S]*\.\.\.Object\.fromEntries\(items\.map/);
  assert.match(shell, /<os-nav-icon clrVerticalNavIcon \[token\]="iconTokenFor\(item\)"/);
  assert.match(navIcon, /return this\.iconLibrary\.getSvg\(this\.token\)/);
});

test('every Extension management tab has a reloadable canonical route', () => {
  assert.match(routes, /path: 'extensions', redirectTo: 'extensions\/subshells'/);
  assert.match(routes, /path: 'extensions\/:view', component: AdminPlugins/);
  for (const view of ['subshells', 'plugins', 'topology', 'catalog', 'audit', 'bindings']) {
    assert.match(source, new RegExp(`selectView\\('${view}'\\)`));
    assert.match(source, new RegExp(`activeView\\(\\) === '${view}'`));
  }
});

test('PFSS child plugins keep their host ownership across routes and navigation', () => {
  assert.match(routes, /return childPath \? `\/pfss\/\$\{childPath\}` : '\/pfss\/foundation'/);
  assert.match(routes, /path: 'p\/opensearch', redirectTo: 'pfss\/opensearch'/);
  assert.match(routes, /path: 'p\/postgres', redirectTo: 'pfss\/postgres'/);
  assert.match(routes, /matcher: pfssHostMatcher, component: PluginHost, data: \{ pluginId: 'foundation' \}/);
  assert.match(extensionHost, /hostRef: String\(item\['hostRef'\] \|\| 'main'\)/);
  assert.match(extensionHost, /this\.activeModules\.has\(entry\.id\)/);
  assert.doesNotMatch(shell, /this\.ext\.managementInventory\(\)/);
  assert.match(source, /const projection = hostRef === 'main' \? undefined : this\.ext\.hostChildProjection\(hostRef, r\.name\)/);
  assert.match(source, /if \(projection\) return projection\.route/);
  assert.match(source, /label: 'Host 메뉴 사용 가능'/);
  assert.match(source, /this\.ext\.pluginLoadState\(r\.name\)/);
  assert.match(perspectives, /id === 'foundation' \? '\/pfss\/foundation' : `\/p\/\$\{id\}`/);
});

test('a verified child is not reported available until its host acknowledges the real route and element', () => {
  assert.match(extensionHost, /readonly hostChildProjections = signal/);
  assert.match(extensionHost, /reportProjections: reportChildProjections/);
  assert.match(extensionHost, /!customElements\.get\(element\)/);
  assert.match(extensionHost, /this\.activeModules\.has\(entry\.id\)/);
  assert.match(source, /HostProjectionMissing/);
  assert.match(source, /label: 'Host 연동 실패'/);
  assert.match(source, /this\.ext\.hostChildProjection\(hostRef, r\.name\)/);
  assert.match(source, /\{\{ menuState\(r\)\.reason \}\}/);
});
