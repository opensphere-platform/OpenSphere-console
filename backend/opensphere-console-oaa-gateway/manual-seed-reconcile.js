const { createHash } = require('crypto');

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function seedItemChecksum(value) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value ?? null))).digest('hex');
}

function relationId(value = {}) {
  const fromId = String(value.fromId || value.from_id || '').trim();
  const toId = String(value.toId || value.to_id || '').trim();
  const relation = String(value.relation || '').trim();
  return String(value.id || (fromId && toId && relation ? `relation:${fromId}:${relation}:${toId}` : '')).trim();
}

function expectedItems(items, idFor) {
  const out = new Map();
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = idFor(raw);
    if (id) out.set(id, seedItemChecksum(raw));
  }
  return out;
}

function currentItems(rows) {
  return new Map((Array.isArray(rows) ? rows : []).map((row) => [
    String(row.id || '').trim(),
    String(row.seedChecksum || row.seed_checksum || row.checksum || '').trim(),
  ]).filter(([id]) => id));
}

function collectionDiff(expected, current) {
  const missing = [];
  const changed = [];
  const stale = [];
  for (const [id, checksum] of expected) {
    if (!current.has(id)) missing.push(id);
    else if (current.get(id) !== checksum) changed.push(id);
  }
  for (const id of current.keys()) {
    if (!expected.has(id)) stale.push(id);
  }
  return { missing: missing.sort(), changed: changed.sort(), stale: stale.sort() };
}

function manualSeedStructureDiff(manifest = {}, current = {}) {
  const concepts = collectionDiff(
    expectedItems(manifest.concepts, (value) => String(value.id || '').trim()),
    currentItems(current.concepts),
  );
  const relations = collectionDiff(
    expectedItems(manifest.relations, relationId),
    currentItems(current.relations),
  );
  return {
    concepts,
    relations,
    needsReconcile: [concepts, relations].some((value) => value.missing.length || value.changed.length || value.stale.length),
  };
}

function seedOwnershipMetadata(raw, seedSourceId, schema) {
  return {
    schema,
    seedSourceId: String(seedSourceId || 'manual-seed').trim() || 'manual-seed',
    seedChecksum: seedItemChecksum(raw),
  };
}

module.exports = {
  canonicalValue,
  manualSeedStructureDiff,
  relationId,
  seedItemChecksum,
  seedOwnershipMetadata,
};
