import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

const authenticatedFamilies = (contract) => contract.families.filter(
  ({ sessionPolicy }) => !['public-read', 'public-static'].includes(sessionPolicy),
);

test('Console Web atomically routes every authenticated family to target authority', async () => {
  const [shell, routes, dockerfile, contractSource] = await Promise.all([
    read('apps/console-web/nginx/default.conf.template'),
    read('apps/console-web/nginx/target-api-routes.conf'),
    read('apps/console-web/Dockerfile'),
    read('packages/contracts/browser-api-cutover.json'),
  ]);
  const contract = JSON.parse(contractSource);
  const authenticated = authenticatedFamilies(contract);
  assert.equal(contract.status, 'target-migration', 'routing readiness must not claim global release readiness');
  assert.equal(contract.currentSessionAuthority, 'console_identity.browser_session');
  assert.equal(authenticated.length, 13);
  assert(authenticated.every(({ status }) => status === 'target-routed'));
  assert.match(shell, /include \/etc\/nginx\/target-api-routes[.]conf;/u);
  assert.match(dockerfile, /COPY apps\/console-web\/nginx\/target-api-routes[.]conf \/etc\/nginx\/target-api-routes[.]conf/u);
  assert.doesNotMatch(shell + routes, /opensphere-console-(?:backend|dupa-controller)/u);
  for (const target of [
    'opensphere-console-api.opensphere-console.svc.cluster.local',
    'opensphere-console-osaa-gateway.opensphere-console.svc.cluster.local',
    'opensphere-notification-dispatcher.opensphere-console.svc.cluster.local',
    'opensphere-external-channel-executor.opensphere-console.svc.cluster.local',
    'opensphere-shell-api.opensphere-console.svc.cluster.local',
    'opensphere-shell-gateway.opensphere-console.svc.cluster.local',
    'opensphere-extension-controller.opensphere-console.svc.cluster.local',
  ]) assert.match(routes, new RegExp(target.replaceAll('.', '[.]'), 'u'));
  for (const endpoint of [
    '/api/internal/os-shell-authn', '/api/internal/r2d2-proxy-authn',
    '/api/internal/notification-owner-authn', '/api/internal/external-channel-owner-authn',
    '/api/internal/plugin-proxy-authz', '/api/internal/extension-management-authn',
  ]) assert.match(routes, new RegExp(endpoint, 'u'));
  assert.equal((routes.match(/auth_request_set \$owner_authorization/g) || []).length, 12);
  assert.equal((routes.match(/proxy_set_header Authorization \$owner_authorization/g) || []).length, 12);
  assert.equal((routes.match(/proxy_set_header X-OS-Owner-Admission \$owner_admission/g) || []).length, 12);
  assert.equal((routes.match(/proxy_set_header X-OS-Owner-CSRF-Verified \$owner_csrf_verified/g) || []).length, 12);
  assert.equal((routes.match(/proxy_set_header Cookie "";/g) || []).length, 12);
  assert.equal((routes.match(/proxy_set_header X-OS-CSRF-Token "";/g) || []).length, 12);
  assert.equal((routes.match(/proxy_set_header Authorization "";/g) || []).length, 6);
  assert.equal((routes.match(/proxy_set_header Cookie \$http_cookie;/g) || []).length, 6);
  assert.equal((routes.match(/proxy_set_header X-OS-CSRF-Token \$http_x_os_csrf_token;/g) || []).length, 6);
  assert.match(routes, /location = \/api\/osaa\/incidents\/stream[\s\S]*proxy_buffering off;/u);
  assert.match(routes, /sessions\/[\s\S]*\/attach\$[\s\S]*proxy_set_header Upgrade \$http_upgrade;/u);
  assert.match(routes, /location @optional_owner_unavailable[\s\S]*default_type application\/json;[\s\S]*return 503/u);
  assert.match(routes, /location @owner_admission_unavailable[\s\S]*default_type application\/json;[\s\S]*return 503/u);
  assert.equal((routes.match(/error_page 500 = @owner_admission_unavailable/g) || []).length, 12);
  assert.equal((routes.match(/error_page 502 504 = @optional_owner_unavailable/g) || []).length, 12);
  assert.equal((routes.match(/proxy_intercept_errors on;/g) || []).length, 2);
  assert.equal((routes.match(/return 410/g) || []).length, 4);
});

test('Platform routing preserves target reads and classifies every missing legacy path', async () => {
  const [routes, handler, platformOperations, ledgerSource, bootstrapInstaller, bootstrapControl] = await Promise.all([
    read('apps/console-web/nginx/target-api-routes.conf'),
    read('apps/console-api/src/http-handler.mjs'),
    read('apps/console-api/src/platform-change-operations.mjs'),
    read('packages/contracts/legacy-api-disposition.json'),
    read('backend/gitea/bootstrap/install.ps1'),
    read('backend/gitea/bootstrap/control-plane-bootstrap.ps1'),
  ]);
  const ledger = JSON.parse(ledgerSource);
  const handled = new Set([...handler.matchAll(/(['"])(\/api\/platform\/[^'"]*)\1/gu)].map((match) => match[2]));
  const missing = ledger.decisions
    .map(({ path }) => path)
    .filter((path) => path.startsWith('/api/platform/') && !handled.has(path))
    .sort();
  const retired = [
    '/api/platform/gitea/webhook',
    '/api/platform/reconcile/next',
    '/api/platform/reconcile/receipt',
  ];
  const unavailable = [
    '/api/platform/changes/',
    '/api/platform/contracts',
    '/api/platform/os-shell/feature-state',
    '/api/platform/os-shell/feature-state/local-edge-automation',
    '/api/platform/os-shell/feature-state/local-edge-automation/scale-down-claim',
    '/api/platform/os-shell/feature-state/local-edge-automation/scale-down-complete',
    '/api/platform/releases/local-edge-automation',
    '/api/platform/releases/local-edge-automation/preview',
  ];
  assert.deepEqual(missing, [...retired, ...unavailable].sort());
  assert(routes.includes('gitea/webhook/?|reconcile/(?:next|receipt)/?'));
  assert(routes.includes('changes/[0-9a-fA-F]') && routes.includes('/retry/?)$'));
  assert.match(routes, /TargetPlatformCapabilityInactive/u);
  for (const discriminator of ['contracts/?', 'changes/$', 'os-shell/feature-state', 'releases/local-edge-automation']) {
    assert(routes.includes(discriminator), 'missing explicit unavailable classifier: ' + discriminator);
  }
  assert(routes.includes('location ~ ^/api/(?:identity') && routes.includes('platform(?:/|$)')
    && routes.includes('console_api_upstream'), 'target platform catch-all is missing');
  assert.match(platformOperations, /postMergeOwnerReady = \(\) => false/u);
  assert.equal((platformOperations.match(/assertPostMergeOwnerReady\(postMergeOwnerReady\);/g) || []).length, 3);
  assert.match(bootstrapInstaller, /-ReleaseType 'target'/u);
  assert.match(bootstrapControl, /if \(\$ReleaseType -eq 'legacy-rollback'\) \{\s*Enable-LegacyRollbackWebhook/u);
});

test('atomic owner routing has exact Web ingress and owner-to-C_API callback policy', async () => {
  const [consoleApi, extension, osaa, notification, recovery] = await Promise.all([
    read('apps/console-api/deploy.yaml'),
    read('apps/extension-controller/deploy.yaml'),
    read('apps/osaa-gateway/deploy.yaml'),
    read('apps/notification-dispatcher/deploy.yaml'),
    read('apps/recovery-owner/external-channel-service.yaml'),
  ]);
  assert.match(extension, /name: opensphere-extension-controller-ingress[\s\S]*app: opensphere-console\r?\n/u);
  assert.match(osaa, /name: opensphere-console-osaa-gateway-ingress[\s\S]*app: opensphere-console \} \} \}/u);
  assert.match(notification, /name: opensphere-notification-dispatcher-ingress[\s\S]*app: opensphere-console \}/u);
  assert.match(recovery, /name: opensphere-external-channel-executor-ingress[\s\S]*app: opensphere-console \}/u);
  assert.match(consoleApi, /Target Owners revalidate exchanged bearer\/session authority/u);
  for (const owner of [
    'opensphere-extension-controller',
    'opensphere-notification-dispatcher',
    'opensphere-external-channel-executor',
    'opensphere-shell-api',
    'opensphere-shell-gateway',
  ]) assert.match(consoleApi, new RegExp('app(?:\\.kubernetes\\.io/name)?: ' + owner, 'u'));
  assert.doesNotMatch(consoleApi, /Target Owners[\s\S]*podSelector: \{\}/u);
});
