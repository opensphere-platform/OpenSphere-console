import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateSupabaseReadiness } from './platform-readiness.model.ts';

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