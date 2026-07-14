const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('base Main Shell has no built-in AI or Manual consumer surface', () => {
  const shell = read('src', 'app', 'os', 'os-shell.ts');
  const routes = read('src', 'app', 'app.routes.ts');
  const search = read('src', 'app', 'core', 'search.service.ts');
  const nginx = read('nginx', 'default.conf.template');

  assert.doesNotMatch(shell, /OsOaaAgent|<os-oaa-agent/);
  assert.doesNotMatch(routes, /redirectTo:\s*'p\/manual'/);
  assert.doesNotMatch(search, /ManualService|\/p\/manual/);
  assert.doesNotMatch(nginx, /location\s+\/api\/(?:oaa|manual)\//);
});

test('Backbone bootstrap contains exactly the three required pillars', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  const manifest = read('backend', 'backbone', 'bootstrap', 'backbone.yaml');
  const components = controller.slice(controller.indexOf('const BB_COMPONENTS'), controller.indexOf('const BB_ACCESS'));

  for (const pillar of ['backbone-postgres', 'backbone-rustfs', 'backbone-gitea']) {
    assert.match(components, new RegExp(pillar));
    assert.match(manifest, new RegExp(pillar));
  }
  assert.doesNotMatch(components, /oaa|manual/i);
  assert.doesNotMatch(manifest, /opensphere-console-oaa-gateway|OAA_GATEWAY_IMAGE/);
  assert.doesNotMatch(controller, /function bbWorkloads/);
});

test('base deployment does not declare or pre-install any Consumer', () => {
  const deploy = read('deploy', 'opensphere-console.yaml');
  const optionalAi = read('backend', 'backbone', 'console-services.yaml');
  const adminBackbone = read('src', 'app', 'pages', 'admin-backbone.ts');

  assert.doesNotMatch(deploy, /kind:\s*UIPlugin(?:Package|Registration)/);
  assert.match(optionalAi, /OPTIONAL AI STAGING MANIFEST/);
  assert.doesNotMatch(adminBackbone, /OAA|oaa|LlmKey|KnowledgeStore/);
});

test('native management assets have one canonical tree under /manage', () => {
  const routes = read('src', 'app', 'app.routes.ts');
  const layout = read('src', 'app', 'pages', 'admin-layout.ts');
  const shell = read('src', 'app', 'os', 'os-shell.ts');
  const search = read('src', 'app', 'core', 'search.service.ts');

  assert.match(routes, /path:\s*'manage'[\s\S]*path:\s*'catalog',\s*component:\s*Catalog/);
  assert.match(routes, /path:\s*'manage'[\s\S]*path:\s*'apis',\s*component:\s*Apis/);
  assert.doesNotMatch(routes, /path:\s*'(?:catalog|apis|console-admins)',\s*redirectTo/);
  assert.doesNotMatch(routes, /path:\s*'admin\/(?:plugins|roles)'/);
  for (const group of ['자산 및 확장', '신원 및 접근', '플랫폼 기반', '운영']) assert.match(layout, new RegExp(group));
  for (const route of ['/manage/catalog', '/manage/apis', '/manage/extensions']) assert.match(layout, new RegExp(route));
  assert.match(shell, /private static readonly NATIVE: NavBand\[\] = \[\]/);
  assert.doesNotMatch(search, /path:\s*'\/(?:catalog|apis|admin\/plugins|admin\/roles|console-admins)'/);
});

test('Console UI and native CLI share the canonical catalog API without an rhdh alias', () => {
  const nginx = read('nginx', 'default.conf.template');
  const api = read('src', 'app', 'core', 'api.service.ts');
  const cli = read('backend', 'os-cli', 'cmd', 'os', 'main.go');
  assert.match(nginx, /location \/api\/catalog\//);
  assert.match(api, /\/api\/catalog\/entities/);
  assert.match(cli, /path := "\/api\/catalog\/entities"/);
  assert.doesNotMatch(`${nginx}\n${api}`, /\/api\/rhdh/);
});

test('notification detail uses the shared right sliding panel', () => {
  const notifications = read('src', 'app', 'pages', 'admin-notifications.ts');

  assert.match(notifications, /imports:\s*\[[^\]]*OsPanel/);
  assert.match(notifications, /<os-panel[\s\S]*\[open\]="!!selected\(\)"/);
  assert.match(notifications, /\(click\)="open\(n\)"/);
  assert.match(notifications, /관련 화면으로 이동/);
  assert.doesNotMatch(notifications, /clr-dg-row-detail|clrIfExpanded/);
});

test('audited management UI uses Clarity controls and explicit accessibility states', () => {
  const plugins = read('src', 'app', 'pages', 'admin-plugins.ts');
  const roles = read('src', 'app', 'pages', 'admin-roles.ts');
  const admins = read('src', 'app', 'pages', 'console-admins.ts');
  const backbone = read('src', 'app', 'pages', 'backbone-slice.ts');
  const notifications = read('src', 'app', 'os', 'os-notifications.ts');
  const catalog = read('src', 'app', 'pages', 'catalog.ts');
  const apis = read('src', 'app', 'pages', 'apis.ts');
  const shell = read('src', 'app', 'os', 'os-shell.ts');
  const styles = read('src', 'styles.scss');
  const index = read('src', 'index.html');
  const audited = [plugins, roles, admins, backbone, notifications, catalog, apis].join('\n');

  assert.match(plugins, /<os-panel/);
  assert.doesNotMatch(plugins, /cc-drawer-backdrop|<aside class="cc-drawer"/);
  assert.match(notifications, /<clr-dropdown/);
  assert.match(notifications, /<clr-alert/);
  assert.doesNotMatch(audited, /\b(?:window\.)?(?:prompt|confirm)\s*\(/);
  assert.doesNotMatch(audited, /http:\/\/localhost:7007|cdn\.statically\.io/);
  assert.match(backbone, /https:\/\/logos\.opl\.io\.kr\/i\//);
  assert.match(catalog, /\[loading\]="loading\(\)"/);
  assert.match(admins, /\[loading\]="identityLoading\(\)"/);
  assert.match(catalog, /HTTP \(401\|403\)/);
  assert.match(shell, /본문으로 건너뛰기/);
  assert.match(index, /<html lang="ko">/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /forced-colors/);
});

test('one top-level design guide is the only design policy SSOT', () => {
  const guide = read('DESIGN-GUIDE.md');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));

  assert.match(guide, /Clarity Design System v18/);
  assert.match(guide, /Carbon 아이콘은 승인된 요소/);
  assert.match(guide, /https:\/\/logos\.opl\.io\.kr\//);
  assert.match(guide, /구현 전에 사용자 승인을 받고/);
  assert.match(pkg.dependencies['@clr/angular'], /18\./);
  assert.match(pkg.dependencies['@clr/ui'], /18\./);
  assert.match(lock.packages['node_modules/@clr/angular'].version, /^18\./);
  assert.equal(
    lock.packages['node_modules/@clr/angular'].version,
    lock.packages['node_modules/@clr/ui'].version,
    'Clarity Angular and UI must use the same release line',
  );
  for (const legacy of [
    ['DESIGN-RULES.md'],
    ['docs', 'DESIGN-TOKENS.md'],
    ['docs', 'dupa-nav-contribution-contract.md'],
  ]) {
    assert.equal(fs.existsSync(path.join(root, ...legacy)), false, `${legacy.join('/')} must be absorbed and deleted`);
  }
});

test('os CLI is Console-native and cannot be reintroduced as a Binding', () => {
  const routes = read('src', 'app', 'app.routes.ts');
  const layout = read('src', 'app', 'pages', 'admin-layout.ts');
  const page = read('src', 'app', 'pages', 'admin-cli.ts');
  const nginx = read('nginx', 'default.conf.template');
  const controller = read('backend', 'dupa-control', 'controller.js');
  const manifest = JSON.parse(read('backend', 'os-cli', 'index.json'));
  const deploy = read('backend', 'os-cli', 'deploy.yaml');
  const cliDockerfile = read('backend', 'os-cli', 'Dockerfile');
  const dockerfile = read('Dockerfile');

  assert.match(routes, /path:\s*'cli',\s*component:\s*AdminCli/);
  assert.match(layout, /route:\s*'\/manage\/cli'/);
  assert.match(page, /<clr-datagrid>/);
  assert.match(page, /<clr-alert/);
  assert.match(nginx, /location \/api\/cli\//);
  assert.match(nginx, /location \/api\/cli\/[\s\S]*try_files \$uri =404/);
  assert.doesNotMatch(nginx, /os-cli\.opensphere-console\.svc/);
  assert.match(dockerfile, /AS cli-build/);
  assert.match(dockerfile, /AS cli-manifest/);
  assert.match(dockerfile, /RUN node \.\/generate-manifest\.mjs/);
  assert.match(dockerfile, /COPY --from=cli-manifest \/manifest\/artifacts\/ \/usr\/share\/nginx\/html\/api\/cli\//);
  assert.doesNotMatch(nginx, /location .*\/api\/plugins\/os-cli/);
  assert.match(controller, /NATIVE_BINDING_NAMES = new Set\(\['os'\]\)/);
  assert.equal(manifest.ownership, 'console-native');
  assert.equal(manifest.profile, 'admin');
  assert.equal(manifest.extensionBoundary.adminTokenReuse, false);
  assert.ok(manifest.links.every((link) => link.href.startsWith('/api/cli/')));
  // The source manifest is only a schema template. Both Console image variants
  // must hydrate it from the exact artifacts compiled in that build.
  assert.ok(manifest.links.every((link) => link.sha256 === '0'.repeat(64) && link.size === 0));
  assert.match(cliDockerfile, /RUN node generate-manifest\.mjs/);
  assert.match(cliDockerfile, /index\.generated\.json/);
  assert.match(deploy, /opensphere\.io\/scope:\s*main-shell-core/);
  assert.equal(fs.existsSync(path.join(root, 'backend', 'cli-download', 'clidownload-os.yaml')), false);
});

test('Registry is a Console core projection and Kanidm trust uses the installation CA', () => {
  const nginx = read('nginx', 'default.conf.template');
  const controller = read('backend', 'dupa-control', 'controller.js');
  const controllerDeploy = read('backend', 'dupa-control', 'opensphere-console-dupa-controller.yaml');
  const backendDeploy = read('backend', 'opensphere-console-backend', 'deploy.yaml');

  assert.match(controller, /p === '\/api\/v1\/registry'/);
  assert.match(controller, /publishedPlugins = published\.map\(\(plugin\) => \(\{ \.\.\.plugin, available: true \}\)\)/);
  assert.match(nginx, /opensphere-console-dupa-controller\.opensphere-console\.svc\.cluster\.local/);
  assert.doesNotMatch(nginx, /opensphere-registry\.opensphere-console\.svc/);
  for (const deploy of [controllerDeploy, backendDeploy]) {
    assert.match(deploy, /KANIDM_CA_PATH/);
    assert.match(deploy, /secretName:\s*opensphere-console-auth-ca/);
    assert.match(deploy, /mountPath:\s*\/etc\/kanidm-ca/);
  }
});

test('a server-rejected browser token forces reauthentication even before local expiry', () => {
  const http = read('src', 'app', 'core', 'http.service.ts');
  const auth = read('src', 'app', 'core', 'auth.service.ts');

  assert.match(http, /response\.status === 401 && token/);
  assert.doesNotMatch(http, /response\.status === 401 && !this\.auth\.hasValidToken\(\)/);
  assert.match(auth, /async reAuthenticate\(\)[\s\S]*await this\.mgr\.removeUser\(\);[\s\S]*this\.clearAppliedUser\(\);[\s\S]*await this\.redirectToLogin\(\);/);
});

// F-3: native 서비스 id(os-cli)는 어떤 Binding 이름을 써도 /api/plugins 프록시 allowlist에 진입 못 한다.
test('os-cli native service id is a reserved proxy id and hard-denied in proxy-authz', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  assert.match(controller, /RESERVED_PROXY_SERVICE_IDS = new Set\(\['os-cli'\]\)/);
  // allowlist 조립 시 예약 id는 published/binding 양쪽에서 제외된다.
  assert.match(controller, /published\.map\(\(p\) => p\.id\)\.filter\(\(id\) => !RESERVED_PROXY_SERVICE_IDS\.has\(id\)\)/);
  assert.match(controller, /RESERVED_PROXY_SERVICE_IDS\.has\(mm\[1\]\)/);
  // proxy-authz는 allowlist 상태와 무관하게 예약 id를 항상 403 처리(이중 방어).
  assert.match(controller, /proxyAllow\.has\(id\) && !RESERVED_PROXY_SERVICE_IDS\.has\(id\)/);
});

// F-6: os-cli Deployment 하드닝 — seccomp/고정 UID/SA 토큰 미마운트/PDB.
test('os-cli deployment applies seccomp, fixed uid, no SA token, and a PDB', () => {
  const deploy = read('backend', 'os-cli', 'deploy.yaml');
  assert.match(deploy, /automountServiceAccountToken:\s*false/);
  assert.match(deploy, /seccompProfile:\s*\{\s*type:\s*RuntimeDefault\s*\}/);
  assert.match(deploy, /runAsUser:\s*101/);
  assert.match(deploy, /topologySpreadConstraints/);
  assert.match(deploy, /kind:\s*PodDisruptionBudget/);
  assert.match(deploy, /minAvailable:\s*1/);
});

// F-2: CLI login은 argv 노출 없는 --pat-stdin 입력을 제공하고 --pat는 deprecated 경고를 낸다.
test('os CLI login supports --pat-stdin and deprecates argv --pat', () => {
  const main = read('backend', 'os-cli', 'cmd', 'os', 'main.go');
  assert.match(main, /--pat-stdin/);
  assert.match(main, /patStdin := fs\.Bool\("pat-stdin"/);
  assert.match(main, /io\.ReadAll\(io\.LimitReader\(in,/);
  assert.match(main, /프로세스 목록·셸 히스토리에 노출/);
});
