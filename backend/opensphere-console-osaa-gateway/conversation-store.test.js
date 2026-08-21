'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  MAX_CONTEXT_CHARS,
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
  assert.ok(window.length <= 80);
  assert.ok(window.reduce((total, item) => total + item.content.length, 0) <= MAX_CONTEXT_CHARS + 1000);
  assert.equal(window.some((item) => item.content === 'failed output'), false);
  const previousNumbers = window.slice(0, -1).map((item) => Number(item.content.match(/^m(\d+)-/)[1]));
  assert.deepEqual(previousNumbers, [...previousNumbers].sort((a, b) => a - b));
});

test('one conversation serializes turns before provider execution', () => {
  const source = readFileSync(require.resolve('./conversation-store'), 'utf8');
  assert.match(source, /role='user' AND status='pending'/);
  assert.match(source, /turn_request_id<>\$2/);
  assert.match(source, /another conversation turn is still in progress/);
});

test('gateway runtime image contains the durable conversation store', () => {
  const dockerfile = readFileSync(join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY conversation-store\.js \/app\/conversation-store\.js$/m);
});
