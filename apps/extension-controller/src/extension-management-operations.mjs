const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ICON = /^(?:|[a-z0-9][a-z0-9-]{0,95})$/u;
const READ_PERMISSIONS = new Set([
  'console.extension.install', 'console.extension.remove', 'console.extension.revoke',
]);

function fault(message, code, status, sideEffect = 'none') {
  return Object.assign(new Error(message), { code, status, sideEffect });
}
function actorAuthority(actor, permission, { requireAal2 = false } = {}) {
  if (!actor?.subjectId || !Array.isArray(actor.permissions)
      || !Number.isSafeInteger(actor.permissionRevision)
      || !Number.isSafeInteger(actor.revokeEpoch)) {
    throw fault('current Extension owner authority is required', 'AuthenticationRequired', 401);
  }
  if (permission === 'extension.read') {
    if (!actor.permissions.some((candidate) => READ_PERMISSIONS.has(candidate))) {
      throw fault('an Extension permission is required', 'PermissionDenied', 403);
    }
  } else if (!actor.permissions.includes(permission)) {
    throw fault(permission + ' permission is required', 'PermissionDenied', 403);
  }
  if (requireAal2 && actor.assurance !== 'aal2') {
    throw fault('Extension management mutation requires MFA assurance aal2', 'StepUpRequired', 428);
  }
}
function correlation(value) {
  const result = String(value || '');
  if (result.length < 8 || result.length > 128 || /[\r\n]/u.test(result)) {
    throw fault('Extension management correlation is invalid', 'ValidationFailed', 400);
  }
  return result;
}
function reason(value) {
  const result = String(value || '').trim();
  if (result.length < 8 || result.length > 500 || /[\r\n]/u.test(result)) {
    throw fault('Extension management reason must contain 8..500 characters', 'ValidationFailed', 400);
  }
  return result;
}
function extensionId(value) {
  const result = String(value || '');
  if (!ID.test(result)) throw fault('Extension identity is invalid', 'ValidationFailed', 400);
  return result;
}
function projection(items, observedAt) {
  return Object.freeze({
    items,
    projection: Object.freeze({ ready: true, state: 'live', observedAt, ageSeconds: 0 }),
  });
}
function navigationPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fault('Extension navigation settings are invalid', 'ValidationFailed', 400);
  }
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !['icon', 'labelOverride'].includes(key))) {
    throw fault('Extension navigation settings are invalid', 'ValidationFailed', 400);
  }
  const result = {};
  if (Object.hasOwn(value, 'icon')) {
    if (typeof value.icon !== 'string' || !ICON.test(value.icon)) {
      throw fault('Extension navigation icon is invalid', 'ValidationFailed', 400);
    }
    result.icon = value.icon;
  }
  if (Object.hasOwn(value, 'labelOverride')) {
    if (typeof value.labelOverride !== 'string') {
      throw fault('Extension navigation label is invalid', 'ValidationFailed', 400);
    }
    const label = value.labelOverride.trim();
    if (label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label)) {
      throw fault('Extension navigation label is invalid', 'ValidationFailed', 400);
    }
    result.labelOverride = label || null;
  }
  return Object.freeze(result);
}

export function createExtensionManagementOperations({ authority, store, clock = () => new Date() }) {
  for (const method of ['catalog', 'registrations', 'bindings', 'setDesiredState', 'rollback', 'setBindingEnabled', 'navigationInventory']) {
    if (typeof authority?.[method] !== 'function') throw new TypeError('Extension management Kubernetes authority is incomplete');
  }
  for (const method of ['preferences', 'writePreferences', 'recordEvent', 'events']) {
    if (typeof store?.[method] !== 'function') throw new TypeError('Extension management store is incomplete');
  }

  async function recordedMutation({ actor, correlationId, action, targetRef, reason: mutationReason, apply }) {
    const requestCorrelation = correlation(correlationId);
    const requestReason = reason(mutationReason);
    await store.recordEvent({
      actorRef: actor.subjectId, correlationId: requestCorrelation, action, targetRef,
      outcome: 'accepted', reason: requestReason,
      evidence: { permissionRevision: actor.permissionRevision, revokeEpoch: actor.revokeEpoch, assurance: actor.assurance },
    });
    let receipt;
    try {
      receipt = await apply();
    } catch (error) {
      try {
        await store.recordEvent({
          actorRef: actor.subjectId, correlationId: requestCorrelation, action, targetRef,
          outcome: ['present', 'unknown'].includes(error?.sideEffect) ? 'unknown' : 'failed',
          reason: String(error?.code || 'OwnerUnavailable').slice(0, 500),
          evidence: { sideEffect: error?.sideEffect || 'unknown' },
        });
      } catch {
        if (!error.sideEffect || error.sideEffect === 'none') error.sideEffect = 'unknown';
      }
      throw error;
    }
    try {
      await store.recordEvent({
        actorRef: actor.subjectId, correlationId: requestCorrelation, action, targetRef,
        outcome: 'succeeded', reason: requestReason, evidence: receipt,
      });
    } catch (error) {
      throw fault('Extension mutation succeeded but audit completion is unavailable', 'AuditUnavailable', 503, 'present');
    }
    return receipt;
  }

  async function setNavigationOperation({ actor, id, settings, correlationId }) {
    actorAuthority(actor, 'console.extension.install', { requireAal2: true });
    const target = extensionId(id);
    const update = navigationPatch(settings);
    const inventory = await authority.navigationInventory();
    if (!inventory.includes(target)) {
      throw fault('navigation settings require a registered first-level subShell', 'NavigationInventoryMismatch', 409);
    }
    const preferences = await store.writePreferences({
      actorRef: actor.subjectId,
      correlationId: correlation(correlationId),
      updates: [{ extensionId: target, navigation: update }],
      reason: 'operator updated Extension navigation',
    });
    return Object.freeze({ accepted: true, id: target, navigation: preferences.get(target)?.navigation || update });
  }

  return Object.freeze({
    async catalog({ actor }) {
      actorAuthority(actor, 'extension.read');
      const [preferences, observedAt] = await Promise.all([
        store.preferences(), Promise.resolve(clock().toISOString()),
      ]);
      return projection(await authority.catalog(preferences), observedAt);
    },
    async registrations({ actor }) {
      actorAuthority(actor, 'extension.read');
      return projection(await authority.registrations(), clock().toISOString());
    },
    async events({ actor }) {
      actorAuthority(actor, 'console.audit.read');
      return Object.freeze({ items: await store.events(100) });
    },
    async bindings({ actor }) {
      actorAuthority(actor, 'extension.read');
      return Object.freeze({ items: await authority.bindings() });
    },
    async registrationAction({ actor, id, action, reason: actionReason, correlationId }) {
      const target = extensionId(id);
      if (!['enable', 'disable', 'uninstall', 'rollback'].includes(action)) {
        throw fault('Extension registration action is invalid', 'ValidationFailed', 400);
      }
      const permission = ['disable', 'uninstall'].includes(action)
        ? 'console.extension.remove' : 'console.extension.install';
      actorAuthority(actor, permission, { requireAal2: true });
      const auditAction = 'console.extension.' + action;
      const receipt = await recordedMutation({
        actor, correlationId, action: auditAction, targetRef: 'extension:' + target,
        reason: actionReason,
        apply: () => action === 'rollback'
          ? authority.rollback({ id: target, actorRef: actor.subjectId, reason: reason(actionReason) })
          : authority.setDesiredState({
            id: target,
            desiredState: action === 'enable' ? 'Enabled' : action === 'disable' ? 'Disabled' : 'Uninstalled',
            actorRef: actor.subjectId,
            reason: reason(actionReason),
          }),
      });
      return Object.freeze({ accepted: true, ...receipt });
    },
    async bindingAction({ actor, name, action, correlationId }) {
      if (!['enable', 'disable'].includes(action)) throw fault('Binding action is invalid', 'ValidationFailed', 400);
      actorAuthority(actor, 'console.extension.install', { requireAal2: true });
      const target = extensionId(name);
      const enabled = action === 'enable';
      const receipt = await recordedMutation({
        actor, correlationId,
        action: 'console.extension.binding.' + action,
        targetRef: 'binding:' + target,
        reason: 'operator requested Binding ' + action,
        apply: () => authority.setBindingEnabled({ name: target, enabled }),
      });
      return Object.freeze({ accepted: true, ...receipt });
    },
    setNavigation: setNavigationOperation,
    async setIcon({ actor, id, icon, correlationId }) {
      return setNavigationOperation({ actor, id, settings: { icon }, correlationId });
    },
    async setNavigationOrder({ actor, ids, correlationId }) {
      actorAuthority(actor, 'console.extension.install', { requireAal2: true });
      if (!Array.isArray(ids) || ids.length > 64 || ids.some((id) => !ID.test(String(id || '')))
          || new Set(ids).size !== ids.length) {
        throw fault('Extension navigation order is invalid', 'ValidationFailed', 400);
      }
      const inventory = await authority.navigationInventory();
      if (ids.length !== inventory.length || [...ids].sort().some((id, index) => id !== inventory[index])) {
        throw fault('Extension navigation order does not match the current inventory', 'NavigationInventoryMismatch', 409);
      }
      await store.writePreferences({
        actorRef: actor.subjectId,
        correlationId: correlation(correlationId),
        updates: ids.map((id, order) => ({ extensionId: id, navigation: { order } })),
        reason: 'operator updated Extension navigation order',
      });
      return Object.freeze({ accepted: true, ids: Object.freeze([...ids]) });
    },
  });
}
