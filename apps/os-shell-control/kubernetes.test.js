'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { validatedRuntimeIdentity } = require('./kubernetes');

const review = { status: { authenticated: true, audiences: ['opensphere-shell-runtime-bootstrap'], user: {
  username: 'system:serviceaccount:opensphere-shell-sessions:opensphere-shell-runtime', extra: {
    'authentication.kubernetes.io/pod-name': ['os-shell-a'], 'authentication.kubernetes.io/pod-uid': ['pod-uid'],
  },
} } };
test('accepts only the exact bound projected runtime identity', () => {
  assert.deepEqual(validatedRuntimeIdentity(review, { namespace: 'opensphere-shell-sessions', serviceAccount: 'opensphere-shell-runtime' }), {
    podName: 'os-shell-a', podUid: 'pod-uid', username: review.status.user.username,
  });
  assert.throws(() => validatedRuntimeIdentity({ status: { ...review.status, audiences: ['other'] } }, { namespace: 'opensphere-shell-sessions', serviceAccount: 'opensphere-shell-runtime' }), /rejected/);
});

test('Kubernetes readiness uses the reconciler Pod-list authority without broadening RBAC', async () => {
  let observed;
  const request = (options, callback) => { observed = options; const req = new (require('node:events').EventEmitter)();
    req.setTimeout = () => {}; req.end = () => { const res = new (require('node:events').EventEmitter)(); res.statusCode = 200; callback(res);
      process.nextTick(() => { res.emit('data', Buffer.from('{"items":[]}')); res.emit('end'); }); }; return req; };
  const { createKubernetesClient } = require('./kubernetes'); const client = createKubernetesClient({ host: 'kubernetes.test', token: 'sa', ca: Buffer.from('ca'), request });
  assert.deepEqual(await client.listPods('opensphere-shell-sessions', 1), { items: [] });
  assert.equal(observed.method, 'GET'); assert.equal(observed.path, '/api/v1/namespaces/opensphere-shell-sessions/pods?limit=1');
  assert.equal(observed.rejectUnauthorized, true);
});
