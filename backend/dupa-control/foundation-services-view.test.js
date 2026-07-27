'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('Console foundation services keep role-oriented scope and CC compatibility routing', () => {
  const routes = read('src', 'app', 'app.routes.ts');
  const layout = read('src', 'app', 'pages', 'admin-layout.ts');
  const page = read('src', 'app', 'pages', 'admin-foundation-services.ts');

  assert.match(routes, /path: 'foundation-services',[\s\S]*?loadComponent:[\s\S]*?AdminFoundationServices/);
  assert.match(routes, /path: 'bbss', redirectTo: 'foundation-services'/);
  assert.match(layout, /id: 'foundation'/);
  assert.match(layout, /label: 'Console 기반 서비스'/);
  assert.match(layout, /\{ label: '개요', route: '\/manage\/foundation-services' \}/);
  assert.match(layout, /\{ label: 'Data & Identity', route: '\/manage\/data-identity' \}/);
  assert.match(layout, /\{ label: '선언형 상태 변경', route: '\/manage\/state-changes' \}/);
  assert.match(layout, /\{ label: 'Infrastructure Monitoring', route: '\/manage\/infrastructure-monitoring' \}/);

  assert.match(page, /title="Console 기반 서비스"/);
  assert.match(page, /현재 가용성과 장기 운영 준비도를 분리/);
  assert.match(page, /수집되지 않은 값은 0이 아닌 미구성/);
  assert.match(page, /공통 운영 Gate/);
  assert.match(page, /데이터 출처 계약/);
  assert.match(page, /제품 이름보다 서비스 역할을 우선/);
  assert.match(page, /route: '\/manage\/data-identity'/);
  assert.match(page, /route: '\/manage\/state-changes'/);
  assert.match(page, /route: '\/manage\/infrastructure-monitoring'/);
});

test('Beszel detail uses Carbon Charts and preserves gaps as missing values', () => {
  const page = read('src', 'app', 'pages', 'admin-infrastructure-monitoring.ts');
  const adapter = read('backend', 'opensphere-console-backend', 'baseline-monitoring.js');
  const styles = read('src', 'styles.scss');
  const packageJson = JSON.parse(read('package.json'));

  assert.match(page, /LineChartComponent/);
  assert.match(page, /<ibm-line-chart/);
  assert.match(page, /ScaleTypes\.TIME/);
  assert.match(page, /ChartTheme\.WHITE/);
  assert.match(page, /IBM Carbon Charts/);
  assert.match(page, /Network throughput/);
  assert.match(page, /Disk I\/O/);
  assert.match(page, /value: value === null \|\| !Number\.isFinite\(value\) \? null : value/);
  assert.doesNotMatch(page, /MetricLineChart/);
  assert.match(adapter, /diskReadBytesPerSecond/);
  assert.match(adapter, /networkSentBytesPerSecond/);
  assert.equal(packageJson.dependencies['@carbon/charts'], '1.27.17');
  assert.equal(packageJson.dependencies['@carbon/charts-angular'], '1.27.17');
  assert.match(styles, /@import '@carbon\/charts\/styles\.css'/);
});
