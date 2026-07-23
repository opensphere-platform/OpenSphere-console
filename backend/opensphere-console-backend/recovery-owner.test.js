const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRecoveryOwnerStatus,
  buildRecoveryPlan,
  normalizedRecoveryEvidence,
} = require('./recovery-owner');

const verifiedCheck = (assertion) => ({ assertion, expected: '>=1', observed: '3', verdict: 'Verified' });
const raw = {
  schemaVersion: 'v2',
  generatedAt: '2026-07-23T00:00:00Z',
  policy: { maxEvidenceAgeSeconds: 86400 },
  backup: {
    supabase: { database: { sha256: 'a'.repeat(64), verified: true }, storage: { sha256: 'b'.repeat(64), verified: true } },
    gitea: { sha256: 'c'.repeat(64), verified: true },
  },
  restore: {
    supabase: { state: 'Verified', checks: [verifiedCheck('users')] },
    storage: { state: 'Verified', checks: [verifiedCheck('canary object')] },
    gitea: { state: 'Verified', checks: [verifiedCheck('repositories')] },
  },
};

test('recovery owner exposes verification state without vault coordinates or checksum values', () => {
  const normalized = normalizedRecoveryEvidence({ ...raw, backup: { ...raw.backup, locationRef: 'private://vault' } }, '2026-07-23T01:00:00Z');
  const encoded = JSON.stringify(normalized);
  assert.equal(normalized.freshness.fresh, true);
  assert.equal(normalized.backup.gitea.checksumRecorded, true);
  assert.doesNotMatch(encoded, /private:\/\/vault|"sha256"|a{32}/);
});

test('a successful declaration cannot overrule incomplete restore assertions', () => {
  const evidence = normalizedRecoveryEvidence({
    ...raw,
    restore: { ...raw.restore, storage: { state: 'Verified', checks: [{ assertion: 'objects', expected: '>=1', observed: '0', verdict: 'InsufficientEvidence' }] } },
  }, '2026-07-23T01:00:00Z');
  const status = buildRecoveryOwnerStatus(evidence, { executorAvailable: true });
  assert.equal(evidence.restore.supabaseStorage.state, 'AttentionRequired');
  assert.ok(status.blockers.includes('supabaseStorage_restore_unverified'));
  assert.equal(status.ready, false);
});

test('read and plan capabilities stay available while execution fails closed', () => {
  const evidence = normalizedRecoveryEvidence(raw, '2026-07-23T01:00:00Z');
  const status = buildRecoveryOwnerStatus(evidence);
  const plan = buildRecoveryPlan(evidence, 'gitea');
  assert.deepEqual(status.capabilities, ['status-read', 'plan-read']);
  assert.equal(status.execution.available, false);
  assert.ok(status.blockers.includes('recovery_drill_executor_unavailable'));
  assert.equal(plan.executable, false);
  assert.match(plan.steps.map((step) => step.description).join(' '), /repositories, LFS data/);
  assert.throws(() => buildRecoveryPlan(evidence, 'production'), (error) => error?.code === 400 && /component must be one of/.test(error?.msg));
});
