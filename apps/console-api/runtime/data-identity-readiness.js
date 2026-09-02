'use strict';

const REQUIRED_COMPONENTS = Object.freeze([
  { key: 'auth', name: 'Supabase Auth', responsibility: 'Console identity and session issuance' },
  { key: 'data', name: 'Supabase PostgREST', responsibility: 'RLS-protected Console data API' },
  { key: 'storage', name: 'Supabase Storage', responsibility: 'Console uploads and operation artifacts' },
]);

function failureDetail(error) {
  if (error?.name === 'TimeoutError') return 'timeout';
  const message = String(error?.message || error?.msg || '').trim();
  return message ? message.slice(0, 160) : 'unreachable';
}

async function evaluateDataIdentityReadiness({
  readDataAuthority,
  fetchImpl = fetch,
  authUrl,
  storageUrl,
  timeoutMs = 3000,
}) {
  const checks = {
    auth: async () => {
      if (!authUrl) throw new Error('not configured');
      const response = await fetchImpl(`${authUrl.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      return 'HTTP 200';
    },
    data: async () => {
      const result = await readDataAuthority();
      if (!Array.isArray(result)) throw new Error('invalid authority response');
      return 'operator projection readable';
    },
    storage: async () => {
      if (!storageUrl) throw new Error('not configured');
      const response = await fetchImpl(`${storageUrl.replace(/\/$/, '')}/status`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      return 'HTTP 200';
    },
  };

  const components = await Promise.all(REQUIRED_COMPONENTS.map(async (component) => {
    try {
      return { ...component, ready: true, detail: await checks[component.key]() };
    } catch (error) {
      return { ...component, ready: false, detail: failureDetail(error) };
    }
  }));

  return {
    ready: components.every((component) => component.ready),
    required: true,
    components,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { REQUIRED_COMPONENTS, evaluateDataIdentityReadiness };
