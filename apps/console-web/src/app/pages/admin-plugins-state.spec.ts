import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  clearStaleLazyChunkRetry,
  isStaleLazyChunkError,
  recoverStaleLazyChunkOnce,
} from '../system-plugins/system-plugin-lazy-recovery.ts';

const source = fs.readFileSync(new URL('./admin-plugins.ts', import.meta.url), 'utf8');
const navigation = fs.readFileSync(new URL('./extensions-workspace-nav.ts', import.meta.url), 'utf8');
const modules = fs.readFileSync(new URL('./admin-modules.html', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../core/plugin-control-client.service.ts', import.meta.url), 'utf8');
const projectionStore = fs.readFileSync(new URL('../core/extension-projection.store.ts', import.meta.url), 'utf8');
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

test('an activation failure remains visible even when navigation stays available', () => {
  assert.match(source, /const menu = this\.menuState\(r\);[\s\S]*if \(hostFailure\)/);
  assert.match(source, /메뉴 노출 · \$\{this\.extensionLoadFailureLabel\(failure\.stage\)\}/);
  assert.match(extensionHost, /this\.clearPluginFailure\(e\.id\)/);
});

test('loading and failures are reported per extension and by the actual failed stage', () => {
  assert.match(source, /const pluginState = this\.ext\.pluginLoadState\(r\.name\)/);
  assert.match(source, /pluginState === 'queued'/);
  assert.match(source, /label: '탐색 스냅샷 확인 중'/);
  assert.match(source, /label: '요청 화면 적재 중'/);
  for (const label of ['Manifest 검증 실패', '서명 검증 실패', '실행 파일 적재 실패', '화면 Asset 적재 실패', 'UI 활성화 실패']) {
    assert.ok(source.includes(label), `${label} 단계 표시가 필요하다`);
  }
  assert.doesNotMatch(source, /label: 'Host 적재 실패'/);
});

test('Enabled registrations never present Enable as their primary lifecycle action', () => {
  assert.match(source, /@if \(r\.desiredState === 'Enabled'\)/);
  assert.match(source, /검증 다시 시도/);
  assert.match(source, /명시적 비활성 요청 없음/);
});

test('an unavailable control projection is unknown or stale, never a false zero', () => {
  assert.match(source, /return '—'/);
  assert.match(source, /registrationsLoaded\(\) \? String\(this\.subShellRegistrations\(\)\.length\) : '—'/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /마지막 정상 값을 유지합니다/);
  assert.match(client, /ExtensionProjectionStatus/);
  assert.match(client, /catalogSnapshot/);
  assert.match(client, /registrationsSnapshot/);
  assert.match(projectionStore, /private inFlight/);
  assert.match(source, /void this\.refreshOperationalData\(\);[\s\S]*await this\.projections\.refresh\(force\)/);
});

test('Extension management separates first-level subShells from host-owned plugins', () => {
  assert.match(source, /설치된 기능/);
  assert.match(source, /하위 기능 관리/);
  assert.match(source, /subShellRegistrations\(\)/);
  assert.match(source, /pluginHostGroups\(\)/);
  assert.match(source, /group\.hostRef/);
  assert.match(source, /하위 기능은 1단 메뉴 객체가 아닙니다/);
  assert.doesNotMatch(source, /@for \(r of registrations\(\); track r\.name\)/);
});

test('Plugin management lists Console-owned system plugins separately from Registry lifecycle controls', () => {
  assert.match(source, /systemPluginDescriptors = computed\(\(\) => this\.systemPlugins\.list\(\)\)/);
  assert.match(source, /registryPluginCount = computed\(\(\) =>/);
  assert.match(source, /systemPluginCount = computed\(\(\) => this\.systemPluginDescriptors\(\)\.length\)/);
  assert.match(source, /totalPluginCount = computed\(\(\) => this\.registryPluginCount\(\) \+ this\.systemPluginCount\(\)\)/);
  assert.match(source, /<h3>Console 내장 기능<\/h3>/);
  assert.match(source, /descriptor\.displayName/);
  assert.match(source, /descriptor\.category/);
  assert.match(source, /Console 릴리스에 포함된 읽기 전용 항목/);
  assert.match(source, /<h2>Registry 기능 기여<\/h2>/);
  assert.match(systemPluginRegistry, /validateConsoleComposition\(CONSOLE_COMPOSITION_MANIFEST\)/);
  assert.match(compositionManifest, /systemPlugins:\s*Object\.freeze\(\[OS_SHELL_SYSTEM_PLUGIN, R2D2_SYSTEM_PLUGIN\]\)/);
  assert.match(osShellDescriptor, /displayName:\s*'OS Shell'/);
  assert.match(osShellDescriptor, /category:\s*'Developer Tools'/);
  assert.match(r2d2Descriptor, /id:\s*'r2d2'/);
  assert.match(r2d2Descriptor, /displayName:\s*'R2D2'/);
  assert.match(r2d2Descriptor, /category:\s*'AI Orchestration'/);
  assert.match(r2d2Descriptor, /route:\s*'\/manage\/osaa'/);
  assert.match(r2d2Descriptor, /runtimeAdapterId:\s*'cbss\.osaa-gateway'/);
  assert.match(r2d2Route, /loadComponent/);
  assert.match(r2d2Route, /catch\(\(error: unknown\) =>/);
  assert.match(r2d2Route, /return SystemPluginUnavailable/);
  const systemSection = source.slice(source.indexOf('aria-label="Console 내장 기능"'), source.indexOf('<h2>Registry 기능 기여<\/h2>'));
  assert.doesNotMatch(systemSection, /run\('(?:enable|disable|uninstall)'/);
});

test('a stale system-plugin lazy chunk reloads once without hiding a persistent failure', () => {
  const values = new Map<string, string>();
  let reloads = 0;
  const browser = {
    location: {
      href: 'https://localhost:1114/manage/osaa',
      reload: () => { reloads += 1; },
    },
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  };
  const staleError = new TypeError('Failed to fetch dynamically imported module: https://localhost:1114/chunk-old.js');

  assert.equal(isStaleLazyChunkError(staleError), true);
  assert.equal(recoverStaleLazyChunkOnce('r2d2', staleError, browser), true);
  assert.equal(reloads, 1);
  assert.equal(recoverStaleLazyChunkOnce('r2d2', staleError, browser), false);
  assert.equal(reloads, 1);
  assert.equal(recoverStaleLazyChunkOnce('r2d2', new Error('component initialization failed'), browser), false);

  clearStaleLazyChunkRetry('r2d2', browser);
  assert.equal(recoverStaleLazyChunkOnce('r2d2', staleError, browser), true);
  assert.equal(reloads, 2);
});

test('Topology includes Console-owned system plugins without treating them as installable Registry extensions', () => {
  assert.match(source, /SystemPluginRegistryService/);
  assert.match(source, /this\.systemPlugins\.list\(\)/);
  assert.match(source, /id: 'system-plugins'/);
  assert.match(source, /label: '기본 제공 기능'/);
  assert.match(source, /label: descriptor\.displayName/);
  assert.match(source, /descriptor\.category/);
  assert.match(source, /type: 'systemPlugin'/);
  assert.match(source, /Console 릴리스에 포함/);
  assert.match(source, /actionable: false/);
  assert.match(systemPluginRegistry, /list\(\): readonly SystemPluginDescriptor\[\]/);
  assert.match(systemPluginRegistry, /Object\.freeze\(\[\.\.\.this\.descriptors\.values\(\)\]\)/);
  assert.match(source, /id: 'core-surfaces'/);
  assert.match(source, /label: '기본 화면'/);
  assert.match(source, /type: 'core'/);
  assert.match(compositionManifest, /MANUAL_CORE_SURFACE/);
  assert.match(compositionManifest, /kind:\s*'coreSurface'/);
  assert.match(compositionManifest, /route:\s*'\/manual'/);
});

test('SubShell management projects the selected Carbon icon without a redundant Host column', () => {
  assert.match(source, /let-showHost="showHost" let-showIcon="showIcon"/);
  assert.match(source, /orderedSubShellRegistrations\(\)[\s\S]*showHost: false, showIcon: true/);
  assert.match(source, /group\.items[\s\S]*showHost: true, showIcon: false/);
  assert.match(source, /@if \(showHost\) \{ <th class="left">소속 Host<\/th> \}/);
  assert.match(source, /<os-nav-icon \[token\]="extensionIconToken\(r\.name\)" \[size\]="20" \/>/);
  assert.match(source, /extensionIconToken\(name: string\)/);
});

test('the catalog icon selected in management wins when first-level navigation is composed', () => {
  assert.match(extensionHost, /const managementLoad = this\.loadManagementInventory\(\)/);
  assert.match(extensionHost, /\.\.\.Object\.fromEntries\(activePlugins\.map[\s\S]*\.\.\.current/);
  assert.match(extensionHost, /\.\.\.current,[\s\S]*\.\.\.Object\.fromEntries\(items\.map/);
  assert.match(shell, /<os-nav-icon clrVerticalNavIcon \[token\]="iconTokenFor\(item\)"/);
  assert.match(navIcon, /assets\/carbon-icons/);
});

test('SubShell navigation order and optional menu label are explicit management controls', () => {
  assert.match(source, /cdkDropList/);
  assert.match(source, /cdkDrag/);
  assert.match(source, /cdkDropListDropped\)="dropSubShell\(\$event\)"/);
  assert.match(source, /Extension · 1단 메뉴/);
  assert.match(source, /extension-order-handle/);
  assert.doesNotMatch(source, /MAIN SHELL NAVIGATION/);
  assert.doesNotMatch(source, /subshell-menu-editor/);
  assert.match(source, /setNavigationOrder\(this\.orderedSubShellRegistrations\(\)\.map/);
  assert.match(source, /@for \(r of group\.items; track r\.name\) \{\s*<tr cdkDrag cdkDragLockAxis="y"/);
  assert.match(source, /<ng-template #extensionStatusCells/);
  assert.doesNotMatch(source, /<ng-template #extensionStatusCells[^>]*>\s*<tr cdkDrag/);
  assert.match(source, /menuLabelOverride\(\)/);
  assert.match(source, /비워서 저장하면 원래 이름/);
  assert.match(source, /setNavigation\(id, \{ labelOverride: value \}\)/);
  assert.ok(
    source.indexOf('aria-label="1단 메뉴 표시 설정"')
      < source.indexOf('aria-labelledby="cc-integrations-title"'),
    'SubShell menu settings must be presented before Console integration status'
  );
});

test('a forced projection refresh queues one fresh read behind stale in-flight work', () => {
  assert.match(projectionStore, /private forcedAfterInFlight/);
  assert.match(projectionStore, /if \(!force\) return this\.inFlight/);
  assert.match(projectionStore, /const active = this\.inFlight;[\s\S]*\.then\(\(\) => this\.refresh\(true\)\)/);
  assert.match(projectionStore, /if \(this\.forcedAfterInFlight === forced\) this\.forcedAfterInFlight = null/);
});

test('inactive routes are healthy on-demand lifecycle states, not UI or Host failures', () => {
  assert.match(source, /label: 'Host 메뉴 노출'/);
  assert.match(source, /화면은 요청 시 적재/);
  assert.match(source, /tone: this\.ext\.pluginLoadState\(r\.name\) === 'queued' \? 'success' : 'warning'/);
  assert.doesNotMatch(source, /label: childState === 'queued' \? '요청 시 적재'/);
  assert.doesNotMatch(source, /백그라운드 순서를 기다리는 중|background 순서를 기다리는 중/);
});

test('every Extension management tab has a reloadable canonical route', () => {
  assert.match(routes, /path: 'extensions', redirectTo: 'extensions\/subshells'/);
  assert.match(routes, /path: 'extensions\/:view', component: AdminPlugins/);
  assert.match(navigation, /\[routerLink\]="'\/manage\/extensions\/'\+item\.id"/);
  for (const view of ['subshells', 'plugins', 'topology', 'catalog', 'registry-connections', 'trust', 'audit', 'bindings']) {
    assert.ok(new RegExp("id:\\s*'" + view + "'").test(source));
  }
  assert.match(source, /activeView\(\) === 'registry-connections'/);
  assert.match(source, /activeView\(\) === 'trust'/);
});

test('Registry delivery and trust have explicit no-secret controls and impact previews', () => {
  assert.match(source, /Registry 연결/);
  assert.match(source, /신뢰·회수/);
  assert.match(client, /\/registry-connections\/opensphere-ghcr\/verify/);
  assert.match(source, /registryDependentPackages/);
  assert.match(source, /revocationImpact/);
  assert.match(source, /revokeExpectedConfirmation\(image: string\)/);
  assert.match(client, /\.\.\.\(replacementImage \? \{ replacementImage \} : \{\}\)/);
  assert.doesNotMatch(client, /executionRevision/);
});

test('SubShell menu groups support a bounded override and signed-default reset', () => {
  assert.match(source, /standardNavigationBands/);
  assert.match(source, /customNavigationBands/);
  assert.match(source, /bandOverride/);
  assert.match(source, /비워서 저장하면 signed package의 기본 그룹으로 복원합니다/);
  assert.match(client, /bandOverride\?: string/);
});

test('Catalog separates common Registry descriptors from Console Extension package lifecycle', () => {
  assert.match(source, /<h2 id="foundation-catalog-title">OpenSphere Registry Inventory<\/h2>/);
  assert.match(source, /<h2 id="extension-package-catalog-title">Extension Packages<\/h2>/);
  assert.match(source, /Foundation service plan과는 다른 생명주기입니다/);
  assert.match(source, /foundationCatalogSnapshot/);
  assert.match(source, /\/api\/v1\/registry/);
  assert.match(source, /body\.schema !== 'opensphere\.registry-catalog\/v1'/);
  assert.match(source, /body\.stale/);
  assert.match(source, /moduleCatalogFresh\(body\)/);
  assert.match(source, /snapshot\.catalog\.moduleDescriptors/);
  assert.match(source, /snapshot\.inventory\.coverage/);
  assert.match(source, /registryDescriptorClasses/);
  assert.match(source, /coreService.*extension.*installableModule/);
  assert.doesNotMatch(source, /snapshot\.catalog\.plans/);
  assert.doesNotMatch(source, /snapshot\.catalog\.runtimeCatalogs/);
  assert.match(source, /Core Service, Console Extension, 설치 가능 모듈/);
});

test('Foundation module Catalog does not configure or create service instances', () => {
  const catalogSection = source.slice(source.indexOf('id="foundation-catalog-title"'), source.indexOf('id="extension-package-catalog-title"'));
  assert.match(modules, /관리 화면 열기/);
  assert.ok(source.includes('<os-admin-modules [embedded]="true"'));
  assert.doesNotMatch(catalogSection, /create-postgres-cluster|operations\/plan|postgresVersion|Instance name|Available/);
  assert.doesNotMatch(source, /createOscePostgresPlan|selectedFoundationPlan|oscePlan/);
});

test('PFSS child plugins keep their host ownership across routes and navigation', () => {
  assert.match(routes, /matcher: platformSupportDeliveryMatcher,[\s\S]*data: \{ pluginId: 'foundation' \}/);
  assert.match(routes, /segments\[1\]\.path === 'delivery' && \['argocd', 'crossplane'\]\.includes\(segments\[2\]\?\.path \?\? ''\)/);
  assert.match(routes, /return childPath \? `\/pfss\/\$\{childPath\}` : '\/pfss\/foundation'/);
  assert.match(routes, /path: 'p\/opensearch', redirectTo: 'pfss\/opensearch'/);
  assert.match(routes, /path: 'p\/postgres', redirectTo: 'pfss\/postgres'/);
  assert.match(routes, /matcher: pfssHostMatcher, component: PluginHost, data: \{ pluginId: 'foundation' \}/);
  assert.match(extensionHost, /hostRef: item\.hostRef \|\| 'main'/);
  assert.match(extensionHost, /declarations\.filter\(\(projection\) => approvedChildren\.has\(projection\.id\)\)/);
  assert.doesNotMatch(shell, /this\.ext\.managementInventory\(\)/);
  assert.match(source, /const projection = hostRef === 'main' \? undefined : this\.ext\.hostChildProjection\(hostRef, r\.name\)/);
  assert.match(source, /if \(projection\) return projection\.route/);
  assert.match(source, /label: 'Host 메뉴 사용 가능'/);
  assert.match(source, /this\.ext\.pluginLoadState\(r\.name\)/);
  assert.match(perspectives, /id === 'foundation' \? '\/pfss\/foundation' : `\/p\/\$\{id\}`/);
});

test('a verified host declaration exposes Registry-approved navigation before child execution', () => {
  assert.match(extensionHost, /readonly hostChildProjections = signal/);
  assert.match(extensionHost, /reportProjections: reportChildProjections/);
  assert.match(extensionHost, /hostProjectionDeclarations\.set\(pluginId/);
  assert.match(extensionHost, /approvedChildren\.has\(projection\.id\)/);
  assert.doesNotMatch(extensionHost, /Boolean\(customElements\.get\(projection\.element\)\)/);
  assert.doesNotMatch(extensionHost, /approvedChildren\.has\(projection\.id\)[\s\S]{0,120}this\.activeModules\.has\(projection\.id\)/);
  assert.match(source, /label: 'Host 메뉴 노출'/);
  assert.match(source, /this\.ext\.hostChildProjection\(hostRef, r\.name\)/);
  assert.match(source, /\{\{ menuState\(r\)\.reason \}\}/);
});
