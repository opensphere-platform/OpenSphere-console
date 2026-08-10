'use strict';

const SOURCE_NAMES = Object.freeze(['registry', 'release', 'gitea', 'his', 'owner']);

function classifyProjection(row) {
  const key = `${row.kind || ''} ${row.name || ''} ${row.payload?.owner || ''}`.toLowerCase();
  if (/registry|main-shell/.test(key)) return 'registry';
  if (/release|bom|installation-lock/.test(key)) return 'release';
  if (/gitea|change-control|state-change/.test(key)) return 'gitea';
  if (/\bhis\b|observability|telemetry/.test(key)) return 'his';
  return 'owner';
}

function projectionToRow(row, source, now = Date.now()) {
  const observedAt = row.observed_at instanceof Date ? row.observed_at.toISOString() : String(row.observed_at || new Date(now).toISOString());
  const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at || observedAt);
  return {
    source,
    kind: String(row.kind || 'ControlPlaneAuthority'),
    namespace: String(row.namespace || ''),
    name: String(row.name || ''),
    authority_uid: `${source}/${row.kind || 'authority'}/${row.namespace || ''}/${row.name || ''}`,
    resource_version: row.resource_version || null,
    health: Date.parse(expiresAt) > now ? String(row.health || 'Unknown') : 'Unknown',
    payload: row.payload || {},
    observed_at: observedAt,
    expires_at: expiresAt,
  };
}

/**
 * Converts the already-sanitized owner/runtime projection into independently
 * fresh adapter batches. Missing sources are NotConfigured, not outages.
 */
function projectAuthorityAdapters(rows, now = Date.now()) {
  const grouped = new Map(SOURCE_NAMES.map((source) => [source, []]));
  for (const row of rows || []) {
    if (!row?.name) continue;
    const source = classifyProjection(row);
    grouped.get(source).push(projectionToRow(row, source, now));
  }
  return SOURCE_NAMES.map((source) => {
    const sourceRows = grouped.get(source);
    const configured = sourceRows.length > 0;
    const complete = configured && sourceRows.every((row) => Date.parse(row.expires_at) > now);
    return {
      source, configured, snapshotComplete: complete,
      epistemicState: !configured ? 'unknown' : (complete ? 'known' : 'stale'),
      blockerCode: !configured ? 'not_configured' : (complete ? null : 'source_projection_stale'),
      rows: sourceRows,
    };
  });
}

module.exports = { SOURCE_NAMES, classifyProjection, projectionToRow, projectAuthorityAdapters };
