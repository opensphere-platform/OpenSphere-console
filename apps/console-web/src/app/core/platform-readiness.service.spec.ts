import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateReleaseLockReadiness, evaluateSupabaseReadiness } from './platform-readiness.model.ts';

test('Supabase readiness consumes the target ReadEnvelope data projection', () => {
  assert.deepEqual(evaluateSupabaseReadiness({
    schemaVersion: '1.0',
    authority: 'Supabase',
    freshness: 'fresh',
    data: {
      components: [
        { component: 'auth', state: 'Ready' },
        { component: 'dataApi', state: 'Ready' },
        { component: 'storage', state: 'Ready' },
      ],
    },
  }), { ready: true, detail: '3/3 services Ready' });
});

test('Supabase readiness fails closed for partial or legacy top-level evidence', () => {
  assert.deepEqual(evaluateSupabaseReadiness({
    data: { components: [{ component: 'auth', state: 'Ready' }, { component: 'storage', state: 'Unknown' }] },
  }), { ready: false, detail: '1/2 services Ready' });
  assert.deepEqual(evaluateSupabaseReadiness({
    components: [{ component: 'auth', ready: true }],
  }), { ready: false, detail: 'Supabase component evidence is absent' });
});
test('Release readiness trusts the validated installed lock independently from the optional executor', () => {
  const digest = 'sha256:' + 'a'.repeat(64);
  assert.deepEqual(evaluateReleaseLockReadiness({
    current: { channel: 'edge', releaseDigest: digest },
    execution: { ready: false, state: 'Unavailable', blocker: 'platform_release_owner_not_target_ready' },
  }), {
    ready: true,
    detail: `Installed edge release · ${digest.slice(0, 19)}… · separate executor Unavailable`,
  });
});

test('Release readiness fails closed without a canonical installed lock digest', () => {
  assert.deepEqual(evaluateReleaseLockReadiness({
    current: { channel: 'edge', releaseDigest: 'latest' },
    execution: { ready: true, state: 'Ready' },
  }), { ready: false, detail: 'Installed release lock evidence is incomplete' });
});