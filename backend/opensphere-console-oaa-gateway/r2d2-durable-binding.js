'use strict';

const { createHash } = require('crypto');

function durableBindingRequest(binding, inputs) {
  const toolId = binding?.toolId;
  if (toolId === 'oaa.k8s.workload.restart') return { action: 'restart-workload', target: { namespace: inputs.namespace, name: inputs.name } };
  if (toolId === 'oaa.k8s.workload.scale') return { action: 'scale-workload', target: { namespace: inputs.namespace, name: inputs.name, replicas: inputs.replicas } };
  if (toolId === 'oaa.k8s.workload.rollback-image') return { action: 'rollback-image', target: { namespace: inputs.namespace, name: inputs.name, container: inputs.container, image: inputs.image } };
  if (toolId === 'oaa.k8s.cronjob.run') return { action: 'run-cronjob', target: { namespace: inputs.namespace, name: inputs.name } };
  if (toolId === 'oaa.notification.delivery.retry') return { action: 'retry-delivery', target: { deliveryId: inputs.deliveryId } };
  if (toolId === 'oaa.his.lifecycle' && String(inputs.action || '').toLowerCase() === 'recover') return { action: 'owner-recover', target: { id: inputs.id } };
  return null;
}

function durableIdempotencyKey({ actor, bindingId, action, target, confirmation }) {
  const subject = String(actor?.subject || actor?.sub || '');
  if (!subject) throw Object.assign(new Error('durable binding requires an authenticated subject'), { code: 'ActorSubjectRequired' });
  const payload = JSON.stringify({ subject, bindingId, action, target, confirmation });
  return `r2d2:sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

module.exports = { durableBindingRequest, durableIdempotencyKey };
