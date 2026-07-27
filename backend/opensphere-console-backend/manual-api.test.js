'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MANUAL_ROUTE_PREFIX,
  DOCUMENT_LIMIT_MAX,
  SEARCH_LIMIT_MAX,
  CHUNK_MAX_CHARS,
  CHUNK_MAX_COUNT,
  chunkText,
  buildIndex,
  createManualApi,
} = require('./manual-api');

const REAL_SEED = path.resolve(__dirname, '..', 'opensphere-console-oaa-gateway', 'manual-seeds', 'opensphere-core-manuals.json');
const NOW_MS = Date.parse('2026-07-26T00:00:00.000Z');
const HOST_DOC = 'help-center/os-level-linux-host-control';
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; return this; },
  };
}

function buildApi(options = {}) {
  return createManualApi({
    seedPath: options.seedPath || REAL_SEED,
    verifyReader: options.verifyReader || (async () => ({ sub: 'operator-uuid' })),
    audit: options.audit || (async () => {}),
    now: () => NOW_MS,
  });
}

async function get(api, url) {
  const res = fakeRes();
  const handled = await api.handle({ method: 'GET', url, headers: {} }, res);
  return { handled, res };
}

function writeSeed(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-manual-'));
  const file = path.join(dir, 'seed.json');
  fs.writeFileSync(file, JSON.stringify(manifest));
  return { dir, file };
}

test('the real seed loads and exposes the Linux host document', () => {
  const api = buildApi();
  assert.equal(api.ready(), true);
  const stats = api.stats();
  assert.ok(stats.documents >= 29, `expected the full manual, got ${stats.documents}`);
  assert.equal(stats.sourceId, 'opensphere-core-manuals');
});

test('sources returns the {items} shape the UI expects', async () => {
  const { handled, res } = await get(buildApi(), '/api/manual/sources');
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.items) && res.body.items.length > 0);
  for (const item of res.body.items) {
    for (const key of ['id', 'type', 'name', 'authorityTier', 'documents', 'updatedAt']) {
      assert.ok(key in item, `source is missing ${key}`);
    }
    assert.equal(typeof item.documents, 'number');
    assert.equal(typeof item.authorityTier, 'number');
  }
});

test('documents returns the ManualDocument shape for every field the UI reads', async () => {
  const { res } = await get(buildApi(), '/api/manual/documents?limit=60');
  assert.equal(res.statusCode, 200);
  const doc = res.body.items.find((item) => item.sourceId === HOST_DOC);
  assert.ok(doc, 'the Linux host document must be listed');
  // Exactly the ManualDocument interface in src/app/core/manual.service.ts.
  for (const key of ['id', 'namespace', 'sourceType', 'sourceId', 'title', 'version', 'updatedAt',
    'chunkCount', 'summary', 'metadata', 'documentType', 'authorityTier', 'status', 'language',
    'route', 'sourcePath', 'sourceUrl', 'sourceName', 'source', 'tags', 'perspective', 'component']) {
    assert.ok(key in doc, `ManualDocument is missing ${key}`);
  }
  // Derived from the document itself rather than pinned to a stage number.
  // A hardcoded title is a test somebody has to remember to update, and the
  // failure it would then catch — a title claiming fewer stages than the
  // document describes — is exactly the drift worth catching automatically.
  // The seed builder carries the title as its own literal, so the markdown
  // heading is a genuinely independent source for it.
  const heading = fs.readFileSync(
    path.join(__dirname, '..', '..', 'docs/manual/OS-LEVEL-LINUX-HOST-CONTROL.md'), 'utf8',
  ).split('\n')[0].replace(/^#\s+/, '').trim();
  const sameDashes = (value) => value.replace(/[‐-―]/g, '-');
  assert.equal(sameDashes(doc.title), sameDashes(heading),
    'the served title must name the same stages the document actually describes');
  assert.equal(doc.sourceType, 'manual');
  assert.ok(doc.chunkCount > 0);
  assert.ok(doc.summary.length > 0);
  assert.ok(doc.perspective.includes('os-level'));
  // Internal query fields must never reach the client.
  assert.ok(!('chunks' in doc) && !('searchText' in doc));
});

test('document returns {item, chunks, actionBindings} and full content', async () => {
  const { res } = await get(buildApi(), `/api/manual/document?sourceId=${encodeURIComponent(HOST_DOC)}`);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.item && Array.isArray(res.body.chunks) && Array.isArray(res.body.actionBindings));
  assert.equal(res.body.item.sourceId, HOST_DOC);
  assert.equal(res.body.chunks.length, res.body.item.chunkCount);
  res.body.chunks.forEach((chunk, i) => {
    assert.equal(chunk.chunkIndex, i, 'chunk indices must be dense and ordered');
    assert.equal(typeof chunk.content, 'string');
    assert.ok(chunk.metadata && typeof chunk.metadata === 'object');
  });
  // The reader must be able to show the Stage 1 boundary text.
  const joined = res.body.chunks.map((c) => c.content).join('\n');
  assert.match(joined, /rcc-node-agent/);
  assert.match(joined, /읽기 전용/);
});

test('search finds the Linux host content and ranks deterministically', async () => {
  const api = buildApi();
  const first = await get(api, '/api/manual/search?q=rcc-node-agent&limit=8');
  assert.equal(first.res.statusCode, 200);
  assert.ok(first.res.body.items.length > 0, 'search must find the host agent');
  assert.ok(first.res.body.items.some((hit) => hit.sourceId === HOST_DOC));
  for (const key of ['documentId', 'sourceId', 'title', 'version', 'score', 'chunkIndex', 'excerpt',
    'metadata', 'chunkMetadata', 'documentType', 'authorityTier', 'route', 'sourcePath', 'sourceUrl', 'sourceName']) {
    assert.ok(key in first.res.body.items[0], `ManualSearchHit is missing ${key}`);
  }
  // Stable ordering: identical queries must produce identical results.
  const second = await get(api, '/api/manual/search?q=rcc-node-agent&limit=8');
  assert.deepEqual(second.res.body.items, first.res.body.items);
  // Scores must be non-increasing.
  const scores = first.res.body.items.map((hit) => hit.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('an empty search query returns no items rather than the whole manual', async () => {
  const { res } = await get(buildApi(), '/api/manual/search?q=');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items, []);
});

test('limits are clamped and hostile values cannot force an unbounded response', async () => {
  const api = buildApi();
  const huge = await get(api, '/api/manual/documents?limit=100000');
  assert.ok(huge.res.body.items.length <= DOCUMENT_LIMIT_MAX);
  const negative = await get(api, '/api/manual/documents?limit=-5');
  assert.ok(negative.res.body.items.length >= 1);
  const nan = await get(api, '/api/manual/documents?limit=abc');
  assert.ok(nan.res.body.items.length >= 1 && nan.res.body.items.length <= DOCUMENT_LIMIT_MAX);
  const search = await get(api, '/api/manual/search?q=the&limit=9999');
  assert.ok(search.res.body.items.length <= SEARCH_LIMIT_MAX);
});

test('over-long and control-character search terms stay bounded, not rejected', async () => {
  // Truncating a search term only widens the result set, so bounding is safe
  // and keeps the UI usable.
  const api = buildApi();
  const long = await get(api, `/api/manual/documents?q=${'a'.repeat(5000)}`);
  assert.equal(long.res.statusCode, 200);
  assert.ok(long.res.body.query.length <= 200);
  const control = await get(api, '/api/manual/documents?q=ab%00%1Fcd');
  assert.equal(control.res.statusCode, 200);
  assert.equal(CONTROL_CHARS.test(control.res.body.query), false);
  const search = await get(api, `/api/manual/search?q=${'b'.repeat(5000)}`);
  assert.equal(search.res.statusCode, 200);
});

test('malformed identifiers are refused with 400 instead of being truncated', async () => {
  // Silently trimming an identifier turns a request for one document into a
  // lookup for a different name, which would return the wrong document.
  const api = buildApi();

  const longId = await get(api, `/api/manual/document?sourceId=${'a'.repeat(5000)}`);
  assert.equal(longId.res.statusCode, 400);
  assert.match(longId.res.body.error, /sourceId exceeds/);

  const controlId = await get(api, '/api/manual/document?sourceId=help-center%00%1F');
  assert.equal(controlId.res.statusCode, 400);
  assert.match(controlId.res.body.error, /sourceId contains control characters/);

  const longSource = await get(api, `/api/manual/documents?source=${'a'.repeat(5000)}`);
  assert.equal(longSource.res.statusCode, 400);
  assert.match(longSource.res.body.error, /source exceeds/);

  const controlSource = await get(api, '/api/manual/documents?source=core%00');
  assert.equal(controlSource.res.statusCode, 400);
  assert.match(controlSource.res.body.error, /source contains control characters/);

  const atLimit = await get(api, `/api/manual/document?sourceId=${'a'.repeat(200)}`);
  assert.equal(atLimit.res.statusCode, 404, 'a valid-shaped unknown id is a 404, not a 400');
});

test('identifier validation is not stateful across requests', async () => {
  // A /g regex used with .test() alternates results; identifiers must not
  // intermittently pass validation.
  const api = buildApi();
  for (let i = 0; i < 4; i += 1) {
    const { res } = await get(api, '/api/manual/document?sourceId=bad%00id');
    assert.equal(res.statusCode, 400, `request ${i} should be rejected consistently`);
  }
});

test('path traversal and injection in sourceId cannot escape the seed index', async () => {
  const api = buildApi();
  for (const hostile of [
    '../../../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    '/etc/passwd',
    "'; DROP TABLE oaa_knowledge_documents;--",
    '__proto__',
    'constructor',
  ]) {
    const { res } = await get(api, `/api/manual/document?sourceId=${encodeURIComponent(hostile)}`);
    assert.equal(res.statusCode, 404, `${hostile} must not resolve`);
    assert.equal(res.body.error, 'manual document not found');
  }
});

test('a missing sourceId is a 400, not a 500', async () => {
  const { res } = await get(buildApi(), '/api/manual/document');
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /sourceId required/);
});

test('unauthenticated callers are refused before any content is served', async () => {
  const api = buildApi({ verifyReader: async () => { throw { code: 401, msg: 'authentication required' }; } });
  for (const route of ['sources', 'documents', 'search?q=x', 'document?sourceId=' + HOST_DOC]) {
    const { res } = await get(api, `/api/manual/${route}`);
    assert.equal(res.statusCode, 401, `${route} must require authentication`);
    assert.equal(res.body.items, undefined);
    assert.equal(res.body.item, undefined);
  }
});

test('the manual API is read-only: no mutation verb is accepted', async () => {
  const api = buildApi();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = fakeRes();
    await api.handle({ method, url: '/api/manual/documents', headers: {} }, res);
    assert.equal(res.statusCode, 405, `${method} must be refused`);
  }
});

test('unknown manual routes are refused rather than falling through', async () => {
  const { handled, res } = await get(buildApi(), '/api/manual/admin/seed');
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
});

test('non-manual paths are not claimed, so existing routing is preserved', async () => {
  const { handled, res } = await get(buildApi(), '/api/control-centers/cc2/hosts');
  assert.equal(handled, false);
  assert.equal(res.statusCode, 0);
});

test('a missing or malformed seed fails closed with 503, never partial content', async () => {
  const missing = buildApi({ seedPath: '/nonexistent/seed.json' });
  assert.equal(missing.ready(), false);
  const gone = await get(missing, '/api/manual/sources');
  assert.equal(gone.res.statusCode, 503);

  const { dir, file } = writeSeed({ source: { id: 'x' }, documents: [] });
  try {
    const empty = buildApi({ seedPath: file });
    assert.equal(empty.ready(), false);
    const res = await get(empty, '/api/manual/documents');
    assert.equal(res.res.statusCode, 503);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a seed with duplicate active sourceId is refused, not silently deduped', () => {
  // Overwriting would make one document permanently unreachable and make
  // /api/manual/document return whichever copy was indexed last.
  const manifest = {
    version: '2026-07-26T00:00:00.000Z',
    source: { id: 's', type: 'repo', name: 'S' },
    documents: [
      { sourceId: 'dup', title: 'First', content: 'alpha', status: 'active' },
      { sourceId: 'dup', title: 'Second', content: 'beta', status: 'active' },
      { sourceId: 'other', title: 'Other', content: 'gamma', status: 'active' },
    ],
  };
  assert.throws(() => buildIndex(manifest), /duplicate active sourceId: dup/);

  const { dir, file } = writeSeed(manifest);
  try {
    const api = buildApi({ seedPath: file });
    assert.equal(api.ready(), false, 'startup must fail closed on an ambiguous seed');
    assert.match(api.stats().error, /duplicate active sourceId/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a duplicate that is retired does not block the seed', () => {
  // Only *active* documents compete for a sourceId.
  const index = buildIndex({
    version: '2026-07-26T00:00:00.000Z',
    source: { id: 's', type: 'repo', name: 'S' },
    documents: [
      { sourceId: 'dup', title: 'Live', content: 'alpha', status: 'active' },
      { sourceId: 'dup', title: 'Old', content: 'beta', status: 'retired' },
    ],
  });
  assert.equal(index.documents.length, 1);
  assert.equal(index.bySourceId.get('dup').title, 'Live');
});

test('the real seed has no duplicate sourceId', () => {
  const api = buildApi();
  assert.equal(api.ready(), true, api.stats().error || '');
});

test('retired documents are not served', () => {
  const index = buildIndex({
    version: '2026-07-26T00:00:00.000Z',
    source: { id: 's', type: 'repo', name: 'S' },
    documents: [
      { sourceId: 'live', title: 'Live', content: 'alpha', status: 'active' },
      { sourceId: 'gone', title: 'Gone', content: 'beta', status: 'retired' },
    ],
  });
  assert.deepEqual(index.documents.map((d) => d.sourceId), ['live']);
  assert.equal(index.bySourceId.has('gone'), false);
});

test('chunking matches the gateway contract and stays bounded', () => {
  // Short blocks accumulate into one chunk until maxChars, as the gateway does.
  assert.deepEqual(chunkText('a\n\nb'), ['a\n\nb']);
  assert.deepEqual(chunkText('a\n\nb', 2), ['a', 'b']);
  assert.deepEqual(chunkText(''), []);
  const long = 'x'.repeat(CHUNK_MAX_CHARS * 3);
  const split = chunkText(long);
  assert.equal(split.length, 3);
  for (const part of split) assert.ok(part.length <= CHUNK_MAX_CHARS);
  const many = Array.from({ length: CHUNK_MAX_COUNT + 40 }, (_, i) => `block ${i}`).join('\n\n');
  assert.ok(chunkText(many, 10).length <= CHUNK_MAX_COUNT);
});

test('document reads are audited but list and search are not', async () => {
  const events = [];
  const api = buildApi({ audit: async (_actor, event) => { events.push(event); } });
  await get(api, '/api/manual/sources');
  await get(api, '/api/manual/documents');
  await get(api, '/api/manual/search?q=host');
  assert.deepEqual(events, []);
  await get(api, `/api/manual/document?sourceId=${encodeURIComponent(HOST_DOC)}`);
  assert.deepEqual(events, [{ action: 'rcc.manual.read', target: HOST_DOC }]);
});

test('responses are never cached and declare their content type', async () => {
  const { res } = await get(buildApi(), '/api/manual/sources');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('the route prefix constant matches what the UI calls', () => {
  const service = fs.readFileSync(path.resolve(__dirname, '../../src/app/core/manual.service.ts'), 'utf8');
  for (const route of ['sources', 'documents', 'search', 'document']) {
    assert.ok(service.includes(`${MANUAL_ROUTE_PREFIX}${route}`), `UI calls ${MANUAL_ROUTE_PREFIX}${route}`);
  }
});
