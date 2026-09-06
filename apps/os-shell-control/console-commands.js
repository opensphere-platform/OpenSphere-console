'use strict';
// Native installation is available before extensions. Providers cannot select
// these fixed C_API routes or add privilege definitions to the control plane.
const { createHash } = require('node:crypto');
const { validateSchema } = require('./command-schema');
const text = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const commands = [
  { id: 'console.modules.catalog', description: 'Read the verified official module catalog and current registrations.', read: true, argumentSchema: object({}) },
  { id: 'console.modules.inspect', description: 'Inspect an exact catalog module and revision before installation. No cluster change.', read: true,
    argumentSchema: object({ descriptorId: text(128, { minLength: 1 }), catalogRevision: text(71, { format: 'sha256' }) }) },
  { id: 'console.modules.install', description: 'Install the reviewed official module through the Extension Controller. Accepted is not complete; query its operation ID.', read: false,
    argumentSchema: object({ descriptorId: text(128, { minLength: 1 }), catalogRevision: text(71, { format: 'sha256' }), reason: text(500, { minLength: 8 }) }), statusCommand: 'console.modules.operation' },
  { id: 'console.modules.operation', description: 'Read an existing installation operation. Verified proves package installation, not all product functions.', read: true,
    argumentSchema: object({ operationId: text(36, { format: 'uuid' }) }) },
];
for (const command of commands) validateSchema(command.argumentSchema);
const definitions = Object.freeze(Object.fromEntries(commands.map(d => [d.id, Object.freeze({ ...d, owner: 'console', native: true,
  fields: Object.keys(d.argumentSchema.properties), requiredPermission: 'console.extension.install' })])));
function target(command, args, actor, requestId) {
  switch (command) {
    case 'console.modules.catalog': return { method: 'GET', path: '/api/admin/extensions/catalog' };
    case 'console.modules.inspect': return { method: 'POST', path: '/api/admin/extensions/inspect', body: args };
    case 'console.modules.install': return { method: 'POST', path: '/api/admin/extensions/install', body: args,
      idempotencyKey: 'os-shell-install-' + createHash('sha256').update(JSON.stringify([actor.subjectId, requestId, command])).digest('hex') };
    case 'console.modules.operation': return { method: 'GET', path: '/api/platform/operations/' + args.operationId };
    default: throw Object.assign(new Error('Native command not found'), { status: 404, code: 'CommandNotFound' });
  }
}
module.exports = { definitions, target };
