const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Focused static contract: Manual is a Main Shell native page (subShell/plugin/Consumer 아님).
// The obsolete backend/manual-subShell package (UIPluginPackage/Registration + subShell image/workload)
// is fully retired — this file locks down the replacement contract so it cannot silently regress.

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('app.routes.ts imports ManualPage and defines an authenticated native /manual route', () => {
  const routes = read('src', 'app', 'app.routes.ts');

  assert.match(routes, /import\s*\{\s*ManualPage\s*\}\s*from\s*'\.\/pages\/manual'/);
  assert.match(
    routes,
    /path:\s*'manual',\s*component:\s*ManualPage,\s*canActivate:\s*\[authenticatedGuard\]/,
  );
  // Not a redirect to the retired subShell, not nested under the plugin-host prefix.
  assert.doesNotMatch(routes, /redirectTo:\s*'p\/manual'/);
});

test('os-shell.ts exposes a native global header link to /manual', () => {
  const shell = read('src', 'app', 'os', 'os-shell.ts');

  assert.match(shell, /os-header-manual/);
  assert.match(shell, /routerLink="\/manual"/);
});

test('search.service.ts routes Manual Registry hits to /manual?doc= and never /p/manual', () => {
  const search = read('src', 'app', 'core', 'search.service.ts');

  assert.match(search, /ManualService/);
  assert.match(search, /\/manual\?doc=/);
  assert.doesNotMatch(search, /\/p\/manual/);
});

test('native manual.ts consumes ManualService (not /api/manual directly) with loading/error/retry/detail states and no innerHTML', () => {
  const manualPage = read('src', 'app', 'pages', 'manual.ts');
  const manualService = read('src', 'app', 'core', 'manual.service.ts');

  // The page depends on ManualService for its data — it never injects HttpService/ApiService or
  // calls fetch()/http.request() itself; /api/manual is only ever reached through the
  // ManualService indirection. (The template legitimately *displays* the backend name
  // "OAA Manual Registry (/api/manual)" as user-facing text — that is not a network call.)
  assert.match(manualPage, /import\s*\{[\s\S]*ManualService[\s\S]*\}\s*from\s*'\.\.\/core\/manual\.service'/);
  assert.match(manualPage, /private manual = inject\(ManualService\)/);
  assert.doesNotMatch(manualPage, /inject\(HttpService\)|inject\(ApiService\)/);
  assert.doesNotMatch(manualPage, /fetch\(|\.request\(/);

  // The /api/manual surface itself is only reached indirectly, through ManualService.
  assert.match(manualService, /\/api\/manual\/sources/);
  assert.match(manualService, /\/api\/manual\/documents/);
  assert.match(manualService, /\/api\/manual\/document\?/);
  assert.match(manualService, /\/api\/manual\/search/);

  // Loading / error / retry / detail behavior.
  assert.match(manualPage, /docsLoading = signal\(true\)/);
  assert.match(manualPage, /docsError = signal\(''\)/);
  assert.match(manualPage, /detailLoading = signal\(false\)/);
  assert.match(manualPage, /detailError = signal\(''\)/);
  assert.match(manualPage, /retryDocument\(\)/);
  assert.match(manualPage, /\(click\)="retryDocument\(\)"/);
  assert.match(manualPage, /detail = signal<ManualDocumentDetail \| null>\(null\)/);
  assert.match(manualPage, /openDocument\(sourceId: string\)/);

  // Safe rendering only — no innerHTML binding/assignment anywhere in the native page (a JSDoc
  // comment noting that innerHTML is intentionally *not* used is expected and is not a usage).
  assert.doesNotMatch(manualPage, /\[innerHTML\]|\.innerHTML\s*=|bypassSecurityTrustHtml/);
});

test('the retired backend/manual-subShell package is fully absent', () => {
  assert.equal(fs.existsSync(path.join(root, 'backend', 'manual-subShell')), false);
});

test('no Manual-specific UIPluginPackage/Registration, subShell image, or workload manifest remains in Console', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  const controllerDeploy = read('backend', 'dupa-control', 'opensphere-console-dupa-controller.yaml');
  const crds = read('backend', 'dupa-control', 'ui-plugin-crds.yaml');
  const dockerfile = read('Dockerfile');

  // ui-plugin-crds.yaml only declares the generic CRD schema (UIPluginPackage/UIPluginRegistration
  // kinds, with a generic per-plugin `contributions.manual` capability flag) — it must not carry a
  // concrete Manual-subShell instance (no manifest/image/workload naming the retired package).
  assert.doesNotMatch(crds, /manual-subShell/i);
  assert.doesNotMatch(controller, /manual-subShell/i);
  assert.doesNotMatch(controllerDeploy, /manual-subShell/i);
  assert.doesNotMatch(dockerfile, /manual-subShell/i);

  // No leftover subShell-style Manual image/workload deployment anywhere under backend/.
  const walk = (dir) => {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...walk(full));
      else found.push(full);
    }
    return found;
  };
  const manualLike = walk(path.join(root, 'backend')).filter((f) => /manual-subshell/i.test(f));
  assert.deepEqual(manualLike, []);
});
