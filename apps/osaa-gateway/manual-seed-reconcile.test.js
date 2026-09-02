const test = require('node:test');
const assert = require('node:assert/strict');
const {
  manualSeedStructureDiff,
  relationId,
  seedItemChecksum,
  seedOwnershipMetadata,
} = require('./manual-seed-reconcile');

test('manual seed checksums are canonical across object key order', () => {
  assert.equal(
    seedItemChecksum({ id: 'concept:a', tags: ['a', 'b'], nested: { z: 1, a: 2 } }),
    seedItemChecksum({ nested: { a: 2, z: 1 }, tags: ['a', 'b'], id: 'concept:a' }),
  );
});

test('manual structure reconciliation detects same-count changes and removals', () => {
  const conceptA = { id: 'concept:a', name: 'A', definition: 'new definition' };
  const conceptB = { id: 'concept:b', name: 'B' };
  const relation = { fromId: 'concept:a', relation: 'depends-on', toId: 'concept:b' };
  const manifest = { concepts: [conceptA, conceptB], relations: [relation] };
  const current = {
    concepts: [
      { id: 'concept:a', seedChecksum: seedItemChecksum({ ...conceptA, definition: 'old definition' }) },
      { id: 'concept:retired', seedChecksum: seedItemChecksum({ id: 'concept:retired' }) },
    ],
    relations: [{ id: relationId(relation), seedChecksum: seedItemChecksum(relation) }],
  };
  const diff = manualSeedStructureDiff(manifest, current);
  assert.deepEqual(diff.concepts.missing, ['concept:b']);
  assert.deepEqual(diff.concepts.changed, ['concept:a']);
  assert.deepEqual(diff.concepts.stale, ['concept:retired']);
  assert.deepEqual(diff.relations, { missing: [], changed: [], stale: [] });
  assert.equal(diff.needsReconcile, true);
});

test('seed ownership metadata ties structural rows to the declarative manifest', () => {
  const raw = { id: 'concept:a', name: 'A' };
  assert.deepEqual(seedOwnershipMetadata(raw, 'opensphere-core-manuals', 'manual-concept.opensphere.io/v1alpha1'), {
    schema: 'manual-concept.opensphere.io/v1alpha1',
    seedSourceId: 'opensphere-core-manuals',
    seedChecksum: seedItemChecksum(raw),
  });
});
