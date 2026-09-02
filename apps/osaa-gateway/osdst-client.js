'use strict';

const OSDST_URL = (process.env.OSDST_URL || 'http://opensphere-osdst.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const MODES = Object.freeze(['off', 'shadow', 'read-enforce', 'mutation-enforce']);

function dialogueModePolicy(value) {
  const mode = MODES.includes(String(value || '').trim().toLowerCase())
    ? String(value).trim().toLowerCase() : 'off';
  return Object.freeze({
    mode,
    recordTransitions: mode !== 'off',
    exposeContext: mode === 'read-enforce' || mode === 'mutation-enforce',
    enforceCurrentFacts: mode === 'read-enforce' || mode === 'mutation-enforce',
    enforceMutations: mode === 'mutation-enforce',
  });
}

function bearer(actor) {
  const token = String(actor?.bearerToken || '').trim();
  if (!token) throw Object.assign(new Error('OSDST requires the verified caller token'), { code: 401 });
  return token;
}

async function request(path, actor, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  let response;
  try {
    response = await fetch(`${OSDST_URL}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(actor ? { authorization: `Bearer ${bearer(actor)}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw Object.assign(new Error(`OSDST unavailable: ${error.message || error}`), {
      code: 503, errorCode: 'osdst_unavailable',
    });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `OSDST HTTP ${response.status}`), {
      code: response.status,
      errorCode: data.errorCode || 'osdst_request_failed',
      retryAfterSeconds: Number(data.retryAfterSeconds || 0),
    });
  }
  return data;
}

function createOsdstClient() {
  return {
    list: (actor, options = {}) => request(`/v1/conversations?status=${encodeURIComponent(options.status || '')}&limit=${encodeURIComponent(options.limit || 40)}`, actor),
    get: (actor, id) => request(`/v1/conversations/${encodeURIComponent(id)}`, actor),
    update: (actor, id, patch) => request(`/v1/conversations/${encodeURIComponent(id)}`, actor, { method: 'PATCH', body: patch }),
    remove: (actor, id) => request(`/v1/conversations/${encodeURIComponent(id)}`, actor, { method: 'DELETE' }),
    beginTurn: (actor, body) => request('/v1/turns/begin', actor, { method: 'POST', body }),
    completeTurn: (actor, turn, response) => request('/v1/turns/complete', actor, { method: 'POST', body: { turn, response }, timeoutMs: 30000 }),
    failTurn: (actor, turn) => request('/v1/turns/fail', actor, { method: 'POST', body: { turn } }),
    heartbeatTurn: (actor, turn) => request('/v1/turns/heartbeat', actor, { method: 'POST', body: { turn } }),
    dialogueContext: (actor, id) => request(`/v1/conversations/${encodeURIComponent(id)}/projection`, actor),
    status: () => request('/v1/status', null, { timeoutMs: 5000 }),
  };
}

module.exports = { MODES, createOsdstClient, dialogueModePolicy };
