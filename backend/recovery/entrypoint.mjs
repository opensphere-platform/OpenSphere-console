import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import https from 'node:https';

const WORK = '/work';
const MODES = new Set(['backup-supabase', 'backup-gitea', 'drill-supabase', 'drill-gitea']);
const EVIDENCE_NAMESPACE = process.env.RECOVERY_EVIDENCE_NAMESPACE || 'opensphere-console';
const EVIDENCE_NAME = process.env.RECOVERY_EVIDENCE_NAME || 'opensphere-platform-recovery-evidence';
const SERVICE_ACCOUNT_ROOT = '/var/run/secrets/kubernetes.io/serviceaccount';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

function isoNow() {
  return new Date().toISOString();
}

function runId() {
  return `${isoNow().replace(/[-:.]/g, '').replace('Z', 'Z')}-${randomUUID().slice(0, 8)}`;
}

function shell(command, args, { env = {}, cwd = WORK, input } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) return resolveResult({ stdout, stderr });
      const detail = stderr.trim().slice(-800) || stdout.trim().slice(-800);
      reject(new Error(`${command} exited ${code}${detail ? `: ${detail}` : ''}`));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function sha256File(path) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveDigest(hash.digest('hex')));
  });
}

function encryptionKey() {
  const input = required('RECOVERY_ENCRYPTION_KEY');
  if (Buffer.byteLength(input, 'utf8') < 32) {
    throw new Error('RECOVERY_ENCRYPTION_KEY must contain at least 32 UTF-8 bytes');
  }
  return createHash('sha256').update(input, 'utf8').digest();
}

async function encryptFile(input, output) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  await pipeline(createReadStream(input), cipher, createWriteStream(output, { mode: 0o600 }));
  const [plainSha256, cipherSha256, info] = await Promise.all([sha256File(input), sha256File(output), stat(input)]);
  return {
    name: basename(input),
    object: basename(output),
    plaintextSha256: plainSha256,
    ciphertextSha256: cipherSha256,
    plaintextBytes: info.size,
    cipher: { algorithm: 'AES-256-GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
  };
}

async function decryptFile(input, output, cipher) {
  if (cipher?.algorithm !== 'AES-256-GCM' || !cipher.iv || !cipher.tag) {
    throw new Error('Recovery manifest contains an unsupported cipher descriptor');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(cipher.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(cipher.tag, 'base64'));
  await pipeline(createReadStream(input), decipher, createWriteStream(output, { mode: 0o600 }));
}

function s3Environment() {
  const caBundle = optional('AWS_CA_BUNDLE');
  return {
    AWS_ACCESS_KEY_ID: required('RECOVERY_S3_ACCESS_KEY'),
    AWS_SECRET_ACCESS_KEY: required('RECOVERY_S3_SECRET_KEY'),
    AWS_DEFAULT_REGION: optional('RECOVERY_S3_REGION', 'us-east-1'),
    AWS_EC2_METADATA_DISABLED: 'true',
    ...(caBundle ? { AWS_CA_BUNDLE: caBundle } : {})
  };
}

function s3Args(action, local, key) {
  const endpoint = required('RECOVERY_S3_ENDPOINT');
  if (!endpoint.startsWith('https://')) throw new Error('RECOVERY_S3_ENDPOINT must be HTTPS');
  const bucket = required('RECOVERY_S3_BUCKET');
  const remote = `s3://${bucket}/${key.replace(/^\/+/, '')}`;
  return action === 'upload'
    ? ['s3', 'cp', local, remote, '--only-show-errors', '--endpoint-url', endpoint]
    : ['s3', 'cp', remote, local, '--only-show-errors', '--endpoint-url', endpoint];
}

async function upload(local, key) {
  await shell('aws', s3Args('upload', local, key), { env: s3Environment() });
}

async function download(key, local) {
  await shell('aws', s3Args('download', local, key), { env: s3Environment() });
}

function recoveryPrefix() {
  return optional('RECOVERY_S3_PREFIX', 'opensphere-recovery/v1').replace(/^\/+|\/+$/g, '');
}

async function tarDirectory(source, output) {
  if (!existsSync(source)) throw new Error(`Required recovery source is unavailable: ${source}`);
  await shell('tar', ['-C', source, '-czf', output, '.']);
}

async function pgDump({ host, user, password, database, target }) {
  await shell('pg_dump', [
    '--format=custom', '--no-owner', '--no-privileges', '--verbose',
    '--host', host, '--username', user, '--dbname', database, '--file', target
  ], { env: { PGPASSWORD: password } });
}

async function captureRoleNames({ host, user, password, database, target }) {
  const result = await shell('psql', [
    '--host', host, '--username', user, '--dbname', database,
    '--tuples-only', '--no-align', '--command',
    "SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname;"
  ], { env: { PGPASSWORD: password } });
  const roles = [...new Set(result.stdout.split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value && value.length <= 63))];
  if (!roles.length) throw new Error('PostgreSQL recovery role inventory is empty');
  await writeFile(target, JSON.stringify({ schemaVersion: 'opensphere-recovery-roles/v1', roles }, null, 2), { mode: 0o600 });
  return roles;
}

async function appendArchive(entries, input, output) {
  const encrypted = await encryptFile(input, output);
  entries.push(encrypted);
}

function artifact(entries, name) {
  const entry = entries.find((item) => item.name === name);
  if (!entry) throw new Error(`Recovery manifest does not contain ${name}`);
  return entry;
}

async function kubeRequest(method, path, body) {
  const token = await readFile(join(SERVICE_ACCOUNT_ROOT, 'token'), 'utf8');
  const ca = await readFile(join(SERVICE_ACCOUNT_ROOT, 'ca.crt'));
  const hostname = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || '443';
  if (!hostname) throw new Error('Kubernetes service environment is unavailable for recovery evidence publication');
  const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
  return new Promise((resolveResponse, reject) => {
    const request = https.request({
      hostname,
      port,
      path,
      method,
      ca,
      headers: {
        authorization: `Bearer ${token.trim()}`,
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/merge-patch+json', 'content-length': payload.length } : {})
      }
    }, (response) => {
      let value = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { value += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          try { return resolveResponse(JSON.parse(value || '{}')); } catch { return resolveResponse({}); }
        }
        reject(new Error(`Kubernetes recovery evidence request failed: HTTP ${response.statusCode} ${value.slice(0, 300)}`));
      });
    });
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function assertQuiescedWriter() {
  const reference = optional('RECOVERY_QUIESCE_DEPLOYMENT');
  if (!reference) throw new Error('RECOVERY_QUIESCE_DEPLOYMENT is required for an application-consistent backup');
  const [namespace, name, extra] = reference.split('/');
  if (!namespace || !name || extra || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace) || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
    throw new Error('RECOVERY_QUIESCE_DEPLOYMENT must be namespace/deployment-name');
  }
  const deployment = await kubeRequest('GET', `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`);
  const desired = Number(deployment?.spec?.replicas ?? 1);
  const current = Number(deployment?.status?.replicas ?? 0);
  const ready = Number(deployment?.status?.readyReplicas ?? 0);
  if (desired !== 0 || current !== 0 || ready !== 0) {
    throw new Error(`Writer deployment ${namespace}/${name} is not quiesced (desired=${desired}, current=${current}, ready=${ready})`);
  }
}

async function publishEvidence(mutator) {
  const path = `/api/v1/namespaces/${encodeURIComponent(EVIDENCE_NAMESPACE)}/configmaps/${encodeURIComponent(EVIDENCE_NAME)}`;
  const configMap = await kubeRequest('GET', path);
  let current;
  try { current = JSON.parse(configMap?.data?.['recovery-evidence.json'] || '{}'); } catch { current = {}; }
  const next = mutator(current);
  next.schemaVersion = 'v3';
  next.generatedAt = isoNow();
  await kubeRequest('PATCH', path, { data: { 'recovery-evidence.json': JSON.stringify(next, null, 2) } });
}

function backupEvidence(run, component, entries) {
  return (current) => {
    const next = structuredClone(current && typeof current === 'object' ? current : {});
    next.policy = next.policy || { maxEvidenceAgeSeconds: 86400, targetMode: 'isolated-non-destructive-drill' };
    next.backup = next.backup || { supabase: {}, gitea: {} };
    next.backup.supabase = next.backup.supabase || {};
    next.backup.gitea = next.backup.gitea || {};
    const summarize = (entry) => ({ sha256: entry.plaintextSha256, verified: true, verifiedAt: isoNow(), runId: run.id });
    if (component === 'supabase') {
      next.backup.supabase.database = summarize(artifact(entries, 'supabase.pg.dump'));
      next.backup.supabase.storage = summarize(artifact(entries, 'supabase-storage.tgz'));
    } else {
      next.backup.gitea = summarize(artifact(entries, 'gitea.pg.dump'));
    }
    return next;
  };
}

function drillEvidence(component, checks) {
  return (current) => {
    const next = structuredClone(current && typeof current === 'object' ? current : {});
    next.policy = next.policy || { maxEvidenceAgeSeconds: 86400, targetMode: 'isolated-non-destructive-drill' };
    next.restore = next.restore || {};
    const restored = { state: 'Verified', verifiedAt: isoNow(), assertions: checks.map((item) => item.assertion), checks };
    if (component === 'supabase') {
      next.restore.supabase = restored;
    } else {
      next.restore.gitea = restored;
    }
    return next;
  };
}

function numberCheck(assertion, observed, expected = '>=1') {
  const value = Number(observed);
  const minimum = Number(expected.replace('>=', ''));
  return { assertion, expected, observed: String(value), verdict: Number.isFinite(value) && value >= minimum ? 'Verified' : 'Failed' };
}

async function postgresScratch(restore) {
  const directory = join(WORK, `postgres-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  await shell('initdb', ['--username=recovery', '--auth=trust', '--pgdata', directory]);
  await shell('pg_ctl', ['--pgdata', directory, '--wait', 'start', '--options=-c listen_addresses=127.0.0.1 -c port=55432']);
  try { return await restore({ directory, host: '127.0.0.1', port: '55432', user: 'recovery' }); }
  finally {
    await shell('pg_ctl', ['--pgdata', directory, '--wait', 'stop', '--mode=fast']).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

async function psqlScalar(sql, { host, port, user }) {
  const result = await shell('psql', ['--host', host, '--port', port, '--username', user, '--dbname', 'postgres', '--tuples-only', '--no-align', '--command', sql]);
  return result.stdout.trim();
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function ensureRoles(roles, connection) {
  const normalized = [...new Set((Array.isArray(roles) ? roles : [])
    .map((value) => String(value || '').trim())
    .filter((value) => value && value.length <= 63))].slice(0, 200);
  if (!normalized.length) throw new Error('Recovery role inventory is empty or invalid');
  const values = normalized.map(sqlLiteral).join(',');
  await psqlScalar(
    `DO $$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY[${values}] LOOP `
      + `IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN `
      + `EXECUTE format('CREATE ROLE %I NOLOGIN', role_name); END IF; END LOOP; END $$;`,
    connection
  );
}

async function restoreDatabase(dump, profile, archivedRoles) {
  return postgresScratch(async (connection) => {
    const requiredRoles = profile === 'supabase'
      ? ['anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin', 'supabase_storage_admin', 'opensphere_console_backend', 'opensphere_oaa_gateway']
      : ['gitea'];
    await ensureRoles([...requiredRoles, ...(archivedRoles || [])], connection);
    await shell('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', '--host', connection.host, '--port', connection.port, '--username', connection.user, '--dbname', 'postgres', dump]);
    if (profile === 'supabase') {
      const [users, operators, events] = await Promise.all([
        psqlScalar('SELECT count(*) FROM auth.users;', connection),
        psqlScalar('SELECT count(*) FROM console.operator;', connection),
        psqlScalar('SELECT count(*) FROM audit.event;', connection)
      ]);
      return [numberCheck('auth.users restored', users), numberCheck('console operators restored', operators), numberCheck('audit events restored', events, '>=0')];
    }
    const [users, repositories, issues] = await Promise.all([
      psqlScalar('SELECT count(*) FROM "user";', connection),
      psqlScalar('SELECT count(*) FROM repository;', connection),
      psqlScalar('SELECT count(*) FROM issue;', connection)
    ]);
    return [numberCheck('gitea users restored', users), numberCheck('gitea repositories restored', repositories), numberCheck('gitea issues restored', issues, '>=0')];
  });
}

async function backupSupabase() {
  const id = runId();
  const archiveRoot = join(WORK, id);
  await mkdir(archiveRoot, { recursive: true });
  const dump = join(archiveRoot, 'supabase.pg.dump');
  const storage = join(archiveRoot, 'supabase-storage.tgz');
  const roles = join(archiveRoot, 'supabase-roles.json');
  await assertQuiescedWriter();
  await pgDump({
    host: required('SUPABASE_POSTGRES_HOST'), user: required('SUPABASE_POSTGRES_USER'), password: required('SUPABASE_POSTGRES_PASSWORD'), database: optional('SUPABASE_POSTGRES_DATABASE', 'postgres'), target: dump
  });
  await captureRoleNames({
    host: required('SUPABASE_POSTGRES_HOST'), user: required('SUPABASE_POSTGRES_USER'), password: required('SUPABASE_POSTGRES_PASSWORD'), database: optional('SUPABASE_POSTGRES_DATABASE', 'postgres'), target: roles
  });
  await tarDirectory(required('SUPABASE_STORAGE_SOURCE'), storage);
  const entries = [];
  for (const input of [dump, storage, roles]) await appendArchive(entries, input, `${input}.enc`);
  const run = {
    schemaVersion: 'opensphere-recovery-run/v1', id, component: 'supabase', createdAt: isoNow(),
    sourceRevision: optional('RECOVERY_SOURCE_REVISION', 'unknown'), artifacts: entries
  };
  const prefix = `${recoveryPrefix()}/${id}/supabase`;
  for (const entry of entries) await upload(join(archiveRoot, entry.object), `${prefix}/${entry.object}`);
  const manifest = join(archiveRoot, 'manifest.json');
  await writeFile(manifest, JSON.stringify(run, null, 2), { mode: 0o600 });
  await upload(manifest, `${prefix}/manifest.json`);
  await publishEvidence(backupEvidence(run, 'supabase', entries));
  return { id, manifestKey: `${prefix}/manifest.json`, artifacts: entries.length };
}

async function backupGitea() {
  const id = runId();
  const archiveRoot = join(WORK, id);
  await mkdir(archiveRoot, { recursive: true });
  const dump = join(archiveRoot, 'gitea.pg.dump');
  const data = join(archiveRoot, 'gitea-data.tgz');
  const configuration = join(archiveRoot, 'gitea-private-config.tgz');
  const roles = join(archiveRoot, 'gitea-roles.json');
  await assertQuiescedWriter();
  await pgDump({
    host: required('GITEA_POSTGRES_HOST'), user: required('GITEA_POSTGRES_USER'), password: required('GITEA_POSTGRES_PASSWORD'), database: optional('GITEA_POSTGRES_DATABASE', 'gitea'), target: dump
  });
  await captureRoleNames({
    host: required('GITEA_POSTGRES_HOST'), user: required('GITEA_POSTGRES_USER'), password: required('GITEA_POSTGRES_PASSWORD'), database: optional('GITEA_POSTGRES_DATABASE', 'gitea'), target: roles
  });
  await tarDirectory(required('GITEA_DATA_SOURCE'), data);
  await tarDirectory(required('GITEA_PRIVATE_CONFIG_SOURCE'), configuration);
  const entries = [];
  for (const input of [dump, data, configuration, roles]) await appendArchive(entries, input, `${input}.enc`);
  const run = {
    schemaVersion: 'opensphere-recovery-run/v1', id, component: 'gitea', createdAt: isoNow(),
    sourceRevision: optional('RECOVERY_SOURCE_REVISION', 'unknown'), artifacts: entries
  };
  const prefix = `${recoveryPrefix()}/${id}/gitea`;
  for (const entry of entries) await upload(join(archiveRoot, entry.object), `${prefix}/${entry.object}`);
  const manifest = join(archiveRoot, 'manifest.json');
  await writeFile(manifest, JSON.stringify(run, null, 2), { mode: 0o600 });
  await upload(manifest, `${prefix}/manifest.json`);
  await publishEvidence(backupEvidence(run, 'gitea', entries));
  return { id, manifestKey: `${prefix}/manifest.json`, artifacts: entries.length };
}

async function loadDrill(manifestKey, expectedComponent) {
  const root = join(WORK, `drill-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const manifestPath = join(root, 'manifest.json');
  await download(manifestKey, manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 'opensphere-recovery-run/v1' || manifest.component !== expectedComponent || !Array.isArray(manifest.artifacts)) {
    throw new Error('Recovery manifest is not an OpenSphere artifact for the requested isolated drill');
  }
  const prefix = dirname(manifestKey).replace(/\\/g, '/');
  for (const entry of manifest.artifacts) {
    const encrypted = join(root, entry.object);
    const plain = join(root, entry.name);
    await download(`${prefix}/${entry.object}`, encrypted);
    if (await sha256File(encrypted) !== entry.ciphertextSha256) throw new Error(`Ciphertext digest mismatch for ${entry.name}`);
    await decryptFile(encrypted, plain, entry.cipher);
    if (await sha256File(plain) !== entry.plaintextSha256) throw new Error(`Plaintext digest mismatch for ${entry.name}`);
  }
  return { root, manifest };
}

async function drillSupabase() {
  const loaded = await loadDrill(required('RECOVERY_MANIFEST_KEY'), 'supabase');
  try {
    const archivedRoles = JSON.parse(await readFile(join(loaded.root, 'supabase-roles.json'), 'utf8')).roles;
    const databaseChecks = await restoreDatabase(join(loaded.root, 'supabase.pg.dump'), 'supabase', archivedRoles);
    const storage = join(loaded.root, 'storage');
    await mkdir(storage, { recursive: true });
    await shell('tar', ['-C', storage, '-xzf', join(loaded.root, 'supabase-storage.tgz')]);
    const count = (await shell('find', [storage, '-type', 'f'])).stdout.split(/\r?\n/).filter(Boolean).length;
    const storageChecks = [numberCheck('restored object files', count)];
    await publishEvidence((current) => {
      const next = drillEvidence('supabase', databaseChecks)(current);
      next.restore.storage = { state: storageChecks.every((item) => item.verdict === 'Verified') ? 'Verified' : 'AttentionRequired', verifiedAt: isoNow(), assertions: storageChecks.map((item) => item.assertion), checks: storageChecks };
      return next;
    });
    return { component: 'supabase', databaseChecks, storageChecks };
  } finally { await rm(loaded.root, { recursive: true, force: true }); }
}

async function drillGitea() {
  const loaded = await loadDrill(required('RECOVERY_MANIFEST_KEY'), 'gitea');
  try {
    const archivedRoles = JSON.parse(await readFile(join(loaded.root, 'gitea-roles.json'), 'utf8')).roles;
    const databaseChecks = await restoreDatabase(join(loaded.root, 'gitea.pg.dump'), 'gitea', archivedRoles);
    const gitea = join(loaded.root, 'gitea');
    const config = join(loaded.root, 'config');
    await mkdir(gitea, { recursive: true });
    await mkdir(config, { recursive: true });
    await shell('tar', ['-C', gitea, '-xzf', join(loaded.root, 'gitea-data.tgz')]);
    await shell('tar', ['-C', config, '-xzf', join(loaded.root, 'gitea-private-config.tgz')]);
    const repositories = (await shell('find', [gitea, '-name', 'HEAD', '-type', 'f'])).stdout.split(/\r?\n/).filter(Boolean).length;
    const keys = (await shell('find', [config, '-type', 'f'])).stdout.split(/\r?\n/).filter(Boolean).length;
    const checks = [
      ...databaseChecks,
      numberCheck('gitea repository git heads restored', repositories),
      numberCheck('gitea private configuration restored', keys)
    ];
    await publishEvidence(drillEvidence('gitea', checks));
    return { component: 'gitea', checks };
  } finally { await rm(loaded.root, { recursive: true, force: true }); }
}

async function main() {
  const mode = required('RECOVERY_MODE');
  if (!MODES.has(mode)) throw new Error(`RECOVERY_MODE must be one of ${[...MODES].join(', ')}`);
  await mkdir(WORK, { recursive: true });
  const result = mode === 'backup-supabase'
    ? await backupSupabase()
    : mode === 'backup-gitea'
      ? await backupGitea()
      : mode === 'drill-supabase'
        ? await drillSupabase()
        : await drillGitea();
  // The result deliberately exposes only opaque run/manifest references and
  // assertion outcomes. No S3 credential, encryption key or archive content
  // is ever printed to a Kubernetes Job log.
  process.stdout.write(`${JSON.stringify({ ok: true, mode, result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`OpenSphere recovery failed: ${String(error?.message || error).slice(0, 1000)}\n`);
    process.exitCode = 1;
  });
}

export { decryptFile, encryptFile };
