const PREFERENCES_SQL = 'SELECT console_extension.list_presentation_preferences() AS projection';
const WRITE_PREFERENCES_SQL = [
  'SELECT console_extension.write_presentation_preferences(',
  '$1::uuid, $2::text, $3::jsonb, $4::text',
  ') AS projection',
].join(' ');
const RECORD_EVENT_SQL = [
  'SELECT console_extension.record_management_event(',
  '$1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb',
  ') AS receipt',
].join(' ');
const EVENTS_SQL = 'SELECT console_extension.list_management_events($1::integer) AS projection';
const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ICON = /^(?:|[a-z0-9][a-z0-9-]{0,95})$/u;

function databaseError(error) {
  const known = new Set(['ValidationFailed']);
  const code = known.has(String(error?.detail || '')) ? String(error.detail) : 'AuthorityUnavailable';
  return Object.assign(new Error(code === 'ValidationFailed'
    ? 'Extension management authority rejected the request'
    : 'Extension management database authority is unavailable'), {
    code,
    status: code === 'ValidationFailed' ? 400 : 503,
    sideEffect: 'none',
    cause: error,
  });
}
function navigation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('navigation preference is invalid');
  const output = {};
  if (Object.hasOwn(value, 'icon')) {
    if (typeof value.icon !== 'string' || !ICON.test(value.icon)) throw new Error('navigation icon is invalid');
    output.icon = value.icon;
  }
  if (Object.hasOwn(value, 'labelOverride')) {
    if (value.labelOverride !== null
        && (typeof value.labelOverride !== 'string' || value.labelOverride.length > 80 || /[\u0000-\u001f\u007f]/u.test(value.labelOverride))) {
      throw new Error('navigation label is invalid');
    }
    output.labelOverride = value.labelOverride;
  }
  if (Object.hasOwn(value, 'order')) {
    if (!Number.isInteger(value.order) || value.order < 0 || value.order > 63) throw new Error('navigation order is invalid');
    output.order = value.order;
  }
  if (!Object.keys(output).length) throw new Error('navigation preference is empty');
  return Object.freeze(output);
}
function preferences(value) {
  const items = Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : null;
  if (!items || items.length > 256) throw new Error('navigation preference projection is invalid');
  const result = new Map();
  for (const item of items) {
    if (!ID.test(String(item?.extensionId || '')) || result.has(item.extensionId)) {
      throw new Error('navigation preference identity is invalid');
    }
    result.set(item.extensionId, Object.freeze({ navigation: navigation(item.navigation) }));
  }
  return result;
}
function events(value) {
  const items = Array.isArray(value?.items) ? value.items : null;
  if (!items || items.length > 200 || value?.authority !== 'ConsoleAuditLedger') {
    throw new Error('Extension event projection is invalid');
  }
  return Object.freeze(items.map((item) => {
    for (const key of ['time', 'actor', 'action', 'target', 'result', 'reason', 'opId', 'source']) {
      if (typeof item?.[key] !== 'string' || item[key].length > 512 || /[\u0000-\u001f\u007f]/u.test(item[key])) {
        throw new Error('Extension event item is invalid');
      }
    }
    if (!Number.isFinite(Date.parse(item.time)) || item.source !== 'C_EXT') throw new Error('Extension event authority is invalid');
    return Object.freeze({
      time: item.time, actor: item.actor,
      ...(typeof item.actorId === 'string' ? { actorId: item.actorId } : {}),
      action: item.action, target: item.target, result: item.result,
      reason: item.reason, opId: item.opId, source: item.source,
    });
  }));
}

export function createExtensionManagementStore({ query }) {
  if (typeof query !== 'function') throw new TypeError('PostgreSQL query function is required');
  async function call(sql, parameters, column) {
    try {
      const result = await query(sql, parameters);
      const value = result?.rows?.[0]?.[column];
      if (!value) throw new Error('Extension management database returned no projection');
      return value;
    } catch (error) {
      if (error?.code && ['ValidationFailed', 'AuthorityUnavailable'].includes(error.code)) throw error;
      throw databaseError(error);
    }
  }
  return Object.freeze({
    async preferences() {
      try { return preferences(await call(PREFERENCES_SQL, [], 'projection')); }
      catch (error) {
        if (error?.code) throw error;
        throw Object.assign(new Error('Extension preference authority returned an invalid projection'), {
          code: 'AuthorityContractViolation', status: 503, sideEffect: 'none', cause: error,
        });
      }
    },
    async writePreferences({ actorRef, correlationId, updates, reason }) {
      const projection = await call(WRITE_PREFERENCES_SQL, [
        actorRef, correlationId, JSON.stringify(updates), reason,
      ], 'projection');
      try { return preferences(projection); }
      catch (error) {
        throw Object.assign(new Error('Extension preference authority returned an invalid write projection'), {
          code: 'AuthorityContractViolation', status: 503, sideEffect: 'present', cause: error,
        });
      }
    },
    async recordEvent({ actorRef, correlationId, action, targetRef, outcome, reason = '', evidence = {} }) {
      const receipt = await call(RECORD_EVENT_SQL, [
        actorRef, correlationId, action, targetRef, outcome, reason, JSON.stringify(evidence),
      ], 'receipt');
      if (!/^sha256:[a-f0-9]{64}$/u.test(String(receipt?.eventHash || ''))
          || !Number.isSafeInteger(Number(receipt?.sequenceId))
          || !Number.isFinite(Date.parse(String(receipt?.occurredAt || '')))) {
        throw Object.assign(new Error('Extension management audit returned an invalid receipt'), {
          code: 'AuthorityContractViolation', status: 503, sideEffect: 'present',
        });
      }
      return Object.freeze({
        eventId: String(receipt.eventId), sequenceId: Number(receipt.sequenceId),
        eventHash: receipt.eventHash, occurredAt: receipt.occurredAt,
      });
    },
    async events(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw Object.assign(new Error('Extension event limit is invalid'), { code: 'ValidationFailed', status: 400, sideEffect: 'none' });
      }
      try { return events(await call(EVENTS_SQL, [limit], 'projection')); }
      catch (error) {
        if (error?.code) throw error;
        throw Object.assign(new Error('Extension event authority returned an invalid projection'), {
          code: 'AuthorityContractViolation', status: 503, sideEffect: 'none', cause: error,
        });
      }
    },
  });
}
