const RECOVERY_COMPONENTS = Object.freeze(['all', 'supabase-database', 'supabase-storage', 'gitea']);
const RECOVERY_OWNER_CAPABILITIES = Object.freeze(['status-read', 'plan-read']);

function bounded(value, maximum = 240) {
  return String(value ?? '').slice(0, maximum);
}

function normalizedCheck(item) {
  const verdict = ['Verified', 'InsufficientEvidence', 'Failed'].includes(String(item?.verdict))
    ? String(item.verdict)
    : 'InsufficientEvidence';
  return {
    assertion: bounded(item?.assertion || 'unnamed assertion', 120),
    expected: bounded(item?.expected ?? 'recorded', 120),
    observed: bounded(item?.observed ?? 'unknown', 120),
    verdict,
  };
}

function normalizedRestoreUnit(value) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const checks = (Array.isArray(row.checks) ? row.checks : []).slice(0, 20).map(normalizedCheck);
  const attention = !checks.length || checks.some((item) => item.verdict !== 'Verified');
  return {
    state: attention ? 'AttentionRequired' : (String(row.state || 'Unknown') === 'Verified' ? 'Verified' : 'AttentionRequired'),
    declaredState: bounded(row.state || 'Unknown', 40),
    verifiedAt: row.verifiedAt || null,
    assertions: (Array.isArray(row.assertions) ? row.assertions : []).slice(0, 20).map((item) => bounded(item)),
    checks,
    evidenceQuality: attention ? 'insufficient' : 'verified',
  };
}

function normalizedBackupUnit(value) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    verified: row.verified === true,
    checksumRecorded: typeof row.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(row.sha256),
  };
}

function normalizedRecoveryEvidence(value, observedAt = new Date().toISOString()) {
  const evidence = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const maxEvidenceAgeSeconds = Number(evidence?.policy?.maxEvidenceAgeSeconds);
  const generatedAtMs = Date.parse(evidence.generatedAt || '');
  const observedAtMs = Date.parse(observedAt || '');
  const ageSeconds = Number.isFinite(generatedAtMs) && Number.isFinite(observedAtMs)
    ? Math.max(0, Math.floor((observedAtMs - generatedAtMs) / 1000))
    : null;
  const freshnessPolicyConfigured = Number.isInteger(maxEvidenceAgeSeconds) && maxEvidenceAgeSeconds >= 300 && maxEvidenceAgeSeconds <= 2592000;
  return {
    available: Boolean(evidence.generatedAt),
    schemaVersion: bounded(evidence.schemaVersion || 'unknown', 40),
    generatedAt: evidence.generatedAt || null,
    observedAt,
    freshness: {
      ageSeconds,
      maxAgeSeconds: freshnessPolicyConfigured ? maxEvidenceAgeSeconds : null,
      policyConfigured: freshnessPolicyConfigured,
      fresh: freshnessPolicyConfigured && ageSeconds !== null && ageSeconds <= maxEvidenceAgeSeconds,
    },
    backup: {
      // Vault paths and raw checksum values are deliberately omitted. The
      // Agent needs verification state, not recovery-vault coordinates.
      supabaseDatabase: normalizedBackupUnit(evidence?.backup?.supabase?.database),
      supabaseStorage: normalizedBackupUnit(evidence?.backup?.supabase?.storage),
      gitea: normalizedBackupUnit(evidence?.backup?.gitea),
    },
    restore: {
      supabaseDatabase: normalizedRestoreUnit(evidence?.restore?.supabase),
      supabaseStorage: normalizedRestoreUnit(evidence?.restore?.storage),
      gitea: normalizedRestoreUnit(evidence?.restore?.gitea),
    },
    legacyDecommission: {
      approved: evidence?.decommission?.approved === true,
      completedAt: evidence?.decommission?.completedAt || null,
    },
  };
}

function componentBlockers(evidence) {
  const blockers = [];
  if (!evidence.available) blockers.push('recovery_evidence_unavailable');
  if (!evidence.freshness.policyConfigured) blockers.push('recovery_freshness_policy_missing');
  else if (!evidence.freshness.fresh) blockers.push('recovery_evidence_stale');
  for (const [component, backup] of Object.entries(evidence.backup || {})) {
    if (!backup.verified || !backup.checksumRecorded) blockers.push(`${component}_backup_unverified`);
  }
  for (const [component, restore] of Object.entries(evidence.restore || {})) {
    if (restore.state !== 'Verified' || restore.evidenceQuality !== 'verified') blockers.push(`${component}_restore_unverified`);
  }
  return blockers;
}

function buildRecoveryOwnerStatus(rawEvidence, options = {}) {
  const evidence = rawEvidence?.restore && rawEvidence?.backup && rawEvidence?.freshness
    ? rawEvidence
    : normalizedRecoveryEvidence(rawEvidence, options.observedAt);
  const executorAvailable = options.executorAvailable === true;
  const blockers = componentBlockers(evidence);
  if (!executorAvailable) blockers.push('recovery_drill_executor_unavailable');
  return {
    apiVersion: 'opensphere.io/oaa-recovery-owner/v1',
    owner: 'Console Platform Recovery / Supabase + Gitea',
    observedAt: evidence.observedAt || options.observedAt || new Date().toISOString(),
    capabilities: [...RECOVERY_OWNER_CAPABILITIES],
    ready: blockers.length === 0,
    blockers,
    evidence,
    execution: {
      available: executorAvailable,
      mode: 'isolated-non-destructive-drill',
      approval: 'AAL2 + exact confirmation + independent Gitea approval',
      reason: executorAvailable ? null : 'No signed recovery-drill executor is configured.',
    },
  };
}

function planSteps(component) {
  const shared = [
    'Resolve only an owner-staged external recovery-vault reference; never accept archive bytes, credentials, or a raw URL in chat.',
    'Create or reset a disposable recovery namespace without changing production consumers.',
  ];
  const steps = {
    'supabase-database': [
      ...shared,
      'Restore PostgreSQL into an isolated Supabase target and run schema migrations with digest-pinned images.',
      'Verify auth users, Console operators, audit-chain continuity, and migration version assertions.',
    ],
    'supabase-storage': [
      ...shared,
      'Restore Storage metadata and object bytes together into an isolated target.',
      'Verify a predeclared canary object by bucket, size, and digest without returning its content.',
    ],
    gitea: [
      ...shared,
      'Restore the Gitea database, repositories, LFS data, private configuration, and signing identity into an isolated target.',
      'Verify user, repository, issue, signed-history, and branch-protection assertions before starting the target service.',
    ],
  };
  return component === 'all'
    ? [...steps['supabase-database'], ...steps['supabase-storage'].slice(2), ...steps.gitea.slice(2)]
    : steps[component];
}

function buildRecoveryPlan(rawEvidence, component = 'all', options = {}) {
  const selected = String(component || 'all').trim().toLowerCase();
  if (!RECOVERY_COMPONENTS.includes(selected)) throw { code: 400, msg: `component must be one of ${RECOVERY_COMPONENTS.join(', ')}` };
  const status = buildRecoveryOwnerStatus(rawEvidence, options);
  const selectedKeys = selected === 'all'
    ? ['supabaseDatabase', 'supabaseStorage', 'gitea']
    : [{ 'supabase-database': 'supabaseDatabase', 'supabase-storage': 'supabaseStorage', gitea: 'gitea' }[selected]];
  const selectedState = Object.fromEntries(selectedKeys.map((key) => [key, {
    backup: status.evidence.backup[key],
    restore: status.evidence.restore[key],
  }]));
  return {
    apiVersion: 'opensphere.io/oaa-recovery-plan/v1',
    owner: status.owner,
    component: selected,
    targetMode: 'isolated-non-destructive-drill',
    executable: status.execution.available,
    blockers: status.blockers,
    selectedState,
    steps: planSteps(selected).map((description, index) => ({ order: index + 1, description })),
    completionGate: 'A separate reviewed change may promote structured evidence only after every assertion is independently verified.',
  };
}

module.exports = {
  RECOVERY_COMPONENTS,
  RECOVERY_OWNER_CAPABILITIES,
  buildRecoveryOwnerStatus,
  buildRecoveryPlan,
  normalizedRecoveryEvidence,
};
