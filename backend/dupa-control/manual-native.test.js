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

test('native manual.ts consumes ManualService and implements the Help Center landing and reader without innerHTML', () => {
  const manualPage = read('src', 'app', 'pages', 'manual.ts');
  const manualService = read('src', 'app', 'core', 'manual.service.ts');

  // The page depends on ManualService for its data — it never injects HttpService/ApiService or
  // calls fetch()/http.request() itself; /api/manual is only ever reached through the
  // ManualService indirection. (The template legitimately *displays* the backend name
  // "OAA Manual Registry (/api/manual)" as user-facing text — that is not a network call.)
  assert.match(manualPage, /import\s*\{[\s\S]*ManualService[\s\S]*\}\s*from\s*'\.\.\/core\/manual\.service'/);
  assert.match(manualPage, /private readonly manual = inject\(ManualService\)/);
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
  assert.match(manualPage, /openDocument\(sourceId: string, syncRoute = true\)/);

  // Global search can navigate from an already-mounted /manual page to another
  // `/manual?doc=<sourceId>` result. Query-param changes must therefore remain reactive;
  // reading only the initial ActivatedRoute snapshot breaks the integrated-search link.
  assert.match(manualPage, /route\.queryParamMap/);
  assert.match(manualPage, /takeUntilDestroyed\(this\.destroyRef\)/);
  assert.match(manualPage, /docParam !== this\.selectedDocId\(\)/);
  assert.match(manualPage, /openDocument\(docParam, false\)/);
  assert.doesNotMatch(manualPage, /const docParam = this\.route\.snapshot\.queryParamMap\.get\('doc'\)/);

  // Oracle Help Center-inspired information architecture: hero search, 3 operating bands,
  // 10 Perspective data cards and a full document reader (not the old registry datagrid/panel).
  assert.match(manualPage, /class="manual-hero"/);
  assert.match(manualPage, /class="manual-primary-grid"/);
  assert.match(manualPage, /class="manual-deliver-grid"/);
  assert.match(manualPage, /class="manual-reader manual-shell-width"/);
  assert.match(manualPage, /perspectiveDocuments = computed/);
  assert.match(manualPage, /type ManualBand = 'operate' \| 'build' \| 'deliver'/);
  assert.match(manualPage, /manual-band-\$\{band\}/);
  // The old admin-facing Manual Registry table must never return as the user-facing /manual page.
  // Registry operation remains in /manage/oaa; /manual is exclusively the Help Center and reader.
  assert.doesNotMatch(
    manualPage,
    /OsDatagrid|OsPanel|os-datagrid|os-panel|os-source-chips|sourceFilter\(|OAA Manual Registry 소스\/문서 탐색 및 검색/,
  );

  // Safe rendering only — no innerHTML binding/assignment anywhere in the native page (a JSDoc
  // comment noting that innerHTML is intentionally *not* used is expected and is not a usage).
  assert.doesNotMatch(manualPage, /\[innerHTML\]|\.innerHTML\s*=|bypassSecurityTrustHtml/);
});

test('bundled Manual Registry provides ten readable Perspective documents and never ingests legacy docs.ts', () => {
  const seed = JSON.parse(read('backend', 'opensphere-console-oaa-gateway', 'manual-seeds', 'opensphere-core-manuals.json'));
  const perspectiveDocs = seed.documents.filter((doc) => doc.tags?.includes('perspective-home'));

  assert.equal(perspectiveDocs.length, 10);
  assert.deepEqual(
    perspectiveDocs.map((doc) => doc.tags.find((tag) => /^order-\d{2}$/.test(tag))),
    Array.from({ length: 10 }, (_, index) => `order-${String(index + 1).padStart(2, '0')}`),
  );
  assert.equal(seed.documents.some((doc) => doc.sourceId === 'help-center/docs-ts'), false);
  assert.equal(seed.documents.some((doc) => /OpenSphere-shell-menual\/src\/app\/docs\.ts/i.test(doc.sourcePath || '')), false);
  assert.equal(seed.documents.some((doc) => doc.sourceId === 'console-docs/manual-ownership'), true);
});

test('Manual product ownership is Console-native and the standalone legacy repository stays deleted', () => {
  const ownership = read('docs', 'MANUAL-OWNERSHIP.md');
  const legacyStandalone = path.resolve(root, '..', 'OpenSphere-shell-menual');

  assert.match(ownership, /Manual의 유일한 제품 소유자는 Main Shell인 `OpenSphere-console`/);
  assert.match(ownership, /`docs\/manual\/\*\.md`/);
  assert.match(ownership, /`src\/app\/pages\/manual\.ts`/);
  assert.match(ownership, /같은 기능을 다른 이름의 Manual subShell로 다시 만들지 않는다/);
  assert.equal(fs.existsSync(legacyStandalone), false, 'the retired standalone Manual repository must stay deleted');
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
