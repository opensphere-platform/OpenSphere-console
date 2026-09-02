import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ledgerPath = resolve(repositoryRoot, 'packages', 'contracts', 'legacy-api-disposition.json');
const EXPECTED = Object.freeze({
  snapshot: '731f4d1e3301f076cc8c6b63b7916c8a2f57fccf',
  fileSha256: '91f9cacd1165bca2aa58b5a18433691752a1e39a1990aafe6cb29fd141d46b8e',
  count: 277,
  pathSetDigest: 'sha256:ab1547c0d966789be0b4550ed551f1dc15610d32bf8e3c36257c9926671f71d1',
});
const ALLOWED_DISPOSITIONS = new Set(['adopted', 'reworked', 'rejected']);
const ALLOWED_OWNERS = new Set(['C_AI', 'C_API', 'C_BAK', 'C_CLI', 'C_EXT', 'C_NOTIFY', 'C_REG', 'C_SCTL']);
const ALLOWED_TARGET_KINDS = new Set([
  'adapter-capability',
  'browser-family',
  'cooperating-system',
  'internal-contract',
  'none',
  'owner-capability',
  'public-read-family',
  'public-static-family',
  'repository',
  'runtime-probe',
]);

function pathSetDigest(paths) {
  return 'sha256:' + createHash('sha256').update(paths.map((path) => `${path}\n`).join('')).digest('hex');
}

function summarize(decisions) {
  return {
    byDisposition: Object.fromEntries(['adopted', 'reworked', 'rejected'].map((value) => [
      value,
      decisions.filter(({ disposition }) => disposition === value).length,
    ])),
    byTargetOwner: Object.fromEntries([...ALLOWED_OWNERS].sort().flatMap((owner) => {
      const count = decisions.filter(({ targetOwner }) => targetOwner === owner).length;
      return count ? [[owner, count]] : [];
    })),
  };
}

export async function verifyLegacyApiDisposition({ root = repositoryRoot } = {}) {
  const ledger = JSON.parse(await readFile(resolve(root, 'packages', 'contracts', 'legacy-api-disposition.json'), 'utf8'));
  assert.equal(ledger.schemaVersion, '1.0');
  assert.equal(ledger.status, 'reviewed');
  assert.deepEqual(ledger.sourceEvidence, {
    snapshot: EXPECTED.snapshot,
    fileSha256: EXPECTED.fileSha256,
    uniqueLiteralPaths: EXPECTED.count,
    pathSetDigest: EXPECTED.pathSetDigest,
    scope: 'Production text files only; tests, docs and binary artifacts excluded. Literal occurrence is evidence, not a complete OpenAPI operation.',
    scopeCaveat: 'The evidence includes test sources despite its scope claim; this ledger preserves and explicitly disposes every listed literal.',
  });
  assert.equal(ledger.decisions.length, EXPECTED.count);
  const paths = ledger.decisions.map(({ path }) => path);
  assert.equal(new Set(paths).size, EXPECTED.count, 'legacy API disposition paths must be unique');
  assert.deepEqual(paths, [...paths].sort(), 'legacy API disposition paths must use bytewise lexical order');
  assert.equal(pathSetDigest(paths), EXPECTED.pathSetDigest, 'legacy API disposition path set drifted');

  for (const record of ledger.decisions) {
    assert.match(record.path, /^\/api(?:[/?]|$)/u, `invalid legacy API literal: ${record.path}`);
    assert(ALLOWED_DISPOSITIONS.has(record.disposition), `invalid disposition: ${record.path}`);
    assert.equal(typeof record.rationale, 'string', `missing rationale: ${record.path}`);
    assert(record.rationale.length >= 40, `rationale is not reviewable: ${record.path}`);
    assert(Array.isArray(record.sources) && record.sources.length > 0, `source trace is absent: ${record.path}`);
    for (const source of record.sources) {
      assert.equal(typeof source.file, 'string', `source file is absent: ${record.path}`);
      assert(Number.isSafeInteger(source.line) && source.line > 0, `source line is invalid: ${record.path}`);
    }
    assert(record.target && ALLOWED_TARGET_KINDS.has(record.target.kind), `target kind is invalid: ${record.path}`);
    if (record.disposition === 'rejected') {
      assert.equal(record.targetOwner, null, `rejected path must not retain a Console owner: ${record.path}`);
      assert(['cooperating-system', 'none', 'repository'].includes(record.target.kind), `rejected path has an executable Console target: ${record.path}`);
    } else {
      assert(ALLOWED_OWNERS.has(record.targetOwner), `retained path has no closed target owner: ${record.path}`);
      assert(!['none', 'repository'].includes(record.target.kind), `retained path has no executable target: ${record.path}`);
    }
  }

  const summary = summarize(ledger.decisions);
  assert.deepEqual(ledger.summary, summary, 'legacy API disposition summary drifted');
  assert.equal(Object.values(summary.byDisposition).reduce((sum, value) => sum + value, 0), EXPECTED.count);
  return Object.freeze({ status: 'passed', decisions: EXPECTED.count, ...summary });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyLegacyApiDisposition().then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch((error) => {
    process.stderr.write(`Legacy API disposition verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
