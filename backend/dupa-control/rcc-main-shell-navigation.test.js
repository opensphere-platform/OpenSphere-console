'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..', '..');

function read(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');
}

async function navigationContract() {
  const url = pathToFileURL(path.join(repoRoot, 'src/app/core/perspectives.ts')).href;
  return import(`${url}?navigation-contract=${Date.now()}`);
}

test('Linux Host Manager menu keeps the selected control-center context', async () => {
  const { controlCenterIdFromUrl, navigationForPlugin, routeForPlugin } =
    await navigationContract();

  assert.equal(controlCenterIdFromUrl('/cc/cc2/kubernetes/pods?namespace=default'), 'cc2');
  assert.equal(controlCenterIdFromUrl('/cc/region-7/hosts#updates'), 'region-7');
  assert.equal(controlCenterIdFromUrl('/p/linux-host-manager'), null);
  assert.equal(controlCenterIdFromUrl('/cc/CC2/hosts'), null);

  assert.equal(routeForPlugin('linux-host-manager', 'region-7'), '/cc/region-7/hosts');
  assert.equal(routeForPlugin('linux-host-manager', '../unsafe'), '/cc/cc2/hosts');
  assert.equal(routeForPlugin('ordinary-plugin', 'region-7'), '/p/ordinary-plugin');

  assert.deepEqual(
    navigationForPlugin(
      { id: 'linux-host-manager', title: 'Linux hosts', navBand: 'infrastructure' },
      'region-7',
    ),
    {
      pluginId: 'linux-host-manager',
      path: '/cc/region-7/hosts',
      label: 'Linux 호스트',
      band: '운영',
    },
  );
});

test('Main Shell, search, home, and Extension status use one regional navigation contract', () => {
  const shell = read('src/app/os/os-shell.ts');
  const search = read('src/app/core/search.service.ts');
  const landing = read('src/app/pages/landing.ts');
  const overview = read('src/app/pages/rcc-overview.ts');
  const extensions = read('src/app/pages/admin-plugins.ts');
  const routes = read('src/app/app.routes.ts');
  const entry = read('deploy/rcc/subshells/linux-host-manager/entry.js');

  assert.match(shell, /navigationForPlugin\(p, controlCenterId\)/);
  assert.match(shell, /`\/cc\/\$\{controlCenterId\}\/kubernetes`/);
  assert.match(shell, /private controlCenter = inject\(ControlCenterContextService\)/);
  assert.doesNotMatch(shell, /os-plugin-badge/);

  assert.match(search, /navigationForPlugin\(p, this\.controlCenter\.id\(\)\)/);
  assert.match(landing, /navigationForPlugin\(p, this\.controlCenter\.id\(\)\)/);
  assert.match(overview, /routerLink="\/cc\/cc2\/hosts"/);
  assert.match(extensions, /this\.controlCenter\.pluginRoute\(r\.name\)/);

  assert.match(routes, /data: \{ pluginId: 'linux-host-manager' \}/);
  assert.match(entry, /title: 'Linux 호스트'/);
  assert.match(entry, /navBand: '운영'/);
});

test('operator-facing navigation labels use one language and hide implementation badges', () => {
  const shell = read('src/app/os/os-shell.ts');
  const admin = read('src/app/pages/admin-layout.ts');
  const kubernetes = read('src/app/features/kubernetes/kubernetes-console-page.ts');
  const kubernetesNav = read('src/app/features/kubernetes/nav.ts');

  for (const label of ["'운영'", "'구축'", "'전달'", "'지능'"]) {
    assert.ok(shell.includes(label), `${label} canonical band is required`);
  }
  for (const label of ['개발 도구', '콘솔 및 접근', '플랫폼 제어', '운영 및 증거']) {
    assert.ok(admin.includes(label), `${label} admin group is required`);
  }
  assert.match(kubernetes, />\s*개요\s*</);
  assert.match(kubernetes, />읽기 전용</);
  for (const label of ['워크로드', '네트워크', '구성 및 스토리지', '클러스터', '접근 제어']) {
    assert.ok(kubernetesNav.includes(`group: '${label}'`), `${label} Kubernetes group is required`);
  }
});

test('manage navigation uses the native Clarity hierarchy contract', () => {
  const admin = read('src/app/pages/admin-layout.ts');
  const overview = read('src/app/pages/admin-overview.ts');
  const bbss = read('src/app/pages/admin-bbss.ts');
  const routes = read('src/app/app.routes.ts');

  assert.match(admin, /<clr-vertical-nav-group\b/);
  assert.match(admin, /<clr-vertical-nav-group-children>/);
  assert.match(admin, /\[clrVerticalNavGroupExpanded\]="isGroupExpanded\(group\.id\)"/);
  assert.match(
    admin,
    /\(clrVerticalNavGroupExpandedChange\)="setGroupExpanded\(group\.id, \$event\)"/,
  );
  assert.match(admin, /<os-cicon clrVerticalNavIcon \[icon\]="group\.icon"/);
  assert.match(admin, /routerLinkActive="active"/);
  assert.match(admin, /ariaCurrentWhenActive="page"/);
  assert.match(admin, /paths: 'exact'/);
  assert.match(admin, /queryParams: 'ignored'/);
  assert.match(admin, /fragment: 'ignored'/);
  assert.match(admin, /expandGroupForUrl\(event\.urlAfterRedirects\)/);
  assert.doesNotMatch(admin, /cm-tree-(?:group|label|item)/);

  assert.match(
    routes,
    /path: ''[\s\S]*?loadComponent: \(\) => import\('\.\/pages\/admin-overview'\)\.then\(\(module\) => module\.AdminOverview\)/,
  );
  assert.doesNotMatch(routes, /import \{ AdminOverview \} from '\.\/pages\/admin-overview'/);
  assert.doesNotMatch(routes, /import \{ AdminBbss \} from '\.\/pages\/admin-bbss'/);
  assert.match(
    routes,
    /path: 'bbss',[\s\S]*?loadComponent: \(\) => import\('\.\/pages\/admin-bbss'\)\.then\(\(module\) => module\.AdminBbss\)/,
  );
  for (const id of ['supabase', 'gitea', 'beszel']) {
    assert.match(
      routes,
      new RegExp(`path: 'bbss/${id}'[\\s\\S]*?data: \\{ bbssService: '${id}' \\}`),
    );
  }
  assert.equal(
    (routes.match(/loadComponent: \(\) => import\('\.\/pages\/admin-bbss-service'\)/g) || [])
      .length,
    3,
  );
  assert.doesNotMatch(routes, /\{ path: '', redirectTo: 'catalog'/);
  assert.match(admin, /\{ label: '개요', route: '\/manage', icon: Dashboard16 \}/);
  assert.match(admin, /id: 'bbss'/);
  assert.match(admin, /label: 'Backbone Service Stack'/);
  assert.match(admin, /\{ label: '개요', route: '\/manage\/bbss' \}/);
  assert.match(admin, /\{ label: 'Supabase', route: '\/manage\/bbss\/supabase' \}/);
  assert.match(admin, /\{ label: 'Gitea', route: '\/manage\/bbss\/gitea' \}/);
  assert.match(admin, /\{ label: 'Beszel', route: '\/manage\/bbss\/beszel' \}/);
  assert.match(
    admin,
    /\{[\s\S]*?label: 'Console Extensions',[\s\S]*?route: '\/manage\/extensions',[\s\S]*?icon: Application16,[\s\S]*?feature: 'extensions',[\s\S]*?\}/,
  );
  assert.equal((admin.match(/route: '\/manage\/extensions'/g) || []).length, 1);
  assert.equal((admin.match(/route: '\/manage\/bbss'/g) || []).length, 1);
  assert.match(overview, /title="개요" tag="Host authority · Live"/);
  assert.match(overview, /routerLink="\/manage\/bbss"/);
  assert.doesNotMatch(overview, /더미 데이터|Node status · Preview/);
  assert.match(overview, /aria-label="실제 노드 상태 차트"/);
  assert.match(overview, /<ibm-donut-chart/);
  assert.match(overview, /<ibm-line-chart/);
  assert.match(overview, /\/api\/admin\/overview/);
  assert.match(bbss, /title="Backbone Service Stack" tag="BBSS · Live availability"/);
  assert.match(bbss, /\/api\/admin\/bbss\/status/);
  assert.match(routes, /\{ path: '\*\*', redirectTo: '', pathMatch: 'full' \}/);
  assert.match(admin, /@media \(max-width: 56rem\)/);
  assert.match(admin, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(admin, /max-height: 42vh/);

  const lazyComponents = [
    ['catalog', 'catalog', 'Catalog'],
    ['apis', 'apis', 'Apis'],
    ['cli', 'admin-cli', 'AdminCli'],
    ['console-admins', 'console-admins', 'ConsoleAdmins'],
    ['extensions', 'admin-plugins', 'AdminPlugins'],
    ['roles', 'admin-roles', 'AdminRoles'],
    ['platform-control', 'admin-platform-control', 'AdminPlatformControl'],
    ['data-identity', 'admin-data-identity', 'AdminDataIdentity'],
    ['change-control', 'admin-change-control', 'AdminChangeControl'],
    ['oaa', 'admin-oaa', 'AdminOaa'],
    ['observability', 'admin-observability', 'AdminObservability'],
    ['notifications', 'admin-notifications', 'AdminNotifications'],
    ['external-channels', 'admin-external-channels', 'AdminExternalChannels'],
    ['audit', 'admin-audit', 'AdminAudit'],
  ];
  for (const [route, file, component] of lazyComponents) {
    assert.match(
      routes,
      new RegExp(
        String.raw`path: '${route}',[\s\S]*?loadComponent: \(\) => import\('\./pages/${file}'\)\.then\(\(module\) => module\.${component}\)`,
      ),
      `${route} must be isolated in a lazy route`,
    );
  }

  const groupIds = [...admin.matchAll(/\bid: '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(groupIds, [
    'bbss',
    'developer-tools',
    'console-access',
    'platform-control',
    'operations-evidence',
  ]);

  for (const route of [
    '/manage/catalog',
    '/manage/bbss',
    '/manage/bbss/supabase',
    '/manage/bbss/gitea',
    '/manage/bbss/beszel',
    '/manage/apis',
    '/manage/cli',
    '/manage/console-admins',
    '/manage/roles',
    '/manage/extensions',
    '/manage/platform-control',
    '/manage/data-identity',
    '/manage/change-control',
    '/manage/oaa',
    '/manage/observability',
    '/manage/notifications',
    '/manage/external-channels',
    '/manage/audit',
  ]) {
    assert.ok(admin.includes(`route: '${route}'`), `${route} must remain reachable`);
  }

  const capability = read('src/app/core/manage-capability.service.ts');
  for (const [feature, endpoint] of [
    ['extensions', '/api/admin/plugins/catalog'],
    ['cli', '/api/cli/index.json'],
    ['oaa', '/api/oaa/health'],
    ['observability', '/api/admin/observability/status'],
  ]) {
    assert.ok(
      admin.includes(`feature: '${feature}'`),
      `${feature} must be runtime-gated in navigation`,
    );
    assert.ok(
      capability.includes(`feature: '${feature}', path: '${endpoint}'`),
      `${feature} must probe its real page contract`,
    );
  }
  assert.match(capability, /response\.status === 404[\s\S]*?phase: 'not-configured'/);
  assert.match(admin, /aria-disabled="true"/);
  assert.match(admin, /cm-capability-badge/);
});

test('management pages fail visibly, reject stale evidence, and avoid the Clarity header trap', () => {
  const consoleAdmins = read('src/app/pages/console-admins.ts');
  const roles = read('src/app/pages/admin-roles.ts');
  const audit = read('src/app/pages/admin-audit.ts');
  const externalChannels = read('src/app/pages/admin-external-channels.ts');
  const platformControl = read('src/app/pages/admin-platform-control.ts');
  const cli = read('src/app/pages/admin-cli.ts');
  const notifications = read('src/app/pages/admin-notifications.ts');
  const notificationService = read('src/app/core/notification.service.ts');
  const catalog = read('src/app/pages/catalog.ts');
  const apis = read('src/app/pages/apis.ts');
  const bbss = read('src/app/pages/admin-bbss.ts');
  const bbssService = read('src/app/pages/admin-bbss-service.ts');
  const overview = read('src/app/pages/admin-overview.ts');
  const extensions = read('src/app/pages/admin-plugins.ts');

  assert.match(
    consoleAdmins,
    /async confirmReason[\s\S]*?catch \(error\)[\s\S]*?변경을 완료하지 못했습니다/,
  );
  assert.match(consoleAdmins, /사용자 감사 이력을 불러오지 못했습니다/);
  assert.match(
    roles,
    /async refresh\(\): Promise<void> \{[\s\S]*?this\.busy\.set\(true\)[\s\S]*?finally \{[\s\S]*?this\.busy\.set\(false\)/,
  );
  assert.match(audit, /this\.error\.set\(''\)/);
  assert.match(audit, /this\.events\.set\(\[\]\)/);
  assert.match(externalChannels, /Promise\.allSettled/);
  assert.match(externalChannels, /notificationSummaryLoaded/);
  assert.match(externalChannels, /backupSummaryLoaded/);
  assert.match(platformControl, /this\.supabase\.set\(null\)/);
  assert.match(platformControl, /this\.gitea\.set\(null\)/);
  assert.match(cli, />다시 시도</);
  assert.match(cli, /readonly loading = signal\(false\)/);
  assert.match(notificationService, /readonly sourceHealth = signal/);
  assert.match(notificationService, /Supabase 감사 이벤트 원천 조회 실패/);
  assert.match(notifications, /현재 건수를 전체 알림 0건으로 해석하지 마세요/);
  assert.match(catalog, /this\.rows\.set\(\[\]\)[\s\S]*?this\.selected\.set\(null\)/);
  assert.match(apis, /this\.rows\.set\(\[\]\)[\s\S]*?this\.selected\.set\(null\)/);
  assert.match(bbss, /catch \(error\) \{[\s\S]*?this\.status\.set\(null\)/);
  assert.match(bbssService, /this\.metrics\.set\(null\)[\s\S]*?this\.charts\.set\(\[\]\)/);
  assert.match(overview, /this\.overview\.set\(null\)[\s\S]*?this\.availabilityData\.set\(\[\]\)/);
  assert.match(extensions, /Promise\.allSettled/);
  assert.match(extensions, /controlPlaneDown/);

  for (const file of [
    'admin-platform-control.ts',
    'admin-data-identity.ts',
    'admin-change-control.ts',
    'admin-bbss.ts',
    'admin-bbss-service.ts',
  ]) {
    assert.doesNotMatch(
      read(`src/app/pages/${file}`),
      /<header(?:\s|>)/,
      `${file} must not inherit Clarity's global semantic header styling`,
    );
  }
});
