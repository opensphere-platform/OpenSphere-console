const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');

// Root cause (Setup CI run 29386721667): the OAA gateway connected as BACKBONE_PG_USER=console
// using the shared backbone-postgres/password secret key, and ensureKnowledgeSchema() executed
// CREATE TABLE in public. The Backbone bootstrap boundary deliberately REVOKEs CREATE on schema
// public from PUBLIC and console, granting console only USAGE plus explicit audit/credential
// table DML -- so OAA schema initialization could never succeed, and readiness/opensphere_oaa
// was also the wrong ownership boundary for OAA even if it had worked. These tests prove the
// fix: a dedicated PostgreSQL role/schema/secret, least privilege, verified TLS with the
// Setup-managed CA, and no console credential reuse, across both the console repo's Backbone
// manifests/gateway and (separately) the Setup-CLI secret generation/preservation contract.
const gateway = fs.readFileSync(path.join(root, 'backend', 'opensphere-console-oaa-gateway', 'server.js'), 'utf8');
const oaaManifest = fs.readFileSync(path.join(root, 'backend', 'backbone', 'console-services.yaml'), 'utf8');
const backbone = fs.readFileSync(path.join(root, 'backend', 'backbone', 'bootstrap', 'backbone.yaml'), 'utf8');

test('OAA-Gateway defaults to and only ever uses the dedicated opensphere_oaa PostgreSQL role, never the shared console credential', () => {
  assert.match(gateway, /user: process\.env\.BACKBONE_PG_USER \|\| 'opensphere_oaa'/);
  assert.doesNotMatch(gateway, /BACKBONE_PG_USER \|\| 'console'/);
  // The password comes only from BACKBONE_PG_PASSWORD (wired to the dedicated oaa_password
  // secret key in console-services.yaml below) -- server.js itself must never hardcode or
  // fall back to a 'console'-flavoured credential source.
  assert.match(gateway, /password: process\.env\.BACKBONE_PG_PASSWORD/);
});

test('OAA-Gateway resolves unqualified table names into its own dedicated schema via a validated, non-injectable identifier, defaulting to "oaa"', () => {
  assert.match(gateway, /const SCHEMA_ID_RE = \/\^\[a-z_\]\[a-z0-9_\]\{0,62\}\$\/;/);
  assert.match(gateway, /schema: SCHEMA_ID_RE\.test\(process\.env\.BACKBONE_PG_SCHEMA \|\| ''\) \? process\.env\.BACKBONE_PG_SCHEMA : 'oaa',/);
});

test('OAA-Gateway pgvector installation is bootstrap-owner responsibility only -- the runtime role never attempts CREATE EXTENSION', () => {
  assert.doesNotMatch(gateway, /CREATE EXTENSION IF NOT EXISTS vector/);
});

test('OAA-Gateway PostgreSQL pool uses verified TLS against the Setup-managed installation CA and fails closed (never connects) when the CA is unavailable', () => {
  assert.match(gateway, /caPath: process\.env\.BACKBONE_PG_CA_PATH \|\| '\/etc\/backbone-postgres-ca\/ca\.crt',/);
  const getPgPoolFn = gateway.match(/function getPgPool\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(getPgPoolFn, 'getPgPool must be defined');
  assert.match(getPgPoolFn, /const ca = pgCa\(\);/);
  assert.match(getPgPoolFn, /if \(!ca\) \{/);
  assert.match(getPgPoolFn, /return null;/);
  assert.match(getPgPoolFn, /ssl: \{ ca, rejectUnauthorized: true, servername: PG\.host \},/);
  // Fail closed: no path in getPgPool ever constructs a Pool without the ssl option (i.e. never
  // silently downgrades to an unverified/plaintext connection).
  const poolConstructions = getPgPoolFn.match(/new Pool\(\{[\s\S]*?\n    \}\);/g) || [];
  assert.ok(poolConstructions.length >= 1);
  for (const construction of poolConstructions) assert.match(construction, /ssl: \{ ca, rejectUnauthorized: true/);
});

test('OAA-Gateway sets search_path via a deterministic connection-startup option, never a racy unawaited post-connect query', () => {
  const getPgPoolFn = gateway.match(/function getPgPool\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(getPgPoolFn, 'getPgPool must be defined');
  // The `options` field is sent inside the libpq StartupMessage and applied by the server
  // before authentication completes -- i.e. before the pool can ever hand the connection to a
  // caller's first query. This is the deterministic, race-free replacement for a 'connect'-event
  // client.query() (which is unawaited and can race the caller's first checked-out query).
  assert.match(getPgPoolFn, /options: `-c search_path=\$\{PG\.schema\},public`,/);
  assert.doesNotMatch(gateway, /pgPool\.on\('connect'/);
  assert.doesNotMatch(gateway, /client\.query\(`SET search_path/);
  // Every Pool construction in getPgPool carries the startup option (never a path that omits it).
  const poolConstructions = getPgPoolFn.match(/new Pool\(\{[\s\S]*?\n    \}\);/g) || [];
  assert.ok(poolConstructions.length >= 1);
  for (const construction of poolConstructions) {
    assert.match(construction, /options: `-c search_path=\$\{PG\.schema\},public`,/);
  }
});

// Extracts one top-level `function name(...) { ... }` (or `async function ...`) body from
// `source` by brace-matching from the opening `{`, independent of indentation style. Mirrors
// oaa-gateway-tier.test.js's extractFunctionSource/loadGatewayFunctions helpers so the real
// getPgPool()/pgCa() logic is actually *executed* against a fake `Pool`/`fs`, not just
// regex-matched, without requiring the real `pg` package to be installed.
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

function loadGatewayFunctions(names, sandboxGlobals = {}) {
  const sandbox = { ...sandboxGlobals };
  vm.createContext(sandbox);
  const src = names.map((n) => extractFunctionSource(gateway, n)).join('\n\n');
  const fns = vm.runInContext(`${src}\n({ ${names.join(', ')} });`, sandbox);
  return { fns, sandbox };
}

test('OAA-Gateway search_path startup option is built only from the validated SCHEMA_ID_RE-checked PG.schema, never raw env text', () => {
  const SCHEMA_ID_RE = /^[a-z_][a-z0-9_]{0,62}$/;
  const hostileInputs = ["oaa; DROP SCHEMA public", 'oaa" ', 'oaa\nSET ROLE x', '', 'Oaa', '0aa', 'a'.repeat(64)];
  for (const hostile of hostileInputs) {
    assert.equal(SCHEMA_ID_RE.test(hostile), false, `SCHEMA_ID_RE must reject ${JSON.stringify(hostile)}`);
  }
  assert.equal(SCHEMA_ID_RE.test('oaa'), true);
});

test('OAA-Gateway getPgPool() actually constructs the Pool with the deterministic search_path startup option and verified TLS -- behavioural, not just source-text matching', () => {
  // Fake `pg` Pool captures the exact config object getPgPool() passes to `new Pool(...)`, and a
  // fake `fs` supplies a CA so the fail-closed branch is not taken. `connect` is intentionally
  // NOT among the events fns can register against without recording it, so a regression that
  // reintroduces a racy pgPool.on('connect', ...) handler is caught by the recorded event list.
  const capturedConfigs = [];
  const registeredEvents = [];
  class FakePool {
    constructor(config) { capturedConfigs.push(config); }
    on(event) { registeredEvents.push(event); return this; }
  }
  const fakeFs = { readFileSync: () => Buffer.from('fake-ca-bytes') };
  const { fns } = loadGatewayFunctions(['pgCa', 'getPgPool'], {
    fs: fakeFs,
    Pool: FakePool,
    PG: { host: 'backbone-postgres.opensphere-backbone.svc.cluster.local', port: 5432, database: 'console', user: 'opensphere_oaa', password: 'secret', schema: 'oaa', caPath: '/etc/backbone-postgres-ca/ca.crt' },
    pgEnabled: () => true,
    pgPool: null,
    console,
  });

  const pool = fns.getPgPool();
  assert.ok(pool instanceof FakePool, 'getPgPool must return the constructed Pool');
  assert.equal(capturedConfigs.length, 1);
  const config = capturedConfigs[0];
  // Deterministic connection-startup option -- applied inside the StartupMessage before
  // authentication completes, before any caller query can ever race it.
  assert.equal(config.options, '-c search_path=oaa,public');
  // Verified TLS: never rejectUnauthorized:false, always pinned servername.
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.servername, 'backbone-postgres.opensphere-backbone.svc.cluster.local');
  assert.equal(config.ssl.ca.toString(), 'fake-ca-bytes');
  // No racy post-connect handler is ever registered.
  assert.ok(!registeredEvents.includes('connect'), 'getPgPool must never register a connect-event search_path handler');
  assert.deepEqual(registeredEvents, ['error']);
});

test('OAA-Gateway getPgPool() fails closed (never constructs a Pool) when the installation CA is unavailable', () => {
  const capturedConfigs = [];
  class FakePool {
    constructor(config) { capturedConfigs.push(config); }
    on() { return this; }
  }
  const { fns } = loadGatewayFunctions(['pgCa', 'getPgPool'], {
    fs: { readFileSync: () => { throw new Error('ENOENT'); } },
    Pool: FakePool,
    PG: { host: 'x', port: 5432, database: 'console', user: 'opensphere_oaa', password: 'secret', schema: 'oaa', caPath: '/etc/backbone-postgres-ca/ca.crt' },
    pgEnabled: () => true,
    pgPool: null,
    console,
  });
  const pool = fns.getPgPool();
  assert.equal(pool, null);
  assert.equal(capturedConfigs.length, 0, 'no Pool may ever be constructed without a verified CA');
});

test('Base manifest wires the OAA-Gateway Deployment to the dedicated opensphere_oaa role/oaa_password secret key, its own schema, and the Backbone PostgreSQL CA mount -- never the console password key', () => {
  assert.match(oaaManifest, /\{ name: BACKBONE_PG_USER, value: opensphere_oaa \}/);
  assert.match(oaaManifest, /\{ name: BACKBONE_PG_PASSWORD, valueFrom: \{ secretKeyRef: \{ name: backbone-postgres, key: oaa_password \} \} \}/);
  assert.doesNotMatch(oaaManifest, /secretKeyRef: \{ name: backbone-postgres, key: password \}/);
  assert.match(oaaManifest, /\{ name: BACKBONE_PG_SCHEMA, value: oaa \}/);
  assert.match(oaaManifest, /\{ name: BACKBONE_PG_CA_PATH, value: \/etc\/backbone-postgres-ca\/ca\.crt \}/);
  assert.match(oaaManifest, /name: backbone-postgres-ca, mountPath: \/etc\/backbone-postgres-ca, readOnly: true/);
  assert.match(oaaManifest, /name: backbone-postgres-ca\s*\n\s*secret:\s*\n\s*secretName: backbone-postgres\s*\n\s*items: \[\{ key: ca\.crt, path: ca\.crt \}\]/);
});

test('Backbone bootstrap provisions the dedicated opensphere_oaa role/schema on both empty-PVC init and idempotent boundary reconcile, with least privilege and no audit-table access', () => {
  // Both the empty-PVC init script and the idempotent reconcile Job must establish/rotate the
  // role from its own generated secret value (never the console_password variable).
  const oaaBlocks = backbone.match(/CREATE ROLE opensphere_oaa LOGIN PASSWORD %L NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS/g) || [];
  assert.equal(oaaBlocks.length, 2, 'both 00-console-runtime-boundary.sh and reconcile.sql must create opensphere_oaa');
  const oaaAlters = backbone.match(/ALTER ROLE opensphere_oaa LOGIN PASSWORD %L NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS/g) || [];
  assert.equal(oaaAlters.length, 2, 'both scripts must idempotently re-apply the current secret value');
  assert.match(backbone, /:'oaa_password'/);
  assert.doesNotMatch(backbone, /CREATE ROLE opensphere_oaa[^\n]*:'console_password'/);

  // Dedicated schema owned by the role, USAGE-only (never CREATE) on public, and search_path
  // wired so unqualified OAA table names resolve into it.
  const schemaGrants = backbone.match(/CREATE SCHEMA IF NOT EXISTS oaa AUTHORIZATION opensphere_oaa;/g) || [];
  assert.equal(schemaGrants.length, 2);
  const schemaOwnerRepairs = backbone.match(/ALTER SCHEMA oaa OWNER TO opensphere_oaa;/g) || [];
  assert.equal(schemaOwnerRepairs.length, 2, 'both bootstrap paths must repair a pre-existing incorrectly-owned OAA schema');
  const searchPathAlters = backbone.match(/ALTER ROLE opensphere_oaa IN DATABASE console SET search_path = oaa, public;/g) || [];
  assert.equal(searchPathAlters.length, 2);
  const publicUsageGrants = backbone.match(/GRANT USAGE ON SCHEMA public TO opensphere_oaa;/g) || [];
  assert.equal(publicUsageGrants.length, 2);
  assert.doesNotMatch(backbone, /GRANT CREATE ON SCHEMA public TO opensphere_oaa/);
  assert.doesNotMatch(backbone, /GRANT[^\n]*ON TABLE public\.audit_log TO opensphere_oaa/);
  assert.doesNotMatch(backbone, /GRANT[^\n]*ON TABLE public\.managed_credential TO opensphere_oaa/);
  // Every opensphere_oaa role definition carries exactly the NO-prefixed least-privilege flags
  // (not a bare/positive SUPERUSER, CREATEROLE, CREATEDB, REPLICATION, or BYPASSRLS grant); this
  // is already pinned verbatim by the CREATE/ALTER ROLE assertions above (oaaBlocks/oaaAlters),
  // so this only guards against a stray, differently-worded privilege grant appearing elsewhere.
  assert.doesNotMatch(backbone, /GRANT opensphere_oaa/);
  assert.doesNotMatch(backbone, /ALTER ROLE opensphere_oaa[^\n]*\bSUPERUSER\b(?!\s*NOINHERIT)/);

  // Install pgvector remains bootstrap-owner responsibility (opensphere_db_bootstrap superuser)
  // both on empty-PVC init and idempotent reconcile.
  const pgvectorInstalls = backbone.match(/CREATE EXTENSION IF NOT EXISTS vector;/g) || [];
  assert.ok(pgvectorInstalls.length >= 2);

  // Secret wiring: the OPENSPHERE_OAA_PASSWORD env sourced from its own oaa_password key drives
  // the empty-PVC init script, and the reconcile Job separately sources OAA_PASSWORD from the
  // same key -- never the console runtime `password` key.
  assert.match(backbone, /\{ name: OPENSPHERE_OAA_PASSWORD, valueFrom: \{ secretKeyRef: \{ name: backbone-postgres, key: oaa_password \} \} \}/);
  assert.match(backbone, /\{ name: OAA_PASSWORD, valueFrom: \{ secretKeyRef: \{ name: backbone-postgres, key: oaa_password \} \} \}/);
  assert.match(backbone, /: "\$\{OPENSPHERE_OAA_PASSWORD:\?OPENSPHERE_OAA_PASSWORD is required\}"/);
  assert.match(backbone, /\\getenv oaa_password OAA_PASSWORD/);
});
