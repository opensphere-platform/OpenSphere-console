const http = require('http');
const https = require('https');
const fs = require('fs');
const { createHash, createPublicKey, randomUUID, verify } = require('crypto');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 8080);
const VERSION = process.env.APP_VERSION || '0.1.0';
const BACKBONE_NS = process.env.BACKBONE_NS || 'opensphere-backbone';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const APISERVER = process.env.APISERVER || 'https://kubernetes.default.svc';
const KANIDM_ISSUERS = (process.env.KANIDM_ISSUERS || process.env.KANIDM_ISS || 'https://auth.console.opensphere.dev/oauth2/openid/opensphere-console,https://localhost:8444/oauth2/openid/opensphere-console')
  .split(',').map((x) => x.trim()).filter(Boolean);
const KANIDM_JWKS_URL = process.env.KANIDM_JWKS_URL || 'https://kanidm-core.opensphere-console-auth.svc:8443/oauth2/openid/opensphere-console/public_key.jwk';
const KANIDM_TLS_SERVERNAME = process.env.KANIDM_TLS_SERVERNAME || 'kanidm.opensphere-console-auth.svc';
const KANIDM_AZP = process.env.KANIDM_AZP || 'opensphere-console';
const KANIDM_ADMIN_GROUP = process.env.KANIDM_ADMIN_GROUP || 'opensphere-console-admins';
const KANIDM_CA_PATH = process.env.KANIDM_CA_PATH || '/app/kanidm-ca.crt';
const PG = {
  host: process.env.BACKBONE_PG_HOST || 'backbone-postgres.opensphere-backbone.svc.cluster.local',
  port: Number(process.env.BACKBONE_PG_PORT || 5432),
  database: process.env.BACKBONE_PG_DB || 'console',
  user: process.env.BACKBONE_PG_USER || 'console',
  password: process.env.BACKBONE_PG_PASSWORD || process.env.BACKBONE_PG_password || process.env.password || '',
};
const OAA_EMBED_DIM = Math.max(16, Math.min(4096, Number(process.env.OAA_EMBED_DIM || 384) || 384));
const OAA_RAG_TOP_K = Math.max(1, Math.min(12, Number(process.env.OAA_RAG_TOP_K || 5) || 5));
const OAA_RAG_ENABLED = process.env.OAA_RAG_ENABLED !== 'false';
const OAA_EMBED_KEY_ID = String(process.env.OAA_EMBED_KEY_ID || '').trim();
const OAA_MANUAL_SEED_PATH = process.env.OAA_MANUAL_SEED_PATH || '/app/manual-seeds/opensphere-core-manuals.json';
const OAA_ENV_NAMESPACES = (process.env.OAA_ENV_NAMESPACES || 'opensphere-console,opensphere-backbone,opensphere-console-auth,opensphere-monitoring')
  .split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8);
const OAA_SCALE_MAX = Math.max(1, Math.min(50, Number(process.env.OAA_SCALE_MAX || 10) || 10));

const KEY_LABEL = 'opensphere.io/oaa-llm-key';
const PART_LABEL = 'opensphere.io/part-of';
const ID_RE = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;
const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const PROVIDER_RE = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{0,128}$/;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_CHAT_MESSAGES = 24;
const MAX_CHAT_CHARS = 24000;

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function saToken() {
  return fs.readFileSync(`${SA}/token`, 'utf8').trim();
}

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function b64d(s) {
  return Buffer.from(s || '', 'base64').toString('utf8');
}

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) throw Object.assign(new Error('payload too large'), { code: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function k8s(method, path, body) {
  const headers = { authorization: `Bearer ${saToken()}`, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = method === 'PATCH' ? 'application/merge-patch+json' : 'application/json';
  const res = await fetch(`${APISERVER}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, json: data };
}

let jwks = null;
let jwksAt = 0;
function jwksCa() {
  if (!KANIDM_CA_PATH) return undefined;
  try {
    return fs.readFileSync(KANIDM_CA_PATH);
  } catch {
    return undefined;
  }
}

async function loadJwks(force = false) {
  if (!force && jwks && Date.now() - jwksAt < 5 * 60 * 1000) return jwks;
  const u = new URL(KANIDM_JWKS_URL);
  const data = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      ca: jwksCa(),
      servername: KANIDM_TLS_SERVERNAME,
    }, (resp) => {
      const chunks = [];
      resp.on('data', (x) => chunks.push(x));
      resp.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
  jwks = data.keys || (data.kty ? [data] : []);
  jwksAt = Date.now();
  return jwks;
}

async function verifyAuthed(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) throw { code: 401, msg: 'no bearer token' };
  const [h, p, s] = m[1].split('.');
  if (!h || !p || !s) throw { code: 401, msg: 'malformed token' };
  const header = JSON.parse(b64urlToBuf(h).toString('utf8'));
  const claims = JSON.parse(b64urlToBuf(p).toString('utf8'));
  const aud = Array.isArray(claims.aud) ? claims.aud : (claims.aud ? [claims.aud] : []);
  if (header.alg !== 'ES256') throw { code: 401, msg: 'unexpected alg' };
  let jwk = (await loadJwks()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await loadJwks(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw { code: 401, msg: 'unknown kid' };
  const pub = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = verify('SHA256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64urlToBuf(s));
  if (!ok) throw { code: 401, msg: 'bad signature' };
  if (!KANIDM_ISSUERS.includes(claims.iss)) throw { code: 401, msg: 'bad iss' };
  if (claims.azp !== KANIDM_AZP && !aud.includes(KANIDM_AZP)) throw { code: 401, msg: 'bad azp/aud' };
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw { code: 401, msg: 'token expired' };
  const groups = (claims.groups || []).map((g) => String(g).replace(/^\//, '').replace(/@.*$/, ''));
  return { username: claims.preferred_username || claims.sub || 'unknown', subject: claims.sub || '', groups };
}

async function verifyAdmin(req) {
  const actor = await verifyAuthed(req);
  if (!actor.groups.includes(KANIDM_ADMIN_GROUP)) throw { code: 403, msg: `not in ${KANIDM_ADMIN_GROUP}` };
  return actor;
}

function secretName(id) {
  return `oaa-llm-${id}`;
}

function keyMetaFromSecret(s) {
  const a = s.metadata?.annotations || {};
  return {
    id: a['opensphere.io/oaa-key-id'] || String(s.metadata?.name || '').replace(/^oaa-llm-/, ''),
    provider: a['opensphere.io/oaa-provider'] || '',
    displayName: a['opensphere.io/oaa-display-name'] || '',
    baseUrl: a['opensphere.io/oaa-base-url'] || '',
    defaultModel: a['opensphere.io/oaa-default-model'] || '',
    embeddingModel: a['opensphere.io/oaa-embedding-model'] || '',
    enabled: a['opensphere.io/oaa-enabled'] !== 'false',
    keyFingerprint: a['opensphere.io/oaa-key-fingerprint'] || '',
    secretRef: s.metadata?.name || '',
    updatedAt: a['opensphere.io/oaa-updated-at'] || s.metadata?.creationTimestamp || '',
    updatedBy: a['opensphere.io/oaa-updated-by'] || '',
  };
}

function enabledKeyFromSecret(s) {
  const meta = keyMetaFromSecret(s);
  const apiKey = b64d(s.data?.api_key || '');
  if (!meta.enabled || !apiKey) return null;
  return { ...meta, apiKey };
}

async function listKeys() {
  const r = await k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/secrets?labelSelector=${encodeURIComponent(`${KEY_LABEL}=true`)}`);
  if (!r.ok) throw Object.assign(new Error(`secret list HTTP ${r.status}`), { code: 502 });
  return (r.json?.items || []).map(keyMetaFromSecret).sort((a, b) => a.id.localeCompare(b.id));
}

async function loadEnabledKey(id = '') {
  if (id) {
    if (!ID_RE.test(id)) throw { code: 400, msg: 'invalid keyId' };
    const r = await k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/secrets/${secretName(id)}`);
    if (r.status === 404) throw { code: 404, msg: 'llm key not found' };
    if (!r.ok) throw { code: 502, msg: `secret read HTTP ${r.status}` };
    const key = enabledKeyFromSecret(r.json);
    if (!key) throw { code: 400, msg: 'llm key is disabled or empty' };
    return key;
  }
  const r = await k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/secrets?labelSelector=${encodeURIComponent(`${KEY_LABEL}=true`)}`);
  if (!r.ok) throw { code: 502, msg: `secret list HTTP ${r.status}` };
  const keys = (r.json?.items || []).map(enabledKeyFromSecret).filter(Boolean);
  const preferred = keys.find((k) => k.id === 'deepseek') || keys.find((k) => k.provider === 'deepseek') || keys[0];
  if (!preferred) throw { code: 404, msg: 'no enabled llm key' };
  return preferred;
}

async function loadEmbeddingKey(id = '') {
  const wanted = String(id || OAA_EMBED_KEY_ID || '').trim();
  if (wanted) {
    const key = await loadEnabledKey(wanted);
    if (!key.embeddingModel) throw { code: 400, msg: `llm key ${wanted} has no embedding model` };
    return key;
  }
  const r = await k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/secrets?labelSelector=${encodeURIComponent(`${KEY_LABEL}=true`)}`);
  if (!r.ok) throw { code: 502, msg: `secret list HTTP ${r.status}` };
  const keys = (r.json?.items || []).map(enabledKeyFromSecret).filter((k) => k && k.embeddingModel);
  return keys.find((k) => k.id === 'openai-main') || keys.find((k) => k.provider === 'openai') || keys[0] || null;
}

function normalizeMessages(body) {
  const inMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages = inMessages
    .slice(-MAX_CHAT_MESSAGES)
    .map((m) => ({
      role: ['system', 'user', 'assistant'].includes(m?.role) ? m.role : 'user',
      content: String(m?.content || '').slice(0, 8000),
    }))
    .filter((m) => m.content.trim());
  if (!messages.length) throw { code: 400, msg: 'messages required' };
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total > MAX_CHAT_CHARS) throw { code: 413, msg: 'chat context too large' };
  return messages;
}

let pgPool = null;
let pgSchemaReady = false;
let pgSchemaPromise = null;
let pgSeedReady = false;

function pgEnabled() {
  return Boolean(PG.password);
}

function getPgPool() {
  if (!pgEnabled()) return null;
  if (!pgPool) {
    pgPool = new Pool({
      host: PG.host,
      port: PG.port,
      database: PG.database,
      user: PG.user,
      password: PG.password,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pgPool.on('error', (e) => console.error('[oaa-db] pool error', e.message || e));
  }
  return pgPool;
}

async function ensureKnowledgeSchema() {
  const pool = getPgPool();
  if (!pool) return false;
  if (pgSchemaReady) return true;
  if (pgSchemaPromise) return pgSchemaPromise;
  pgSchemaPromise = (async () => {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oaa_knowledge_documents (
      id uuid PRIMARY KEY,
      namespace text NOT NULL DEFAULT 'opensphere',
      source_type text NOT NULL,
      source_id text NOT NULL,
      title text NOT NULL,
      version text,
      metadata jsonb NOT NULL DEFAULT '{}',
      content_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(namespace, source_type, source_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oaa_knowledge_chunks (
      id uuid PRIMARY KEY,
      document_id uuid NOT NULL REFERENCES oaa_knowledge_documents(id) ON DELETE CASCADE,
      chunk_index int NOT NULL,
      content text NOT NULL,
      embedding vector(${OAA_EMBED_DIM}) NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(document_id, chunk_index)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oaa_tool_capabilities (
      id text PRIMARY KEY,
      name text NOT NULL,
      version text NOT NULL,
      channel text NOT NULL,
      read_only boolean NOT NULL,
      spec jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oaa_manual_concepts (
      id text PRIMARY KEY,
      namespace text NOT NULL,
      type text NOT NULL,
      name text NOT NULL,
      aliases text[] NOT NULL DEFAULT '{}',
      summary text NOT NULL,
      definition text NOT NULL,
      authority_tier int NOT NULL,
      status text NOT NULL,
      source_ids text[] NOT NULL DEFAULT '{}',
      section_ids text[] NOT NULL DEFAULT '{}',
      tags text[] NOT NULL DEFAULT '{}',
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oaa_manual_relations (
      id text PRIMARY KEY,
      namespace text NOT NULL,
      from_id text NOT NULL,
      to_id text NOT NULL,
      relation text NOT NULL,
      confidence text NOT NULL,
      authority_tier int NOT NULL,
      source_id text NOT NULL,
      section_id text,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oaa_manual_action_bindings (
      id text PRIMARY KEY,
      source_id text NOT NULL,
      section_id text,
      tool_id text NOT NULL REFERENCES oaa_tool_capabilities(id) ON DELETE RESTRICT,
      intent text NOT NULL,
      risk_level text NOT NULL,
      confirmation text NOT NULL,
      spec jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS oaa_manual_concepts_type_idx ON oaa_manual_concepts (namespace, type)');
  await pool.query('CREATE INDEX IF NOT EXISTS oaa_manual_relations_from_idx ON oaa_manual_relations (namespace, from_id, relation)');
  await pool.query('CREATE INDEX IF NOT EXISTS oaa_manual_relations_to_idx ON oaa_manual_relations (namespace, to_id, relation)');
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS oaa_knowledge_chunks_embedding_hnsw_idx ON oaa_knowledge_chunks USING hnsw (embedding vector_cosine_ops)');
  } catch (e) {
    console.warn('[oaa-db] hnsw index unavailable, trying ivfflat:', e.message || e);
    try {
      await pool.query('CREATE INDEX IF NOT EXISTS oaa_knowledge_chunks_embedding_ivfflat_idx ON oaa_knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 32)');
    } catch (e2) {
      console.warn('[oaa-db] vector index creation skipped:', e2.message || e2);
    }
  }
  pgSchemaReady = true;
  return true;
  })();
  try {
    return await pgSchemaPromise;
  } finally {
    if (pgSchemaReady) pgSchemaPromise = null;
  }
}

function hashEmbedding(text) {
  const vec = new Array(OAA_EMBED_DIM).fill(0);
  const tokens = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_.:/-]+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 2000);
  const source = tokens.length ? tokens : ['opensphere'];
  for (const token of source) {
    const h = createHash('sha256').update(token).digest();
    const idx = h.readUInt32BE(0) % OAA_EMBED_DIM;
    const sign = (h[4] & 1) ? 1 : -1;
    const weight = 1 + Math.min(token.length, 24) / 24;
    vec[idx] += sign * weight;
    if (token.includes('-') || token.includes('/')) {
      const idx2 = h.readUInt32BE(8) % OAA_EMBED_DIM;
      vec[idx2] += weight * 0.5;
    }
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

function normalizeProviderEmbedding(values) {
  const vec = Array.isArray(values) ? values.map((v) => Number(v)) : [];
  if (vec.length !== OAA_EMBED_DIM) {
    throw new Error(`embedding dimension ${vec.length} does not match OAA_EMBED_DIM ${OAA_EMBED_DIM}`);
  }
  if (vec.some((v) => !Number.isFinite(v))) throw new Error('embedding contains non-finite values');
  return vec.map((v) => Number(v.toFixed(8)));
}

async function providerEmbedding(text, key) {
  const baseUrl = (key.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const started = Date.now();
  const commonBody = {
    model: key.embeddingModel,
    input: String(text || '').slice(0, 12000),
  };
  const attempts = [];
  if (key.provider === 'openai' || /text-embedding-3/i.test(key.embeddingModel)) {
    attempts.push({ ...commonBody, dimensions: OAA_EMBED_DIM });
  }
  attempts.push(commonBody);

  let lastMsg = '';
  for (const reqBody of attempts) {
    const resp = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
    const raw = await resp.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
    if (!resp.ok) {
      lastMsg = data?.error?.message || data?.message || `provider HTTP ${resp.status}`;
      continue;
    }
    const vector = normalizeProviderEmbedding(data?.data?.[0]?.embedding);
    return {
      vector,
      source: {
        mode: 'provider',
        keyId: key.id,
        provider: key.provider,
        model: key.embeddingModel,
        latencyMs: Date.now() - started,
      },
    };
  }
  throw new Error(lastMsg || 'embedding provider failed');
}

async function embeddingVector(text, opts = {}) {
  const strict = Boolean(opts.strict);
  try {
    const key = await loadEmbeddingKey(opts.keyId || '');
    if (key) return await providerEmbedding(text, key);
    if (strict) throw new Error('no enabled embedding key');
  } catch (e) {
    if (strict) throw e;
    console.warn('[oaa-embed] provider skipped:', e.message || e);
  }
  return {
    vector: hashEmbedding(text),
    source: { mode: 'hash', keyId: '', provider: 'local', model: `hash-${OAA_EMBED_DIM}` },
  };
}

function vectorLiteral(vec) {
  return `[${vec.map((v) => Number.isFinite(v) ? v : 0).join(',')}]`;
}

function chunkText(content, maxChars = 1200) {
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
  return chunks.slice(0, 80);
}

function builtInKnowledgeDocs() {
  return [
    {
      namespace: 'opensphere',
      sourceType: 'builtin',
      sourceId: 'opensphere-10-perspective',
      title: 'OpenSphere 10 Perspective',
      version: '2026-07-04',
      metadata: { kind: 'foundation-knowledge' },
      content: [
        'OpenSphere 10 Perspective is the internal operating model used by OpenSphere. Generic LLMs do not know it unless OAA stores it as project knowledge.',
        '0 Main Shell: console operation and control surface. 1 Base/Substrate: cloud, region, cluster fleet, node, OS, network and physical substrate. 2 K8s Cluster + Ceph: in-cluster control plane, etcd, storage, VM and resource reality. 3 User: employees, members, groups and workforce IGA. 4 Developer: catalog declarations combined with cluster reality and golden path. 5 AI Level: model serving, inference, agent and AI capability layer. 6 API = information flow: contracts, state, inbound and outbound information. 7 Workspace internal: internal business apps and employee work surfaces. 8 Customer: customer-facing services and portals. 9 External/Edge Service: ingress, TLS, domains and probes. 10 WebSite: public web pages and the organization face.',
        'OAA must answer questions about these perspectives from Backbone knowledge, not from provider model memory.'
      ].join('\n\n'),
    },
    {
      namespace: 'opensphere',
      sourceType: 'builtin',
      sourceId: 'oaa-mvp-architecture',
      title: 'OAA MVP Architecture',
      version: '2026-07-04',
      metadata: { kind: 'architecture' },
      content: [
        'OAA means OpenSphere AI Agent. In the MVP, OAA is implemented as a right-side console chat panel plus the oaa-gateway Backbone tier.',
        'The gateway owns LLM key custody through Kubernetes Secrets, reads project knowledge from Backbone PostgreSQL, searches pgvector chunks, and injects selected context into the model request.',
        'The MVP does not require a separate vector database. Backbone PostgreSQL with pgvector is enough for initial project knowledge, policy, and console documentation RAG.'
      ].join('\n\n'),
    },
    {
      namespace: 'opensphere',
      sourceType: 'builtin',
      sourceId: 'backbone-services',
      title: 'Backbone Services',
      version: '2026-07-04',
      metadata: { kind: 'backbone' },
      content: [
        'Backbone is the console data tier. Current core services include PostgreSQL with pgvector, RustFS, Gitea, Foundation support, and OAA-Gateway.',
        'PostgreSQL is the preferred MVP store for OAA memory because it is already part of Backbone, supports relational audit/config data, and supports vector search through pgvector.',
        'RustFS is useful later for larger document objects, files, snapshots and binary artifacts. Gitea is useful later for code and Git-backed knowledge ingestion.'
      ].join('\n\n'),
    },
    {
      namespace: 'opensphere',
      sourceType: 'builtin',
      sourceId: 'workspace-policy',
      title: 'OpenSphere Workspace Policy Bands',
      version: '2026-07-04',
      metadata: { kind: 'policy' },
      content: [
        'OpenSphere also uses Workspace policy gates for navigation and role access. Existing policy examples include Foundation, Customer, Website, and MOSS.',
        'These policy gates are not the same as the OpenSphere 10 Perspective model. OAA should explain the difference when users ask.'
      ].join('\n\n'),
    },
  ];
}

async function upsertKnowledgeDocument(doc, actor = null) {
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) throw { code: 503, msg: 'Backbone PostgreSQL is not configured for OAA knowledge' };
  const namespace = String(doc.namespace || 'opensphere').trim() || 'opensphere';
  const sourceType = String(doc.sourceType || doc.source_type || 'manual').trim() || 'manual';
  const sourceId = String(doc.sourceId || doc.source_id || '').trim();
  const title = String(doc.title || sourceId || 'Untitled').trim();
  const content = String(doc.content || '').trim();
  if (!sourceId) throw { code: 400, msg: 'sourceId required' };
  if (!content) throw { code: 400, msg: 'content required' };
  const metadata = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
  const version = doc.version ? String(doc.version) : null;
  const contentHash = createHash('sha256').update(content).digest('hex');
  const id = randomUUID();
  const upsert = await pool.query(`
    INSERT INTO oaa_knowledge_documents (id, namespace, source_type, source_id, title, version, metadata, content_hash)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
    ON CONFLICT (namespace, source_type, source_id)
    DO UPDATE SET title = EXCLUDED.title, version = EXCLUDED.version, metadata = EXCLUDED.metadata,
      content_hash = EXCLUDED.content_hash, updated_at = now()
    RETURNING id, content_hash
  `, [id, namespace, sourceType, sourceId, title, version, JSON.stringify(metadata), contentHash]);
  const docId = upsert.rows[0].id;
  await pool.query('DELETE FROM oaa_knowledge_chunks WHERE document_id = $1', [docId]);
  const chunks = chunkText(content);
  let embeddingMode = 'hash';
  let embeddingProvider = 'local';
  let embeddingModel = `hash-${OAA_EMBED_DIM}`;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const embedding = await embeddingVector(`${title}\n${chunk}`, { keyId: doc.embeddingKeyId || '', strict: doc.strictEmbedding === true });
    embeddingMode = embedding.source.mode;
    embeddingProvider = embedding.source.provider;
    embeddingModel = embedding.source.model;
    const emb = vectorLiteral(embedding.vector);
    await pool.query(`
      INSERT INTO oaa_knowledge_chunks (id, document_id, chunk_index, content, embedding, metadata)
      VALUES ($1, $2, $3, $4, $5::vector, $6::jsonb)
    `, [randomUUID(), docId, i, chunk, emb, JSON.stringify({ title, namespace, sourceType, sourceId, embedding: embedding.source, ...metadata })]);
  }
  audit(actor, 'knowledge-upsert', `${namespace}/${sourceType}/${sourceId}`, 'ok', `${chunks.length} chunks / ${embeddingMode}`);
  return { id: docId, chunks: chunks.length, contentHash, embeddingMode, embeddingProvider, embeddingModel };
}

async function seedBuiltinKnowledge(force = false, actor = null) {
  if (!OAA_RAG_ENABLED) return { seeded: false, reason: 'rag disabled' };
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) return { seeded: false, reason: 'postgres not configured' };
  if (pgSeedReady && !force) return { seeded: false, reason: 'already ready' };
  const count = await pool.query("SELECT count(*)::int AS n FROM oaa_knowledge_documents WHERE namespace = 'opensphere' AND source_type = 'builtin'");
  if (count.rows[0].n > 0 && !force) {
    pgSeedReady = true;
    return { seeded: false, reason: 'builtin exists' };
  }
  let chunks = 0;
  for (const doc of builtInKnowledgeDocs()) {
    const out = await upsertKnowledgeDocument(doc, actor);
    chunks += out.chunks;
  }
  pgSeedReady = true;
  return { seeded: true, documents: builtInKnowledgeDocs().length, chunks };
}

async function knowledgeStats() {
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) throw { code: 503, msg: 'Backbone PostgreSQL is not configured for OAA knowledge' };
  const [counts, modes, manualSources, keys] = await Promise.all([
    pool.query(`
    SELECT
      (SELECT count(*)::int FROM oaa_knowledge_documents) AS documents,
      (SELECT count(*)::int FROM oaa_knowledge_chunks) AS chunks,
      (SELECT count(*)::int FROM oaa_knowledge_documents WHERE source_type = 'manual') AS "manualDocuments",
      (
        SELECT count(*)::int
        FROM oaa_knowledge_chunks c
        JOIN oaa_knowledge_documents d ON d.id = c.document_id
        WHERE d.source_type = 'manual'
      ) AS "manualChunks",
      (SELECT count(*)::int FROM oaa_manual_concepts) AS "manualConcepts",
      (SELECT count(*)::int FROM oaa_manual_relations) AS "manualRelations"
    `),
    pool.query(`
      SELECT COALESCE(metadata->'embedding'->>'mode', 'unknown') AS mode, count(*)::int AS chunks
      FROM oaa_knowledge_chunks
      GROUP BY 1
      ORDER BY 1
    `),
    pool.query(`
      SELECT COALESCE(d.metadata->'source'->>'id', d.source_id) AS source, count(DISTINCT d.id)::int AS documents, count(c.id)::int AS chunks
      FROM oaa_knowledge_documents d
      LEFT JOIN oaa_knowledge_chunks c ON c.document_id = d.id
      WHERE d.source_type = 'manual'
      GROUP BY 1
      ORDER BY documents DESC, source
      LIMIT 8
    `),
    listKeys().catch(() => []),
  ]);
  const embeddingKeys = keys.filter((k) => k.enabled && k.embeddingModel).map((k) => ({
    id: k.id,
    provider: k.provider,
    displayName: k.displayName,
    embeddingModel: k.embeddingModel,
  }));
  return {
    enabled: OAA_RAG_ENABLED,
    embedDim: OAA_EMBED_DIM,
    manualSeedPath: OAA_MANUAL_SEED_PATH,
    ...counts.rows[0],
    manualSources: manualSources.rows,
    embeddingModes: modes.rows,
    embeddingKeys,
  };
}

async function searchKnowledge(query, limit = OAA_RAG_TOP_K) {
  if (!OAA_RAG_ENABLED || !String(query || '').trim()) return [];
  const pool = getPgPool();
  if (!pool) return [];
  await seedBuiltinKnowledge();
  const embedding = await embeddingVector(query);
  const emb = vectorLiteral(embedding.vector);
  const r = await pool.query(`
    SELECT
      d.title,
      d.source_type AS "sourceType",
      d.source_id AS "sourceId",
      c.chunk_index AS "chunkIndex",
      c.content,
      c.metadata,
      1 - (c.embedding <=> $1::vector) AS score
    FROM oaa_knowledge_chunks c
    JOIN oaa_knowledge_documents d ON d.id = c.document_id
    ORDER BY c.embedding <=> $1::vector
    LIMIT $2
  `, [emb, limit]);
  return r.rows.map((x) => {
    const metadata = x.metadata && typeof x.metadata === 'object' ? x.metadata : {};
    return {
      ...x,
      metadata,
      score: Number(x.score || 0),
      authorityTier: Number.isInteger(Number(metadata.authorityTier)) ? Number(metadata.authorityTier) : null,
      documentType: metadata.documentType || metadata.kind || '',
      sectionHeading: metadata.sectionHeading || '',
      route: metadata.route || '',
      sourcePath: metadata.sourcePath || '',
      sourceUrl: metadata.sourceUrl || '',
      sourceName: metadata.source?.name || metadata.source?.id || '',
      queryEmbedding: embedding.source,
    };
  });
}

function manualDocFromRow(row) {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    id: row.id,
    namespace: row.namespace,
    sourceType: row.sourceType || row.source_type || 'manual',
    sourceId: row.sourceId || row.source_id || '',
    title: row.title || '',
    version: row.version || '',
    updatedAt: row.updatedAt || row.updated_at || '',
    chunkCount: Number(row.chunkCount || row.chunk_count || 0),
    summary: trimText(row.summary || ''),
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
  };
}

async function ensureManualRegistryReady() {
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) throw { code: 503, msg: 'Backbone PostgreSQL is not configured for Manual Registry' };
  await seedBundledManualKnowledgeIfEmpty();
  return pool;
}

async function listManualSources() {
  const pool = await ensureManualRegistryReady();
  const r = await pool.query(`
    SELECT
      COALESCE(metadata->'source'->>'id', source_id) AS id,
      COALESCE(metadata->'source'->>'type', 'manual') AS type,
      COALESCE(metadata->'source'->>'name', metadata->'source'->>'id', source_id) AS name,
      MIN(COALESCE((metadata->>'authorityTier')::int, 4)) AS "authorityTier",
      count(*)::int AS documents,
      max(updated_at) AS "updatedAt"
    FROM oaa_knowledge_documents
    WHERE source_type = 'manual'
    GROUP BY 1, 2, 3
    ORDER BY "authorityTier" ASC, name
  `);
  return {
    schema: 'manual-sources.opensphere.io/v1alpha1',
    generatedAt: new Date().toISOString(),
    items: r.rows,
  };
}

async function listManualDocuments(options = {}) {
  const pool = await ensureManualRegistryReady();
  const q = String(options.q || '').trim();
  const source = String(options.source || '').trim();
  const limit = Math.max(1, Math.min(100, Number(options.limit || 40) || 40));
  const params = [limit];
  const where = ["d.source_type = 'manual'"];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(
      d.title ILIKE $${params.length}
      OR d.source_id ILIKE $${params.length}
      OR d.metadata::text ILIKE $${params.length}
      OR EXISTS (
        SELECT 1 FROM oaa_knowledge_chunks cx
        WHERE cx.document_id = d.id AND cx.content ILIKE $${params.length}
      )
    )`);
  }
  if (source) {
    params.push(source);
    where.push(`COALESCE(d.metadata->'source'->>'id', d.source_id) = $${params.length}`);
  }
  const r = await pool.query(`
    SELECT d.id, d.namespace, d.source_type AS "sourceType", d.source_id AS "sourceId",
           d.title, d.version, d.metadata, d.updated_at AS "updatedAt",
           count(c.id)::int AS "chunkCount",
           left(string_agg(c.content, ' ' ORDER BY c.chunk_index), 360) AS summary
    FROM oaa_knowledge_documents d
    LEFT JOIN oaa_knowledge_chunks c ON c.document_id = d.id
    WHERE ${where.join(' AND ')}
    GROUP BY d.id
    ORDER BY COALESCE((d.metadata->>'authorityTier')::int, 4), d.title
    LIMIT $1
  `, params);
  return {
    schema: 'manual-documents.opensphere.io/v1alpha1',
    generatedAt: new Date().toISOString(),
    query: q,
    source,
    items: r.rows.map(manualDocFromRow),
  };
}

async function getManualDocument(sourceId) {
  const pool = await ensureManualRegistryReady();
  const sid = String(sourceId || '').trim();
  if (!sid) throw { code: 400, msg: 'sourceId required' };
  const doc = await pool.query(`
    SELECT d.id, d.namespace, d.source_type AS "sourceType", d.source_id AS "sourceId",
           d.title, d.version, d.metadata, d.updated_at AS "updatedAt",
           count(c.id)::int AS "chunkCount",
           left(string_agg(c.content, ' ' ORDER BY c.chunk_index), 360) AS summary
    FROM oaa_knowledge_documents d
    LEFT JOIN oaa_knowledge_chunks c ON c.document_id = d.id
    WHERE d.source_type = 'manual' AND d.source_id = $1
    GROUP BY d.id
    LIMIT 1
  `, [sid]);
  if (!doc.rows.length) throw { code: 404, msg: 'manual document not found' };
  const chunks = await pool.query(`
    SELECT chunk_index AS "chunkIndex", content, metadata
    FROM oaa_knowledge_chunks
    WHERE document_id = $1
    ORDER BY chunk_index
  `, [doc.rows[0].id]);
  const bindings = await pool.query(`
    SELECT id, source_id AS "sourceId", section_id AS "sectionId", tool_id AS "toolId",
           intent, risk_level AS "riskLevel", confirmation, spec
    FROM oaa_manual_action_bindings
    WHERE source_id = $1 OR section_id ILIKE $2
    ORDER BY risk_level, id
    LIMIT 24
  `, [sid, `%${sid}%`]);
  return {
    schema: 'manual-document.opensphere.io/v1alpha1',
    generatedAt: new Date().toISOString(),
    item: manualDocFromRow(doc.rows[0]),
    chunks: chunks.rows,
    actionBindings: bindings.rows,
  };
}

async function searchManualRegistry(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) return { schema: 'manual-search.opensphere.io/v1alpha1', query: q, items: [] };
  const pool = await ensureManualRegistryReady();
  const embedding = await embeddingVector(q);
  const emb = vectorLiteral(embedding.vector);
  const n = Math.max(1, Math.min(25, Number(limit || 8) || 8));
  const r = await pool.query(`
    SELECT
      d.id AS "documentId",
      d.title,
      d.namespace,
      d.source_id AS "sourceId",
      d.version,
      d.metadata,
      c.chunk_index AS "chunkIndex",
      c.content,
      c.metadata AS "chunkMetadata",
      1 - (c.embedding <=> $1::vector) AS score
    FROM oaa_knowledge_chunks c
    JOIN oaa_knowledge_documents d ON d.id = c.document_id
    WHERE d.source_type = 'manual'
    ORDER BY c.embedding <=> $1::vector
    LIMIT $2
  `, [emb, n]);
  return {
    schema: 'manual-search.opensphere.io/v1alpha1',
    generatedAt: new Date().toISOString(),
    query: q,
    embedding: embedding.source,
    items: r.rows.map((x) => {
      const metadata = x.metadata && typeof x.metadata === 'object' ? x.metadata : {};
      const chunkMetadata = x.chunkMetadata && typeof x.chunkMetadata === 'object' ? x.chunkMetadata : {};
      return {
        documentId: x.documentId,
        sourceId: x.sourceId,
        title: x.title,
        version: x.version || '',
        score: Number(x.score || 0),
        chunkIndex: x.chunkIndex,
        excerpt: trimText(x.content, 420),
        metadata,
        chunkMetadata,
        documentType: metadata.documentType || '',
        authorityTier: Number.isInteger(Number(metadata.authorityTier)) ? Number(metadata.authorityTier) : null,
        route: metadata.route || '',
        sourcePath: metadata.sourcePath || '',
        sourceUrl: metadata.sourceUrl || '',
        sourceName: metadata.source?.name || metadata.source?.id || '',
      };
    }),
  };
}

async function listManualConceptGraph(query = '', limit = 64) {
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) return { schema: 'manual-concept-graph.opensphere.io/v1alpha1', concepts: [], relations: [] };
  const q = String(query || '').trim();
  const n = Math.max(1, Math.min(128, Number(limit || 64) || 64));
  const params = [n];
  let where = '';
  if (q) {
    const terms = Array.from(new Set([
      q,
      ...q.split(/[^A-Za-z0-9가-힣_-]+/).map((x) => x.trim()).filter((x) => x.length >= 3),
    ])).slice(0, 8);
    params.push(terms.map((x) => `%${x}%`));
    where = `
      WHERE id ILIKE ANY($2::text[])
         OR name ILIKE ANY($2::text[])
         OR summary ILIKE ANY($2::text[])
         OR definition ILIKE ANY($2::text[])
         OR EXISTS (SELECT 1 FROM unnest(aliases) AS a WHERE a ILIKE ANY($2::text[]))
         OR EXISTS (SELECT 1 FROM unnest(tags) AS t WHERE t ILIKE ANY($2::text[]))
    `;
  }
  const concepts = await pool.query(`
    SELECT id, namespace, type, name, aliases, summary, definition,
           authority_tier AS "authorityTier", status, source_ids AS "sourceIds",
           section_ids AS "sectionIds", tags, metadata, updated_at AS "updatedAt"
    FROM oaa_manual_concepts
    ${where}
    ORDER BY authority_tier ASC, type, name
    LIMIT $1
  `, params);
  const ids = concepts.rows.map((r) => r.id);
  let relationRows = [];
  if (ids.length) {
    const rels = await pool.query(`
      SELECT id, namespace, from_id AS "fromId", to_id AS "toId", relation, confidence,
             authority_tier AS "authorityTier", source_id AS "sourceId", section_id AS "sectionId",
             metadata, updated_at AS "updatedAt"
      FROM oaa_manual_relations
      WHERE from_id = ANY($1::text[]) OR to_id = ANY($1::text[])
      ORDER BY authority_tier ASC, relation, from_id, to_id
      LIMIT 256
    `, [ids]);
    relationRows = rels.rows;
  }
  return {
    schema: 'manual-concept-graph.opensphere.io/v1alpha1',
    generatedAt: new Date().toISOString(),
    query: q,
    concepts: concepts.rows,
    relations: relationRows,
  };
}

async function reembedKnowledge(body = {}, actor = null) {
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) throw { code: 503, msg: 'Backbone PostgreSQL is not configured for OAA knowledge' };
  const keyId = String(body.keyId || '').trim();
  const strict = body.strict !== false;
  const rows = await pool.query(`
    SELECT c.id, c.content, c.metadata, d.title
    FROM oaa_knowledge_chunks c
    JOIN oaa_knowledge_documents d ON d.id = c.document_id
    ORDER BY d.source_id, c.chunk_index
  `);
  let updated = 0;
  let provider = '';
  let model = '';
  let mode = '';
  for (const row of rows.rows) {
    const embedding = await embeddingVector(`${row.title}\n${row.content}`, { keyId, strict });
    provider = embedding.source.provider;
    model = embedding.source.model;
    mode = embedding.source.mode;
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    await pool.query(`
      UPDATE oaa_knowledge_chunks
      SET embedding = $2::vector,
          metadata = $3::jsonb
      WHERE id = $1
    `, [row.id, vectorLiteral(embedding.vector), JSON.stringify({ ...metadata, embedding: embedding.source })]);
    updated += 1;
  }
  audit(actor, 'knowledge-reembed', 'all', 'ok', `${updated} chunks / ${mode || 'none'} / ${provider || 'none'} / ${model || 'none'}`);
  return { updated, embeddingMode: mode || '', embeddingProvider: provider || '', embeddingModel: model || '', embedDim: OAA_EMBED_DIM };
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

async function upsertManualConcepts(concepts, defaults, actor = null) {
  if (!Array.isArray(concepts) || !concepts.length) return { concepts: 0, items: [] };
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) throw { code: 503, msg: 'Backbone PostgreSQL is not configured for OAA concepts' };
  const items = [];
  for (const raw of concepts) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim();
    if (!id) throw { code: 400, msg: 'manual concept id required' };
    const name = String(raw.name || id).trim();
    const summary = String(raw.summary || raw.definition || name).trim();
    const definition = String(raw.definition || raw.summary || name).trim();
    const metadata = compactObject({
      ...(raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}),
      schema: 'manual-concept.opensphere.io/v1alpha1',
    });
    await pool.query(`
      INSERT INTO oaa_manual_concepts (
        id, namespace, type, name, aliases, summary, definition, authority_tier, status,
        source_ids, section_ids, tags, metadata
      )
      VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10::text[], $11::text[], $12::text[], $13::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        namespace = EXCLUDED.namespace,
        type = EXCLUDED.type,
        name = EXCLUDED.name,
        aliases = EXCLUDED.aliases,
        summary = EXCLUDED.summary,
        definition = EXCLUDED.definition,
        authority_tier = EXCLUDED.authority_tier,
        status = EXCLUDED.status,
        source_ids = EXCLUDED.source_ids,
        section_ids = EXCLUDED.section_ids,
        tags = EXCLUDED.tags,
        metadata = EXCLUDED.metadata,
        updated_at = now()
    `, [
      id,
      String(raw.namespace || defaults.defaultNamespace || 'opensphere').trim() || 'opensphere',
      String(raw.type || 'term').trim() || 'term',
      name,
      stringList(raw.aliases),
      summary,
      definition,
      authorityTier(raw.authorityTier, defaults.sourceTier),
      String(raw.status || 'active').trim() || 'active',
      stringList(raw.sourceIds || raw.source_ids),
      stringList(raw.sectionIds || raw.section_ids),
      stringList(raw.tags),
      JSON.stringify(metadata),
    ]);
    items.push({ id, name, type: String(raw.type || 'term').trim() || 'term' });
  }
  audit(actor, 'manual-concepts-upsert', defaults.sourceId || 'manual-seed', 'ok', `${items.length} concepts`);
  return { concepts: items.length, items };
}

async function upsertManualRelations(relations, defaults, actor = null) {
  if (!Array.isArray(relations) || !relations.length) return { relations: 0, items: [] };
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) throw { code: 503, msg: 'Backbone PostgreSQL is not configured for OAA relations' };
  const items = [];
  for (const raw of relations) {
    if (!raw || typeof raw !== 'object') continue;
    const fromId = String(raw.fromId || raw.from_id || '').trim();
    const toId = String(raw.toId || raw.to_id || '').trim();
    const relation = String(raw.relation || '').trim();
    if (!fromId || !toId || !relation) throw { code: 400, msg: 'manual relation fromId, toId, relation required' };
    const id = String(raw.id || `relation:${fromId}:${relation}:${toId}`).trim();
    const metadata = compactObject({
      ...(raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}),
      schema: 'manual-relation.opensphere.io/v1alpha1',
    });
    await pool.query(`
      INSERT INTO oaa_manual_relations (
        id, namespace, from_id, to_id, relation, confidence, authority_tier, source_id, section_id, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        namespace = EXCLUDED.namespace,
        from_id = EXCLUDED.from_id,
        to_id = EXCLUDED.to_id,
        relation = EXCLUDED.relation,
        confidence = EXCLUDED.confidence,
        authority_tier = EXCLUDED.authority_tier,
        source_id = EXCLUDED.source_id,
        section_id = EXCLUDED.section_id,
        metadata = EXCLUDED.metadata,
        updated_at = now()
    `, [
      id,
      String(raw.namespace || defaults.defaultNamespace || 'opensphere').trim() || 'opensphere',
      fromId,
      toId,
      relation,
      String(raw.confidence || 'manual').trim() || 'manual',
      authorityTier(raw.authorityTier, defaults.sourceTier),
      String(raw.sourceId || raw.source_id || defaults.sourceId || 'manual-seed').trim(),
      String(raw.sectionId || raw.section_id || '').trim() || null,
      JSON.stringify(metadata),
    ]);
    items.push({ id, fromId, relation, toId });
  }
  audit(actor, 'manual-relations-upsert', defaults.sourceId || 'manual-seed', 'ok', `${items.length} relations`);
  return { relations: items.length, items };
}

async function upsertManualSeedManifest(body = {}, actor = null) {
  if (!body || typeof body !== 'object') throw { code: 400, msg: 'manual seed manifest required' };
  const source = body.source && typeof body.source === 'object' ? body.source : {};
  const sourceId = String(source.id || 'manual-upload').trim();
  const sourceType = String(source.type || 'upload').trim();
  const sourceName = String(source.name || sourceId).trim();
  const defaultNamespace = String(source.defaultNamespace || 'opensphere').trim() || 'opensphere';
  const defaultLanguage = String(source.defaultLanguage || 'mixed').trim() || 'mixed';
  const sourceTier = authorityTier(source.authorityTier, 3);
  const docs = Array.isArray(body.documents) ? body.documents : [];
  if (!docs.length) throw { code: 400, msg: 'manual seed documents required' };

  const results = [];
  let chunks = 0;
  for (const raw of docs) {
    if (!raw || typeof raw !== 'object') continue;
    const sourcePath = String(raw.sourcePath || raw.source_path || '').trim();
    const route = String(raw.route || '').trim();
    const rawSourceId = String(raw.sourceId || raw.source_id || sourcePath || route || '').trim();
    if (!rawSourceId) throw { code: 400, msg: 'manual document sourceId required' };
    const tier = authorityTier(raw.authorityTier, sourceTier);
    const metadata = {
      schema: 'manual.opensphere.io/v1alpha1',
      source: { id: sourceId, type: sourceType, name: sourceName },
      documentType: String(raw.documentType || raw.document_type || 'reference').trim() || 'reference',
      authorityTier: tier,
      status: String(raw.status || 'active').trim() || 'active',
      language: String(raw.language || defaultLanguage).trim() || defaultLanguage,
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
      acl: raw.acl && typeof raw.acl === 'object' ? raw.acl : undefined,
      checksum: String(raw.checksum || '').trim(),
    };
    const out = await upsertKnowledgeDocument({
      namespace: raw.namespace || defaultNamespace,
      sourceType: 'manual',
      sourceId: rawSourceId,
      title: raw.title || rawSourceId,
      version: raw.version || body.version || null,
      metadata: compactObject(metadata),
      content: raw.content,
      embeddingKeyId: raw.embeddingKeyId || body.embeddingKeyId || '',
      strictEmbedding: raw.strictEmbedding === true || body.strictEmbedding === true,
    }, actor);
    chunks += out.chunks;
    results.push({ sourceId: rawSourceId, title: raw.title || rawSourceId, chunks: out.chunks, embeddingMode: out.embeddingMode });
  }
  const defaults = { sourceId, sourceType, sourceName, sourceTier, defaultNamespace, defaultLanguage };
  const conceptOut = await upsertManualConcepts(body.concepts, defaults, actor);
  const relationOut = await upsertManualRelations(body.relations, defaults, actor);
  audit(actor, 'knowledge-manual-seed', sourceId, 'ok', `${results.length} documents / ${chunks} chunks / ${conceptOut.concepts} concepts / ${relationOut.relations} relations`);
  return {
    schema: 'manual-seed.opensphere.io/v1alpha1',
    source: { id: sourceId, type: sourceType, name: sourceName },
    documents: results.length,
    chunks,
    concepts: conceptOut.concepts,
    relations: relationOut.relations,
    items: results,
  };
}

function loadBundledManualSeedManifest() {
  const raw = fs.readFileSync(OAA_MANUAL_SEED_PATH, 'utf8');
  return JSON.parse(raw);
}

async function seedBundledManualKnowledge(actor = null) {
  let manifest;
  try {
    manifest = loadBundledManualSeedManifest();
  } catch (e) {
    throw { code: 503, msg: `bundled manual seed unavailable: ${e.message || e}` };
  }
  const out = await upsertManualSeedManifest(manifest, actor);
  audit(actor, 'knowledge-bundled-manual-seed', OAA_MANUAL_SEED_PATH, 'ok', `${out.documents} documents / ${out.chunks} chunks`);
  return { ...out, bundled: true, seedPath: OAA_MANUAL_SEED_PATH, version: manifest.version || null };
}

async function seedBundledManualKnowledgeIfEmpty(actor = null) {
  if (!OAA_RAG_ENABLED) return { seeded: false, reason: 'rag disabled' };
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) return { seeded: false, reason: 'postgres not configured' };
  let manifest;
  try {
    manifest = loadBundledManualSeedManifest();
  } catch (e) {
    return { seeded: false, reason: `bundled manual seed unavailable: ${e.message || e}` };
  }
  const docs = Array.isArray(manifest.documents) ? manifest.documents : [];
  const concepts = Array.isArray(manifest.concepts) ? manifest.concepts : [];
  const relations = Array.isArray(manifest.relations) ? manifest.relations : [];
  const current = await pool.query(`
    SELECT source_id, metadata->>'checksum' AS checksum
    FROM oaa_knowledge_documents
    WHERE source_type = 'manual'
      AND metadata->'source'->>'id' = 'opensphere-core-manuals'
  `);
  const structure = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM oaa_manual_concepts WHERE $1 = ANY(source_ids)) AS concepts,
      (SELECT count(*)::int FROM oaa_manual_relations WHERE source_id = $1) AS relations
  `, ['opensphere-core-manuals']);
  const bySourceId = new Map(current.rows.map((r) => [r.source_id, r.checksum || '']));
  const missing = docs.filter((d) => !bySourceId.has(String(d.sourceId || d.source_id || ''))).map((d) => d.sourceId || d.source_id);
  const changed = docs
    .filter((d) => {
      const id = String(d.sourceId || d.source_id || '');
      const checksum = String(d.checksum || '');
      return id && bySourceId.has(id) && checksum && bySourceId.get(id) !== checksum;
    })
    .map((d) => d.sourceId || d.source_id);
  const missingConcepts = concepts.length > Number(structure.rows[0]?.concepts || 0);
  const missingRelations = relations.length > Number(structure.rows[0]?.relations || 0);
  if (!missing.length && !changed.length && !missingConcepts && !missingRelations && current.rows.length >= docs.length) {
    return { seeded: false, reason: 'bundled manuals up to date', documents: current.rows.length };
  }
  const out = await seedBundledManualKnowledge(actor);
  return { ...out, seeded: true, missing, changed, missingConcepts, missingRelations };
}

function trimText(value, max = 220) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '...' : s;
}

function podReady(pod) {
  const statuses = pod.status?.containerStatuses || [];
  if (!statuses.length) return '0/0';
  const ready = statuses.filter((s) => s.ready).length;
  return `${ready}/${statuses.length}`;
}

function podRestarts(pod) {
  return (pod.status?.containerStatuses || []).reduce((n, s) => n + (Number(s.restartCount) || 0), 0);
}

function podReason(pod) {
  const waiting = (pod.status?.containerStatuses || []).find((s) => s.state?.waiting)?.state?.waiting;
  const terminated = (pod.status?.containerStatuses || []).find((s) => s.state?.terminated)?.state?.terminated;
  return waiting?.reason || terminated?.reason || pod.status?.reason || '';
}

function workloadRow(x) {
  const spec = x.spec || {};
  const status = x.status || {};
  return {
    name: x.metadata?.name || '',
    kind: x.kind || '',
    desired: Number(spec.replicas ?? spec.desiredNumberScheduled ?? 0),
    ready: Number(status.readyReplicas ?? status.numberReady ?? 0),
    available: Number(status.availableReplicas ?? status.updatedNumberScheduled ?? 0),
    updated: Number(status.updatedReplicas ?? status.updatedNumberScheduled ?? 0),
  };
}

async function k8sGet(path) {
  const r = await k8s('GET', path);
  if (!r.ok) return { ok: false, status: r.status, error: r.json?.message || `HTTP ${r.status}`, items: [] };
  return { ok: true, status: r.status, items: r.json?.items || [], json: r.json };
}

function requireAllowedNamespace(ns) {
  const value = String(ns || '').trim();
  if (!K8S_NAME_RE.test(value) || !OAA_ENV_NAMESPACES.includes(value)) throw { code: 400, msg: 'namespace is not allowed for OAA tools' };
  return value;
}

function requireK8sName(value, field = 'name') {
  const s = String(value || '').trim();
  if (!K8S_NAME_RE.test(s)) throw { code: 400, msg: `invalid ${field}` };
  return s;
}

function requireConfirm(actual, expected) {
  if (String(actual || '').trim() !== expected) throw { code: 400, msg: `confirmation required: ${expected}` };
}

async function getDeployment(ns, name) {
  const r = await k8s('GET', `/apis/apps/v1/namespaces/${ns}/deployments/${name}`);
  if (r.status === 404) throw { code: 404, msg: 'deployment not found' };
  if (!r.ok) throw { code: 502, msg: `deployment read HTTP ${r.status}` };
  return r.json;
}

async function getPod(ns, name) {
  const r = await k8s('GET', `/api/v1/namespaces/${ns}/pods/${name}`);
  if (r.status === 404) throw { code: 404, msg: 'pod not found' };
  if (!r.ok) throw { code: 502, msg: `pod read HTTP ${r.status}` };
  return r.json;
}

function selectorFromMatchLabels(labels = {}) {
  return Object.entries(labels)
    .filter(([k, v]) => k && v)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join(',');
}

async function objectEvents(ns, kind, name) {
  const fieldSelector = encodeURIComponent(`involvedObject.kind=${kind},involvedObject.name=${name}`);
  const r = await k8sGet(`/api/v1/namespaces/${ns}/events?fieldSelector=${fieldSelector}&limit=30`);
  return (r.items || [])
    .map((e) => ({
      type: e.type || '',
      reason: e.reason || '',
      message: trimText(e.message, 220),
      time: e.lastTimestamp || e.eventTime || e.firstTimestamp || '',
    }))
    .sort((a, b) => String(b.time).localeCompare(String(a.time)))
    .slice(0, 10);
}

function summarizeConditions(items = []) {
  return (items || []).map((c) => ({
    type: c.type || '',
    status: c.status || '',
    reason: c.reason || '',
    message: trimText(c.message || '', 180),
  }));
}

async function describePod(body = {}, actor = null) {
  const ns = requireAllowedNamespace(body.namespace);
  const name = requireK8sName(body.name || body.pod, 'pod');
  const pod = await getPod(ns, name);
  const events = await objectEvents(ns, 'Pod', name);
  const containers = (pod.status?.containerStatuses || []).map((c) => ({
    name: c.name,
    ready: Boolean(c.ready),
    restartCount: c.restartCount || 0,
    image: c.image || '',
    state: c.state?.waiting?.reason || c.state?.terminated?.reason || (c.state?.running ? 'Running' : ''),
  }));
  audit(actor, 'k8s-describe-pod', `${ns}/${name}`, 'ok', '');
  return {
    action: 'describe-pod',
    namespace: ns,
    name,
    phase: pod.status?.phase || '',
    node: pod.spec?.nodeName || '',
    podIP: pod.status?.podIP || '',
    ready: podReady(pod),
    restarts: podRestarts(pod),
    reason: podReason(pod),
    containers,
    conditions: summarizeConditions(pod.status?.conditions || []),
    events,
  };
}

async function describeDeployment(body = {}, actor = null) {
  const ns = requireAllowedNamespace(body.namespace);
  const name = requireK8sName(body.name || body.deployment, 'deployment');
  const dep = await getDeployment(ns, name);
  const selector = selectorFromMatchLabels(dep.spec?.selector?.matchLabels || {});
  const pods = selector
    ? await k8sGet(`/api/v1/namespaces/${ns}/pods?labelSelector=${selector}&limit=30`)
    : { items: [] };
  const events = await objectEvents(ns, 'Deployment', name);
  const podRows = (pods.items || []).map((p) => ({
    name: p.metadata?.name || '',
    phase: p.status?.phase || '',
    ready: podReady(p),
    restarts: podRestarts(p),
    reason: podReason(p),
  })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20);
  audit(actor, 'k8s-describe-deployment', `${ns}/${name}`, 'ok', '');
  return {
    action: 'describe-deployment',
    namespace: ns,
    name,
    generation: dep.metadata?.generation || null,
    observedGeneration: dep.status?.observedGeneration || null,
    replicas: dep.spec?.replicas ?? null,
    readyReplicas: dep.status?.readyReplicas || 0,
    availableReplicas: dep.status?.availableReplicas || 0,
    updatedReplicas: dep.status?.updatedReplicas || 0,
    selector: dep.spec?.selector?.matchLabels || {},
    conditions: summarizeConditions(dep.status?.conditions || []),
    pods: podRows,
    events,
  };
}

async function rolloutStatus(body = {}, actor = null) {
  const out = await describeDeployment(body, actor);
  const desired = Number(out.replicas || 0);
  const generationObserved = Number(out.observedGeneration || 0) >= Number(out.generation || 0);
  const updated = Number(out.updatedReplicas || 0) >= desired;
  const available = Number(out.availableReplicas || 0) >= desired;
  const ready = Number(out.readyReplicas || 0) >= desired;
  const complete = generationObserved && updated && available && ready;
  const progressing = (out.conditions || []).find((c) => c.type === 'Progressing');
  const availableCondition = (out.conditions || []).find((c) => c.type === 'Available');
  const status = complete ? 'complete' : (progressing?.status === 'True' ? 'progressing' : 'pending');
  audit(actor, 'k8s-rollout-status', `${out.namespace}/${out.name}`, 'ok', status);
  return {
    action: 'rollout-status',
    namespace: out.namespace,
    name: out.name,
    status,
    complete,
    desired,
    generation: out.generation,
    observedGeneration: out.observedGeneration,
    readyReplicas: out.readyReplicas,
    availableReplicas: out.availableReplicas,
    updatedReplicas: out.updatedReplicas,
    progressing,
    availableCondition,
    pods: out.pods,
    events: out.events,
  };
}

async function restartDeployment(body = {}, actor = null) {
  const ns = requireAllowedNamespace(body.namespace);
  const name = requireK8sName(body.name || body.deployment, 'deployment');
  requireConfirm(body.confirm, `restart deployment ${ns}/${name}`);
  const before = await getDeployment(ns, name);
  const now = new Date().toISOString();
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            'kubectl.kubernetes.io/restartedAt': now,
            'opensphere.io/oaa-restarted-at': now,
            'opensphere.io/oaa-restarted-by': actor?.username || 'unknown',
          },
        },
      },
    },
  };
  const r = await k8s('PATCH', `/apis/apps/v1/namespaces/${ns}/deployments/${name}`, patch);
  if (!r.ok) throw { code: 502, msg: `deployment restart patch HTTP ${r.status}` };
  audit(actor, 'k8s-restart-deployment', `${ns}/${name}`, 'ok', body.reason || '');
  return {
    action: 'restart-deployment',
    namespace: ns,
    name,
    previousGeneration: before.metadata?.generation || null,
    generation: r.json?.metadata?.generation || null,
    restartedAt: now,
  };
}

async function scaleDeployment(body = {}, actor = null) {
  const ns = requireAllowedNamespace(body.namespace);
  const name = requireK8sName(body.name || body.deployment, 'deployment');
  const replicas = Number(body.replicas);
  if (!Number.isInteger(replicas) || replicas < 0 || replicas > OAA_SCALE_MAX) throw { code: 400, msg: `replicas must be an integer between 0 and ${OAA_SCALE_MAX}` };
  requireConfirm(body.confirm, `scale deployment ${ns}/${name} to ${replicas}`);
  const before = await getDeployment(ns, name);
  const r = await k8s('PATCH', `/apis/apps/v1/namespaces/${ns}/deployments/${name}`, { spec: { replicas } });
  if (!r.ok) throw { code: 502, msg: `deployment scale patch HTTP ${r.status}` };
  audit(actor, 'k8s-scale-deployment', `${ns}/${name}`, 'ok', `replicas ${before.spec?.replicas ?? ''} -> ${replicas}; ${body.reason || ''}`);
  return {
    action: 'scale-deployment',
    namespace: ns,
    name,
    previousReplicas: before.spec?.replicas ?? null,
    replicas: r.json?.spec?.replicas ?? replicas,
    generation: r.json?.metadata?.generation || null,
  };
}

async function podLogs(body = {}, actor = null) {
  const ns = requireAllowedNamespace(body.namespace);
  const pod = requireK8sName(body.pod || body.name, 'pod');
  const container = body.container ? requireK8sName(body.container, 'container') : '';
  const tailLines = Math.max(1, Math.min(300, Number(body.tailLines || 120) || 120));
  const params = new URLSearchParams({ tailLines: String(tailLines) });
  if (container) params.set('container', container);
  const r = await k8s('GET', `/api/v1/namespaces/${ns}/pods/${pod}/log?${params.toString()}`);
  if (!r.ok) throw { code: r.status === 404 ? 404 : 502, msg: `pod logs HTTP ${r.status}` };
  audit(actor, 'k8s-pod-logs', `${ns}/${pod}`, 'ok', container || '');
  return {
    action: 'pod-logs',
    namespace: ns,
    pod,
    container,
    tailLines,
    text: String(r.json?.raw || '').slice(-20000),
  };
}

async function namespaceSnapshot(ns) {
  const [pods, services, events, deployments, statefulsets, daemonsets] = await Promise.all([
    k8sGet(`/api/v1/namespaces/${ns}/pods?limit=80`),
    k8sGet(`/api/v1/namespaces/${ns}/services?limit=80`),
    k8sGet(`/api/v1/namespaces/${ns}/events?limit=80`),
    k8sGet(`/apis/apps/v1/namespaces/${ns}/deployments?limit=80`),
    k8sGet(`/apis/apps/v1/namespaces/${ns}/statefulsets?limit=80`),
    k8sGet(`/apis/apps/v1/namespaces/${ns}/daemonsets?limit=80`),
  ]);
  const podRows = pods.items.map((p) => ({
    name: p.metadata?.name || '',
    phase: p.status?.phase || '',
    ready: podReady(p),
    restarts: podRestarts(p),
    reason: podReason(p),
    node: p.spec?.nodeName || '',
  })).sort((a, b) => (b.restarts - a.restarts) || a.name.localeCompare(b.name)).slice(0, 18);
  const unhealthyPods = podRows.filter((p) => p.phase !== 'Running' || !p.ready.startsWith(p.ready.split('/')[1] + '/') || p.restarts > 0 || p.reason);
  const eventRows = events.items
    .map((e) => ({
      type: e.type || '',
      reason: e.reason || '',
      object: e.involvedObject ? `${e.involvedObject.kind}/${e.involvedObject.name}` : '',
      message: trimText(e.message, 180),
      time: e.lastTimestamp || e.eventTime || e.firstTimestamp || '',
    }))
    .sort((a, b) => String(b.time).localeCompare(String(a.time)))
    .slice(0, 12);
  const serviceRows = services.items
    .map((s) => ({
      name: s.metadata?.name || '',
      type: s.spec?.type || '',
      clusterIP: s.spec?.clusterIP || '',
      ports: (s.spec?.ports || []).map((p) => {
        const name = p.name ? `${p.name}:` : '';
        const target = p.targetPort ? `->${p.targetPort}` : '';
        const node = p.nodePort ? `/node:${p.nodePort}` : '';
        return `${name}${p.port}${target}${node}`;
      }).join(', '),
      selector: s.spec?.selector || {},
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 30);
  const workloadRows = [
    ...deployments.items.map((x) => workloadRow({ ...x, kind: 'Deployment' })),
    ...statefulsets.items.map((x) => workloadRow({ ...x, kind: 'StatefulSet' })),
    ...daemonsets.items.map((x) => workloadRow({ ...x, kind: 'DaemonSet' })),
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)).slice(0, 30);
  return {
    namespace: ns,
    access: {
      pods: pods.ok ? 'ok' : pods.error,
      services: services.ok ? 'ok' : services.error,
      events: events.ok ? 'ok' : events.error,
      workloads: deployments.ok || statefulsets.ok || daemonsets.ok ? 'ok' : deployments.error,
    },
    counts: {
      pods: pods.items.length,
      services: services.items.length,
      events: events.items.length,
      workloads: deployments.items.length + statefulsets.items.length + daemonsets.items.length,
      unhealthyPods: unhealthyPods.length,
    },
    workloads: workloadRows,
    pods: podRows,
    services: serviceRows,
    unhealthyPods,
    recentEvents: eventRows,
  };
}

async function clusterPodSummary() {
  const pods = await k8sGet('/api/v1/pods?limit=5000');
  const phaseCounts = { Running: 0, Pending: 0, Failed: 0, Succeeded: 0, Unknown: 0 };
  const namespaceMap = new Map();
  const unhealthyPods = [];
  for (const p of pods.items || []) {
    const namespace = p.metadata?.namespace || 'default';
    const phase = p.status?.phase || 'Unknown';
    const key = phaseCounts[phase] == null ? 'Unknown' : phase;
    phaseCounts[key] += 1;
    if (!namespaceMap.has(namespace)) {
      namespaceMap.set(namespace, { namespace, pods: 0, running: 0, pending: 0, failed: 0, succeeded: 0, unknown: 0 });
    }
    const row = namespaceMap.get(namespace);
    row.pods += 1;
    if (key === 'Running') row.running += 1;
    else if (key === 'Pending') row.pending += 1;
    else if (key === 'Failed') row.failed += 1;
    else if (key === 'Succeeded') row.succeeded += 1;
    else row.unknown += 1;
    const ready = podReady(p);
    const restarts = podRestarts(p);
    const reason = podReason(p);
    const readyParts = ready.split('/');
    const allReady = readyParts.length === 2 && readyParts[0] === readyParts[1];
    if (phase !== 'Running' || !allReady || restarts > 0 || reason) {
      unhealthyPods.push({
        namespace,
        name: p.metadata?.name || '',
        phase,
        ready,
        restarts,
        reason,
      });
    }
  }
  const namespaces = [...namespaceMap.values()].sort((a, b) => a.namespace.localeCompare(b.namespace));
  return {
    access: pods.ok ? 'ok' : pods.error,
    totalPods: pods.items.length,
    phaseCounts,
    namespaces,
    unhealthyPods: unhealthyPods
      .sort((a, b) => (b.restarts - a.restarts) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
      .slice(0, 24),
  };
}

function sanitizePageContext(input = {}) {
  const ctx = input && typeof input === 'object' ? input : {};
  return {
    path: trimText(ctx.path || '', 160),
    hash: trimText(ctx.hash || '', 160),
    title: trimText(ctx.title || '', 120),
    selectedText: trimText(ctx.selectedText || '', 500),
  };
}

async function environmentSnapshot(body = {}, actor = null) {
  const context = sanitizePageContext(body.context || body.pageContext || {});
  const started = Date.now();
  const [cluster, namespaces] = await Promise.all([
    clusterPodSummary().catch((e) => ({
      access: e.message || String(e),
      totalPods: 0,
      phaseCounts: { Running: 0, Pending: 0, Failed: 0, Succeeded: 0, Unknown: 0 },
      namespaces: [],
      unhealthyPods: [],
    })),
    Promise.all(OAA_ENV_NAMESPACES.map((ns) => namespaceSnapshot(ns).catch((e) => ({
    namespace: ns,
    access: { error: e.message || String(e) },
    counts: { pods: 0, services: 0, events: 0, workloads: 0, unhealthyPods: 0 },
    workloads: [],
    pods: [],
    services: [],
    unhealthyPods: [],
    recentEvents: [],
    })))),
  ]);
  const out = {
    time: new Date().toISOString(),
    actor: actor?.username || 'unknown',
    pageContext: context,
    cluster,
    namespaces,
    latencyMs: Date.now() - started,
  };
  audit(actor, 'environment-snapshot', OAA_ENV_NAMESPACES.join(','), 'ok', `${namespaces.length} namespaces / ${cluster.totalPods || 0} cluster pods`);
  return out;
}

function environmentSystemMessage(snapshot) {
  const lines = [];
  lines.push('OpenSphere Live Environment Snapshot:');
  if (snapshot.pageContext?.path) lines.push(`Current console route: ${snapshot.pageContext.path}${snapshot.pageContext.hash || ''}`);
  if (snapshot.pageContext?.title) lines.push(`Browser title: ${snapshot.pageContext.title}`);
  if (snapshot.cluster) {
    const c = snapshot.cluster;
    const phases = c.phaseCounts || {};
    lines.push(`Cluster pod summary: totalPods=${c.totalPods || 0}, running=${phases.Running || 0}, pending=${phases.Pending || 0}, failed=${phases.Failed || 0}, succeeded=${phases.Succeeded || 0}, unknown=${phases.Unknown || 0}, access=${c.access || 'unknown'}`);
    const nsCounts = (c.namespaces || []).map((x) => `${x.namespace}=${x.pods}`).join('; ');
    if (nsCounts) lines.push(`Cluster namespace pod counts: ${nsCounts}`);
    const badClusterPods = (c.unhealthyPods || []).slice(0, 8).map((p) => `${p.namespace}/${p.name} phase=${p.phase} ready=${p.ready} restarts=${p.restarts}${p.reason ? ` reason=${p.reason}` : ''}`);
    if (badClusterPods.length) lines.push(`Cluster unhealthy/restarted pods: ${badClusterPods.join('; ')}`);
  }
  for (const ns of snapshot.namespaces || []) {
    lines.push(`Namespace ${ns.namespace}: pods=${ns.counts?.pods || 0}, workloads=${ns.counts?.workloads || 0}, services=${ns.counts?.services || 0}, unhealthyPods=${ns.counts?.unhealthyPods || 0}`);
    const bad = (ns.unhealthyPods || []).slice(0, 6).map((p) => `${p.name} phase=${p.phase} ready=${p.ready} restarts=${p.restarts}${p.reason ? ` reason=${p.reason}` : ''}`);
    if (bad.length) lines.push(`Unhealthy/restarted pods: ${bad.join('; ')}`);
    const workloads = (ns.workloads || []).slice(0, 8).map((w) => `${w.kind}/${w.name} ready=${w.ready}/${w.desired || w.ready}`);
    if (workloads.length) lines.push(`Workloads: ${workloads.join('; ')}`);
    const events = (ns.recentEvents || []).filter((e) => e.type === 'Warning').slice(0, 4).map((e) => `${e.object} ${e.reason}: ${e.message}`);
    if (events.length) lines.push(`Recent warnings: ${events.join('; ')}`);
  }
  lines.push('Use this live snapshot for operational questions. Do not claim to have executed actions unless an explicit action tool result is present.');
  return { role: 'system', content: lines.join('\n').slice(0, 14000) };
}

function controlToolsSystemMessage() {
  const manifest = oaaToolManifest();
  const bindings = oaaActionBindings();
  return {
    role: 'system',
    content: [
      'OAA Controlled Tools available through OAA Gateway:',
      `Allowed namespaces: ${OAA_ENV_NAMESPACES.join(', ')}`,
      `Tool manifest schema: ${manifest.schema}. Tool IDs: ${manifest.tools.map((t) => t.id).join(', ')}.`,
      `Action binding schema: ${bindings.schema}. Action binding IDs: ${bindings.bindings.map((b) => b.id).join(', ')}.`,
      'Read tools: live environment snapshot is automatically attached; cluster pod summary, pod logs, services, events, describe, and rollout can be read through /api/oaa/tools/k8s/*.',
      'Admin action tools: /api/oaa/actions/k8s/restart-deployment and /api/oaa/actions/k8s/scale-deployment.',
      'Action safety rules: admin token required, target namespace must be allowed, deployment name must be RFC1123-safe, and exact confirmation text is required.',
      'Restart confirmation format: restart deployment <namespace>/<deployment>.',
      `Scale confirmation format: scale deployment <namespace>/<deployment> to <replicas>. Maximum replicas: ${OAA_SCALE_MAX}.`,
      'Do not state that an action was executed unless an explicit action endpoint result is present.',
    ].join('\n'),
  };
}

function bindingInput(fields) {
  return { type: 'object', fields };
}

function oaaActionBindings() {
  const toolIds = new Set(oaaToolManifest().tools.map((t) => t.id));
  const mk = (binding) => ({
    schema: 'manual-action-binding.opensphere.io/v1alpha1',
    valid: toolIds.has(binding.toolId),
    ...binding,
  });
  const bindings = [
    mk({
      id: 'manual-action:opensphere:environment-read',
      namespace: 'opensphere',
      sourceId: 'console-docs/backbone-architecture',
      sectionId: 'manual-section:console-docs/backbone-architecture#oaa-gateway',
      title: 'Inspect live OpenSphere environment before operational answers',
      intent: 'inspect',
      toolId: 'oaa.environment.read',
      controlPlane: 'oaa-gateway',
      riskLevel: 'read',
      confirmation: 'none',
      requiredInputs: bindingInput({ context: 'optional current console route/title/selection' }),
      permission: { roles: ['authenticated'], scopes: ['oaa:tools:read'] },
      audit: { eventType: 'environment-snapshot', targetTemplate: 'opensphere namespaces' },
      citations: [{ sourceId: 'console-docs/backbone-architecture', sourcePath: 'OpenSphere-console/docs/BACKBONE-ARCHITECTURE.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:knowledge-search',
      namespace: 'opensphere',
      sourceId: 'console-docs/oaa-manual-knowledge-data-model',
      sectionId: 'manual-section:console-docs/oaa-manual-knowledge-data-model#retrieval-contract',
      title: 'Search manuals before answering OpenSphere-specific questions',
      intent: 'diagnose',
      toolId: 'oaa.knowledge.search',
      controlPlane: 'oaa-gateway',
      riskLevel: 'read',
      confirmation: 'none',
      requiredInputs: bindingInput({ q: 'question or search query', limit: 'optional result count' }),
      permission: { roles: ['authenticated'], scopes: ['oaa:knowledge:read'] },
      audit: { eventType: 'knowledge-search', targetTemplate: 'opensphere/manuals' },
      citations: [{ sourceId: 'console-docs/oaa-manual-knowledge-data-model', sourcePath: 'OpenSphere-console/docs/OAA-MANUAL-KNOWLEDGE-DATA-MODEL.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:manual-ingest',
      namespace: 'opensphere',
      sourceId: 'console-docs/oaa-manual-knowledge-data-model',
      sectionId: 'manual-section:console-docs/oaa-manual-knowledge-data-model#seed-manifest-format',
      title: 'Ingest OpenSphere manuals into Backbone PostgreSQL pgvector',
      intent: 'ingest-knowledge',
      toolId: 'oaa.knowledge.ingest-manual',
      controlPlane: 'oaa-gateway',
      riskLevel: 'medium',
      confirmation: 'required',
      preflightToolIds: ['oaa.knowledge.search'],
      requiredInputs: bindingInput({ manifest: 'manual-seed.opensphere.io/v1alpha1 manifest' }),
      permission: { roles: [KANIDM_ADMIN_GROUP], scopes: ['oaa:knowledge:write'] },
      audit: { eventType: 'knowledge-manual-seed', targetTemplate: '<manifest.source.id>' },
      citations: [{ sourceId: 'console-docs/oaa-manual-knowledge-data-model', sourcePath: 'OpenSphere-console/docs/OAA-MANUAL-KNOWLEDGE-DATA-MODEL.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:k8s-describe',
      namespace: 'opensphere',
      sourceId: 'console-docs/backbone-architecture',
      sectionId: 'manual-section:console-docs/backbone-architecture#oaa-gateway',
      title: 'Describe pods or deployments when diagnosing OAA and Backbone services',
      intent: 'diagnose',
      toolId: 'oaa.k8s.resource.describe',
      controlPlane: 'kubernetes-api',
      riskLevel: 'read',
      confirmation: 'none',
      requiredInputs: bindingInput({ kind: 'pod | deployment', namespace: OAA_ENV_NAMESPACES.join(' | '), name: 'Kubernetes resource name' }),
      permission: { roles: ['authenticated'], scopes: ['oaa:k8s:read'], namespaceScope: OAA_ENV_NAMESPACES },
      audit: { eventType: 'k8s-describe-resource', targetTemplate: '<namespace>/<kind>/<name>' },
      citations: [{ sourceId: 'console-docs/backbone-architecture', sourcePath: 'OpenSphere-console/docs/BACKBONE-ARCHITECTURE.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:cluster-pod-count',
      namespace: 'opensphere',
      sourceId: 'console-docs/backbone-architecture',
      sectionId: 'manual-section:console-docs/backbone-architecture#oaa-gateway',
      title: 'Count current Kubernetes pods across all namespaces',
      intent: 'inspect',
      toolId: 'oaa.k8s.cluster.pods.summary',
      controlPlane: 'kubernetes-api',
      riskLevel: 'read',
      confirmation: 'none',
      requiredInputs: bindingInput({}),
      permission: { roles: ['authenticated'], scopes: ['oaa:k8s:read'] },
      audit: { eventType: 'k8s-cluster-pod-summary', targetTemplate: 'cluster' },
      citations: [{ sourceId: 'console-docs/backbone-architecture', sourcePath: 'OpenSphere-console/docs/BACKBONE-ARCHITECTURE.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:oaa-gateway-rollout',
      namespace: 'opensphere',
      sourceId: 'console-docs/backbone-architecture',
      sectionId: 'manual-section:console-docs/backbone-architecture#oaa-gateway',
      title: 'Check OAA Gateway rollout status',
      intent: 'diagnose',
      toolId: 'oaa.k8s.deployment.rollout',
      controlPlane: 'kubernetes-api',
      riskLevel: 'read',
      confirmation: 'none',
      targetHints: { namespace: BACKBONE_NS, deployment: 'oaa-gateway' },
      requiredInputs: bindingInput({ namespace: BACKBONE_NS, name: 'oaa-gateway' }),
      permission: { roles: ['authenticated'], scopes: ['oaa:k8s:read'], namespaceScope: [BACKBONE_NS] },
      audit: { eventType: 'k8s-rollout-status', targetTemplate: `${BACKBONE_NS}/oaa-gateway` },
      citations: [{ sourceId: 'console-docs/backbone-architecture', sourcePath: 'OpenSphere-console/docs/BACKBONE-ARCHITECTURE.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:oaa-gateway-restart',
      namespace: 'opensphere',
      sourceId: 'console-docs/backbone-architecture',
      sectionId: 'manual-section:console-docs/backbone-architecture#oaa-gateway',
      title: 'Restart OAA Gateway after configuration or manual seed changes',
      intent: 'restart',
      toolId: 'oaa.k8s.deployment.restart',
      controlPlane: 'kubernetes-api',
      riskLevel: 'medium',
      confirmation: 'required',
      confirmationTemplate: `restart deployment ${BACKBONE_NS}/oaa-gateway`,
      preflightToolIds: ['oaa.k8s.deployment.rollout'],
      targetHints: { namespace: BACKBONE_NS, deployment: 'oaa-gateway' },
      requiredInputs: bindingInput({ namespace: BACKBONE_NS, name: 'oaa-gateway', confirm: `restart deployment ${BACKBONE_NS}/oaa-gateway` }),
      permission: { roles: [KANIDM_ADMIN_GROUP], scopes: ['oaa:k8s:write'], namespaceScope: [BACKBONE_NS] },
      audit: { eventType: 'k8s-restart-deployment', targetTemplate: `${BACKBONE_NS}/oaa-gateway` },
      citations: [{ sourceId: 'console-docs/backbone-architecture', sourcePath: 'OpenSphere-console/docs/BACKBONE-ARCHITECTURE.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:oaa-gateway-scale',
      namespace: 'opensphere',
      sourceId: 'console-docs/backbone-architecture',
      sectionId: 'manual-section:console-docs/backbone-architecture#oaa-gateway',
      title: 'Scale OAA Gateway deployment within configured replica limits',
      intent: 'scale',
      toolId: 'oaa.k8s.deployment.scale',
      controlPlane: 'kubernetes-api',
      riskLevel: 'medium',
      confirmation: 'required',
      confirmationTemplate: `scale deployment ${BACKBONE_NS}/oaa-gateway to <replicas>`,
      preflightToolIds: ['oaa.k8s.deployment.rollout'],
      targetHints: { namespace: BACKBONE_NS, deployment: 'oaa-gateway', maxReplicas: OAA_SCALE_MAX },
      requiredInputs: bindingInput({ namespace: BACKBONE_NS, name: 'oaa-gateway', replicas: `0..${OAA_SCALE_MAX}`, confirm: `scale deployment ${BACKBONE_NS}/oaa-gateway to <replicas>` }),
      permission: { roles: [KANIDM_ADMIN_GROUP], scopes: ['oaa:k8s:write'], namespaceScope: [BACKBONE_NS] },
      audit: { eventType: 'k8s-scale-deployment', targetTemplate: `${BACKBONE_NS}/oaa-gateway` },
      citations: [{ sourceId: 'console-docs/backbone-architecture', sourcePath: 'OpenSphere-console/docs/BACKBONE-ARCHITECTURE.md' }],
    }),
  ];
  return {
    schema: 'oaa-action-bindings.opensphere.io/v1alpha1',
    service: 'oaa-gateway',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    bindings,
    invalidBindings: bindings.filter((b) => !b.valid).map((b) => ({ id: b.id, toolId: b.toolId })),
  };
}

function schemaObject(required = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: required,
    required: Object.entries(required).filter(([, v]) => v?.required !== false).map(([k]) => k),
  };
}

function toolEndpoint(method, path) {
  return { method, path };
}

function oaaToolManifest() {
  const nsEnum = OAA_ENV_NAMESPACES;
  const nsField = { type: 'string', enum: nsEnum, description: 'Allowed OpenSphere namespace' };
  const deploymentField = { type: 'string', pattern: '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' };
  const podField = { type: 'string', pattern: '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' };
  const confirmField = { type: 'string', description: 'Exact confirmation phrase required by the action' };
  return {
    schema: 'oaa-tool-manifest.opensphere.io/v1alpha1',
    service: 'oaa-gateway',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    allowedNamespaces: nsEnum,
    scaleMax: OAA_SCALE_MAX,
    safety: {
      writeActionsRequireAdmin: true,
      allowedNamespaceEnforced: true,
      exactConfirmationRequired: true,
      auditEventRequired: true,
    },
    tools: [
      {
        id: 'oaa.environment.read',
        name: 'Read live OpenSphere environment snapshot',
        channel: 'api',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/environment'),
        riskLevel: 'read',
        confirmation: 'none',
        inputSchema: schemaObject({ context: { type: 'object', required: false } }),
        auditEventType: 'environment-snapshot',
      },
      {
        id: 'oaa.k8s.pods.list',
        name: 'List pods through environment snapshot',
        channel: 'kubernetes',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/environment'),
        riskLevel: 'read',
        confirmation: 'none',
        kubernetes: { verbs: ['get', 'list'], apiGroups: [''], resources: ['pods'], namespaces: nsEnum },
        inputSchema: schemaObject({ namespace: { ...nsField, required: false } }),
        auditEventType: 'environment-snapshot',
      },
      {
        id: 'oaa.k8s.cluster.pods.summary',
        name: 'Read cluster-wide pod count and namespace summary',
        channel: 'kubernetes',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/k8s/pods-summary'),
        riskLevel: 'read',
        confirmation: 'none',
        kubernetes: { verbs: ['get', 'list'], apiGroups: [''], resources: ['pods'], namespaces: ['*'] },
        inputSchema: schemaObject({}),
        auditEventType: 'k8s-cluster-pod-summary',
      },
      {
        id: 'oaa.k8s.services.list',
        name: 'List services',
        channel: 'kubernetes',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/k8s/services'),
        riskLevel: 'read',
        confirmation: 'none',
        kubernetes: { verbs: ['get', 'list'], apiGroups: [''], resources: ['services'], namespaces: nsEnum },
        inputSchema: schemaObject({ namespace: { ...nsField, required: false } }),
        auditEventType: 'k8s-services',
      },
      {
        id: 'oaa.k8s.events.list',
        name: 'List recent Kubernetes events',
        channel: 'kubernetes',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/k8s/events'),
        riskLevel: 'read',
        confirmation: 'none',
        kubernetes: { verbs: ['get', 'list'], apiGroups: [''], resources: ['events'], namespaces: nsEnum },
        inputSchema: schemaObject({ namespace: { ...nsField, required: false } }),
        auditEventType: 'k8s-events',
      },
      {
        id: 'oaa.k8s.logs.tail',
        name: 'Tail pod logs',
        channel: 'kubernetes',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/k8s/pod-logs'),
        riskLevel: 'read',
        confirmation: 'none',
        kubernetes: { verbs: ['get'], apiGroups: [''], resources: ['pods/log'], namespaces: nsEnum },
        inputSchema: schemaObject({
          namespace: nsField,
          pod: podField,
          container: { type: 'string', required: false },
          tailLines: { type: 'integer', minimum: 1, maximum: 300, required: false },
        }),
        auditEventType: 'k8s-pod-logs',
      },
      {
        id: 'oaa.k8s.resource.describe',
        name: 'Describe pod or deployment',
        channel: 'kubernetes',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/k8s/describe'),
        riskLevel: 'read',
        confirmation: 'none',
        kubernetes: { verbs: ['get', 'list'], apiGroups: ['', 'apps'], resources: ['pods', 'deployments', 'events'], namespaces: nsEnum },
        inputSchema: schemaObject({
          kind: { type: 'string', enum: ['pod', 'deployment'] },
          namespace: nsField,
          name: { type: 'string' },
        }),
        auditEventType: 'k8s-describe-resource',
      },
      {
        id: 'oaa.k8s.deployment.rollout',
        name: 'Read deployment rollout status',
        channel: 'kubernetes',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/k8s/rollout'),
        riskLevel: 'read',
        confirmation: 'none',
        kubernetes: { verbs: ['get', 'list'], apiGroups: ['apps', ''], resources: ['deployments', 'pods', 'events'], namespaces: nsEnum },
        inputSchema: schemaObject({ namespace: nsField, name: deploymentField }),
        auditEventType: 'k8s-rollout-status',
      },
      {
        id: 'oaa.k8s.deployment.restart',
        name: 'Restart deployment by patching pod template annotation',
        channel: 'kubernetes',
        readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/k8s/restart-deployment'),
        riskLevel: 'medium',
        confirmation: 'required',
        confirmationTemplate: 'restart deployment <namespace>/<deployment>',
        preflightToolIds: ['oaa.k8s.deployment.rollout'],
        kubernetes: { verbs: ['get', 'patch'], apiGroups: ['apps'], resources: ['deployments'], namespaces: nsEnum },
        inputSchema: schemaObject({
          namespace: nsField,
          name: deploymentField,
          confirm: confirmField,
          reason: { type: 'string', required: false },
        }),
        auditEventType: 'k8s-restart-deployment',
      },
      {
        id: 'oaa.k8s.deployment.scale',
        name: 'Scale deployment replicas',
        channel: 'kubernetes',
        readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/k8s/scale-deployment'),
        riskLevel: 'medium',
        confirmation: 'required',
        confirmationTemplate: 'scale deployment <namespace>/<deployment> to <replicas>',
        preflightToolIds: ['oaa.k8s.deployment.rollout'],
        kubernetes: { verbs: ['get', 'patch'], apiGroups: ['apps'], resources: ['deployments'], namespaces: nsEnum },
        inputSchema: schemaObject({
          namespace: nsField,
          name: deploymentField,
          replicas: { type: 'integer', minimum: 0, maximum: OAA_SCALE_MAX },
          confirm: confirmField,
          reason: { type: 'string', required: false },
        }),
        auditEventType: 'k8s-scale-deployment',
      },
      {
        id: 'oaa.knowledge.search',
        name: 'Search OpenSphere manual and project knowledge',
        channel: 'api',
        readOnly: true,
        endpoint: toolEndpoint('GET', '/api/oaa/knowledge/search'),
        riskLevel: 'read',
        confirmation: 'none',
        inputSchema: schemaObject({
          q: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 20, required: false },
        }),
        auditEventType: 'knowledge-search',
      },
      {
        id: 'oaa.knowledge.ingest-manual',
        name: 'Ingest bundled or submitted OpenSphere manual knowledge',
        channel: 'api',
        readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/admin/knowledge/manual-seed'),
        riskLevel: 'medium',
        confirmation: 'required',
        inputSchema: schemaObject({ manifest: { type: 'object' } }),
        auditEventType: 'knowledge-manual-seed',
      },
    ],
  };
}

function summarizeToolManifest() {
  const manifest = oaaToolManifest();
  const lines = [
    `OAA tool manifest: ${manifest.schema}`,
    `Allowed namespaces: ${manifest.allowedNamespaces.join(', ')}`,
    `Scale max: ${manifest.scaleMax}`,
    'Tools:',
  ];
  for (const tool of manifest.tools) {
    lines.push(`- ${tool.id}: ${tool.readOnly ? 'read' : 'write'} ${tool.endpoint?.method || '-'} ${tool.endpoint?.path || '-'} confirmation=${tool.confirmation}`);
  }
  return lines.join('\n');
}

function summarizeActionBindings() {
  const manifest = oaaActionBindings();
  const lines = [
    `OAA action bindings: ${manifest.schema}`,
    `Bindings: ${manifest.bindings.length}, invalid: ${manifest.invalidBindings.length}`,
  ];
  for (const b of manifest.bindings) {
    lines.push(`- ${b.id}: ${b.intent} -> ${b.toolId} risk=${b.riskLevel} confirmation=${b.confirmation} source=${b.sourceId}${b.valid ? '' : ' INVALID_TOOL'}`);
  }
  return lines.join('\n');
}

async function seedToolRegistry(actor = null) {
  if (!OAA_RAG_ENABLED) return { seeded: false, reason: 'rag disabled' };
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) return { seeded: false, reason: 'postgres not configured' };
  const toolManifest = oaaToolManifest();
  const bindingManifest = oaaActionBindings();
  for (const tool of toolManifest.tools) {
    await pool.query(`
      INSERT INTO oaa_tool_capabilities (id, name, version, channel, read_only, spec)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        version = EXCLUDED.version,
        channel = EXCLUDED.channel,
        read_only = EXCLUDED.read_only,
        spec = EXCLUDED.spec,
        updated_at = now()
    `, [tool.id, tool.name, VERSION, tool.channel || 'api', tool.readOnly === true, JSON.stringify(tool)]);
  }
  for (const binding of bindingManifest.bindings) {
    await pool.query(`
      INSERT INTO oaa_manual_action_bindings (id, source_id, section_id, tool_id, intent, risk_level, confirmation, spec)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        source_id = EXCLUDED.source_id,
        section_id = EXCLUDED.section_id,
        tool_id = EXCLUDED.tool_id,
        intent = EXCLUDED.intent,
        risk_level = EXCLUDED.risk_level,
        confirmation = EXCLUDED.confirmation,
        spec = EXCLUDED.spec,
        updated_at = now()
    `, [
      binding.id,
      binding.sourceId,
      binding.sectionId || null,
      binding.toolId,
      binding.intent,
      binding.riskLevel,
      binding.confirmation,
      JSON.stringify(binding),
    ]);
  }
  audit(actor, 'tool-registry-seed', 'oaa-tool-capabilities', 'ok', `${toolManifest.tools.length} tools / ${bindingManifest.bindings.length} bindings`);
  return {
    seeded: true,
    tools: toolManifest.tools.length,
    bindings: bindingManifest.bindings.length,
  };
}

async function toolManifestFromStore() {
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) return oaaToolManifest();
  const rows = await pool.query(`
    SELECT id, name, version, channel, read_only, spec
    FROM oaa_tool_capabilities
    ORDER BY read_only DESC, id
  `);
  if (!rows.rows.length) return oaaToolManifest();
  const base = oaaToolManifest();
  return {
    ...base,
    generatedAt: new Date().toISOString(),
    storage: 'postgres',
    tools: rows.rows.map((r) => ({
      ...(r.spec || {}),
      id: r.id,
      name: r.name,
      version: r.version,
      channel: r.channel,
      readOnly: r.read_only === true,
    })),
  };
}

async function actionBindingsFromStore() {
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) return oaaActionBindings();
  const rows = await pool.query(`
    SELECT b.id, b.source_id, b.section_id, b.tool_id, b.intent, b.risk_level, b.confirmation, b.spec,
           t.id IS NOT NULL AS valid
    FROM oaa_manual_action_bindings b
    LEFT JOIN oaa_tool_capabilities t ON t.id = b.tool_id
    ORDER BY b.risk_level, b.intent, b.id
  `);
  if (!rows.rows.length) return oaaActionBindings();
  const bindings = rows.rows.map((r) => ({
    ...(r.spec || {}),
    id: r.id,
    sourceId: r.source_id,
    sectionId: r.section_id || undefined,
    toolId: r.tool_id,
    intent: r.intent,
    riskLevel: r.risk_level,
    confirmation: r.confirmation,
    valid: r.valid === true,
  }));
  return {
    schema: 'oaa-action-bindings.opensphere.io/v1alpha1',
    service: 'oaa-gateway',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    storage: 'postgres',
    bindings,
    invalidBindings: bindings.filter((b) => !b.valid).map((b) => ({ id: b.id, toolId: b.toolId })),
  };
}

async function summarizeStoredToolManifest() {
  const manifest = await toolManifestFromStore();
  const lines = [
    `OAA tool manifest: ${manifest.schema}${manifest.storage ? ` (${manifest.storage})` : ''}`,
    `Allowed namespaces: ${manifest.allowedNamespaces.join(', ')}`,
    `Scale max: ${manifest.scaleMax}`,
    'Tools:',
  ];
  for (const tool of manifest.tools) {
    lines.push(`- ${tool.id}: ${tool.readOnly ? 'read' : 'write'} ${tool.endpoint?.method || '-'} ${tool.endpoint?.path || '-'} confirmation=${tool.confirmation}`);
  }
  return lines.join('\n');
}

async function summarizeStoredActionBindings() {
  const manifest = await actionBindingsFromStore();
  const lines = [
    `OAA action bindings: ${manifest.schema}${manifest.storage ? ` (${manifest.storage})` : ''}`,
    `Bindings: ${manifest.bindings.length}, invalid: ${manifest.invalidBindings.length}`,
  ];
  for (const b of manifest.bindings) {
    lines.push(`- ${b.id}: ${b.intent} -> ${b.toolId} risk=${b.riskLevel} confirmation=${b.confirmation} source=${b.sourceId}${b.valid ? '' : ' INVALID_TOOL'}`);
  }
  return lines.join('\n');
}

function actionCommandForBinding(binding, query = '') {
  const inputs = {};
  if (binding.toolId === 'oaa.knowledge.search') inputs.q = query || 'OpenSphere';
  if (binding.toolId === 'oaa.k8s.resource.describe') {
    inputs.kind = 'deployment';
    inputs.namespace = binding.targetHints?.namespace || BACKBONE_NS;
    inputs.name = binding.targetHints?.deployment || 'oaa-gateway';
  }
  if (binding.toolId === 'oaa.k8s.deployment.rollout' || binding.toolId === 'oaa.k8s.deployment.restart' || binding.toolId === 'oaa.k8s.deployment.scale') {
    inputs.namespace = binding.targetHints?.namespace || BACKBONE_NS;
    inputs.name = binding.targetHints?.deployment || 'oaa-gateway';
  }
  if (binding.toolId === 'oaa.k8s.deployment.scale') inputs.replicas = 1;
  const jsonText = Object.keys(inputs).length ? ` ${JSON.stringify(inputs)}` : '';
  const expected = bindingConfirmationExpected(binding, inputs);
  return `/action ${binding.id}${jsonText}${expected ? ` confirm ${expected}` : ''}`;
}

async function suggestActionBindings({ query = '', sources = [], conceptGraph = null } = {}) {
  const manifest = await actionBindingsFromStore();
  const sourceIds = new Set((sources || []).map((s) => s.sourceId).filter(Boolean));
  for (const c of conceptGraph?.concepts || []) {
    for (const id of c.sourceIds || []) sourceIds.add(id);
  }
  const terms = String(query || '').toLowerCase().split(/[^a-z0-9가-힣_-]+/).filter((x) => x.length >= 3);
  const scored = [];
  for (const b of manifest.bindings || []) {
    if (b.valid === false) continue;
    let score = 0;
    if (sourceIds.has(b.sourceId)) score += 10;
    const hay = [b.id, b.title, b.intent, b.toolId, b.sourceId, b.sectionId, b.controlPlane].filter(Boolean).join(' ').toLowerCase();
    for (const term of terms) if (hay.includes(term)) score += 2;
    if (b.riskLevel === 'read') score += 2;
    if (b.confirmation === 'none') score += 1;
    if (score <= 1) continue;
    scored.push({ binding: b, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.binding.id).localeCompare(String(b.binding.id)));
  return scored.slice(0, 4).map(({ binding, score }) => ({
    id: binding.id,
    title: binding.title,
    intent: binding.intent,
    toolId: binding.toolId,
    sourceId: binding.sourceId,
    riskLevel: binding.riskLevel,
    confirmation: binding.confirmation,
    confirmationTemplate: binding.confirmationTemplate || '',
    command: actionCommandForBinding(binding, query),
    score,
  }));
}

async function getActionBinding(id) {
  const wanted = String(id || '').trim();
  if (!wanted) throw { code: 400, msg: 'bindingId required' };
  const manifest = await actionBindingsFromStore();
  const binding = (manifest.bindings || []).find((b) => b.id === wanted);
  if (!binding) throw { code: 404, msg: 'action binding not found' };
  if (binding.valid === false) throw { code: 409, msg: `action binding references missing tool: ${binding.toolId}` };
  return binding;
}

function bindingConfirmationExpected(binding, inputs = {}) {
  if (!binding || binding.confirmation === 'none') return '';
  let expected = binding.confirmationTemplate || `execute binding ${binding.id}`;
  expected = expected
    .replace(/<namespace>/g, String(inputs.namespace || binding.targetHints?.namespace || ''))
    .replace(/<deployment>/g, String(inputs.deployment || inputs.name || binding.targetHints?.deployment || ''))
    .replace(/<replicas>/g, String(inputs.replicas ?? ''));
  return expected.trim();
}

function requireBindingConfirmation(binding, inputs = {}, fallbackConfirm = '') {
  const expected = bindingConfirmationExpected(binding, inputs);
  if (!expected) return '';
  requireConfirm(inputs.confirm || fallbackConfirm, expected);
  return expected;
}

function bindingSummary(binding, result) {
  const citation = (binding.citations || [])[0];
  const lines = [
    `Action binding executed: ${binding.id}`,
    `intent=${binding.intent} tool=${binding.toolId} risk=${binding.riskLevel} source=${binding.sourceId}`,
  ];
  if (citation?.sourcePath) lines.push(`manual=${citation.sourcePath}`);
  if (result?.message) lines.push('', result.message);
  else if (result?.action === 'cluster-pod-summary') lines.push('', summarizeClusterPods(result.cluster || result));
  else if (result?.action) lines.push('', summarizeDescribe(result));
  else lines.push('', JSON.stringify(result, null, 2).slice(0, 5000));
  return lines.join('\n');
}

async function executeActionBinding(body = {}, actor = null) {
  const started = Date.now();
  const binding = await getActionBinding(body.bindingId || body.id);
  const inputs = { ...(body.inputs && typeof body.inputs === 'object' ? body.inputs : {}) };
  if (body.confirm && !inputs.confirm) inputs.confirm = body.confirm;
  if (body.reason && !inputs.reason) inputs.reason = body.reason;
  const expected = requireBindingConfirmation(binding, inputs, body.confirm || '');
  let result;
  if (binding.riskLevel !== 'read') assertActorAdmin(actor);

  switch (binding.toolId) {
    case 'oaa.environment.read':
      result = await environmentSnapshot(inputs, actor);
      break;
    case 'oaa.k8s.cluster.pods.summary': {
      const cluster = await clusterPodSummary();
      audit(actor, 'k8s-cluster-pod-summary', 'cluster', 'ok', `${cluster.totalPods || 0} pods`);
      result = { action: 'cluster-pod-summary', message: summarizeClusterPods(cluster), cluster };
      break;
    }
    case 'oaa.knowledge.search': {
      const q = String(inputs.q || inputs.query || '').trim();
      if (!q) throw { code: 400, msg: 'q is required for knowledge search binding' };
      result = { action: 'knowledge-search', q, items: await searchKnowledge(q, Number(inputs.limit || OAA_RAG_TOP_K)) };
      audit(actor, 'binding-knowledge-search', binding.id, 'ok', q);
      break;
    }
    case 'oaa.knowledge.ingest-manual':
      result = await upsertManualSeedManifest(inputs.manifest || inputs, actor);
      break;
    case 'oaa.k8s.resource.describe': {
      const kind = String(inputs.kind || '').toLowerCase();
      if (kind === 'pod' || kind === 'pods') result = await describePod(inputs, actor);
      else if (kind === 'deployment' || kind === 'deploy' || kind === 'deployments') result = await describeDeployment(inputs, actor);
      else throw { code: 400, msg: 'kind must be pod or deployment' };
      break;
    }
    case 'oaa.k8s.deployment.rollout':
      result = await rolloutStatus({
        namespace: inputs.namespace || binding.targetHints?.namespace,
        name: inputs.name || inputs.deployment || binding.targetHints?.deployment,
      }, actor);
      break;
    case 'oaa.k8s.deployment.restart':
      result = await restartDeployment({
        namespace: inputs.namespace || binding.targetHints?.namespace,
        name: inputs.name || inputs.deployment || binding.targetHints?.deployment,
        confirm: inputs.confirm,
        reason: inputs.reason || `binding ${binding.id}`,
      }, actor);
      break;
    case 'oaa.k8s.deployment.scale':
      result = await scaleDeployment({
        namespace: inputs.namespace || binding.targetHints?.namespace,
        name: inputs.name || inputs.deployment || binding.targetHints?.deployment,
        replicas: inputs.replicas,
        confirm: inputs.confirm,
        reason: inputs.reason || `binding ${binding.id}`,
      }, actor);
      break;
    default:
      throw { code: 501, msg: `binding tool not executable yet: ${binding.toolId}` };
  }

  audit(actor, 'binding-execute', binding.id, 'ok', `${binding.toolId}${expected ? ` / ${expected}` : ''}`);
  return {
    action: 'binding-execute',
    binding,
    confirmationExpected: expected || null,
    result,
    message: bindingSummary(binding, result),
    latencyMs: Date.now() - started,
  };
}

function commandHelp() {
  return [
    'OAA commands:',
    '/env',
    '/pod-count',
    '/pods [namespace]',
    '/services [namespace]',
    '/events [namespace]',
    '/deployments [namespace]',
    '/describe pod <namespace> <pod>',
    '/describe deployment <namespace> <deployment>',
    '/rollout <namespace> <deployment>',
    '/logs <namespace> <pod> [tailLines]',
    '/restart <namespace> <deployment> confirm restart deployment <namespace>/<deployment>',
    `/scale <namespace> <deployment> <replicas> confirm scale deployment <namespace>/<deployment> to <replicas>`,
    '/action <binding-id> [json-input] confirm <required confirmation>',
    '/tools',
    '/bindings',
    `Allowed namespaces: ${OAA_ENV_NAMESPACES.join(', ')}`,
  ].join('\n');
}

function commandResponse(started, message, result = null) {
  return {
    keyId: 'oaa-tools',
    provider: 'opensphere',
    model: 'oaa-control-tools',
    message,
    usage: null,
    latencyMs: Date.now() - started,
    sources: [],
    environment: null,
    toolResult: result,
  };
}

function confirmTail(text) {
  const marker = ' confirm ';
  const idx = String(text || '').indexOf(marker);
  return idx >= 0 ? String(text).slice(idx + marker.length).trim() : '';
}

function assertActorAdmin(actor) {
  if (!actor?.groups?.includes(KANIDM_ADMIN_GROUP)) throw { code: 403, msg: `not in ${KANIDM_ADMIN_GROUP}` };
}

function summarizeEnvironment(snapshot) {
  const lines = ['Live environment snapshot:'];
  if (snapshot.cluster) lines.push(summarizeClusterPods(snapshot.cluster));
  for (const ns of snapshot.namespaces || []) {
    lines.push(`- ${ns.namespace}: pods ${ns.counts?.pods || 0}, workloads ${ns.counts?.workloads || 0}, services ${ns.counts?.services || 0}, unhealthy ${ns.counts?.unhealthyPods || 0}`);
    const warnings = (ns.recentEvents || []).filter((e) => e.type === 'Warning').slice(0, 2);
    for (const w of warnings) lines.push(`  warning ${w.object} ${w.reason}: ${w.message}`);
  }
  return lines.join('\n');
}

function summarizeClusterPods(summary) {
  const phases = summary.phaseCounts || {};
  const lines = [
    `Cluster pod summary: total ${summary.totalPods || 0}`,
    `Phases: Running=${phases.Running || 0}, Pending=${phases.Pending || 0}, Failed=${phases.Failed || 0}, Succeeded=${phases.Succeeded || 0}, Unknown=${phases.Unknown || 0}`,
    'Namespace counts:',
  ];
  for (const ns of summary.namespaces || []) {
    lines.push(`- ${ns.namespace}: pods=${ns.pods}, running=${ns.running}, pending=${ns.pending}, failed=${ns.failed}, succeeded=${ns.succeeded}, unknown=${ns.unknown}`);
  }
  if (summary.unhealthyPods?.length) {
    lines.push('Unhealthy/restarted pods:');
    for (const p of summary.unhealthyPods.slice(0, 12)) {
      lines.push(`- ${p.namespace}/${p.name}: phase=${p.phase} ready=${p.ready} restarts=${p.restarts}${p.reason ? ` reason=${p.reason}` : ''}`);
    }
  }
  return lines.join('\n');
}

async function selectedSnapshots(ns) {
  if (ns) return [await namespaceSnapshot(requireAllowedNamespace(ns))];
  return Promise.all(OAA_ENV_NAMESPACES.map((x) => namespaceSnapshot(x).catch((e) => ({
    namespace: x,
    access: { error: e.message || String(e) },
    counts: { pods: 0, services: 0, events: 0, workloads: 0, unhealthyPods: 0 },
    workloads: [],
    pods: [],
    services: [],
    unhealthyPods: [],
    recentEvents: [],
  }))));
}

function summarizePods(namespaces) {
  const lines = ['Pods:'];
  for (const ns of namespaces) {
    lines.push(`- namespace ${ns.namespace} (${ns.pods.length}/${ns.counts?.pods || 0} shown)`);
    for (const p of ns.pods) {
      lines.push(`  ${p.name} phase=${p.phase} ready=${p.ready} restarts=${p.restarts}${p.reason ? ` reason=${p.reason}` : ''}`);
    }
    if (!ns.pods.length) lines.push('  (none)');
  }
  return lines.join('\n');
}

function summarizeDeployments(namespaces) {
  const lines = ['Deployments and workloads:'];
  for (const ns of namespaces) {
    const items = (ns.workloads || []).filter((w) => w.kind === 'Deployment');
    lines.push(`- namespace ${ns.namespace} (${items.length} deployments)`);
    for (const w of items) {
      lines.push(`  ${w.name} ready=${w.ready}/${w.desired || w.ready} available=${w.available} updated=${w.updated}`);
    }
    if (!items.length) lines.push('  (none)');
  }
  return lines.join('\n');
}

function summarizeServices(namespaces) {
  const lines = ['Services:'];
  for (const ns of namespaces) {
    const items = ns.services || [];
    lines.push(`- namespace ${ns.namespace} (${items.length}/${ns.counts?.services || 0} shown)`);
    for (const s of items) {
      const selector = s.selector && Object.keys(s.selector).length
        ? Object.entries(s.selector).map(([k, v]) => `${k}=${v}`).join(',')
        : '-';
      lines.push(`  ${s.name} type=${s.type || '-'} clusterIP=${s.clusterIP || '-'} ports=${s.ports || '-'} selector=${selector}`);
    }
    if (!items.length) lines.push('  (none)');
  }
  return lines.join('\n');
}

function summarizeEvents(namespaces) {
  const lines = ['Recent events:'];
  for (const ns of namespaces) {
    const items = ns.recentEvents || [];
    lines.push(`- namespace ${ns.namespace} (${items.length}/${ns.counts?.events || 0} shown)`);
    for (const e of items) {
      lines.push(`  ${e.time || '-'} ${e.type || '-'} ${e.reason || '-'} ${e.object || '-'}: ${e.message || '-'}`);
    }
    if (!items.length) lines.push('  (none)');
  }
  return lines.join('\n');
}

function summarizeDescribe(out) {
  if (out.action === 'describe-pod') {
    const lines = [
      `Pod ${out.namespace}/${out.name}`,
      `phase=${out.phase} ready=${out.ready} restarts=${out.restarts} node=${out.node || '-'}`,
    ];
    for (const c of out.containers || []) lines.push(`container ${c.name}: ready=${c.ready} restarts=${c.restartCount} state=${c.state || '-'} image=${c.image}`);
    for (const e of (out.events || []).slice(0, 5)) lines.push(`event ${e.type} ${e.reason}: ${e.message}`);
    return lines.join('\n');
  }
  if (out.action === 'describe-deployment') {
    const lines = [
      `Deployment ${out.namespace}/${out.name}`,
      `replicas=${out.replicas} ready=${out.readyReplicas} available=${out.availableReplicas} updated=${out.updatedReplicas} generation=${out.generation}/${out.observedGeneration || '-'}`,
    ];
    for (const c of out.conditions || []) lines.push(`condition ${c.type}: ${c.status}${c.reason ? ` ${c.reason}` : ''}${c.message ? ` - ${c.message}` : ''}`);
    for (const p of out.pods || []) lines.push(`pod ${p.name}: phase=${p.phase} ready=${p.ready} restarts=${p.restarts}${p.reason ? ` reason=${p.reason}` : ''}`);
    for (const e of (out.events || []).slice(0, 5)) lines.push(`event ${e.type} ${e.reason}: ${e.message}`);
    return lines.join('\n');
  }
  if (out.action === 'rollout-status') {
    const lines = [
      `Rollout ${out.namespace}/${out.name}: ${out.status}`,
      `desired=${out.desired} ready=${out.readyReplicas} available=${out.availableReplicas} updated=${out.updatedReplicas} generation=${out.generation}/${out.observedGeneration || '-'}`,
    ];
    if (out.progressing) lines.push(`progressing=${out.progressing.status}${out.progressing.reason ? ` ${out.progressing.reason}` : ''}${out.progressing.message ? ` - ${out.progressing.message}` : ''}`);
    if (out.availableCondition) lines.push(`available=${out.availableCondition.status}${out.availableCondition.reason ? ` ${out.availableCondition.reason}` : ''}${out.availableCondition.message ? ` - ${out.availableCondition.message}` : ''}`);
    for (const p of (out.pods || []).slice(0, 8)) lines.push(`pod ${p.name}: phase=${p.phase} ready=${p.ready} restarts=${p.restarts}${p.reason ? ` reason=${p.reason}` : ''}`);
    return lines.join('\n');
  }
  return JSON.stringify(out, null, 2);
}

async function handleSlashCommand(text, body, actor) {
  const started = Date.now();
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  if (cmd === '/help') return commandResponse(started, commandHelp());
  if (cmd === '/tools') return commandResponse(started, await summarizeStoredToolManifest(), await toolManifestFromStore());
  if (cmd === '/bindings') return commandResponse(started, await summarizeStoredActionBindings(), await actionBindingsFromStore());
  if (cmd === '/action') {
    const bindingId = parts[1] || '';
    const confirm = confirmTail(raw);
    const beforeConfirm = raw.includes(' confirm ') ? raw.slice(0, raw.indexOf(' confirm ')) : raw;
    const jsonText = beforeConfirm.slice(('/action ' + bindingId).length).trim();
    let inputs = {};
    if (jsonText) {
      try { inputs = JSON.parse(jsonText); }
      catch { return commandResponse(started, 'Usage: /action <binding-id> {"field":"value"} confirm <required confirmation>'); }
    }
    const out = await executeActionBinding({ bindingId, inputs, confirm, reason: 'OAA chat binding command' }, actor);
    return commandResponse(started, out.message, out);
  }
  if (cmd === '/env') {
    const out = await environmentSnapshot(body, actor);
    return commandResponse(started, summarizeEnvironment(out), out);
  }
  if (cmd === '/pod-count' || cmd === '/podcount') {
    const out = await clusterPodSummary();
    audit(actor, 'k8s-cluster-pod-summary', 'cluster', 'ok', `${out.totalPods || 0} pods`);
    return commandResponse(started, summarizeClusterPods(out), { action: 'cluster-pod-summary', cluster: out });
  }
  if (cmd === '/pods') {
    const out = await selectedSnapshots(parts[1] || '');
    return commandResponse(started, summarizePods(out), { action: 'pods', namespaces: out });
  }
  if (cmd === '/services' || cmd === '/svc') {
    const out = await selectedSnapshots(parts[1] || '');
    return commandResponse(started, summarizeServices(out), { action: 'services', namespaces: out });
  }
  if (cmd === '/events') {
    const out = await selectedSnapshots(parts[1] || '');
    return commandResponse(started, summarizeEvents(out), { action: 'events', namespaces: out });
  }
  if (cmd === '/deployments' || cmd === '/deploys') {
    const out = await selectedSnapshots(parts[1] || '');
    return commandResponse(started, summarizeDeployments(out), { action: 'deployments', namespaces: out });
  }
  if (cmd === '/logs') {
    const out = await podLogs({ namespace: parts[1], pod: parts[2], tailLines: parts[3] || 120 }, actor);
    const textOut = out.text ? out.text.slice(-5000) : '(empty logs)';
    return commandResponse(started, `Logs ${out.namespace}/${out.pod} tail=${out.tailLines}\n\n${textOut}`, out);
  }
  if (cmd === '/describe') {
    const kind = String(parts[1] || '').toLowerCase();
    if (kind === 'pod' || kind === 'pods') {
      const out = await describePod({ namespace: parts[2], name: parts[3] }, actor);
      return commandResponse(started, summarizeDescribe(out), out);
    }
    if (kind === 'deployment' || kind === 'deploy' || kind === 'deployments') {
      const out = await describeDeployment({ namespace: parts[2], name: parts[3] }, actor);
      return commandResponse(started, summarizeDescribe(out), out);
    }
    return commandResponse(started, 'Usage: /describe pod <namespace> <pod> OR /describe deployment <namespace> <deployment>');
  }
  if (cmd === '/rollout') {
    const out = await rolloutStatus({ namespace: parts[1], name: parts[2] }, actor);
    return commandResponse(started, summarizeDescribe(out), out);
  }
  if (cmd === '/restart') {
    assertActorAdmin(actor);
    const out = await restartDeployment({ namespace: parts[1], name: parts[2], confirm: confirmTail(raw), reason: 'OAA chat command' }, actor);
    return commandResponse(started, `Restart requested for Deployment ${out.namespace}/${out.name}. generation ${out.previousGeneration || '-'} -> ${out.generation || '-'}.`, out);
  }
  if (cmd === '/scale') {
    assertActorAdmin(actor);
    const out = await scaleDeployment({ namespace: parts[1], name: parts[2], replicas: parts[3], confirm: confirmTail(raw), reason: 'OAA chat command' }, actor);
    return commandResponse(started, `Scale requested for Deployment ${out.namespace}/${out.name}. replicas ${out.previousReplicas ?? '-'} -> ${out.replicas}.`, out);
  }
  return commandResponse(started, `Unknown OAA command: ${cmd}\n\n${commandHelp()}`);
}

function latestUserContent(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return messages[messages.length - 1]?.content || '';
}

function knowledgeSystemMessage(rows) {
  const context = rows.map((r, i) => [
    `[${i + 1}] ${r.title} (${r.sourceType}/${r.sourceId}#${r.chunkIndex}, score=${r.score.toFixed(3)}${r.authorityTier != null ? `, authorityTier=${r.authorityTier}` : ''})`,
    r.sourcePath ? `Source path: ${r.sourcePath}` : '',
    r.sectionHeading ? `Section: ${r.sectionHeading}` : '',
    r.content,
  ].filter(Boolean).join('\n')).join('\n\n');
  return {
    role: 'system',
    content: [
      'You are OAA, the OpenSphere AI Agent inside OpenSphere Console.',
      'Use the OpenSphere Knowledge Context below when it is relevant. If the context is insufficient, say what is missing instead of inventing internal OpenSphere facts.',
      'Answer in the user language. Keep operational advice concrete.',
      'OpenSphere Knowledge Context:',
      context,
    ].join('\n\n').slice(0, 12000),
  };
}

function conceptGraphSystemMessage(graph) {
  const concepts = (graph?.concepts || []).slice(0, 12);
  if (!concepts.length) return null;
  const relations = (graph?.relations || []).slice(0, 24);
  const conceptText = concepts.map((c, i) => [
    `[C${i + 1}] ${c.name} (${c.type}/${c.id}, authorityTier=${c.authorityTier})`,
    c.aliases?.length ? `Aliases: ${c.aliases.join(', ')}` : '',
    c.summary ? `Summary: ${c.summary}` : '',
    c.sourceIds?.length ? `Sources: ${c.sourceIds.join(', ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  const relationText = relations.map((r) => `${r.fromId} --${r.relation}--> ${r.toId} (source=${r.sourceId}, tier=${r.authorityTier})`).join('\n');
  return {
    role: 'system',
    content: [
      'OpenSphere Concept Graph Context:',
      'Use these canonical OpenSphere concepts and relations when explaining internal OpenSphere models such as perspectives, planes, services, tools, menus, and control boundaries.',
      'If a concept graph item conflicts with lower authority-tier manual text, prefer the lower authority-tier manual. Do not invent missing concepts.',
      'Concepts:',
      conceptText,
      relationText ? 'Relations:' : '',
      relationText,
    ].filter(Boolean).join('\n\n').slice(0, 10000),
  };
}

function actionSuggestionsSystemMessage(actions) {
  const items = (actions || []).slice(0, 4);
  if (!items.length) return null;
  return {
    role: 'system',
    content: [
      'OAA Suggested Action Bindings:',
      'These are available manual-backed actions related to the user request. You may mention them as options, but do not claim they were executed. Non-read actions require the exact confirmation command.',
      ...items.map((a, i) => [
        `[A${i + 1}] ${a.title}`,
        `binding=${a.id}`,
        `intent=${a.intent} tool=${a.toolId} risk=${a.riskLevel} confirmation=${a.confirmation}`,
        `command=${a.command}`,
      ].join('\n')),
    ].join('\n\n').slice(0, 7000),
  };
}

async function chatCompletion(body, actor) {
  const baseMessages = normalizeMessages(body);
  const commandOut = await handleSlashCommand(latestUserContent(baseMessages), body, actor);
  if (commandOut) return commandOut;
  const key = await loadEnabledKey(String(body.keyId || '').trim());
  let sources = [];
  let conceptGraph = null;
  let suggestedActions = [];
  let messages = baseMessages;
  let environment = null;
  const systemMessages = [controlToolsSystemMessage()];
  const userContent = latestUserContent(baseMessages);
  try {
    sources = await searchKnowledge(userContent);
    if (sources.length) systemMessages.push(knowledgeSystemMessage(sources));
  } catch (e) {
    console.warn('[oaa-rag] search skipped:', e.message || e);
  }
  try {
    conceptGraph = await listManualConceptGraph(userContent, 24);
    const msg = conceptGraphSystemMessage(conceptGraph);
    if (msg) systemMessages.push(msg);
  } catch (e) {
    console.warn('[oaa-concepts] graph skipped:', e.message || e);
  }
  try {
    suggestedActions = await suggestActionBindings({ query: userContent, sources, conceptGraph });
    const msg = actionSuggestionsSystemMessage(suggestedActions);
    if (msg) systemMessages.push(msg);
  } catch (e) {
    console.warn('[oaa-actions] suggestions skipped:', e.message || e);
  }
  try {
    if (body.includeEnvironment !== false) {
      environment = await environmentSnapshot(body, actor);
      systemMessages.push(environmentSystemMessage(environment));
    }
  } catch (e) {
    console.warn('[oaa-env] snapshot skipped:', e.message || e);
  }
  if (systemMessages.length) messages = [...systemMessages, ...baseMessages];
  const baseUrl = (key.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = String(body.model || key.defaultModel || 'deepseek-v4-flash').trim();
  if (!MODEL_RE.test(model)) throw { code: 400, msg: 'invalid model' };
  const reqBody = {
    model,
    messages,
    stream: false,
    max_tokens: Math.max(32, Math.min(4096, Number(body.maxTokens || 1024) || 1024)),
  };
  if (key.provider === 'deepseek') reqBody.thinking = { type: 'disabled' };

  const started = Date.now();
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(reqBody),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || `provider HTTP ${resp.status}`;
    throw { code: 502, msg };
  }
  const content = data?.choices?.[0]?.message?.content || '';
  audit(actor, 'chat-completion', key.id, 'ok', `${key.provider}/${model}`);
  return {
    keyId: key.id,
    provider: key.provider,
    model: data?.model || model,
    message: content,
    usage: data?.usage || null,
    latencyMs: Date.now() - started,
    sources: sources.map((s) => ({
      title: s.title,
      sourceType: s.sourceType,
      sourceId: s.sourceId,
      chunkIndex: s.chunkIndex,
      score: s.score,
      authorityTier: s.authorityTier,
      documentType: s.documentType,
      sectionHeading: s.sectionHeading,
      route: s.route,
      sourcePath: s.sourcePath,
      sourceUrl: s.sourceUrl,
      sourceName: s.sourceName,
    })),
    concepts: conceptGraph ? {
      schema: conceptGraph.schema,
      query: conceptGraph.query,
      concepts: (conceptGraph.concepts || []).slice(0, 12).map((c) => ({
        id: c.id,
        type: c.type,
        name: c.name,
        summary: c.summary,
        authorityTier: c.authorityTier,
        sourceIds: c.sourceIds || [],
      })),
      relations: (conceptGraph.relations || []).slice(0, 24).map((r) => ({
        id: r.id,
        fromId: r.fromId,
        relation: r.relation,
        toId: r.toId,
        authorityTier: r.authorityTier,
        sourceId: r.sourceId,
      })),
    } : null,
    suggestedActions,
    environment: environment ? {
      time: environment.time,
      namespaces: environment.namespaces.map((ns) => ({
        namespace: ns.namespace,
        counts: ns.counts,
        access: ns.access,
      })),
    } : null,
  };
}

function validateKeyBody(body, rotate = false) {
  const id = String(body.id || '').trim();
  const provider = String(body.provider || '').trim();
  const displayName = String(body.displayName || id || provider).trim();
  const apiKey = String(body.apiKey || '');
  const baseUrl = String(body.baseUrl || '').trim();
  const defaultModel = String(body.defaultModel || '').trim();
  const embeddingModel = String(body.embeddingModel || '').trim();
  const reason = String(body.reason || '').trim();
  if (!ID_RE.test(id)) throw { code: 400, msg: 'invalid id' };
  if (!PROVIDER_RE.test(provider)) throw { code: 400, msg: 'invalid provider' };
  if (!rotate && apiKey.length < 8) throw { code: 400, msg: 'apiKey required' };
  if (defaultModel && !MODEL_RE.test(defaultModel)) throw { code: 400, msg: 'invalid defaultModel' };
  if (embeddingModel && !MODEL_RE.test(embeddingModel)) throw { code: 400, msg: 'invalid embeddingModel' };
  if (!reason) throw { code: 400, msg: 'reason required' };
  return { id, provider, displayName, apiKey, baseUrl, defaultModel, embeddingModel, enabled: body.enabled !== false, reason };
}

async function upsertKey(body, actor) {
  const b = validateKeyBody(body);
  const fingerprint = createHash('sha256').update(b.apiKey).digest('hex').slice(0, 16);
  const now = new Date().toISOString();
  const obj = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName(b.id),
      namespace: BACKBONE_NS,
      labels: { [PART_LABEL]: 'opensphere-oaa', [KEY_LABEL]: 'true' },
      annotations: {
        'opensphere.io/oaa-key-id': b.id,
        'opensphere.io/oaa-provider': b.provider,
        'opensphere.io/oaa-display-name': b.displayName,
        'opensphere.io/oaa-base-url': b.baseUrl,
        'opensphere.io/oaa-default-model': b.defaultModel,
        'opensphere.io/oaa-embedding-model': b.embeddingModel,
        'opensphere.io/oaa-enabled': String(b.enabled),
        'opensphere.io/oaa-key-fingerprint': fingerprint,
        'opensphere.io/oaa-updated-at': now,
        'opensphere.io/oaa-updated-by': actor.username,
        'opensphere.io/oaa-change-reason': b.reason,
      },
    },
    type: 'Opaque',
    stringData: { api_key: b.apiKey },
  };
  const created = await k8s('POST', `/api/v1/namespaces/${BACKBONE_NS}/secrets`, obj);
  if (created.ok) return { created: true, item: keyMetaFromSecret({ metadata: obj.metadata }) };
  if (created.status !== 409) throw { code: 502, msg: `secret create HTTP ${created.status}` };
  const patched = await k8s('PATCH', `/api/v1/namespaces/${BACKBONE_NS}/secrets/${obj.metadata.name}`, {
    metadata: { labels: obj.metadata.labels, annotations: obj.metadata.annotations },
    stringData: obj.stringData,
  });
  if (!patched.ok) throw { code: 502, msg: `secret patch HTTP ${patched.status}` };
  return { created: false, item: keyMetaFromSecret({ metadata: obj.metadata }) };
}

async function deleteKey(id) {
  if (!ID_RE.test(id)) throw { code: 400, msg: 'invalid id' };
  const r = await k8s('DELETE', `/api/v1/namespaces/${BACKBONE_NS}/secrets/${secretName(id)}`);
  if (r.ok || r.status === 404) return { deleted: r.status !== 404 };
  throw { code: 502, msg: `secret delete HTTP ${r.status}` };
}

function audit(actor, action, target, result, reason) {
  console.log('[oaa-audit] ' + JSON.stringify({
    time: new Date().toISOString(),
    actor: actor?.username || 'system',
    action,
    target,
    result,
    reason: reason || '',
  }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname === '/api/oaa/health') {
      return json(res, 200, { service: 'oaa-gateway', version: VERSION, namespace: BACKBONE_NS });
    }
    if (url.pathname === '/api/oaa/admin/knowledge/stats' && req.method === 'GET') {
      await verifyAdmin(req);
      return json(res, 200, await knowledgeStats());
    }
    if (url.pathname === '/api/oaa/admin/knowledge/seed' && req.method === 'POST') {
      const actor = await verifyAdmin(req);
      return json(res, 200, await seedBuiltinKnowledge(true, actor));
    }
    if (url.pathname === '/api/oaa/admin/knowledge/reembed' && req.method === 'POST') {
      const actor = await verifyAdmin(req);
      const body = await readBody(req);
      return json(res, 200, await reembedKnowledge(body, actor));
    }
    if (url.pathname === '/api/oaa/admin/knowledge/documents' && req.method === 'POST') {
      const actor = await verifyAdmin(req);
      const body = await readBody(req);
      return json(res, 201, await upsertKnowledgeDocument(body, actor));
    }
    if (url.pathname === '/api/oaa/admin/knowledge/manual-seed' && req.method === 'POST') {
      const actor = await verifyAdmin(req);
      const body = await readBody(req);
      return json(res, 200, await upsertManualSeedManifest(body, actor));
    }
    if (url.pathname === '/api/oaa/admin/knowledge/manual-seed/bundled' && req.method === 'POST') {
      const actor = await verifyAdmin(req);
      return json(res, 200, await seedBundledManualKnowledge(actor));
    }
    if (url.pathname === '/api/oaa/knowledge/search' && req.method === 'GET') {
      await verifyAuthed(req);
      const q = url.searchParams.get('q') || '';
      return json(res, 200, { items: await searchKnowledge(q, Number(url.searchParams.get('limit') || OAA_RAG_TOP_K)) });
    }
    if (url.pathname === '/api/oaa/knowledge/concepts' && req.method === 'GET') {
      await verifyAuthed(req);
      return json(res, 200, await listManualConceptGraph(url.searchParams.get('q') || '', Number(url.searchParams.get('limit') || 64)));
    }
    if (url.pathname === '/api/manual/sources' && req.method === 'GET') {
      await verifyAuthed(req);
      return json(res, 200, await listManualSources());
    }
    if (url.pathname === '/api/manual/documents' && req.method === 'GET') {
      await verifyAuthed(req);
      return json(res, 200, await listManualDocuments({
        q: url.searchParams.get('q') || '',
        source: url.searchParams.get('source') || '',
        limit: url.searchParams.get('limit') || 40,
      }));
    }
    if (url.pathname === '/api/manual/document' && req.method === 'GET') {
      await verifyAuthed(req);
      return json(res, 200, await getManualDocument(url.searchParams.get('sourceId') || ''));
    }
    if (url.pathname === '/api/manual/search' && req.method === 'GET') {
      await verifyAuthed(req);
      return json(res, 200, await searchManualRegistry(url.searchParams.get('q') || '', Number(url.searchParams.get('limit') || 8)));
    }
    if (url.pathname === '/api/oaa/tools/manifest' && req.method === 'GET') {
      await verifyAuthed(req);
      return json(res, 200, await toolManifestFromStore());
    }
    if (url.pathname === '/api/oaa/tools/action-bindings' && req.method === 'GET') {
      await verifyAuthed(req);
      return json(res, 200, await actionBindingsFromStore());
    }
    if (url.pathname === '/api/oaa/tools/environment' && (req.method === 'GET' || req.method === 'POST')) {
      const actor = await verifyAuthed(req);
      const body = req.method === 'POST' ? await readBody(req) : {};
      return json(res, 200, await environmentSnapshot(body, actor));
    }
    if (url.pathname === '/api/oaa/tools/k8s/pod-logs' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      const body = await readBody(req);
      return json(res, 200, await podLogs(body, actor));
    }
    if (url.pathname === '/api/oaa/tools/k8s/pods-summary' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      const out = await clusterPodSummary();
      audit(actor, 'k8s-cluster-pod-summary', 'cluster', 'ok', `${out.totalPods || 0} pods`);
      return json(res, 200, { action: 'cluster-pod-summary', message: summarizeClusterPods(out), cluster: out });
    }
    if (url.pathname === '/api/oaa/tools/k8s/describe' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      const body = await readBody(req);
      const kind = String(body.kind || '').toLowerCase();
      if (kind === 'pod' || kind === 'pods') return json(res, 200, await describePod(body, actor));
      if (kind === 'deployment' || kind === 'deploy' || kind === 'deployments') return json(res, 200, await describeDeployment(body, actor));
      return json(res, 400, { error: 'kind must be pod or deployment' });
    }
    if (url.pathname === '/api/oaa/tools/k8s/rollout' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      const body = await readBody(req);
      return json(res, 200, await rolloutStatus(body, actor));
    }
    if (url.pathname === '/api/oaa/tools/k8s/services' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      const body = await readBody(req);
      const out = await selectedSnapshots(body.namespace || '');
      audit(actor, 'k8s-services', body.namespace || OAA_ENV_NAMESPACES.join(','), 'ok', `${out.length} namespaces`);
      return json(res, 200, { action: 'services', message: summarizeServices(out), namespaces: out });
    }
    if (url.pathname === '/api/oaa/tools/k8s/events' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      const body = await readBody(req);
      const out = await selectedSnapshots(body.namespace || '');
      audit(actor, 'k8s-events', body.namespace || OAA_ENV_NAMESPACES.join(','), 'ok', `${out.length} namespaces`);
      return json(res, 200, { action: 'events', message: summarizeEvents(out), namespaces: out });
    }
    if (url.pathname === '/api/oaa/actions/bindings/execute' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      const body = await readBody(req);
      return json(res, 200, await executeActionBinding(body, actor));
    }
    if (url.pathname === '/api/oaa/actions/k8s/restart-deployment' && req.method === 'POST') {
      const actor = await verifyAdmin(req);
      const body = await readBody(req);
      return json(res, 200, await restartDeployment(body, actor));
    }
    if (url.pathname === '/api/oaa/actions/k8s/scale-deployment' && req.method === 'POST') {
      const actor = await verifyAdmin(req);
      const body = await readBody(req);
      return json(res, 200, await scaleDeployment(body, actor));
    }
    if (url.pathname === '/api/oaa/admin/llm-keys' && req.method === 'GET') {
      await verifyAdmin(req);
      return json(res, 200, { items: await listKeys() });
    }
    if (url.pathname === '/api/oaa/admin/llm-keys' && req.method === 'POST') {
      const actor = await verifyAdmin(req);
      const body = await readBody(req);
      const out = await upsertKey(body, actor);
      audit(actor, out.created ? 'llm-key-create' : 'llm-key-rotate', out.item.id, 'ok', body.reason);
      return json(res, out.created ? 201 : 200, out);
    }
    if (url.pathname === '/api/oaa/chat' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      const body = await readBody(req);
      return json(res, 200, await chatCompletion(body, actor));
    }
    const del = url.pathname.match(/^\/api\/oaa\/admin\/llm-keys\/([a-z0-9-]+)$/);
    if (del && req.method === 'DELETE') {
      const actor = await verifyAdmin(req);
      const reason = url.searchParams.get('reason') || '';
      if (!reason.trim()) return json(res, 400, { error: 'reason required' });
      const out = await deleteKey(del[1]);
      audit(actor, 'llm-key-delete', del[1], out.deleted ? 'ok' : 'not-found', reason);
      return json(res, 200, out);
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    const code = typeof e.code === 'number' ? e.code : 500;
    if (code >= 500) console.error('[oaa-error]', req.method, url.pathname, e && (e.stack || e.message || e));
    return json(res, code, { error: e.msg || e.message || String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`oaa-gateway v${VERSION} listening :${PORT} (ns=${BACKBONE_NS})`);
  seedBuiltinKnowledge().then((out) => {
    if (out.seeded) console.log(`[oaa-db] seeded ${out.documents} docs / ${out.chunks} chunks (dim=${OAA_EMBED_DIM})`);
    else console.log(`[oaa-db] ready (${out.reason || 'ok'}, dim=${OAA_EMBED_DIM})`);
  }).catch((e) => console.error('[oaa-db] init failed', e.message || e));
  seedBundledManualKnowledgeIfEmpty().then((out) => {
    if (out.seeded) console.log(`[oaa-db] seeded bundled manuals ${out.documents} docs / ${out.chunks} chunks`);
    else console.log(`[oaa-db] bundled manuals ready (${out.reason || 'ok'})`);
  }).catch((e) => console.error('[oaa-db] bundled manual seed failed', e.message || e));
  seedToolRegistry().then((out) => {
    if (out.seeded) console.log(`[oaa-db] seeded tool registry ${out.tools} tools / ${out.bindings} bindings`);
    else console.log(`[oaa-db] tool registry ready (${out.reason || 'ok'})`);
  }).catch((e) => console.error('[oaa-db] tool registry seed failed', e.message || e));
});
