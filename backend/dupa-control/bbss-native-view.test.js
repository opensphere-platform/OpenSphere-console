'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('BBSS is a first-level hierarchy with overview and three product evidence routes', () => {
  const routes = read('src', 'app', 'app.routes.ts');
  const layout = read('src', 'app', 'pages', 'admin-layout.ts');
  const page = read('src', 'app', 'pages', 'admin-bbss.ts');
  const product = read('src', 'app', 'pages', 'admin-bbss-service.ts');
  const overview = read('src', 'app', 'pages', 'admin-overview.ts');
  const styles = read('src', 'styles.scss');
  const packageJson = JSON.parse(read('package.json'));

  assert.doesNotMatch(routes, /import \{ AdminBbss \}/);
  assert.match(
    routes,
    /path: 'bbss',[\s\S]*?loadComponent: \(\) => import\('\.\/pages\/admin-bbss'\)\.then\(\(module\) => module\.AdminBbss\)/,
  );
  for (const id of ['supabase', 'gitea', 'beszel']) {
    assert.match(
      routes,
      new RegExp(`path: 'bbss/${id}'[\\s\\S]*?data: \\{ bbssService: '${id}' \\}`),
    );
    assert.match(layout, new RegExp(`route: '/manage/bbss/${id}'`));
  }
  assert.equal(
    (routes.match(/loadComponent: \(\) => import\('\.\/pages\/admin-bbss-service'\)/g) || [])
      .length,
    3,
  );
  assert.match(layout, /id: 'bbss'/);
  assert.match(layout, /label: 'Backbone Service Stack'/);
  assert.match(layout, /\{ label: '개요', route: '\/manage\/bbss' \}/);
  assert.match(page, /\/api\/admin\/bbss\/status/);
  assert.match(page, /BBSS · Live availability/);
  assert.match(page, /productRoute\(service\.id\)/);
  assert.match(page, /현재 가용성/);
  assert.match(page, /운영 복원력/);
  assert.match(page, /업무 시계열/);
  assert.match(page, /공통 의존성과 장애 도메인/);
  assert.match(page, /Kubernetes에서 직접 읽은 현재 replica와 restart/);
  assert.match(product, /\/api\/admin\/bbss\/status/);
  assert.match(product, /\/api\/identity\/supabase\/status/);
  assert.match(product, /\/api\/platform\/gitea\/status/);
  assert.match(product, /\/api\/plugins\/linux-host-manager\/control-centers\//);
  assert.match(product, /'1h' \| '12h' \| '24h' \| '1w' \| '30d'/);
  assert.match(product, /LineChartComponent/);
  assert.match(product, /<ibm-line-chart/);
  assert.match(product, /ScaleTypes\.TIME/);
  assert.match(product, /ChartTheme\.WHITE/);
  assert.match(product, /IBM Carbon Charts 기반 Beszel 시계열/);
  assert.match(product, /공통 호스트 영향 지표/);
  assert.match(product, /제품 자체의 현재 가용성은 상단 Runtime·owner API 근거로 판정합니다/);
  assert.match(product, /gap은 선을 이어 왜곡하지 않습니다/);
  assert.match(product, /value: null/);
  assert.doesNotMatch(product, /<svg viewBox="0 0 600 120"/);
  assert.equal(packageJson.dependencies['@carbon/charts'], '1.27.17');
  assert.equal(packageJson.dependencies['@carbon/charts-angular'], '1.27.17');
  assert.match(styles, /@import '@carbon\/charts\/styles\.css'/);
  for (const logo of ['supabase-2.svg', 'gitea.svg', 'beszel-light.svg']) {
    assert.match(product, new RegExp(logo.replace('.', '\\.')));
    assert.match(page, new RegExp(logo.replace('.', '\\.')));
  }
  assert.match(page, /service-card-header/);
  assert.match(page, /\.service-logo\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent/);
  assert.match(product, /\.product-logo-shell\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent/);
  assert.match(product, /class="panel-header"/);
  assert.match(product, /class="chart-header"/);
  assert.doesNotMatch(page, /<header(?:\s|>)/);
  assert.doesNotMatch(product, /<header(?:\s|>)/);
  assert.match(product, /Runtime 구성요소/);
  assert.match(product, /Persistent storage/);
  assert.match(product, /Consumer integrations/);
  assert.match(product, /Repository inventory/);
  assert.match(product, /호스트 시계열/);
  assert.match(product, /실제 파일시스템 사용량과 다릅니다/);
  assert.match(overview, /BBSS 실시간 요약/);
  assert.match(overview, /BBSS 가용성 열기/);
  assert.match(routes, /loadComponent: \(\) => import\('\.\/pages\/admin-overview'\)/);
});

test('management overview is a live host-authority and Beszel view with Carbon charts', () => {
  const routes = read('src', 'app', 'app.routes.ts');
  const overview = read('src', 'app', 'pages', 'admin-overview.ts');
  const server = read('backend', 'opensphere-console-backend', 'server.js');
  const projection = read('backend', 'opensphere-console-backend', 'admin-overview-status.js');
  const dockerfile = read('backend', 'opensphere-console-backend', 'Dockerfile');

  assert.match(routes, /loadComponent: \(\) => import\('\.\/pages\/admin-overview'\)/);
  assert.match(overview, /\/api\/admin\/overview/);
  assert.match(overview, /Host authority · Live/);
  assert.match(overview, /DonutChartComponent/);
  assert.match(overview, /LineChartComponent/);
  assert.match(overview, /<ibm-donut-chart/);
  assert.match(overview, /<ibm-line-chart/);
  assert.match(overview, /RCC가 실제로 수신한 호스트 상태와 Beszel 24시간 시계열/);
  assert.match(overview, /미수집 값은 0이 아니라 — 로 표시/);
  assert.doesNotMatch(overview, /더미 데이터|SAMPLE|cc2-worker-03|cc2-edge-01/);
  assert.doesNotMatch(overview, /points="50,122/);

  assert.match(server, /p === '\/api\/admin\/overview'/);
  assert.match(server, /await verifyConsoleAdmin\(req\)/);
  assert.match(server, /range: '24h'/);
  assert.match(server, /buildAdminOverview/);
  assert.match(projection, /schemaVersion: SCHEMA_VERSION/);
  assert.match(projection, /rcc\.admin\.overview\/v1/);
  assert.match(projection, /toHostSummary/);
  assert.match(projection, /Beszel readonly API/);
  assert.match(projection, /const cpuPercent = boundedPercent\(latest\?\.cpuPercent\)/);
  assert.match(
    projection,
    /missing or stale evidence is surfaced as attention, never as a measured 0/,
  );
  assert.doesNotMatch(projection, /password|service-role-key|private.?key/i);
  assert.match(dockerfile, /COPY opensphere-console-backend\/admin-overview-status\.js/);
});

test('BBSS charts keep Beszel host evidence separate from product availability', () => {
  const product = read('src', 'app', 'pages', 'admin-bbss-service.ts');
  const agentUnit = read('deploy', 'his', 'beszel', 'agent', 'beszel-agent.service');
  const agentEnvironment = read('deploy', 'his', 'beszel', 'agent', 'agent.env.example');

  assert.match(
    product,
    /this\.status\(\)\?\.services\.find\(\(service\) => service\.id === 'beszel'\)/,
  );
  assert.match(product, /reads: Promise<void>\[\] = \[this\.refreshBeszel\(\)\]/);
  assert.match(product, /productId !== 'beszel'/);
  assert.match(agentUnit, /no runtime socket/);
  assert.match(agentUnit, /CapabilityBoundingSet=\s*$/m);
  assert.match(agentEnvironment, /BESZEL_AGENT_DOCKER_HOST=\s*$/m);
  assert.doesNotMatch(agentUnit, /docker\.sock|containerd\.sock/);
});

test('BBSS backend is admin-gated, bounded and preserves owner boundaries', () => {
  const server = read('backend', 'opensphere-console-backend', 'server.js');
  const projection = read('backend', 'opensphere-console-backend', 'bbss-status.js');

  assert.match(server, /p === '\/api\/admin\/bbss\/status'/);
  assert.match(server, /await verifyConsoleAdmin\(req\)/);
  assert.match(server, /captureBbssEvidence\('Supabase owner API', supabaseStatus\)/);
  assert.match(server, /captureBbssEvidence\('Gitea owner API', bbssGiteaStatus\)/);
  assert.match(server, /captureBbssEvidence\('Governed change projection', giteaStatus\)/);
  assert.match(server, /must not turn a reachable Gitea API into a false outage/);
  assert.match(server, /receipts:\s*null/);
  assert.match(server, /byStatus:\s*null/);
  assert.match(server, /captureBbssEvidence\('Beszel readonly API', bbssBeszelStatus\)/);
  assert.match(server, /beszelMetricsSource\.client\.fetchMetrics/);
  assert.match(server, /range: '1h'/);
  assert.match(server, /slice\(0, 20\)/);
  assert.match(projection, /schemaVersion: 'rcc\.bbss\.status\/v1'/);
  assert.match(projection, /actualUsedBytes: null/);
  assert.match(projection, /Application throughput history is NotConfigured/);
  assert.match(projection, /Beszel stores host metrics only/);
  assert.doesNotMatch(projection, /password|service-role-key|private.?key/i);
});

test('BBSS availability distinguishes runtime, resilience, telemetry and recovery', () => {
  const projection = read('backend', 'opensphere-console-backend', 'bbss-status.js');
  assert.match(projection, /runtimeAvailability: runtimeState/);
  assert.match(projection, /resilience: resilienceState/);
  assert.match(projection, /applicationTelemetry: telemetryState/);
  assert.match(projection, /Node failure domain/);
  assert.match(projection, /node-local storage/);
  assert.match(projection, /Disruption protection/);
  assert.match(projection, /Backup and restore evidence/);
  assert.match(projection, /Prometheus-compatible HIS source is not configured/);
  assert.match(projection, /At least one mandatory BBSS service is unavailable/);
});

test('CC2 runtime packages the projector and declares only the three BBSS namespaces', () => {
  const dockerfile = read('backend', 'opensphere-console-backend', 'Dockerfile');
  const deployment = read('deploy', 'rcc', 'rcc.yaml');
  assert.match(dockerfile, /COPY opensphere-console-backend\/bbss-status\.js/);
  assert.match(deployment, /BBSS_SUPABASE_NAMESPACE, value: polyon-rcc-data/);
  assert.match(deployment, /BBSS_GITEA_NAMESPACE, value: polyon-rcc-change/);
  assert.match(deployment, /BBSS_BESZEL_NAMESPACE, value: beszel-system/);
  assert.doesNotMatch(deployment, /BBSS_.*(?:PASSWORD|TOKEN|KEY)/);
});
