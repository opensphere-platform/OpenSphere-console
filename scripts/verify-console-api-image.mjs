import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Exercise the built image's default entrypoint, not host source or a mock API.
// PostgreSQL and both API instances are disposable and isolated from Kubernetes.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--image' || !/^[a-z0-9][a-z0-9./:@_-]+$/u.test(args[1])) {
  throw new Error('Usage: node scripts/verify-console-api-image.mjs --image <built-image>');
}
const image = args[1];
const postgresImage = 'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
const runId = randomUUID();
const prefix = 'os-api-smoke-' + runId;
const network = prefix + '-net';
const database = prefix + '-db';
const label = 'opensphere.test.run';
const password = randomBytes(24).toString('hex');
const runtimePassword = randomBytes(24).toString('hex');
const wrongPassword = randomBytes(24).toString('hex');
const sessionKey = randomBytes(32).toString('base64');
const serviceKey = randomBytes(48).toString('hex');
const owned = [];
let networkCreated = false;
let evidence;
let failure;
function redact(value) {
  let text = String(value || '');
  for (const secret of [password, runtimePassword, wrongPassword, sessionKey, serviceKey]) text = text.split(secret).join('[REDACTED]');
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, '[REDACTED_DATABASE_URL]');
}
function docker(argv, { env = {}, input, allowFailure = false, timeout = 30000 } = {}) {
  const result = spawnSync('docker', argv, {
    env: { ...process.env, ...env }, input, encoding: 'utf8', windowsHide: true,
    timeout, maxBuffer: 2 * 1024 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`Docker ${argv[0]} failed: ${redact(result.stderr || result.error?.message).slice(-2500)}`);
  }
  return result;
}
function inspect(name) { return JSON.parse(docker(['inspect', name]).stdout)[0]; }
function logs(name) { return redact(docker(['logs', '--tail', '30', name], { allowFailure: true }).stderr).slice(-2500); }
function create(name, argv, env) {
  owned.push(name);
  docker(['create', '--name', name, '--label', `${label}=${runId}`, ...argv], { env });
  docker(['start', name]);
}
async function health(name, expectedStatus) {
  // The client executes inside the image, but the server remains its normal PID 1.
  const probe = "const r=await fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(3000)}); console.log(JSON.stringify({status:r.status,body:await r.json()}));";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = inspect(name);
    if (!state.State.Running) throw new Error(`API entrypoint exited (${state.State.ExitCode}): ${logs(name)}`);
    const result = docker(['exec', name, 'node', '--input-type=module', '-e', probe], { allowFailure: true });
    if (result.status === 0) {
      const response = JSON.parse(result.stdout);
      assert.equal(response.status, expectedStatus, 'API readiness must reflect PostgreSQL authentication');
      if (expectedStatus === 200) {
        assert.equal(response.body.state, 'Ready');
        assert.equal(response.body.authority, 'SupabasePostgreSQL');
      } else {
        assert.notEqual(response.body.state, 'Ready');
      }
      assert.equal(state.RestartCount, 0, 'A restarting API is not a successful image startup');
      return response.status;
    }
    await delay(250);
  }
  throw new Error(`API image did not serve HTTP readiness: ${logs(name)}`);
}
function api(name, credential) {
  const env = {
    CONSOLE_DATABASE_URL: `postgresql://console_api_runtime:${credential}@postgres:5432/postgres`,
    CONSOLE_PUBLIC_ORIGIN: 'https://console.image.test',
    CONSOLE_SESSION_ENCRYPTION_KEY: sessionKey,
    CONSOLE_SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    CONSOLE_DATABASE_CONNECT_TIMEOUT_MS: '1000',
  };
  create(name, [
    '--network', network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m',
    ...Object.keys(env).flatMap((key) => ['--env', key]), image,
  ], env);
}
try {
  const imageInfo = JSON.parse(docker(['image', 'inspect', image]).stdout)[0];
  assert.equal(imageInfo.Config.User, '1001', 'Exercise the non-root production image');
  assert.deepEqual(imageInfo.Config.Cmd, ['node', 'src/server.mjs'], 'Exercise the production entrypoint');
  if (docker(['image', 'inspect', postgresImage], { allowFailure: true }).status !== 0) {
    docker(['pull', postgresImage], { timeout: 180000 });
  }
  networkCreated = true;
  docker(['network', 'create', '--internal', '--label', `${label}=${runId}`, network]);
  create(database, [
    '--network', network, '--network-alias', 'postgres',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '--env', 'POSTGRES_PASSWORD', '--env', 'PGDATA=/tmp/opensphere-pgdata', postgresImage,
  ], { POSTGRES_PASSWORD: password });
  let databaseReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!inspect(database).State.Running) throw new Error('Temporary PostgreSQL exited');
    if (docker(['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { allowFailure: true }).status === 0) {
      databaseReady = true;
      break;
    }
    await delay(250);
  }
  assert.ok(databaseReady, 'Temporary PostgreSQL did not become ready');
  docker(['exec', '-i', database, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input: `CREATE ROLE console_api_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;\n`,
  });
  api(prefix + '-ready', runtimePassword);
  const readyStatus = await health(prefix + '-ready', 200);
  const connections = docker(['exec', '-i', database, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], {
    input: "SELECT count(*) FROM pg_stat_activity WHERE usename='console_api_runtime' AND application_name='opensphere-console-api';\n",
  }).stdout.trim();
  assert.ok(Number(connections) >= 1, 'Ready must come from the actual runtime DB role');
  api(prefix + '-unready', wrongPassword);
  const rejectedStatus = await health(prefix + '-unready', 503);
  evidence = {
    status: 'passed', image, imageId: imageInfo.Id, platform: `${imageInfo.Os}/${imageInfo.Architecture}`,
    defaultEntrypoint: true, runtimeUser: '1001', realPostgreSqlRuntimeRole: true,
    readyHttpStatus: readyStatus, invalidDatabaseCredentialHttpStatus: rejectedStatus,
    sourceBindMounts: false, clusterAccess: false, hostPorts: false,
  };
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const name of owned.reverse()) {
    try {
      const result = docker(['inspect', name], { allowFailure: true });
      if (result.status !== 0) {
        assert.match(result.stderr || '', /No such (object|container)/iu, 'Unable to establish test container absence');
        continue;
      }
      const container = JSON.parse(result.stdout)[0];
      assert.equal(container.Config.Labels?.[label], runId, 'Refusing to remove a non-test container');
      docker(['rm', '--force', '--volumes', container.Id]);
    } catch (error) { cleanupErrors.push(redact(error.message)); }
  }
  if (networkCreated) {
    try {
      const inspected = docker(['network', 'inspect', network], { allowFailure: true });
      if (inspected.status !== 0) {
        assert.match(inspected.stderr || '', /(No such (object|network)|network .* not found)/iu, 'Unable to establish test network absence');
      } else {
        const result = JSON.parse(inspected.stdout)[0];
        assert.equal(result.Labels?.[label], runId, 'Refusing to remove a non-test network');
        docker(['network', 'rm', result.Id]);
      }
    } catch (error) { cleanupErrors.push(redact(error.message)); }
  }
  if (cleanupErrors.length) failure = new Error(`${failure ? redact(failure.message) + '; ' : ''}Cleanup failed: ${cleanupErrors.join('; ')}`);
}
if (failure) throw new Error(redact(failure.message));
console.log(JSON.stringify({ ...evidence, temporaryResourcesRemoved: true }));
