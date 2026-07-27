'use strict';

/**
 * Read-only Manual API for the RCC minimal deployment.
 *
 * The Console Manual UI (`src/app/core/manual.service.ts`) consumes four
 * endpoints. In the full platform they are served by the OAA Gateway from
 * PostgreSQL. RCC deliberately does not run that gateway, and adding it would
 * mean a second control plane and a second database.
 *
 * This module serves the same four endpoints, with the same response shapes,
 * from the release-generated seed file. It is strictly read-only:
 *   - no mutation verb is routed at all
 *   - nothing is written, cached to disk, or fetched over the network
 *   - the seed is read once at startup and never reloaded from a request
 *
 * Scope boundary: this is the manual *reader* contract only. Concept graphs,
 * embeddings, semantic search, action-binding authoring and knowledge ingestion
 * remain gateway-owned and are not reimplemented here.
 */

const fs = require('fs');

const MANUAL_ROUTE_PREFIX = '/api/manual/';
const MAX_QUERY_CHARS = 200;
const MAX_SOURCE_ID_CHARS = 200;
const DOCUMENT_LIMIT_MAX = 100;
const DOCUMENT_LIMIT_DEFAULT = 40;
const SEARCH_LIMIT_MAX = 25;
const SEARCH_LIMIT_DEFAULT = 8;
const CHUNK_MAX_CHARS = 1200;
const CHUNK_MAX_COUNT = 80;
const SUMMARY_MAX_CHARS = 360;
const EXCERPT_MAX_CHARS = 220;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
const CONTROL_CHARS_TEST = /[\u0000-\u001f\u007f]/;

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

/** Mirrors the gateway's chunker byte-for-byte so chunk indices are stable. */
function chunkText(content, maxChars = CHUNK_MAX_CHARS) {
  const blocks = String(content || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const block of blocks) {
    if ((current + '\n\n' + block).trim().length > maxChars && current) {
      chunks.push(current.trim());
      current = '';
    }
    if (block.length > maxChars) {
      for (let i = 0; i < block.length; i += maxChars) chunks.push(block.slice(i, i + maxChars).trim());
    } else {
      current = (current ? `${current}\n\n` : '') + block;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.slice(0, CHUNK_MAX_COUNT);
}

function trimText(value, max = EXCERPT_MAX_CHARS) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

function stringList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 32);
  if (typeof value === 'string') return value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 32);
  return [];
}

function authorityTier(value, fallback = 3) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : fallback;
}

function compactObject(value) {
  const out = {};
  for (const [k, v] of Object.entries(value || {})) {
    if (v === '' || v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

function boundedParam(value, max) {
  // Free-text search input. Control characters would corrupt logs; the length
  // bound keeps a hostile query string from driving an unbounded scan.
  // Truncating a *search term* is safe: it only widens the result set.
  return String(value ?? '').replace(CONTROL_CHARS_RE, '').trim().slice(0, max);
}

/**
 * Identifiers are never truncated or sanitised into a different identifier.
 * Silently trimming `sourceId` would turn a request for one document into a
 * lookup for another name, so a malformed identifier is refused outright.
 */
function identifierParam(value, name, max) {
  const raw = String(value ?? '');
  if (CONTROL_CHARS_TEST.test(raw)) throw { code: 400, msg: `${name} contains control characters` };
  if (raw.length > max) throw { code: 400, msg: `${name} exceeds ${max} characters` };
  return raw.trim();
}

function boundedLimit(raw, fallback, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n) || fallback));
}

/**
 * Projects one seed document into the index the reader endpoints serve.
 * The metadata shape matches `upsertManualSeedManifest` in the gateway so the
 * UI sees identical fields from either backend.
 */
function indexDocument(raw, source, defaults) {
  const sourcePath = String(raw.sourcePath || raw.source_path || '').trim();
  const route = String(raw.route || '').trim();
  const sourceId = String(raw.sourceId || raw.source_id || sourcePath || route || '').trim();
  if (!sourceId) return null;

  const content = String(raw.content || '');
  const chunks = chunkText(content);
  const metadata = compactObject({
    schema: 'manual.opensphere.io/v1alpha1',
    source: { id: source.id, type: source.type, name: source.name },
    documentType: String(raw.documentType || raw.document_type || 'reference').trim() || 'reference',
    authorityTier: authorityTier(raw.authorityTier, defaults.tier),
    status: String(raw.status || 'active').trim() || 'active',
    language: String(raw.language || defaults.language).trim() || defaults.language,
    route,
    sourcePath,
    sourceUrl: String(raw.sourceUrl || raw.source_url || '').trim(),
    perspective: stringList(raw.perspective),
    plane: stringList(raw.plane),
    component: stringList(raw.component),
    audience: stringList(raw.audience),
    tags: stringList(raw.tags),
    aliases: stringList(raw.aliases),
    replaces: stringList(raw.replaces),
    replacedBy: String(raw.replacedBy || raw.replaced_by || '').trim(),
    checksum: String(raw.checksum || '').trim(),
  });

  return {
    // The gateway issues a database uuid. RCC has no such table, so the stable
    // identifier is the seed sourceId; the UI navigates by sourceId anyway.
    id: sourceId,
    namespace: String(raw.namespace || defaults.namespace).trim() || defaults.namespace,
    sourceType: 'manual',
    sourceId,
    title: String(raw.title || sourceId),
    version: String(raw.version || defaults.version || ''),
    // Not the bundle version. That is a content digest, and this field is
    // rendered as a date and compared as one, so a digest here would show an
    // operator a hash where a date belongs and silently break that ordering.
    updatedAt: String(raw.updatedAt || defaults.updatedAt || ''),
    chunkCount: chunks.length,
    summary: trimText(chunks.join(' '), SUMMARY_MAX_CHARS),
    metadata,
    documentType: metadata.documentType || '',
    authorityTier: Number.isInteger(Number(metadata.authorityTier)) ? Number(metadata.authorityTier) : null,
    status: metadata.status || '',
    language: metadata.language || '',
    route: metadata.route || '',
    sourcePath: metadata.sourcePath || '',
    sourceUrl: metadata.sourceUrl || '',
    sourceName: metadata.source?.name || metadata.source?.id || '',
    source: metadata.source || null,
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    perspective: Array.isArray(metadata.perspective) ? metadata.perspective : [],
    component: Array.isArray(metadata.component) ? metadata.component : [],
    chunks,
    searchText: `${raw.title || ''}\n${sourceId}\n${content}`.toLowerCase(),
  };
}

/** Strips fields that exist only for query evaluation. */
function publicDocument(doc) {
  const { chunks, searchText, ...rest } = doc;
  return rest;
}

function buildIndex(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manual seed is not an object');
  const source = manifest.source && typeof manifest.source === 'object' ? manifest.source : {};
  const defaults = {
    namespace: String(source.defaultNamespace || 'opensphere').trim() || 'opensphere',
    language: String(source.defaultLanguage || 'mixed').trim() || 'mixed',
    tier: authorityTier(source.authorityTier, 3),
    version: String(manifest.version || ''),
    updatedAt: String(manifest.updatedAt || ''),
  };
  const sourceMeta = {
    id: String(source.id || 'manual-upload').trim(),
    type: String(source.type || 'upload').trim(),
    name: String(source.name || source.id || 'manual').trim(),
  };
  const rawDocs = Array.isArray(manifest.documents) ? manifest.documents : [];
  if (!rawDocs.length) throw new Error('manual seed contains no documents');

  const documents = rawDocs
    .map((raw) => (raw && typeof raw === 'object' ? indexDocument(raw, sourceMeta, defaults) : null))
    .filter((doc) => doc && doc.status === 'active');

  // A duplicate sourceId would make one document silently unreachable and make
  // /api/manual/document return whichever copy happened to be indexed last.
  // Refuse the whole seed instead: an ambiguous manual is worse than none.
  const seen = new Set();
  const duplicates = [];
  for (const doc of documents) {
    if (seen.has(doc.sourceId)) duplicates.push(doc.sourceId);
    seen.add(doc.sourceId);
  }
  if (duplicates.length) {
    throw new Error(`manual seed has duplicate active sourceId: ${[...new Set(duplicates)].sort().join(', ')}`);
  }

  // Same ordering the gateway query produces: authority tier, then title.
  documents.sort((a, b) => (a.authorityTier ?? 4) - (b.authorityTier ?? 4) || a.title.localeCompare(b.title));

  const bySourceId = new Map(documents.map((doc) => [doc.sourceId, doc]));
  return { documents, bySourceId, seedVersion: defaults.version, sourceMeta };
}

function listSources(index) {
  const groups = new Map();
  for (const doc of index.documents) {
    const id = doc.source?.id || doc.sourceId;
    const existing = groups.get(id);
    if (existing) {
      existing.documents += 1;
      existing.authorityTier = Math.min(existing.authorityTier, doc.authorityTier ?? 4);
      if (doc.updatedAt > existing.updatedAt) existing.updatedAt = doc.updatedAt;
      continue;
    }
    groups.set(id, {
      id,
      type: doc.source?.type || 'manual',
      name: doc.source?.name || doc.source?.id || id,
      authorityTier: doc.authorityTier ?? 4,
      documents: 1,
      updatedAt: doc.updatedAt,
    });
  }
  return [...groups.values()].sort((a, b) => a.authorityTier - b.authorityTier || a.name.localeCompare(b.name));
}

function listDocuments(index, { q, source, limit }) {
  const needle = q.toLowerCase();
  const items = index.documents.filter((doc) => {
    if (source && (doc.source?.id || doc.sourceId) !== source) return false;
    if (!needle) return true;
    return doc.searchText.includes(needle) || JSON.stringify(doc.metadata).toLowerCase().includes(needle);
  });
  return items.slice(0, limit).map(publicDocument);
}

function searchManual(index, { q, limit }) {
  const needle = q.toLowerCase();
  const hits = [];
  for (const doc of index.documents) {
    const titleHit = doc.title.toLowerCase().includes(needle);
    doc.chunks.forEach((content, chunkIndex) => {
      const lower = content.toLowerCase();
      if (!lower.includes(needle) && !titleHit) return;
      // Deterministic scoring: term frequency plus fixed title/content bonuses,
      // so the same query always ranks the same way.
      const occurrences = lower.split(needle).length - 1;
      const score = occurrences * 0.1 + (titleHit ? 0.4 : 0) + (occurrences > 0 ? 0.2 : 0);
      hits.push({
        documentId: doc.id,
        sourceId: doc.sourceId,
        title: doc.title,
        version: doc.version,
        score: Number(score.toFixed(4)),
        chunkIndex,
        excerpt: trimText(content, EXCERPT_MAX_CHARS),
        metadata: doc.metadata,
        chunkMetadata: { chunkIndex, sourceId: doc.sourceId },
        documentType: doc.documentType,
        authorityTier: doc.authorityTier,
        route: doc.route,
        sourcePath: doc.sourcePath,
        sourceUrl: doc.sourceUrl,
        sourceName: doc.sourceName,
      });
    });
  }
  hits.sort((a, b) => b.score - a.score
    || (a.authorityTier ?? 4) - (b.authorityTier ?? 4)
    || a.sourceId.localeCompare(b.sourceId)
    || a.chunkIndex - b.chunkIndex);
  return hits.slice(0, limit);
}

function documentDetail(index, sourceId) {
  const doc = index.bySourceId.get(sourceId);
  if (!doc) throw { code: 404, msg: 'manual document not found' };
  return {
    item: publicDocument(doc),
    chunks: doc.chunks.map((content, chunkIndex) => ({
      chunkIndex,
      content,
      metadata: { chunkIndex, sourceId: doc.sourceId },
    })),
    // Action bindings are an OAA-gateway concept. RCC publishes none rather
    // than inventing them, and the UI already treats the list as optional.
    actionBindings: [],
  };
}

function loadSeed(seedPath) {
  const raw = fs.readFileSync(seedPath, 'utf8');
  return buildIndex(JSON.parse(raw));
}

/**
 * @param seedPath   absolute path to the generated manual seed
 * @param verifyReader  async (req) => actor; must throw {code,msg} when denied
 */
function createManualApi({ seedPath, verifyReader, audit = async () => {}, now = () => Date.now() }) {
  let index = null;
  let loadError = '';
  try {
    index = loadSeed(seedPath);
  } catch (error) {
    // Fail closed and stay closed: a partially readable manual would be worse
    // than an explicit 503, because the reader cannot tell what is missing.
    loadError = error?.message || 'manual seed is unavailable';
  }

  async function handle(req, res) {
    const url = new URL(String(req.url ?? ''), 'http://polyon-rcc.local');
    if (!url.pathname.startsWith(MANUAL_ROUTE_PREFIX)) return false;

    const method = String(req.method || '').toUpperCase();
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'the manual API is read-only' });
      return true;
    }

    const route = url.pathname.slice(MANUAL_ROUTE_PREFIX.length);
    if (!['sources', 'documents', 'search', 'document'].includes(route)) {
      sendJson(res, 404, { error: 'unknown manual route' });
      return true;
    }

    if (!index) {
      sendJson(res, 503, { error: `manual registry is unavailable: ${loadError}` });
      return true;
    }

    let actor;
    try {
      actor = await verifyReader(req);
    } catch (error) {
      sendJson(res, error?.code || 401, { error: error?.msg || 'authentication required' });
      return true;
    }

    const generatedAt = new Date(now()).toISOString();
    try {
      if (route === 'sources') {
        sendJson(res, 200, {
          schema: 'manual-sources.opensphere.io/v1alpha1',
          generatedAt,
          items: listSources(index),
        });
      } else if (route === 'documents') {
        const q = boundedParam(url.searchParams.get('q'), MAX_QUERY_CHARS);
        // `source` selects a source, so it is an identifier, not search text.
        const source = identifierParam(url.searchParams.get('source'), 'source', MAX_SOURCE_ID_CHARS);
        const limit = boundedLimit(url.searchParams.get('limit'), DOCUMENT_LIMIT_DEFAULT, DOCUMENT_LIMIT_MAX);
        sendJson(res, 200, {
          schema: 'manual-documents.opensphere.io/v1alpha1',
          generatedAt,
          query: q,
          source,
          items: listDocuments(index, { q, source, limit }),
        });
      } else if (route === 'search') {
        const q = boundedParam(url.searchParams.get('q'), MAX_QUERY_CHARS);
        const limit = boundedLimit(url.searchParams.get('limit'), SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
        sendJson(res, 200, {
          schema: 'manual-search.opensphere.io/v1alpha1',
          generatedAt,
          query: q,
          items: q ? searchManual(index, { q, limit }) : [],
        });
      } else {
        const sourceId = identifierParam(url.searchParams.get('sourceId'), 'sourceId', MAX_SOURCE_ID_CHARS);
        if (!sourceId) throw { code: 400, msg: 'sourceId required' };
        const detail = documentDetail(index, sourceId);
        await audit(actor, { action: 'rcc.manual.read', target: sourceId });
        sendJson(res, 200, {
          schema: 'manual-document.opensphere.io/v1alpha1',
          generatedAt,
          ...detail,
        });
      }
    } catch (error) {
      sendJson(res, error?.code || 500, { error: error?.msg || 'manual request failed' });
    }
    return true;
  }

  return {
    handle,
    ready: () => Boolean(index),
    stats: () => (index
      ? { documents: index.documents.length, seedVersion: index.seedVersion, sourceId: index.sourceMeta.id }
      : { documents: 0, error: loadError }),
  };
}

module.exports = {
  MANUAL_ROUTE_PREFIX,
  DOCUMENT_LIMIT_MAX,
  SEARCH_LIMIT_MAX,
  CHUNK_MAX_CHARS,
  CHUNK_MAX_COUNT,
  chunkText,
  buildIndex,
  listSources,
  listDocuments,
  searchManual,
  documentDetail,
  createManualApi,
};
