const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('Console management exposes Supabase, Gitea and HISS as distinct authorities', () => {
  const routes = read('src', 'app', 'app.routes.ts');
  const layout = read('src', 'app', 'pages', 'admin-layout.ts');
  assert.match(routes, /path: 'platform-control'/);
  assert.match(routes, /path: 'data-identity'/);
  assert.match(routes, /path: 'state-changes'/);
  assert.match(routes, /path: 'change-control', redirectTo: 'state-changes'/);
  assert.match(routes, /path: 'observability'/);
  assert.match(routes, /path: 'backbone', redirectTo: 'data-identity'/);
  assert.match(layout, /플랫폼 제어/);
  assert.match(layout, /HISS Observability/);
  assert.match(layout, /route: '\/manage\/state-changes'/);
  assert.doesNotMatch(layout, /route: '\/manage\/change-control'/);
  assert.doesNotMatch(layout, /routerLink="\/manage\/backbone"/);
});

test('Console management uses Clarity mixed tree navigation with direct overview, Extensions and R2D2 links', () => {
  const routes = read('src', 'app', 'app.routes.ts');
  const layout = read('src', 'app', 'pages', 'admin-layout.ts');
  const overview = read('src', 'app', 'pages', 'admin-overview.ts');
  assert.match(routes, /path: '', component: AdminOverview, pathMatch: 'full'/);
  assert.doesNotMatch(routes, /path: '', redirectTo: 'catalog'/);
  assert.match(layout, /routerLink="\/manage"/);
  assert.match(layout, /clr-vertical-nav-group/);
  assert.match(layout, /clr-vertical-nav-group-children/);
  assert.match(
    layout,
    /extensionItem = \{[\s\S]{0,120}label: 'Extensions',[\s\S]{0,80}route: '\/manage\/extensions'/,
  );
  assert.match(
    layout,
    /r2d2Item = \{[\s\S]{0,120}label: 'R2D2',[\s\S]{0,80}route: '\/manage\/osaa'/,
  );
  const treeGroups = layout.slice(
    layout.indexOf('readonly groups:'),
    layout.indexOf('constructor()'),
  );
  assert.doesNotMatch(treeGroups, /route: '\/manage\/extensions'/);
  assert.doesNotMatch(treeGroups, /route: '\/manage\/osaa'/);
  assert.match(overview, /title="Console Service Dashboard" tag="CBSS · Service plane"/);
  assert.match(overview, /OpenSphere를 제어하기 위해 Console은 무엇을 서비스하는가/);
  assert.match(overview, /CBSS CORE SERVICES/);
  assert.match(overview, /OpenSphere Control Engine/);
  assert.match(overview, /OSAA Dialogue State Tracker/);
  assert.match(overview, /SubShell·Plugin 구성/);
  assert.match(overview, /Owner live evidence 연계 전/);
  assert.match(overview, /routerLink="\/manage\/foundation-services"/);
  assert.match(overview, /route: '\/manage\/extensions'/);
});

test('all Console management surfaces share task context, status and filtering conventions', () => {
  const styles = read('src', 'styles.scss');
  const catalog = read('src', 'app', 'pages', 'catalog.ts');
  const apis = read('src', 'app', 'pages', 'apis.ts');
  const admins = read('src', 'app', 'pages', 'console-admins.ts');
  const roles = read('src', 'app', 'pages', 'admin-roles.ts');
  const extensions = read('src', 'app', 'pages', 'admin-plugins.ts');
  const osaa = read('src', 'app', 'pages', 'admin-osaa.ts');
  const observability = read('src', 'app', 'pages', 'admin-observability.ts');
  const notifications = read('src', 'app', 'pages', 'admin-notifications.ts');
  const audit = read('src', 'app', 'pages', 'admin-audit.ts');
  assert.match(styles, /\.manage-status-rail/);
  assert.match(styles, /\.manage-toolbar/);
  for (const source of [catalog, apis, admins, roles, extensions, osaa, observability, notifications, audit]) {
    assert.match(source, /manage-status-rail/);
  }
  assert.match(catalog, /Catalog 검색/);
  assert.match(apis, /API 검색/);
  assert.match(notifications, /viewFilter/);
  assert.match(audit, /resultView/);
  assert.doesNotMatch(extensions, /routerLink="\/manage\/platform-readiness"/);
});

test('Console administrator actions keep failures visible in the action dialog', () => {
  const admins = read('src', 'app', 'pages', 'console-admins.ts');
  const actionDialog = read('src', 'app', 'os', 'os-action-dialog.ts');
  assert.match(admins, /\[error\]="actionError\(\)"/);
  assert.match(admins, /관리 작업 실패:/);
  assert.match(admins, /this\.reasonOpen\.set\(false\);[\s\S]{0,120}this\.pendingAction = null;[\s\S]{0,120}catch \(error\)/);
  assert.match(admins, /panelSubtitle\(\)/);
  assert.match(admins, /user\.email.*Supabase Auth · Console roles/);
  assert.match(actionDialog, /@Input\(\) error = ''/);
  assert.match(actionDialog, /clrAlertType.*danger/);
});

test('Platform Control presents support readiness, operations, evidence and journey as correlated task views', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  const routes = read('src', 'app', 'app.routes.ts');
  const control = read('src', 'app', 'pages', 'admin-platform-control.ts');
  const readiness = read('src', 'app', 'pages', 'admin-platform-readiness.ts');
  const dataIdentity = read('src', 'app', 'pages', 'admin-data-identity.ts');
  const changeControl = read('src', 'app', 'pages', 'admin-change-control.ts');
  assert.match(routes, /path: 'platform-readiness', component: AdminPlatformControl, data: \{ controlTab: 'readiness' \}/);
  assert.match(control, />Operations</);
  assert.match(control, />Support Profile</);
  assert.match(control, />Evidence</);
  assert.match(control, />변경 흐름</);
  assert.match(control, /os-admin-platform-readiness \[embedded\]="true"/);
  assert.match(control, /queryParamMap\.get\('tab'\)[\s\S]{0,160}controlTab/);
  assert.match(control, /requestedTab[\s\S]{0,280}'readiness'/);
  assert.match(readiness, /@Input\(\) embedded = false/);
  assert.match(readiness, /PlatformSupportProfile 사전 점검/);
  assert.match(control, /변경 요청 → 서명된 상태 선언 → Kubernetes 실측 결과/);
  assert.match(control, /HISS Preflight/);
  assert.match(control, /opensphere\.his\.readiness-projection\/v1/);
  assert.match(control, /PlatformReadinessService/);
  assert.match(control, /this\.readinessService\.status\(\)/);
  assert.match(control, /this\.readiness\(\)\?\.evidence\?\.\['his'\]/);
  assert.doesNotMatch(control, /item\.key === 'his-binding'/);
  assert.match(dataIdentity, /Recovery evidence/);
  assert.match(dataIdentity, /Insufficient evidence/);
  assert.match(changeControl, /플랫폼 상태 변경 관리/);
  assert.match(changeControl, /State Change Authority/);
  assert.match(changeControl, /변경 흐름/);
  assert.match(changeControl, /서명된 상태 선언/);
  assert.match(changeControl, /소비자 적용기/);
  assert.doesNotMatch(changeControl, /title="Change Control"/);
  assert.match(controller, /route: pfs\.shellReady \? '\/pfss\/foundation'/);
  assert.doesNotMatch(controller, /route: pfs\.shellReady \? '\/p\/foundation'/);
});

test('DUPA active runtime depends on Supabase audit and never ships legacy data modules', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  const dockerfile = read('backend', 'dupa-control', 'Dockerfile');
  const deployment = read('backend', 'dupa-control', 'opensphere-console-dupa-controller.yaml');
  assert.match(controller, /Supabase audit\.event is the durable authority/);
  assert.match(controller, /function supabaseRequest/);
  assert.match(controller, /rpc\/revoke_image/);
  assert.match(controller, /p\.startsWith\('\/api\/admin\/backbone\/'\)[\s\S]{0,180}RetiredControlSurface/);
  assert.doesNotMatch(controller, /const db = require\('\.\/db'\)/);
  assert.doesNotMatch(controller, /const storage = require\('\.\/storage'\)/);
  assert.doesNotMatch(dockerfile, /COPY db\.js|COPY storage\.js|COPY kanidm-ca\.crt/);
  assert.match(deployment, /SUPABASE_REST_URL/);
  assert.doesNotMatch(deployment, /BACKBONE_PG_|BACKBONE_S3_/);
});

test('OSAA runs in the Console namespace and HISS remains the telemetry owner', () => {
  const gateway = read('backend', 'opensphere-console-osaa-gateway', 'server.js');
  const nginx = read('nginx', 'default.conf.template');
  const plan = read('docs', 'PLAN-CONSOLE-PLATFORM-CONTROL-PLANE-V2-2026-07-22.md');
  assert.match(gateway, /const OSAA_NAMESPACE = process\.env\.OSAA_NAMESPACE \|\| 'opensphere-console'/);
  assert.doesNotMatch(gateway, /BACKBONE_NS/);
  assert.match(nginx, /opensphere-console-osaa-gateway\.opensphere-console\.svc\.cluster\.local/);
  assert.match(plan, /Binding이 없어도 bootstrap·진단·연결 복구 화면은 동작/);
  assert.match(plan, /Console은 Prometheus\/Operator\/CRD\/retention\/scrape\/Alertmanager를 설치·구성·운영하지 않는다/);
});

test('Supabase revocation ledger is append-only and correlated with audit evidence', () => {
  const migration = read('backend', 'supabase', 'migrations', '0007_extension_revocation.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS console\.image_revocation/);
  assert.match(migration, /CREATE TRIGGER image_revocation_append_only/);
  assert.match(migration, /ALTER TABLE console\.image_revocation ENABLE ALWAYS TRIGGER/);
  assert.match(migration, /FUNCTION console\.revoke_image/);
  assert.match(migration, /INSERT INTO audit\.event/);
});

test('recovery readiness consumes current Supabase and Gitea evidence, never a legacy data stack', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  const recovery = read('backend', 'recovery', 'opensphere-platform-recovery-evidence.yaml');
  const start = controller.indexOf('async function backupRestoreEvidence()');
  const end = controller.indexOf('async function securityPolicyEvidence()');
  const evidence = controller.slice(start, end);
  assert.match(evidence, /opensphere-platform-recovery-evidence/);
  assert.match(evidence, /Supabase\+Gitea recovery evidence/);
  assert.doesNotMatch(evidence, /BACKBONE_NS|backbone-postgres|opensphere-backbone|opensphere-cbs/);
  assert.match(recovery, /"supabase"/);
  assert.match(recovery, /"gitea"/);
  assert.match(recovery, /"state": "AttentionRequired"/);
  assert.match(recovery, /"verified": false/);
  assert.match(recovery, /Do not replace it with made-up checksum/);
  assert.match(recovery, /"approved": false/);
});

test('recovery API cannot let a declared state overrule failed structured checks', () => {
  const recoveryUnit = read('backend', 'opensphere-console-backend', 'recovery-owner.js');
  assert.match(recoveryUnit, /checks\.some\(\(item\) => item\.verdict !== 'Verified'\)/);
  assert.match(recoveryUnit, /state: attention \? 'AttentionRequired'/);
  assert.match(recoveryUnit, /declaredState/);
  assert.match(recoveryUnit, /evidenceQuality/);
  assert.match(recoveryUnit, /recovery_drill_executor_unavailable/);
  assert.doesNotMatch(recoveryUnit, /locationRef:/);
});
