'use strict';

/**
 * Freshness contract for the generated manual seed.
 *
 * The seed is what `/manual` actually serves. If a Console-owned source
 * document is edited without re-running `npm run manual:seed`, the published
 * manual silently keeps serving the old text — and nothing else in the test
 * suite notices, because both files are individually valid.
 *
 * These assertions compare the seed against the files it was generated from.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..', '..');
const seedPath = path.join(repoRoot, 'backend/opensphere-console-oaa-gateway/manual-seeds/opensphere-core-manuals.json');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
const CONSOLE_PREFIX = 'OpenSphere-console/';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Same normalisation the seed builder applies before hashing. */
const normalise = (raw) => raw
  .replace(/\r\n/g, '\n')
  .split(String.fromCharCode(0)).join('')
  .trim();

const consoleDocs = seed.documents.filter((doc) => String(doc.sourcePath || '').startsWith(CONSOLE_PREFIX));

test('the seed is not stale: every Console-owned document matches its source file', () => {
  assert.ok(consoleDocs.length >= 12, `expected the Console manual set, found ${consoleDocs.length}`);
  const stale = [];
  for (const doc of consoleDocs) {
    const rel = doc.sourcePath.slice(CONSOLE_PREFIX.length);
    const full = path.join(repoRoot, rel);
    if (!fs.existsSync(full)) {
      stale.push(`${doc.sourceId}: source file ${rel} no longer exists`);
      continue;
    }
    const actual = sha256(normalise(fs.readFileSync(full, 'utf8')));
    if (actual !== doc.checksum) {
      stale.push(`${doc.sourceId}: ${rel} changed since the seed was generated`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `the manual seed is out of date. Re-run:\n`
      + `  OPENSPHERE_PLATFORM_ROOT=<platform repo> npm run manual:seed\n\n`
      + stale.join('\n'),
  );
});

test('every seed document checksum matches its own embedded content', () => {
  const broken = seed.documents
    .filter((doc) => sha256(doc.content) !== doc.checksum)
    .map((doc) => doc.sourceId);
  assert.deepEqual(broken, [], 'seed content and checksum disagree');
});

test('no seed document is empty', () => {
  const empty = seed.documents.filter((doc) => !String(doc.content || '').trim()).map((doc) => doc.sourceId);
  assert.deepEqual(empty, [], 'a document resolved to empty content when the seed was generated');
});

test('seed document ids are unique', () => {
  const ids = seed.documents.map((doc) => doc.sourceId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate sourceId in the seed');
});

test('the RCC Linux host document is published through the seed', () => {
  const doc = seed.documents.find((entry) => entry.sourceId === 'help-center/os-level-linux-host-control');
  assert.ok(doc, 'the Linux host-control manual must be in the seed or /manual cannot show it');
  assert.equal(doc.sourcePath, 'OpenSphere-console/docs/manual/OS-LEVEL-LINUX-HOST-CONTROL.md');
  assert.ok(doc.perspective.includes('os-level'));
  // Content the operator must be able to reach through /manual.
  for (const claim of ['rcc-node-agent', 'RCC_AGENT_KEYS_FILE', 'linux-host-manager', '/cc/:ccId/hosts']) {
    assert.ok(doc.content.includes(claim), `the published manual must document ${claim}`);
  }
});

test('the seed carries no credential material', () => {
  const serialized = JSON.stringify(seed);
  assert.doesNotMatch(serialized, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  assert.doesNotMatch(serialized, /Bearer [A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(serialized, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
});

test('rebuilding the seed over unchanged inputs changes nothing', () => {
  // The bundle version was a wall-clock timestamp, so every rebuild rewrote a
  // committed artifact and every diff claimed a change that had not happened —
  // which also meant a real edit and an idle re-run looked identical. Making it
  // a digest of the payload is what buys byte-for-byte idempotence, so that is
  // what is checked: the version must be exactly the hash of what it ships.
  const { source, documents, concepts, relations } = seed;
  assert.equal(seed.version, `sha256:${sha256(JSON.stringify({ source, documents, concepts, relations }))}`,
    'the bundle version must be the digest of the bundle, recomputed here independently');

  // Stated separately from the digest equality above, because that assertion
  // would still hold for a version derived from the clock *and* the content.
  // Nothing that varies with when the build ran may appear here.
  assert.doesNotMatch(seed.version, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    'the bundle version must not be a timestamp');
});

test('the seed says what it was built from without saying where', () => {
  // `source.basePath` was the absolute path of the platform checkout, so the
  // committed artifact recorded one developer's home directory and would have
  // differed for anyone else who regenerated it. That is both a portability
  // defect and a needless disclosure, and it is why `source` had to be kept out
  // of the digest — the version would have varied by machine.
  //
  // Now that provenance is named rather than located, the digest covers the
  // whole file. Which means this is no longer only a tidiness rule: an absolute
  // path reintroduced here would make the version machine-dependent again and
  // silently undo the idempotence asserted above.
  const values = Object.values(seed.source).filter((v) => typeof v === 'string');
  assert.ok(values.length >= 5, 'the source block must still describe the bundle');
  for (const value of values) {
    assert.ok(!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value),
      `source carries the filesystem path ${value}; provenance must be a name, not a location`);
    assert.doesNotMatch(value, /\/(Users|home)\//,
      `source carries a home directory in ${value}`);
  }

  // The paths that do belong in the seed are the per-document ones, and they
  // are relative to the platform checkout rather than rooted on any machine.
  for (const doc of seed.documents) {
    assert.ok(!doc.sourcePath.startsWith('/'),
      `${doc.sourceId} records an absolute source path`);
  }
});

test('the seed states an update date that survives the version becoming a digest', () => {
  // The manual API hands this to every document that carries no date of its
  // own; the console renders it with `new Date(...)` and the source list takes
  // a lexicographic maximum of it. A digest satisfies neither, and `dateOf`
  // falls back to printing the raw string — so the regression would reach an
  // operator as a hash in the "업데이트" field rather than as a failure.
  assert.match(seed.updatedAt, /^\d{4}-\d{2}-\d{2}$/, 'the seed must carry a plain date');
  assert.ok(!Number.isNaN(new Date(seed.updatedAt).getTime()), 'that date must parse');

  // And it must be the newest one the bundle actually declares, not a constant
  // somebody wrote once: a seed whose newest document is from July must not
  // report an update date from May.
  const declared = seed.documents.map((doc) => doc.version).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)).sort();
  assert.ok(declared.length, 'some document must declare a dated version');
  assert.equal(seed.updatedAt, declared[declared.length - 1],
    'the update date must be the newest date the bundle declares');

  const { buildIndex } = require('../opensphere-console-backend/manual-api');
  const index = buildIndex(seed);
  const undated = index.documents.filter((doc) => !/^\d{4}-\d{2}-\d{2}/.test(doc.updatedAt));
  assert.deepEqual(undated.map((doc) => doc.sourceId), [],
    'every served document must end up with a date operators can read');
});

test('the seed generator documents the safe platform-root override', () => {
  const ownership = fs.readFileSync(path.join(repoRoot, 'docs/MANUAL-OWNERSHIP.md'), 'utf8');
  assert.match(ownership, /OPENSPHERE_PLATFORM_ROOT/, 'the override must be documented for reproducible regeneration');
  const builder = fs.readFileSync(path.join(repoRoot, 'backend/opensphere-console-oaa-gateway/scripts/build-manual-seed.js'), 'utf8');
  assert.match(builder, /OPENSPHERE_PLATFORM_ROOT/);
  assert.match(builder, /refusing to write a seed/, 'the generator must fail closed rather than emit a partial seed');
});
