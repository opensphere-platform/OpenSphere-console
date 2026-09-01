function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
}

const LIVE_COMPONENTS = Object.freeze([
  Object.freeze({ component: 'auth', authority: 'SupabaseAuth', path: '/health', contract: 'status', evidenceRef: 'supabase-auth:health:ready' }),
  Object.freeze({ component: 'dataApi', authority: 'SupabasePostgREST', path: '/', contract: 'openapi', evidenceRef: 'supabase-postgrest:openapi:ready' }),
  Object.freeze({ component: 'storage', authority: 'SupabaseStorage', path: '/status', contract: 'status', evidenceRef: 'supabase-storage:status:ready' }),
]);

function configuredOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(name + ' must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new TypeError(name + ' must be an HTTP(S) origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

async function boundedText(response, maximumBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('response too large');
  if (!response.body) throw new Error('response body missing');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

function failedProbe(component, reasonCode, observedAt, state = 'Unknown') {
  return Object.freeze({
    component: component.component,
    state,
    authority: component.authority,
    reasonCode,
    observedAt,
  });
}

export function createSupabaseLiveProbes({
  authUrl,
  dataApiUrl,
  storageUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 1500,
  maximumResponseBytes = 128 * 1024,
  now = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new TypeError('Supabase probe timeout is invalid');
  if (!Number.isInteger(maximumResponseBytes) || maximumResponseBytes < 1024 || maximumResponseBytes > 1024 * 1024) {
    throw new TypeError('Supabase probe response limit is invalid');
  }
  const origins = Object.freeze({
    auth: configuredOrigin(authUrl, 'Supabase Auth URL'),
    dataApi: configuredOrigin(dataApiUrl, 'Supabase PostgREST URL'),
    storage: configuredOrigin(storageUrl, 'Supabase Storage URL'),
  });

  async function observeOne(component) {
    const observedAt = now().toISOString();
    let response;
    try {
      response = await fetchImpl(origins[component.component] + component.path, {
        method: 'GET',
        headers: { accept: component.contract === 'openapi' ? 'application/openapi+json, application/json' : 'application/json, text/plain' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return failedProbe(component, timeout ? 'DependencyTimeout' : 'AuthorityUnavailable', observedAt);
    }
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      return failedProbe(component, 'HealthCheckFailed', observedAt, 'Blocked');
    }
    if (component.contract === 'openapi') {
      try {
        const document = JSON.parse(await boundedText(response, maximumResponseBytes));
        if ((!document.openapi && !document.swagger) || !document.paths || typeof document.paths !== 'object') {
          return failedProbe(component, 'HealthContractInvalid', observedAt, 'Blocked');
        }
      } catch {
        return failedProbe(component, 'HealthContractInvalid', observedAt, 'Blocked');
      }
    } else {
      if (response.body) await response.body.cancel().catch(() => {});
    }
    return Object.freeze({
      component: component.component,
      state: 'Ready',
      authority: component.authority,
      reasonCode: null,
      observedAt,
      evidenceRef: component.evidenceRef,
    });
  }

  return Object.freeze({
    async observe() {
      return Promise.all(LIVE_COMPONENTS.map(observeOne));
    },
  });
}

function mergeLiveStatus(envelope, live, now) {
  const output = structuredClone(envelope);
  const replacements = new Map(live.map((component) => [component.component, component]));
  output.data.components = output.data.components.map((component) => replacements.get(component.component) || component);
  const runtime = output.data.components.filter((component) => ['database', 'auth', 'dataApi', 'storage', 'rls'].includes(component.component));
  output.data.state = runtime.some((component) => component.state === 'Blocked')
    ? 'Blocked'
    : output.data.components.every((component) => component.state === 'Ready') ? 'Ready' : 'Degraded';
  output.observedAt = now().toISOString();
  output.evidenceRefs = [
    ...(Array.isArray(output.evidenceRefs) ? output.evidenceRefs : []),
    ...live.flatMap((component) => component.evidenceRef ? [component.evidenceRef] : []),
  ];
  return output;
}

export function createDataIdentityOperations({ store, liveProbes = null, now = () => new Date() }) {
  if (!store?.getSupabaseStatus) throw new TypeError('Supabase status projection store is required');
  return Object.freeze({
    async getSupabaseStatus({ session, correlationId }) {
      const permissionRevision = Number(session?.permissionRevision);
      const revokeEpoch = Number(session?.revokeEpoch);
      if (!session?.sessionId || !session?.subjectId
          || !Number.isSafeInteger(permissionRevision) || permissionRevision < 0
          || !Number.isSafeInteger(revokeEpoch) || revokeEpoch < 0) {
        fail('AuthenticationRequired', 'session authority revision is invalid', 401);
      }
      const baseline = await store.getSupabaseStatus({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        expectedPermissionRevision: permissionRevision,
        expectedRevokeEpoch: revokeEpoch,
        correlationId,
      });
      if (!liveProbes) return baseline;
      return mergeLiveStatus(baseline, await liveProbes.observe(), now);
    },
  });
}
