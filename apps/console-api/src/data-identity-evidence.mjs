import { open } from 'node:fs/promises';

const DOMAINS = ['supabaseDatabase', 'supabaseStorage', 'gitea'];
const ASSERTIONS = {
  supabaseDatabase: ['auth.users restored', 'console authority subjects restored', 'console audit events restored', 'migration ledger restored', 'console RLS tables restored'],
  supabaseStorage: ['restored object files'],
  gitea: ['gitea users restored', 'gitea repositories restored', 'gitea repository git heads restored', 'gitea private configuration restored'],
};
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

export function projectRecoveryEvidence(raw, { now = new Date(), migration = null } = {}) {
  const observedAt = now.toISOString();
  const invalid = reasonCode => ({ state: 'Unknown', reasonCode, observedAt, generatedAt: null, maxAgeSeconds: null, domains: [] });
  if (!raw) return invalid('RecoveryEvidenceUnavailable');
  if (raw.schemaVersion !== 'v3' || !iso(raw.generatedAt)) return invalid('RecoveryEvidenceInvalid');
  const maxAge = raw.policy?.maxEvidenceAgeSeconds;
  if (!Number.isInteger(maxAge) || maxAge < 300 || maxAge > 2592000
      || raw.policy?.targetMode !== 'isolated-non-destructive-drill') return invalid('RecoveryPolicyInvalid');
  const fresh = value => iso(value) !== null && Date.parse(value) <= now.getTime()
    && now.getTime() - Date.parse(value) <= maxAge * 1000;
  const generatedFresh = fresh(raw.generatedAt);
  const backup = { supabaseDatabase: raw.backup?.supabase?.database, supabaseStorage: raw.backup?.supabase?.storage, gitea: raw.backup?.gitea };
  const restore = { supabaseDatabase: raw.restore?.supabase, supabaseStorage: raw.restore?.storage, gitea: raw.restore?.gitea };
  const domains = DOMAINS.map(domain => {
    const b = backup[domain] || {}, r = restore[domain] || {};
    const checks = ASSERTIONS[domain].map(assertion => {
      const matches = Array.isArray(r.checks) ? r.checks.filter(c => c?.assertion === assertion) : [];
      const c = matches.length === 1 ? matches[0] : null;
      const minimum = assertion === 'console audit events restored' ? 0 : assertion === 'console RLS tables restored' ? 16 : 1;
      const observed = c && /^\d{1,15}$/.test(String(c.observed)) ? Number(c.observed) : null;
      const verified = c?.verdict === 'Verified' && observed !== null && observed >= minimum;
      // Fixed assertion labels and numeric values only; never forward arbitrary owner strings.
      return { assertion, expected: `>=${minimum}`, observed, state: verified ? 'Ready' : 'Unknown' };
    });
    const migrationMatches = domain !== 'supabaseDatabase' || Boolean(migration?.baselineRevision && migration?.setDigest
      && r.migration?.globalId === migration.baselineRevision && r.migration?.setDigest === migration.setDigest
      && r.migration?.count === migration.migrationCount);
    const backupReady = generatedFresh && fresh(b.verifiedAt) && b.verified === true && sha(b.sha256);
    const restoreReady = backupReady && fresh(r.verifiedAt) && Date.parse(r.verifiedAt) >= Date.parse(b.verifiedAt) && r.state === 'Verified'
      && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(String(r.operationId || ''))
      && checks.every(c => c.state === 'Ready') && migrationMatches;
    return { domain, backupState: backupReady ? 'Ready' : 'Unknown', restoreState: restoreReady ? 'Ready' : 'Unknown',
      backupVerifiedAt: iso(b.verifiedAt), restoreVerifiedAt: iso(r.verifiedAt),
      checksumRecorded: sha(b.sha256), checks,
      reasonCode: !generatedFresh ? 'RecoveryEvidenceStale' : !backupReady ? 'BackupUnverified'
        : !migrationMatches ? 'RestoreMigrationMismatch' : !restoreReady ? 'RestoreUnverified' : null };
  });
  return { state: domains.every(d => d.backupState === 'Ready' && d.restoreState === 'Ready') ? 'Ready' : 'Degraded',
    reasonCode: generatedFresh ? null : 'RecoveryEvidenceStale', observedAt, generatedAt: iso(raw.generatedAt), maxAgeSeconds: maxAge, domains };
}

export function createRecoveryEvidenceReader({ path = '/var/run/opensphere/recovery/recovery-evidence.json', now = () => new Date() } = {}) {
  return Object.freeze({ async observe(migration) {
    let handle;
    try {
      handle = await open(path, 'r');
      const buffer = Buffer.alloc(128 * 1024 + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > 128 * 1024) throw new Error('oversized');
      return projectRecoveryEvidence(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')), { now: now(), migration });
    } catch (error) {
      const missing = error?.code === 'ENOENT';
      return { ...projectRecoveryEvidence(null, { now: now() }), reasonCode: missing ? 'RecoveryEvidenceUnavailable' : 'RecoveryEvidenceInvalid' };
    } finally { await handle?.close(); }
  } });
}
