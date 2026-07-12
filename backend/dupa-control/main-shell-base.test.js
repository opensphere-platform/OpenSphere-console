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
  const components = controller.slice(controller.indexOf('const BB_COMPONENTS'), controller.indexOf('const BB_ACCESS'));
  const workloads = controller.slice(controller.indexOf('function bbWorkloads'), controller.indexOf('async function backboneStatus'));

  for (const pillar of ['backbone-postgres', 'backbone-rustfs', 'backbone-gitea']) {
    assert.match(components, new RegExp(pillar));
    assert.match(workloads, new RegExp(pillar));
  }
  assert.doesNotMatch(components, /oaa|manual/i);
  assert.doesNotMatch(workloads, /oaa-gateway|OAA_GATEWAY_IMAGE/);
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
  for (const route of ['/manage/catalog', '/manage/apis', '/manage/plugins']) assert.match(layout, new RegExp(route));
  assert.match(shell, /private static readonly NATIVE: NavBand\[\] = \[\]/);
  assert.doesNotMatch(search, /path:\s*'\/(?:catalog|apis|admin\/plugins|admin\/roles|console-admins)'/);
});

test('notification detail uses the shared right sliding panel', () => {
  const notifications = read('src', 'app', 'pages', 'admin-notifications.ts');

  assert.match(notifications, /imports:\s*\[[^\]]*OsPanel/);
  assert.match(notifications, /<os-panel[\s\S]*\[open\]="!!selected\(\)"/);
  assert.match(notifications, /\(click\)="open\(n\)"/);
  assert.match(notifications, /관련 화면으로 이동/);
  assert.doesNotMatch(notifications, /clr-dg-row-detail|clrIfExpanded/);
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

  assert.match(routes, /path:\s*'cli',\s*component:\s*AdminCli/);
  assert.match(layout, /route:\s*'\/manage\/cli'/);
  assert.match(page, /<clr-datagrid>/);
  assert.match(page, /<clr-alert/);
  assert.match(nginx, /location \/api\/cli\//);
  assert.doesNotMatch(nginx, /location .*\/api\/plugins\/os-cli/);
  assert.match(controller, /NATIVE_BINDING_NAMES = new Set\(\['os'\]\)/);
  assert.equal(manifest.ownership, 'console-native');
  assert.equal(manifest.profile, 'admin');
  assert.equal(manifest.extensionBoundary.adminTokenReuse, false);
  assert.ok(manifest.links.every((link) => link.href.startsWith('/api/cli/')));
  assert.ok(manifest.links.every((link) => /^[a-f0-9]{64}$/.test(link.sha256) && link.size > 0));
  assert.match(deploy, /opensphere\.io\/scope:\s*main-shell-core/);
  assert.equal(fs.existsSync(path.join(root, 'backend', 'cli-download', 'clidownload-os.yaml')), false);
});
