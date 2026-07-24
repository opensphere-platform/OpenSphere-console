'use strict';

const { createHash } = require('crypto');

function text(value, label, { min = 0, max = 255, required = false } = {}) {
  const output = String(value ?? '').trim();
  if (required && !output) throw { code: 400, msg: `${label} is required` };
  if (output.length < min || output.length > max) throw { code: 400, msg: `${label} must be ${min}-${max} characters` };
  return output;
}

function auditReason(value) {
  return text(value, 'reason', { max: 240 });
}

function normalizeTarget(input) {
  const region = text(input?.region || 'us-east-005', 'region', { required: true, min: 3, max: 32 }).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(region)) throw { code: 400, msg: 'invalid S3 region' };
  let endpoint;
  try { endpoint = new URL(text(input?.endpoint, 'endpoint', { required: true, max: 240 })); }
  catch { throw { code: 400, msg: 'valid HTTPS endpoint is required' }; }
  const expectedHost = `s3.${region}.backblazeb2.com`;
  if (
    endpoint.protocol !== 'https:'
    || endpoint.hostname !== expectedHost
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || !['', '/'].includes(endpoint.pathname)
  ) throw { code: 400, msg: `endpoint must be https://${expectedHost}` };
  const bucketName = text(input?.bucketName, 'bucket name', { required: true, min: 3, max: 63 }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName)) throw { code: 400, msg: 'invalid S3 bucket name' };
  const pathPrefix = text(input?.pathPrefix || 'opensphere-console', 'path prefix', { required: true, max: 200 }).replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(pathPrefix) || /(^|\/)\.\.?(\/|$)/.test(pathPrefix)) {
    throw { code: 400, msg: 'invalid backup path prefix' };
  }
  return {
    name: text(input?.name || 'Backblaze B2 Console Backup', 'target name', { required: true, min: 2, max: 80 }),
    provider: 's3',
    vendor: 'backblaze-b2',
    endpoint: endpoint.origin,
    region,
    bucket_name: bucketName,
    bucket_id: text(input?.bucketId, 'bucket ID', { max: 128 }) || null,
    path_prefix: pathPrefix,
    bucket_private: input?.bucketPrivate !== false,
    lifecycle_mode: text(input?.lifecycleMode || 'keep-all-versions', 'lifecycle mode', { required: true, max: 80 }),
    server_side_encryption: ['enabled', 'disabled', 'unknown'].includes(input?.serverSideEncryption)
      ? input.serverSideEncryption
      : 'unknown',
  };
}

function publicTarget(row) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    vendor: row.vendor,
    endpoint: row.endpoint,
    region: row.region,
    bucketName: row.bucket_name,
    bucketId: row.bucket_id || '',
    pathPrefix: row.path_prefix,
    bucketPrivate: Boolean(row.bucket_private),
    lifecycleMode: row.lifecycle_mode,
    serverSideEncryption: row.server_side_encryption,
    clientSideEncryption: row.client_side_encryption,
    enabled: Boolean(row.enabled),
    healthState: row.health_state,
    credential: {
      configured: Boolean(row.credential_configured),
      version: Number(row.secret_version || 0),
    },
    lastTest: row.last_test_at ? {
      status: row.last_test_status,
      at: row.last_test_at,
      errorCode: row.last_error_code || null,
    } : null,
    lastBackupAt: row.last_backup_at || null,
    lastRestoreAt: row.last_restore_at || null,
    updatedAt: row.updated_at,
  };
}

function publicBackup(row, target) {
  return {
    id: row.id,
    targetId: row.target_id,
    targetName: target?.name || '',
    objectKey: row.object_key,
    status: row.status,
    formatVersion: row.format_version,
    encryption: row.encryption,
    plaintextDigest: row.plaintext_digest || '',
    objectDigest: row.object_digest || '',
    sizeBytes: Number(row.size_bytes || 0),
    entryCounts: row.entry_counts || {},
    createdAt: row.created_at,
    completedAt: row.completed_at || null,
    errorCode: row.error_code || null,
  };
}

function countSnapshot(snapshot) {
  const config = snapshot.configuration || {};
  const counts = {};
  for (const [name, value] of Object.entries(config)) {
    counts[name] = Array.isArray(value) ? value.length : (value ? 1 : 0);
  }
  return counts;
}

function rowDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const SNAPSHOT_KEYS = Object.freeze({
  roles: (item) => item.code,
  permissions: (item) => item.code,
  rolePermissions: (item) => `${item.roleCode}:${item.permissionCode}`,
  pluginMeta: (item) => item.pluginId,
  consumerContracts: (item) => item.consumerId,
  observabilityClaims: (item) => item.consumerId,
  notificationChannels: (item) => item.id,
  notificationRules: (item) => item.id,
  notificationRuleChannels: (item) => `${item.ruleId}:${item.channelId}`,
});

function compareSnapshots(current, incoming) {
  const result = {};
  for (const [category, keyFor] of Object.entries(SNAPSHOT_KEYS)) {
    const currentItems = Array.isArray(current.configuration?.[category]) ? current.configuration[category] : [];
    const incomingItems = Array.isArray(incoming.configuration?.[category]) ? incoming.configuration[category] : [];
    const currentIndex = new Map(currentItems.map((item) => [keyFor(item), rowDigest(item)]));
    let additions = 0;
    let changes = 0;
    let unchanged = 0;
    for (const item of incomingItems) {
      const existing = currentIndex.get(keyFor(item));
      if (!existing) additions += 1;
      else if (existing === rowDigest(item)) unchanged += 1;
      else changes += 1;
    }
    result[category] = { incoming: incomingItems.length, additions, changes, unchanged };
  }
  const incomingControl = incoming.configuration?.notificationDeliveryControl || null;
  const currentControl = current.configuration?.notificationDeliveryControl || null;
  result.notificationDeliveryControl = {
    incoming: incomingControl ? 1 : 0,
    additions: !currentControl && incomingControl ? 1 : 0,
    changes: currentControl && incomingControl && rowDigest(currentControl) !== rowDigest(incomingControl) ? 1 : 0,
    unchanged: currentControl && incomingControl && rowDigest(currentControl) === rowDigest(incomingControl) ? 1 : 0,
  };
  result.totals = Object.values(result).reduce((totals, item) => ({
    incoming: totals.incoming + item.incoming,
    additions: totals.additions + item.additions,
    changes: totals.changes + item.changes,
    unchanged: totals.unchanged + item.unchanged,
  }), { incoming: 0, additions: 0, changes: 0, unchanged: 0 });
  return result;
}

function createExternalChannelApi({
  restRequest,
  logAudit,
  newOpId,
  executorRequest,
}) {
  async function captureConfiguration(actor) {
    const [
      roles,
      permissions,
      rolePermissions,
      pluginMeta,
      consumerContracts,
      observabilityClaims,
      notificationChannels,
      notificationRules,
      notificationRuleChannels,
      notificationDeliveryControl,
    ] = await Promise.all([
      restRequest('role', { query: 'select=id,code,description,system_managed&order=code.asc' }),
      restRequest('permission', { query: 'select=id,code,risk_level&order=code.asc' }),
      restRequest('role_permission', { query: 'select=role_id,permission_id' }),
      restRequest('plugin_meta', { query: 'select=plugin_id,record&order=plugin_id.asc' }),
      restRequest('consumer_contract', { query: 'select=*&order=consumer_id.asc' }),
      restRequest('observability_claim', { query: 'select=consumer_id,requested_capabilities,binding_name,binding_namespace,phase&order=consumer_id.asc' }),
      restRequest('notification_channel', { query: 'select=id,name,provider,channel_type,enabled,config&deleted_at=is.null&order=name.asc' }),
      restRequest('notification_rule', { query: 'select=*&deleted_at=is.null&order=priority.asc,name.asc' }),
      restRequest('notification_rule_channel', { query: 'select=rule_id,channel_id' }),
      restRequest('notification_delivery_control', { query: 'select=paused,reason&singleton=eq.true' }),
    ]);
    const roleIndex = new Map(roles.map((item) => [item.id, item.code]));
    const permissionIndex = new Map(permissions.map((item) => [item.id, item.code]));
    return {
      apiVersion: 'configuration-backup.opensphere.io/v1',
      kind: 'OpenSphereConsoleConfiguration',
      createdAt: new Date().toISOString(),
      createdBy: actor.sub,
      restoreMode: 'allowlisted-transactional-merge',
      exclusions: [
        'auth-users-and-credentials',
        'operator-role-assignments',
        'notification-and-external-channel-secrets',
        'llm-provider-keys',
        'audit-and-delivery-history',
        'gitea-repository-content',
        'supabase-database-and-storage-bytes',
      ],
      configuration: {
        roles: roles.map((item) => ({
          code: item.code,
          description: item.description || '',
          systemManaged: Boolean(item.system_managed),
        })),
        permissions: permissions.map((item) => ({
          code: item.code,
          riskLevel: item.risk_level,
        })),
        rolePermissions: rolePermissions.map((item) => ({
          roleCode: roleIndex.get(item.role_id),
          permissionCode: permissionIndex.get(item.permission_id),
        })).filter((item) => item.roleCode && item.permissionCode),
        pluginMeta: pluginMeta.map((item) => ({ pluginId: item.plugin_id, record: item.record || {} })),
        consumerContracts: consumerContracts.map((item) => ({
          consumerId: item.consumer_id,
          displayName: item.display_name,
          ownerKind: item.owner_kind,
          supabaseSchemas: item.supabase_schemas || [],
          storageBuckets: item.storage_buckets || [],
          giteaRepository: item.gitea_repository || '',
          giteaPath: item.gitea_path || '',
          reconciler: item.reconciler || '',
          observabilityClaim: item.observability_claim || '',
          desiredRevision: item.desired_revision || '',
          metadata: item.metadata || {},
        })),
        observabilityClaims: observabilityClaims.map((item) => ({
          consumerId: item.consumer_id,
          requestedCapabilities: item.requested_capabilities || [],
          bindingName: item.binding_name || '',
          bindingNamespace: item.binding_namespace || '',
          phase: item.phase,
        })),
        notificationChannels: notificationChannels.map((item) => ({
          id: item.id,
          name: item.name,
          provider: item.provider,
          channelType: item.channel_type,
          enabled: Boolean(item.enabled),
          config: item.config || {},
        })),
        notificationRules: notificationRules.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description || '',
          enabled: Boolean(item.enabled),
          priority: item.priority,
          version: item.version,
          minSeverity: item.min_severity,
          sources: item.sources || [],
          categories: item.categories || [],
          labelMatch: item.label_match || {},
          quietHours: item.quiet_hours || {},
          dedupWindowSeconds: item.dedup_window_seconds,
          throttle: item.throttle || {},
          messagePolicy: item.message_policy || {},
        })),
        notificationRuleChannels: notificationRuleChannels.map((item) => ({
          ruleId: item.rule_id,
          channelId: item.channel_id,
        })),
        notificationDeliveryControl: notificationDeliveryControl[0]
          ? { paused: Boolean(notificationDeliveryControl[0].paused), reason: notificationDeliveryControl[0].reason || '' }
          : null,
      },
    };
  }

  async function targets() {
    const rows = await restRequest('external_backup_target', {
      query: 'select=*&deleted_at=is.null&order=name.asc',
    });
    return rows.map(publicTarget);
  }

  async function summary() {
    const [targetRows, backupRows, restoreRows] = await Promise.all([
      restRequest('external_backup_target', { query: 'select=health_state,credential_configured,enabled&deleted_at=is.null' }),
      restRequest('configuration_backup', { query: 'select=status,completed_at&order=created_at.desc&limit=1' }),
      restRequest('configuration_restore', { query: 'select=status,applied_at&order=created_at.desc&limit=1' }),
    ]);
    return {
      targets: targetRows.length,
      readyTargets: targetRows.filter((row) => row.enabled && row.health_state === 'Ready').length,
      configuredTargets: targetRows.filter((row) => row.credential_configured).length,
      lastBackup: backupRows[0] ? { status: backupRows[0].status, at: backupRows[0].completed_at } : null,
      lastRestore: restoreRows[0] ? { status: restoreRows[0].status, at: restoreRows[0].applied_at } : null,
    };
  }

  async function createTarget(actor, body) {
    const changeReason = auditReason(body?.reason);
    const parsed = normalizeTarget(body);
    const id = newOpId();
    const now = new Date().toISOString();
    await restRequest('external_backup_target', {
      method: 'POST',
      body: [{ ...parsed, id, created_by: actor.sub, updated_by: actor.sub, created_at: now, updated_at: now }],
    });
    try {
      await executorRequest(`/internal/targets/${id}/credentials`, {
        accessKeyId: body?.accessKeyId,
        applicationKey: body?.applicationKey,
      });
    } catch (error) {
      await restRequest('external_backup_target', {
        method: 'DELETE',
        query: `id=eq.${encodeURIComponent(id)}`,
        prefer: 'return=minimal',
      }).catch(() => undefined);
      throw error;
    }
    await logAudit(actor, 'external-backup-target-create', id, 'ok', changeReason, {
      requestId: newOpId(),
      targetType: 'external-backup-target',
      payloadDigest: rowDigest(parsed),
    });
    const rows = await restRequest('external_backup_target', { query: `select=*&id=eq.${encodeURIComponent(id)}` });
    return publicTarget(rows[0]);
  }

  async function test(actor, id, body) {
    const changeReason = auditReason(body?.reason);
    const output = await executorRequest(`/internal/targets/${id}/test`, {});
    await logAudit(actor, 'external-backup-target-test', id, output.ready ? 'ok' : 'failed', changeReason, {
      requestId: newOpId(),
      targetType: 'external-backup-target',
    });
    return output;
  }

  async function backups() {
    const [rows, targetRows] = await Promise.all([
      restRequest('configuration_backup', { query: 'select=*&order=created_at.desc&limit=100' }),
      restRequest('external_backup_target', { query: 'select=id,name&deleted_at=is.null' }),
    ]);
    const targetIndex = new Map(targetRows.map((item) => [item.id, item]));
    return rows.map((row) => publicBackup(row, targetIndex.get(row.target_id)));
  }

  async function backupNow(actor, id, body) {
    const changeReason = auditReason(body?.reason);
    const targetRows = await restRequest('external_backup_target', {
      query: `select=*&id=eq.${encodeURIComponent(id)}&deleted_at=is.null`,
    });
    const target = targetRows[0];
    if (!target || !target.enabled) throw { code: 404, msg: 'enabled external backup target not found' };
    if (!target.credential_configured) throw { code: 409, msg: 'external backup target credentials are not configured' };
    const snapshot = await captureConfiguration(actor);
    const backupId = newOpId();
    const date = new Date();
    const datePath = [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    ].join('/');
    const objectKey = `${target.path_prefix}/configuration/${datePath}/${backupId}.json.enc`;
    await restRequest('configuration_backup', {
      method: 'POST',
      body: [{
        id: backupId,
        target_id: id,
        object_key: objectKey,
        entry_counts: countSnapshot(snapshot),
        created_by: actor.sub,
      }],
    });
    const output = await executorRequest(`/internal/targets/${id}/backups/${backupId}`, { snapshot }, 45000);
    await logAudit(actor, 'external-configuration-backup-create', backupId, 'ok', changeReason, {
      requestId: newOpId(),
      targetType: 'configuration-backup',
      payloadDigest: String(output.plaintextDigest || '').replace(/^sha256:/, ''),
    });
    return { ...output, entryCounts: countSnapshot(snapshot) };
  }

  async function readSnapshot(backupId) {
    const rows = await restRequest('configuration_backup', {
      query: `select=*&id=eq.${encodeURIComponent(backupId)}`,
    });
    if (!rows[0]) throw { code: 404, msg: 'configuration backup not found' };
    const backup = rows[0];
    return executorRequest(`/internal/targets/${backup.target_id}/backups/${backup.id}/read`, {}, 45000);
  }

  async function previewRestore(actor, backupId, body) {
    const restoreReason = auditReason(body?.reason);
    const [downloaded, current] = await Promise.all([
      readSnapshot(backupId),
      captureConfiguration(actor),
    ]);
    const preview = {
      backupId,
      backupCreatedAt: downloaded.snapshot.createdAt,
      restoreMode: downloaded.snapshot.restoreMode,
      exclusions: downloaded.snapshot.exclusions || [],
      changes: compareSnapshots(current, downloaded.snapshot),
    };
    const rows = await restRequest('configuration_restore', {
      method: 'POST',
      body: [{
        backup_id: backupId,
        requested_by: actor.sub,
        preview_digest: downloaded.digest,
        preview,
        reason: restoreReason,
      }],
    });
    await logAudit(actor, 'external-configuration-restore-preview', rows[0].id, 'ok', restoreReason, {
      requestId: newOpId(),
      targetType: 'configuration-restore',
      payloadDigest: downloaded.digest.replace(/^sha256:/, ''),
    });
    return { restoreId: rows[0].id, digest: downloaded.digest, ...preview };
  }

  async function applyRestore(actor, restoreId, body) {
    const restoreReason = auditReason(body?.reason);
    const restoreRows = await restRequest('configuration_restore', {
      query: `select=*&id=eq.${encodeURIComponent(restoreId)}`,
    });
    const restore = restoreRows[0];
    if (!restore || restore.status !== 'previewed') throw { code: 409, msg: 'restore preview is not available' };
    const expected = `RESTORE ${restore.backup_id}`;
    if (String(body?.confirmation || '').trim() !== expected) throw { code: 400, msg: `confirmation must exactly match ${expected}` };
    await restRequest('configuration_restore', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(restoreId)}&status=eq.previewed`,
      body: { status: 'applying', reason: restoreReason, error_code: null },
      prefer: 'return=minimal',
    });
    try {
      const downloaded = await readSnapshot(restore.backup_id);
      if (downloaded.digest !== restore.preview_digest) throw { code: 409, msg: 'backup changed after restore preview' };
      const result = await restRequest('rpc/restore_configuration_snapshot', {
        method: 'POST',
        body: { p_snapshot: downloaded.snapshot, p_actor: actor.sub },
      });
      const at = new Date().toISOString();
      const backupRows = await restRequest('configuration_backup', {
        query: `select=target_id&id=eq.${encodeURIComponent(restore.backup_id)}`,
      });
      await Promise.all([
        restRequest('configuration_restore', {
          method: 'PATCH',
          query: `id=eq.${encodeURIComponent(restoreId)}`,
          body: { status: 'restored', applied_at: at, error_code: null },
          prefer: 'return=minimal',
        }),
        backupRows[0] ? restRequest('external_backup_target', {
          method: 'PATCH',
          query: `id=eq.${encodeURIComponent(backupRows[0].target_id)}`,
          body: { last_restore_at: at, updated_at: at },
          prefer: 'return=minimal',
        }) : Promise.resolve(),
      ]);
      await logAudit(actor, 'external-configuration-restore-apply', restoreId, 'ok', restoreReason, {
        requestId: newOpId(),
        targetType: 'configuration-restore',
        payloadDigest: downloaded.digest.replace(/^sha256:/, ''),
      });
      return { restored: true, restoredAt: at, counts: result };
    } catch (error) {
      await restRequest('configuration_restore', {
        method: 'PATCH',
        query: `id=eq.${encodeURIComponent(restoreId)}`,
        body: { status: 'failed', error_code: error?.msg || 'configuration-restore-failed' },
        prefer: 'return=minimal',
      }).catch(() => undefined);
      throw error;
    }
  }

  return {
    applyRestore,
    backupNow,
    backups,
    createTarget,
    previewRestore,
    summary,
    targets,
    test,
  };
}

module.exports = {
  auditReason,
  compareSnapshots,
  createExternalChannelApi,
  normalizeTarget,
  publicTarget,
};
