import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyContracts } from './verify-console-contracts.mjs';

test('foundational Console contracts are internally complete and self-contained', async () => {
  const result = await verifyContracts();
  assert.deepEqual(result, {
    status: 'passed',
    contractStatus: 'foundational-slice',
    operations: 18,
    actionPolicies: 5,
    schemas: 9,
    components: 10,
  });
});
