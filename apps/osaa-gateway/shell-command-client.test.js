'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createShellCommandClient, renderShellResults } = require('./shell-command-client');
const actor = { subject: '11111111-1111-4111-8111-111111111111', bearerToken: 'test-current-user' };
const context = { sessionId: '22222222-2222-4222-8222-222222222222', clientRequestId: '33333333-3333-4333-8333-333333333333', userInstruction: '요청한 모듈을 설치해줘' };
const definition = owner => ({ id: owner + '.install', owner, description: 'Install the requested owned capability', allowed: true, mutation: true,
  statusCommand: owner + '.inspect', argumentSchema: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 8, maxLength: 500 } } } });
function fixture() {
  const commands = [definition('first-owner')], requests = [];
  const client = createShellCommandClient({ baseUrl: 'http://shell.test', fetchImpl: async (url, init) => {
    assert.equal(url, 'http://shell.test/api/os-shell/commands');
    if (init.method === 'GET') return Response.json({ schema: 'opensphere.shell-command-catalog/v1', controlPlane: 'OS-Shell', observedAt: new Date().toISOString(), commands });
    const body = JSON.parse(init.body); requests.push(body);
    return Response.json({ schema: 'opensphere.shell-command/v1', controlPlane: 'OS-Shell', command: body.command, owner: body.command.split('.')[0], requestId: body.requestId,
      operationId: 'operation-id', data: { operation: { id: 'operation-id', phase: 'Queued' } } });
  } });
  return { client, commands, requests };
}
test('22 discovers a newly installed owner without a module ID or repository change in its client', async () => {
  const f = fixture(); f.commands.push(definition('new-owner'));
  const list = await f.client.describe(actor, {}); assert.deepEqual(list.commands.map(c => c.owner), ['first-owner', 'new-owner']);
  const detail = (await f.client.describe(actor, { command: 'new-owner.install' })).commands[0];
  assert.equal(detail.arguments.additionalProperties, false);
  const input = { command: detail.id, contractRevision: detail.contractRevision, argumentsJson: JSON.stringify({ reason: 'requested installation' }) };
  const result = await f.client.execute(actor, input, context);
  assert.equal(result.owner, 'new-owner'); assert.equal(result.data.operation.phase, 'Queued');
  await f.client.execute(actor, input, context);
  assert.equal(f.requests[0].requestId, f.requests[1].requestId);
  await f.client.execute(actor, input, { ...context, clientRequestId: '44444444-4444-4444-8444-444444444444' });
  assert.notEqual(f.requests[1].requestId, f.requests[2].requestId);
  const rendered = renderShellResults([{ tool: 'execute_os_shell_command', result }]);
  assert.match(rendered, /Queued/); assert.match(rendered, /접수 상태/);
  const partial = renderShellResults([{ tool: 'execute_os_shell_command', result }, { tool: 'execute_os_shell_command', result: { error: 'owner unavailable' } }]);
  assert.match(partial, /후속 명령 실패 또는 결과 미확인/); assert.match(partial, /owner unavailable/);
});
test('contract changes, permission revocation and missing trusted turn context block submission', async () => {
  const f = fixture(), detail = (await f.client.describe(actor, { command: 'first-owner.install' })).commands[0];
  const input = { command: detail.id, contractRevision: detail.contractRevision, argumentsJson: '{"reason":"requested installation"}' };
  await assert.rejects(f.client.execute(actor, input, {}), { code: 403 });
  f.commands[0].description = 'Updated contract';
  await assert.rejects(f.client.execute(actor, input, context), { code: 409 });
  f.commands[0].allowed = false;
  await assert.rejects(f.client.execute(actor, input, context), { code: 403 });
  f.commands.length = 0;
  await assert.rejects(f.client.execute(actor, input, context), { code: 403 });
  assert.equal(f.requests.length, 0);
});
