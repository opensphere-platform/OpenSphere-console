const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
// OAA-Gateway is a Main Shell native, CBS-consumer server workload (CONSTITUTION-0004 §4.2) —
// product ownership and lifecycle belong to Console/Main Shell, exactly like Manual, even though
// it runs as a separate server-side workload for security/isolation. It is administered by its own
// Setup-owned /manage/oaa page (admin-oaa.ts, see oaa-admin-native.test.js) — not by
// dupa-control/controller.js reconciliation or admin-backbone.ts (controller never creates/patches/
// deletes the OAA-Gateway Deployment; it only probes /readyz — see main-shell-base.test.js). It is
// NOT a Backbone-owned pillar and NOT an optional/staged subShell. `controller` is still read below
// only for the still-current, non-OAA-specific manual-subShell retirement assertion. Same-origin
// nginx proxying, base-manifest RBAC/image/CA-mount wiring, and the /readyz contract are covered in
// main-shell-base.test.js and oaa-base-runtime.test.js.
const controller = fs.readFileSync(path.join(root, 'backend', 'dupa-control', 'controller.js'), 'utf8');
const gateway = fs.readFileSync(path.join(root, 'backend', 'opensphere-console-oaa-gateway', 'server.js'), 'utf8');
const oaaAgent = fs.readFileSync(path.join(root, 'src', 'app', 'os', 'os-oaa-agent.ts'), 'utf8');
const manualService = fs.readFileSync(path.join(root, 'src', 'app', 'core', 'manual.service.ts'), 'utf8');
const searchService = fs.readFileSync(path.join(root, 'src', 'app', 'core', 'search.service.ts'), 'utf8');
const extensionHost = fs.readFileSync(path.join(root, 'src', 'app', 'core', 'extension-host.service.ts'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src', 'app', 'app.routes.ts'), 'utf8');
const osShell = fs.readFileSync(path.join(root, 'src', 'app', 'os', 'os-shell.ts'), 'utf8');
const manualPage = fs.readFileSync(path.join(root, 'src', 'app', 'pages', 'manual.ts'), 'utf8');
const manualSeed = JSON.parse(fs.readFileSync(path.join(root, 'backend', 'opensphere-console-oaa-gateway', 'manual-seeds', 'opensphere-core-manuals.json'), 'utf8'));
const oaaManifest = fs.readFileSync(path.join(root, 'backend', 'backbone', 'console-services.yaml'), 'utf8');

test('OAA-Gateway never returns raw LLM key material in list metadata', () => {
  assert.match(gateway, /function keyMetaFromSecret/);
  assert.match(gateway, /stringData:\s*\{\s*api_key:\s*b\.apiKey\s*\}/);
  assert.doesNotMatch(gateway, /apiKey:\s*b\.apiKey/);
  assert.doesNotMatch(gateway, /api_key:\s*b64d/);
});

test('OAA-Gateway /healthz stays liveness-only; /readyz is the unauthenticated in-cluster readiness gate; /api/oaa/health is authenticated and explicit', () => {
  // /healthz never checks Postgres/pgvector/seed state — that is exclusively /readyz's job.
  const healthzLine = gateway.match(/if \(url\.pathname === '\/healthz'\)[^\n]*\n/)?.[0] || '';
  assert.match(healthzLine, /return json\(res, 200, \{ ok: true \}\);/);
  assert.doesNotMatch(healthzLine, /verifyAuthed|computeReadiness/);

  // /readyz is unauthenticated (no verifyAuthed/verifyAdmin call in its block) and returns a
  // structured ready/components/reason body with a non-200 status when any component fails.
  assert.match(gateway, /async function computeReadiness\(\)/);
  const readyzBlock = gateway.match(/if \(url\.pathname === '\/readyz'\) \{[\s\S]*?\n    \}/)?.[0] || '';
  assert.match(readyzBlock, /computeReadiness\(\)/);
  assert.doesNotMatch(readyzBlock, /verifyAuthed|verifyAdmin/);
  assert.match(readyzBlock, /state\.ready \? 200 : 503/);
  assert.match(readyzBlock, /components: state\.components/);
  assert.match(readyzBlock, /reason: state\.reason/);
  for (const component of ['postgres', 'vectorSchema', 'manualRegistrySeed', 'toolRegistrySeed']) {
    assert.match(gateway, new RegExp(`components\\.${component} = `));
  }
  // Component checks never leak secret material — no password/apiKey/token fields in the readyz path.
  const computeReadinessFn = gateway.match(/async function computeReadiness\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(computeReadinessFn, /apiKey|api_key|password|PG\.password/);

  // /api/oaa/health stays authenticated and now exposes explicit readiness/degraded/mutation-gate
  // state instead of a bare `ok: true`.
  const healthBlock = gateway.match(/if \(url\.pathname === '\/api\/oaa\/health'\) \{[\s\S]*?\n    \}/)?.[0] || '';
  assert.match(healthBlock, /await verifyAuthed\(req\)/);
  assert.match(healthBlock, /readiness: \{ ready: readiness\.ready, components: readiness\.components, reason: readiness\.reason \}/);
  assert.match(healthBlock, /degraded,/);
  assert.match(healthBlock, /mutationGate: \{ enabled: OAA_MUTATION_ENABLED, reason:/);
});

test('ensureKnowledgeSchema always clears the in-flight schema promise on both success and failure, so a startup race with PostgreSQL can retry instead of pinning a rejected Promise forever', () => {
  const fn = extractFunctionSource(gateway, 'ensureKnowledgeSchema');
  assert.match(fn, /if \(pgSchemaReady\) return true;/);
  assert.match(fn, /if \(pgSchemaPromise\) return pgSchemaPromise;/);
  const finallyBlock = fn.match(/finally \{([\s\S]*?)\n  \}\n\}/)?.[1] || '';
  assert.ok(finallyBlock, 'ensureKnowledgeSchema must have a finally block clearing pgSchemaPromise');
  assert.match(finallyBlock, /pgSchemaPromise = null;/);
  // Regression guard: clearing must not be gated behind pgSchemaReady (the old
  // `if (pgSchemaReady) pgSchemaPromise = null;`), or a failed schema setup leaves
  // pgSchemaPromise pinned to a rejected Promise forever and every later call/readiness probe
  // fails without ever retrying.
  assert.doesNotMatch(finallyBlock, /if \(pgSchemaReady\)/);
});

test('computeReadiness self-heals bundled Manual Registry and tool registry seeds via concurrency-safe reconciliation before returning manual/tool not-ready, without unconditionally re-seeding once rows exist', () => {
  const fn = extractFunctionSource(gateway, 'computeReadiness');

  // Manual Registry: rows already present -> no seed call, just mark ready.
  assert.match(fn, /if \(Number\(r\.rows\[0\]\?\.n \|\| 0\) > 0\) \{\s*\n\s*\/\/ Rows already present[^\n]*\n\s*components\.manualRegistrySeed = true;/);
  // Manual Registry: rows absent -> reconcile via the existing concurrency-safe seeder, then re-query.
  assert.match(fn, /await ensureManualRegistryReady\(\)\.catch\(\(\) => null\);/);
  assert.match(fn, /const r2 = await pool\.query\(manualRegistrySeedQuery\);\s*\n\s*components\.manualRegistrySeed = Number\(r2\.rows\[0\]\?\.n \|\| 0\) > 0;/);

  // Tool registry: same self-heal shape via ensureToolRegistryReady.
  assert.match(fn, /if \(Number\(r\.rows\[0\]\?\.n \|\| 0\) > 0\) \{\s*\n\s*\/\/ Rows already present[^\n]*\n\s*components\.toolRegistrySeed = true;/);
  assert.match(fn, /await ensureToolRegistryReady\(\)\.catch\(\(\) => null\);/);
  assert.match(fn, /const r2 = await pool\.query\(toolRegistrySeedQuery\);\s*\n\s*components\.toolRegistrySeed = Number\(r2\.rows\[0\]\?\.n \|\| 0\) > 0;/);

  // Reconciliation must run strictly before each not-ready return, so a caller that retries
  // /readyz observes recovery instead of a permanently stuck 503.
  const manualHealIdx = fn.indexOf('await ensureManualRegistryReady()');
  const manualNotReadyIdx = fn.indexOf("reason: 'manual_registry_seed_not_ready'");
  assert.ok(manualHealIdx >= 0 && manualNotReadyIdx > manualHealIdx, 'manual registry reconciliation must precede the not-ready return');

  const toolHealIdx = fn.indexOf('await ensureToolRegistryReady()');
  const toolNotReadyIdx = fn.indexOf("reason: 'tool_registry_seed_not_ready'");
  assert.ok(toolHealIdx >= 0 && toolNotReadyIdx > toolHealIdx, 'tool registry reconciliation must precede the not-ready return');

  // Structured booleans/stable reason codes only — no secret material anywhere in the function.
  assert.doesNotMatch(fn, /apiKey|api_key|password|PG\.password/);
});

test('ensureToolRegistryReady is a concurrency-safe, idempotent seed-if-absent wrapper around seedToolRegistry, mirroring the Manual Registry inflight-promise pattern (so /readyz never re-upserts the tool registry on every probe)', () => {
  assert.match(gateway, /let toolSeedReady = false;/);
  assert.match(gateway, /let toolSeedInflight = null;/);
  const fn = extractFunctionSource(gateway, 'ensureToolRegistryReady');
  assert.match(fn, /await ensureKnowledgeSchema\(\);/);
  assert.match(fn, /if \(!toolSeedReady\) \{/);
  assert.match(fn, /toolSeedInflight \|\|= seedToolRegistry\(actor\)/);
  assert.match(fn, /toolSeedReady = true;/);
  assert.match(fn, /\.finally\(\(\) => \{\s*\n\s*toolSeedInflight = null;/);
  assert.match(fn, /await toolSeedInflight;/);
});

test('OAA-Gateway exposes authenticated chat without exposing key material', () => {
  assert.match(gateway, /url\.pathname === '\/api\/oaa\/chat'/);
  assert.match(gateway, /await verifyAuthed\(req\)/);
  assert.match(gateway, /chatCompletion\(body, actor\)/);
  assert.match(gateway, /thinking = \{ type: 'disabled' \}/);
  assert.match(gateway, /sources:\s*sources\.map/);
  assert.match(gateway, /knowledgeSystemMessage\(sources\)/);
  assert.match(gateway, /conceptGraphSystemMessage\(conceptGraph\)/);
  assert.match(gateway, /concepts:\s*conceptGraph/);
  assert.match(gateway, /OpenSphere Concept Graph Context/);
  assert.match(gateway, /suggestActionBindings/);
  assert.match(gateway, /actionSuggestionsSystemMessage\(suggestedActions\)/);
  assert.match(gateway, /suggestedActions/);
  assert.match(gateway, /OAA Suggested Action Bindings/);
});

test('OAA-Gateway stores project knowledge in Backbone PostgreSQL pgvector', () => {
  assert.match(gateway, /require\('pg'\)/);
  // pgvector installation is bootstrap-owner responsibility only (CONSTITUTION-0004 §4.5 OAA
  // bootstrap boundary) -- the sealed opensphere_db_bootstrap superuser runs `CREATE EXTENSION
  // IF NOT EXISTS vector` in backend/backbone/bootstrap/backbone.yaml. The dedicated
  // opensphere_oaa runtime role has no CREATE on public and must never attempt this itself; see
  // oaa-gateway-postgres-boundary.test.js.
  assert.doesNotMatch(gateway, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.match(gateway, /oaa_knowledge_documents/);
  assert.match(gateway, /oaa_knowledge_chunks/);
  assert.match(gateway, /oaa_manual_concepts/);
  assert.match(gateway, /oaa_manual_relations/);
  assert.match(gateway, /oaa_tool_capabilities/);
  assert.match(gateway, /oaa_manual_action_bindings/);
  assert.match(gateway, /manual-concept\.opensphere\.io\/v1alpha1/);
  assert.match(gateway, /manual-relation\.opensphere\.io\/v1alpha1/);
  assert.match(gateway, /manual-concept-graph\.opensphere\.io\/v1alpha1/);
  assert.match(gateway, /upsertManualConcepts/);
  assert.match(gateway, /upsertManualRelations/);
  assert.match(gateway, /listManualConceptGraph/);
  assert.match(gateway, /embedding vector\(\$\{OAA_EMBED_DIM\}\)/);
  assert.match(gateway, /\/api\/oaa\/admin\/knowledge\/seed/);
  assert.match(gateway, /\/api\/oaa\/admin\/knowledge\/manual-seed/);
  assert.match(gateway, /\/api\/oaa\/admin\/knowledge\/manual-seed\/bundled/);
  assert.match(gateway, /\/api\/oaa\/admin\/knowledge\/reembed/);
  assert.match(gateway, /\/api\/oaa\/knowledge\/concepts/);
  assert.match(gateway, /providerEmbedding\(text, key\)/);
  assert.match(gateway, /OpenSphere 10 Perspective/);
  assert.match(gateway, /manual\.opensphere\.io\/v1alpha1/);
  assert.match(gateway, /manual-seed\.opensphere\.io\/v1alpha1/);
  assert.match(gateway, /OAA_MANUAL_SEED_PATH/);
  assert.match(gateway, /manualSources/);
  assert.match(gateway, /manualDocuments/);
  assert.match(gateway, /manualChunks/);
  assert.match(gateway, /manualConcepts/);
  assert.match(gateway, /manualRelations/);
  assert.match(gateway, /seedBundledManualKnowledge/);
  assert.match(gateway, /seedBundledManualKnowledgeIfEmpty/);
  assert.match(gateway, /manualSeedInflight/);
  assert.match(gateway, /ON CONFLICT \(document_id, chunk_index\)/);
  assert.match(gateway, /bundled manuals up to date/);
  assert.match(gateway, /metadata->>'checksum'/);
  assert.match(gateway, /authorityTier/);
  assert.match(gateway, /sourcePath/);
  assert.match(gateway, /sectionHeading/);
});

test('OAA bundled manual seed carries core OpenSphere manuals', () => {
  assert.equal(manualSeed.schema, 'manual-seed.opensphere.io/v1alpha1');
  assert.equal(manualSeed.source.id, 'opensphere-core-manuals');
  assert.ok(manualSeed.documents.length >= 12);
  const ids = manualSeed.documents.map((d) => d.sourceId);
  assert.ok(ids.includes('opensphere-docs/constitution-0000'));
  assert.ok(ids.includes('opensphere-docs/p4-intelligence'));
  assert.ok(ids.includes('console-docs/backbone-architecture'));
  assert.ok(ids.includes('console-docs/oaa-manual-knowledge-data-model'));
  assert.ok(ids.includes('help-center/docs-ts'));
  assert.ok(manualSeed.concepts.length >= 10);
  assert.ok(manualSeed.relations.length >= 10);
  assert.ok(manualSeed.concepts.some((c) => c.id === 'concept:opensphere:perspective:ai-level'));
  assert.ok(manualSeed.concepts.some((c) => c.id === 'concept:opensphere:service:oaa-gateway'));
  assert.ok(manualSeed.relations.some((r) => r.fromId === 'concept:opensphere:service:oaa-gateway' && r.relation === 'belongs-to'));
  for (const doc of manualSeed.documents) {
    assert.equal(typeof doc.content, 'string');
    assert.ok(doc.content.length > 100);
    assert.equal(typeof doc.checksum, 'string');
    assert.equal(doc.checksum.length, 64);
    assert.ok(Number.isInteger(doc.authorityTier));
  }
});

test('Console Manual is exposed as a registry API, header search source, and a native /manual page', () => {
  assert.match(gateway, /async function listManualSources/);
  assert.match(gateway, /async function listManualDocuments/);
  assert.match(gateway, /async function getManualDocument/);
  assert.match(gateway, /async function searchManualRegistry/);
  assert.match(gateway, /manual-sources\.opensphere\.io\/v1alpha1/);
  assert.match(gateway, /manual-documents\.opensphere\.io\/v1alpha1/);
  assert.match(gateway, /manual-document\.opensphere\.io\/v1alpha1/);
  assert.match(gateway, /manual-search\.opensphere\.io\/v1alpha1/);
  assert.match(gateway, /\/api\/manual\/sources/);
  assert.match(gateway, /\/api\/manual\/documents/);
  assert.match(gateway, /\/api\/manual\/document/);
  assert.match(gateway, /\/api\/manual\/search/);
  assert.match(manualService, /class ManualService/);
  assert.match(manualService, /\/api\/manual\/sources/);
  assert.match(manualService, /\/api\/manual\/documents/);
  assert.match(manualService, /\/api\/manual\/document/);
  assert.match(manualService, /\/api\/manual\/search/);
  assert.match(searchService, /ManualService/);
  assert.match(searchService, /this\.manual\.search\(q, 6\)/);
  assert.match(searchService, /queryManualContributions/);
  assert.match(searchService, /manualContributions/);
  assert.match(searchService, /manual-registry/);
  assert.match(searchService, /\/manual\?doc=/);
  assert.doesNotMatch(searchService, /\/p\/manual\?doc=/);
  assert.match(extensionHost, /manual:contribute/);
  assert.match(extensionHost, /manualContributions/);
  assert.match(extensionHost, /syncManualContribution/);
  assert.match(extensionHost, /\/api\/oaa\/admin\/knowledge\/manual-seed/);
  // Manual is a Main Shell native page (subShell/plugin/Consumer 아님) — component + deep-linkable route.
  assert.match(routes, /path: 'manual'/);
  assert.match(routes, /component: ManualPage/);
  assert.doesNotMatch(routes, /redirectTo: 'p\/manual'/);
  assert.doesNotMatch(routes, /ManualShell/);
  // Native global header action (§manual-native-console) — not a subShell nav entry.
  assert.match(osShell, /os-header-manual/);
  assert.match(osShell, /routerLink="\/manual"/);
  assert.match(manualPage, /class ManualPage/);
  assert.match(manualPage, /ManualService/);
  assert.match(manualPage, /selector: 'os-manual'/);
  // The obsolete Manual subShell package is fully retired — no package/UIPluginPackage/Registration surface remains.
  assert.equal(fs.existsSync(path.join(root, 'backend', 'manual-subShell')), false);
  assert.doesNotMatch(controller, /manual-subShell/);
  assert.doesNotMatch(gateway, /manual-subShell/);
});

test('OAA-Gateway exposes read-only live environment tools', () => {
  assert.match(gateway, /OAA_ENV_NAMESPACES/);
  assert.match(gateway, /function oaaToolManifest/);
  assert.match(gateway, /function oaaActionBindings/);
  assert.match(gateway, /async function seedToolRegistry/);
  assert.match(gateway, /async function toolManifestFromStore/);
  assert.match(gateway, /async function actionBindingsFromStore/);
  assert.match(gateway, /async function executeActionBinding/);
  assert.match(gateway, /function requireBindingConfirmation/);
  assert.match(gateway, /oaa-tool-manifest\.opensphere\.io\/v1alpha1/);
  assert.match(gateway, /oaa-action-bindings\.opensphere\.io\/v1alpha1/);
  assert.match(gateway, /tool-registry-seed/);
  assert.match(gateway, /seeded tool registry/);
  assert.match(gateway, /\/api\/oaa\/tools\/manifest/);
  assert.match(gateway, /\/api\/oaa\/tools\/action-bindings/);
  assert.match(gateway, /oaa\.environment\.read/);
  assert.match(gateway, /oaa\.k8s\.pods\.list/);
  assert.match(gateway, /oaa\.k8s\.cluster\.pods\.summary/);
  assert.match(gateway, /clusterPodSummary/);
  assert.match(gateway, /Cluster pod summary/);
  assert.match(gateway, /oaa\.knowledge\.search/);
  assert.match(gateway, /manual-action:opensphere:cluster-pod-count/);
  assert.match(gateway, /manual-action:opensphere:opensphere-console-oaa-gateway-restart/);
  assert.match(gateway, /async function environmentSnapshot/);
  assert.match(gateway, /namespaceSnapshot\(ns\)/);
  assert.match(gateway, /\/api\/oaa\/tools\/environment/);
  assert.match(gateway, /environmentSystemMessage\(environment\)/);
});

test('OAA-Gateway exposes controlled admin action tools', () => {
  assert.match(gateway, /async function handleSlashCommand/);
  assert.match(gateway, /cmd === '\/env'/);
  assert.match(gateway, /cmd === '\/pod-count'/);
  assert.match(gateway, /cmd === '\/pods'/);
  assert.match(gateway, /cmd === '\/services'/);
  assert.match(gateway, /cmd === '\/events'/);
  assert.match(gateway, /cmd === '\/deployments'/);
  assert.match(gateway, /cmd === '\/describe'/);
  assert.match(gateway, /cmd === '\/rollout'/);
  assert.match(gateway, /cmd === '\/logs'/);
  assert.match(gateway, /cmd === '\/restart'/);
  assert.match(gateway, /cmd === '\/scale'/);
  assert.match(gateway, /cmd === '\/bindings'/);
  assert.match(gateway, /cmd === '\/action'/);
  assert.match(gateway, /\/api\/oaa\/actions\/bindings\/execute/);
  assert.match(gateway, /binding-execute/);
  assert.match(gateway, /summarizeToolManifest/);
  assert.match(gateway, /summarizeActionBindings/);
  assert.match(gateway, /summarizeStoredToolManifest/);
  assert.match(gateway, /summarizeStoredActionBindings/);
  assert.match(gateway, /oaa\.k8s\.deployment\.restart/);
  assert.match(gateway, /oaa\.k8s\.deployment\.scale/);
  assert.match(gateway, /\/api\/oaa\/actions\/k8s\/restart-deployment/);
  assert.match(gateway, /\/api\/oaa\/actions\/k8s\/scale-deployment/);
  assert.match(gateway, /\/api\/oaa\/tools\/k8s\/pod-logs/);
  assert.match(gateway, /\/api\/oaa\/tools\/k8s\/pods-summary/);
  assert.match(gateway, /\/api\/oaa\/tools\/k8s\/services/);
  assert.match(gateway, /\/api\/oaa\/tools\/k8s\/events/);
  assert.match(gateway, /\/api\/oaa\/tools\/k8s\/describe/);
  assert.match(gateway, /\/api\/oaa\/tools\/k8s\/rollout/);
  assert.match(gateway, /async function describePod/);
  assert.match(gateway, /async function describeDeployment/);
  assert.match(gateway, /async function rolloutStatus/);
  assert.match(gateway, /await verifyAdmin\(req\)/);
  assert.match(gateway, /assertActorAdmin\(actor\)/);
  assert.match(gateway, /confirmation required/);
  assert.match(gateway, /k8s-restart-deployment/);
  assert.match(gateway, /k8s-scale-deployment/);
});

// OAA-Gateway administration lives at the Setup-owned /manage/oaa page (admin-oaa.ts), which is a
// standalone component separate from admin-backbone.ts (contract enforced in oaa-admin-native.test.js,
// including `assert.doesNotMatch(adminBackbone, /OAA|oaa|LlmKey|KnowledgeStore/)`). No OAA/LLM-key/
// knowledge-store assertions belong in this file's admin-backbone coverage.

test('Action binding execution resolves the connected tool from the raw store and fails closed on a risk/tool mismatch', () => {
  // Contract for the OAA action-binding mutation gate (CONSTITUTION-0004 §4.2): a binding's stored
  // risk_level alone must never be trusted to decide whether execution is a mutation. The gate must
  // additionally resolve the bound tool's readOnly flag from the raw (unfiltered) tool store, so a
  // read-labelled binding wired to a write tool cannot bypass the gate via a direct bindingId call.
  assert.match(gateway, /async function getActionBinding\(id\)/);
  const getActionBindingFn = gateway.match(/async function getActionBinding\(id\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(getActionBindingFn, /await toolManifestFromStore\(\)/);
  assert.match(getActionBindingFn, /toolReadOnly:\s*tool\.readOnly === true/);
  assert.match(getActionBindingFn, /if \(!tool\) throw \{ code: 409/);

  assert.match(gateway, /async function executeActionBinding\(body = \{\}, actor = null\)/);
  const executeActionBindingFn = gateway.match(/async function executeActionBinding\(body = \{\}, actor = null\) \{[\s\S]*?\n  switch \(binding\.toolId\)/)?.[0] || '';
  assert.match(executeActionBindingFn, /const mutationRequired = binding\.riskLevel !== 'read' \|\| binding\.toolReadOnly !== true;/);

  // The gate must fire before confirmation-phrase validation, admin-membership validation, and the
  // execution switch — never after.
  const gateIdx = executeActionBindingFn.indexOf('mutationRequired');
  const firstGateCallIdx = executeActionBindingFn.indexOf('if (mutationRequired) assertMutationEnabled(actor, binding.id);');
  const confirmIdx = executeActionBindingFn.indexOf('requireBindingConfirmation(binding, inputs, body.confirm || \'\')');
  const adminGateCallIdx = executeActionBindingFn.indexOf('if (mutationRequired) assertActorAdmin(actor);');
  assert.ok(gateIdx >= 0 && firstGateCallIdx > gateIdx, 'mutationRequired must be computed before it gates execution');
  assert.ok(firstGateCallIdx >= 0 && confirmIdx > firstGateCallIdx, 'mutation gate must run before confirmation-phrase validation');
  assert.ok(adminGateCallIdx > confirmIdx, 'admin-membership gate must run after confirmation but is still driven by mutationRequired');
});

// Extracts one top-level `function name(...) { ... }` (or `async function ...`) body from `source`
// by brace-matching from the opening `{`, independent of indentation style. Used below to actually
// *execute* the gateway's pure mutation-gate/reason-validator logic (not just regex-match its shape).
function extractFunctionSource(source, name) {
  const startMatch = source.match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`));
  assert.ok(startMatch, `function ${name} not found in gateway source`);
  const start = startMatch.index;
  let i = start + startMatch[0].length;
  let depth = 1;
  while (depth > 0 && i < source.length) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  return source.slice(start, i);
}

// Loads the named pure functions out of the real server.js source into an isolated vm sandbox and
// returns callable references to them, plus the sandbox object so free-variable globals (like
// OAA_MUTATION_ENABLED) can be set/changed between calls.
function loadGatewayFunctions(names, sandboxGlobals = {}) {
  const sandbox = { ...sandboxGlobals };
  vm.createContext(sandbox);
  const src = names.map((n) => extractFunctionSource(gateway, n)).join('\n\n');
  const fns = vm.runInContext(`${src}\n({ ${names.join(', ')} });`, sandbox);
  return { fns, sandbox };
}

test('withActionBindingMutationGate fails closed: bindings referencing an unknown/missing tool are filtered, not just non-read-only ones', () => {
  const { fns, sandbox } = loadGatewayFunctions(
    ['withActionBindingMutationGate'],
    { OAA_MUTATION_GATE_REASON: 'mutation_disabled_until_his_ready' },
  );
  const toolManifest = {
    tools: [
      { id: 'oaa.read.tool', readOnly: true },
      { id: 'oaa.write.tool', readOnly: false },
    ],
  };
  const bindingManifest = {
    bindings: [
      { id: 'b-read-good', riskLevel: 'read', toolId: 'oaa.read.tool', valid: true },
      { id: 'b-read-write-tool', riskLevel: 'read', toolId: 'oaa.write.tool', valid: true },
      // The regression this test guards: a binding stamped riskLevel:'read' whose toolId does not
      // resolve to any entry in the raw tool manifest at all (unknown/missing tool) must be
      // dropped fail-closed, not fall through because Map#get() on a missing key is `undefined`
      // (which is !== false and used to slip past the old `=== false` check).
      { id: 'b-read-unknown-tool', riskLevel: 'read', toolId: 'oaa.unknown.tool', valid: true },
      { id: 'b-write-read-tool', riskLevel: 'write', toolId: 'oaa.read.tool', valid: true },
    ],
  };

  sandbox.OAA_MUTATION_ENABLED = false;
  const gated = fns.withActionBindingMutationGate(bindingManifest, toolManifest);
  assert.equal(gated.mutationEnabled, false);
  assert.deepStrictEqual(gated.bindings.map((b) => b.id), ['b-read-good']);

  // When the gate is open, bindings pass through untouched (no filtering).
  sandbox.OAA_MUTATION_ENABLED = true;
  const open = fns.withActionBindingMutationGate(bindingManifest, toolManifest);
  assert.equal(open.mutationEnabled, true);
  assert.equal(open.bindings, bindingManifest.bindings);
});

test('requireMutationReason fails closed on empty/whitespace/missing reasons with a stable machine-readable 400, and passes through a real trimmed reason', () => {
  const { fns } = loadGatewayFunctions(['requireMutationReason']);
  for (const bad of [undefined, null, '', '   ', '\n\t ']) {
    assert.throws(
      () => fns.requireMutationReason(bad),
      (err) => {
        assert.equal(err.code, 400);
        assert.equal(err.errorCode, 'mutation_reason_required');
        assert.equal(typeof err.msg, 'string');
        return true;
      },
    );
  }
  assert.equal(fns.requireMutationReason('  scheduled maintenance  '), 'scheduled maintenance');
});

test('Direct restart/scale endpoints and action-binding write execution require a real caller-supplied reason before mutation, and never synthesize a fallback', () => {
  // No synthesized fallback reason anywhere in the gateway (e.g. the old
  // `inputs.reason || \`binding ${binding.id}\`` pattern).
  assert.doesNotMatch(gateway, /reason:\s*inputs\.reason\s*\|\|\s*`binding/);

  const restartFn = extractFunctionSource(gateway, 'restartDeployment');
  const scaleFn = extractFunctionSource(gateway, 'scaleDeployment');
  for (const [label, fn] of [['restartDeployment', restartFn], ['scaleDeployment', scaleFn]]) {
    assert.match(fn, /const reason = requireMutationReason\(body\.reason\);/, `${label} must validate a real reason`);
    const confirmIdx = fn.indexOf('requireConfirm(');
    const reasonIdx = fn.indexOf('requireMutationReason(body.reason)');
    const patchIdx = fn.indexOf(`k8s('PATCH'`);
    assert.ok(confirmIdx >= 0 && reasonIdx > confirmIdx, `${label}: reason check must run after confirmation check`);
    assert.ok(patchIdx > reasonIdx, `${label}: reason must be validated before the mutating PATCH call`);
    assert.match(fn, /audit\(actor, '[^']+', `\$\{ns\}\/\$\{name\}`, 'ok', .*reason/, `${label} must audit using the validated reason`);
  }

  const executeActionBindingFn = extractFunctionSource(gateway, 'executeActionBinding');
  // Reason validation is gated by mutationRequired (same variable that gates assertMutationEnabled
  // and assertActorAdmin) — so read-only binding execution never has to supply a reason — and it
  // runs strictly before the execution switch (i.e. before any mutation can occur).
  assert.match(executeActionBindingFn, /if \(mutationRequired\) inputs\.reason = requireMutationReason\(inputs\.reason\);/);
  const adminGateIdx = executeActionBindingFn.indexOf('if (mutationRequired) assertActorAdmin(actor);');
  const reasonGateIdx = executeActionBindingFn.indexOf('if (mutationRequired) inputs.reason = requireMutationReason(inputs.reason);');
  const switchIdx = executeActionBindingFn.indexOf('switch (binding.toolId)');
  assert.ok(adminGateIdx >= 0 && reasonGateIdx > adminGateIdx, 'reason gate must run after the admin gate');
  assert.ok(switchIdx > reasonGateIdx, 'reason gate must run before the execution switch (before any mutation)');
  // The restart/scale dispatch cases forward the already-validated inputs.reason — no per-case
  // fallback synthesis remains.
  assert.match(executeActionBindingFn, /case 'oaa\.k8s\.deployment\.restart':[\s\S]*?reason: inputs\.reason,/);
  assert.match(executeActionBindingFn, /case 'oaa\.k8s\.deployment\.scale':[\s\S]*?reason: inputs\.reason,/);
});

test('OAA chat UI renders answer citations from Gateway sources', () => {
  assert.match(oaaAgent, /interface OaaSource/);
  assert.match(oaaAgent, /interface OaaConcept/);
  assert.match(oaaAgent, /interface OaaSuggestedAction/);
  assert.match(oaaAgent, /sources\?: OaaSource\[\]/);
  assert.match(oaaAgent, /concepts\?: OaaConcept\[\]/);
  assert.match(oaaAgent, /actions\?: OaaSuggestedAction\[\]/);
  assert.match(oaaAgent, /normalizeSources\(body\.sources\)/);
  assert.match(oaaAgent, /normalizeConcepts\(body\.concepts\?\.concepts\)/);
  assert.match(oaaAgent, /normalizeSuggestedActions\(body\.suggestedActions\)/);
  assert.match(oaaAgent, /oaa-sources/);
  assert.match(oaaAgent, /Sources/);
  assert.match(oaaAgent, /Concepts/);
  assert.match(oaaAgent, /Suggested Actions/);
  assert.match(oaaAgent, /useSuggestedAction/);
  assert.match(oaaAgent, /resetDockWidth/);
  assert.match(oaaAgent, /Drag to resize chat/);
  assert.match(oaaAgent, /oaa-agent-resizing/);
  assert.match(oaaAgent, /concepts \$\{conceptCount\}/);
  assert.match(oaaAgent, /actions \$\{actionCount\}/);
  assert.match(oaaAgent, /sourceLabel\(s\)/);
  assert.match(oaaAgent, /authorityTier/);
  assert.match(oaaAgent, /sourcePath/);
});

// ── OAA verifyAuthed live-identity-authority parity (security hardening) ────────────────────────
// Security finding: verifyAuthed previously trusted locally-verified signed group claims until exp.
// A revoked PAT/CLI session, a disabled account, or a removed admin role could remain usable until
// the token's own exp. dupa-control's controller.js already requires the auth BFF's live
// /bff/token/introspect state on every request with no cache; OAA must have the same live identity
// authority. These tests prove that contract statically (source shape) and by executing the real,
// unmodified pure validator functions extracted from server.js.

test('OAA-Gateway defines TOKEN_INTROSPECTION_URL/SERVERNAME with the same defaults as dupa-control, and reuses the mounted installation CA (jwksCa) rather than a second CA source', () => {
  assert.match(gateway, /const TOKEN_INTROSPECTION_URL = process\.env\.TOKEN_INTROSPECTION_URL\s*\n\s*\|\|\s*'https:\/\/opensphere-console-auth\.opensphere-console\.svc:8443\/bff\/token\/introspect';/);
  assert.match(gateway, /const TOKEN_INTROSPECTION_SERVERNAME = process\.env\.TOKEN_INTROSPECTION_SERVERNAME \|\| KANIDM_TLS_SERVERNAME;/);
});

test('verifyAuthed introspects the exact raw JWT on EVERY authenticated request with no cache, and derives groups/admin decision from live introspection state, not signed claims', () => {
  const fn = extractFunctionSource(gateway, 'verifyAuthed');
  // The raw bearer token captured off the Authorization header (not a re-encoded/derived value) is
  // what gets introspected, and it is looked up fresh on every call — no TTL/cache guard exists
  // anywhere around the introspectManagedToken call (contrast with loadJwks, which does cache).
  assert.match(fn, /const rawToken = m\[1\];/);
  assert.match(fn, /managedState = await introspectManagedToken\(rawToken\);/);
  assert.doesNotMatch(fn, /introspectCache|introspectAt|introspectTtl|introspectionAt/i);
  // Outage/error must fail closed as a generic 401 and must never place the raw token in the
  // thrown message (no leaking token material on failure). Matched as one literal block (rather
  // than a wildcard capture) because the thrown object literal has its own nested `{ }`, which
  // would otherwise terminate a lazy capture early.
  assert.match(fn, /\} catch \{\n {4}throw \{ code: 401, msg: 'token introspection unavailable' \};\n {2}\}/);
  // assertManagedTokenActive gates *before* groups are derived, and groups must come from
  // managedState.groups (the live introspection response), never claims.groups (the signed token).
  const activeGateIdx = fn.indexOf('assertManagedTokenActive(claims, managedState);');
  const groupsIdx = fn.indexOf('const groups = (managedState.groups');
  assert.ok(activeGateIdx >= 0 && groupsIdx > activeGateIdx, 'assertManagedTokenActive must run before groups are derived');
  assert.match(fn, /const groups = \(managedState\.groups \|\| \[\]\)\.map\(\(g\) => String\(g\)\.replace\(\/\^\\\/\/, ''\)\.replace\(\/@\.\*\$\/, ''\)\);/);
  assert.doesNotMatch(fn, /claims\.groups/);
  // Signature verification and assertClaims (strict claim validation) must both run before the live
  // introspection call, so an unsigned/expired/malformed token is rejected without ever touching the
  // network.
  const sigIdx = fn.indexOf("if (!ok) throw { code: 401, msg: 'bad signature' };");
  const claimsIdx = fn.indexOf('assertClaims(header, claims);');
  const introspectCallIdx = fn.indexOf('managedState = await introspectManagedToken(rawToken);');
  assert.ok(sigIdx >= 0 && claimsIdx > sigIdx, 'signature check must run before assertClaims');
  assert.ok(claimsIdx >= 0 && introspectCallIdx > claimsIdx, 'assertClaims must run before live introspection');
});

test('assertClaims requires iss/azp-or-aud/exp/sub/iat, validates nbf with a 30s skew, and only accepts typ undefined/browser/pat/cli_session', () => {
  const { fns } = loadGatewayFunctions(
    ['assertClaims'],
    { KANIDM_ISSUERS: ['https://issuer.example/opensphere-console'], KANIDM_AZP: 'opensphere-console' },
  );
  const nowMs = 1_000_000_000_000;
  const baseClaims = () => ({
    iss: 'https://issuer.example/opensphere-console',
    azp: 'opensphere-console',
    exp: Math.floor(nowMs / 1000) + 300,
    sub: 'user-1',
    iat: Math.floor(nowMs / 1000) - 5,
  });
  const header = { alg: 'ES256' };

  // Happy path for every supported typ.
  for (const typ of [undefined, 'browser', 'pat', 'cli_session']) {
    const claims = { ...baseClaims(), typ };
    assert.doesNotThrow(() => fns.assertClaims(header, claims, nowMs));
  }

  // Unsupported typ is rejected.
  assert.throws(
    () => fns.assertClaims(header, { ...baseClaims(), typ: 'refresh' }, nowMs),
    (err) => { assert.equal(err.code, 401); return true; },
  );

  // Required claims: iss, azp/aud, exp, sub, iat. Thrown values are plain {code,msg} objects (not
  // Error instances), so a predicate is used instead of a RegExp (assert.throws stringifies a
  // non-Error thrown value to "[object Object]" before testing a RegExp against it).
  for (const missing of ['iss', 'exp', 'sub', 'iat']) {
    const claims = baseClaims();
    delete claims[missing];
    assert.throws(
      () => fns.assertClaims(header, claims, nowMs),
      (err) => { assert.equal(err.code, 401); assert.match(err.msg, /missing|bad iss/); return true; },
    );
  }
  {
    const claims = baseClaims();
    delete claims.azp;
    assert.throws(() => fns.assertClaims(header, claims, nowMs), (err) => { assert.equal(err.msg, 'bad azp/aud'); return true; });
    // aud alone (array form) satisfies the azp-or-aud requirement.
    assert.doesNotThrow(() => fns.assertClaims(header, { ...claims, aud: ['opensphere-console'] }, nowMs));
  }

  // exp in the past is rejected regardless of typ.
  assert.throws(() => fns.assertClaims(header, { ...baseClaims(), exp: Math.floor(nowMs / 1000) - 1 }, nowMs), (err) => { assert.equal(err.msg, 'token expired'); return true; });

  // nbf: within the 30s skew passes; beyond it fails.
  assert.doesNotThrow(() => fns.assertClaims(header, { ...baseClaims(), nbf: Math.floor((nowMs + 29_000) / 1000) }, nowMs));
  assert.throws(() => fns.assertClaims(header, { ...baseClaims(), nbf: Math.floor((nowMs + 40_000) / 1000) }, nowMs), (err) => { assert.equal(err.msg, 'token not yet valid'); return true; });

  // Wrong alg is rejected even with otherwise-valid claims.
  assert.throws(() => fns.assertClaims({ alg: 'HS256' }, baseClaims(), nowMs), (err) => { assert.equal(err.msg, 'unexpected alg'); return true; });
});

test('assertManagedTokenActive requires state.active === true and matching sub/username/exp; browser requires state.type browser_session; PAT/CLI require matching jti; cli_session additionally requires matching device_id', () => {
  const { fns } = loadGatewayFunctions(['assertManagedTokenActive']);
  const browserClaims = { sub: 'u1', preferred_username: 'alice', exp: 111 };
  const patClaims = { sub: 'u1', preferred_username: 'alice', exp: 111, typ: 'pat', jti: 'jti-1' };
  const cliClaims = { sub: 'u1', preferred_username: 'alice', exp: 111, typ: 'cli_session', jti: 'jti-2', device_id: 'dev-1' };

  // Revoked/inactive credential (or a wholly missing state, e.g. introspection failure) is rejected.
  assert.throws(() => fns.assertManagedTokenActive(browserClaims, null), (err) => { assert.equal(err.code, 401); return true; });
  assert.throws(() => fns.assertManagedTokenActive(browserClaims, { active: false, sub: 'u1', username: 'alice', exp: 111, type: 'browser_session' }));

  // sub/username/exp must all match the live state, individually.
  assert.throws(() => fns.assertManagedTokenActive(browserClaims, { active: true, sub: 'someone-else', username: 'alice', exp: 111, type: 'browser_session' }));
  assert.throws(() => fns.assertManagedTokenActive(browserClaims, { active: true, sub: 'u1', username: 'bob', exp: 111, type: 'browser_session' }));
  assert.throws(() => fns.assertManagedTokenActive(browserClaims, { active: true, sub: 'u1', username: 'alice', exp: 999, type: 'browser_session' }));

  // Browser session requires state.type === 'browser_session' and never checks jti/device_id.
  assert.doesNotThrow(() => fns.assertManagedTokenActive(browserClaims, { active: true, sub: 'u1', username: 'alice', exp: 111, type: 'browser_session' }));
  assert.throws(() => fns.assertManagedTokenActive(browserClaims, { active: true, sub: 'u1', username: 'alice', exp: 111, type: 'pat' }));
  assert.doesNotThrow(() => fns.assertManagedTokenActive({ ...browserClaims, typ: 'browser' }, { active: true, sub: 'u1', username: 'alice', exp: 111, type: 'browser_session' }));

  // PAT requires a matching jti.
  assert.doesNotThrow(() => fns.assertManagedTokenActive(patClaims, { active: true, sub: 'u1', username: 'alice', exp: 111, jti: 'jti-1' }));
  assert.throws(() => fns.assertManagedTokenActive(patClaims, { active: true, sub: 'u1', username: 'alice', exp: 111, jti: 'jti-other' }));
  assert.throws(() => fns.assertManagedTokenActive({ ...patClaims, jti: undefined }, { active: true, sub: 'u1', username: 'alice', exp: 111, jti: 'jti-1' }));

  // CLI session requires a matching jti AND a matching device_id.
  assert.doesNotThrow(() => fns.assertManagedTokenActive(cliClaims, { active: true, sub: 'u1', username: 'alice', exp: 111, jti: 'jti-2', deviceId: 'dev-1' }));
  assert.throws(() => fns.assertManagedTokenActive(cliClaims, { active: true, sub: 'u1', username: 'alice', exp: 111, jti: 'jti-2', deviceId: 'dev-other' }));
  assert.throws(() => fns.assertManagedTokenActive({ ...cliClaims, device_id: undefined }, { active: true, sub: 'u1', username: 'alice', exp: 111, jti: 'jti-2', deviceId: 'dev-1' }));
});

test('introspectManagedToken is a bounded https.request (not fetch) against TOKEN_INTROSPECTION_URL: installation CA + correct SNI, form-urlencoded token body, 3s timeout, 64KiB response cap, and requires HTTP 200 JSON', () => {
  const fn = extractFunctionSource(gateway, 'introspectManagedToken');
  assert.match(fn, /const u = new URL\(TOKEN_INTROSPECTION_URL\);/);
  assert.match(fn, /const body = Buffer\.from\(new URLSearchParams\(\{ token: jwt \}\)\.toString\(\)\);/);
  assert.match(fn, /method: 'POST',/);
  assert.match(fn, /ca: jwksCa\(\),/);
  assert.match(fn, /servername: TOKEN_INTROSPECTION_SERVERNAME,/);
  assert.match(fn, /'content-type': 'application\/x-www-form-urlencoded',/);
  assert.match(fn, /rq\.setTimeout\(3000, \(\) => rq\.destroy\(new Error\('token introspection timeout'\)\)\);/);
  assert.match(fn, /if \(size > 64 \* 1024\) return reject\(new Error\('token introspection response too large'\)\);/);
  assert.match(fn, /if \(size <= 64 \* 1024\) chunks\.push\(chunk\);/);
  assert.match(fn, /if \(resp\.statusCode !== 200\) return reject\(new Error\(`token introspection HTTP \$\{resp\.statusCode\}`\)\);/);
  assert.match(fn, /catch \{ reject\(new Error\('token introspection returned invalid JSON'\)\); \}/);
  assert.doesNotMatch(gateway.slice(gateway.indexOf('function introspectManagedToken'), gateway.indexOf('function introspectManagedToken') + fn.length + 40), /fetch\(/);
});

test('Base manifest wires both TOKEN_INTROSPECTION_URL and TOKEN_INTROSPECTION_SERVERNAME into the OAA-Gateway Deployment env, alongside the existing kanidm-ca mount it reuses', () => {
  assert.match(oaaManifest, /name: TOKEN_INTROSPECTION_URL, value: https:\/\/opensphere-console-auth\.opensphere-console\.svc:8443\/bff\/token\/introspect/);
  assert.match(oaaManifest, /name: TOKEN_INTROSPECTION_SERVERNAME, value: kanidm\.opensphere-console-auth\.svc/);
  assert.match(oaaManifest, /name: kanidm-ca, mountPath: \/etc\/kanidm-ca, readOnly: true/);
  assert.match(oaaManifest, /secretName: opensphere-console-auth-ca/);
});
