import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLegacyApiDisposition } from './legacy-api-disposition.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceLedgerPath = resolve(repositoryRoot, 'packages', 'contracts', 'legacy-api-disposition.json');

async function fixture(mutator) {
  const root = await mkdtemp(resolve(tmpdir(), 'opensphere-legacy-api-'));
  const contractDirectory = resolve(root, 'packages', 'contracts');
  await mkdir(contractDirectory, { recursive: true });
  const ledger = JSON.parse(await readFile(sourceLedgerPath, 'utf8'));
  mutator(ledger);
  await writeFile(resolve(contractDirectory, 'legacy-api-disposition.json'), JSON.stringify(ledger), 'utf8');
  return root;
}

test('the reviewed ledger closes all 277 source literals', async () => {
  const result = await verifyLegacyApiDisposition();
  assert.equal(result.status, 'passed');
  assert.equal(result.decisions, 277);
  assert.deepEqual(result.byDisposition, { adopted: 9, reworked: 236, rejected: 32 });
});

test('a missing source literal fails closed', async () => {
  const root = await fixture((ledger) => ledger.decisions.pop());
  await assert.rejects(() => verifyLegacyApiDisposition({ root }), /277/u);
});

test('a changed disposition fails closed', async () => {
  const root = await fixture((ledger) => {
    ledger.decisions[0].disposition = 'pending';
  });
  await assert.rejects(() => verifyLegacyApiDisposition({ root }), /invalid disposition/u);
});

test('a rejected path cannot retain executable Console authority', async () => {
  const root = await fixture((ledger) => {
    const record = ledger.decisions.find(({ disposition }) => disposition === 'rejected');
    record.targetOwner = 'C_API';
  });
  await assert.rejects(() => verifyLegacyApiDisposition({ root }), /must not retain/u);
});
