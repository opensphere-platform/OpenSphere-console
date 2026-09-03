import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {verifyManualSeed} from './verify-manual-seed.mjs';
const seed = JSON.parse(readFileSync(new URL('../apps/osaa-gateway/manual-seeds/opensphere-core-manuals.json', import.meta.url), 'utf8'));
test('committed Manual snapshot and repository-owned source documents agree', () => {
  assert.equal(verifyManualSeed(seed).status, 'passed');
});
test('Manual body substitution without its checksum is rejected', () => {
  const altered = structuredClone(seed); altered.documents[0].content += '\nsubstituted policy';
  assert.throws(() => verifyManualSeed(altered), /document checksum mismatch/);
});
test('Manual version substitution and orphaned source references are rejected', () => {
  const altered = structuredClone(seed); altered.version = 'sha256:' + '0'.repeat(64);
  assert.throws(() => verifyManualSeed(altered), /version checksum mismatch/);
  const orphan = structuredClone(seed); orphan.concepts[0].sourceIds = ['retired/missing-document'];
  assert.throws(() => verifyManualSeed(orphan), /concept source is missing/);
});
test('Manual duplicate IDs and invalid graph endpoints are rejected', () => {
  const duplicate = structuredClone(seed); duplicate.documents.push(duplicate.documents[0]);
  assert.throws(() => verifyManualSeed(duplicate), /identifier is invalid or duplicated/);
  const orphan = structuredClone(seed); orphan.relations[0].toId = 'concept:retired';
  assert.throws(() => verifyManualSeed(orphan), /relation source or endpoint is missing/);
});
