'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSchema, validateValue } = require('./command-schema');
const shape = () => ({ type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: {
  id: { type: 'string', maxLength: 64, enum: ['cert-manager', 'ingress-nginx'] },
  reason: { type: 'string', minLength: 8, maxLength: 500 },
  selected: { type: 'boolean' },
  revision: { type: 'integer', minimum: 1, maximum: 1000000 },
  names: { type: 'array', maxItems: 8, items: { type: 'string', format: 'dns-name', maxLength: 253 } },
} });
test('one data contract validates optional typed fields without a Shell module allowlist', () => {
  const schema = validateSchema(shape());
  validateValue(schema, { id: 'cert-manager', reason: 'requested installation', selected: false, revision: 2, names: ['cert-manager'] });
  validateValue(schema, { id: 'ingress-nginx', reason: 'restore selected module' });
  for (const extra of [{ id: 'crossplane-core' }, { reason: 'short' }, { selected: 'false' }, { revision: 1.5 }, { names: ['https://attacker'] }, { url: 'https://attacker' }]) {
    assert.throws(() => validateValue(schema, { id: 'cert-manager', reason: 'requested installation', ...extra }), { code: 'ValidationFailed' });
  }
});
test('contracts cannot add remote refs, arbitrary regexes or unbounded input', () => {
  for (const bad of [
    { type: 'string', maxLength: 100, pattern: '(a+)+$' },
    { type: 'string' }, { type: 'array', items: { type: 'boolean' } },
    { ...shape(), additionalProperties: true }, { ...shape(), $ref: 'https://attacker' },
    { type: 'integer', minimum: 0, maximum: 10, enum: ['one'] },
  ]) assert.throws(() => validateSchema(bad), { code: 'CommandProviderUnavailable' });
  let deep = { type: 'boolean' };
  for (let i = 0; i < 8; i++) deep = { type: 'array', maxItems: 1, items: deep };
  assert.throws(() => validateSchema(deep), { code: 'CommandProviderUnavailable' });
});
