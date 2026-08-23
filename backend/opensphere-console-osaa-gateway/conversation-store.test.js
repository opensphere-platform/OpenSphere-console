'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  DEFAULT_RETENTION_DAYS,
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_MESSAGES,
  TURN_LEASE_SECONDS,
  contextWindow,
  conversationId,
  firstTurnTitle,
  messageContent,
  ownerId,
  requestId,
  title,
} = require('./conversation-store');

test('OSAA identifiers and bounded user input fail closed', () => {
  assert.equal(ownerId({ subject: 'user-123' }), 'user-123');
  assert.throws(() => ownerId({}), /subject is required/);
  assert.equal(conversationId('8FD10F3B-4F82-4ACD-87BC-E81E259578A8'), '8fd10f3b-4f82-4acd-87bc-e81e259578a8');
  assert.throws(() => conversationId('legacy-session'), /UUID/);
  assert.equal(requestId('0cf375ab-4832-46e4-a5f5-d19879ac8bb7'), '0cf375ab-4832-46e4-a5f5-d19879ac8bb7');
  assert.throws(() => requestId(''), /UUID/);
  assert.equal(messageContent('  hello  '), 'hello');
  assert.throws(() => messageContent('   '), /message is required/);
  assert.throws(
    () => messageContent('x'.repeat(MAX_CONTEXT_CHARS + 1)),
    (error) => error.code === 413 && error.errorCode === 'osaa_context_too_large',
  );
  assert.equal(title('  A   durable   title  '), 'A durable title');
  assert.equal(firstTurnTitle('첫 문장입니다.\n둘째 문장'), '첫 문장입니다.');
});

test('context window is chronological and bounded by server budget', () => {
  const rows = [];
  for (let index = 1; index <= 100; index += 1) {
    rows.push({ sequence: index, role: index % 2 ? 'user' : 'assistant', content: `m${index}-${'x'.repeat(900)}`, status: 'completed' });
  }
  rows.push({ sequence: 101, role: 'assistant', content: 'failed output', status: 'failed' });
  const window = contextWindow(rows, 'current request');
  assert.equal(window.at(-1).content, 'current request');
  assert.equal(window.at(-1).role, 'user');
  assert.equal(MAX_CONTEXT_MESSAGES, 24);
  assert.equal(MAX_CONTEXT_CHARS, 24000);
  assert.ok(window.length <= MAX_CONTEXT_MESSAGES);
  assert.ok(window.reduce((total, item) => total + item.content.length, 0) <= MAX_CONTEXT_CHARS);
  assert.equal(window.some((item) => item.content === 'failed output'), false);
  const previousNumbers = window.slice(0, -1).map((item) => Number(item.content.match(/^m(\d+)-/)[1]));
  assert.deepEqual(previousNumbers, [...previousNumbers].sort((a, b) => a - b));
});

test('one conversation serializes turns before provider execution', () => {
  const source = readFileSync(require.resolve('./conversation-store'), 'utf8');
  assert.match(source, /async function withActor/);
  assert.match(source, /set_config\('opensphere[.]actor_id'/);
  assert.match(source, /role='user' AND status='pending'/);
  assert.match(source, /turn_request_id<>\$2/);
  assert.match(source, /another conversation turn is still in progress/);
  assert.equal(TURN_LEASE_SECONDS, 120);
  assert.equal(DEFAULT_RETENTION_DAYS, 30);
  assert.match(source, /INSERT INTO osaa\.conversation\(id,owner_id,title,model_id,retention_days\)/);
  assert.match(source, /workerLeaseId = randomUUID\(\)/);
  assert.match(source, /attempt<\$4/);
  assert.match(source, /conversation_turn_attempt_limit/);
  assert.match(source, /reap_expired_dialogue_turns/);
  assert.match(source, /maintenancePoolProvider/);
  assert.doesNotMatch(source, /reap_expired_dialogue_turns\(\$1,\$2\)/);
  assert.match(source, /heartbeatTurn/);
  assert.match(source, /conversation_turn_lease_lost/);
  assert.match(source, /retryAfterSeconds/);
});

test('successful provider responses repair the conversation model projection', () => {
  const source = readFileSync(require.resolve('./conversation-store'), 'utf8');
  assert.match(source, /response\?\.modelAuthority === 'provider'/);
  assert.match(source, /SET model_id=COALESCE\(\$2,model_id\)/);
  assert.doesNotMatch(source, /response\?\.modelAuthority === 'execution-profile'[\s\S]*?SET model_id/);
});

test('gateway runtime image contains the durable conversation store', () => {
  const dockerfile = readFileSync(join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY conversation-store\.js \/app\/conversation-store\.js$/m);
  assert.match(dockerfile, /^COPY dialogue-state\.js \/app\/dialogue-state\.js$/m);
});

test('Dialogue State transition and assistant message share one fail-closed transaction', () => {
  const source = readFileSync(require.resolve('./conversation-store'), 'utf8');
  const complete = source.slice(source.indexOf('async function completeTurn'));
  assert.match(complete, /await client\.query\('BEGIN'\)/);
  assert.match(complete, /commitDialogueTransition\([\s\S]*?INSERT INTO osaa\.conversation_message/);
  assert.match(complete, /await client\.query\('COMMIT'\)/);
  assert.match(source, /INSERT INTO osaa\.dialogue_state_transition/);
  assert.match(source, /RETURNING revision/);
  assert.match(source, /osaa_dialogue_revision_conflict/);
  assert.doesNotMatch(source, /dialogue_state_transition[\s\S]*?ON CONFLICT[^;]*DO NOTHING/);
  const server = readFileSync(join(__dirname, 'server.js'), 'utf8');
  assert.match(server, /function dialogueTransitionForToolResult/);
  assert.match(server, /r2d2[.]foundation-postgres-status\/v1/);
  assert.match(server, /r2d2[.]foundation-postgres-intake\/v1/);
  assert.match(server, /intent: 'status[.]read'/);
  assert.match(server, /intent: 'create[.]plan'/);
  assert.match(server, /intent: 'operation[.]watch'/);
  assert.match(source, /operationRef: row\.operation_ref \|\| null/);
  assert.match(source, /targetRef: row\.target_ref \|\| null/);
  assert.match(source, /SELECT domain,intent,phase,target_ref,capability_ref,operation_ref,revision,state_digest/);
  assert.match(server, /initializeConversationLeaseReaper/);
  assert.match(server, /conversationRecoveryMatch/);
  assert.match(server, /conversation turn recovery requires MFA assurance aal2/);
  assert.match(server, /recover dialogue turn \$\{conversationRecoveryMatch\[1\]\}\/\$\{conversationRecoveryMatch\[2\]\}/);
  assert.match(server, /retry-after/);
});
