import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultManifestPath = join(repositoryRoot, 'migrations', 'manifest.json');
const globalIdPattern = /^opensphere-console\/[0-9]{8}\/[0-9]{4}$/;
const semanticKeyPattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const shaPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const setDigestPattern = /^sha256:[a-f0-9]{64}$/;

function canonicalText(value) {
  return value.replace(/\r\n?/g, '\n');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function closedKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(label + ' has unknown fields: ' + unknown.join(', '));
}

function migrationRecord(entry) {
  return [
    entry.globalId,
    entry.semanticKey,
    entry.predecessorGlobalId || '',
    entry.path,
    entry.sha256,
    entry.sourceRevision,
  ].join('|') + '\n';
}

function migrationSetDigest(entries) {
  return 'sha256:' + sha256(entries.map(migrationRecord).join(''));
}

function migrationSqlFiles(root) {
  const output = [];
  for (const directory of ['baseline', 'versions']) {
    const absolute = join(root, 'migrations', directory);
    let files;
    try {
      files = readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files) {
      if (file.isFile() && file.name.endsWith('.sql')) {
        output.push(relative(root, join(absolute, file.name)).split(sep).join('/'));
      }
    }
  }
  return output.sort();
}

function gitFileAtRevision(root, revision, path) {
  const result = spawnSync('git', ['-C', root, 'show', `${revision}:${path}`], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`source revision ${revision} does not contain ${path}`);
  return result.stdout;
}

export function verifyMigrationManifest({
  root = repositoryRoot,
  manifestPath = defaultManifestPath,
  verifySourceRevision = true,
} = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  closedKeys(manifest, ['schemaVersion', 'repository', 'latestGlobalId', 'migrationCount', 'setDigest', 'migrations'], 'manifest');
  if (manifest.schemaVersion !== 1 || manifest.repository !== 'OpenSphere-Console') throw new Error('migration manifest identity is invalid');
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length < 1
      || manifest.migrationCount !== manifest.migrations.length) throw new Error('migration manifest count is invalid');

  const seenIds = new Set();
  const seenKeys = new Set();
  const expectedFiles = [];
  let predecessor = null;
  for (const [index, entry] of manifest.migrations.entries()) {
    closedKeys(entry, [
      'globalId', 'semanticKey', 'predecessorGlobalId', 'path', 'sha256', 'sourceRevision', 'setDigest', 'setSize',
    ], `migration[${index}]`);
    if (!globalIdPattern.test(entry.globalId) || seenIds.has(entry.globalId)) throw new Error(`migration[${index}] globalId is invalid or duplicated`);
    if (!semanticKeyPattern.test(entry.semanticKey) || seenKeys.has(entry.semanticKey)) throw new Error(`migration[${index}] semanticKey is invalid or duplicated`);
    if (entry.predecessorGlobalId !== predecessor) throw new Error(`migration[${index}] predecessor is not the prior globalId`);
    if (!/^migrations\/(baseline|versions)\/[a-z0-9][a-z0-9_.-]*\.sql$/.test(entry.path)) throw new Error(`migration[${index}] path is invalid`);
    if (!shaPattern.test(entry.sha256) || !revisionPattern.test(entry.sourceRevision)) throw new Error(`migration[${index}] digest or source revision is invalid`);
    const absolute = resolve(root, entry.path);
    if (!absolute.startsWith(resolve(root, 'migrations') + sep)) throw new Error(`migration[${index}] escapes the migration root`);
    const sql = canonicalText(readFileSync(absolute, 'utf8'));
    if (/^\s*\\/m.test(sql)) throw new Error(`migration[${index}] contains a psql meta-command`);
    if (sha256(sql) !== entry.sha256) throw new Error(`migration[${index}] file digest mismatch`);
    if (verifySourceRevision && sha256(canonicalText(gitFileAtRevision(root, entry.sourceRevision, entry.path))) !== entry.sha256) {
      throw new Error(`migration[${index}] source revision digest mismatch`);
    }
    const prefix = manifest.migrations.slice(0, index + 1);
    const prefixDigest = migrationSetDigest(prefix);
    if (entry.setDigest !== prefixDigest || entry.setSize !== index + 1) throw new Error(`migration[${index}] set lineage is invalid`);
    seenIds.add(entry.globalId);
    seenKeys.add(entry.semanticKey);
    expectedFiles.push(entry.path);
    predecessor = entry.globalId;
  }

  if (manifest.latestGlobalId !== predecessor) throw new Error('latestGlobalId is not the final migration');
  if (manifest.setDigest !== migrationSetDigest(manifest.migrations)) throw new Error('migration set digest mismatch');
  const files = migrationSqlFiles(root);
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles.slice().sort())) throw new Error('migration SQL inventory differs from the manifest');
  return Object.freeze(manifest);
}

function psqlEnvironment(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('CONSOLE_MIGRATION_DATABASE_URL must be an absolute PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.hash) {
    throw new Error('CONSOLE_MIGRATION_DATABASE_URL is invalid');
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || database.includes('/')) throw new Error('CONSOLE_MIGRATION_DATABASE_URL must select one database');
  const allowedQuery = new Set(['sslmode']);
  for (const key of url.searchParams.keys()) if (!allowedQuery.has(key)) throw new Error(`unsupported PostgreSQL URL option: ${key}`);
  const environment = { ...process.env };
  delete environment.CONSOLE_MIGRATION_DATABASE_URL;
  Object.assign(environment, {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: database,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGAPPNAME: 'opensphere-console-migrations',
  });
  if (url.searchParams.has('sslmode')) environment.PGSSLMODE = url.searchParams.get('sslmode');
  return environment;
}

function runPsql(environment, args, input) {
  const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', ...args], {
    env: environment, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, input,
  });
  if (result.error) throw new Error('psql could not start: ' + result.error.message);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'psql failed').trim());
  return result.stdout.trim();
}

function readAppliedMigrations(environment) {
  const exists = runPsql(environment, ['-At', '-c', "SELECT to_regclass('console_migration.applied_migration') IS NOT NULL"]);
  if (exists === 'f') return [];
  if (exists !== 't') throw new Error('migration ledger existence check returned an invalid value');
  const rows = runPsql(environment, ['-At', '-F', '|', '-c', [
    'SELECT global_id, semantic_key, COALESCE(predecessor_global_id, \'\'), file_sha256, source_revision,',
    'migration_set_digest, migration_set_size::text',
    'FROM console_migration.applied_migration ORDER BY applied_sequence',
  ].join(' ')]);
  return rows ? rows.split(/\r?\n/).map((row) => row.split('|')) : [];
}

function assertAppliedPrefix(manifest, rows) {
  if (rows.length > manifest.migrations.length) throw new Error('database migration ledger is ahead of the manifest');
  for (const [index, row] of rows.entries()) {
    const entry = manifest.migrations[index];
    const expected = [
      entry.globalId, entry.semanticKey, entry.predecessorGlobalId || '', entry.sha256,
      entry.sourceRevision, entry.setDigest, String(entry.setSize),
    ];
    if (JSON.stringify(row) !== JSON.stringify(expected)) throw new Error(`database migration ledger mismatch at ${entry.globalId}`);
  }
}

function sqlLiteral(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

export function migrationTransactionSql(root, entry) {
  const sql = canonicalText(readFileSync(resolve(root, entry.path), 'utf8'));
  return sql + [
    '',
    'INSERT INTO console_migration.applied_migration(',
    '  global_id, semantic_key, predecessor_global_id, file_sha256, source_revision, migration_set_digest, migration_set_size',
    ') VALUES (',
    `  ${sqlLiteral(entry.globalId)}, ${sqlLiteral(entry.semanticKey)}, ${entry.predecessorGlobalId ? sqlLiteral(entry.predecessorGlobalId) : 'NULL'},`,
    `  ${sqlLiteral(entry.sha256)}, ${sqlLiteral(entry.sourceRevision)}, ${sqlLiteral(entry.setDigest)}, ${entry.setSize}`,
    ');',
    '',
  ].join('\n');
}

export function renderMigration({ root = repositoryRoot, manifestPath = defaultManifestPath, globalId, verifySourceRevision = true } = {}) {
  const manifest = verifyMigrationManifest({ root, manifestPath, verifySourceRevision });
  if (!globalIdPattern.test(String(globalId || ''))) throw new Error('render globalId is invalid');
  const entry = manifest.migrations.find((migration) => migration.globalId === globalId);
  if (!entry) throw new Error('render globalId is absent from the verified manifest');
  return migrationTransactionSql(root, entry);
}

export function applyMigrations({ root = repositoryRoot, manifestPath = defaultManifestPath, databaseUrl } = {}) {
  const manifest = verifyMigrationManifest({ root, manifestPath });
  const environment = psqlEnvironment(databaseUrl || process.env.CONSOLE_MIGRATION_DATABASE_URL || '');
  let rows = readAppliedMigrations(environment);
  assertAppliedPrefix(manifest, rows);
  let applied = 0;
  for (const entry of manifest.migrations.slice(rows.length)) {
    runPsql(environment, ['--single-transaction'], migrationTransactionSql(root, entry));
    applied += 1;
    rows = readAppliedMigrations(environment);
    assertAppliedPrefix(manifest, rows);
  }
  return Object.freeze({ status: 'passed', applied, migrationCount: rows.length, latestGlobalId: manifest.latestGlobalId, setDigest: manifest.setDigest });
}

function main() {
  const mode = process.argv[2];
  if (mode === 'verify') {
    const materializedRelease = process.argv[3] === '--verified-materialized-release';
    if (process.argv.length !== (materializedRelease ? 4 : 3)) throw new Error('verify accepts only --verified-materialized-release');
    const manifest = verifyMigrationManifest({ verifySourceRevision: !materializedRelease });
    process.stdout.write(JSON.stringify({ status: 'passed', migrationCount: manifest.migrationCount, latestGlobalId: manifest.latestGlobalId, setDigest: manifest.setDigest }, null, 2) + '\n');
    return;
  }
  if (mode === 'apply') {
    process.stdout.write(JSON.stringify(applyMigrations(), null, 2) + '\n');
    return;
  }
  if (mode === 'render') {
    const materializedRelease = process.argv[4] === '--verified-materialized-release';
    if (process.argv.length !== (materializedRelease ? 5 : 4)) throw new Error('render requires one globalId and optional --verified-materialized-release');
    process.stdout.write(renderMigration({ globalId: process.argv[3], verifySourceRevision: !materializedRelease }));
    return;
  }
  throw new Error('usage: node scripts/console-migrations.mjs <verify [--verified-materialized-release]|apply|render globalId [--verified-materialized-release]>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Console migration failure: ${error.message}\n`);
    process.exitCode = 1;
  }
}
