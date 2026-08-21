'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { durableBindingRequest, durableIdempotencyKey } = require('./r2d2-durable-binding');

test('only the initial closed management scenarios map to durable operations', () => {
  assert.deepEqual(durableBindingRequest({ toolId: 'osaa.k8s.workload.restart' },
    { namespace: 'opensphere-console', name: 'console' }),
  { action: 'restart-workload', target: { namespace: 'opensphere-console', name: 'console' } });
  assert.deepEqual(durableBindingRequest({ toolId: 'osaa.notification.delivery.retry' }, { deliveryId: 'delivery-1' }),
    { action: 'retry-delivery', target: { deliveryId: 'delivery-1' } });
  assert.equal(durableBindingRequest({ toolId: 'osaa.k8s.resource.delete' }, {}), null);
});

test('durable idempotency is stable for one human and distinct across actors', () => {
  const input = { bindingId: 'restart', action: 'restart-workload', target: { uid: 'uid-1' },
    confirmation: 'restart deployment opensphere-console/console' };
  const first = durableIdempotencyKey({ ...input, actor: { subject: 'user-1' } });
  assert.match(first, /^r2d2:sha256:[0-9a-f]{64}$/);
  assert.equal(first, durableIdempotencyKey({ ...input, actor: { subject: 'user-1' } }));
  assert.notEqual(first, durableIdempotencyKey({ ...input, actor: { subject: 'user-2' } }));
  assert.throws(() => durableIdempotencyKey({ ...input, actor: {} }), /authenticated subject/);
});
