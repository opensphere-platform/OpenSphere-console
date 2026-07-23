const http = require('http');
const fs = require('fs');
const { createHash, randomUUID } = require('crypto');
const { Pool } = require('pg');
const { normalizeProviderToolCalls } = require('./provider-tool-calls');
const { manualSeedStructureDiff, relationId, seedOwnershipMetadata } = require('./manual-seed-reconcile');
const { buildAgentControlReadiness } = require('./agent-control-readiness');
const {
  RUNTIME_RESOURCE_KINDS,
  WATCH_RESOURCE_KINDS,
  resourceDefinition,
  kubernetesResourcePath,
  sanitizeKubernetesObject,
  projectedResourceHealth,
} = require('./kubernetes-resource-catalog');

const PORT = Number(process.env.PORT || 8080);
const VERSION = process.env.APP_VERSION || '0.1.0';
const OAA_NAMESPACE = process.env.OAA_NAMESPACE || 'opensphere-console';
const OAA_KEY_NAMESPACE = process.env.OAA_KEY_NAMESPACE || 'opensphere-oaa-credentials';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const APISERVER = process.env.APISERVER || 'https://kubernetes.default.svc';
const CONSOLE_ADMIN_GROUP = process.env.CONSOLE_ADMIN_GROUP || 'console-admins';
const CONSOLE_IDENTITY_URL = (process.env.CONSOLE_IDENTITY_URL || 'http://opensphere-console-backend.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const DUPA_CONTROL_URL = (process.env.DUPA_CONTROL_URL || 'http://opensphere-console-dupa-controller.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const CLUSTER_MANAGER_URL = (process.env.CLUSTER_MANAGER_URL || 'http://cluster-manager.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const FOUNDATION_CONTROL_URL = (process.env.FOUNDATION_CONTROL_URL || 'http://foundation-oaa-owner.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const SCHEMA_ID_RE = /^[a-z_][a-z0-9_]{0,62}$/;
// ADR-006 target mode.  In this mode schema ownership belongs exclusively to
// versioned Supabase migrations; the gateway validates and consumes it but
// never performs runtime DDL.
const OAA_DATA_AUTHORITY = 'supabase';
const OAA_SUPABASE_MODE = true;
// The gateway uses its own Supabase PostgreSQL role; it never reuses a Console
// Backend credential or owns schema migration/DDL.
const PG = {
  host: process.env.OAA_PG_HOST || 'opensphere-supabase-postgres.opensphere-console-data.svc.cluster.local',
  port: Number(process.env.OAA_PG_PORT || 5432),
  database: process.env.OAA_PG_DB || 'postgres',
  user: process.env.OAA_PG_USER || 'opensphere_oaa_gateway',
  password: process.env.OAA_PG_PASSWORD || '',
  // The dedicated schema opensphere_oaa owns. Unqualified OAA table names resolve here via
  // search_path, never requiring (or granting) CREATE on public.
  schema: SCHEMA_ID_RE.test(process.env.OAA_PG_SCHEMA || '') ? process.env.OAA_PG_SCHEMA : 'oaa',
  // Setup-managed installation CA for verified TLS to Supabase PostgreSQL — never a baked-in
  // image certificate, and connections never disable certificate verification.
  caPath: process.env.OAA_PG_CA_PATH || '/etc/oaa-postgres-ca/ca.crt',
};
const OAA_PG_TLS = process.env.OAA_PG_TLS === 'true';
const OAA_EMBED_DIM = Math.max(16, Math.min(4096, Number(process.env.OAA_EMBED_DIM || (OAA_SUPABASE_MODE ? 1536 : 384)) || (OAA_SUPABASE_MODE ? 1536 : 384)));
const OAA_RAG_TOP_K = Math.max(1, Math.min(12, Number(process.env.OAA_RAG_TOP_K || 5) || 5));
const OAA_RAG_ENABLED = process.env.OAA_RAG_ENABLED !== 'false';
// Legacy compatibility flag. It now permits PostgreSQL lexical fallback only;
// OAA never manufactures hash vectors that can be confused with semantic evidence.
const OAA_ALLOW_HASH_EMBEDDINGS = process.env.OAA_ALLOW_HASH_EMBEDDINGS === 'true';
const OAA_EMBED_READINESS_TTL_MS = Math.max(30000, Math.min(900000, Number(process.env.OAA_EMBED_READINESS_TTL_MS || 300000) || 300000));
const OAA_RUNTIME_REFRESH_MS = Math.max(30000, Math.min(300000, Number(process.env.OAA_RUNTIME_REFRESH_MS || 60000) || 60000));
const OAA_K8S_WATCH_ENABLED = process.env.OAA_K8S_WATCH_ENABLED !== 'false';
const OAA_K8S_WATCH_TIMEOUT_SECONDS = Math.max(60, Math.min(600, Number(process.env.OAA_K8S_WATCH_TIMEOUT_SECONDS || 240) || 240));
const OAA_K8S_WATCH_RECONNECT_MS = Math.max(1000, Math.min(30000, Number(process.env.OAA_K8S_WATCH_RECONNECT_MS || 3000) || 3000));
const OAA_K8S_WATCH_HEARTBEAT_MS = Math.max(5000, Math.min(60000, Number(process.env.OAA_K8S_WATCH_HEARTBEAT_MS || 15000) || 15000));
const OAA_WATCH_OBSERVER_ID = String(process.env.OAA_WATCH_OBSERVER_ID || process.env.HOSTNAME || randomUUID()).trim().slice(0, 128);
const OAA_ACTION_SUBMISSION_ENABLED = process.env.OAA_ACTION_SUBMISSION_ENABLED === 'true';
const OAA_EMBED_KEY_ID = String(process.env.OAA_EMBED_KEY_ID || '').trim();
const OAA_MANUAL_SEED_PATH = process.env.OAA_MANUAL_SEED_PATH || '/app/manual-seeds/opensphere-core-manuals.json';
const OAA_ENV_NAMESPACES = (process.env.OAA_ENV_NAMESPACES || 'opensphere-console,opensphere-console-data,opensphere-console-change,opensphere-foundation,opensphere-system')
  .split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8);
const OAA_MUTATION_NAMESPACES = (process.env.OAA_MUTATION_NAMESPACES || 'opensphere-console,opensphere-console-data,opensphere-console-change')
  .split(',').map((x) => x.trim()).filter((x) => OAA_ENV_NAMESPACES.includes(x)).slice(0, 8);
const OAA_SCALE_MAX = Math.max(1, Math.min(50, Number(process.env.OAA_SCALE_MAX || 10) || 10));
const OAA_WORKLOAD_KINDS = Object.freeze(['deployment', 'statefulset', 'daemonset']);
const OAA_SCALABLE_WORKLOAD_KINDS = Object.freeze(['deployment', 'statefulset']);
const OAA_APPLY_RESOURCE_KINDS = Object.freeze([
  'configmap', 'service', 'deployment', 'statefulset', 'daemonset', 'job', 'cronjob',
  'ingress', 'networkpolicy', 'horizontalpodautoscaler', 'poddisruptionbudget', 'persistentvolumeclaim',
]);
const OAA_DELETE_RESOURCE_KINDS = Object.freeze([
  'configmap', 'service', 'deployment', 'statefulset', 'daemonset', 'job', 'cronjob',
  'ingress', 'networkpolicy', 'horizontalpodautoscaler', 'poddisruptionbudget',
]);
const OAA_HIS_VALIDATION_IDS = Object.freeze(['cluster-network', 'cluster-dns', 'kube-prometheus-stack', 'storage', 'csi-snapshot']);
const OAA_HIS_MANAGED_IDS = Object.freeze(['ingress-nginx', 'cert-manager', 'metrics-server', 'kube-prometheus-stack']);
const OAA_HIS_LIFECYCLE_ACTIONS = Object.freeze(['install', 'upgrade', 'recover', 'rollback', 'uninstall']);
const OAA_EXTENSION_LIFECYCLE_ACTIONS = Object.freeze(['install', 'enable', 'disable', 'uninstall', 'rollback']);
const OAA_FOUNDATION_ENGINES = Object.freeze(['keycloak', 'samba', 'postgres', 'psmdb', 'valkey', 'opensearch', 'rustfs']);
const OAA_FOUNDATION_MODELS = Object.freeze(['identity', 'data']);
const OAA_CONSOLE_ROLES = Object.freeze(['console-admins', 'console-operators', 'console-viewers']);
const OAA_EVIDENCE_STREAMS = Object.freeze(['agent_run', 'agent_step', 'tool_run', 'retrieval_trace', 'llm_usage_event', 'runtime_event']);
const OAA_RECOVERY_COMPONENTS = Object.freeze(['all', 'supabase-database', 'supabase-storage', 'gitea']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OAA_EXTENSION_IMAGE_RE = /^ghcr\.io\/opensphere-platform\/[a-z0-9._-]+@sha256:[0-9a-f]{64}$/;
const OAA_CEPH_IMPORT_REF_RE = /^opensphere-ceph-imports\/opensphere-ceph-import-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OAA_OWNER_ACTION_TOOL_IDS = new Set([
  'oaa.platform.readiness.preflight',
  'oaa.platform.readiness.verify',
  'oaa.extension.lifecycle',
  'oaa.extension.image.revoke',
  'oaa.notification.channel.enabled',
  'oaa.notification.channel.test',
  'oaa.notification.delivery.retry',
  'oaa.his.validate',
  'oaa.his.lifecycle',
  'oaa.his.observability.configure',
  'oaa.ceph.connect',
  'oaa.ceph.disconnect',
  'oaa.foundation.engine.lifecycle',
  'oaa.foundation.claim.create',
  'oaa.foundation.claim.release',
  'oaa.foundation.identity-directory.claim.create',
  'oaa.foundation.identity-directory.claim.release',
  'oaa.identity.user.create',
  'oaa.identity.user.enabled',
  'oaa.identity.role.membership',
  'oaa.evidence.retention.update',
]);
// CONSTITUTION-0004 §4.2: before Cluster Manager Activated + HIS Preflight Ready, OAA may only
// expose Manual/help/search/safe read-only capability. Kubernetes mutation/action tools must stay
// unavailable. This must be exactly the string 'true' to open the gate; any other value (including
// unset) fails closed.
const OAA_MUTATION_ENABLED = process.env.OAA_MUTATION_ENABLED === 'true';
const OAA_MUTATION_GATE_REASON = 'mutation_disabled_until_his_ready';

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

async function verifyAuthed(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) throw { code: 401, msg: 'no bearer token' };
  let response;
  try {
    response = await fetch(`${CONSOLE_IDENTITY_URL}/api/identity/session`, {
      headers: { authorization: `Bearer ${m[1]}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw { code: 503, msg: 'Supabase identity authority unavailable' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw { code: response.status === 403 ? 403 : 401, msg: body.error || 'invalid Supabase session' };
  return {
    username: body.username || body.subject || 'unknown',
    subject: body.subject || '',
    groups: Array.isArray(body.groups) ? body.groups : [],
    permissions: Array.isArray(body.permissions) ? body.permissions : [],
    assurance: body.assurance || 'aal1',
    // Never log this value.  It is retained only for a same-request call to
    // the Console Backend audit authority.
    bearerToken: m[1],
    provider: 'supabase',
  };
}

async function verifyAdmin(req) {
  const actor = await verifyAuthed(req);
  if (!actor.groups.includes(CONSOLE_ADMIN_GROUP)) throw { code: 403, msg: `requires ${CONSOLE_ADMIN_GROUP}` };
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
    validationStatus: a['opensphere.io/oaa-validation-status'] || 'untested',
    validationMessage: a['opensphere.io/oaa-validation-message'] || '',
    validatedAt: a['opensphere.io/oaa-validated-at'] || '',
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
  const r = await k8s('GET', `/api/v1/namespaces/${OAA_KEY_NAMESPACE}/secrets?labelSelector=${encodeURIComponent(`${KEY_LABEL}=true`)}`);
  if (!r.ok) throw Object.assign(new Error(`secret list HTTP ${r.status}`), { code: 502 });
  return (r.json?.items || []).map(keyMetaFromSecret).sort((a, b) => a.id.localeCompare(b.id));
}

async function loadEnabledKey(id = '') {
  if (id) {
    if (!ID_RE.test(id)) throw { code: 400, msg: 'invalid keyId' };
    const r = await k8s('GET', `/api/v1/namespaces/${OAA_KEY_NAMESPACE}/secrets/${secretName(id)}`);
    if (r.status === 404) throw { code: 404, msg: 'llm key not found' };
    if (!r.ok) throw { code: 502, msg: `secret read HTTP ${r.status}` };
    const key = enabledKeyFromSecret(r.json);
    if (!key) throw { code: 400, msg: 'llm key is disabled or empty' };
    return key;
  }
  const r = await k8s('GET', `/api/v1/namespaces/${OAA_KEY_NAMESPACE}/secrets?labelSelector=${encodeURIComponent(`${KEY_LABEL}=true`)}`);
  if (!r.ok) throw { code: 502, msg: `secret list HTTP ${r.status}` };
  const keys = (r.json?.items || []).map(enabledKeyFromSecret).filter(Boolean);
  const preferred = keys.find((k) => k.id === 'deepseek') || keys.find((k) => k.provider === 'deepseek') || keys[0];
  if (!preferred) throw { code: 404, msg: 'no enabled llm key' };
  return preferred;
}

function supportsProviderEmbedding(key) {
  if (!key?.embeddingModel) return false;
  // The current embedding adapter implements the OpenAI-compatible
  // /embeddings contract. DeepSeek's configured endpoint is chat-only and
  // must never be probed with an OpenAI embedding model merely because the
  // metadata field was populated by an old form default.
  return key.provider === 'openai' || key.provider === 'custom';
}

async function loadEmbeddingKey(id = '') {
  const wanted = String(id || OAA_EMBED_KEY_ID || '').trim();
  if (wanted) {
    const key = await loadEnabledKey(wanted);
    if (!key.embeddingModel) throw { code: 400, msg: `llm key ${wanted} has no embedding model` };
    if (!supportsProviderEmbedding(key)) throw { code: 400, msg: `llm key ${wanted} provider does not support the configured embedding adapter` };
    return key;
  }
  const r = await k8s('GET', `/api/v1/namespaces/${OAA_KEY_NAMESPACE}/secrets?labelSelector=${encodeURIComponent(`${KEY_LABEL}=true`)}`);
  if (!r.ok) throw { code: 502, msg: `secret list HTTP ${r.status}` };
  const keys = (r.json?.items || []).map(enabledKeyFromSecret).filter(supportsProviderEmbedding);
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
let pgUsageLedgerReady = false;
let pgUsageLedgerPromise = null;
let pgSeedReady = false;

function pgEnabled() {
  return Boolean(PG.password);
}

// Reads the Setup-managed installation CA mounted read-only from Supabase PostgreSQL
// Secret (never a baked-in image certificate). Returns undefined (never throws) so a missing
// mount fails closed into getPgPool() below refusing to open an unverified connection, rather
// than silently connecting without TLS verification.
function pgCa() {
  try {
    return fs.readFileSync(PG.caPath);
  } catch {
    return undefined;
  }
}

function getPgPool() {
  if (!pgEnabled()) return null;
  if (!pgPool) {
    const ca = pgCa();
    if (OAA_PG_TLS && !ca) {
      // Fail closed: never fall back to an unverified/plaintext connection. The caller sees
      // "no pool" (same shape as postgres-not-configured) and /readyz stays a structured 503.
      console.error('[oaa-db] Supabase PostgreSQL installation CA is unavailable at', PG.caPath, '- refusing to connect without verified TLS');
      return null;
    }
    pgPool = new Pool({
      host: PG.host,
      port: PG.port,
      database: PG.database,
      user: PG.user,
      password: PG.password,
      // Verified TLS against the Setup-managed installation CA — rejectUnauthorized stays
      // true and servername is pinned to the Supabase PostgreSQL DNS name.
      // Supabase PostgreSQL is reached only over the cluster NetworkPolicy in
      // the current self-hosted install; TLS can be required explicitly when a
      // TLS-enabled service is configured. The deprecated legacy database path
      // is not supported by this runtime.
      ssl: OAA_PG_TLS ? { ca, rejectUnauthorized: true, servername: PG.host } : (OAA_SUPABASE_MODE ? false : { ca, rejectUnauthorized: true, servername: PG.host }),
      // Deterministic, race-free search_path: `options` is sent inside the libpq StartupMessage
      // (see pg/lib/client.js _startup) and applied by the server before authentication
      // completes and before the pool can ever hand the connection to a caller's query -- unlike
      // a 'connect'-event client.query(), there is no window where a caller's first query can
      // race an unawaited SET. This is also belt-and-suspenders with the role-level
      // `ALTER ROLE opensphere_oaa ... SET search_path = oaa, public` already established by
      // Supabase bootstrap/reconcile, so search_path
      // is correct even for a bare `psql -U opensphere_oaa` session that never sets `options`.
      // PG.schema is validated against SCHEMA_ID_RE above, never interpolated from an
      // unvalidated source.
      options: `-c search_path=${PG.schema},extensions,public`,
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
  if (OAA_SUPABASE_MODE) {
    // Migration 0005 is the only schema writer in the target architecture.
    // Verify the serving projection and vector extension rather than silently
    // creating partial tables from an application pod.
    const state = await pool.query(`
      SELECT
        to_regclass('oaa.oaa_knowledge_documents') AS documents,
        to_regclass('oaa.oaa_knowledge_chunks') AS chunks,
        to_regclass('oaa.oaa_tool_capabilities') AS tools,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'oaa' AND table_name = 'oaa_knowledge_chunks'
            AND column_name = 'document_revision'
        ) AS revision_ready,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'oaa' AND table_name = 'oaa_knowledge_chunks'
            AND column_name = 'active'
        ) AS active_ready,
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector_ready
    `);
    const row = state.rows[0] || {};
    if (!row.documents || !row.chunks || !row.tools || row.vector_ready !== true || row.revision_ready !== true || row.active_ready !== true) {
      throw new Error('Supabase OAA migrations 0005 and 0015 are not applied');
    }
    pgSchemaReady = true;
    return true;
  }
  // pgvector installation is bootstrap-owner responsibility only (CONSTITUTION-0004 §4.5):
  // Setup's sealed opensphere_db_bootstrap superuser runs `CREATE EXTENSION IF NOT EXISTS
  // vector` during empty-PVC init and idempotent boundary reconcile (see
  // Supabase migrations). opensphere_oaa deliberately has no CREATE on
  // public and must never attempt to install the extension itself.
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
    // Always clear the in-flight promise, on both success and failure. Only the caller that
    // created pgSchemaPromise reaches this finally (concurrent callers returned the shared
    // promise early above), so this cannot race a fast-path pgSchemaReady check. Clearing it
    // unconditionally lets a later call retry schema setup after a transient failure (e.g. the
    // async startup seed racing PostgreSQL before it was ready) instead of leaving
    // pgSchemaPromise pinned to a rejected Promise forever.
    pgSchemaPromise = null;
  }
}

async function ensureUsageLedgerSchema() {
  const pool = getPgPool();
  if (!pool) throw { code: 503, msg: 'Supabase PostgreSQL is not configured for LLM usage' };
  if (pgUsageLedgerReady) return true;
  if (pgUsageLedgerPromise) return pgUsageLedgerPromise;
  pgUsageLedgerPromise = (async () => {
    const state = await pool.query("SELECT to_regclass('oaa.llm_usage_event') AS usage_ledger");
    if (!state.rows[0]?.usage_ledger) throw new Error('Supabase OAA migration 0012 is not applied');
    pgUsageLedgerReady = true;
    return true;
  })();
  try {
    return await pgUsageLedgerPromise;
  } finally {
    pgUsageLedgerPromise = null;
  }
}

function usageToken(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeProviderUsage(raw) {
  const usage = raw && typeof raw === 'object' ? raw : null;
  const inputTokens = usageToken(usage?.prompt_tokens ?? usage?.input_tokens);
  const outputTokens = usageToken(usage?.completion_tokens ?? usage?.output_tokens);
  const cachedInputTokens = usageToken(
    usage?.prompt_cache_hit_tokens
      ?? usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.input_tokens_details?.cached_tokens,
  );
  const reasoningTokens = usageToken(
    usage?.completion_tokens_details?.reasoning_tokens
      ?? usage?.output_tokens_details?.reasoning_tokens,
  );
  const reportedTotal = usageToken(usage?.total_tokens);
  const totalTokens = Math.max(reportedTotal, inputTokens + outputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    totalTokens,
    source: usage ? 'provider' : 'unavailable',
  };
}

function usageSource(value, fallback = 'oaa-gateway') {
  const source = String(value || fallback).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(source) ? source : fallback;
}

function digestUsageSession(value) {
  const sessionId = String(value || '').trim();
  return sessionId ? `sha256:${createHash('sha256').update(sessionId).digest('hex')}` : null;
}

async function recordLlmUsageEvent(event) {
  try {
    await ensureUsageLedgerSchema();
    const pool = getPgPool();
    if (!pool) return false;
    const usage = event.usage || normalizeProviderUsage(null);
    const actorId = String(event.actor?.subject || 'system').slice(0, 200);
    const actorLabel = String(event.actor?.username || event.actor?.subject || 'system').slice(0, 200);
    await pool.query(`
      INSERT INTO llm_usage_event (
        request_id, agent_run_id, provider_request_id, actor_id, actor_label, source, session_digest,
        key_id, key_fingerprint, credential_revision, provider, model, operation, status,
        input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, total_tokens,
        usage_source, latency_ms, finish_reason, error_code, estimated_cost_usd, pricing_version
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
      ) ON CONFLICT (request_id) DO NOTHING
    `, [
      event.requestId,
      event.agentRunId || null,
      event.providerRequestId ? String(event.providerRequestId).slice(0, 240) : null,
      actorId,
      actorLabel,
      usageSource(event.source),
      digestUsageSession(event.sessionId),
      String(event.key?.id || 'unknown').slice(0, 48),
      event.key?.keyFingerprint ? String(event.key.keyFingerprint).slice(0, 160) : null,
      event.key?.updatedAt ? String(event.key.updatedAt).slice(0, 160) : null,
      String(event.key?.provider || event.provider || 'unknown').slice(0, 64),
      String(event.model || 'unknown').slice(0, 160),
      event.operation === 'embedding' ? 'embedding' : 'chat_completion',
      ['succeeded', 'failed', 'cancelled'].includes(event.status) ? event.status : 'failed',
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedInputTokens,
      usage.reasoningTokens,
      usage.totalTokens,
      usage.source,
      Number.isFinite(Number(event.latencyMs)) ? Math.max(0, Math.floor(Number(event.latencyMs))) : null,
      event.finishReason ? String(event.finishReason).slice(0, 160) : null,
      event.errorCode ? String(event.errorCode).slice(0, 160) : null,
      Number.isFinite(Number(event.estimatedCostUsd)) ? Number(event.estimatedCostUsd) : null,
      event.pricingVersion ? String(event.pricingVersion).slice(0, 160) : null,
    ]);
    return true;
  } catch (error) {
    console.warn('[oaa-usage] Supabase ledger write skipped:', error.message || error);
    return false;
  }
}

function usageMetric(row = {}) {
  const requests = Number(row.requests || 0);
  const successfulRequests = Number(row.successfulRequests || 0);
  return {
    requests,
    successfulRequests,
    failedRequests: Number(row.failedRequests || 0),
    inputTokens: Number(row.inputTokens || 0),
    outputTokens: Number(row.outputTokens || 0),
    cachedInputTokens: Number(row.cachedInputTokens || 0),
    reasoningTokens: Number(row.reasoningTokens || 0),
    totalTokens: Number(row.totalTokens || 0),
    successRate: requests ? Number(((successfulRequests / requests) * 100).toFixed(1)) : 0,
    p95LatencyMs: row.p95LatencyMs == null ? null : Math.round(Number(row.p95LatencyMs)),
    estimatedCostUsd: row.estimatedCostUsd == null ? null : Number(row.estimatedCostUsd),
    pricedRequests: Number(row.pricedRequests || 0),
    unpricedRequests: Number(row.unpricedRequests || 0),
  };
}

async function llmUsageDashboard(days = 30) {
  await ensureUsageLedgerSchema();
  const pool = getPgPool();
  if (!pool) throw { code: 503, msg: 'Supabase PostgreSQL is not configured for LLM usage' };
  const rangeDays = [1, 7, 30, 90, 365].includes(Number(days)) ? Number(days) : 30;
  const metricColumns = `
    count(e.request_id)::int AS "requests",
    count(*) FILTER (WHERE e.status = 'succeeded')::int AS "successfulRequests",
    count(*) FILTER (WHERE e.status <> 'succeeded')::int AS "failedRequests",
    COALESCE(sum(e.input_tokens), 0)::bigint AS "inputTokens",
    COALESCE(sum(e.output_tokens), 0)::bigint AS "outputTokens",
    COALESCE(sum(e.cached_input_tokens), 0)::bigint AS "cachedInputTokens",
    COALESCE(sum(e.reasoning_tokens), 0)::bigint AS "reasoningTokens",
    COALESCE(sum(e.total_tokens), 0)::bigint AS "totalTokens",
    percentile_cont(0.95) WITHIN GROUP (ORDER BY e.latency_ms) FILTER (WHERE e.latency_ms IS NOT NULL) AS "p95LatencyMs",
    sum(e.estimated_cost_usd) AS "estimatedCostUsd",
    count(*) FILTER (WHERE e.estimated_cost_usd IS NOT NULL)::int AS "pricedRequests",
    count(*) FILTER (WHERE e.total_tokens > 0 AND e.estimated_cost_usd IS NULL)::int AS "unpricedRequests"`;
  const [summaryResult, windowsResult, byKeyResult, byModelResult, bySourceResult, dailyResult, recentResult] = await Promise.all([
    pool.query(`SELECT ${metricColumns} FROM llm_usage_event e WHERE e.occurred_at >= now() - ($1::int * interval '1 day')`, [rangeDays]),
    pool.query(`
      WITH windows(name, since_at) AS (VALUES
        ('hours24', now() - interval '24 hours'),
        ('days7', now() - interval '7 days'),
        ('days30', now() - interval '30 days')
      )
      SELECT w.name, ${metricColumns}
      FROM windows w LEFT JOIN llm_usage_event e ON e.occurred_at >= w.since_at
      GROUP BY w.name
    `),
    pool.query(`
      SELECT e.key_id AS "keyId", max(e.provider) AS "provider",
        array_agg(DISTINCT e.model ORDER BY e.model) AS "models",
        max(e.occurred_at) AS "lastUsedAt", ${metricColumns},
        COALESCE(sum(e.total_tokens) FILTER (WHERE e.occurred_at >= now() - interval '24 hours'), 0)::bigint AS "tokens24h",
        COALESCE(sum(e.total_tokens) FILTER (WHERE e.occurred_at >= now() - interval '7 days'), 0)::bigint AS "tokens7d",
        COALESCE(sum(e.total_tokens) FILTER (WHERE e.occurred_at >= now() - interval '30 days'), 0)::bigint AS "tokens30d"
      FROM llm_usage_event e
      WHERE e.occurred_at >= now() - (GREATEST($1::int, 30) * interval '1 day')
      GROUP BY e.key_id ORDER BY "totalTokens" DESC
    `, [rangeDays]),
    pool.query(`
      SELECT e.provider, e.model, e.operation, ${metricColumns}
      FROM llm_usage_event e
      WHERE e.occurred_at >= now() - ($1::int * interval '1 day')
      GROUP BY e.provider, e.model, e.operation ORDER BY "totalTokens" DESC
    `, [rangeDays]),
    pool.query(`
      SELECT e.source, ${metricColumns}
      FROM llm_usage_event e
      WHERE e.occurred_at >= now() - ($1::int * interval '1 day')
      GROUP BY e.source ORDER BY "totalTokens" DESC
    `, [rangeDays]),
    pool.query(`
      WITH days AS (
        SELECT generate_series(
          (now() AT TIME ZONE 'Asia/Seoul')::date - ($1::int - 1),
          (now() AT TIME ZONE 'Asia/Seoul')::date,
          interval '1 day'
        )::date AS day
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS "date", ${metricColumns}
      FROM days d
      LEFT JOIN llm_usage_event e
        ON (e.occurred_at AT TIME ZONE 'Asia/Seoul') >= d.day
       AND (e.occurred_at AT TIME ZONE 'Asia/Seoul') < d.day + interval '1 day'
      GROUP BY d.day ORDER BY d.day
    `, [rangeDays]),
    pool.query(`
      SELECT request_id AS "requestId", occurred_at AS "occurredAt", key_id AS "keyId",
        provider, model, operation, source, status, input_tokens AS "inputTokens",
        output_tokens AS "outputTokens", total_tokens AS "totalTokens", usage_source AS "usageSource",
        latency_ms AS "latencyMs", estimated_cost_usd AS "estimatedCostUsd"
      FROM llm_usage_event ORDER BY occurred_at DESC LIMIT 25
    `),
  ]);
  const windows = Object.fromEntries(windowsResult.rows.map((row) => [row.name, usageMetric(row)]));
  return {
    schema: 'oaa-llm-usage.opensphere.io/v1alpha1',
    generatedAt: new Date().toISOString(),
    rangeDays,
    timeZone: 'Asia/Seoul',
    currency: 'USD',
    costBasis: 'provider-price-not-configured',
    summary: usageMetric(summaryResult.rows[0]),
    windows,
    byKey: byKeyResult.rows.map((row) => ({
      ...usageMetric(row), keyId: row.keyId, provider: row.provider, models: row.models || [],
      lastUsedAt: row.lastUsedAt, tokens24h: Number(row.tokens24h || 0),
      tokens7d: Number(row.tokens7d || 0), tokens30d: Number(row.tokens30d || 0),
    })),
    byModel: byModelResult.rows.map((row) => ({ ...usageMetric(row), provider: row.provider, model: row.model, operation: row.operation })),
    bySource: bySourceResult.rows.map((row) => ({ ...usageMetric(row), source: row.source })),
    daily: dailyResult.rows.map((row) => ({ ...usageMetric(row), date: row.date })),
    recent: recentResult.rows.map((row) => ({
      ...row,
      inputTokens: Number(row.inputTokens || 0), outputTokens: Number(row.outputTokens || 0),
      totalTokens: Number(row.totalTokens || 0), latencyMs: row.latencyMs == null ? null : Number(row.latencyMs),
      estimatedCostUsd: row.estimatedCostUsd == null ? null : Number(row.estimatedCostUsd),
    })),
  };
}

async function agentEvidenceDashboard(days = 30, limit = 25) {
  const pool = getPgPool();
  if (!pool) throw { code: 503, msg: 'Supabase PostgreSQL is not configured for OAA evidence' };
  const rangeDays = [1, 7, 30, 90, 365].includes(Number(days)) ? Number(days) : 30;
  const rowLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const schema = await pool.query(`
    SELECT to_regclass('oaa.evidence_retention_policy') IS NOT NULL AS ready,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'oaa' AND table_name = 'tool_run' AND column_name = 'agent_run_id'
      ) AS correlated
  `);
  if (!schema.rows[0]?.ready || !schema.rows[0]?.correlated) {
    throw { code: 503, msg: 'Supabase OAA migration 0019 is not applied' };
  }
  const [summaryResult, runsResult, retentionResult] = await Promise.all([
    pool.query(`
      SELECT count(*)::int AS runs,
        count(*) FILTER (WHERE status = 'completed')::int AS completed,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'running')::int AS running,
        COALESCE(sum(tool_calls), 0)::bigint AS "toolCalls"
      FROM agent_run WHERE started_at >= now() - ($1::int * interval '1 day')
    `, [rangeDays]),
    pool.query(`
      SELECT id AS "runId", actor_label AS "actorLabel", session_digest AS "sessionDigest",
        request_digest AS "requestDigest", provider, model, status, tool_calls AS "toolCalls",
        started_at AS "startedAt", completed_at AS "completedAt", error_code AS "errorCode"
      FROM agent_run
      WHERE started_at >= now() - ($1::int * interval '1 day')
      ORDER BY started_at DESC LIMIT $2
    `, [rangeDays, rowLimit]),
    pool.query(`
      SELECT stream, retention_days AS "retentionDays", disposition, legal_hold AS "legalHold",
        updated_at AS "updatedAt", updated_by AS "updatedBy", row_count AS "rowCount",
        oldest_at AS "oldestAt", due_rows AS "dueRows", export_covered_rows AS "exportCoveredRows",
        last_export_at AS "lastExportAt"
      FROM evidence_retention_status ORDER BY stream
    `),
  ]);
  const runIds = runsResult.rows.map((row) => row.runId);
  let steps = [];
  let retrievals = [];
  let tools = [];
  let providerCalls = [];
  if (runIds.length) {
    const [stepsResult, retrievalResult, toolsResult, providerResult] = await Promise.all([
      pool.query(`
        SELECT run_id AS "runId", step_index AS "stepIndex", step_kind AS "stepKind", tool_id AS "toolId",
          status, input_digest AS "inputDigest", output_digest AS "outputDigest", metadata, occurred_at AS "occurredAt"
        FROM agent_step WHERE run_id = ANY($1::uuid[]) ORDER BY run_id, step_index
      `, [runIds]),
      pool.query(`
        SELECT trace.agent_run_id AS "runId", trace.request_id AS "requestId", trace.rank, trace.score,
          trace.query_digest AS "queryDigest", trace.document_revision AS "documentRevision",
          document.source_id AS "sourceId", document.title, trace.created_at AS "occurredAt"
        FROM retrieval_trace trace
        LEFT JOIN oaa_knowledge_documents document ON document.id = trace.document_id
        WHERE trace.agent_run_id = ANY($1::uuid[])
        ORDER BY trace.agent_run_id, trace.rank
      `, [runIds]),
      pool.query(`
        SELECT agent_run_id AS "runId", request_id AS "requestId", tool_id AS "toolId", target,
          permission_code AS "permissionCode", status, input_digest AS "inputDigest",
          result_digest AS "resultDigest", created_at AS "occurredAt", completed_at AS "completedAt"
        FROM tool_run WHERE agent_run_id = ANY($1::uuid[]) ORDER BY agent_run_id, created_at
      `, [runIds]),
      pool.query(`
        SELECT agent_run_id AS "runId", request_id AS "requestId", provider, model, operation, status,
          input_tokens AS "inputTokens", output_tokens AS "outputTokens", total_tokens AS "totalTokens",
          usage_source AS "usageSource", latency_ms AS "latencyMs", occurred_at AS "occurredAt"
        FROM llm_usage_event WHERE agent_run_id = ANY($1::uuid[]) ORDER BY agent_run_id, occurred_at
      `, [runIds]),
    ]);
    steps = stepsResult.rows.map((row) => ({ ...row, metadata: redactProjection(row.metadata || {}) }));
    retrievals = retrievalResult.rows.map((row) => ({ ...row, rank: Number(row.rank), score: Number(row.score || 0) }));
    tools = toolsResult.rows;
    providerCalls = providerResult.rows.map((row) => ({
      ...row, inputTokens: Number(row.inputTokens || 0), outputTokens: Number(row.outputTokens || 0),
      totalTokens: Number(row.totalTokens || 0), latencyMs: row.latencyMs == null ? null : Number(row.latencyMs),
    }));
  }
  const groupByRun = (rows) => rows.reduce((map, row) => {
    const runId = row.runId;
    if (!map.has(runId)) map.set(runId, []);
    map.get(runId).push(row);
    return map;
  }, new Map());
  const stepMap = groupByRun(steps);
  const retrievalMap = groupByRun(retrievals);
  const toolMap = groupByRun(tools);
  const providerMap = groupByRun(providerCalls);
  return {
    schema: 'oaa-agent-evidence.opensphere.io/v1alpha1',
    generatedAt: new Date().toISOString(), rangeDays,
    privacy: 'digest-and-metadata-only; prompts, responses, credentials, and raw logs are excluded',
    deletionControl: 'No purge API is exposed. Export receipt and reviewed owner maintenance are required.',
    summary: {
      runs: Number(summaryResult.rows[0]?.runs || 0), completed: Number(summaryResult.rows[0]?.completed || 0),
      failed: Number(summaryResult.rows[0]?.failed || 0), running: Number(summaryResult.rows[0]?.running || 0),
      toolCalls: Number(summaryResult.rows[0]?.toolCalls || 0),
    },
    retention: retentionResult.rows.map((row) => ({
      ...row, rowCount: Number(row.rowCount || 0), dueRows: Number(row.dueRows || 0),
      exportCoveredRows: Number(row.exportCoveredRows || 0),
    })),
    runs: runsResult.rows.map((run) => ({
      ...run, toolCalls: Number(run.toolCalls || 0), steps: stepMap.get(run.runId) || [],
      retrievals: retrievalMap.get(run.runId) || [], tools: toolMap.get(run.runId) || [],
      providerCalls: providerMap.get(run.runId) || [],
    })),
  };
}

async function setEvidenceRetentionPolicy(actor, rawBody) {
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {};
  requireClosedOwnerInputs(body, ['stream', 'retentionDays', 'disposition', 'legalHold', 'confirm', 'reason']);
  assertPermission(actor, 'oaa.evidence.manage');
  if (actor?.assurance !== 'aal2') throw { code: 403, msg: 'evidence retention update requires MFA assurance aal2' };
  const stream = String(body.stream || '').trim();
  const retentionDays = Number(body.retentionDays);
  const disposition = String(body.disposition || '').trim().toLowerCase();
  const legalHold = body.legalHold;
  const reason = requireMutationReason(body.reason);
  if (!OAA_EVIDENCE_STREAMS.includes(stream)) throw { code: 400, msg: 'unsupported evidence stream' };
  if (!Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650) throw { code: 400, msg: 'retentionDays must be an integer between 30 and 3650' };
  if (!['retain', 'export-before-delete'].includes(disposition)) throw { code: 400, msg: 'unsupported evidence disposition' };
  if (typeof legalHold !== 'boolean') throw { code: 400, msg: 'legalHold must be boolean' };
  requireConfirm(body.confirm, `update OAA evidence retention ${stream} to ${retentionDays} days`);
  const pool = getPgPool();
  if (!pool) throw { code: 503, msg: 'Supabase PostgreSQL is not configured for OAA evidence' };
  const result = await pool.query(`
    SELECT stream, retention_days AS "retentionDays", disposition, legal_hold AS "legalHold",
      updated_at AS "updatedAt", updated_by AS "updatedBy"
    FROM oaa.set_evidence_retention_policy($1, $2, $3, $4, $5, $6)
  `, [stream, retentionDays, disposition, legalHold, String(actor?.subject || actor?.username || 'unknown').slice(0, 200), reason]);
  return {
    accepted: true, owner: 'OAA Supabase evidence owner', target: `OAAEvidence/${stream}`,
    policy: result.rows[0], deletionPerformed: false,
    nextBoundary: disposition === 'export-before-delete' ? 'export receipt plus reviewed owner maintenance required' : 'retained in Supabase',
  };
}

let embeddingReadiness = {
  checkedAtMs: 0,
  ready: false,
  reason: 'not_checked',
  keyId: '',
  provider: '',
  model: '',
};

function rememberEmbeddingReadiness(ready, key, reason = '') {
  embeddingReadiness = {
    checkedAtMs: Date.now(),
    ready: Boolean(ready),
    reason: ready ? null : String(reason || 'embedding_provider_unavailable').slice(0, 240),
    keyId: String(key?.id || ''),
    provider: String(key?.provider || ''),
    model: String(key?.embeddingModel || ''),
  };
}

function normalizeProviderEmbedding(values) {
  const vec = Array.isArray(values) ? values.map((v) => Number(v)) : [];
  if (vec.length !== OAA_EMBED_DIM) {
    throw new Error(`embedding dimension ${vec.length} does not match OAA_EMBED_DIM ${OAA_EMBED_DIM}`);
  }
  if (vec.some((v) => !Number.isFinite(v))) throw new Error('embedding contains non-finite values');
  return vec.map((v) => Number(v.toFixed(8)));
}

async function providerEmbedding(text, key, opts = {}) {
  const baseUrl = (key.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const started = Date.now();
  const requestId = randomUUID();
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
  let lastErrorCode = '';
  for (const reqBody of attempts) {
    let resp;
    try {
      resp = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(reqBody),
      });
    } catch {
      lastMsg = 'embedding provider network error';
      lastErrorCode = 'provider_network_error';
      continue;
    }
    const raw = await resp.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
    if (!resp.ok) {
      lastMsg = data?.error?.message || data?.message || `provider HTTP ${resp.status}`;
      lastErrorCode = `provider_http_${resp.status}`;
      continue;
    }
    let vector;
    try {
      vector = normalizeProviderEmbedding(data?.data?.[0]?.embedding);
    } catch (error) {
      lastMsg = error.message || 'invalid provider embedding';
      lastErrorCode = 'invalid_provider_embedding';
      continue;
    }
    const usage = normalizeProviderUsage(data?.usage);
    const latencyMs = Date.now() - started;
    const usageRecorded = await recordLlmUsageEvent({
      requestId,
      agentRunId: opts.agentRunId,
      providerRequestId: data?.id,
      actor: opts.actor,
      source: opts.source || 'oaa-embedding',
      sessionId: opts.sessionId,
      key,
      model: key.embeddingModel,
      operation: 'embedding',
      status: 'succeeded',
      usage,
      latencyMs,
    });
    rememberEmbeddingReadiness(true, key);
    return {
      vector,
      source: {
        mode: 'provider',
        keyId: key.id,
        provider: key.provider,
        model: key.embeddingModel,
        latencyMs,
        usage,
        usageRecorded,
      },
    };
  }
  await recordLlmUsageEvent({
    requestId,
    agentRunId: opts.agentRunId,
    actor: opts.actor,
    source: opts.source || 'oaa-embedding',
    sessionId: opts.sessionId,
    key,
    model: key.embeddingModel,
    operation: 'embedding',
    status: 'failed',
    usage: normalizeProviderUsage(null),
    latencyMs: Date.now() - started,
    errorCode: lastErrorCode || 'provider_error',
  });
  rememberEmbeddingReadiness(false, key, lastMsg || lastErrorCode || 'embedding provider failed');
  throw new Error(lastMsg || 'embedding provider failed');
}

async function embeddingVector(text, opts = {}) {
  // Documents remain browseable through PostgreSQL FTS when the external semantic provider is
  // absent. allowHashFallback is accepted only as a legacy caller name; the returned mode is
  // explicitly lexical and the vector is an inert zero placeholder.
  const allowLexicalFallback = OAA_ALLOW_HASH_EMBEDDINGS
    || opts.allowLexicalFallback === true
    || opts.allowHashFallback === true;
  const strict = Boolean(opts.strict) || (OAA_SUPABASE_MODE && !allowLexicalFallback);
  try {
    const key = await loadEmbeddingKey(opts.keyId || '');
    if (key) return await providerEmbedding(text, key, opts);
    if (strict) throw new Error('no enabled embedding key');
  } catch (e) {
    if (strict) throw e;
    console.warn('[oaa-embed] provider skipped:', e.message || e);
  }
  if (!allowLexicalFallback) {
    throw new Error('provider embedding is required; lexical fallback is disabled for this operation');
  }
  // Keep the document available to PostgreSQL full-text search without
  // manufacturing a vector that could be mistaken for semantic evidence.
  // Strict re-embedding replaces this lexical placeholder once a real
  // embedding provider is configured.
  return {
    vector: new Array(OAA_EMBED_DIM).fill(0),
    source: { mode: 'lexical', keyId: '', provider: 'postgresql', model: 'tsvector' },
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
        'OAA must answer questions about these perspectives from governed OpenSphere knowledge, not from provider model memory.'
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
        'OAA means OpenSphere AI Agent. It is implemented as a right-side Console chat panel plus the opensphere-console-oaa-gateway in the Console namespace.',
        'The gateway owns LLM key custody through Kubernetes Secrets, reads project knowledge from Supabase PostgreSQL, searches pgvector chunks, and injects selected context into the model request.',
        'The MVP does not require a separate vector database. Supabase PostgreSQL with pgvector is the authority for project knowledge, policy, and Console documentation RAG.'
      ].join('\n\n'),
    },
    {
      namespace: 'opensphere',
      sourceType: 'builtin',
      sourceId: 'platform-data-identity',
      title: 'Platform Data & Identity',
      version: '2026-07-04',
      metadata: { kind: 'platform-data-identity' },
      content: [
        'Supabase is the Console authority for identity, relational data, audit and object storage. Gitea is the authority for reviewed declarative changes and history.',
        'Supabase PostgreSQL with pgvector is the OAA knowledge authority; the gateway has no schema-migration ownership and uses its dedicated least-privileged role.',
        'Gitea provides code and Git-backed knowledge ingestion. HIS remains the authority for Prometheus-compatible observability rather than a Console-owned monitoring stack.'
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
  if (!pool) throw { code: 503, msg: 'Supabase PostgreSQL is not configured for OAA knowledge' };
  const namespace = String(doc.namespace || 'opensphere').trim() || 'opensphere';
  const sourceType = String(doc.sourceType || doc.source_type || 'manual').trim() || 'manual';
  const sourceId = String(doc.sourceId || doc.source_id || '').trim();
  const title = String(doc.title || sourceId || 'Untitled').trim();
  const content = String(doc.content || '').trim();
  if (!sourceId) throw { code: 400, msg: 'sourceId required' };
  if (!content) throw { code: 400, msg: 'content required' };
  const metadata = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
  const version = doc.version ? String(doc.version) : null;
  const status = String(doc.status || metadata.status || 'active');
  const authorityTier = Math.max(0, Math.min(4, Number(doc.authorityTier ?? metadata.authorityTier ?? 3) || 3));
  const acl = (doc.acl && typeof doc.acl === 'object') ? doc.acl
    : ((metadata.acl && typeof metadata.acl === 'object') ? metadata.acl : { visibility: 'authenticated' });
  const contentHash = createHash('sha256').update(content).digest('hex');
  const chunks = chunkText(content);
  const existing = await pool.query(`
    SELECT d.id, d.content_hash,
      (SELECT count(*)::int FROM oaa_knowledge_chunks c
       WHERE c.document_id = d.id AND c.active AND c.document_revision = d.content_hash) AS active_chunks,
      (SELECT c.metadata->'embedding' FROM oaa_knowledge_chunks c
       WHERE c.document_id = d.id AND c.active AND c.document_revision = d.content_hash
       ORDER BY c.chunk_index LIMIT 1) AS embedding
    FROM oaa_knowledge_documents d
    WHERE d.namespace = $1 AND d.source_type = $2 AND d.source_id = $3
    LIMIT 1
  `, [namespace, sourceType, sourceId]);
  if (existing.rows[0]?.content_hash === contentHash && Number(existing.rows[0]?.active_chunks || 0) === chunks.length) {
    await pool.query(`
      UPDATE oaa_knowledge_documents
      SET title = $4, version = $5, metadata = $6::jsonb, status = $7,
          authority_tier = $8, acl = $9::jsonb, updated_at = now()
      WHERE namespace = $1 AND source_type = $2 AND source_id = $3
    `, [namespace, sourceType, sourceId, title, version, JSON.stringify(metadata), status, authorityTier, JSON.stringify(acl)]);
    const retained = existing.rows[0].embedding && typeof existing.rows[0].embedding === 'object'
      ? existing.rows[0].embedding : { mode: 'lexical', provider: 'postgresql', model: 'tsvector' };
    audit(actor, 'knowledge-upsert', `${namespace}/${sourceType}/${sourceId}`, 'ok', `${chunks.length} chunks / ${retained.mode || 'retained'} / unchanged`);
    return {
      id: existing.rows[0].id,
      chunks: chunks.length,
      contentHash,
      embeddingMode: retained.mode || 'retained',
      embeddingProvider: retained.provider || '',
      embeddingModel: retained.model || '',
    };
  }

  const preparedChunks = [];
  let embeddingMode = 'lexical';
  let embeddingProvider = 'postgresql';
  let embeddingModel = 'tsvector';
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const embedding = await embeddingVector(`${title}\n${chunk}`, {
      keyId: doc.embeddingKeyId || '',
      strict: doc.strictEmbedding === true,
      allowHashFallback: doc.allowHashFallback === true,
    });
    embeddingMode = embedding.source.mode;
    embeddingProvider = embedding.source.provider;
    embeddingModel = embedding.source.model;
    preparedChunks.push({
      index: i,
      content: chunk,
      vector: vectorLiteral(embedding.vector),
      metadata: { title, namespace, sourceType, sourceId, embedding: embedding.source, ...metadata },
    });
  }

  const id = randomUUID();
  const client = await pool.connect();
  let docId;
  try {
    await client.query('BEGIN');
    const upsert = OAA_SUPABASE_MODE
    ? await client.query(`
      INSERT INTO oaa_knowledge_documents (id, namespace, source_type, source_id, title, version, metadata, content_hash, status, authority_tier, acl)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb)
      ON CONFLICT (namespace, source_type, source_id)
      DO UPDATE SET title = EXCLUDED.title, version = EXCLUDED.version, metadata = EXCLUDED.metadata,
        content_hash = EXCLUDED.content_hash, status = EXCLUDED.status, authority_tier = EXCLUDED.authority_tier,
        acl = EXCLUDED.acl, updated_at = now()
      RETURNING id, content_hash
    `, [id, namespace, sourceType, sourceId, title, version, JSON.stringify(metadata), contentHash, status, authorityTier, JSON.stringify(acl)])
    : await client.query(`
      INSERT INTO oaa_knowledge_documents (id, namespace, source_type, source_id, title, version, metadata, content_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      ON CONFLICT (namespace, source_type, source_id)
      DO UPDATE SET title = EXCLUDED.title, version = EXCLUDED.version, metadata = EXCLUDED.metadata,
        content_hash = EXCLUDED.content_hash, updated_at = now()
      RETURNING id, content_hash
    `, [id, namespace, sourceType, sourceId, title, version, JSON.stringify(metadata), contentHash]);
    docId = upsert.rows[0].id;
    for (const chunk of preparedChunks) {
      await client.query(`
        INSERT INTO oaa_knowledge_chunks
          (id, document_id, document_revision, active, chunk_index, content, embedding, metadata)
        VALUES ($1, $2, $3, true, $4, $5, $6::vector, $7::jsonb)
        ON CONFLICT (document_id, document_revision, chunk_index)
        DO UPDATE SET active = true
      `, [randomUUID(), docId, contentHash, chunk.index, chunk.content, chunk.vector, JSON.stringify(chunk.metadata)]);
    }
    await client.query(`
      UPDATE oaa_knowledge_chunks
      SET active = (document_revision = $2)
      WHERE document_id = $1 AND active IS DISTINCT FROM (document_revision = $2)
    `, [docId, contentHash]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
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
  if (!pool) throw { code: 503, msg: 'Supabase PostgreSQL is not configured for OAA knowledge' };
  const [counts, modes, manualSources, keys] = await Promise.all([
    pool.query(`
    SELECT
      (SELECT count(*)::int FROM oaa_knowledge_documents) AS documents,
      (SELECT count(*)::int FROM oaa_knowledge_chunks WHERE active) AS chunks,
      (SELECT count(*)::int FROM oaa_knowledge_documents WHERE source_type = 'manual') AS "manualDocuments",
      (
        SELECT count(*)::int
        FROM oaa_knowledge_chunks c
        JOIN oaa_knowledge_documents d ON d.id = c.document_id
        WHERE d.source_type = 'manual' AND c.active
      ) AS "manualChunks",
      (SELECT count(*)::int FROM oaa_manual_concepts) AS "manualConcepts",
      (SELECT count(*)::int FROM oaa_manual_relations) AS "manualRelations"
    `),
    pool.query(`
      SELECT COALESCE(metadata->'embedding'->>'mode', 'unknown') AS mode, count(*)::int AS chunks
      FROM oaa_knowledge_chunks
      WHERE active
      GROUP BY 1
      ORDER BY 1
    `),
    pool.query(`
      SELECT COALESCE(d.metadata->'source'->>'id', d.source_id) AS source, count(DISTINCT d.id)::int AS documents, count(c.id)::int AS chunks
      FROM oaa_knowledge_documents d
      LEFT JOIN oaa_knowledge_chunks c ON c.document_id = d.id AND c.active
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
    validationStatus: k.validationStatus,
    validationMessage: k.validationMessage,
    validatedAt: k.validatedAt,
  }));
  const semanticSearch = await checkEmbeddingReadiness(false).catch(() => ({
    ready: false, reason: 'embedding_readiness_check_failed', keyId: '', provider: '', model: '', checkedAt: null,
  }));
  return {
    enabled: OAA_RAG_ENABLED,
    embedDim: OAA_EMBED_DIM,
    manualSeedPath: OAA_MANUAL_SEED_PATH,
    ...counts.rows[0],
    manualSources: manualSources.rows,
    embeddingModes: modes.rows,
    embeddingKeys,
    lexicalSearchReady: true,
    semanticSearch,
  };
}

async function searchKnowledge(query, limit = OAA_RAG_TOP_K, actor = null, usageContext = {}) {
  if (!OAA_RAG_ENABLED || !String(query || '').trim()) return [];
  assertPermission(actor, 'oaa.knowledge.read');
  const pool = getPgPool();
  if (!pool) return [];
  await seedBuiltinKnowledge();
  let embedding = null;
  try {
    embedding = await embeddingVector(query, {
      actor,
      source: usageContext.source || 'knowledge-search',
      sessionId: usageContext.sessionId || '',
      agentRunId: usageContext.runId || null,
    });
  } catch (error) {
    console.warn('[oaa-rag] semantic search degraded to PostgreSQL full-text:', error.message || error);
  }
  const r = embedding ? await pool.query(`
    SELECT
      d.id AS "documentId",
      c.id AS "chunkId",
      d.title,
      d.source_type AS "sourceType",
      d.source_id AS "sourceId",
      c.chunk_index AS "chunkIndex",
      c.document_revision AS "documentRevision",
      c.content,
      c.metadata,
      1 - (c.embedding <=> $1::vector) AS score
    FROM oaa_knowledge_chunks c
    JOIN oaa_knowledge_documents d ON d.id = c.document_id
    WHERE c.active AND d.status = 'active'
    ${knowledgeAclSql(1)}
    ORDER BY c.embedding <=> $1::vector
    LIMIT $6
  `, [vectorLiteral(embedding.vector), ...knowledgeAclParams(actor), limit]) : await pool.query(`
    SELECT
      d.id AS "documentId",
      c.id AS "chunkId",
      d.title,
      d.source_type AS "sourceType",
      d.source_id AS "sourceId",
      c.chunk_index AS "chunkIndex",
      c.document_revision AS "documentRevision",
      c.content,
      c.metadata,
      (
        ts_rank_cd(c.search_vector, plainto_tsquery('simple', $1))
        + CASE WHEN d.title ILIKE ('%' || $1 || '%') THEN 0.4 ELSE 0 END
        + CASE WHEN c.content ILIKE ('%' || $1 || '%') THEN 0.2 ELSE 0 END
      )::double precision AS score
    FROM oaa_knowledge_chunks c
    JOIN oaa_knowledge_documents d ON d.id = c.document_id
    WHERE c.active AND d.status = 'active'
      ${knowledgeAclSql(1)}
      AND (
        c.search_vector @@ plainto_tsquery('simple', $1)
        OR d.title ILIKE ('%' || $1 || '%')
        OR c.content ILIKE ('%' || $1 || '%')
      )
    ORDER BY score DESC, d.authority_tier ASC, d.updated_at DESC
    LIMIT $6
  `, [String(query).trim(), ...knowledgeAclParams(actor), limit]);
  const hits = r.rows.map((x) => {
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
      queryEmbedding: embedding?.source || { mode: 'lexical', provider: 'postgresql', model: 'tsvector' },
    };
  });
  await recordRetrievalTrace(actor, query, hits, usageContext.runId || null);
  return hits;
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

let manualSeedReady = false;
let manualSeedInflight = null;

async function ensureManualRegistryReady() {
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) throw { code: 503, msg: 'Supabase PostgreSQL is not configured for Manual Registry' };
  if (!manualSeedReady) {
    manualSeedInflight ||= reconcileBundledManualKnowledge()
      .then((out) => {
        manualSeedReady = true;
        return out;
      })
      .finally(() => {
        manualSeedInflight = null;
      });
    await manualSeedInflight;
  }
  return pool;
}

async function listManualSources(actor = null) {
  assertPermission(actor, 'oaa.knowledge.read');
  const pool = await ensureManualRegistryReady();
  const r = await pool.query(`
    SELECT
      COALESCE(metadata->'source'->>'id', source_id) AS id,
      COALESCE(metadata->'source'->>'type', 'manual') AS type,
      COALESCE(metadata->'source'->>'name', metadata->'source'->>'id', source_id) AS name,
      MIN(COALESCE((metadata->>'authorityTier')::int, 4)) AS "authorityTier",
      count(*)::int AS documents,
      max(updated_at) AS "updatedAt"
    FROM oaa_knowledge_documents d
    WHERE source_type = 'manual' AND status = 'active'
    ${knowledgeAclSql(0)}
    GROUP BY 1, 2, 3
    ORDER BY "authorityTier" ASC, name
  `, knowledgeAclParams(actor));
  return {
    schema: 'manual-sources.opensphere.io/v1alpha1',
    generatedAt: new Date().toISOString(),
    items: r.rows,
  };
}

async function listManualDocuments(options = {}, actor = null) {
  assertPermission(actor, 'oaa.knowledge.read');
  const pool = await ensureManualRegistryReady();
  const q = String(options.q || '').trim();
  const source = String(options.source || '').trim();
  const limit = Math.max(1, Math.min(100, Number(options.limit || 40) || 40));
  const params = [...knowledgeAclParams(actor), limit];
  const where = ["d.source_type = 'manual'", "d.status = 'active'", knowledgeAclSql(0).replace(/^\s*AND\s*/m, '')];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(
      d.title ILIKE $${params.length}
      OR d.source_id ILIKE $${params.length}
      OR d.metadata::text ILIKE $${params.length}
      OR EXISTS (
        SELECT 1 FROM oaa_knowledge_chunks cx
        WHERE cx.document_id = d.id AND cx.active AND cx.content ILIKE $${params.length}
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
    LEFT JOIN oaa_knowledge_chunks c ON c.document_id = d.id AND c.active
    WHERE ${where.join(' AND ')}
    GROUP BY d.id
    ORDER BY COALESCE((d.metadata->>'authorityTier')::int, 4), d.title
    LIMIT $5
  `, params);
  return {
    schema: 'manual-documents.opensphere.io/v1alpha1',
    generatedAt: new Date().toISOString(),
    query: q,
    source,
    items: r.rows.map(manualDocFromRow),
  };
}

async function getManualDocument(sourceId, actor = null) {
  assertPermission(actor, 'oaa.knowledge.read');
  const pool = await ensureManualRegistryReady();
  const sid = String(sourceId || '').trim();
  if (!sid) throw { code: 400, msg: 'sourceId required' };
  const doc = await pool.query(`
    SELECT d.id, d.namespace, d.source_type AS "sourceType", d.source_id AS "sourceId",
           d.title, d.version, d.metadata, d.updated_at AS "updatedAt",
           count(c.id)::int AS "chunkCount",
           left(string_agg(c.content, ' ' ORDER BY c.chunk_index), 360) AS summary
    FROM oaa_knowledge_documents d
    LEFT JOIN oaa_knowledge_chunks c ON c.document_id = d.id AND c.active
    WHERE d.source_type = 'manual' AND d.status = 'active' AND d.source_id = $1
    ${knowledgeAclSql(1)}
    GROUP BY d.id
    LIMIT 1
  `, [sid, ...knowledgeAclParams(actor)]);
  if (!doc.rows.length) throw { code: 404, msg: 'manual document not found' };
  const chunks = await pool.query(`
    SELECT chunk_index AS "chunkIndex", content, metadata
    FROM oaa_knowledge_chunks
    WHERE document_id = $1 AND active
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

async function searchManualRegistry(query, limit = 8, actor = null) {
  const q = String(query || '').trim();
  if (!q) return { schema: 'manual-search.opensphere.io/v1alpha1', query: q, items: [] };
  assertPermission(actor, 'oaa.knowledge.read');
  const pool = await ensureManualRegistryReady();
  // Manual search remains available through PostgreSQL full-text while a
  // semantic embedding provider is unavailable.
  const embedding = await embeddingVector(q, { allowHashFallback: true });
  const n = Math.max(1, Math.min(25, Number(limit || 8) || 8));
  const r = embedding.source.mode === 'provider' ? await pool.query(`
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
    WHERE c.active AND d.source_type = 'manual' AND d.status = 'active'
    ${knowledgeAclSql(1)}
    ORDER BY c.embedding <=> $1::vector
    LIMIT $6
  `, [vectorLiteral(embedding.vector), ...knowledgeAclParams(actor), n]) : await pool.query(`
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
      (
        ts_rank_cd(c.search_vector, plainto_tsquery('simple', $1))
        + CASE WHEN d.title ILIKE ('%' || $1 || '%') THEN 0.4 ELSE 0 END
        + CASE WHEN c.content ILIKE ('%' || $1 || '%') THEN 0.2 ELSE 0 END
      )::double precision AS score
    FROM oaa_knowledge_chunks c
    JOIN oaa_knowledge_documents d ON d.id = c.document_id
    WHERE c.active AND d.source_type = 'manual' AND d.status = 'active'
      ${knowledgeAclSql(1)}
      AND (
        c.search_vector @@ plainto_tsquery('simple', $1)
        OR d.title ILIKE ('%' || $1 || '%')
        OR c.content ILIKE ('%' || $1 || '%')
      )
    ORDER BY score DESC, d.authority_tier ASC, d.updated_at DESC
    LIMIT $6
  `, [q, ...knowledgeAclParams(actor), n]);
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

async function listManualConceptGraph(query = '', limit = 64, actor = null) {
  assertPermission(actor, 'oaa.knowledge.read');
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
  if (!pool) throw { code: 503, msg: 'Supabase PostgreSQL is not configured for OAA knowledge' };
  const keyId = String(body.keyId || '').trim();
  const strict = body.strict !== false;
  const rows = await pool.query(`
    SELECT c.id, c.content, c.metadata, d.title
    FROM oaa_knowledge_chunks c
    JOIN oaa_knowledge_documents d ON d.id = c.document_id
    WHERE c.active
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
  if (!pool) throw { code: 503, msg: 'Supabase PostgreSQL is not configured for OAA concepts' };
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
      ...seedOwnershipMetadata(raw, defaults.sourceId, 'manual-concept.opensphere.io/v1alpha1'),
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
  if (!pool) throw { code: 503, msg: 'Supabase PostgreSQL is not configured for OAA relations' };
  const items = [];
  for (const raw of relations) {
    if (!raw || typeof raw !== 'object') continue;
    const fromId = String(raw.fromId || raw.from_id || '').trim();
    const toId = String(raw.toId || raw.to_id || '').trim();
    const relation = String(raw.relation || '').trim();
    if (!fromId || !toId || !relation) throw { code: 400, msg: 'manual relation fromId, toId, relation required' };
    const id = relationId(raw);
    const metadata = compactObject({
      ...(raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}),
      ...seedOwnershipMetadata(raw, defaults.sourceId, 'manual-relation.opensphere.io/v1alpha1'),
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

async function upsertManualSeedManifest(body = {}, actor = null, options = { allowHashFallback: true }) {
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
      allowHashFallback: options.allowHashFallback !== false,
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
  const out = await upsertManualSeedManifest(manifest, actor, { allowHashFallback: true });
  audit(actor, 'knowledge-bundled-manual-seed', OAA_MANUAL_SEED_PATH, 'ok', `${out.documents} documents / ${out.chunks} chunks`);
  return { ...out, bundled: true, seedPath: OAA_MANUAL_SEED_PATH, version: manifest.version || null };
}

async function reconcileBundledManualKnowledge(actor = null) {
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
    SELECT d.source_id, d.metadata->>'checksum' AS checksum,
      EXISTS (
        SELECT 1 FROM oaa_knowledge_chunks c
        WHERE c.document_id = d.id AND c.active AND c.document_revision = d.content_hash
      ) AS revision_aligned
    FROM oaa_knowledge_documents d
    WHERE source_type = 'manual'
      AND metadata->'source'->>'id' = 'opensphere-core-manuals'
  `);
  const [currentConcepts, currentRelations] = await Promise.all([
    pool.query(`
      SELECT id, metadata->>'seedChecksum' AS "seedChecksum"
      FROM oaa_manual_concepts
      WHERE metadata->>'seedSourceId' = $1 AND status <> 'retired'
    `, ['opensphere-core-manuals']),
    pool.query(`
      SELECT id, metadata->>'seedChecksum' AS "seedChecksum"
      FROM oaa_manual_relations
      WHERE metadata->>'seedSourceId' = $1
    `, ['opensphere-core-manuals']),
  ]);
  const bySourceId = new Map(current.rows.map((r) => [r.source_id, {
    checksum: r.checksum || '',
    revisionAligned: r.revision_aligned === true,
  }]));
  const manifestSourceIds = docs.map((d) => String(d.sourceId || d.source_id || '')).filter(Boolean);
  const manifestSourceIdSet = new Set(manifestSourceIds);
  const missing = docs.filter((d) => !bySourceId.has(String(d.sourceId || d.source_id || ''))).map((d) => d.sourceId || d.source_id);
  const changed = docs
    .filter((d) => {
      const id = String(d.sourceId || d.source_id || '');
      const checksum = String(d.checksum || '');
      const currentDoc = bySourceId.get(id);
      return id && currentDoc && ((!checksum || currentDoc.checksum !== checksum) || !currentDoc.revisionAligned);
    })
    .map((d) => d.sourceId || d.source_id);
  // Bundled manuals are release-bound and declarative. Removed documents are retired instead of
  // deleted so append-only retrieval evidence keeps stable document and chunk references.
  const stale = current.rows.map((r) => r.source_id).filter((id) => !manifestSourceIdSet.has(String(id || '')));
  const structure = manualSeedStructureDiff(manifest, {
    concepts: currentConcepts.rows,
    relations: currentRelations.rows,
  });
  if (!missing.length && !changed.length && !stale.length && !structure.needsReconcile && current.rows.length >= docs.length) {
    return { seeded: false, reason: 'bundled manuals up to date', documents: current.rows.length };
  }
  const out = await seedBundledManualKnowledge(actor);
  if (stale.length) {
    await pool.query(`
      DELETE FROM oaa_manual_relations
      WHERE source_id = ANY($1::text[])
    `, [stale]);
    await pool.query(`
      UPDATE oaa_knowledge_documents
      SET status = 'retired', updated_at = now()
      WHERE source_type = 'manual'
        AND metadata->'source'->>'id' = 'opensphere-core-manuals'
        AND source_id = ANY($1::text[])
    `, [stale]);
    await pool.query(`
      UPDATE oaa_knowledge_chunks c
      SET active = false
      FROM oaa_knowledge_documents d
      WHERE c.document_id = d.id
        AND d.source_type = 'manual'
        AND d.metadata->'source'->>'id' = 'opensphere-core-manuals'
        AND d.source_id = ANY($1::text[])
        AND c.active
    `, [stale]);
    audit(actor, 'knowledge-bundled-manual-retire', 'opensphere-core-manuals', 'ok', stale.join(', '));
  }
  if (structure.concepts.stale.length) {
    await pool.query(`
      UPDATE oaa_manual_concepts
      SET status = 'retired', updated_at = now()
      WHERE metadata->>'seedSourceId' = $1 AND id = ANY($2::text[])
    `, ['opensphere-core-manuals', structure.concepts.stale]);
    audit(actor, 'knowledge-bundled-concept-retire', 'opensphere-core-manuals', 'ok', structure.concepts.stale.join(', '));
  }
  if (structure.relations.stale.length) {
    await pool.query(`
      DELETE FROM oaa_manual_relations
      WHERE metadata->>'seedSourceId' = $1 AND id = ANY($2::text[])
    `, ['opensphere-core-manuals', structure.relations.stale]);
    audit(actor, 'knowledge-bundled-relation-prune', 'opensphere-core-manuals', 'ok', structure.relations.stale.join(', '));
  }
  return { ...out, seeded: true, missing, changed, stale, structure };
}

function hasPermission(actor, permission) {
  return Boolean(actor?.groups?.includes(CONSOLE_ADMIN_GROUP) || actor?.permissions?.includes(permission));
}

function assertPermission(actor, permission) {
  if (!hasPermission(actor, permission)) throw { code: 403, msg: `requires ${permission}` };
}

function knowledgeAclParams(actor) {
  return [
    actor?.subject || '',
    Array.isArray(actor?.groups) ? actor.groups : [],
    Array.isArray(actor?.permissions) ? actor.permissions : [],
    Boolean(actor?.groups?.includes(CONSOLE_ADMIN_GROUP)),
  ];
}

// ACL is applied in SQL before ranking.  `authenticated` is the explicit
// baseline assigned to migrated non-sensitive manuals; restricted documents
// must name users, groups, or permissions in metadata.acl.
function knowledgeAclSql(parameterOffset = 0) {
  const subject = parameterOffset + 1;
  const groups = parameterOffset + 2;
  const permissions = parameterOffset + 3;
  const administrator = parameterOffset + 4;
  return `
  AND (
    $${administrator}::boolean
    OR COALESCE(d.acl->>'visibility', d.metadata->'acl'->>'visibility', 'authenticated') IN ('public', 'authenticated')
    OR COALESCE(d.acl->'users', d.metadata->'acl'->'users', '[]'::jsonb) ? $${subject}
    OR COALESCE(d.acl->'groups', d.metadata->'acl'->'groups', '[]'::jsonb) ?| $${groups}::text[]
    OR COALESCE(d.acl->'permissions', d.metadata->'acl'->'permissions', '[]'::jsonb) ?| $${permissions}::text[]
  )
`;
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

function requireMutationNamespace(ns) {
  const value = String(ns || '').trim();
  if (!K8S_NAME_RE.test(value) || !OAA_MUTATION_NAMESPACES.includes(value)) throw { code: 400, msg: 'namespace is not allowed for OAA mutations' };
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

// Server-side nonempty mutation reason validator (CONSTITUTION-0004 §4.2/§4.4). Every write
// execution path must be given a real, caller-supplied, nonempty human reason before mutation.
// This never synthesizes a fallback reason (e.g. 'binding <id>' or a canned string) on the
// caller's behalf — an empty/whitespace-only reason fails closed with a stable machine-readable
// error code the UI/tooling can branch on.
function requireMutationReason(reason) {
  const trimmed = String(reason ?? '').trim();
  if (!trimmed) {
    throw { code: 400, msg: 'a nonempty reason is required for this write action', errorCode: 'mutation_reason_required' };
  }
  return trimmed;
}

// Fail-closed mutation gate (CONSTITUTION-0004 §4.2). Every write-capable tool/binding/HTTP path
// must call this before performing any Kubernetes mutation, with no bypass. Audits the block.
function assertMutationEnabled(actor, target = 'oaa-mutation') {
  // The Gateway is a planner/read broker, never a Kubernetes write principal.
  // Keep the old endpoints fail-closed even if a stale deployment accidentally
  // flips OAA_MUTATION_ENABLED; controlled changes must enter Console Backend's
  // policy/approval/Gitea reconciliation path instead.
  audit(actor, 'mutation-gate-block', target, 'blocked', 'oaa_direct_mutation_removed_use_console_backend');
  throw {
    code: 403,
    msg: 'OAA does not directly mutate Kubernetes. Submit this action through the Console Backend control plane.',
    errorCode: 'oaa_direct_mutation_removed_use_console_backend',
  };
}

// Filters control-plane submission capabilities while the Console Backend
// submission boundary is closed.  `mutationEnabled` is retained as the UI
// compatibility field, but means "controlled action submission" — never a
// Gateway Kubernetes write permission.
function withMutationGate(toolManifest) {
  const mutationEnabled = OAA_ACTION_SUBMISSION_ENABLED;
  const tools = mutationEnabled
    ? (toolManifest.tools || [])
    : (toolManifest.tools || []).filter((t) => t && t.readOnly === true);
  return {
    ...toolManifest,
    mutationEnabled,
    mutationGateReason: mutationEnabled ? null : 'console_backend_action_submission_disabled',
    tools,
  };
}

// Filters an action-binding manifest so any binding whose risk is not 'read', or whose referenced
// tool is not read-only, is removed while controlled action submission is closed.
// `toolManifest` should already be the raw (unfiltered) tool manifest so the tool's readOnly flag
// can be resolved.
function withActionBindingMutationGate(bindingManifest, toolManifest) {
  const mutationEnabled = OAA_ACTION_SUBMISSION_ENABLED;
  if (mutationEnabled) {
    return { ...bindingManifest, mutationEnabled: true, mutationGateReason: null };
  }
  const toolReadOnly = new Map((toolManifest.tools || []).map((t) => [t.id, t.readOnly === true]));
  const bindings = (bindingManifest.bindings || []).filter((b) => {
    if (!b || b.riskLevel !== 'read') return false;
    // Fail closed: only retain a binding when its referenced tool is known AND explicitly
    // readOnly === true. An unknown/missing tool (absent from the raw tool manifest) must never
    // be treated as safe just because Map#get() returns undefined instead of false.
    return toolReadOnly.get(b.toolId) === true;
  });
  return {
    ...bindingManifest,
    mutationEnabled: false,
    mutationGateReason: 'console_backend_action_submission_disabled',
    bindings,
    invalidBindings: bindings.filter((b) => !b.valid).map((b) => ({ id: b.id, toolId: b.toolId })),
  };
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
  assertMutationEnabled(actor, 'k8s-restart-deployment');
  const ns = requireMutationNamespace(body.namespace);
  const name = requireK8sName(body.name || body.deployment, 'deployment');
  requireConfirm(body.confirm, `restart deployment ${ns}/${name}`);
  const reason = requireMutationReason(body.reason);
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
  audit(actor, 'k8s-restart-deployment', `${ns}/${name}`, 'ok', reason);
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
  assertMutationEnabled(actor, 'k8s-scale-deployment');
  const ns = requireMutationNamespace(body.namespace);
  const name = requireK8sName(body.name || body.deployment, 'deployment');
  const replicas = Number(body.replicas);
  if (!Number.isInteger(replicas) || replicas < 0 || replicas > OAA_SCALE_MAX) throw { code: 400, msg: `replicas must be an integer between 0 and ${OAA_SCALE_MAX}` };
  requireConfirm(body.confirm, `scale deployment ${ns}/${name} to ${replicas}`);
  const reason = requireMutationReason(body.reason);
  const before = await getDeployment(ns, name);
  const r = await k8s('PATCH', `/apis/apps/v1/namespaces/${ns}/deployments/${name}`, { spec: { replicas } });
  if (!r.ok) throw { code: 502, msg: `deployment scale patch HTTP ${r.status}` };
  audit(actor, 'k8s-scale-deployment', `${ns}/${name}`, 'ok', `replicas ${before.spec?.replicas ?? ''} -> ${replicas}; ${reason}`);
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

function resourceNamespace(kind, namespace, requireNamespaced = true) {
  const definition = resourceDefinition(kind);
  if (!definition.namespaced) return { definition, namespace: '' };
  if (!requireNamespaced && !namespace) return { definition, namespace: '' };
  return { definition, namespace: requireAllowedNamespace(namespace) };
}

async function listKubernetesResources(body = {}, actor = null) {
  const { definition, namespace } = resourceNamespace(body.kind, body.namespace);
  const limit = Math.max(1, Math.min(500, Number(body.limit || 200) || 200));
  const query = { limit };
  if (body.labelSelector) query.labelSelector = String(body.labelSelector).slice(0, 500);
  const response = await k8sGet(kubernetesResourcePath(definition.key, namespace, '', query));
  if (!response.ok) throw { code: response.status === 403 ? 403 : 502, msg: `${definition.kind} list failed: ${response.error}` };
  let items = response.items || [];
  if (definition.key === 'namespace') items = items.filter((item) => OAA_ENV_NAMESPACES.includes(item.metadata?.name || ''));
  const resources = items.map((item) => sanitizeKubernetesObject(definition.key, item));
  audit(actor, 'k8s-list-resources', `${definition.kind}/${namespace || 'cluster'}`, 'ok', `${resources.length} resources`);
  return {
    action: 'list-kubernetes-resources', kind: definition.kind, namespace: namespace || null,
    count: resources.length, continue: response.json?.metadata?.continue || null, resources,
  };
}

async function getKubernetesResource(body = {}, actor = null) {
  const { definition, namespace } = resourceNamespace(body.kind, body.namespace);
  const name = requireK8sName(body.name, 'resource name');
  if (definition.key === 'namespace' && !OAA_ENV_NAMESPACES.includes(name)) throw { code: 403, msg: 'namespace is outside the OAA allowlist' };
  const response = await k8s('GET', kubernetesResourcePath(definition.key, namespace, name));
  if (response.status === 404) throw { code: 404, msg: `${definition.kind} not found` };
  if (!response.ok) throw { code: response.status === 403 ? 403 : 502, msg: `${definition.kind} read HTTP ${response.status}` };
  const resource = sanitizeKubernetesObject(definition.key, response.json || {});
  const events = definition.namespaced ? await objectEvents(namespace, definition.kind, name) : [];
  audit(actor, 'k8s-get-resource', `${definition.kind}/${namespace || 'cluster'}/${name}`, 'ok', '');
  return { action: 'get-kubernetes-resource', resource, health: projectedResourceHealth(resource), events };
}

let runtimeProjectionSupported = null;
let runtimeWatchSchemaSupported = null;
let runtimeProjectionWarningLogged = false;
let runtimeRefreshInFlight = false;
let runtimeWatchStopping = false;
const runtimeWatchControllers = new Set();
const runtimeWatchState = new Map();
let runtimeWatchHeartbeatTimer = null;
let runtimeWatchHeartbeatInFlight = false;

function projectedHealth(item) {
  if (item.kind === 'Pod') return item.payload.phase === 'Running' && !item.payload.reason ? 'Ready' : 'NotReady';
  if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(item.kind)) {
    return Number(item.payload.ready || 0) >= Number(item.payload.desired || 0) ? 'Ready' : 'Degraded';
  }
  if (item.kind === 'NamespaceSnapshot') return Number(item.payload.counts?.unhealthyPods || 0) > 0 ? 'Degraded' : 'Ready';
  return 'Unknown';
}

function runtimeKey(kind, namespace = '') {
  return `${kind}:${namespace || 'cluster'}`;
}

function runtimeProjectionRow(resource) {
  return {
    kind: resource.kind,
    namespace: resource.metadata?.namespace || '',
    name: resource.metadata?.name || '',
    resourceVersion: resource.metadata?.resourceVersion || null,
    health: projectedResourceHealth(resource),
    payload: resource,
  };
}

async function mapLimit(items, concurrency, worker) {
  const queue = [...items];
  const results = [];
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      results.push(await worker(item));
    }
  });
  await Promise.all(runners);
  return results;
}

async function collectRuntimeInventory() {
  const tasks = [];
  for (const kind of RUNTIME_RESOURCE_KINDS) {
    const definition = resourceDefinition(kind);
    if (definition.namespaced) {
      for (const namespace of OAA_ENV_NAMESPACES) tasks.push({ kind, namespace });
    } else {
      tasks.push({ kind, namespace: '' });
    }
  }
  const batches = await mapLimit(tasks, 8, async ({ kind, namespace }) => {
    const definition = resourceDefinition(kind);
    const response = await k8sGet(kubernetesResourcePath(kind, namespace, '', { limit: 500 }));
    if (!response.ok) return { kind, namespace, ok: false, error: response.error, rows: [] };
    let items = response.items || [];
    if (definition.key === 'namespace') items = items.filter((item) => OAA_ENV_NAMESPACES.includes(item.metadata?.name || ''));
    return { kind, namespace, ok: true, rows: items.map((item) => runtimeProjectionRow(sanitizeKubernetesObject(kind, item))) };
  });
  return {
    observedAt: new Date().toISOString(),
    rows: batches.flatMap((batch) => batch.rows),
    access: batches.map(({ kind, namespace, ok, error, rows }) => ({ kind, namespace: namespace || null, ok, count: rows.length, error: error || null })),
  };
}

async function ensureRuntimeWatchSchema(pool) {
  if (runtimeWatchSchemaSupported != null) return runtimeWatchSchemaSupported;
  const check = await pool.query(`
    SELECT to_regclass('oaa.runtime_event') AS event_table,
           to_regclass('oaa.watch_cursor') AS cursor_table,
           EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'oaa' AND table_name = 'watch_cursor' AND column_name = 'observer_id'
           ) AS observer_column
  `);
  runtimeWatchSchemaSupported = Boolean(check.rows[0]?.event_table && check.rows[0]?.cursor_table && check.rows[0]?.observer_column);
  return runtimeWatchSchemaSupported;
}

async function projectRuntimeInventory(inventory) {
  const pool = getPgPool();
  if (!pool) return false;
  if (runtimeProjectionSupported == null) {
    const check = await pool.query("SELECT to_regclass('oaa.runtime_resource') AS table_name");
    runtimeProjectionSupported = Boolean(check.rows[0]?.table_name);
  }
  if (!runtimeProjectionSupported) return false;
  const observedAt = inventory.observedAt || new Date().toISOString();
  const expiresAt = new Date(Date.parse(observedAt) + OAA_RUNTIME_REFRESH_MS * 3).toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of inventory.rows || []) {
      if (!item.name) continue;
      await client.query(`
        INSERT INTO runtime_resource (source, kind, namespace, name, resource_version, health, payload, observed_at, expires_at)
        VALUES ('kubernetes', $1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        ON CONFLICT (source, kind, namespace, name) DO UPDATE SET
          resource_version = EXCLUDED.resource_version, health = EXCLUDED.health, payload = EXCLUDED.payload,
          observed_at = EXCLUDED.observed_at, expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp()
      `, [item.kind, item.namespace, item.name, item.resourceVersion, item.health, JSON.stringify(item.payload || {}), observedAt, expiresAt]);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function projectRuntimeSnapshot(snapshot) {
  const pool = getPgPool();
  if (!pool) return false;
  try {
    if (runtimeProjectionSupported == null) {
      const check = await pool.query("SELECT to_regclass('oaa.runtime_resource') AS table_name");
      runtimeProjectionSupported = Boolean(check.rows[0]?.table_name);
    }
    if (!runtimeProjectionSupported) return false;
    const observedAt = snapshot.time || new Date().toISOString();
    const expiresAt = new Date(Date.parse(observedAt) + OAA_RUNTIME_REFRESH_MS * 3).toISOString();
    const rows = [{ kind: 'ClusterSummary', namespace: '', name: 'cluster', payload: snapshot.cluster }];
    for (const ns of snapshot.namespaces || []) {
      rows.push({ kind: 'NamespaceSnapshot', namespace: ns.namespace, name: ns.namespace, payload: { access: ns.access, counts: ns.counts, recentEvents: ns.recentEvents } });
      for (const workload of ns.workloads || []) rows.push({ kind: workload.kind || 'Workload', namespace: ns.namespace, name: workload.name, payload: workload });
      for (const pod of ns.pods || []) rows.push({ kind: 'Pod', namespace: ns.namespace, name: pod.name, payload: pod });
      for (const service of ns.services || []) rows.push({ kind: 'Service', namespace: ns.namespace, name: service.name, payload: service });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of rows) {
        await client.query(`
          INSERT INTO runtime_resource (source, kind, namespace, name, health, payload, observed_at, expires_at)
          VALUES ('kubernetes', $1, $2, $3, $4, $5::jsonb, $6, $7)
          ON CONFLICT (source, kind, namespace, name) DO UPDATE SET
            health = EXCLUDED.health, payload = EXCLUDED.payload,
            observed_at = EXCLUDED.observed_at, expires_at = EXCLUDED.expires_at,
            updated_at = clock_timestamp()
        `, [item.kind, item.namespace, item.name, projectedHealth(item), JSON.stringify(item.payload || {}), observedAt, expiresAt]);
      }
      await client.query("DELETE FROM runtime_resource WHERE expires_at < clock_timestamp() - interval '10 minutes'");
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return true;
  } catch (error) {
    if (!runtimeProjectionWarningLogged) {
      runtimeProjectionWarningLogged = true;
      console.warn('[oaa-runtime] Supabase projection skipped:', error.message || error);
    }
    return false;
  }
}

async function runtimeProjectionStatus() {
  const pool = getPgPool();
  if (!pool) return { ready: false, reason: 'postgres_not_configured' };
  try {
    const result = await pool.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE expires_at > clock_timestamp())::int AS fresh,
        max(observed_at) FILTER (WHERE expires_at > clock_timestamp()) AS last_observed_at
      FROM runtime_resource
      WHERE source = 'kubernetes'
    `);
    const row = result.rows[0] || {};
    const observedAt = row.last_observed_at || null;
    const watch = runtimeWatchStatus();
    watch.projection = await persistedRuntimeWatchStatus(pool);
    return {
      ready: Number(row.fresh || 0) > 0 && (!OAA_K8S_WATCH_ENABLED || (watch.ready && watch.projection.ready)),
      totalResources: Number(row.total || 0),
      freshResources: Number(row.fresh || 0),
      lastObservedAt: observedAt,
      lagSeconds: observedAt ? Math.max(0, Math.round((Date.now() - Date.parse(observedAt)) / 1000)) : null,
      refreshSeconds: Math.round(OAA_RUNTIME_REFRESH_MS / 1000),
      authority: 'kubernetes',
      projection: 'supabase',
      watch,
    };
  } catch (error) {
    return { ready: false, reason: error.message || 'runtime_projection_unavailable' };
  }
}

async function persistedRuntimeWatchStatus(pool) {
  if (!OAA_K8S_WATCH_ENABLED) return { ready: true, observers: 0, observerStreams: 0, watchingStreams: 0, expectedStreams: 0 };
  try {
    if (!(await ensureRuntimeWatchSchema(pool))) return { ready: false, reason: 'replica_aware_watch_schema_missing' };
    const freshnessSeconds = OAA_K8S_WATCH_TIMEOUT_SECONDS + Math.ceil(OAA_K8S_WATCH_RECONNECT_MS / 1000) + 60;
    const result = await pool.query(`
      SELECT
        count(DISTINCT observer_id) FILTER (WHERE status = 'watching')::int AS observers,
        count(*) FILTER (WHERE status = 'watching')::int AS observer_streams,
        count(*) FILTER (WHERE status = 'watching')::int AS watching_observer_streams,
        count(*) FILTER (WHERE status = 'watching' AND observer_id = $2)::int AS current_observer_streams,
        count(DISTINCT (kind, namespace)) FILTER (WHERE status = 'watching')::int AS watching_streams,
        count(*) FILTER (WHERE status = 'error')::int AS errors,
        max(updated_at) AS last_updated_at
      FROM watch_cursor
      WHERE source = 'kubernetes'
        AND observer_id <> 'legacy'
        AND updated_at > clock_timestamp() - ($1::int * interval '1 second')
    `, [freshnessSeconds, OAA_WATCH_OBSERVER_ID]);
    const row = result.rows[0] || {};
    const expectedStreams = runtimeWatchState.size;
    const watchingStreams = Number(row.watching_streams || 0);
    const currentObserverStreams = Number(row.current_observer_streams || 0);
    return {
      ready: expectedStreams > 0 && watchingStreams >= expectedStreams && currentObserverStreams >= expectedStreams,
      observers: Number(row.observers || 0),
      observerStreams: Number(row.observer_streams || 0),
      watchingObserverStreams: Number(row.watching_observer_streams || 0),
      currentObserverStreams,
      watchingStreams,
      expectedStreams,
      errors: Number(row.errors || 0),
      lastUpdatedAt: row.last_updated_at || null,
    };
  } catch (error) {
    return { ready: false, reason: error.message || 'watch_projection_unavailable' };
  }
}

async function readRuntimeProjectionSnapshot() {
  const pool = getPgPool();
  if (!pool) return null;
  try {
    const result = await pool.query(`
      SELECT kind, namespace, name, payload, observed_at
      FROM runtime_resource
      WHERE source = 'kubernetes' AND expires_at > clock_timestamp()
      ORDER BY kind, namespace, name
    `);
    const rows = result.rows || [];
    const clusterRow = rows.find((row) => row.kind === 'ClusterSummary' && row.name === 'cluster');
    if (!clusterRow) return null;
    const namespaces = OAA_ENV_NAMESPACES.map((namespace) => {
      const summary = rows.find((row) => row.kind === 'NamespaceSnapshot' && row.namespace === namespace)?.payload || {};
      return {
        namespace,
        access: { ...(summary.access || {}), source: 'supabase-runtime-projection' },
        counts: summary.counts || { pods: 0, services: 0, events: 0, workloads: 0, unhealthyPods: 0 },
        workloads: rows.filter((row) => row.namespace === namespace && ['Deployment', 'StatefulSet', 'DaemonSet'].includes(row.kind)).map((row) => row.payload),
        pods: rows.filter((row) => row.namespace === namespace && row.kind === 'Pod').map((row) => row.payload),
        services: rows.filter((row) => row.namespace === namespace && row.kind === 'Service').map((row) => row.payload),
        unhealthyPods: rows.filter((row) => row.namespace === namespace && row.kind === 'Pod' && (row.payload?.phase !== 'Running' || row.payload?.reason || Number(row.payload?.restarts || 0) > 0)).map((row) => row.payload),
        recentEvents: summary.recentEvents || [],
      };
    });
    return {
      cluster: { ...(clusterRow.payload || {}), source: 'supabase-runtime-projection' },
      namespaces,
      observedAt: clusterRow.observed_at,
    };
  } catch {
    return null;
  }
}

async function environmentSnapshot(body = {}, actor = null) {
  const context = sanitizePageContext(body.context || body.pageContext || {});
  const started = Date.now();
  let [cluster, namespaces] = await Promise.all([
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
  const liveClusterReady = cluster.access === 'ok';
  const liveNamespacesReady = namespaces.every((ns) => !ns.access?.error && Object.values(ns.access || {}).some((value) => value === 'ok'));
  let projectionFallback = null;
  if (!liveClusterReady || !liveNamespacesReady) {
    projectionFallback = await readRuntimeProjectionSnapshot();
    if (!liveClusterReady && projectionFallback?.cluster) cluster = projectionFallback.cluster;
    if (!liveNamespacesReady && projectionFallback?.namespaces?.length) {
      namespaces = namespaces.map((ns) => {
        const usable = !ns.access?.error && Object.values(ns.access || {}).some((value) => value === 'ok');
        return usable ? ns : (projectionFallback.namespaces.find((row) => row.namespace === ns.namespace) || ns);
      });
    }
  }
  const out = {
    time: new Date().toISOString(),
    actor: actor?.username || 'unknown',
    pageContext: context,
    cluster,
    namespaces,
    evidenceSource: liveClusterReady && liveNamespacesReady ? 'kubernetes-live' : (projectionFallback ? 'kubernetes-live+supabase-projection' : 'kubernetes-partial'),
    projectionObservedAt: projectionFallback?.observedAt || null,
    latencyMs: Date.now() - started,
  };
  out.supabaseProjection = liveClusterReady && liveNamespacesReady ? await projectRuntimeSnapshot(out) : false;
  audit(actor, 'environment-snapshot', OAA_ENV_NAMESPACES.join(','), 'ok', `${namespaces.length} namespaces / ${cluster.totalPods || 0} cluster pods`);
  return out;
}

async function refreshRuntimeProjection() {
  if (runtimeRefreshInFlight) return;
  runtimeRefreshInFlight = true;
  try {
    await environmentSnapshot({ context: { title: 'scheduled runtime projection' } }, null);
    const inventory = await collectRuntimeInventory();
    await projectRuntimeInventory(inventory);
    await cleanupRuntimeWatchCursors();
  } catch (error) {
    console.warn('[oaa-runtime] scheduled refresh failed:', error.message || error);
  } finally {
    runtimeRefreshInFlight = false;
  }
}

async function cleanupRuntimeWatchCursors() {
  const pool = getPgPool();
  if (!pool || !(await ensureRuntimeWatchSchema(pool))) return false;
  await pool.query("DELETE FROM watch_cursor WHERE updated_at < clock_timestamp() - interval '1 day'");
  return true;
}

async function updateRuntimeWatchCursor(kind, namespace, values = {}) {
  const pool = getPgPool();
  if (!pool) return false;
  try {
    if (!(await ensureRuntimeWatchSchema(pool))) return false;
    await pool.query(`
      INSERT INTO watch_cursor (source, observer_id, kind, namespace, resource_version, status, last_event_at, last_error, reconnect_count, updated_at)
      VALUES ('kubernetes', $1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())
      ON CONFLICT (source, observer_id, kind, namespace) DO UPDATE SET
        resource_version = COALESCE(EXCLUDED.resource_version, watch_cursor.resource_version),
        status = EXCLUDED.status,
        last_event_at = COALESCE(EXCLUDED.last_event_at, watch_cursor.last_event_at),
        last_error = EXCLUDED.last_error,
        reconnect_count = greatest(watch_cursor.reconnect_count, EXCLUDED.reconnect_count),
        updated_at = clock_timestamp()
    `, [OAA_WATCH_OBSERVER_ID, kind, namespace || '', values.resourceVersion || null, values.status || 'starting', values.lastEventAt || null, values.lastError || null, Number(values.reconnectCount || 0)]);
    return true;
  } catch (error) {
    if (!runtimeProjectionWarningLogged) console.warn('[oaa-runtime] watch cursor skipped:', error.message || error);
    return false;
  }
}

async function persistRuntimeWatchHeartbeat() {
  if (runtimeWatchHeartbeatInFlight || runtimeWatchStopping) return false;
  const pool = getPgPool();
  const states = [...runtimeWatchState.values()];
  if (!pool || !states.length) return false;
  runtimeWatchHeartbeatInFlight = true;
  try {
    if (!(await ensureRuntimeWatchSchema(pool))) return false;
    const rows = states.map((state) => ({
      kind: state.kind,
      namespace: state.namespace || '',
      resource_version: state.resourceVersion || null,
      status: state.status || 'starting',
      last_event_at: state.lastEventAt || null,
      last_error: state.lastError || null,
      reconnect_count: Number(state.reconnects || 0),
    }));
    await pool.query(`
      INSERT INTO watch_cursor
        (source, observer_id, kind, namespace, resource_version, status, last_event_at, last_error, reconnect_count, updated_at)
      SELECT 'kubernetes', $1, x.kind, x.namespace, x.resource_version, x.status,
             x.last_event_at, x.last_error, x.reconnect_count, clock_timestamp()
      FROM jsonb_to_recordset($2::jsonb) AS x(
        kind text, namespace text, resource_version text, status text,
        last_event_at timestamptz, last_error text, reconnect_count integer
      )
      ON CONFLICT (source, observer_id, kind, namespace) DO UPDATE SET
        resource_version = COALESCE(EXCLUDED.resource_version, watch_cursor.resource_version),
        status = EXCLUDED.status,
        last_event_at = COALESCE(EXCLUDED.last_event_at, watch_cursor.last_event_at),
        last_error = EXCLUDED.last_error,
        reconnect_count = greatest(watch_cursor.reconnect_count, EXCLUDED.reconnect_count),
        updated_at = clock_timestamp()
    `, [OAA_WATCH_OBSERVER_ID, JSON.stringify(rows)]);
    return true;
  } catch (error) {
    if (!runtimeProjectionWarningLogged) console.warn('[oaa-runtime] watch heartbeat skipped:', error.message || error);
    return false;
  } finally {
    runtimeWatchHeartbeatInFlight = false;
  }
}

async function projectRuntimeWatchEvent(eventType, kind, object) {
  if (!['ADDED', 'MODIFIED', 'DELETED'].includes(eventType)) return false;
  const definition = resourceDefinition(kind);
  const namespace = object?.metadata?.namespace || '';
  if (definition.namespaced && !OAA_ENV_NAMESPACES.includes(namespace)) return false;
  if (definition.key === 'namespace' && !OAA_ENV_NAMESPACES.includes(object?.metadata?.name || '')) return false;
  const resource = sanitizeKubernetesObject(kind, object || {});
  const item = runtimeProjectionRow(resource);
  if (!item.name || !item.resourceVersion) return false;
  const pool = getPgPool();
  if (!pool) return false;
  if (runtimeProjectionSupported == null) {
    const check = await pool.query("SELECT to_regclass('oaa.runtime_resource') AS table_name");
    runtimeProjectionSupported = Boolean(check.rows[0]?.table_name);
  }
  if (!runtimeProjectionSupported) return false;
  const observedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(observedAt) + OAA_RUNTIME_REFRESH_MS * 3).toISOString();
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(item.payload || {})).digest('hex')}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (eventType === 'DELETED') {
      await client.query(`DELETE FROM runtime_resource WHERE source = 'kubernetes' AND kind = $1 AND namespace = $2 AND name = $3`, [item.kind, item.namespace, item.name]);
    } else {
      await client.query(`
        INSERT INTO runtime_resource (source, kind, namespace, name, resource_version, health, payload, observed_at, expires_at)
        VALUES ('kubernetes', $1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        ON CONFLICT (source, kind, namespace, name) DO UPDATE SET
          resource_version = EXCLUDED.resource_version, health = EXCLUDED.health, payload = EXCLUDED.payload,
          observed_at = EXCLUDED.observed_at, expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp()
      `, [item.kind, item.namespace, item.name, item.resourceVersion, item.health, JSON.stringify(item.payload || {}), observedAt, expiresAt]);
    }
    if (await ensureRuntimeWatchSchema(pool)) {
      await client.query(`
        INSERT INTO runtime_event (source, event_type, kind, namespace, name, resource_version, health, payload_digest, observed_at, metadata)
        VALUES ('kubernetes', $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT (source, event_type, kind, namespace, name, resource_version) DO NOTHING
      `, [eventType, item.kind, item.namespace, item.name, item.resourceVersion, item.health, digest, observedAt, JSON.stringify({ generation: resource.metadata?.generation ?? null })]);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function consumeWatchResponse(response, kind, namespace, state) {
  let buffered = '';
  for await (const chunk of response.body) {
    if (runtimeWatchStopping) break;
    buffered += Buffer.from(chunk).toString('utf8');
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      const eventType = String(event.type || '').toUpperCase();
      const resourceVersion = event.object?.metadata?.resourceVersion || '';
      if (eventType === 'ERROR') throw new Error(event.object?.message || 'Kubernetes watch error');
      if (eventType === 'BOOKMARK') {
        if (resourceVersion) state.resourceVersion = resourceVersion;
        continue;
      }
      if (!['ADDED', 'MODIFIED', 'DELETED'].includes(eventType)) continue;
      await projectRuntimeWatchEvent(eventType, kind, event.object || {});
      state.resourceVersion = resourceVersion || state.resourceVersion;
      state.lastEventAt = new Date().toISOString();
      state.events += 1;
      state.status = 'watching';
      state.lastError = null;
    }
  }
}

async function watchResourceLoop(kind, namespace = '') {
  const definition = resourceDefinition(kind);
  const key = runtimeKey(definition.kind, namespace);
  const state = { kind: definition.kind, namespace: namespace || '', status: 'starting', resourceVersion: '0', lastEventAt: null, events: 0, reconnects: 0, lastError: null };
  runtimeWatchState.set(key, state);
  while (!runtimeWatchStopping) {
    const controller = new AbortController();
    runtimeWatchControllers.add(controller);
    try {
      state.status = 'starting';
      const path = kubernetesResourcePath(kind, namespace, '', {
        watch: 'true', allowWatchBookmarks: 'true', timeoutSeconds: OAA_K8S_WATCH_TIMEOUT_SECONDS,
        resourceVersion: state.resourceVersion || '0',
      });
      const response = await fetch(`${APISERVER}${path}`, {
        headers: { authorization: `Bearer ${saToken()}`, accept: 'application/json' }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${definition.kind} watch HTTP ${response.status}`);
      state.status = 'watching';
      state.lastError = null;
      await consumeWatchResponse(response, kind, namespace, state);
      state.reconnects += 1;
      state.status = 'reconnecting';
    } catch (error) {
      if (runtimeWatchStopping || error?.name === 'AbortError') break;
      state.reconnects += 1;
      state.status = 'error';
      state.lastError = String(error?.message || error).slice(0, 300);
      if (/too old resource version|\b410\b/i.test(state.lastError)) state.resourceVersion = '0';
      await updateRuntimeWatchCursor(definition.kind, namespace, { resourceVersion: state.resourceVersion, status: 'error', lastError: state.lastError, reconnectCount: state.reconnects });
    } finally {
      runtimeWatchControllers.delete(controller);
    }
    if (!runtimeWatchStopping) await new Promise((resolve) => setTimeout(resolve, OAA_K8S_WATCH_RECONNECT_MS + Math.floor(Math.random() * 1000)));
  }
  state.status = 'stopped';
  await updateRuntimeWatchCursor(definition.kind, namespace, { resourceVersion: state.resourceVersion, status: 'stopped', lastEventAt: state.lastEventAt, reconnectCount: state.reconnects });
}

function runtimeWatchStatus() {
  const states = [...runtimeWatchState.values()];
  const watching = states.filter((state) => state.status === 'watching').length;
  const errors = states.filter((state) => state.status === 'error').length;
  const lastEventAt = states.map((state) => state.lastEventAt).filter(Boolean).sort().at(-1) || null;
  return {
    enabled: OAA_K8S_WATCH_ENABLED,
    ready: OAA_K8S_WATCH_ENABLED && states.length > 0 && watching === states.length && errors === 0,
    streams: states.length, watching, errors,
    events: states.reduce((count, state) => count + state.events, 0),
    reconnects: states.reduce((count, state) => count + state.reconnects, 0),
    lastEventAt,
  };
}

function startRuntimeWatches() {
  if (!OAA_K8S_WATCH_ENABLED) return;
  for (const kind of WATCH_RESOURCE_KINDS) {
    const definition = resourceDefinition(kind);
    if (definition.namespaced) {
      for (const namespace of OAA_ENV_NAMESPACES) void watchResourceLoop(kind, namespace);
    } else {
      void watchResourceLoop(kind, '');
    }
  }
  void persistRuntimeWatchHeartbeat();
  runtimeWatchHeartbeatTimer = setInterval(() => { void persistRuntimeWatchHeartbeat(); }, OAA_K8S_WATCH_HEARTBEAT_MS);
  runtimeWatchHeartbeatTimer.unref();
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

function operationalAnswerPolicySystemMessage() {
  return {
    role: 'system',
    content: [
      'OpenSphere Operational Answer Contract:',
      'For OpenSphere operations, installation, preflight, Kubernetes, plugin, Data & Identity, Change Control, Foundation, or OAA troubleshooting questions, separate the answer into: 확인한 현재 클러스터 사실, 문서 기반 판단, 필요한 조치, 승인 필요한 작업.',
      'Use the attached live environment snapshot as the primary source for current runtime facts. If the live snapshot is unavailable or incomplete, explicitly say which live fact could not be verified.',
      'Do not infer namespaces, pods, services, deployments, CRDs, readiness, install state, or action results from manuals alone. Manuals describe intended design; live snapshot/tool results describe current reality.',
      'Before recommending a write/apply/install/delete/restart/scale action, state the read-only evidence first and mark the action as a proposal unless an explicit OAA action endpoint result is present.',
      'Never claim that kubectl, apply, install, delete, restart, scale, or secret rotation was executed unless an explicit tool/action result is present in this conversation.',
      'Samba-AD Preflight identity-claim-binding BLOCK means the typed IdentityDirectoryClaim/IdentityDirectoryBinding contract is not ready. Existing generic FoundationClaim/FoundationBinding CRDs alone do not satisfy that typed identity directory contract.',
      'For Samba-AD and identity-directory answers, distinguish: generic foundationclaims/foundationbindings, typed identitydirectoryclaims/identitydirectorybindings, Crossplane core/provider readiness, Foundation reconciler readiness, Keycloak live namespace, and Samba-AD operand lifecycle.',
      'OAA may draft Claim/Binding proposals and commands, but applying them requires admin approval and the Foundation write-path authority.',
    ].join('\n'),
  };
}

function controlToolsSystemMessage() {
  const rawToolManifest = oaaToolManifest();
  const manifest = withMutationGate(rawToolManifest);
  const bindings = withActionBindingMutationGate(oaaActionBindings(), rawToolManifest);
  const mutationNote = manifest.mutationEnabled
    ? 'Administrative actions require permission, AAL2 assurance for high-risk owner operations, exact confirmation, and a human reason. Kubernetes desired-state changes enter Backend/Gitea/reconciler; lifecycle changes call only a fixed owning Console or Cluster Manager facade. OAA never writes Kubernetes directly and never forwards an operator-supplied URL.'
    : `Controlled action submission is disabled (${manifest.mutationGateReason}). Only Manual/help/search and safe read-only tools are available. Do not suggest restart/scale/apply/delete actions as executable; they are not present in the tool list below.`;
  return {
    role: 'system',
    content: [
      'OAA Controlled Tools available through OAA Gateway:',
      `Read namespaces: ${OAA_ENV_NAMESPACES.join(', ')}`,
      `Mutation namespaces: ${OAA_MUTATION_NAMESPACES.join(', ')}`,
      `Tool manifest schema: ${manifest.schema}. Tool IDs: ${manifest.tools.map((t) => t.id).join(', ')}.`,
      `Action binding schema: ${bindings.schema}. Action binding IDs: ${bindings.bindings.map((b) => b.id).join(', ')}.`,
      'Read tools: live environment snapshot is automatically attached; cluster pod summary, pod logs, services, events, describe, and rollout can be read through /api/oaa/tools/k8s/*.',
      'OpenSphere owner-facade reads: authorized operators can inspect Platform Readiness, Main Shell Registry, Supabase, Gitea, HIS ObservabilityBinding, consumer contracts, notification delivery, and Extension Host registration through fixed owner APIs. The canonical catalog search relates declared owners, services, and APIs to live Kubernetes evidence.',
      'Do not treat the catalog or Supabase projection as runtime truth. Catalog is declared topology, Supabase is durable identity/audit/read-model evidence, Kubernetes is live runtime authority, Gitea is desired-change authority, and HIS is telemetry authority.',
      'Platform recovery status is structured evidence, not proof that a restore executor exists. The current owner supports sanitized status and isolated-drill planning only; never claim that backup restore can be executed unless drill-request and evidence-promote capabilities are both advertised.',
      'The provider may call only the permission-filtered read tools supplied with this request. Treat their returned data as current evidence and cite what was actually observed.',
      mutationNote,
      'Action safety rules: admin token required, target namespace/kind must be allowlisted, resource names must be RFC1123-safe, and exact confirmation text is required.',
      'Restart confirmation format: restart deployment <namespace>/<deployment>.',
      `Scale confirmation format: scale deployment <namespace>/<deployment> to <replicas>. Maximum replicas: ${OAA_SCALE_MAX}.`,
      'Other mutation confirmation formats are supplied by the matching action binding. Image updates require immutable sha256 digests; protected deletion additionally requires impact, recovery plan, and backup evidence.',
      'Do not state that an action was executed unless an explicit action endpoint result is present.',
      'Never construct or simulate a confirmation on the operator behalf. A mutating action is accepted only when the operator sends the exact /action confirmation command with their own reason. Kubernetes changes then enter Gitea review and the dedicated reconciler; registered lifecycle actions execute only through their fixed owning facade and return its durable operation result.',
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
      sourceId: 'console-docs/platform-control-plane-v2',
      sectionId: 'manual-section:console-docs/platform-control-plane-v2#phase-1',
      title: 'Inspect live OpenSphere environment before operational answers',
      intent: 'inspect',
      toolId: 'oaa.environment.read',
      controlPlane: 'opensphere-console-oaa-gateway',
      riskLevel: 'read',
      confirmation: 'none',
      requiredInputs: bindingInput({ context: 'optional current console route/title/selection' }),
      permission: { roles: ['authenticated'], scopes: ['oaa:tools:read'] },
      audit: { eventType: 'environment-snapshot', targetTemplate: 'opensphere namespaces' },
      citations: [{ sourceId: 'console-docs/platform-control-plane-v2', sourcePath: 'OpenSphere-console/docs/PLAN-CONSOLE-PLATFORM-CONTROL-PLANE-V2-2026-07-22.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:knowledge-search',
      namespace: 'opensphere',
      sourceId: 'console-docs/oaa-manual-knowledge-data-model',
      sectionId: 'manual-section:console-docs/oaa-manual-knowledge-data-model#retrieval-contract',
      title: 'Search manuals before answering OpenSphere-specific questions',
      intent: 'diagnose',
      toolId: 'oaa.knowledge.search',
      controlPlane: 'opensphere-console-oaa-gateway',
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
      title: 'Ingest OpenSphere manuals into Supabase PostgreSQL pgvector',
      intent: 'ingest-knowledge',
      toolId: 'oaa.knowledge.ingest-manual',
      controlPlane: 'opensphere-console-oaa-gateway',
      riskLevel: 'high',
      confirmation: 'required',
      confirmationTemplate: 'ingest OpenSphere manual knowledge',
      preflightToolIds: ['oaa.knowledge.search'],
      requiredInputs: bindingInput({ manifest: 'manual-seed.opensphere.io/v1alpha1 manifest', reason: 'human management reason (8+ chars)', confirm: 'ingest OpenSphere manual knowledge' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:knowledge:write'] },
      audit: { eventType: 'knowledge-manual-seed', targetTemplate: '<manifest.source.id>' },
      citations: [{ sourceId: 'console-docs/oaa-manual-knowledge-data-model', sourcePath: 'OpenSphere-console/docs/OAA-MANUAL-KNOWLEDGE-DATA-MODEL.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:k8s-describe',
      namespace: 'opensphere',
      sourceId: 'console-docs/platform-control-plane-v2',
      sectionId: 'manual-section:console-docs/platform-control-plane-v2#phase-1',
      title: 'Describe pods or deployments when diagnosing OAA and platform services',
      intent: 'diagnose',
      toolId: 'oaa.k8s.resource.describe',
      controlPlane: 'kubernetes-api',
      riskLevel: 'read',
      confirmation: 'none',
      requiredInputs: bindingInput({ kind: 'pod | deployment', namespace: OAA_ENV_NAMESPACES.join(' | '), name: 'Kubernetes resource name' }),
      permission: { roles: ['authenticated'], scopes: ['oaa:k8s:read'], namespaceScope: OAA_ENV_NAMESPACES },
      audit: { eventType: 'k8s-describe-resource', targetTemplate: '<namespace>/<kind>/<name>' },
      citations: [{ sourceId: 'console-docs/platform-control-plane-v2', sourcePath: 'OpenSphere-console/docs/PLAN-CONSOLE-PLATFORM-CONTROL-PLANE-V2-2026-07-22.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:cluster-pod-count',
      namespace: 'opensphere',
      sourceId: 'console-docs/platform-control-plane-v2',
      sectionId: 'manual-section:console-docs/platform-control-plane-v2#phase-1',
      title: 'Count current Kubernetes pods across all namespaces',
      intent: 'inspect',
      toolId: 'oaa.k8s.cluster.pods.summary',
      controlPlane: 'kubernetes-api',
      riskLevel: 'read',
      confirmation: 'none',
      requiredInputs: bindingInput({}),
      permission: { roles: ['authenticated'], scopes: ['oaa:k8s:read'] },
      audit: { eventType: 'k8s-cluster-pod-summary', targetTemplate: 'cluster' },
      citations: [{ sourceId: 'console-docs/platform-control-plane-v2', sourcePath: 'OpenSphere-console/docs/PLAN-CONSOLE-PLATFORM-CONTROL-PLANE-V2-2026-07-22.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:opensphere-console-oaa-gateway-rollout',
      namespace: 'opensphere',
      sourceId: 'console-docs/platform-control-plane-v2',
      sectionId: 'manual-section:console-docs/platform-control-plane-v2#phase-1',
      title: 'Check OAA Gateway rollout status',
      intent: 'diagnose',
      toolId: 'oaa.k8s.deployment.rollout',
      controlPlane: 'kubernetes-api',
      riskLevel: 'read',
      confirmation: 'none',
      targetHints: { namespace: OAA_NAMESPACE, deployment: 'opensphere-console-oaa-gateway' },
      requiredInputs: bindingInput({ namespace: OAA_NAMESPACE, name: 'opensphere-console-oaa-gateway' }),
      permission: { roles: ['authenticated'], scopes: ['oaa:k8s:read'], namespaceScope: [OAA_NAMESPACE] },
      audit: { eventType: 'k8s-rollout-status', targetTemplate: `${OAA_NAMESPACE}/opensphere-console-oaa-gateway` },
      citations: [{ sourceId: 'console-docs/platform-control-plane-v2', sourcePath: 'OpenSphere-console/docs/PLAN-CONSOLE-PLATFORM-CONTROL-PLANE-V2-2026-07-22.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:opensphere-console-oaa-gateway-restart',
      namespace: 'opensphere',
      sourceId: 'console-docs/platform-control-plane-v2',
      sectionId: 'manual-section:console-docs/platform-control-plane-v2#phase-1',
      title: 'Restart OAA Gateway after configuration or manual seed changes',
      intent: 'restart',
      toolId: 'oaa.k8s.deployment.restart',
      controlPlane: 'kubernetes-api',
      riskLevel: 'medium',
      confirmation: 'required',
      confirmationTemplate: `restart deployment ${OAA_NAMESPACE}/opensphere-console-oaa-gateway`,
      preflightToolIds: ['oaa.k8s.deployment.rollout'],
      targetHints: { namespace: OAA_NAMESPACE, deployment: 'opensphere-console-oaa-gateway' },
      requiredInputs: bindingInput({ namespace: OAA_NAMESPACE, name: 'opensphere-console-oaa-gateway', confirm: `restart deployment ${OAA_NAMESPACE}/opensphere-console-oaa-gateway` }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:k8s:write'], namespaceScope: [OAA_NAMESPACE] },
      audit: { eventType: 'k8s-restart-deployment', targetTemplate: `${OAA_NAMESPACE}/opensphere-console-oaa-gateway` },
      citations: [{ sourceId: 'console-docs/platform-control-plane-v2', sourcePath: 'OpenSphere-console/docs/PLAN-CONSOLE-PLATFORM-CONTROL-PLANE-V2-2026-07-22.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:opensphere-console-oaa-gateway-scale',
      namespace: 'opensphere',
      sourceId: 'console-docs/platform-control-plane-v2',
      sectionId: 'manual-section:console-docs/platform-control-plane-v2#phase-1',
      title: 'Scale OAA Gateway deployment within configured replica limits',
      intent: 'scale',
      toolId: 'oaa.k8s.deployment.scale',
      controlPlane: 'kubernetes-api',
      riskLevel: 'medium',
      confirmation: 'required',
      confirmationTemplate: `scale deployment ${OAA_NAMESPACE}/opensphere-console-oaa-gateway to <replicas>`,
      preflightToolIds: ['oaa.k8s.deployment.rollout'],
      targetHints: { namespace: OAA_NAMESPACE, deployment: 'opensphere-console-oaa-gateway', maxReplicas: OAA_SCALE_MAX },
      requiredInputs: bindingInput({ namespace: OAA_NAMESPACE, name: 'opensphere-console-oaa-gateway', replicas: `0..${OAA_SCALE_MAX}`, confirm: `scale deployment ${OAA_NAMESPACE}/opensphere-console-oaa-gateway to <replicas>` }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:k8s:write'], namespaceScope: [OAA_NAMESPACE] },
      audit: { eventType: 'k8s-scale-deployment', targetTemplate: `${OAA_NAMESPACE}/opensphere-console-oaa-gateway` },
      citations: [{ sourceId: 'console-docs/platform-control-plane-v2', sourcePath: 'OpenSphere-console/docs/PLAN-CONSOLE-PLATFORM-CONTROL-PLANE-V2-2026-07-22.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:control-plane-status',
      namespace: 'opensphere',
      sourceId: 'console-docs/platform-control-plane-v2',
      sectionId: 'manual-section:console-docs/platform-control-plane-v2#target-state',
      title: 'Inspect the OpenSphere control-plane authorities and lifecycle gates',
      intent: 'diagnose',
      toolId: 'oaa.control-plane.status',
      controlPlane: 'opensphere-console-oaa-gateway',
      riskLevel: 'read',
      confirmation: 'none',
      requiredInputs: bindingInput({}),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:platform:read'] },
      audit: { eventType: 'control-plane-status', targetTemplate: 'opensphere/control-plane' },
      citations: [{ sourceId: 'console-docs/platform-control-plane-v2', sourcePath: 'OpenSphere-console/docs/PLAN-CONSOLE-PLATFORM-CONTROL-PLANE-V2-2026-07-22.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:identity-status',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#console-identity-owner-control',
      title: 'Inspect the sanitized Console user and role inventory', intent: 'inspect-identity',
      toolId: 'oaa.identity.status', controlPlane: 'console-identity-owner-facade',
      riskLevel: 'read', confirmation: 'none', requiredInputs: bindingInput({}),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:identity:manage'] },
      audit: { eventType: 'identity-owner-status', targetTemplate: 'ConsoleIdentity/users' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:identity-user-create',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#console-identity-owner-control',
      title: 'Create a Console user without returning a recovery link or credential', intent: 'create-console-user',
      toolId: 'oaa.identity.user.create', controlPlane: 'console-identity-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'create Console user <username>',
      requiredInputs: bindingInput({ email: 'user email', username: 'Console username', displayName: 'display name', roles: OAA_CONSOLE_ROLES.join(' | '), reason: 'human management reason (8+ chars)', confirm: 'create Console user <username>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:identity:manage'] },
      audit: { eventType: 'oaa-identity-user-create', targetTemplate: 'ConsoleUser/<username>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:identity-user-enabled',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#console-identity-owner-control',
      title: 'Enable or disable a Console user while preserving administrator continuity', intent: 'set-console-user-enabled',
      toolId: 'oaa.identity.user.enabled', controlPlane: 'console-identity-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: '<verb> Console user <userId>',
      requiredInputs: bindingInput({ userId: 'Console user UUID', enabled: 'true | false', reason: 'human management reason (8+ chars)', confirm: '<enable|disable> Console user <userId>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:identity:manage'] },
      audit: { eventType: 'oaa-identity-user-enabled', targetTemplate: 'ConsoleUser/<userId>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:identity-role-membership',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#console-identity-owner-control',
      title: 'Add or remove one canonical Console role', intent: 'manage-console-role',
      toolId: 'oaa.identity.role.membership', controlPlane: 'console-identity-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: '<operation> Console role <role> for user <userId>',
      requiredInputs: bindingInput({ userId: 'Console user UUID', role: OAA_CONSOLE_ROLES.join(' | '), operation: 'add | remove', reason: 'human management reason (8+ chars)', confirm: '<add|remove> Console role <role> for user <userId>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:identity:manage'] },
      audit: { eventType: 'oaa-identity-role-membership', targetTemplate: 'ConsoleUser/<userId>/Role/<role>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:evidence-status',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#agent-evidence-correlation-and-retention',
      title: 'Inspect correlated agent, tool, retrieval, provider usage, and retention evidence', intent: 'inspect-agent-evidence',
      toolId: 'oaa.evidence.status', controlPlane: 'oaa-supabase-evidence-owner',
      riskLevel: 'read', confirmation: 'none', requiredInputs: bindingInput({}),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:evidence:read'] },
      audit: { eventType: 'oaa-evidence-status', targetTemplate: 'OAAEvidence/all' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:evidence-retention-update',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#agent-evidence-correlation-and-retention',
      title: 'Update one OAA evidence retention or legal-hold policy', intent: 'manage-evidence-retention',
      toolId: 'oaa.evidence.retention.update', controlPlane: 'oaa-supabase-evidence-owner',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'update OAA evidence retention <stream> to <retentionDays> days',
      requiredInputs: bindingInput({ stream: OAA_EVIDENCE_STREAMS.join(' | '), retentionDays: '30..3650', disposition: 'retain | export-before-delete', legalHold: 'true | false', reason: 'human management reason (8+ chars)', confirm: 'update OAA evidence retention <stream> to <retentionDays> days' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:evidence:manage'] },
      audit: { eventType: 'oaa-evidence-retention-update', targetTemplate: 'OAAEvidence/<stream>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:recovery-status',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#platform-recovery-owner-control',
      title: 'Inspect sanitized Supabase, Storage, and Gitea recovery evidence', intent: 'inspect-recovery',
      toolId: 'oaa.recovery.status', controlPlane: 'console-platform-recovery-owner-facade',
      riskLevel: 'read', confirmation: 'none', requiredInputs: bindingInput({}),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:recovery:read'] },
      audit: { eventType: 'recovery-owner-status', targetTemplate: 'PlatformRecovery/all' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:recovery-plan',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#platform-recovery-owner-control',
      title: 'Plan an isolated non-destructive platform recovery drill', intent: 'plan-recovery',
      toolId: 'oaa.recovery.plan', controlPlane: 'console-platform-recovery-owner-facade',
      riskLevel: 'read', confirmation: 'none', requiredInputs: bindingInput({ component: OAA_RECOVERY_COMPONENTS.join(' | ') }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:recovery:read'] },
      audit: { eventType: 'recovery-owner-plan', targetTemplate: 'PlatformRecovery/<component>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:observability-logs-query',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#his-observability-owner-control',
      title: 'Query redacted centralized logs through the HIS owner facade', intent: 'diagnose-logs',
      toolId: 'oaa.observability.logs.query', controlPlane: 'cluster-manager-his-owner-facade',
      riskLevel: 'read', confirmation: 'none',
      requiredInputs: bindingInput({ template: 'service.recent | service.errors | namespace.recent', service: 'service name for service templates', namespace: 'namespace for namespace.recent', sinceMinutes: '1..1440', limit: '1..200' }),
      permission: { roles: ['authenticated'], scopes: ['oaa:logs:read'] },
      audit: { eventType: 'his-observability-logs-query', targetTemplate: 'HIS/Loki/<target>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:observability-traces-query',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#his-observability-owner-control',
      title: 'Query sanitized distributed traces through the HIS owner facade', intent: 'diagnose-traces',
      toolId: 'oaa.observability.traces.query', controlPlane: 'cluster-manager-his-owner-facade',
      riskLevel: 'read', confirmation: 'none',
      requiredInputs: bindingInput({ template: 'trace.by_id | service.recent', traceId: '32 hex characters for trace.by_id', service: 'service name for service.recent', sinceMinutes: '1..1440', limit: '1..100' }),
      permission: { roles: ['authenticated'], scopes: ['oaa:logs:read'] },
      audit: { eventType: 'his-observability-traces-query', targetTemplate: 'HIS/Tempo/<target>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:catalog-read',
      namespace: 'opensphere',
      sourceId: 'opensphere-docs/constitution-0002-registry',
      sectionId: 'manual-section:opensphere-docs/constitution-0002-registry#registry-api',
      title: 'Search the canonical OpenSphere catalog projection',
      intent: 'inspect',
      toolId: 'oaa.catalog.entities.list',
      controlPlane: 'opensphere-console-backend',
      riskLevel: 'read',
      confirmation: 'none',
      requiredInputs: bindingInput({ filter: 'optional catalog filter', limit: '1..100' }),
      permission: { roles: ['authenticated'], scopes: ['oaa:system:read'] },
      audit: { eventType: 'catalog-entities-read', targetTemplate: 'opensphere/catalog' },
      citations: [{ sourceId: 'opensphere-docs/constitution-0002-registry', sourcePath: '_DOCS_/01-CONSTITUTION/CONSTITUTION-0002-레지스트리.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:registry-read',
      namespace: 'opensphere', sourceId: 'opensphere-docs/constitution-0002-registry',
      sectionId: 'manual-section:opensphere-docs/constitution-0002-registry#registry-api',
      title: 'Read the canonical Main Shell Registry projection', intent: 'inspect-registry',
      toolId: 'oaa.registry.read', controlPlane: 'dupa-registry-owner-facade',
      riskLevel: 'read', confirmation: 'none', requiredInputs: bindingInput({}),
      permission: { roles: ['authenticated'], scopes: ['oaa:system:read'] },
      audit: { eventType: 'registry-read', targetTemplate: 'opensphere/registry' },
      citations: [{ sourceId: 'opensphere-docs/constitution-0002-registry', sourcePath: '_DOCS_/01-CONSTITUTION/CONSTITUTION-0002-레지스트리.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:foundation-status',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#foundation-owner-control',
      title: 'Read the Foundation models, claims, bindings, and controller readiness', intent: 'inspect-foundation',
      toolId: 'oaa.foundation.status', controlPlane: 'foundation-owner-facade',
      riskLevel: 'read', confirmation: 'none', requiredInputs: bindingInput({}),
      permission: { roles: ['authenticated'], scopes: ['oaa:system:read'] },
      audit: { eventType: 'foundation-status-read', targetTemplate: 'Foundation/control-plane' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:foundation-engine-lifecycle',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#foundation-owner-control',
      title: 'Enable or disable one closed-catalog Foundation engine', intent: 'manage-foundation-engine',
      toolId: 'oaa.foundation.engine.lifecycle', controlPlane: 'foundation-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: '<action> Foundation engine <engine>',
      requiredInputs: bindingInput({ engine: OAA_FOUNDATION_ENGINES.join(' | '), action: 'enable | disable', reason: 'human management reason (8+ chars)', confirm: '<action> Foundation engine <engine>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:action:execute:high'] },
      audit: { eventType: 'foundation-engine-lifecycle', targetTemplate: 'FoundationModel/<model>/engine/<engine>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:foundation-claim-create',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#foundation-owner-control',
      title: 'Create a parameter-free Foundation consumer claim from the closed model catalog', intent: 'create-foundation-claim',
      toolId: 'oaa.foundation.claim.create', controlPlane: 'foundation-owner-facade',
      riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'create Foundation claim <name> for <model>',
      requiredInputs: bindingInput({ name: 'claim name', model: OAA_FOUNDATION_MODELS.join(' | '), reason: 'human management reason (8+ chars)', confirm: 'create Foundation claim <name> for <model>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:action:execute:high'], namespaceScope: ['opensphere-foundation'] },
      audit: { eventType: 'foundation-claim-create', targetTemplate: 'FoundationClaim/opensphere-foundation/<name>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:foundation-claim-release',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#foundation-owner-control',
      title: 'Release a Foundation consumer claim through its finalizer-backed owner contract', intent: 'release-foundation-claim',
      toolId: 'oaa.foundation.claim.release', controlPlane: 'foundation-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'release Foundation claim <name>',
      requiredInputs: bindingInput({ name: 'claim name', reason: 'human management reason (8+ chars)', confirm: 'release Foundation claim <name>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:action:execute:high'], namespaceScope: ['opensphere-foundation'] },
      audit: { eventType: 'foundation-claim-release', targetTemplate: 'FoundationClaim/opensphere-foundation/<name>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:foundation-identity-directory-claim-create',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#foundation-owner-control',
      title: 'Create a typed Samba-AD IdentityDirectory consumer claim', intent: 'create-identity-directory-claim',
      toolId: 'oaa.foundation.identity-directory.claim.create', controlPlane: 'foundation-owner-facade',
      riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'create IdentityDirectory claim <name>',
      requiredInputs: bindingInput({ name: 'claim name', reason: 'human management reason (8+ chars)', confirm: 'create IdentityDirectory claim <name>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:action:execute:high'], namespaceScope: ['opensphere-foundation'] },
      audit: { eventType: 'identity-directory-claim-create', targetTemplate: 'IdentityDirectoryClaim/opensphere-foundation/<name>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:foundation-identity-directory-claim-release',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#foundation-owner-control',
      title: 'Release a typed IdentityDirectory claim through its finalizer-backed owner contract', intent: 'release-identity-directory-claim',
      toolId: 'oaa.foundation.identity-directory.claim.release', controlPlane: 'foundation-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'release IdentityDirectory claim <name>',
      requiredInputs: bindingInput({ name: 'claim name', reason: 'human management reason (8+ chars)', confirm: 'release IdentityDirectory claim <name>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:action:execute:high'], namespaceScope: ['opensphere-foundation'] },
      audit: { eventType: 'identity-directory-claim-release', targetTemplate: 'IdentityDirectoryClaim/opensphere-foundation/<name>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:platform-readiness-preflight',
      namespace: 'opensphere', sourceId: 'opensphere-docs/platform-bootstrap-lifecycle',
      sectionId: 'manual-section:opensphere-docs/platform-bootstrap-lifecycle#platform-support-profile',
      title: 'Declare and re-evaluate the Platform Support Profile', intent: 'preflight-platform',
      toolId: 'oaa.platform.readiness.preflight', controlPlane: 'console-lifecycle-owner-facade',
      riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'run platform readiness preflight',
      requiredInputs: bindingInput({ reason: 'human management reason (8+ chars)', confirm: 'run platform readiness preflight' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:action:execute:high'] },
      audit: { eventType: 'platform-readiness-preflight', targetTemplate: 'PlatformSupportProfile/default' },
      citations: [{ sourceId: 'opensphere-docs/platform-bootstrap-lifecycle', sourcePath: '_DOCS_/01-CONSTITUTION/CONSTITUTION-0004-PLATFORM-BOOTSTRAP-SUPPORT-FOUNDATION-LIFECYCLE.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:platform-readiness-verify',
      namespace: 'opensphere', sourceId: 'opensphere-docs/platform-bootstrap-lifecycle',
      sectionId: 'manual-section:opensphere-docs/platform-bootstrap-lifecycle#platform-support-profile',
      title: 'Verify current support evidence and persist Platform Support status', intent: 'verify-platform',
      toolId: 'oaa.platform.readiness.verify', controlPlane: 'console-lifecycle-owner-facade',
      riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'verify platform support profile',
      requiredInputs: bindingInput({ reason: 'human management reason (8+ chars)', confirm: 'verify platform support profile' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:action:execute:high'] },
      audit: { eventType: 'platform-readiness-verify', targetTemplate: 'PlatformSupportProfile/default' },
      citations: [{ sourceId: 'opensphere-docs/platform-bootstrap-lifecycle', sourcePath: '_DOCS_/01-CONSTITUTION/CONSTITUTION-0004-PLATFORM-BOOTSTRAP-SUPPORT-FOUNDATION-LIFECYCLE.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:extension-lifecycle',
      namespace: 'opensphere', sourceId: 'opensphere-docs/constitution-0003-shell-hosting',
      sectionId: 'manual-section:opensphere-docs/constitution-0003-shell-hosting#consumer-lifecycle',
      title: 'Change one registered extension lifecycle state', intent: 'manage-extension',
      toolId: 'oaa.extension.lifecycle', controlPlane: 'dupa-extension-host-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'extension <action> <id>',
      requiredInputs: bindingInput({ id: 'registered extension id', action: OAA_EXTENSION_LIFECYCLE_ACTIONS.join(' | '), reason: 'human management reason (8+ chars)', confirm: 'extension <action> <id>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:action:execute:high'] },
      audit: { eventType: 'extension-lifecycle', targetTemplate: 'UIPluginRegistration/<id>' },
      citations: [{ sourceId: 'opensphere-docs/constitution-0003-shell-hosting', sourcePath: '_DOCS_/01-CONSTITUTION/CONSTITUTION-0003-SHELL-HOSTING-INTEGRATION.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:extension-security-status',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Read the append-only Extension image revocation ledger', intent: 'inspect-extension-security',
      toolId: 'oaa.extension.security.status', controlPlane: 'dupa-extension-security-owner-facade',
      riskLevel: 'read', confirmation: 'none', requiredInputs: bindingInput({}),
      permission: { roles: [CONSOLE_ADMIN_GROUP, 'console-operators'], scopes: ['console:extension:security:read'] },
      audit: { eventType: 'extension-security-status', targetTemplate: 'ExtensionSecurity/revocations' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:extension-image-inspect',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Inspect one exact-digest Extension image and its signed supply-chain evidence', intent: 'inspect-extension-image',
      toolId: 'oaa.extension.image.inspect', controlPlane: 'dupa-extension-security-owner-facade',
      riskLevel: 'read', confirmation: 'none',
      requiredInputs: bindingInput({ image: 'ghcr.io/opensphere-platform/<repository>@sha256:<64 hex>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP, 'console-operators'], scopes: ['console:extension:security:read'] },
      audit: { eventType: 'extension-image-inspect', targetTemplate: 'OCIImage/<image>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:extension-image-revoke',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Append one exact-digest Extension image revocation', intent: 'revoke-extension-image',
      toolId: 'oaa.extension.image.revoke', controlPlane: 'dupa-extension-security-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'revoke extension image <image>',
      requiredInputs: bindingInput({ image: 'exact digest image', replacementImage: 'optional exact digest in the same repository', reason: 'human management reason (8+ chars)', confirm: 'revoke extension image <image>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:extension:security:manage'] },
      audit: { eventType: 'extension-image-revoke', targetTemplate: 'OCIImage/<image>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:notification-status',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Read sanitized Notification channels, rules, and delivery status', intent: 'inspect-notifications',
      toolId: 'oaa.notification.status', controlPlane: 'console-notification-owner-facade',
      riskLevel: 'read', confirmation: 'none', requiredInputs: bindingInput({ limit: '1..100 deliveries' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP, 'console-operators'], scopes: ['console:notification:read'] },
      audit: { eventType: 'notification-owner-status', targetTemplate: 'NotificationDelivery/all' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:notification-channel-enabled',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Enable or disable one configured Notification channel', intent: 'set-notification-channel-enabled',
      toolId: 'oaa.notification.channel.enabled', controlPlane: 'console-notification-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: '<verb> notification channel <channelId>',
      requiredInputs: bindingInput({ channelId: 'Notification channel UUID', enabled: 'true | false', reason: 'human management reason (8+ chars)', confirm: '<enable|disable> notification channel <channelId>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:notification:manage'] },
      audit: { eventType: 'notification-channel-enabled', targetTemplate: 'NotificationChannel/<channelId>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:notification-channel-test',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Send one test through a configured Notification channel', intent: 'test-notification-channel',
      toolId: 'oaa.notification.channel.test', controlPlane: 'console-notification-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'test notification channel <channelId>',
      requiredInputs: bindingInput({ channelId: 'Notification channel UUID', reason: 'human management reason (8+ chars)', confirm: 'test notification channel <channelId>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:notification:manage'] },
      audit: { eventType: 'notification-channel-test', targetTemplate: 'NotificationChannel/<channelId>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:notification-delivery-retry',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Retry one failed or dead-letter Notification delivery', intent: 'retry-notification-delivery',
      toolId: 'oaa.notification.delivery.retry', controlPlane: 'console-notification-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'retry notification delivery <deliveryId>',
      requiredInputs: bindingInput({ deliveryId: 'Notification delivery UUID', reason: 'human management reason (8+ chars)', confirm: 'retry notification delivery <deliveryId>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:notification:manage'] },
      audit: { eventType: 'notification-delivery-retry', targetTemplate: 'NotificationDelivery/<deliveryId>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:his-observability-config',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Read the current managed HIS Observability configuration', intent: 'inspect-his-observability-config',
      toolId: 'oaa.his.observability.config', controlPlane: 'cluster-manager-his-owner-facade',
      riskLevel: 'read', confirmation: 'none', requiredInputs: bindingInput({}),
      permission: { roles: [CONSOLE_ADMIN_GROUP, 'console-operators'], scopes: ['console:his:read'] },
      audit: { eventType: 'his-observability-config-read', targetTemplate: 'HIS/kube-prometheus-stack' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:his-observability-plan',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Plan a closed-schema HIS Observability configuration change', intent: 'plan-his-observability',
      toolId: 'oaa.his.observability.plan', controlPlane: 'cluster-manager-his-owner-facade',
      riskLevel: 'read', confirmation: 'none', requiredInputs: bindingInput({ config: 'complete SecretRef-only Observability configuration' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP, 'console-operators'], scopes: ['console:his:read'] },
      audit: { eventType: 'his-observability-plan', targetTemplate: 'HIS/kube-prometheus-stack' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:his-observability-configure',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Apply a planned HIS Observability configuration', intent: 'configure-his-observability',
      toolId: 'oaa.his.observability.configure', controlPlane: 'cluster-manager-his-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'configure HIS observability public=<public> data-reset=<resetData>',
      requiredInputs: bindingInput({ config: 'complete SecretRef-only Observability configuration', resetData: 'boolean matching the owner plan', reason: 'human management reason (8+ chars)', confirm: 'configure HIS observability public=<public> data-reset=<resetData>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:his:manage'] },
      audit: { eventType: 'his-observability-configure', targetTemplate: 'HIS/kube-prometheus-stack' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:his-validate',
      namespace: 'opensphere', sourceId: 'opensphere-docs/platform-bootstrap-lifecycle',
      sectionId: 'manual-section:opensphere-docs/platform-bootstrap-lifecycle#his-preflight',
      title: 'Run a closed-catalog HIS canary validation', intent: 'validate-his',
      toolId: 'oaa.his.validate', controlPlane: 'cluster-manager-his-owner-facade',
      riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'validate HIS <id>',
      requiredInputs: bindingInput({ id: OAA_HIS_VALIDATION_IDS.join(' | '), reason: 'human management reason (8+ chars)', confirm: 'validate HIS <id>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:action:execute:high'] },
      audit: { eventType: 'his-canary-validation', targetTemplate: 'HIS/<id>' },
      citations: [{ sourceId: 'opensphere-docs/platform-bootstrap-lifecycle', sourcePath: '_DOCS_/01-CONSTITUTION/CONSTITUTION-0004-PLATFORM-BOOTSTRAP-SUPPORT-FOUNDATION-LIFECYCLE.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:his-lifecycle',
      namespace: 'opensphere', sourceId: 'opensphere-docs/platform-bootstrap-lifecycle',
      sectionId: 'manual-section:opensphere-docs/platform-bootstrap-lifecycle#his-preflight',
      title: 'Operate one closed-catalog HelmManaged HIS add-on', intent: 'manage-his',
      toolId: 'oaa.his.lifecycle', controlPlane: 'cluster-manager-his-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: '<action> HIS <id><revisionSuffix>',
      requiredInputs: bindingInput({ id: OAA_HIS_MANAGED_IDS.join(' | '), action: OAA_HIS_LIFECYCLE_ACTIONS.join(' | '), revision: 'required for rollback', reason: 'human management reason (8+ chars)', confirm: '<action> HIS <id> [to revision <revision>]' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:action:execute:high'] },
      audit: { eventType: 'his-lifecycle', targetTemplate: 'HIS/<id>' },
      citations: [{ sourceId: 'opensphere-docs/platform-bootstrap-lifecycle', sourcePath: '_DOCS_/01-CONSTITUTION/CONSTITUTION-0004-PLATFORM-BOOTSTRAP-SUPPORT-FOUNDATION-LIFECYCLE.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:ceph-status',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Read external Ceph connection and runtime prerequisite status', intent: 'inspect-ceph',
      toolId: 'oaa.ceph.status', controlPlane: 'cluster-manager-ceph-owner-facade',
      riskLevel: 'read', confirmation: 'none', requiredInputs: bindingInput({}),
      permission: { roles: [CONSOLE_ADMIN_GROUP, 'console-operators'], scopes: ['console:ceph:read'] },
      audit: { eventType: 'ceph-external-status', targetTemplate: 'CephExternal/rook-ceph' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:ceph-plan',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Plan an external Ceph connection from an owner-staged SecretRef', intent: 'plan-ceph-connect',
      toolId: 'oaa.ceph.plan', controlPlane: 'cluster-manager-ceph-owner-facade',
      riskLevel: 'read', confirmation: 'none', requiredInputs: bindingInput({ importRef: 'opensphere-ceph-imports/opensphere-ceph-import-<uuid>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP, 'console-operators'], scopes: ['console:ceph:read'] },
      audit: { eventType: 'ceph-external-plan', targetTemplate: 'CephExternal/rook-ceph' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:ceph-connect',
      namespace: 'opensphere', sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#existing-owner-api-conversational-control-coverage',
      title: 'Connect external Ceph from an owner-staged SecretRef', intent: 'connect-ceph',
      toolId: 'oaa.ceph.connect', controlPlane: 'cluster-manager-ceph-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'connect Ceph external storage using <importRef>',
      requiredInputs: bindingInput({ importRef: 'opensphere-ceph-imports/opensphere-ceph-import-<uuid>', reason: 'human management reason (8+ chars)', confirm: 'connect Ceph external storage using <importRef>' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:ceph:manage'] },
      audit: { eventType: 'ceph-external-connect', targetTemplate: 'CephExternal/rook-ceph' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    }),
    mk({
      id: 'manual-action:opensphere:ceph-disconnect',
      namespace: 'opensphere', sourceId: 'opensphere-docs/platform-bootstrap-lifecycle',
      sectionId: 'manual-section:opensphere-docs/platform-bootstrap-lifecycle#external-ceph',
      title: 'Disconnect the managed external Ceph consumer integration while retaining remote data', intent: 'disconnect-ceph',
      toolId: 'oaa.ceph.disconnect', controlPlane: 'cluster-manager-ceph-owner-facade',
      riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'disconnect Ceph external storage',
      requiredInputs: bindingInput({ reason: 'human management reason (8+ chars)', confirm: 'disconnect Ceph external storage' }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['console:ceph:manage'] },
      audit: { eventType: 'ceph-external-disconnect', targetTemplate: 'CephExternal/rook-ceph' },
      citations: [{ sourceId: 'opensphere-docs/platform-bootstrap-lifecycle', sourcePath: '_DOCS_/01-CONSTITUTION/CONSTITUTION-0004-PLATFORM-BOOTSTRAP-SUPPORT-FOUNDATION-LIFECYCLE.md' }],
    }),
    ...[
      ['workload-restart', 'Restart an allowlisted Kubernetes workload', 'restart', 'oaa.k8s.workload.restart', 'high', 'restart <kind> <namespace>/<name>', { kind: OAA_WORKLOAD_KINDS.join(' | '), namespace: OAA_MUTATION_NAMESPACES.join(' | '), name: 'workload name' }],
      ['workload-scale', 'Scale an allowlisted Kubernetes workload', 'scale', 'oaa.k8s.workload.scale', 'high', 'scale <kind> <namespace>/<name> to <replicas>', { kind: OAA_SCALABLE_WORKLOAD_KINDS.join(' | '), namespace: OAA_MUTATION_NAMESPACES.join(' | '), name: 'workload name', replicas: `0..${OAA_SCALE_MAX}` }],
      ['workload-update-image', 'Update a workload container to a digest-pinned image', 'update', 'oaa.k8s.workload.update-image', 'high', 'update image <kind> <namespace>/<name> container <container> to <image>', { kind: OAA_WORKLOAD_KINDS.join(' | '), namespace: OAA_MUTATION_NAMESPACES.join(' | '), name: 'workload name', container: 'container name', image: 'repository@sha256:<64 hex>' }],
      ['workload-rollback-image', 'Rollback a workload container to a reviewed digest-pinned image', 'rollback', 'oaa.k8s.workload.rollback-image', 'critical', 'rollback image <kind> <namespace>/<name> container <container> to <image>', { kind: OAA_WORKLOAD_KINDS.join(' | '), namespace: OAA_MUTATION_NAMESPACES.join(' | '), name: 'workload name', container: 'container name', image: 'repository@sha256:<64 hex>', rollbackOf: 'prior change request UUID' }],
      ['resource-apply', 'Apply an allowlisted Kubernetes desired-state manifest', 'apply', 'oaa.k8s.resource.apply', 'high', 'apply <kind> <namespace>/<name>', { kind: OAA_APPLY_RESOURCE_KINDS.join(' | '), namespace: OAA_MUTATION_NAMESPACES.join(' | '), name: 'resource name', manifest: 'allowlisted Kubernetes JSON manifest' }],
      ['resource-delete', 'Delete an allowlisted Kubernetes resource with recovery evidence', 'delete', 'oaa.k8s.resource.delete', 'critical', 'delete <kind> <namespace>/<name>', { kind: OAA_DELETE_RESOURCE_KINDS.join(' | '), namespace: OAA_MUTATION_NAMESPACES.join(' | '), name: 'resource name', impact: 'impact assessment', recoveryPlan: 'tested recovery plan', backupReference: 'backup or not-applicable rationale' }],
      ['cronjob-run', 'Run an idempotent one-off Job from a CronJob', 'run', 'oaa.k8s.cronjob.run', 'high', 'run cronjob <namespace>/<name>', { namespace: OAA_MUTATION_NAMESPACES.join(' | '), name: 'CronJob name' }],
      ['cronjob-suspend', 'Suspend or resume a CronJob', 'configure', 'oaa.k8s.cronjob.suspend', 'high', 'set cronjob <namespace>/<name> suspend <suspend>', { namespace: OAA_MUTATION_NAMESPACES.join(' | '), name: 'CronJob name', suspend: 'true | false' }],
    ].map(([suffix, title, intent, toolId, riskLevel, confirmationTemplate, inputs]) => mk({
      id: `manual-action:opensphere:k8s-${suffix}`,
      namespace: 'opensphere',
      sourceId: 'console-docs/oaa-control-plane-assessment',
      sectionId: 'manual-section:console-docs/oaa-control-plane-assessment#target-control-contract',
      title, intent, toolId,
      controlPlane: 'gitea-declarative-change+oaa-governed-adapter',
      riskLevel, confirmation: 'required', confirmationTemplate,
      requiredInputs: bindingInput({ ...inputs, reason: 'human management reason (8+ chars)', confirm: confirmationTemplate }),
      permission: { roles: [CONSOLE_ADMIN_GROUP], scopes: ['oaa:action:execute:high'], namespaceScope: OAA_MUTATION_NAMESPACES },
      audit: { eventType: toolId, targetTemplate: '<namespace>/<kind>/<name>' },
      citations: [{ sourceId: 'console-docs/oaa-control-plane-assessment', sourcePath: 'OpenSphere-console/docs/OAA-CONTROL-PLANE-ASSESSMENT-2026-07-23.md' }],
    })),
  ];
  return {
    schema: 'oaa-action-bindings.opensphere.io/v1alpha1',
    service: 'opensphere-console-oaa-gateway',
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
  const mutationNsField = { type: 'string', enum: OAA_MUTATION_NAMESPACES, description: 'Allowlisted Console mutation namespace' };
  const deploymentField = { type: 'string', pattern: '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' };
  const podField = { type: 'string', pattern: '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' };
  const confirmField = { type: 'string', description: 'Exact confirmation phrase required by the action' };
  return {
    schema: 'oaa-tool-manifest.opensphere.io/v1alpha1',
    service: 'opensphere-console-oaa-gateway',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    allowedNamespaces: nsEnum,
    mutationNamespaces: OAA_MUTATION_NAMESPACES,
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
        id: 'oaa.control-plane.status',
        name: 'Read OpenSphere control-plane authorities and lifecycle status',
        channel: 'api',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/control-plane/status'),
        riskLevel: 'read',
        confirmation: 'none',
        inputSchema: schemaObject({}),
        auditEventType: 'control-plane-status',
      },
      {
        id: 'oaa.identity.status',
        name: 'Read the sanitized Console user and role inventory',
        channel: 'owner-control-plane',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/identity/status'),
        riskLevel: 'read',
        confirmation: 'none',
        inputSchema: schemaObject({}),
        auditEventType: 'identity-owner-status',
      },
      {
        id: 'oaa.identity.user.create',
        name: 'Create a Console user through the Supabase identity owner',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'create Console user <username>',
        inputSchema: schemaObject({
          email: { type: 'string', minLength: 3, maxLength: 254 },
          username: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{1,63}$' },
          displayName: { type: 'string', minLength: 1, maxLength: 120 },
          roles: { type: 'array', maxItems: 3, uniqueItems: true, items: { type: 'string', enum: OAA_CONSOLE_ROLES } },
          confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'oaa-identity-user-create',
      },
      {
        id: 'oaa.identity.user.enabled',
        name: 'Enable or disable a Console user with administrator-continuity protection',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: '<verb> Console user <userId>',
        inputSchema: schemaObject({
          userId: { type: 'string', pattern: UUID_RE.source }, enabled: { type: 'boolean' },
          confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'oaa-identity-user-enabled',
      },
      {
        id: 'oaa.identity.role.membership',
        name: 'Add or remove one canonical Console role',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: '<operation> Console role <role> for user <userId>',
        inputSchema: schemaObject({
          userId: { type: 'string', pattern: UUID_RE.source },
          role: { type: 'string', enum: OAA_CONSOLE_ROLES },
          operation: { type: 'string', enum: ['add', 'remove'] },
          confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'oaa-identity-role-membership',
      },
      {
        id: 'oaa.evidence.status',
        name: 'Read correlated OAA agent and retention evidence',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/evidence/status'),
        riskLevel: 'read', confirmation: 'none', inputSchema: schemaObject({}),
        auditEventType: 'oaa-evidence-status',
      },
      {
        id: 'oaa.evidence.retention.update',
        name: 'Update one OAA evidence retention or legal-hold policy',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'update OAA evidence retention <stream> to <retentionDays> days',
        inputSchema: schemaObject({
          stream: { type: 'string', enum: OAA_EVIDENCE_STREAMS },
          retentionDays: { type: 'integer', minimum: 30, maximum: 3650 },
          disposition: { type: 'string', enum: ['retain', 'export-before-delete'] },
          legalHold: { type: 'boolean' }, confirm: confirmField,
          reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'oaa-evidence-retention-update',
      },
      {
        id: 'oaa.recovery.status',
        name: 'Read sanitized Supabase, Storage, and Gitea recovery evidence',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/recovery/status'),
        riskLevel: 'read', confirmation: 'none', inputSchema: schemaObject({}),
        auditEventType: 'recovery-owner-status',
      },
      {
        id: 'oaa.recovery.plan',
        name: 'Plan an isolated non-destructive recovery drill',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/recovery/plan'),
        riskLevel: 'read', confirmation: 'none',
        inputSchema: schemaObject({ component: { type: 'string', enum: OAA_RECOVERY_COMPONENTS } }),
        auditEventType: 'recovery-owner-plan',
      },
      {
        id: 'oaa.observability.logs.query',
        name: 'Query redacted centralized logs through the HIS owner API',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/observability/logs'),
        riskLevel: 'read', confirmation: 'none',
        inputSchema: schemaObject({
          template: { type: 'string', enum: ['service.recent', 'service.errors', 'namespace.recent'] },
          service: { type: 'string', required: false }, namespace: { type: 'string', required: false },
          sinceMinutes: { type: 'integer', minimum: 1, maximum: 1440, required: false },
          limit: { type: 'integer', minimum: 1, maximum: 200, required: false },
        }),
        auditEventType: 'his-observability-logs-query',
      },
      {
        id: 'oaa.observability.traces.query',
        name: 'Query sanitized distributed traces through the HIS owner API',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/observability/traces'),
        riskLevel: 'read', confirmation: 'none',
        inputSchema: schemaObject({
          template: { type: 'string', enum: ['trace.by_id', 'service.recent'] },
          traceId: { type: 'string', pattern: '^[a-fA-F0-9]{32}$', required: false }, service: { type: 'string', required: false },
          sinceMinutes: { type: 'integer', minimum: 1, maximum: 1440, required: false },
          limit: { type: 'integer', minimum: 1, maximum: 100, required: false },
        }),
        auditEventType: 'his-observability-traces-query',
      },
      {
        id: 'oaa.catalog.entities.list',
        name: 'Search the canonical OpenSphere catalog projection',
        channel: 'api',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/catalog/entities'),
        riskLevel: 'read',
        confirmation: 'none',
        inputSchema: schemaObject({
          filter: { type: 'string', required: false, maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 100, required: false },
        }),
        auditEventType: 'catalog-entities-read',
      },
      {
        id: 'oaa.registry.read',
        name: 'Read the Main Shell canonical Registry projection',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/registry'),
        riskLevel: 'read', confirmation: 'none', inputSchema: schemaObject({}),
        auditEventType: 'registry-read',
      },
      {
        id: 'oaa.foundation.status',
        name: 'Read Foundation owner models, claims, bindings, and controller readiness',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/foundation/status'),
        riskLevel: 'read', confirmation: 'none', inputSchema: schemaObject({}),
        auditEventType: 'foundation-status-read',
      },
      {
        id: 'oaa.foundation.engine.lifecycle',
        name: 'Enable or disable one closed-catalog Foundation engine',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: '<action> Foundation engine <engine>',
        inputSchema: schemaObject({
          engine: { type: 'string', enum: OAA_FOUNDATION_ENGINES },
          action: { type: 'string', enum: ['enable', 'disable'] },
          confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'foundation-engine-lifecycle',
      },
      {
        id: 'oaa.foundation.claim.create',
        name: 'Create a parameter-free Foundation claim from the closed model catalog',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'create Foundation claim <name> for <model>',
        inputSchema: schemaObject({
          name: deploymentField, model: { type: 'string', enum: OAA_FOUNDATION_MODELS },
          confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'foundation-claim-create',
      },
      {
        id: 'oaa.foundation.claim.release',
        name: 'Release a Foundation claim through the finalizer-backed owner contract',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'release Foundation claim <name>',
        inputSchema: schemaObject({
          name: deploymentField, confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'foundation-claim-release',
      },
      {
        id: 'oaa.foundation.identity-directory.claim.create',
        name: 'Create a typed Samba-AD IdentityDirectory claim',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'create IdentityDirectory claim <name>',
        inputSchema: schemaObject({
          name: deploymentField, confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'identity-directory-claim-create',
      },
      {
        id: 'oaa.foundation.identity-directory.claim.release',
        name: 'Release a typed IdentityDirectory claim through its owner contract',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'release IdentityDirectory claim <name>',
        inputSchema: schemaObject({
          name: deploymentField, confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'identity-directory-claim-release',
      },
      {
        id: 'oaa.platform.readiness.preflight',
        name: 'Declare and re-evaluate Platform Support Profile readiness',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'run platform readiness preflight',
        inputSchema: schemaObject({ confirm: confirmField, reason: { type: 'string' } }),
        auditEventType: 'platform-readiness-preflight',
      },
      {
        id: 'oaa.platform.readiness.verify',
        name: 'Verify and persist current Platform Support Profile evidence',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'verify platform support profile',
        inputSchema: schemaObject({ confirm: confirmField, reason: { type: 'string' } }),
        auditEventType: 'platform-readiness-verify',
      },
      {
        id: 'oaa.extension.lifecycle',
        name: 'Operate one registered Extension Host lifecycle',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'extension <action> <id>',
        inputSchema: schemaObject({ id: deploymentField, action: { type: 'string', enum: OAA_EXTENSION_LIFECYCLE_ACTIONS }, confirm: confirmField, reason: { type: 'string' } }),
        auditEventType: 'extension-lifecycle',
      },
      {
        id: 'oaa.extension.security.status',
        name: 'Read the append-only Extension image revocation ledger',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/extensions/security'),
        riskLevel: 'read', confirmation: 'none', inputSchema: schemaObject({}),
        auditEventType: 'extension-security-status',
      },
      {
        id: 'oaa.extension.image.inspect',
        name: 'Inspect an exact-digest Extension image and signed supply-chain evidence',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/extensions/inspect'),
        riskLevel: 'read', confirmation: 'none',
        inputSchema: schemaObject({ image: { type: 'string', pattern: OAA_EXTENSION_IMAGE_RE.source } }),
        auditEventType: 'extension-image-inspect',
      },
      {
        id: 'oaa.extension.image.revoke',
        name: 'Append an exact-digest Extension image revocation',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'revoke extension image <image>',
        inputSchema: schemaObject({
          image: { type: 'string', pattern: OAA_EXTENSION_IMAGE_RE.source },
          replacementImage: { type: 'string', pattern: OAA_EXTENSION_IMAGE_RE.source, required: false },
          confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'extension-image-revoke',
      },
      {
        id: 'oaa.notification.status',
        name: 'Read sanitized Notification channels, rules, and deliveries',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/notifications/status'),
        riskLevel: 'read', confirmation: 'none',
        inputSchema: schemaObject({ limit: { type: 'integer', minimum: 1, maximum: 100, required: false } }),
        auditEventType: 'notification-owner-status',
      },
      {
        id: 'oaa.notification.channel.enabled',
        name: 'Enable or disable one configured Notification channel',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: '<verb> notification channel <channelId>',
        inputSchema: schemaObject({
          channelId: { type: 'string', pattern: UUID_RE.source }, enabled: { type: 'boolean' },
          confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'notification-channel-enabled',
      },
      {
        id: 'oaa.notification.channel.test',
        name: 'Send one test through a configured Notification channel',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'test notification channel <channelId>',
        inputSchema: schemaObject({
          channelId: { type: 'string', pattern: UUID_RE.source },
          confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'notification-channel-test',
      },
      {
        id: 'oaa.notification.delivery.retry',
        name: 'Retry one failed or dead-letter Notification delivery',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'retry notification delivery <deliveryId>',
        inputSchema: schemaObject({
          deliveryId: { type: 'string', pattern: UUID_RE.source },
          confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'notification-delivery-retry',
      },
      {
        id: 'oaa.his.observability.config',
        name: 'Read the current managed HIS Observability configuration',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/his/observability/config'),
        riskLevel: 'read', confirmation: 'none', inputSchema: schemaObject({}),
        auditEventType: 'his-observability-config-read',
      },
      {
        id: 'oaa.his.observability.plan',
        name: 'Plan a complete SecretRef-only HIS Observability configuration',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/his/observability/plan'),
        riskLevel: 'read', confirmation: 'none',
        inputSchema: schemaObject({ config: hisObservabilityConfigSchema() }),
        auditEventType: 'his-observability-plan',
      },
      {
        id: 'oaa.his.observability.configure',
        name: 'Apply a planned HIS Observability configuration through its owner',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'configure HIS observability public=<public> data-reset=<resetData>',
        inputSchema: schemaObject({
          config: hisObservabilityConfigSchema(), resetData: { type: 'boolean' },
          confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'his-observability-configure',
      },
      {
        id: 'oaa.his.validate',
        name: 'Run a closed-catalog HIS canary validation',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'validate HIS <id>',
        inputSchema: schemaObject({ id: { type: 'string', enum: OAA_HIS_VALIDATION_IDS }, confirm: confirmField, reason: { type: 'string' } }),
        auditEventType: 'his-canary-validation',
      },
      {
        id: 'oaa.his.lifecycle',
        name: 'Operate one closed-catalog HelmManaged HIS add-on',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: '<action> HIS <id><revisionSuffix>',
        inputSchema: schemaObject({
          id: { type: 'string', enum: OAA_HIS_MANAGED_IDS },
          action: { type: 'string', enum: OAA_HIS_LIFECYCLE_ACTIONS },
          revision: { type: 'integer', minimum: 1, required: false }, confirm: confirmField, reason: { type: 'string' },
        }),
        auditEventType: 'his-lifecycle',
      },
      {
        id: 'oaa.ceph.status',
        name: 'Read external Ceph connection and runtime prerequisite status',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/ceph/status'),
        riskLevel: 'read', confirmation: 'none', inputSchema: schemaObject({}),
        auditEventType: 'ceph-external-status',
      },
      {
        id: 'oaa.ceph.plan',
        name: 'Plan external Ceph from an owner-staged SecretRef',
        channel: 'owner-control-plane', readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/ceph/plan'),
        riskLevel: 'read', confirmation: 'none',
        inputSchema: schemaObject({ importRef: { type: 'string', pattern: OAA_CEPH_IMPORT_REF_RE.source } }),
        auditEventType: 'ceph-external-plan',
      },
      {
        id: 'oaa.ceph.connect',
        name: 'Connect external Ceph from an owner-staged SecretRef',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'connect Ceph external storage using <importRef>',
        inputSchema: schemaObject({
          importRef: { type: 'string', pattern: OAA_CEPH_IMPORT_REF_RE.source },
          confirm: confirmField, reason: { type: 'string', minLength: 8, maxLength: 500 },
        }),
        auditEventType: 'ceph-external-connect',
      },
      {
        id: 'oaa.ceph.disconnect',
        name: 'Disconnect managed external Ceph consumer resources while retaining remote data',
        channel: 'owner-control-plane', readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'disconnect Ceph external storage',
        inputSchema: schemaObject({ confirm: confirmField, reason: { type: 'string' } }),
        auditEventType: 'ceph-external-disconnect',
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
        id: 'oaa.k8s.resources.list',
        name: 'List sanitized Kubernetes operational resources',
        channel: 'kubernetes',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/k8s/resources'),
        riskLevel: 'read',
        confirmation: 'none',
        kubernetes: { verbs: ['get', 'list'], resources: RUNTIME_RESOURCE_KINDS, namespaces: nsEnum },
        inputSchema: schemaObject({
          kind: { type: 'string', enum: RUNTIME_RESOURCE_KINDS },
          namespace: { ...nsField, required: false },
          labelSelector: { type: 'string', required: false },
          limit: { type: 'integer', minimum: 1, maximum: 500, required: false },
        }),
        auditEventType: 'k8s-list-resources',
      },
      {
        id: 'oaa.k8s.resource.get',
        name: 'Read one sanitized Kubernetes operational resource',
        channel: 'kubernetes',
        readOnly: true,
        endpoint: toolEndpoint('POST', '/api/oaa/tools/k8s/resource'),
        riskLevel: 'read',
        confirmation: 'none',
        kubernetes: { verbs: ['get', 'list'], resources: RUNTIME_RESOURCE_KINDS, namespaces: nsEnum },
        inputSchema: schemaObject({
          kind: { type: 'string', enum: RUNTIME_RESOURCE_KINDS },
          namespace: { ...nsField, required: false },
          name: { type: 'string' },
        }),
        auditEventType: 'k8s-get-resource',
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
        name: 'Submit deployment restart to the Console control plane',
        channel: 'control-plane',
        readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high',
        confirmation: 'required',
        confirmationTemplate: 'restart deployment <namespace>/<deployment>',
        preflightToolIds: ['oaa.k8s.deployment.rollout'],
        kubernetes: { verbs: ['get'], apiGroups: ['apps'], resources: ['deployments'], namespaces: OAA_MUTATION_NAMESPACES },
        inputSchema: schemaObject({
          namespace: mutationNsField,
          name: deploymentField,
          confirm: confirmField,
          reason: { type: 'string', required: true },
        }),
        auditEventType: 'k8s-restart-deployment',
      },
      {
        id: 'oaa.k8s.deployment.scale',
        name: 'Submit deployment scale change to the Console control plane',
        channel: 'control-plane',
        readOnly: false,
        endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high',
        confirmation: 'required',
        confirmationTemplate: 'scale deployment <namespace>/<deployment> to <replicas>',
        preflightToolIds: ['oaa.k8s.deployment.rollout'],
        kubernetes: { verbs: ['get'], apiGroups: ['apps'], resources: ['deployments'], namespaces: OAA_MUTATION_NAMESPACES },
        inputSchema: schemaObject({
          namespace: mutationNsField,
          name: deploymentField,
          replicas: { type: 'integer', minimum: 0, maximum: OAA_SCALE_MAX },
          confirm: confirmField,
          reason: { type: 'string', required: true },
        }),
        auditEventType: 'k8s-scale-deployment',
      },
      {
        id: 'oaa.k8s.workload.restart',
        name: 'Submit an allowlisted workload restart',
        channel: 'control-plane', readOnly: false, endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'restart <kind> <namespace>/<name>',
        inputSchema: schemaObject({
          kind: { type: 'string', enum: OAA_WORKLOAD_KINDS }, namespace: mutationNsField, name: deploymentField,
          confirm: confirmField, reason: { type: 'string' },
        }), auditEventType: 'k8s-restart-workload',
      },
      {
        id: 'oaa.k8s.workload.scale',
        name: 'Submit an allowlisted workload scale change',
        channel: 'control-plane', readOnly: false, endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'scale <kind> <namespace>/<name> to <replicas>',
        inputSchema: schemaObject({
          kind: { type: 'string', enum: OAA_SCALABLE_WORKLOAD_KINDS }, namespace: mutationNsField, name: deploymentField,
          replicas: { type: 'integer', minimum: 0, maximum: OAA_SCALE_MAX }, confirm: confirmField, reason: { type: 'string' },
        }), auditEventType: 'k8s-scale-workload',
      },
      {
        id: 'oaa.k8s.workload.update-image',
        name: 'Submit a digest-pinned workload image update',
        channel: 'control-plane', readOnly: false, endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'update image <kind> <namespace>/<name> container <container> to <image>',
        inputSchema: schemaObject({
          kind: { type: 'string', enum: OAA_WORKLOAD_KINDS }, namespace: mutationNsField, name: deploymentField,
          container: deploymentField, image: { type: 'string' }, confirm: confirmField, reason: { type: 'string' },
        }), auditEventType: 'k8s-update-workload-image',
      },
      {
        id: 'oaa.k8s.workload.rollback-image',
        name: 'Submit a digest-pinned workload image rollback',
        channel: 'control-plane', readOnly: false, endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'rollback image <kind> <namespace>/<name> container <container> to <image>',
        inputSchema: schemaObject({
          kind: { type: 'string', enum: OAA_WORKLOAD_KINDS }, namespace: mutationNsField, name: deploymentField,
          container: deploymentField, image: { type: 'string' }, rollbackOf: { type: 'string' }, confirm: confirmField, reason: { type: 'string' },
        }), auditEventType: 'k8s-rollback-workload-image',
      },
      {
        id: 'oaa.k8s.resource.apply',
        name: 'Submit a declarative server-side apply for an allowlisted resource',
        channel: 'control-plane', readOnly: false, endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'apply <kind> <namespace>/<name>',
        inputSchema: schemaObject({
          kind: { type: 'string', enum: OAA_APPLY_RESOURCE_KINDS }, namespace: mutationNsField, name: deploymentField,
          manifest: { type: 'object' }, confirm: confirmField, reason: { type: 'string' },
        }), auditEventType: 'k8s-apply-resource',
      },
      {
        id: 'oaa.k8s.resource.delete',
        name: 'Submit a protected deletion for an allowlisted resource',
        channel: 'control-plane', readOnly: false, endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'critical', confirmation: 'required', confirmationTemplate: 'delete <kind> <namespace>/<name>',
        inputSchema: schemaObject({
          kind: { type: 'string', enum: OAA_DELETE_RESOURCE_KINDS }, namespace: mutationNsField, name: deploymentField,
          impact: { type: 'string' }, recoveryPlan: { type: 'string' }, backupReference: { type: 'string' },
          confirm: confirmField, reason: { type: 'string' },
        }), auditEventType: 'k8s-delete-resource',
      },
      {
        id: 'oaa.k8s.cronjob.run',
        name: 'Submit an idempotent one-off Job from a CronJob template',
        channel: 'control-plane', readOnly: false, endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'run cronjob <namespace>/<name>',
        inputSchema: schemaObject({ namespace: mutationNsField, name: deploymentField, confirm: confirmField, reason: { type: 'string' } }),
        auditEventType: 'k8s-run-cronjob',
      },
      {
        id: 'oaa.k8s.cronjob.suspend',
        name: 'Submit a CronJob suspend or resume change',
        channel: 'control-plane', readOnly: false, endpoint: toolEndpoint('POST', '/api/oaa/actions/bindings/execute'),
        riskLevel: 'high', confirmation: 'required', confirmationTemplate: 'set cronjob <namespace>/<name> suspend <suspend>',
        inputSchema: schemaObject({ namespace: mutationNsField, name: deploymentField, suspend: { type: 'boolean' }, confirm: confirmField, reason: { type: 'string' } }),
        auditEventType: 'k8s-suspend-cronjob',
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

function summarizeToolManifest(manifest = withMutationGate(oaaToolManifest())) {
  const lines = [
    `OAA tool manifest: ${manifest.schema}${manifest.storage ? ` (${manifest.storage})` : ''}`,
    `Mutation gate: ${manifest.mutationEnabled === false ? `closed (${manifest.mutationGateReason})` : 'open'}`,
    `Read namespaces: ${manifest.allowedNamespaces.join(', ')}`,
    `Mutation namespaces: ${(manifest.mutationNamespaces || []).join(', ')}`,
    `Scale max: ${manifest.scaleMax}`,
    'Tools:',
  ];
  for (const tool of manifest.tools) {
    lines.push(`- ${tool.id}: ${tool.readOnly ? 'read' : 'write'} ${tool.endpoint?.method || '-'} ${tool.endpoint?.path || '-'} confirmation=${tool.confirmation}`);
  }
  return lines.join('\n');
}

function summarizeActionBindings(manifest = withActionBindingMutationGate(oaaActionBindings(), oaaToolManifest())) {
  const lines = [
    `OAA action bindings: ${manifest.schema}${manifest.storage ? ` (${manifest.storage})` : ''}`,
    `Mutation gate: ${manifest.mutationEnabled === false ? `closed (${manifest.mutationGateReason})` : 'open'}`,
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

let toolSeedReady = false;
let toolSeedInflight = null;

// Concurrency-safe, idempotent "seed if absent" wrapper around seedToolRegistry, mirroring the
// manualSeedReady/manualSeedInflight pattern for the Manual Registry. seedToolRegistry itself is an
// unconditional upsert, so this guard is what keeps computeReadiness() from re-writing the tool
// registry on every /readyz probe once rows already exist, while still allowing self-healing
// reconciliation the first time rows are found missing (e.g. startup seed raced PostgreSQL).
async function ensureToolRegistryReady(actor = null) {
  await ensureKnowledgeSchema();
  const pool = getPgPool();
  if (!pool) return false;
  if (!toolSeedReady) {
    toolSeedInflight ||= seedToolRegistry(actor)
      .then((out) => {
        toolSeedReady = true;
        return out;
      })
      .finally(() => {
        toolSeedInflight = null;
      });
    await toolSeedInflight;
  }
  return true;
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
    service: 'opensphere-console-oaa-gateway',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    storage: 'postgres',
    bindings,
    invalidBindings: bindings.filter((b) => !b.valid).map((b) => ({ id: b.id, toolId: b.toolId })),
  };
}

async function gatedToolManifestFromStore() {
  return withMutationGate(await toolManifestFromStore());
}

async function gatedActionBindingsFromStore() {
  // Use the raw (unfiltered) tool manifest to resolve each binding's tool readOnly flag; the
  // gated/filtered manifest would already be missing write tools and could mask a mismatch.
  const rawToolManifest = await toolManifestFromStore();
  return withActionBindingMutationGate(await actionBindingsFromStore(), rawToolManifest);
}

const TOOL_PERMISSION = {
  'oaa.control-plane.status': 'console.git.change',
  'oaa.identity.status': 'console.identity.manage',
  'oaa.identity.user.create': 'console.identity.manage',
  'oaa.identity.user.enabled': 'console.identity.manage',
  'oaa.identity.role.membership': 'console.identity.manage',
  'oaa.evidence.status': 'oaa.evidence.read',
  'oaa.evidence.retention.update': 'oaa.evidence.manage',
  'oaa.recovery.status': 'console.recovery.read',
  'oaa.recovery.plan': 'console.recovery.read',
  'oaa.observability.logs.query': 'oaa.logs.read',
  'oaa.observability.traces.query': 'oaa.logs.read',
  'oaa.registry.read': 'oaa.system.read',
  'oaa.foundation.status': 'oaa.system.read',
  'oaa.knowledge.search': 'oaa.knowledge.read',
  'oaa.knowledge.ingest-manual': 'oaa.knowledge.manage',
  'oaa.k8s.logs.tail': 'oaa.logs.read',
  'oaa.k8s.deployment.restart': 'oaa.action.execute.high',
  'oaa.k8s.deployment.scale': 'oaa.action.execute.high',
  'oaa.k8s.workload.restart': 'oaa.action.execute.high',
  'oaa.k8s.workload.scale': 'oaa.action.execute.high',
  'oaa.k8s.workload.update-image': 'oaa.action.execute.high',
  'oaa.k8s.workload.rollback-image': 'oaa.action.execute.high',
  'oaa.k8s.resource.apply': 'oaa.action.execute.high',
  'oaa.k8s.resource.delete': 'oaa.action.execute.high',
  'oaa.k8s.cronjob.run': 'oaa.action.execute.high',
  'oaa.k8s.cronjob.suspend': 'oaa.action.execute.high',
  'oaa.platform.readiness.preflight': 'oaa.action.execute.high',
  'oaa.platform.readiness.verify': 'oaa.action.execute.high',
  'oaa.extension.lifecycle': 'oaa.action.execute.high',
  'oaa.extension.security.status': 'console.extension.security.read',
  'oaa.extension.image.inspect': 'console.extension.security.read',
  'oaa.extension.image.revoke': 'console.extension.security.manage',
  'oaa.notification.status': 'console.notification.read',
  'oaa.notification.channel.enabled': 'console.notification.manage',
  'oaa.notification.channel.test': 'console.notification.manage',
  'oaa.notification.delivery.retry': 'console.notification.manage',
  'oaa.his.validate': 'oaa.action.execute.high',
  'oaa.his.lifecycle': 'oaa.action.execute.high',
  'oaa.his.observability.config': 'console.his.read',
  'oaa.his.observability.plan': 'console.his.read',
  'oaa.his.observability.configure': 'console.his.manage',
  'oaa.ceph.status': 'console.ceph.read',
  'oaa.ceph.plan': 'console.ceph.read',
  'oaa.ceph.connect': 'console.ceph.manage',
  'oaa.ceph.disconnect': 'console.ceph.manage',
  'oaa.foundation.engine.lifecycle': 'oaa.action.execute.high',
  'oaa.foundation.claim.create': 'oaa.action.execute.high',
  'oaa.foundation.claim.release': 'oaa.action.execute.high',
  'oaa.foundation.identity-directory.claim.create': 'oaa.action.execute.high',
  'oaa.foundation.identity-directory.claim.release': 'oaa.action.execute.high',
};

function requiredPermissionForTool(tool) {
  if (TOOL_PERMISSION[tool.id]) return TOOL_PERMISSION[tool.id];
  return tool.readOnly === false ? 'oaa.action.execute.low' : 'oaa.system.read';
}

function filterToolManifestForActor(manifest, actor) {
  return {
    ...manifest,
    tools: (manifest.tools || []).filter((tool) => hasPermission(actor, requiredPermissionForTool(tool))),
  };
}

const lifecycleGateCache = new Map();
const observabilityCapabilityCache = new Map();
const hisOwnerCapabilityCache = new Map();
const cephOwnerCapabilityCache = new Map();
const recoveryOwnerCapabilityCache = new Map();

async function oaaObservabilityCapabilities(actor) {
  const subject = String(actor?.subject || 'unknown');
  const cached = observabilityCapabilityCache.get(subject);
  if (cached && Date.now() - cached.checkedAt < 15000) return cached.capabilities;
  let capabilities = new Set();
  try {
    const response = await fetch(`${DUPA_CONTROL_URL}/api/admin/observability/status`, {
      headers: { authorization: `Bearer ${actor?.bearerToken || ''}`, accept: 'application/json' }, signal: AbortSignal.timeout(5000),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) capabilities = new Set((body.capabilities || []).map((value) => String(value).toLowerCase()));
  } catch { /* fail closed: unavailable capability evidence exposes no HIS query tool */ }
  observabilityCapabilityCache.set(subject, { checkedAt: Date.now(), capabilities });
  return capabilities;
}

async function oaaHisOwnerCapabilities(actor) {
  const subject = String(actor?.subject || 'unknown');
  const cached = hisOwnerCapabilityCache.get(subject);
  if (cached && Date.now() - cached.checkedAt < 15000) return cached.capabilities;
  let capabilities = new Set();
  if (hasPermission(actor, 'console.his.read')) {
    try {
      const response = await fetch(`${CLUSTER_MANAGER_URL}/api/his/oaa/capabilities`, {
        headers: { authorization: `Bearer ${actor?.bearerToken || ''}`, accept: 'application/json' }, signal: AbortSignal.timeout(5000),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.apiVersion === 'opensphere.io/oaa-his-owner/v1') {
        capabilities = new Set((body.capabilities || []).map((value) => String(value)));
      }
    } catch { /* fail closed: an old or unavailable owner exposes no advanced HIS controls */ }
  }
  hisOwnerCapabilityCache.set(subject, { checkedAt: Date.now(), capabilities });
  return capabilities;
}

async function oaaCephOwnerCapabilities(actor) {
  const subject = String(actor?.subject || 'unknown');
  const cached = cephOwnerCapabilityCache.get(subject);
  if (cached && Date.now() - cached.checkedAt < 15000) return cached.capabilities;
  let capabilities = new Set();
  if (hasPermission(actor, 'console.ceph.read')) {
    try {
      const response = await fetch(`${CLUSTER_MANAGER_URL}/api/ceph/oaa/capabilities`, {
        headers: { authorization: `Bearer ${actor?.bearerToken || ''}`, accept: 'application/json' }, signal: AbortSignal.timeout(10000),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.apiVersion === 'opensphere.io/oaa-ceph-owner/v1') {
        capabilities = new Set((body.capabilities || []).map((value) => String(value)));
      }
    } catch { /* fail closed: old owner or incomplete Rook prerequisites expose no Ceph control */ }
  }
  cephOwnerCapabilityCache.set(subject, { checkedAt: Date.now(), capabilities });
  return capabilities;
}

async function oaaRecoveryOwnerCapabilities(actor) {
  const subject = String(actor?.subject || 'unknown');
  const cached = recoveryOwnerCapabilityCache.get(subject);
  if (cached && Date.now() - cached.checkedAt < 15000) return cached.capabilities;
  let capabilities = new Set();
  if (hasPermission(actor, 'console.recovery.read')) {
    try {
      const response = await fetch(`${CONSOLE_IDENTITY_URL}/api/oaa/owner/recovery/capabilities`, {
        headers: { authorization: `Bearer ${actor?.bearerToken || ''}`, accept: 'application/json' }, signal: AbortSignal.timeout(5000),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.apiVersion === 'opensphere.io/oaa-recovery-owner/v1') {
        capabilities = new Set((body.capabilities || []).map((value) => String(value)));
      }
    } catch { /* fail closed: no owner evidence means no recovery tool exposure */ }
  }
  recoveryOwnerCapabilityCache.set(subject, { checkedAt: Date.now(), capabilities });
  return capabilities;
}

async function oaaMutationLifecycle(actor) {
  if (!OAA_ACTION_SUBMISSION_ENABLED) return { ready: false, reason: 'console_backend_action_submission_disabled' };
  const subject = String(actor?.subject || 'unknown');
  const cached = lifecycleGateCache.get(subject);
  if (cached && Date.now() - cached.checkedAt < 15000) return cached.value;
  let value;
  try {
    const response = await fetch(`${DUPA_CONTROL_URL}/api/admin/platform-readiness/status`, {
      headers: { authorization: `Bearer ${actor?.bearerToken || ''}`, accept: 'application/json' }, signal: AbortSignal.timeout(5000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) value = { ready: false, reason: body.error || `lifecycle_gate_http_${response.status}` };
    else {
      const prerequisites = Array.isArray(body.prerequisites) ? body.prerequisites : [];
      const clusterManager = prerequisites.find((item) => item.key === 'cluster-manager');
      const hisBinding = prerequisites.find((item) => item.key === 'his-binding');
      value = {
        ready: Boolean(clusterManager?.ready && hisBinding?.ready),
        reason: clusterManager?.ready ? (hisBinding?.ready ? null : 'his_preflight_not_ready') : 'cluster_manager_not_activated',
        clusterManagerActivated: Boolean(clusterManager?.ready), hisPreflightReady: Boolean(hisBinding?.ready), observedAt: body.observedAt || null,
      };
    }
  } catch {
    value = { ready: false, reason: 'lifecycle_authority_unavailable' };
  }
  lifecycleGateCache.set(subject, { checkedAt: Date.now(), value });
  return value;
}

async function requireOaaMutationLifecycle(actor, options = {}) {
  const lifecycle = await oaaMutationLifecycle(actor);
  if (options.allowConsoleRecovery === true && OAA_ACTION_SUBMISSION_ENABLED) {
    return { ...lifecycle, recoveryGate: 'console-owner-independent' };
  }
  if (options.allowEvidenceControl === true && OAA_ACTION_SUBMISSION_ENABLED) {
    return { ...lifecycle, recoveryGate: 'evidence-owner-independent' };
  }
  if (options.allowExtensionSecurity === true && OAA_ACTION_SUBMISSION_ENABLED) {
    return { ...lifecycle, recoveryGate: 'extension-security-owner-independent' };
  }
  if (options.allowNotificationControl === true && OAA_ACTION_SUBMISSION_ENABLED) {
    return { ...lifecycle, recoveryGate: 'notification-owner-independent' };
  }
  if (options.allowHisRecovery === true && lifecycle.clusterManagerActivated) return { ...lifecycle, recoveryGate: 'cluster-manager-activated' };
  if (options.allowCephRecovery === true && lifecycle.clusterManagerActivated) return { ...lifecycle, recoveryGate: 'cluster-manager-activated' };
  if (!lifecycle.ready) throw { code: lifecycle.reason === 'lifecycle_authority_unavailable' ? 503 : 409, msg: `OAA mutation gate closed: ${lifecycle.reason}` };
  return lifecycle;
}

async function gatedToolManifestForActor(actor) {
  const manifest = await gatedToolManifestFromStore();
  const [lifecycle, observabilityCapabilities, hisOwnerCapabilities, cephOwnerCapabilities, recoveryOwnerCapabilities] = await Promise.all([
    oaaMutationLifecycle(actor), oaaObservabilityCapabilities(actor), oaaHisOwnerCapabilities(actor), oaaCephOwnerCapabilities(actor), oaaRecoveryOwnerCapabilities(actor),
  ]);
  const hisRecoveryTools = new Set(['oaa.his.validate', 'oaa.his.lifecycle', 'oaa.his.observability.configure']);
  const cephRecoveryTools = new Set(['oaa.ceph.connect', 'oaa.ceph.disconnect']);
  const consoleRecoveryTools = new Set(['oaa.identity.user.create', 'oaa.identity.user.enabled', 'oaa.identity.role.membership']);
  const evidenceControlTools = new Set(['oaa.evidence.retention.update']);
  const extensionSecurityTools = new Set(['oaa.extension.image.revoke']);
  const notificationControlTools = new Set(['oaa.notification.channel.enabled', 'oaa.notification.channel.test', 'oaa.notification.delivery.retry']);
  const lifecycleGated = lifecycle.ready ? manifest : {
    ...manifest,
    mutationEnabled: false,
    mutationGateReason: lifecycle.reason,
    tools: (manifest.tools || []).filter((tool) => tool.readOnly === true || tool.id === 'oaa.knowledge.ingest-manual'
      || consoleRecoveryTools.has(tool.id) || evidenceControlTools.has(tool.id)
      || extensionSecurityTools.has(tool.id) || notificationControlTools.has(tool.id)
      || (lifecycle.clusterManagerActivated && (hisRecoveryTools.has(tool.id) || cephRecoveryTools.has(tool.id)))),
  };
  const capabilityGated = {
    ...lifecycleGated,
    tools: (lifecycleGated.tools || []).filter((tool) => tool.id !== 'oaa.observability.logs.query' || observabilityCapabilities.has('logs'))
      .filter((tool) => tool.id !== 'oaa.observability.traces.query' || observabilityCapabilities.has('traces'))
      .filter((tool) => tool.id !== 'oaa.his.observability.config' || hisOwnerCapabilities.has('observability-config-read'))
      .filter((tool) => tool.id !== 'oaa.his.observability.plan' || hisOwnerCapabilities.has('observability-plan'))
      .filter((tool) => tool.id !== 'oaa.his.observability.configure' || hisOwnerCapabilities.has('observability-configure'))
      .filter((tool) => tool.id !== 'oaa.ceph.status' || cephOwnerCapabilities.has('status-read'))
      .filter((tool) => tool.id !== 'oaa.ceph.plan' || cephOwnerCapabilities.has('plan-from-import'))
      .filter((tool) => tool.id !== 'oaa.ceph.connect' || cephOwnerCapabilities.has('connect-from-import'))
      .filter((tool) => tool.id !== 'oaa.ceph.disconnect' || cephOwnerCapabilities.has('disconnect'))
      .filter((tool) => tool.id !== 'oaa.recovery.status' || recoveryOwnerCapabilities.has('status-read'))
      .filter((tool) => tool.id !== 'oaa.recovery.plan' || recoveryOwnerCapabilities.has('plan-read')),
  };
  return {
    ...filterToolManifestForActor(capabilityGated, actor), lifecycle,
    observabilityCapabilities: [...observabilityCapabilities].sort(),
    hisOwnerCapabilities: [...hisOwnerCapabilities].sort(),
    cephOwnerCapabilities: [...cephOwnerCapabilities].sort(),
    recoveryOwnerCapabilities: [...recoveryOwnerCapabilities].sort(),
  };
}

async function gatedActionBindingsForActor(actor) {
  const manifest = await gatedToolManifestForActor(actor);
  const allowedTools = new Set((manifest.tools || []).map((tool) => tool.id));
  const bindings = await gatedActionBindingsFromStore();
  return {
    ...bindings,
    mutationEnabled: manifest.mutationEnabled,
    mutationGateReason: manifest.mutationGateReason,
    lifecycle: manifest.lifecycle,
    bindings: (bindings.bindings || []).filter((binding) => allowedTools.has(binding.toolId)),
  };
}

function hisObservabilityConfigSchema() {
  const closed = (properties) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
  const boundedName = { type: 'string', maxLength: 253 };
  const storage = { type: 'string', pattern: '^[1-9][0-9]*(Mi|Gi|Ti)$' };
  const duration = { type: 'string', pattern: '^[1-9][0-9]*(m|h|d|w|y)$' };
  return closed({
    schemaVersion: { type: 'integer', enum: [1] },
    prometheus: closed({
      retention: duration,
      storageClassName: boundedName,
      storageSize: storage,
      remoteWrite: closed({
        enabled: { type: 'boolean' },
        url: { type: 'string', maxLength: 2048 },
        secretName: boundedName,
        secretKey: boundedName,
      }),
    }),
    alertmanager: closed({ retention: duration, storageClassName: boundedName, storageSize: storage }),
    grafana: closed({
      storageClassName: boundedName,
      storageSize: storage,
      exposureMode: { type: 'string', enum: ['ClusterInternal', 'PrivateIngress', 'PublicIngress'] },
      hostname: boundedName,
      ingressClassName: boundedName,
      ingressNamespace: boundedName,
      tlsSecretName: boundedName,
      oidcSecretName: boundedName,
      allowedCidrs: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 64 } },
    }),
    telemetry: closed({
      enabled: { type: 'boolean' },
      retention: duration,
      storageClassName: boundedName,
      lokiStorageSize: storage,
      tempoStorageSize: storage,
    }),
  });
}

function sampleHisObservabilityConfig() {
  return {
    schemaVersion: 1,
    prometheus: { retention: '7d', storageClassName: '', storageSize: '20Gi', remoteWrite: { enabled: false, url: '', secretName: '', secretKey: 'token' } },
    alertmanager: { retention: '120h', storageClassName: '', storageSize: '2Gi' },
    grafana: {
      storageClassName: '', storageSize: '5Gi', exposureMode: 'ClusterInternal', hostname: '',
      ingressClassName: 'nginx', ingressNamespace: 'ingress-nginx', tlsSecretName: '', oidcSecretName: '', allowedCidrs: [],
    },
    telemetry: { enabled: true, retention: '168h', storageClassName: '', lokiStorageSize: '10Gi', tempoStorageSize: '10Gi' },
  };
}

async function summarizeStoredToolManifest() {
  return summarizeToolManifest(await gatedToolManifestFromStore());
}

async function summarizeStoredActionBindings() {
  return summarizeActionBindings(await gatedActionBindingsFromStore());
}

function actionCommandForBinding(binding, query = '') {
  const inputs = {};
  if (binding.toolId === 'oaa.knowledge.search') inputs.q = query || 'OpenSphere';
  if (binding.toolId === 'oaa.k8s.resource.describe') {
    inputs.kind = 'deployment';
    inputs.namespace = binding.targetHints?.namespace || OAA_NAMESPACE;
    inputs.name = binding.targetHints?.deployment || 'opensphere-console-oaa-gateway';
  }
  if (binding.toolId === 'oaa.k8s.deployment.rollout' || binding.toolId === 'oaa.k8s.deployment.restart' || binding.toolId === 'oaa.k8s.deployment.scale') {
    inputs.namespace = binding.targetHints?.namespace || OAA_NAMESPACE;
    inputs.name = binding.targetHints?.deployment || 'opensphere-console-oaa-gateway';
  }
  if (binding.toolId === 'oaa.k8s.deployment.scale') inputs.replicas = 1;
  if (binding.toolId === 'oaa.k8s.workload.restart' || binding.toolId === 'oaa.k8s.workload.scale' || binding.toolId === 'oaa.k8s.workload.update-image' || binding.toolId === 'oaa.k8s.workload.rollback-image') {
    inputs.kind = 'deployment'; inputs.namespace = OAA_NAMESPACE; inputs.name = 'replace-me';
  }
  if (binding.toolId === 'oaa.k8s.workload.scale') inputs.replicas = 1;
  if (binding.toolId === 'oaa.k8s.workload.update-image' || binding.toolId === 'oaa.k8s.workload.rollback-image') {
    inputs.container = 'replace-me'; inputs.image = 'registry.example/repository@sha256:<64-hex-digest>';
  }
  if (binding.toolId === 'oaa.k8s.workload.rollback-image') inputs.rollbackOf = '<prior-change-request-uuid>';
  if (binding.toolId === 'oaa.k8s.resource.apply' || binding.toolId === 'oaa.k8s.resource.delete') {
    inputs.kind = 'configmap'; inputs.namespace = OAA_NAMESPACE; inputs.name = 'replace-me';
  }
  if (binding.toolId === 'oaa.k8s.resource.apply') {
    inputs.manifest = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace: OAA_NAMESPACE, name: 'replace-me' }, data: { setting: 'value' } };
  }
  if (binding.toolId === 'oaa.k8s.resource.delete') {
    inputs.impact = '<impact assessment>'; inputs.recoveryPlan = '<recovery plan>'; inputs.backupReference = '<backup reference or rationale>';
  }
  if (binding.toolId === 'oaa.k8s.cronjob.run' || binding.toolId === 'oaa.k8s.cronjob.suspend') {
    inputs.namespace = OAA_NAMESPACE; inputs.name = 'replace-me';
  }
  if (binding.toolId === 'oaa.k8s.cronjob.suspend') inputs.suspend = true;
  if (binding.toolId === 'oaa.extension.lifecycle') {
    inputs.id = 'replace-me'; inputs.action = 'enable';
  }
  if (binding.toolId === 'oaa.extension.image.inspect' || binding.toolId === 'oaa.extension.image.revoke') {
    inputs.image = 'ghcr.io/opensphere-platform/replace-me@sha256:<64-hex-digest>';
  }
  if (binding.toolId === 'oaa.notification.status') inputs.limit = 50;
  if (binding.toolId === 'oaa.notification.channel.enabled') {
    inputs.channelId = '00000000-0000-4000-8000-000000000000'; inputs.enabled = true;
  }
  if (binding.toolId === 'oaa.notification.channel.test') inputs.channelId = '00000000-0000-4000-8000-000000000000';
  if (binding.toolId === 'oaa.notification.delivery.retry') inputs.deliveryId = '00000000-0000-4000-8000-000000000000';
  if (['oaa.his.observability.plan', 'oaa.his.observability.configure'].includes(binding.toolId)) inputs.config = sampleHisObservabilityConfig();
  if (binding.toolId === 'oaa.his.observability.configure') inputs.resetData = false;
  if (binding.toolId === 'oaa.his.validate') inputs.id = 'cluster-network';
  if (binding.toolId === 'oaa.his.lifecycle') {
    inputs.id = 'kube-prometheus-stack'; inputs.action = 'upgrade';
  }
  if (binding.toolId === 'oaa.ceph.plan' || binding.toolId === 'oaa.ceph.connect') {
    inputs.importRef = 'opensphere-ceph-imports/opensphere-ceph-import-00000000-0000-4000-8000-000000000000';
  }
  if (binding.toolId === 'oaa.identity.user.create') {
    inputs.email = 'replace-me@example.invalid'; inputs.username = 'replace-me';
    inputs.displayName = 'Replace Me'; inputs.roles = ['console-viewers'];
  }
  if (binding.toolId === 'oaa.identity.user.enabled') {
    inputs.userId = '00000000-0000-4000-8000-000000000000'; inputs.enabled = true;
  }
  if (binding.toolId === 'oaa.identity.role.membership') {
    inputs.userId = '00000000-0000-4000-8000-000000000000';
    inputs.role = 'console-viewers'; inputs.operation = 'add';
  }
  if (binding.toolId === 'oaa.evidence.retention.update') {
    inputs.stream = 'runtime_event'; inputs.retentionDays = 90;
    inputs.disposition = 'export-before-delete'; inputs.legalHold = false;
  }
  if (binding.toolId === 'oaa.recovery.plan') inputs.component = 'all';
  if (binding.riskLevel !== 'read') inputs.reason = '<human management reason, at least 8 characters>';
  const jsonText = Object.keys(inputs).length ? ` ${JSON.stringify(inputs)}` : '';
  const expected = bindingConfirmationExpected(binding, inputs);
  return `/action ${binding.id}${jsonText}${expected ? ` confirm ${expected}` : ''}`;
}

async function suggestActionBindings({ query = '', sources = [], conceptGraph = null } = {}) {
  // Never suggest write actions while the mutation gate is closed (CONSTITUTION-0004 §4.2).
  const manifest = await gatedActionBindingsFromStore();
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
  // Resolve the connected tool from the raw (unfiltered) tool store — never from a filtered/gated
  // manifest — so a binding whose stored risk_level was poisoned to 'read' but whose bound tool is
  // actually mutating (readOnly !== true) cannot slip a direct binding-id execute past the mutation
  // gate (CONSTITUTION-0004 §4.2). Missing/unresolvable tool fails closed with 409.
  const toolManifest = await toolManifestFromStore();
  const tool = (toolManifest.tools || []).find((t) => t && t.id === binding.toolId);
  if (!tool) throw { code: 409, msg: `action binding references missing tool: ${binding.toolId}` };
  return { ...binding, toolReadOnly: tool.readOnly === true };
}

function bindingConfirmationExpected(binding, inputs = {}) {
  if (!binding || binding.confirmation === 'none') return '';
  let expected = binding.confirmationTemplate || `execute binding ${binding.id}`;
  const revisionSuffix = String(inputs.action || '').toLowerCase() === 'rollback'
    ? ` to revision ${inputs.revision ?? ''}`
    : '';
  expected = expected
    .replace(/<namespace>/g, String(inputs.namespace || binding.targetHints?.namespace || ''))
    .replace(/<deployment>/g, String(inputs.deployment || inputs.name || binding.targetHints?.deployment || ''))
    .replace(/<replicas>/g, String(inputs.replicas ?? ''))
    .replace(/<kind>/g, String(inputs.kind || inputs.manifest?.kind || '').toLowerCase())
    .replace(/<name>/g, String(inputs.name || inputs.manifest?.metadata?.name || ''))
    .replace(/<container>/g, String(inputs.container || ''))
    .replace(/<image>/g, String(inputs.image || ''))
    .replace(/<suspend>/g, String(inputs.suspend ?? ''))
    .replace(/<id>/g, String(inputs.id || ''))
    .replace(/<action>/g, String(inputs.action || '').toLowerCase())
    .replace(/<revision>/g, String(inputs.revision ?? ''))
    .replace(/<revisionSuffix>/g, revisionSuffix)
    .replace(/<username>/g, String(inputs.username || ''))
    .replace(/<userId>/g, String(inputs.userId || ''))
    .replace(/<role>/g, String(inputs.role || ''))
    .replace(/<operation>/g, String(inputs.operation || '').toLowerCase())
    .replace(/<verb>/g, inputs.enabled === true ? 'enable' : (inputs.enabled === false ? 'disable' : ''))
    .replace(/<image>/g, String(inputs.image || ''))
    .replace(/<channelId>/g, String(inputs.channelId || ''))
    .replace(/<deliveryId>/g, String(inputs.deliveryId || ''));
  expected = expected
    .replace(/<stream>/g, String(inputs.stream || ''))
    .replace(/<retentionDays>/g, String(inputs.retentionDays ?? ''))
    .replace(/<importRef>/g, String(inputs.importRef || ''))
    .replace(/<public>/g, String(inputs.config?.grafana?.exposureMode === 'PublicIngress'))
    .replace(/<resetData>/g, String(inputs.resetData));
  return expected.trim();
}

function actionTarget(binding, inputs = {}) {
  const manifest = inputs.manifest && typeof inputs.manifest === 'object' ? inputs.manifest : {};
  const namespace = inputs.namespace || manifest.metadata?.namespace || binding.targetHints?.namespace || '';
  const name = inputs.name || inputs.deployment || inputs.userId || inputs.username || inputs.stream || inputs.image || inputs.channelId || inputs.deliveryId || manifest.metadata?.name || binding.targetHints?.deployment || binding.id;
  const kind = String(inputs.kind || manifest.kind || '').toLowerCase();
  return `${kind ? `${kind}:` : ''}${namespace}/${name}`.replace(/\/+$/g, '').replace(/^:\/+/, '');
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
  // Mutation gate takes priority over every other check (confirmation phrase, admin membership):
  // a write binding — OR a binding whose stored risk_level says 'read' but whose resolved tool is
  // not readOnly (data poisoning / raw-store mismatch) — must fail closed with a stable 403 before
  // we validate or execute anything else (CONSTITUTION-0004 §4.2).
  const mutationRequired = binding.riskLevel !== 'read' || binding.toolReadOnly !== true;
  if (mutationRequired && !OAA_ACTION_SUBMISSION_ENABLED) assertMutationEnabled(actor, binding.id);
  const inputs = { ...(body.inputs && typeof body.inputs === 'object' ? body.inputs : {}) };
  if (body.confirm && !inputs.confirm) inputs.confirm = body.confirm;
  if (body.reason && !inputs.reason) inputs.reason = body.reason;
  const expected = requireBindingConfirmation(binding, inputs, body.confirm || '');
  let result;
  // Nonempty human reason required before any write execution — never synthesized on the
  // caller's behalf (CONSTITUTION-0004 §4.2/§4.4). Read-only bindings are exempt.
  if (mutationRequired) inputs.reason = requireMutationReason(inputs.reason);

  if (mutationRequired) {
    if (binding.toolId === 'oaa.knowledge.ingest-manual') {
      assertPermission(actor, 'oaa.knowledge.manage');
      if (actor?.assurance !== 'aal2') throw { code: 403, msg: 'manual knowledge ingestion requires MFA assurance aal2' };
      result = await upsertManualSeedManifest(inputs.manifest || inputs, actor);
      const target = String(inputs.manifest?.source?.id || 'opensphere/manuals').slice(0, 200);
      await recordToolRun(actor, {
        requestId: randomUUID(), toolId: binding.toolId, target,
        permissionCode: 'oaa.knowledge.manage', reason: inputs.reason,
        input: inputs, status: 'applied', result,
      });
      return {
        action: 'binding-execute', binding, confirmationExpected: expected || null, result,
        message: bindingSummary(binding, result), latencyMs: Date.now() - started,
      };
    }
    await requireOaaMutationLifecycle(actor, {
      allowHisRecovery: ['oaa.his.validate', 'oaa.his.lifecycle', 'oaa.his.observability.configure'].includes(binding.toolId),
      allowCephRecovery: ['oaa.ceph.connect', 'oaa.ceph.disconnect'].includes(binding.toolId),
      allowConsoleRecovery: ['oaa.identity.user.create', 'oaa.identity.user.enabled', 'oaa.identity.role.membership'].includes(binding.toolId),
      allowEvidenceControl: binding.toolId === 'oaa.evidence.retention.update',
      allowExtensionSecurity: binding.toolId === 'oaa.extension.image.revoke',
      allowNotificationControl: ['oaa.notification.channel.enabled', 'oaa.notification.channel.test', 'oaa.notification.delivery.retry'].includes(binding.toolId),
    });
    if (OAA_OWNER_ACTION_TOOL_IDS.has(binding.toolId)) {
      let ownerResult;
      try {
        ownerResult = await executeOwnerControlAction(binding.toolId, inputs, actor);
      } catch (error) {
        const failure = { code: Number(error?.code) || 500, error: String(error?.msg || error?.message || 'owner action failed').slice(0, 500) };
        await recordToolRun(actor, {
          requestId: randomUUID(),
          toolId: binding.toolId,
          target: actionTarget(binding, inputs),
          permissionCode: TOOL_PERMISSION[binding.toolId] || 'oaa.action.execute.high',
          reason: inputs.reason,
          input: inputs,
          status: 'failed',
          result: failure,
        }).catch(() => undefined);
        audit(actor, 'owner-control-action', actionTarget(binding, inputs), 'failed', `${binding.toolId} / ${failure.error}`);
        throw error;
      }
      await recordToolRun(actor, {
        requestId: randomUUID(),
        toolId: binding.toolId,
        target: ownerResult.target,
        permissionCode: TOOL_PERMISSION[binding.toolId] || 'oaa.action.execute.high',
        reason: inputs.reason,
        input: inputs,
        status: 'applied',
        result: ownerResult,
      });
      return {
        action: 'binding-execute',
        binding,
        confirmationExpected: expected || null,
        result: ownerResult,
        message: bindingSummary(binding, ownerResult),
        latencyMs: Date.now() - started,
      };
    }
    if (binding.toolId.startsWith('oaa.k8s.')) {
      const manifestNamespace = inputs.manifest && typeof inputs.manifest === 'object'
        ? inputs.manifest.metadata?.namespace
        : '';
      inputs.namespace = requireMutationNamespace(inputs.namespace || manifestNamespace || binding.targetHints?.namespace);
    }
    const target = actionTarget(binding, inputs);
    const controlPlane = await submitControlPlaneAction(binding, inputs, target, actor);
    await recordToolRun(actor, {
      requestId: controlPlane.requestId,
      toolId: binding.toolId,
      target,
      permissionCode: TOOL_PERMISSION[binding.toolId] || 'oaa.action.propose',
      reason: inputs.reason,
      input: inputs,
      status: 'intent',
      result: controlPlane,
    });
    return {
      action: 'binding-submit',
      binding,
      confirmationExpected: expected || null,
      result: controlPlane,
      message: `Control-plane request ${controlPlane.requestId} was recorded. It awaits the approved Backend adapter.`,
      latencyMs: Date.now() - started,
    };
  }

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
      result = { action: 'knowledge-search', q, items: await searchKnowledge(q, Number(inputs.limit || OAA_RAG_TOP_K), actor) };
      audit(actor, 'binding-knowledge-search', binding.id, 'ok', q);
      break;
    }
    case 'oaa.knowledge.ingest-manual':
      result = await upsertManualSeedManifest(inputs.manifest || inputs, actor);
      break;
    case 'oaa.control-plane.status':
      result = await controlPlaneStatus(actor);
      break;
    case 'oaa.identity.status':
      result = await identityStatusRead(actor);
      break;
    case 'oaa.extension.security.status':
      result = await extensionSecurityStatusRead(actor);
      break;
    case 'oaa.extension.image.inspect':
      result = await extensionImageInspectRead(inputs, actor);
      break;
    case 'oaa.notification.status':
      result = await notificationStatusRead(inputs, actor);
      break;
    case 'oaa.his.observability.config':
      result = await hisObservabilityConfigRead(actor);
      break;
    case 'oaa.his.observability.plan':
      result = await hisObservabilityPlanRead(inputs, actor);
      break;
    case 'oaa.ceph.status':
      result = await cephStatusRead(actor);
      break;
    case 'oaa.ceph.plan':
      result = await cephPlanRead(inputs, actor);
      break;
    case 'oaa.evidence.status':
      assertPermission(actor, 'oaa.evidence.read');
      result = await agentEvidenceDashboard(inputs.days || 30, inputs.limit || 25);
      break;
    case 'oaa.recovery.status':
      result = await recoveryStatusRead(actor);
      break;
    case 'oaa.recovery.plan':
      result = await recoveryPlanRead(inputs, actor);
      break;
    case 'oaa.observability.logs.query':
      result = await observabilityRead(inputs, actor, 'logs');
      break;
    case 'oaa.observability.traces.query':
      result = await observabilityRead(inputs, actor, 'traces');
      break;
    case 'oaa.catalog.entities.list':
      result = await catalogEntitySearch(inputs, actor);
      break;
    case 'oaa.registry.read':
      result = await registryRead(actor);
      break;
    case 'oaa.foundation.status':
      result = await foundationStatusRead(actor);
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
        reason: inputs.reason,
      }, actor);
      break;
    case 'oaa.k8s.deployment.scale':
      result = await scaleDeployment({
        namespace: inputs.namespace || binding.targetHints?.namespace,
        name: inputs.name || inputs.deployment || binding.targetHints?.deployment,
        replicas: inputs.replicas,
        confirm: inputs.confirm,
        reason: inputs.reason,
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
    '/control-plane',
    '/catalog [filter]',
    '/registry',
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
    `Read namespaces: ${OAA_ENV_NAMESPACES.join(', ')}`,
    `Mutation namespaces: ${OAA_MUTATION_NAMESPACES.join(', ')}`,
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
  if (!actor?.groups?.includes(CONSOLE_ADMIN_GROUP)) throw { code: 403, msg: `requires ${CONSOLE_ADMIN_GROUP}` };
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
  if (cmd === '/tools') {
    const manifest = await gatedToolManifestForActor(actor);
    return commandResponse(started, summarizeToolManifest(manifest), manifest);
  }
  if (cmd === '/bindings') {
    const manifest = await gatedActionBindingsForActor(actor);
    return commandResponse(started, summarizeActionBindings(manifest), manifest);
  }
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
    // A chat command is not a management reason.  Mutating bindings must get
    // a concrete, human-supplied reason from the JSON inputs (or the caller's
    // request envelope), otherwise the Backend refuses the intent.
    const out = await executeActionBinding({ bindingId, inputs, confirm, reason: body?.reason || '' }, actor);
    return commandResponse(started, out.message, out);
  }
  if (cmd === '/env') {
    const out = await environmentSnapshot(body, actor);
    return commandResponse(started, summarizeEnvironment(out), out);
  }
  if (cmd === '/control-plane' || cmd === '/controlplane') {
    const out = await controlPlaneStatus(actor);
    return commandResponse(started, JSON.stringify(out, null, 2), out);
  }
  if (cmd === '/catalog') {
    const out = await catalogEntitySearch({ filter: parts.slice(1).join(' '), limit: 100 }, actor);
    return commandResponse(started, JSON.stringify(out, null, 2), out);
  }
  if (cmd === '/registry') {
    const out = await registryRead(actor);
    return commandResponse(started, JSON.stringify(out, null, 2), out);
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
    const out = await restartDeployment({ namespace: parts[1], name: parts[2], confirm: confirmTail(raw), reason: body?.reason || '' }, actor);
    return commandResponse(started, `Restart requested for Deployment ${out.namespace}/${out.name}. generation ${out.previousGeneration || '-'} -> ${out.generation || '-'}.`, out);
  }
  if (cmd === '/scale') {
    assertActorAdmin(actor);
    const out = await scaleDeployment({ namespace: parts[1], name: parts[2], replicas: parts[3], confirm: confirmTail(raw), reason: body?.reason || '' }, actor);
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

const AGENT_MAX_TOOL_ROUNDS = 6;

function agentToolDefinitions(actor, observabilityCapabilities = new Set(), hisOwnerCapabilities = new Set(), cephOwnerCapabilities = new Set(), recoveryOwnerCapabilities = new Set()) {
  const tools = [];
  const add = (permission, name, description, properties = {}, required = []) => {
    if (!hasPermission(actor, permission)) return;
    tools.push({
      type: 'function',
      function: {
        name,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
      },
    });
  };
  const namespace = { type: 'string', description: `Allowed namespace: ${OAA_ENV_NAMESPACES.join(', ')}` };
  const name = { type: 'string', description: 'Kubernetes resource name' };
  add('oaa.system.read', 'get_environment_snapshot', 'Read the current OpenSphere runtime snapshot. Use this for live facts, never manuals.', {
    namespace: { ...namespace, description: `${namespace.description}. Omit to inspect all allowed namespaces.` },
  });
  add('oaa.system.read', 'get_cluster_pod_summary', 'Read current cluster-wide pod phase and unhealthy/restart counts.');
  add('oaa.system.read', 'list_kubernetes_resources', 'List current sanitized operational resources from the live Kubernetes API. Namespace is required for namespaced kinds and omitted for cluster-scoped kinds.', {
    kind: { type: 'string', enum: RUNTIME_RESOURCE_KINDS },
    namespace: { ...namespace, description: `${namespace.description}. Required only for namespaced kinds.` },
    labelSelector: { type: 'string', maxLength: 500 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
  }, ['kind']);
  add('oaa.system.read', 'get_kubernetes_resource', 'Read one current sanitized operational resource and its recent events. Namespace is required for namespaced kinds and omitted for cluster-scoped kinds.', {
    kind: { type: 'string', enum: RUNTIME_RESOURCE_KINDS },
    namespace: { ...namespace, description: `${namespace.description}. Required only for namespaced kinds.` },
    name,
  }, ['kind', 'name']);
  add('oaa.system.read', 'list_namespace_resources', 'List current resources in one allowed namespace.', {
    namespace,
    category: { type: 'string', enum: ['pods', 'deployments', 'services', 'events', 'all'] },
  }, ['namespace', 'category']);
  add('oaa.system.read', 'describe_kubernetes_resource', 'Read detailed current status and events for a Pod or Deployment.', {
    kind: { type: 'string', enum: ['pod', 'deployment'] }, namespace, name,
  }, ['kind', 'namespace', 'name']);
  add('oaa.system.read', 'get_deployment_rollout', 'Read observed rollout readiness for a Deployment.', {
    namespace, name,
  }, ['namespace', 'name']);
  add('oaa.logs.read', 'get_pod_logs', 'Read a redacted tail of current Pod logs for diagnosis.', {
    namespace,
    pod: name,
    container: { type: 'string' },
    tailLines: { type: 'integer', minimum: 1, maximum: 300 },
  }, ['namespace', 'pod']);
  if (observabilityCapabilities.has('logs')) add('oaa.logs.read', 'query_centralized_logs', 'Query redacted historical logs from HIS/Loki using a fixed template. Use service.errors for failures, service.recent for recent service output, or namespace.recent for an allowed namespace.', {
    template: { type: 'string', enum: ['service.recent', 'service.errors', 'namespace.recent'] },
    service: { type: 'string', description: 'Required for service templates' },
    namespace: { ...namespace, description: 'Required for namespace.recent' },
    sinceMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  }, ['template']);
  if (observabilityCapabilities.has('traces')) add('oaa.logs.read', 'query_distributed_traces', 'Query sanitized traces from HIS/Tempo using trace.by_id or service.recent.', {
    template: { type: 'string', enum: ['trace.by_id', 'service.recent'] },
    traceId: { type: 'string', pattern: '^[a-fA-F0-9]{32}$', description: 'Required for trace.by_id' },
    service: { type: 'string', description: 'Required for service.recent' },
    sinceMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  }, ['template']);
  add('oaa.knowledge.read', 'search_opensphere_knowledge', 'Search governed OpenSphere manuals and knowledge with document ACL enforcement.', {
    query: { type: 'string', minLength: 1, maxLength: 1000 },
    limit: { type: 'integer', minimum: 1, maximum: 12 },
  }, ['query']);
  add('oaa.system.read', 'list_governed_actions', 'List actions allowed for this user. Mutating actions are proposals and still require an exact human confirmation and approval workflow.', {
    query: { type: 'string', maxLength: 1000 },
  });
  add('oaa.system.read', 'search_catalog_entities', 'Search the canonical OpenSphere catalog projection. Use this to relate services, owners, APIs, and declared platform components to live resources.', {
    filter: { type: 'string', maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  });
  add('oaa.system.read', 'get_opensphere_registry', 'Read the current Main Shell native Registry projection from its owning DUPA API. Treat it as discovery and activation state, not Kubernetes runtime truth.', {});
  add('oaa.system.read', 'get_foundation_status', 'Read Foundation models, engine states, consumer claims, bindings, and controller readiness from the Foundation owner API.', {});
  add('console.identity.manage', 'get_console_identity_status', 'Read the current PII-minimized Console user and canonical role inventory from the Supabase identity owner.', {});
  add('console.extension.security.read', 'get_extension_security_status', 'Read the append-only exact-digest Extension image revocation ledger.', {});
  add('console.extension.security.read', 'inspect_extension_image', 'Inspect an exact-digest OpenSphere Extension image, signed descriptor, source revision, platforms, provenance and SBOM evidence.', {
    image: { type: 'string', pattern: OAA_EXTENSION_IMAGE_RE.source },
  }, ['image']);
  add('console.notification.read', 'get_notification_status', 'Read sanitized Notification channel, rule, and recent delivery state without recipients, message bodies, routes, or provider message IDs.', {
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  });
  if (recoveryOwnerCapabilities.has('status-read')) {
    add('console.recovery.read', 'get_platform_recovery_status', 'Read current sanitized backup verification, restore assertions, evidence freshness, and recovery execution blockers. This never returns vault paths, checksum values, credentials, or archive contents.', {});
  }
  if (recoveryOwnerCapabilities.has('plan-read')) {
    add('console.recovery.read', 'plan_platform_recovery_drill', 'Plan an isolated non-destructive recovery drill for Supabase database, Supabase Storage, Gitea, or all components. The plan is not execution.', {
      component: { type: 'string', enum: OAA_RECOVERY_COMPONENTS },
    }, ['component']);
  }
  if (hisOwnerCapabilities.has('observability-config-read')) {
    add('console.his.read', 'get_his_observability_config', 'Read the current complete managed HIS Observability configuration and owner policy. Secret values are never returned.', {});
  }
  if (hisOwnerCapabilities.has('observability-plan')) {
    add('console.his.read', 'plan_his_observability_config', 'Plan a complete closed-schema HIS Observability configuration and return live blockers, warnings, storage effects, and whether data reset is required. Only SecretRef names are accepted.', {
      config: hisObservabilityConfigSchema(),
    }, ['config']);
  }
  if (cephOwnerCapabilities.has('status-read')) {
    add('console.ceph.read', 'get_ceph_status', 'Read external Ceph connection state and the independently verified Rook/RBAC/runtime prerequisites.', {});
  }
  if (cephOwnerCapabilities.has('plan-from-import')) {
    add('console.ceph.read', 'plan_ceph_connection', 'Plan external Ceph from an owner-staged SecretRef. Raw provider credentials are never accepted or returned by this tool.', {
      importRef: { type: 'string', pattern: OAA_CEPH_IMPORT_REF_RE.source },
    }, ['importRef']);
  }
  add('oaa.evidence.read', 'get_agent_evidence_status', 'Read correlated digest-only agent runs, tool calls, retrieval revisions, provider usage, and retention/export coverage.', {
    days: { type: 'integer', enum: [1, 7, 30, 90, 365] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  });
  if (hasPermission(actor, 'console.git.change')) {
    add('console.git.change', 'get_change_control_status', 'Read Gitea declaration authority and reconciler consumer status.', {});
    add('console.git.change', 'get_control_plane_status', 'Read the current OpenSphere lifecycle and complete OAA operating readiness through owning APIs. Use agentControl.blockers and missingCapabilities instead of assuming that reachable APIs mean full control is ready.', {});
  }
  return tools;
}

function redactToolText(value) {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED_JWT]')
    .replace(/\b(sk|rk|pk|ghp|glpat)-[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function toolResultContent(result) {
  return redactToolText(JSON.stringify(result)).slice(0, 18000);
}

async function backendGet(path, actor) {
  if (!actor?.bearerToken) throw { code: 503, msg: 'Console identity token is unavailable' };
  let response;
  try {
    response = await fetch(`${CONSOLE_IDENTITY_URL}${path}`, {
      headers: { authorization: `Bearer ${actor.bearerToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw { code: 503, msg: 'Console Backend status API is unavailable' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw { code: response.status, msg: body.error || `Console Backend HTTP ${response.status}` };
  return body;
}

async function identityStatusRead(actor) {
  assertPermission(actor, 'console.identity.manage');
  const projection = redactProjection(await backendGet('/api/oaa/owner/identity/status', actor));
  audit(actor, 'identity-owner-status', 'ConsoleIdentity/users', 'ok', `${projection.users?.length || 0} users / ${projection.roles?.length || 0} roles`);
  return projection;
}

function requireExtensionDigestImage(value, label = 'Extension image') {
  const image = String(value || '').trim().toLowerCase();
  if (!OAA_EXTENSION_IMAGE_RE.test(image)) throw { code: 400, msg: `${label} must be ghcr.io/opensphere-platform/<repository>@sha256:<64 hex>` };
  return image;
}

async function extensionSecurityStatusRead(actor) {
  assertPermission(actor, 'console.extension.security.read');
  const projection = redactProjection(await dupaGet('/api/oaa/owner/extensions/security', actor));
  audit(actor, 'extension-security-status', 'ExtensionSecurity/revocations', 'ok', `${projection.items?.length || 0} revocations`);
  return projection;
}

async function extensionImageInspectRead(inputs, actor) {
  assertPermission(actor, 'console.extension.security.read');
  requireClosedOwnerInputs(inputs, ['image']);
  const image = requireExtensionDigestImage(inputs.image);
  const projection = redactProjection(await fixedOwnerPost(
    DUPA_CONTROL_URL, '/api/oaa/owner/extensions/inspect', actor, { image }, 'DUPA Extension security', 60000,
  ));
  audit(actor, 'extension-image-inspect', `OCIImage/${image}`, 'ok', projection.verification?.signature || 'verified');
  return projection;
}

async function notificationStatusRead(inputs, actor) {
  assertPermission(actor, 'console.notification.read');
  requireClosedOwnerInputs(inputs, ['limit']);
  const limit = Number(inputs.limit || 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw { code: 400, msg: 'notification delivery limit must be 1-100' };
  const projection = redactProjection(await backendGet(`/api/oaa/owner/notifications/status?limit=${limit}`, actor));
  audit(actor, 'notification-owner-status', 'NotificationDelivery/all', 'ok', `${projection.channels?.length || 0} channels / ${projection.deliveries?.length || 0} deliveries`);
  return projection;
}

async function recoveryStatusRead(actor) {
  assertPermission(actor, 'console.recovery.read');
  if (!(await oaaRecoveryOwnerCapabilities(actor)).has('status-read')) throw { code: 409, msg: 'Console recovery owner does not expose status-read' };
  const projection = redactProjection(await backendGet('/api/oaa/owner/recovery/status', actor));
  audit(actor, 'recovery-owner-status', 'PlatformRecovery/all', 'ok', `${projection.blockers?.length || 0} blockers`);
  return projection;
}

async function recoveryPlanRead(inputs, actor) {
  assertPermission(actor, 'console.recovery.read');
  requireClosedOwnerInputs(inputs, ['component']);
  if (!(await oaaRecoveryOwnerCapabilities(actor)).has('plan-read')) throw { code: 409, msg: 'Console recovery owner does not expose plan-read' };
  const component = String(inputs?.component || 'all').trim().toLowerCase();
  if (!OAA_RECOVERY_COMPONENTS.includes(component)) throw { code: 400, msg: `component must be one of ${OAA_RECOVERY_COMPONENTS.join(', ')}` };
  const projection = redactProjection(await fixedOwnerPost(
    CONSOLE_IDENTITY_URL, '/api/oaa/owner/recovery/plan', actor, { component }, 'Console Platform Recovery', 30000,
  ));
  audit(actor, 'recovery-owner-plan', `PlatformRecovery/${component}`, 'ok', `${projection.steps?.length || 0} steps / ${projection.blockers?.length || 0} blockers`);
  return projection;
}

async function dupaGet(path, actor) {
  if (!actor?.bearerToken) throw { code: 503, msg: 'Console identity token is unavailable' };
  let response;
  try {
    response = await fetch(`${DUPA_CONTROL_URL}${path}`, {
      headers: { authorization: `Bearer ${actor.bearerToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw { code: 503, msg: 'Console lifecycle API is unavailable' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw { code: response.status, msg: body.error || `Console lifecycle HTTP ${response.status}` };
  return body;
}

async function clusterManagerGet(path, actor) {
  if (!actor?.bearerToken) throw { code: 503, msg: 'Console identity token is unavailable' };
  let response;
  try {
    response = await fetch(`${CLUSTER_MANAGER_URL}${path}`, {
      headers: { authorization: `Bearer ${actor.bearerToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw { code: 503, msg: 'Cluster Manager owner API is unavailable' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw { code: response.status, msg: body.error || `Cluster Manager HTTP ${response.status}` };
  return body;
}

function boundedObservabilityReadInputs(inputs, kind) {
  const value = inputs && typeof inputs === 'object' ? inputs : {};
  const allowed = kind === 'logs'
    ? ['template', 'service', 'namespace', 'sinceMinutes', 'limit']
    : ['template', 'traceId', 'service', 'sinceMinutes', 'limit'];
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw { code: 400, msg: `observability query contains unsupported inputs: ${extra.join(', ')}` };
  const templates = kind === 'logs' ? ['service.recent', 'service.errors', 'namespace.recent'] : ['trace.by_id', 'service.recent'];
  const template = String(value.template || (kind === 'logs' ? 'service.recent' : 'trace.by_id'));
  if (!templates.includes(template)) throw { code: 400, msg: `unsupported ${kind} query template` };
  const output = { template };
  if (value.service !== undefined) output.service = requireOwnerActionId(value.service);
  if (value.namespace !== undefined) output.namespace = requireNamespace(value.namespace);
  if (value.traceId !== undefined) {
    const traceId = String(value.traceId || '').trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(traceId)) throw { code: 400, msg: 'traceId must be 32 hexadecimal characters' };
    output.traceId = traceId;
  }
  const sinceMinutes = Number(value.sinceMinutes || 60);
  const maximumLimit = kind === 'logs' ? 200 : 100;
  const limit = Number(value.limit || 100);
  if (!Number.isInteger(sinceMinutes) || sinceMinutes < 1 || sinceMinutes > 1440) throw { code: 400, msg: 'sinceMinutes must be an integer from 1 to 1440' };
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumLimit) throw { code: 400, msg: `limit must be an integer from 1 to ${maximumLimit}` };
  output.sinceMinutes = sinceMinutes;
  output.limit = limit;
  if (template.startsWith('service.') && !output.service) throw { code: 400, msg: 'service is required for the selected template' };
  if (template === 'namespace.recent' && !output.namespace) throw { code: 400, msg: 'namespace is required for namespace.recent' };
  if (template === 'trace.by_id' && !output.traceId) throw { code: 400, msg: 'traceId is required for trace.by_id' };
  return output;
}

async function observabilityRead(inputs, actor, kind) {
  assertPermission(actor, 'oaa.logs.read');
  const query = boundedObservabilityReadInputs(inputs, kind);
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  const result = redactProjection(await clusterManagerGet(`/api/his/observability/${kind}?${params.toString()}`, actor));
  const target = query.traceId || query.service || query.namespace || kind;
  audit(actor, `his-observability-${kind}-query`, `HIS/${kind}/${target}`, 'ok', `${query.template} limit=${query.limit}`);
  return result;
}

async function fixedOwnerPost(baseUrl, path, actor, payload, owner, timeoutMs = 30000) {
  if (!actor?.bearerToken) throw { code: 503, msg: 'Console identity token is unavailable' };
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${actor.bearerToken}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw { code: 503, msg: `${owner} owner API is unavailable` };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw { code: response.status, msg: body.error || `${owner} HTTP ${response.status}` };
  return body;
}

function requireClosedOwnerInputs(inputs, allowed) {
  const keys = Object.keys(inputs || {});
  const extra = keys.filter((key) => !allowed.includes(key));
  if (extra.length) throw { code: 400, msg: `owner action contains unsupported inputs: ${extra.join(', ')}` };
}

function requireExactOwnerObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw { code: 400, msg: `${label} must be an object` };
  requireClosedOwnerInputs(value, keys);
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) throw { code: 400, msg: `${label} is missing required fields: ${missing.join(', ')}` };
  return value;
}

function ownerConfigString(value, label, maximum = 253) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw { code: 400, msg: `${label} must be a bounded string` };
  }
  return value;
}

function normalizeHisObservabilityOwnerConfig(value) {
  const source = requireExactOwnerObject(value, ['schemaVersion', 'prometheus', 'alertmanager', 'grafana', 'telemetry'], 'config');
  if (source.schemaVersion !== 1) throw { code: 400, msg: 'config.schemaVersion must be 1' };
  const prometheus = requireExactOwnerObject(source.prometheus, ['retention', 'storageClassName', 'storageSize', 'remoteWrite'], 'config.prometheus');
  const remoteWrite = requireExactOwnerObject(prometheus.remoteWrite, ['enabled', 'url', 'secretName', 'secretKey'], 'config.prometheus.remoteWrite');
  const alertmanager = requireExactOwnerObject(source.alertmanager, ['retention', 'storageClassName', 'storageSize'], 'config.alertmanager');
  const grafana = requireExactOwnerObject(source.grafana, ['storageClassName', 'storageSize', 'exposureMode', 'hostname', 'ingressClassName', 'ingressNamespace', 'tlsSecretName', 'oidcSecretName', 'allowedCidrs'], 'config.grafana');
  const telemetry = requireExactOwnerObject(source.telemetry, ['enabled', 'retention', 'storageClassName', 'lokiStorageSize', 'tempoStorageSize'], 'config.telemetry');
  if (typeof remoteWrite.enabled !== 'boolean' || typeof telemetry.enabled !== 'boolean') throw { code: 400, msg: 'Observability enabled fields must be boolean' };
  if (!['ClusterInternal', 'PrivateIngress', 'PublicIngress'].includes(grafana.exposureMode)) throw { code: 400, msg: 'Grafana exposureMode is outside the closed policy' };
  if (!Array.isArray(grafana.allowedCidrs) || grafana.allowedCidrs.length > 32) throw { code: 400, msg: 'Grafana allowedCidrs must be a bounded array' };
  return {
    schemaVersion: 1,
    prometheus: {
      retention: ownerConfigString(prometheus.retention, 'config.prometheus.retention'),
      storageClassName: ownerConfigString(prometheus.storageClassName, 'config.prometheus.storageClassName'),
      storageSize: ownerConfigString(prometheus.storageSize, 'config.prometheus.storageSize'),
      remoteWrite: {
        enabled: remoteWrite.enabled,
        url: ownerConfigString(remoteWrite.url, 'config.prometheus.remoteWrite.url', 2048),
        secretName: ownerConfigString(remoteWrite.secretName, 'config.prometheus.remoteWrite.secretName'),
        secretKey: ownerConfigString(remoteWrite.secretKey, 'config.prometheus.remoteWrite.secretKey'),
      },
    },
    alertmanager: {
      retention: ownerConfigString(alertmanager.retention, 'config.alertmanager.retention'),
      storageClassName: ownerConfigString(alertmanager.storageClassName, 'config.alertmanager.storageClassName'),
      storageSize: ownerConfigString(alertmanager.storageSize, 'config.alertmanager.storageSize'),
    },
    grafana: {
      storageClassName: ownerConfigString(grafana.storageClassName, 'config.grafana.storageClassName'),
      storageSize: ownerConfigString(grafana.storageSize, 'config.grafana.storageSize'),
      exposureMode: grafana.exposureMode,
      hostname: ownerConfigString(grafana.hostname, 'config.grafana.hostname'),
      ingressClassName: ownerConfigString(grafana.ingressClassName, 'config.grafana.ingressClassName'),
      ingressNamespace: ownerConfigString(grafana.ingressNamespace, 'config.grafana.ingressNamespace'),
      tlsSecretName: ownerConfigString(grafana.tlsSecretName, 'config.grafana.tlsSecretName'),
      oidcSecretName: ownerConfigString(grafana.oidcSecretName, 'config.grafana.oidcSecretName'),
      allowedCidrs: grafana.allowedCidrs.map((cidr) => ownerConfigString(cidr, 'config.grafana.allowedCidrs[]', 64)),
    },
    telemetry: {
      enabled: telemetry.enabled,
      retention: ownerConfigString(telemetry.retention, 'config.telemetry.retention'),
      storageClassName: ownerConfigString(telemetry.storageClassName, 'config.telemetry.storageClassName'),
      lokiStorageSize: ownerConfigString(telemetry.lokiStorageSize, 'config.telemetry.lokiStorageSize'),
      tempoStorageSize: ownerConfigString(telemetry.tempoStorageSize, 'config.telemetry.tempoStorageSize'),
    },
  };
}

function hisObservabilityConfirmation(config, resetData) {
  return `configure HIS observability public=${config.grafana.exposureMode === 'PublicIngress'} data-reset=${Boolean(resetData)}`;
}

async function hisObservabilityConfigRead(actor) {
  assertPermission(actor, 'console.his.read');
  if (!(await oaaHisOwnerCapabilities(actor)).has('observability-config-read')) throw { code: 409, msg: 'signed Cluster Manager does not expose the HIS Observability config owner capability' };
  const projection = redactProjection(await clusterManagerGet('/api/his/oaa/observability/config', actor));
  audit(actor, 'his-observability-config-read', 'HIS/kube-prometheus-stack', 'ok', projection.source || 'managed configuration');
  return projection;
}

async function hisObservabilityPlanRead(inputs, actor) {
  assertPermission(actor, 'console.his.read');
  if (!(await oaaHisOwnerCapabilities(actor)).has('observability-plan')) throw { code: 409, msg: 'signed Cluster Manager does not expose the HIS Observability plan owner capability' };
  requireClosedOwnerInputs(inputs, ['config']);
  const config = normalizeHisObservabilityOwnerConfig(inputs.config);
  const projection = redactProjection(await fixedOwnerPost(
    CLUSTER_MANAGER_URL, '/api/his/oaa/observability/plan', actor, { config }, 'Cluster Manager HIS', 120000,
  ));
  audit(actor, 'his-observability-plan', 'HIS/kube-prometheus-stack', 'ok', `${projection.changes?.length || 0} changes / ${projection.blockers?.length || 0} blockers`);
  return projection;
}

function requireCephImportRef(value) {
  const importRef = String(value || '').trim().toLowerCase();
  if (!OAA_CEPH_IMPORT_REF_RE.test(importRef)) throw { code: 400, msg: 'importRef must be opensphere-ceph-imports/opensphere-ceph-import-<uuid>' };
  return importRef;
}

async function cephStatusRead(actor) {
  assertPermission(actor, 'console.ceph.read');
  if (!(await oaaCephOwnerCapabilities(actor)).has('status-read')) throw { code: 409, msg: 'signed Cluster Manager does not expose the Ceph owner status capability' };
  const projection = redactProjection(await clusterManagerGet('/api/ceph/oaa/status', actor));
  audit(actor, 'ceph-external-status', 'CephExternal/rook-ceph', 'ok', `${projection.state || 'Unknown'}:${projection.reason || 'unknown'}`);
  return projection;
}

async function cephPlanRead(inputs, actor) {
  assertPermission(actor, 'console.ceph.read');
  requireClosedOwnerInputs(inputs, ['importRef']);
  if (!(await oaaCephOwnerCapabilities(actor)).has('plan-from-import')) throw { code: 409, msg: 'signed Cluster Manager or Rook prerequisites do not expose the Ceph plan capability' };
  const importRef = requireCephImportRef(inputs.importRef);
  const projection = redactProjection(await fixedOwnerPost(CLUSTER_MANAGER_URL, '/api/ceph/oaa/plan', actor, { importRef }, 'Cluster Manager Ceph', 120000));
  audit(actor, 'ceph-external-plan', 'CephExternal/rook-ceph', 'ok', `${projection.storage?.length || 0} storage classes`);
  return projection;
}

function requireOwnerActionId(value, allowed = null) {
  const id = String(value || '').trim();
  if (!K8S_NAME_RE.test(id)) throw { code: 400, msg: 'owner action id is invalid' };
  if (allowed && !allowed.includes(id)) throw { code: 400, msg: 'owner action id is outside the closed catalog' };
  return id;
}

async function executeOwnerControlAction(toolId, inputs, actor) {
  if (!OAA_OWNER_ACTION_TOOL_IDS.has(toolId)) throw { code: 403, msg: 'tool is not an approved owner control-plane action' };
  assertPermission(actor, TOOL_PERMISSION[toolId] || 'oaa.action.execute.high');
  if (actor?.assurance !== 'aal2') throw { code: 403, msg: 'owner control-plane action requires MFA assurance aal2' };
  const reason = requireMutationReason(inputs.reason);
  let owner;
  let target;
  let response;

  if (toolId === 'oaa.evidence.retention.update') {
    response = await setEvidenceRetentionPolicy(actor, inputs);
    owner = 'OAA Supabase evidence owner'; target = response.target;
  } else if (toolId === 'oaa.identity.user.create') {
    requireClosedOwnerInputs(inputs, ['email', 'username', 'displayName', 'roles', 'confirm', 'reason']);
    const email = String(inputs.email || '').trim().toLowerCase();
    const username = String(inputs.username || '').trim().toLowerCase();
    const displayName = String(inputs.displayName || '').trim();
    const roles = [...new Set((Array.isArray(inputs.roles) ? inputs.roles : []).map((role) => String(role || '').trim()).filter(Boolean))];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw { code: 400, msg: 'invalid Console user email' };
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(username)) throw { code: 400, msg: 'invalid Console username' };
    if (!displayName || displayName.length > 120) throw { code: 400, msg: 'displayName must be 1-120 characters' };
    if (roles.length > OAA_CONSOLE_ROLES.length || roles.some((role) => !OAA_CONSOLE_ROLES.includes(role))) {
      throw { code: 400, msg: 'roles must be a subset of the canonical Console role catalog' };
    }
    requireConfirm(inputs.confirm, `create Console user ${username}`);
    owner = 'Console Data & Identity / Supabase'; target = `ConsoleUser/${username}`;
    response = await fixedOwnerPost(CONSOLE_IDENTITY_URL, '/api/oaa/owner/identity/actions', actor, {
      action: 'create', email, username, displayName, roles, confirm: inputs.confirm, reason,
    }, owner);
  } else if (toolId === 'oaa.identity.user.enabled') {
    requireClosedOwnerInputs(inputs, ['userId', 'enabled', 'confirm', 'reason']);
    const userId = String(inputs.userId || '').trim().toLowerCase();
    if (!UUID_RE.test(userId)) throw { code: 400, msg: 'Console user id must be a UUID' };
    if (typeof inputs.enabled !== 'boolean') throw { code: 400, msg: 'enabled must be boolean' };
    const verb = inputs.enabled ? 'enable' : 'disable';
    requireConfirm(inputs.confirm, `${verb} Console user ${userId}`);
    owner = 'Console Data & Identity / Supabase'; target = `ConsoleUser/${userId}`;
    response = await fixedOwnerPost(CONSOLE_IDENTITY_URL, '/api/oaa/owner/identity/actions', actor, {
      action: 'set-enabled', userId, enabled: inputs.enabled, confirm: inputs.confirm, reason,
    }, owner);
  } else if (toolId === 'oaa.identity.role.membership') {
    requireClosedOwnerInputs(inputs, ['userId', 'role', 'operation', 'confirm', 'reason']);
    const userId = String(inputs.userId || '').trim().toLowerCase();
    const role = String(inputs.role || '').trim();
    const operation = String(inputs.operation || '').trim().toLowerCase();
    if (!UUID_RE.test(userId)) throw { code: 400, msg: 'Console user id must be a UUID' };
    if (!OAA_CONSOLE_ROLES.includes(role)) throw { code: 400, msg: 'role is outside the canonical Console role catalog' };
    if (!['add', 'remove'].includes(operation)) throw { code: 400, msg: 'role operation must be add or remove' };
    requireConfirm(inputs.confirm, `${operation} Console role ${role} for user ${userId}`);
    owner = 'Console Data & Identity / Supabase'; target = `ConsoleUser/${userId}/Role/${role}`;
    response = await fixedOwnerPost(CONSOLE_IDENTITY_URL, '/api/oaa/owner/identity/actions', actor, {
      action: 'role', userId, role, operation, confirm: inputs.confirm, reason,
    }, owner);
  } else if (toolId === 'oaa.extension.image.revoke') {
    requireClosedOwnerInputs(inputs, ['image', 'replacementImage', 'confirm', 'reason']);
    const image = requireExtensionDigestImage(inputs.image);
    const replacementImage = inputs.replacementImage === undefined || String(inputs.replacementImage || '').trim() === ''
      ? '' : requireExtensionDigestImage(inputs.replacementImage, 'replacement Extension image');
    if (replacementImage && replacementImage.split('@')[0] !== image.split('@')[0]) throw { code: 400, msg: 'replacement Extension image must use the same repository' };
    requireConfirm(inputs.confirm, `revoke extension image ${image}`);
    owner = 'DUPA Extension security'; target = `OCIImage/${image}`;
    response = await fixedOwnerPost(DUPA_CONTROL_URL, '/api/oaa/owner/extensions/revoke', actor, {
      image, ...(replacementImage ? { replacementImage } : {}), confirm: inputs.confirm, reason,
    }, owner, 60000);
  } else if (toolId === 'oaa.notification.channel.enabled') {
    requireClosedOwnerInputs(inputs, ['channelId', 'enabled', 'confirm', 'reason']);
    const channelId = String(inputs.channelId || '').trim().toLowerCase();
    if (!UUID_RE.test(channelId)) throw { code: 400, msg: 'Notification channel id must be a UUID' };
    if (typeof inputs.enabled !== 'boolean') throw { code: 400, msg: 'enabled must be boolean' };
    const verb = inputs.enabled ? 'enable' : 'disable';
    requireConfirm(inputs.confirm, `${verb} notification channel ${channelId}`);
    owner = 'Console Notification Delivery / Supabase'; target = `NotificationChannel/${channelId}`;
    response = await fixedOwnerPost(CONSOLE_IDENTITY_URL, '/api/oaa/owner/notifications/actions', actor, {
      action: 'set-channel-enabled', channelId, enabled: inputs.enabled, confirm: inputs.confirm, reason,
    }, owner);
  } else if (toolId === 'oaa.notification.channel.test') {
    requireClosedOwnerInputs(inputs, ['channelId', 'confirm', 'reason']);
    const channelId = String(inputs.channelId || '').trim().toLowerCase();
    if (!UUID_RE.test(channelId)) throw { code: 400, msg: 'Notification channel id must be a UUID' };
    requireConfirm(inputs.confirm, `test notification channel ${channelId}`);
    owner = 'Console Notification Delivery / Supabase'; target = `NotificationChannel/${channelId}`;
    response = await fixedOwnerPost(CONSOLE_IDENTITY_URL, '/api/oaa/owner/notifications/actions', actor, {
      action: 'test-channel', channelId, confirm: inputs.confirm, reason,
    }, owner);
  } else if (toolId === 'oaa.notification.delivery.retry') {
    requireClosedOwnerInputs(inputs, ['deliveryId', 'confirm', 'reason']);
    const deliveryId = String(inputs.deliveryId || '').trim().toLowerCase();
    if (!UUID_RE.test(deliveryId)) throw { code: 400, msg: 'Notification delivery id must be a UUID' };
    requireConfirm(inputs.confirm, `retry notification delivery ${deliveryId}`);
    owner = 'Console Notification Delivery / Supabase'; target = `NotificationDelivery/${deliveryId}`;
    response = await fixedOwnerPost(CONSOLE_IDENTITY_URL, '/api/oaa/owner/notifications/actions', actor, {
      action: 'retry-delivery', deliveryId, confirm: inputs.confirm, reason,
    }, owner);
  } else if (toolId === 'oaa.platform.readiness.preflight') {
    requireClosedOwnerInputs(inputs, ['confirm', 'reason']);
    requireConfirm(inputs.confirm, 'run platform readiness preflight');
    owner = 'Console lifecycle / DUPA'; target = 'PlatformSupportProfile/default';
    response = await fixedOwnerPost(DUPA_CONTROL_URL, '/api/admin/platform-readiness/preflight', actor, { reason }, owner);
  } else if (toolId === 'oaa.platform.readiness.verify') {
    requireClosedOwnerInputs(inputs, ['confirm', 'reason']);
    requireConfirm(inputs.confirm, 'verify platform support profile');
    owner = 'Console lifecycle / DUPA'; target = 'PlatformSupportProfile/default';
    response = await fixedOwnerPost(DUPA_CONTROL_URL, '/api/admin/platform-readiness/verify', actor, { reason }, owner);
  } else if (toolId === 'oaa.extension.lifecycle') {
    requireClosedOwnerInputs(inputs, ['id', 'action', 'confirm', 'reason']);
    const id = requireOwnerActionId(inputs.id);
    const action = String(inputs.action || '').trim().toLowerCase();
    if (!OAA_EXTENSION_LIFECYCLE_ACTIONS.includes(action)) throw { code: 400, msg: 'extension action is outside the closed lifecycle contract' };
    requireConfirm(inputs.confirm, `extension ${action} ${id}`);
    owner = 'DUPA Extension Host'; target = `UIPluginRegistration/${id}`;
    response = await fixedOwnerPost(DUPA_CONTROL_URL, `/api/admin/plugins/registrations/${encodeURIComponent(id)}/${action}`, actor, { reason }, owner);
  } else if (toolId === 'oaa.his.validate') {
    requireClosedOwnerInputs(inputs, ['id', 'confirm', 'reason']);
    const id = requireOwnerActionId(inputs.id, OAA_HIS_VALIDATION_IDS);
    requireConfirm(inputs.confirm, `validate HIS ${id}`);
    owner = 'Cluster Manager HIS'; target = `HIS/${id}`;
    response = await fixedOwnerPost(CLUSTER_MANAGER_URL, '/api/his/validate', actor, { id, reason }, owner);
  } else if (toolId === 'oaa.his.lifecycle') {
    requireClosedOwnerInputs(inputs, ['id', 'action', 'revision', 'confirm', 'reason']);
    const id = requireOwnerActionId(inputs.id, OAA_HIS_MANAGED_IDS);
    const action = String(inputs.action || '').trim().toLowerCase();
    if (!OAA_HIS_LIFECYCLE_ACTIONS.includes(action)) throw { code: 400, msg: 'HIS action is outside the closed lifecycle contract' };
    const payload = { id, reason };
    let expected = `${action} HIS ${id}`;
    if (action === 'rollback') {
      const revision = Number(inputs.revision);
      if (!Number.isInteger(revision) || revision < 1) throw { code: 400, msg: 'rollback revision must be a positive integer' };
      payload.revision = revision;
      payload.confirm = `${id}:${revision}`;
      expected += ` to revision ${revision}`;
    } else {
      if (inputs.revision !== undefined) throw { code: 400, msg: 'revision is accepted only for HIS rollback' };
      if (action === 'uninstall') payload.confirm = id;
    }
    requireConfirm(inputs.confirm, expected);
    owner = 'Cluster Manager HIS'; target = `HIS/${id}`;
    response = await fixedOwnerPost(CLUSTER_MANAGER_URL, `/api/his/${action}`, actor, payload, owner);
  } else if (toolId === 'oaa.his.observability.configure') {
    requireClosedOwnerInputs(inputs, ['config', 'resetData', 'confirm', 'reason']);
    const ownerCapabilities = await oaaHisOwnerCapabilities(actor);
    if (!ownerCapabilities.has('observability-configure')) throw { code: 409, msg: 'signed Cluster Manager does not expose the HIS Observability owner capability' };
    if (typeof inputs.resetData !== 'boolean') throw { code: 400, msg: 'resetData must be boolean' };
    const config = normalizeHisObservabilityOwnerConfig(inputs.config);
    const expected = hisObservabilityConfirmation(config, inputs.resetData);
    requireConfirm(inputs.confirm, expected);
    owner = 'Cluster Manager HIS'; target = 'HIS/kube-prometheus-stack';
    response = await fixedOwnerPost(CLUSTER_MANAGER_URL, '/api/his/oaa/observability/configure', actor, {
      config, resetData: inputs.resetData, confirm: inputs.confirm, reason,
    }, owner, 600000);
  } else if (toolId === 'oaa.ceph.connect') {
    requireClosedOwnerInputs(inputs, ['importRef', 'confirm', 'reason']);
    const ownerCapabilities = await oaaCephOwnerCapabilities(actor);
    if (!ownerCapabilities.has('connect-from-import')) throw { code: 409, msg: 'signed Cluster Manager or Rook prerequisites do not expose the Ceph connect capability' };
    const importRef = requireCephImportRef(inputs.importRef);
    requireConfirm(inputs.confirm, `connect Ceph external storage using ${importRef}`);
    owner = 'Cluster Manager Ceph'; target = 'CephExternal/rook-ceph';
    response = await fixedOwnerPost(CLUSTER_MANAGER_URL, '/api/ceph/oaa/connect', actor, {
      importRef, confirm: inputs.confirm, reason,
    }, owner, 900000);
  } else if (toolId === 'oaa.ceph.disconnect') {
    requireClosedOwnerInputs(inputs, ['confirm', 'reason']);
    const ownerCapabilities = await oaaCephOwnerCapabilities(actor);
    if (!ownerCapabilities.has('disconnect')) throw { code: 409, msg: 'signed Cluster Manager or Rook prerequisites do not expose the Ceph disconnect capability' };
    requireConfirm(inputs.confirm, 'disconnect Ceph external storage');
    owner = 'Cluster Manager Ceph'; target = 'CephExternal/rook-ceph';
    response = await fixedOwnerPost(CLUSTER_MANAGER_URL, '/api/ceph/oaa/disconnect', actor, { confirm: inputs.confirm, reason }, owner, 900000);
  } else if (toolId === 'oaa.foundation.engine.lifecycle') {
    requireClosedOwnerInputs(inputs, ['engine', 'action', 'confirm', 'reason']);
    const engine = requireOwnerActionId(inputs.engine, OAA_FOUNDATION_ENGINES);
    const action = String(inputs.action || '').trim().toLowerCase();
    if (!['enable', 'disable'].includes(action)) throw { code: 400, msg: 'Foundation engine action must be enable or disable' };
    requireConfirm(inputs.confirm, `${action} Foundation engine ${engine}`);
    owner = 'Foundation control plane'; target = `FoundationEngine/${engine}`;
    response = await fixedOwnerPost(FOUNDATION_CONTROL_URL, '/api/foundation/oaa/engines/lifecycle', actor, { engine, action, confirm: inputs.confirm, reason }, owner, 120000);
  } else if (toolId === 'oaa.foundation.claim.create') {
    requireClosedOwnerInputs(inputs, ['name', 'model', 'confirm', 'reason']);
    const name = requireOwnerActionId(inputs.name);
    const model = requireOwnerActionId(inputs.model, OAA_FOUNDATION_MODELS);
    requireConfirm(inputs.confirm, `create Foundation claim ${name} for ${model}`);
    owner = 'Foundation control plane'; target = `FoundationClaim/opensphere-foundation/${name}`;
    response = await fixedOwnerPost(FOUNDATION_CONTROL_URL, '/api/foundation/oaa/claims/create', actor, { name, model, confirm: inputs.confirm, reason }, owner, 120000);
  } else if (toolId === 'oaa.foundation.claim.release') {
    requireClosedOwnerInputs(inputs, ['name', 'confirm', 'reason']);
    const name = requireOwnerActionId(inputs.name);
    requireConfirm(inputs.confirm, `release Foundation claim ${name}`);
    owner = 'Foundation control plane'; target = `FoundationClaim/opensphere-foundation/${name}`;
    response = await fixedOwnerPost(FOUNDATION_CONTROL_URL, '/api/foundation/oaa/claims/release', actor, { name, confirm: inputs.confirm, reason }, owner, 120000);
  } else if (toolId === 'oaa.foundation.identity-directory.claim.create') {
    requireClosedOwnerInputs(inputs, ['name', 'confirm', 'reason']);
    const name = requireOwnerActionId(inputs.name);
    requireConfirm(inputs.confirm, `create IdentityDirectory claim ${name}`);
    owner = 'Foundation control plane'; target = `IdentityDirectoryClaim/opensphere-foundation/${name}`;
    response = await fixedOwnerPost(FOUNDATION_CONTROL_URL, '/api/foundation/oaa/identity-directory/claims/create', actor, { name, confirm: inputs.confirm, reason }, owner, 120000);
  } else if (toolId === 'oaa.foundation.identity-directory.claim.release') {
    requireClosedOwnerInputs(inputs, ['name', 'confirm', 'reason']);
    const name = requireOwnerActionId(inputs.name);
    requireConfirm(inputs.confirm, `release IdentityDirectory claim ${name}`);
    owner = 'Foundation control plane'; target = `IdentityDirectoryClaim/opensphere-foundation/${name}`;
    response = await fixedOwnerPost(FOUNDATION_CONTROL_URL, '/api/foundation/oaa/identity-directory/claims/release', actor, { name, confirm: inputs.confirm, reason }, owner, 120000);
  }

  const result = { action: 'owner-control-action', toolId, owner, target, accepted: true, response: redactProjection(response) };
  audit(actor, 'owner-control-action', target, 'ok', `${toolId} / ${reason}`);
  return result;
}

async function settledControlPlaneComponent(owner, request) {
  try {
    return { owner, available: true, value: await request() };
  } catch (error) {
    return { owner, available: false, error: String(error?.msg || error?.message || error).slice(0, 240) };
  }
}

function ownerProjectionName(owner) {
  const names = {
    'Console lifecycle / DUPA': 'console-lifecycle',
    'HIS ObservabilityBinding': 'his-observability-binding',
    'Cluster Manager HIS preflight': 'cluster-manager-his',
    'Cluster Manager Ceph integration': 'cluster-manager-ceph',
    'Supabase Data & Identity': 'supabase-data-identity',
    'Gitea Change Control': 'gitea-change-control',
    'Console consumer contracts': 'console-consumer-contracts',
    'Console notification delivery': 'console-notification-delivery',
    'Console Platform Recovery': 'console-platform-recovery',
    'Extension Host registrations': 'extension-host-registrations',
    'Main Shell Registry': 'main-shell-registry',
    'Foundation control plane': 'foundation-control-plane',
  };
  return names[owner] || `owner-${createHash('sha256').update(String(owner || '')).digest('hex').slice(0, 16)}`;
}

function redactProjection(value) {
  const sensitiveKey = /^(password|passwd|apiKey|accessToken|refreshToken|clientSecret|token|secret|secrets|credential|credentials|keyring|kubeconfig|providerExport|stringData)$/i;
  const sanitize = (item, depth = 0) => {
    if (depth > 12) return '[TRUNCATED]';
    if (Array.isArray(item)) return item.slice(0, 500).map((entry) => sanitize(entry, depth + 1));
    if (!item || typeof item !== 'object') return typeof item === 'string' ? redactToolText(item) : item;
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [
      key,
      sensitiveKey.test(key) ? '[REDACTED]' : sanitize(entry, depth + 1),
    ]));
  };
  try { return sanitize(value ?? null); }
  catch { return { redacted: true, reason: 'projection_serialization_failed' }; }
}

function stableOwnerProjection(value) {
  if (Array.isArray(value)) return value.map(stableOwnerProjection);
  if (!value || typeof value !== 'object') return value;
  const volatile = /^(checkedAt|observedAt|generatedAt|servedAt|time|timestamp|lastCheckedAt|lastObservedAt|latencyMs)$/i;
  return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => !volatile.test(key))
    .map((key) => [key, stableOwnerProjection(value[key])]));
}

function ownerProjectionHealth(entry) {
  if (!entry?.available) return 'NotReady';
  const value = entry.value || {};
  if (value.ready === true || ['Ready', 'Connected', 'Activated', 'Established'].includes(value.state || value.status || value.phase)) return 'Ready';
  if (value.ready === false || ['Blocked', 'Failed', 'Denied', 'NotReady'].includes(value.state || value.status || value.phase)) return 'NotReady';
  if (['Degraded', 'Stale'].includes(value.state || value.status || value.phase)) return 'Degraded';
  return 'Unknown';
}

async function readOwnerControlPlaneProjection() {
  const pool = getPgPool();
  if (!pool) return new Map();
  try {
    const result = await pool.query(`
      SELECT name, health, payload, observed_at, expires_at
      FROM runtime_resource
      WHERE source = 'owner-api' AND kind = 'ControlPlaneAuthority'
    `);
    return new Map((result.rows || []).map((row) => [row.name, {
      health: row.health, payload: row.payload, observedAt: row.observed_at,
      fresh: Date.parse(row.expires_at) > Date.now(),
    }]));
  } catch {
    return new Map();
  }
}

async function projectOwnerControlPlaneStatus(entries, observedAt) {
  const pool = getPgPool();
  if (!pool) return false;
  const expiresAt = new Date(Date.parse(observedAt) + Math.max(OAA_RUNTIME_REFRESH_MS * 5, 300000)).toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const rawEntry of entries) {
      const entry = { owner: rawEntry.owner, available: rawEntry.available, ...(rawEntry.available ? { value: redactProjection(rawEntry.value) } : { error: String(rawEntry.error || 'unavailable').slice(0, 240) }) };
      const name = ownerProjectionName(entry.owner);
      const payload = { ...entry, authority: entry.owner, source: 'owner-api' };
      const digest = `sha256:${createHash('sha256').update(JSON.stringify(stableOwnerProjection(payload))).digest('hex')}`;
      const health = ownerProjectionHealth(entry);
      const previous = await client.query(`
        SELECT resource_version FROM runtime_resource
        WHERE source = 'owner-api' AND kind = 'ControlPlaneAuthority' AND namespace = '' AND name = $1
      `, [name]);
      const previousDigest = previous.rows[0]?.resource_version || '';
      await client.query(`
        INSERT INTO runtime_resource (source, kind, namespace, name, resource_version, health, payload, observed_at, expires_at)
        VALUES ('owner-api', 'ControlPlaneAuthority', '', $1, $2, $3, $4::jsonb, $5, $6)
        ON CONFLICT (source, kind, namespace, name) DO UPDATE SET
          resource_version = EXCLUDED.resource_version, health = EXCLUDED.health, payload = EXCLUDED.payload,
          observed_at = EXCLUDED.observed_at, expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp()
      `, [name, digest, health, JSON.stringify(payload), observedAt, expiresAt]);
      if (previousDigest !== digest && await ensureRuntimeWatchSchema(pool)) {
        await client.query(`
          INSERT INTO runtime_event (source, event_type, kind, namespace, name, resource_version, health, payload_digest, observed_at, metadata)
          VALUES ('owner-api', $1, 'ControlPlaneAuthority', '', $2, $3, $4, $3, $5, $6::jsonb)
          ON CONFLICT (source, event_type, kind, namespace, name, resource_version) DO NOTHING
        `, [previousDigest ? 'MODIFIED' : 'ADDED', name, digest, health, observedAt, JSON.stringify({ owner: entry.owner })]);
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.warn('[oaa-owner-projection] Supabase projection skipped:', error.message || error);
    return false;
  } finally {
    client.release();
  }
}

async function controlPlaneStatus(actor) {
  assertPermission(actor, 'console.git.change');
  const checkedAt = new Date().toISOString();
  const [entries, coreReadiness, mutationLifecycle, observabilityCapabilities, hisOwnerCapabilities, cephOwnerCapabilities, recoveryOwnerCapabilities, llmConfigured] = await Promise.all([
    Promise.all([
      settledControlPlaneComponent('Console lifecycle / DUPA', () => dupaGet('/api/admin/platform-readiness/status', actor)),
      settledControlPlaneComponent('HIS ObservabilityBinding', () => dupaGet('/api/admin/observability/status', actor)),
      settledControlPlaneComponent('Cluster Manager HIS preflight', () => clusterManagerGet('/api/his/status', actor)),
      settledControlPlaneComponent('Cluster Manager Ceph integration', () => clusterManagerGet('/api/ceph/status', actor)),
      settledControlPlaneComponent('Supabase Data & Identity', () => backendGet('/api/identity/supabase/status', actor)),
      settledControlPlaneComponent('Gitea Change Control', () => backendGet('/api/platform/gitea/status', actor)),
      settledControlPlaneComponent('Console consumer contracts', () => backendGet('/api/platform/contracts', actor)),
      settledControlPlaneComponent('Console notification delivery', () => backendGet('/api/notifications/summary', actor)),
      settledControlPlaneComponent('Console Platform Recovery', () => backendGet('/api/oaa/owner/recovery/status', actor)),
      settledControlPlaneComponent('Extension Host registrations', () => dupaGet('/api/admin/plugins/registrations', actor)),
      settledControlPlaneComponent('Main Shell Registry', () => dupaGet('/api/v1/registry', actor)),
      settledControlPlaneComponent('Foundation control plane', () => foundationStatusRead(actor)),
    ]),
    computeReadiness({ probeSemantic: false }).catch(() => ({ ready: false, reason: 'readiness_check_failed', capabilities: {} })),
    oaaMutationLifecycle(actor),
    oaaObservabilityCapabilities(actor),
    oaaHisOwnerCapabilities(actor),
    oaaCephOwnerCapabilities(actor),
    oaaRecoveryOwnerCapabilities(actor),
    loadEnabledKey('').then(() => true).catch(() => false),
  ]);
  const previous = await readOwnerControlPlaneProjection();
  const components = Object.fromEntries(entries.map((entry) => {
    if (entry.available) return [entry.owner, entry];
    const last = previous.get(ownerProjectionName(entry.owner));
    return [entry.owner, {
      ...entry,
      ...(last ? { lastKnown: last.payload, lastObservedAt: last.observedAt, stale: true } : {}),
    }];
  }));
  const unavailable = entries.filter((entry) => !entry.available).map((entry) => entry.owner);
  const platformReadiness = entries.find((entry) => entry.owner === 'Console lifecycle / DUPA' && entry.available)?.value || { ready: false, phase: 'Unavailable' };
  const agentControl = buildAgentControlReadiness({
    coreReadiness,
    llmConfigured,
    mutationLifecycle,
    platformReadiness,
    ownerApisUnavailable: unavailable,
    observabilityCapabilities,
    hisOwnerCapabilities,
    cephOwnerCapabilities,
    recoveryOwnerCapabilities,
  });
  const projectionRecorded = await projectOwnerControlPlaneStatus(entries, checkedAt);
  audit(actor, 'control-plane-status', 'opensphere/control-plane', unavailable.length ? 'degraded' : 'ok', unavailable.length ? unavailable.join(', ') : 'all owning APIs reachable');
  return {
    action: 'control-plane-status',
    checkedAt,
    authorityModel: {
      dataAndIdentity: 'Supabase', declarations: 'Gitea', runtime: 'Kubernetes', telemetry: 'HIS', lifecycle: 'Console/Cluster Manager/PFS owner facades',
    },
    ready: unavailable.length === 0,
    fullyOperational: agentControl.fullyOperational,
    agentControl,
    unavailable,
    projection: { authority: 'live owner APIs', durableEvidence: 'supabase', recorded: projectionRecorded },
    components,
  };
}

async function catalogEntitySearch(input, actor) {
  assertPermission(actor, 'oaa.system.read');
  const filter = String(input?.filter || '').trim().slice(0, 200);
  const limit = Math.max(1, Math.min(100, Number(input?.limit || 30) || 30));
  const query = new URLSearchParams({ limit: String(limit) });
  if (filter) query.set('filter', filter);
  const items = await backendGet(`/api/catalog/entities?${query.toString()}`, actor);
  const list = Array.isArray(items) ? items : [];
  audit(actor, 'catalog-entities-read', 'opensphere/catalog', 'ok', `${list.length} entities`);
  return { action: 'catalog-entities-read', filter, count: list.length, items: list };
}

async function registryRead(actor) {
  assertPermission(actor, 'oaa.system.read');
  const registry = redactProjection(await dupaGet('/api/v1/registry', actor));
  const count = Array.isArray(registry?.items)
    ? registry.items.length
    : (Array.isArray(registry?.registrations) ? registry.registrations.length : null);
  audit(actor, 'registry-read', 'opensphere/registry', 'ok', count === null ? 'registry projection read' : `${count} entries`);
  return { action: 'registry-read', authority: 'Main Shell DUPA owner API', count, registry };
}

async function foundationStatusRead(actor) {
  if (!actor?.bearerToken) throw { code: 503, msg: 'Console identity token is unavailable' };
  let response;
  try {
    response = await fetch(`${FOUNDATION_CONTROL_URL}/api/foundation/oaa/status`, {
      headers: { authorization: `Bearer ${actor.bearerToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw { code: 503, msg: 'Foundation owner API is unavailable' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw { code: response.status, msg: body.error || `Foundation owner HTTP ${response.status}` };
  const projection = redactProjection(body);
  audit(actor, 'foundation-status-read', 'Foundation/control-plane', 'ok', `${projection.models?.length || 0} models / ${projection.claims?.length || 0} claims`);
  return projection;
}

async function executeAgentTool(name, args, actor, context = {}) {
  const input = args && typeof args === 'object' ? args : {};
  let result;
  let permissionCode = 'oaa.system.read';
  switch (name) {
    case 'get_environment_snapshot':
      assertPermission(actor, 'oaa.system.read');
      result = await environmentSnapshot(input, actor);
      break;
    case 'get_cluster_pod_summary': {
      assertPermission(actor, 'oaa.system.read');
      const cluster = await clusterPodSummary();
      audit(actor, 'k8s-cluster-pod-summary', 'cluster', 'ok', `${cluster.totalPods || 0} pods`);
      result = { action: 'cluster-pod-summary', cluster };
      break;
    }
    case 'list_kubernetes_resources':
      assertPermission(actor, 'oaa.system.read');
      result = await listKubernetesResources(input, actor);
      break;
    case 'get_kubernetes_resource':
      assertPermission(actor, 'oaa.system.read');
      result = await getKubernetesResource(input, actor);
      break;
    case 'list_namespace_resources': {
      assertPermission(actor, 'oaa.system.read');
      const snapshot = (await selectedSnapshots(input.namespace))[0];
      const category = String(input.category || 'all');
      result = category === 'all' ? snapshot : {
        namespace: snapshot.namespace,
        access: snapshot.access,
        counts: snapshot.counts,
        [category]: category === 'deployments'
          ? (snapshot.workloads || []).filter((item) => item.kind === 'Deployment')
          : (category === 'events' ? snapshot.recentEvents : snapshot[category]),
      };
      break;
    }
    case 'describe_kubernetes_resource':
      assertPermission(actor, 'oaa.system.read');
      result = input.kind === 'pod'
        ? await describePod(input, actor)
        : await describeDeployment(input, actor);
      break;
    case 'get_deployment_rollout':
      assertPermission(actor, 'oaa.system.read');
      result = await rolloutStatus(input, actor);
      break;
    case 'get_pod_logs':
      permissionCode = 'oaa.logs.read';
      assertPermission(actor, permissionCode);
      result = await podLogs(input, actor);
      break;
    case 'query_centralized_logs':
      permissionCode = 'oaa.logs.read';
      result = await observabilityRead(input, actor, 'logs');
      break;
    case 'query_distributed_traces':
      permissionCode = 'oaa.logs.read';
      result = await observabilityRead(input, actor, 'traces');
      break;
    case 'search_opensphere_knowledge':
      permissionCode = 'oaa.knowledge.read';
      assertPermission(actor, permissionCode);
      result = {
        action: 'knowledge-search',
        items: await searchKnowledge(String(input.query || ''), Number(input.limit || OAA_RAG_TOP_K), actor, context),
      };
      break;
    case 'list_governed_actions': {
      assertPermission(actor, 'oaa.system.read');
      const manifest = await gatedActionBindingsForActor(actor);
      const query = String(input.query || '').toLowerCase();
      result = {
        schema: manifest.schema,
        bindings: (manifest.bindings || [])
          .filter((binding) => !query || [binding.id, binding.title, binding.intent, binding.toolId].join(' ').toLowerCase().includes(query))
          .slice(0, 24)
          .map((binding) => ({
            id: binding.id,
            title: binding.title,
            toolId: binding.toolId,
            intent: binding.intent,
            riskLevel: binding.riskLevel,
            confirmation: binding.confirmation,
            confirmationTemplate: binding.confirmationTemplate,
            command: actionCommandForBinding(binding, query),
          })),
      };
      break;
    }
    case 'search_catalog_entities':
      assertPermission(actor, 'oaa.system.read');
      result = await catalogEntitySearch(input, actor);
      break;
    case 'get_opensphere_registry':
      assertPermission(actor, 'oaa.system.read');
      result = await registryRead(actor);
      break;
    case 'get_foundation_status':
      assertPermission(actor, 'oaa.system.read');
      result = await foundationStatusRead(actor);
      break;
    case 'get_console_identity_status':
      permissionCode = 'console.identity.manage';
      result = await identityStatusRead(actor);
      break;
    case 'get_extension_security_status':
      permissionCode = 'console.extension.security.read';
      result = await extensionSecurityStatusRead(actor);
      break;
    case 'inspect_extension_image':
      permissionCode = 'console.extension.security.read';
      result = await extensionImageInspectRead(input, actor);
      break;
    case 'get_notification_status':
      permissionCode = 'console.notification.read';
      result = await notificationStatusRead(input, actor);
      break;
    case 'get_platform_recovery_status':
      permissionCode = 'console.recovery.read';
      result = await recoveryStatusRead(actor);
      break;
    case 'plan_platform_recovery_drill':
      permissionCode = 'console.recovery.read';
      result = await recoveryPlanRead(input, actor);
      break;
    case 'get_his_observability_config':
      permissionCode = 'console.his.read';
      result = await hisObservabilityConfigRead(actor);
      break;
    case 'plan_his_observability_config':
      permissionCode = 'console.his.read';
      result = await hisObservabilityPlanRead(input, actor);
      break;
    case 'get_ceph_status':
      permissionCode = 'console.ceph.read';
      result = await cephStatusRead(actor);
      break;
    case 'plan_ceph_connection':
      permissionCode = 'console.ceph.read';
      result = await cephPlanRead(input, actor);
      break;
    case 'get_agent_evidence_status':
      permissionCode = 'oaa.evidence.read';
      assertPermission(actor, permissionCode);
      result = await agentEvidenceDashboard(input.days || 30, input.limit || 25);
      break;
    case 'get_change_control_status':
      permissionCode = 'console.git.change';
      assertPermission(actor, permissionCode);
      result = {
        gitea: await backendGet('/api/platform/gitea/status', actor),
        contracts: await backendGet('/api/platform/contracts', actor),
      };
      break;
    case 'get_control_plane_status':
      permissionCode = 'console.git.change';
      assertPermission(actor, permissionCode);
      result = await controlPlaneStatus(actor);
      break;
    default:
      throw { code: 400, msg: `unsupported agent tool: ${name}` };
  }
  await recordToolRun(actor, {
    requestId: randomUUID(),
    agentRunId: context.runId || null,
    toolId: `agent.${name}`,
    target: `${input.namespace || 'opensphere'}/${input.name || input.pod || name}`,
    permissionCode,
    reason: 'LLM read-tool loop',
    input,
    status: 'applied',
    result,
  });
  return result;
}

function parseToolArguments(value) {
  const raw = String(value || '{}');
  if (raw.length > 12000) throw { code: 400, msg: 'tool arguments too large' };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw { code: 400, msg: 'invalid tool arguments JSON' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw { code: 400, msg: 'tool arguments must be an object' };
  return parsed;
}

function canonicalToolValue(value) {
  if (Array.isArray(value)) return value.map(canonicalToolValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalToolValue(value[key])]));
  }
  return value;
}

function toolCallSignature(name, args) {
  return `${String(name || '')}:${JSON.stringify(canonicalToolValue(args || {}))}`;
}

function addProviderUsage(total, usage) {
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'totalTokens']) {
    total[key] += Number(usage?.[key] || 0);
  }
  total.source = total.source === 'provider' || usage?.source === 'provider' ? 'provider' : 'unavailable';
  return total;
}

async function providerChatTurn({ baseUrl, key, model, requestBody, actor, source, sessionId, agentRunId = null, round }) {
  const requestId = randomUUID();
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch {
    await recordLlmUsageEvent({
      requestId, agentRunId, actor, source, sessionId, key, model, operation: 'chat_completion', status: 'failed',
      usage: normalizeProviderUsage(null), latencyMs: Date.now() - started, errorCode: 'provider_network_error',
    });
    throw { code: 502, msg: 'LLM provider network request failed' };
  }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  const usage = normalizeProviderUsage(data?.usage);
  const latencyMs = Date.now() - started;
  const message = data?.choices?.[0]?.message || {};
  const finishReason = data?.choices?.[0]?.finish_reason || '';
  if (!response.ok) {
    await recordLlmUsageEvent({
      requestId, agentRunId, providerRequestId: data?.id, actor, source, sessionId, key, model,
      operation: 'chat_completion', status: 'failed', usage, latencyMs,
      errorCode: `provider_http_${response.status}`,
    });
    throw { code: 502, msg: data?.error?.message || data?.message || `provider HTTP ${response.status}` };
  }
  const usageRecorded = await recordLlmUsageEvent({
    requestId, agentRunId, providerRequestId: data?.id, actor, source, sessionId, key,
    model: data?.model || model, operation: 'chat_completion', status: 'succeeded',
    usage, latencyMs, finishReason,
  });
  return { requestId, data, message, usage, usageRecorded, latencyMs, finishReason, round };
}

async function chatCompletion(body, actor) {
  const baseMessages = normalizeMessages(body);
  const commandOut = await handleSlashCommand(latestUserContent(baseMessages), body, actor);
  if (commandOut) return commandOut;
  const key = await loadEnabledKey(String(body.keyId || '').trim());
  const source = usageSource(body.source, 'console-oaa-agent');
  const sessionId = String(body.sessionId || '').slice(0, 200);
  const baseUrl = (key.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = String(body.model || key.defaultModel || 'deepseek-v4-flash').trim();
  if (!MODEL_RE.test(model)) throw { code: 400, msg: 'invalid model' };
  const requestId = randomUUID();
  const started = Date.now();
  const agentRunRecorded = await beginAgentRun({ id: requestId, actor, sessionId, requestText: latestUserContent(baseMessages), key, model });
  let sources = [];
  let conceptGraph = null;
  let suggestedActions = [];
  let messages = baseMessages;
  let environment = null;
  const systemMessages = [operationalAnswerPolicySystemMessage(), controlToolsSystemMessage()];
  const userContent = latestUserContent(baseMessages);
  try {
    sources = await searchKnowledge(userContent, OAA_RAG_TOP_K, actor, { source, sessionId, runId: agentRunRecorded ? requestId : null });
    if (sources.length) systemMessages.push(knowledgeSystemMessage(sources));
  } catch (e) {
    console.warn('[oaa-rag] search skipped:', e.message || e);
  }
  try {
    conceptGraph = await listManualConceptGraph(userContent, 24, actor);
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
  const maxTokens = Math.max(32, Math.min(4096, Number(body.maxTokens || 1024) || 1024));
  const [observabilityCapabilities, hisOwnerCapabilities, cephOwnerCapabilities, recoveryOwnerCapabilities] = await Promise.all([
    oaaObservabilityCapabilities(actor), oaaHisOwnerCapabilities(actor), oaaCephOwnerCapabilities(actor), oaaRecoveryOwnerCapabilities(actor),
  ]);
  const tools = agentToolDefinitions(actor, observabilityCapabilities, hisOwnerCapabilities, cephOwnerCapabilities, recoveryOwnerCapabilities);
  const usage = normalizeProviderUsage(null);
  let usageRecorded = true;
  let data = {};
  let content = '';
  let providerModel = model;
  let rounds = 0;
  const toolTrace = [];
  const toolResultCache = new Map();
  const verifiedToolEvidence = new Map();
  let agentStepIndex = 0;
  try {
  while (rounds < AGENT_MAX_TOOL_ROUNDS) {
    rounds += 1;
    const requestBody = { model, messages, stream: false, max_tokens: maxTokens };
    if (tools.length) {
      requestBody.tools = tools;
      requestBody.tool_choice = 'auto';
    }
    if (key.provider === 'deepseek') requestBody.thinking = { type: 'disabled' };
    const turn = await providerChatTurn({ baseUrl, key, model, requestBody, actor, source, sessionId, agentRunId: agentRunRecorded ? requestId : null, round: rounds });
    data = turn.data;
    providerModel = data?.model || providerModel;
    usageRecorded = usageRecorded && turn.usageRecorded;
    addProviderUsage(usage, turn.usage);
    const normalizedToolCalls = normalizeProviderToolCalls(turn.message, `dsml-${requestId}-${rounds}`);
    if (normalizedToolCalls.malformed) throw { code: 502, msg: 'LLM provider returned a malformed tool-call envelope' };
    const toolCalls = normalizedToolCalls.toolCalls;
    if (agentRunRecorded) await recordAgentStep({
      runId: requestId,
      index: agentStepIndex++,
      kind: 'llm',
      status: 'succeeded',
      input: { round: rounds, messageCount: messages.length, toolCount: tools.length },
      output: { finishReason: turn.finishReason, usage: turn.usage, toolNames: toolCalls.map((call) => call?.function?.name || '') },
      metadata: { provider: key.provider, model: data?.model || model, latencyMs: turn.latencyMs, toolCallEncoding: normalizedToolCalls.encoding },
    });
    if (!toolCalls.length) {
      content = String(turn.message?.content || '');
      break;
    }

    messages.push({
      role: 'assistant',
      content: normalizedToolCalls.encoding === 'deepseek-dsml' || turn.message?.content == null ? null : String(turn.message.content),
      tool_calls: toolCalls,
    });
    let freshToolCalls = 0;
    for (const call of toolCalls.slice(0, 8)) {
      const toolName = String(call?.function?.name || '');
      let args = {};
      let output;
      let ok = false;
      let cached = false;
      try {
        args = parseToolArguments(call?.function?.arguments);
        const signature = toolCallSignature(toolName, args);
        if (toolResultCache.has(signature)) {
          ({ output, ok } = toolResultCache.get(signature));
          cached = true;
        } else {
          output = await executeAgentTool(toolName, args, actor, { source, sessionId, runId: agentRunRecorded ? requestId : null });
          ok = true;
          freshToolCalls += 1;
          toolResultCache.set(signature, { output, ok });
          verifiedToolEvidence.set(signature, { tool: toolName, arguments: args, result: output });
        }
      } catch (error) {
        output = { ok: false, error: error.msg || error.message || String(error) };
        const signature = toolCallSignature(toolName, args);
        if (!toolResultCache.has(signature)) {
          freshToolCalls += 1;
          toolResultCache.set(signature, { output, ok: false });
          verifiedToolEvidence.set(signature, { tool: toolName, arguments: args, result: output });
          await recordToolRun(actor, {
            requestId: randomUUID(),
            agentRunId: agentRunRecorded ? requestId : null,
            toolId: `agent.${toolName || 'unknown'}`,
            target: `${args.namespace || 'opensphere'}/${args.name || args.pod || toolName || 'unknown'}`,
            permissionCode: 'oaa.system.read',
            reason: 'LLM read-tool loop',
            input: args,
            status: 'failed',
            result: output,
          });
        } else {
          cached = true;
        }
      }
      toolTrace.push({
        round: rounds,
        name: toolName,
        status: ok ? 'succeeded' : 'failed',
        target: `${args.namespace || 'opensphere'}/${args.name || args.pod || toolName || 'unknown'}`,
        encoding: normalizedToolCalls.encoding,
        cached,
      });
      if (agentRunRecorded) await recordAgentStep({
        runId: requestId,
        index: agentStepIndex++,
        kind: 'tool',
        toolId: toolName,
        status: ok ? 'succeeded' : 'failed',
        input: args,
        output,
        metadata: { round: rounds, target: `${args.namespace || 'opensphere'}/${args.name || args.pod || toolName || 'unknown'}`, toolCallEncoding: normalizedToolCalls.encoding, cached },
      });
      messages.push({
        role: 'tool',
        tool_call_id: String(call?.id || randomUUID()),
        name: toolName,
        content: toolResultContent(output),
      });
    }
    if (freshToolCalls === 0) {
      audit(actor, 'agent-tool-loop-deduplicated', key.id, 'ok', `round=${rounds}; repeated_calls=${toolCalls.length}`);
      break;
    }
  }

  if (!content) {
    const evidence = redactToolText(JSON.stringify(Array.from(verifiedToolEvidence.values()))).slice(0, 24000);
    const finalMessages = [...systemMessages, {
      role: 'system',
      content: `Automatic tool execution is complete. Produce the final natural-language answer using only the verified evidence JSON below. Do not emit XML, DSML, JSON, tool calls, or requests for more tools. State uncertainty when evidence is insufficient.\nVERIFIED_TOOL_EVIDENCE=${evidence}`,
    }, ...baseMessages];
    // Do not send a tools field on the synthesis request. Some OpenAI-compatible
    // providers ignore tool_choice=none and otherwise emit another tool envelope.
    const requestBody = { model, messages: finalMessages, stream: false, max_tokens: maxTokens };
    if (key.provider === 'deepseek') requestBody.thinking = { type: 'disabled' };
    const finalTurn = await providerChatTurn({ baseUrl, key, model, requestBody, actor, source, sessionId, agentRunId: agentRunRecorded ? requestId : null, round: rounds + 1 });
    data = finalTurn.data;
    providerModel = data?.model || providerModel;
    usageRecorded = usageRecorded && finalTurn.usageRecorded;
    addProviderUsage(usage, finalTurn.usage);
    const finalToolCalls = normalizeProviderToolCalls(finalTurn.message, `dsml-${requestId}-final`);
    if (finalToolCalls.malformed || finalToolCalls.toolCalls.length) {
      throw { code: 502, msg: 'LLM provider did not honor the final no-tool response contract' };
    }
    content = String(finalTurn.message?.content || '');
    if (!content.trim()) throw { code: 502, msg: 'LLM provider returned an empty final response' };
    rounds += 1;
    if (agentRunRecorded) await recordAgentStep({
      runId: requestId,
      index: agentStepIndex++,
      kind: 'llm',
      status: 'succeeded',
      input: { round: rounds, messageCount: finalMessages.length, toolCount: 0, forcedFinal: true },
      output: { finishReason: finalTurn.finishReason, usage: finalTurn.usage, toolNames: [] },
      metadata: { provider: key.provider, model: data?.model || model, latencyMs: finalTurn.latencyMs },
    });
  }
  } catch (error) {
    if (agentRunRecorded) await finishAgentRun(requestId, 'failed', toolTrace.length, error.errorCode || error.code || 'agent_loop_failed');
    throw error;
  }
  const latencyMs = Date.now() - started;
  if (agentRunRecorded) await finishAgentRun(requestId, 'completed', toolTrace.length);
  audit(actor, 'chat-completion', key.id, 'ok', `${key.provider}/${model}; agent_rounds=${rounds}; tool_calls=${toolTrace.length}; total_tokens=${usage.totalTokens}; usage_recorded=${usageRecorded}`);
  return {
    requestId,
    keyId: key.id,
    provider: key.provider,
    model: providerModel,
    message: content,
    usage,
    usageRecorded,
    latencyMs,
    agent: {
      mode: 'permission-filtered-read-tool-loop',
      rounds,
      maxToolRounds: AGENT_MAX_TOOL_ROUNDS,
      toolsAvailable: tools.map((tool) => tool.function.name),
      toolCalls: toolTrace,
      mutationsRequireExplicitCommand: true,
      evidenceRecorded: agentRunRecorded,
    },
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
  assertMutationEnabled(actor, 'llm-key-upsert');
  const b = validateKeyBody(body);
  const fingerprint = createHash('sha256').update(b.apiKey).digest('hex').slice(0, 16);
  const now = new Date().toISOString();
  const obj = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName(b.id),
      namespace: OAA_KEY_NAMESPACE,
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
  const created = await k8s('POST', `/api/v1/namespaces/${OAA_KEY_NAMESPACE}/secrets`, obj);
  if (created.ok) return { created: true, item: keyMetaFromSecret({ metadata: obj.metadata }) };
  if (created.status !== 409) throw { code: 502, msg: `secret create HTTP ${created.status}` };
  const patched = await k8s('PATCH', `/api/v1/namespaces/${OAA_KEY_NAMESPACE}/secrets/${obj.metadata.name}`, {
    metadata: { labels: obj.metadata.labels, annotations: obj.metadata.annotations },
    stringData: obj.stringData,
  });
  if (!patched.ok) throw { code: 502, msg: `secret patch HTTP ${patched.status}` };
  return { created: false, item: keyMetaFromSecret({ metadata: obj.metadata }) };
}

async function deleteKey(id) {
  assertMutationEnabled(null, 'llm-key-delete');
  if (!ID_RE.test(id)) throw { code: 400, msg: 'invalid id' };
  const r = await k8s('DELETE', `/api/v1/namespaces/${OAA_KEY_NAMESPACE}/secrets/${secretName(id)}`);
  if (r.ok || r.status === 404) return { deleted: r.status !== 404 };
  throw { code: 502, msg: `secret delete HTTP ${r.status}` };
}

function audit(actor, action, target, result, reason) {
  const entry = {
    time: new Date().toISOString(),
    actor: actor?.username || 'system',
    action,
    target,
    result,
    reason: reason || '',
  };
  console.log('[oaa-audit] ' + JSON.stringify(entry));
  // Best-effort for reads.  Mutations are fail-closed elsewhere and cannot be
  // performed by this gateway; their intent/result must be recorded by the
  // Console Backend before any control-plane side effect.
  if (actor?.bearerToken) {
    void fetch(`${CONSOLE_IDENTITY_URL}/api/oaa/audit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${actor.bearerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action, target, result, reason: reason || 'OAA read/planning operation', targetType: 'oaa' }),
      signal: AbortSignal.timeout(3000),
    }).catch((error) => console.warn('[oaa-audit] persistence skipped:', error.message || error));
  }
}

// Retrieval evidence is deliberately separate from the Console audit event.
// The latter records a user-visible operation; this table preserves the exact
// (ACL-filtered) corpus evidence used to answer it.  Some authenticated
// service principals do not have a Supabase auth.users UUID, so only write a
// foreign-key-safe trace when the Console identity subject is a UUID.
async function recordRetrievalTrace(actor, query, hits, agentRunId = null) {
  if (!OAA_SUPABASE_MODE || !Array.isArray(hits) || hits.length === 0) return;
  const actorId = String(actor?.subject || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actorId)) return;
  const pool = getPgPool();
  if (!pool) return;
  const requestId = randomUUID();
  const queryDigest = `sha256:${createHash('sha256').update(String(query || '')).digest('hex')}`;
  try {
    await Promise.all(hits.map((hit, index) => {
      if (!hit.documentId || !hit.chunkId) return Promise.resolve();
      return pool.query(
        `INSERT INTO retrieval_trace
           (request_id, agent_run_id, actor_id, query_digest, document_id, chunk_id, document_revision, rank, score)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [requestId, agentRunId, actorId, queryDigest, hit.documentId, hit.chunkId, hit.documentRevision || null, index + 1, Number(hit.score || 0)],
      );
    }));
  } catch (error) {
    // Evidence failure must not leak content or turn an already ACL-safe read
    // into an availability incident; the Console audit still records the read.
    console.warn('[oaa-retrieval-trace] persistence skipped:', error.message || error);
  }
}

async function recordToolRun(actor, { requestId, agentRunId = null, toolId, target, permissionCode, reason, input, status, result }) {
  if (!OAA_SUPABASE_MODE) return;
  const actorId = String(actor?.subject || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actorId)) return;
  const pool = getPgPool();
  if (!pool || !requestId) return;
  const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value || {})).digest('hex')}`;
  try {
    await pool.query(
      `INSERT INTO tool_run
         (request_id, agent_run_id, actor_id, tool_id, target, permission_code, reason, input_digest, status, result_digest, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $9 IN ('applied', 'failed', 'blocked') THEN now() ELSE NULL END)`,
      [requestId, agentRunId, actorId, toolId, target, permissionCode, reason || null, digest(input), status, digest(result)],
    );
  } catch (error) {
    // The Console Backend's begin_change transaction is authoritative for a
    // mutating intent.  This OAA-side evidence row is supplemental and must
    // not make a persisted, idempotent request appear rejected to the user.
    console.warn('[oaa-tool-run] persistence skipped:', error.message || error);
  }
}

function evidenceDigest(value) {
  return `sha256:${createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value || {})).digest('hex')}`;
}

async function beginAgentRun({ id, actor, sessionId, requestText, key, model }) {
  const pool = getPgPool();
  if (!pool) return false;
  try {
    await pool.query(`
      INSERT INTO agent_run
        (id, actor_id, actor_label, session_digest, request_digest, provider, model, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'running')
    `, [
      id,
      String(actor?.subject || 'system').slice(0, 200),
      String(actor?.username || actor?.subject || 'system').slice(0, 200),
      sessionId ? evidenceDigest(sessionId) : null,
      evidenceDigest(requestText),
      String(key?.provider || 'unknown').slice(0, 64),
      String(model || 'unknown').slice(0, 160),
    ]);
    return true;
  } catch (error) {
    console.warn('[oaa-agent-run] start persistence skipped:', error.message || error);
    return false;
  }
}

async function recordAgentStep({ runId, index, kind, toolId = null, status, input, output, metadata = {} }) {
  const pool = getPgPool();
  if (!pool || !runId) return false;
  try {
    await pool.query(`
      INSERT INTO agent_step
        (run_id, step_index, step_kind, tool_id, status, input_digest, output_digest, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (run_id, step_index) DO NOTHING
    `, [runId, index, kind, toolId, status, evidenceDigest(input), evidenceDigest(output), JSON.stringify(metadata || {})]);
    return true;
  } catch (error) {
    console.warn('[oaa-agent-run] step persistence skipped:', error.message || error);
    return false;
  }
}

async function finishAgentRun(runId, status, toolCalls, errorCode = null) {
  const pool = getPgPool();
  if (!pool || !runId) return false;
  try {
    await pool.query(`
      UPDATE agent_run SET status = $2, tool_calls = $3, completed_at = clock_timestamp(), error_code = $4
      WHERE id = $1 AND status = 'running'
    `, [runId, status, Math.max(0, Number(toolCalls || 0)), errorCode ? String(errorCode).slice(0, 160) : null]);
    return true;
  } catch (error) {
    console.warn('[oaa-agent-run] completion persistence skipped:', error.message || error);
    return false;
  }
}

async function submitControlPlaneAction(binding, inputs, target, actor) {
  if (!actor?.bearerToken) throw { code: 503, msg: 'Console identity token is unavailable for control-plane submission' };
  let response;
  try {
    response = await fetch(`${CONSOLE_IDENTITY_URL}/api/oaa/actions/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${actor.bearerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bindingId: binding.id, toolId: binding.toolId, target, inputs, reason: inputs.reason }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw { code: 503, msg: 'Console Backend control-plane submission is unavailable' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.accepted || !body.requestId) {
    throw { code: response.status >= 400 ? response.status : 502, msg: body.error || 'Console Backend rejected OAA action submission' };
  }
  return body;
}

function publicEmbeddingReadiness() {
  return {
    ready: embeddingReadiness.ready,
    reason: embeddingReadiness.reason,
    keyId: embeddingReadiness.keyId,
    provider: embeddingReadiness.provider,
    model: embeddingReadiness.model,
    checkedAt: embeddingReadiness.checkedAtMs ? new Date(embeddingReadiness.checkedAtMs).toISOString() : null,
  };
}

async function checkEmbeddingReadiness(forceProbe = false) {
  const fresh = embeddingReadiness.checkedAtMs > 0
    && Date.now() - embeddingReadiness.checkedAtMs < OAA_EMBED_READINESS_TTL_MS;
  if (fresh) return publicEmbeddingReadiness();

  if (!forceProbe) {
    const keys = await listKeys().catch(() => []);
    const configured = keys.find((key) => key.enabled && key.embeddingModel && key.validationStatus === 'ready');
    if (configured) {
      return {
        ready: true,
        reason: 'configured_not_live_probed',
        keyId: configured.id,
        provider: configured.provider,
        model: configured.embeddingModel,
        checkedAt: configured.validatedAt || null,
      };
    }
    return {
      ready: false,
      reason: keys.some((key) => key.enabled && key.embeddingModel)
        ? 'embedding_key_not_validated'
        : 'embedding_key_not_configured',
      keyId: '', provider: '', model: '', checkedAt: null,
    };
  }

  try {
    await embeddingVector('OpenSphere semantic search readiness probe', {
      strict: true,
      source: 'embedding-readiness',
    });
  } catch (error) {
    if (!embeddingReadiness.checkedAtMs || fresh) {
      rememberEmbeddingReadiness(false, null, error.message || error);
    }
  }
  return publicEmbeddingReadiness();
}

// CONSTITUTION-0004 §4.5: Main Shell Baseline Ready requires PostgreSQL/pgvector connectivity and
// Manual Registry availability. /readyz is the unauthenticated, in-cluster-only probe target the
// Console DUPA controller's platform-control readiness aggregate consumes as a required
// component. It must never return 200 on a guess — every component below is a live check, and the
// response body is structured booleans/reasons only (no secret material, no stack traces).
async function computeReadiness({ probeSemantic = false } = {}) {
  const components = {
    postgres: false,
    vectorSchema: false,
    usageLedger: false,
    runtimeProjection: false,
    runtimeWatchSchema: false,
    agentLedger: false,
    manualRegistrySeed: false,
    toolRegistrySeed: false,
  };
  const pool = getPgPool();
  if (!pool) {
    return { ready: false, components, reason: 'postgres_not_configured' };
  }
  try {
    await pool.query('SELECT 1');
    components.postgres = true;
  } catch {
    return { ready: false, components, reason: 'postgres_unreachable' };
  }
  try {
    await ensureKnowledgeSchema();
    components.vectorSchema = pgSchemaReady === true;
  } catch {
    components.vectorSchema = false;
  }
  if (!components.vectorSchema) {
    return { ready: false, components, reason: 'vector_schema_not_ready' };
  }
  try {
    await ensureUsageLedgerSchema();
    components.usageLedger = pgUsageLedgerReady === true;
  } catch {
    components.usageLedger = false;
  }
  if (!components.usageLedger) {
    return { ready: false, components, reason: 'usage_ledger_not_ready' };
  }
  try {
    const controlSchema = await pool.query(`
      SELECT
        to_regclass('oaa.runtime_resource') IS NOT NULL AS runtime_projection,
        to_regclass('oaa.runtime_event') IS NOT NULL
          AND to_regclass('oaa.watch_cursor') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'oaa' AND table_name = 'watch_cursor' AND column_name = 'observer_id'
          ) AS runtime_watch_schema,
        to_regclass('oaa.agent_run') IS NOT NULL AND to_regclass('oaa.agent_step') IS NOT NULL AS agent_ledger
    `);
    components.runtimeProjection = controlSchema.rows[0]?.runtime_projection === true;
    components.runtimeWatchSchema = controlSchema.rows[0]?.runtime_watch_schema === true;
    components.agentLedger = controlSchema.rows[0]?.agent_ledger === true;
  } catch {
    components.runtimeProjection = false;
    components.runtimeWatchSchema = false;
    components.agentLedger = false;
  }
  if (!components.runtimeProjection || !components.runtimeWatchSchema || !components.agentLedger) {
    return { ready: false, components, reason: 'agent_control_schema_not_ready' };
  }
  const manualRegistrySeedQuery = `
    SELECT count(*)::int AS n
    FROM oaa_knowledge_documents
    WHERE source_type = 'manual' AND metadata->'source'->>'id' = 'opensphere-core-manuals'
  `;
  try {
    loadBundledManualSeedManifest();
    const r = await pool.query(manualRegistrySeedQuery);
    if (Number(r.rows[0]?.n || 0) > 0) {
      // Rows already present — never re-upsert/write on a readiness probe once seeded.
      components.manualRegistrySeed = true;
    } else {
      // Self-heal: the schema is ready but the bundled Manual Registry seed row is absent. This
      // happens when the async startup seed raced PostgreSQL before it was ready and failed
      // (leaving /readyz stuck 503 forever). Retry through the existing concurrency-safe seeder
      // and re-query before deciding the component's state.
      await ensureManualRegistryReady().catch(() => null);
      const r2 = await pool.query(manualRegistrySeedQuery);
      components.manualRegistrySeed = Number(r2.rows[0]?.n || 0) > 0;
    }
  } catch {
    components.manualRegistrySeed = false;
  }
  if (!components.manualRegistrySeed) {
    return { ready: false, components, reason: 'manual_registry_seed_not_ready' };
  }
  const toolRegistrySeedQuery = 'SELECT count(*)::int AS n FROM oaa_tool_capabilities';
  try {
    const r = await pool.query(toolRegistrySeedQuery);
    if (Number(r.rows[0]?.n || 0) > 0) {
      // Rows already present — never re-upsert/write on a readiness probe once seeded.
      components.toolRegistrySeed = true;
    } else {
      // Self-heal: same startup-race scenario as the Manual Registry above, but for the tool
      // capability registry. Retry through the concurrency-safe ensureToolRegistryReady() and
      // re-query before deciding the component's state.
      await ensureToolRegistryReady().catch(() => null);
      const r2 = await pool.query(toolRegistrySeedQuery);
      components.toolRegistrySeed = Number(r2.rows[0]?.n || 0) > 0;
    }
  } catch {
    components.toolRegistrySeed = false;
  }
  if (!components.toolRegistrySeed) {
    return { ready: false, components, reason: 'tool_registry_seed_not_ready' };
  }
  const semanticSearch = await checkEmbeddingReadiness(probeSemantic).catch(() => ({
    ready: false,
    reason: 'embedding_readiness_check_failed',
    keyId: '', provider: '', model: '', checkedAt: null,
  }));
  const runtimeProjection = await runtimeProjectionStatus();
  return {
    ready: true,
    components,
    capabilities: { lexicalSearch: true, semanticSearch, runtimeProjection },
    degraded: !semanticSearch.ready || !runtimeProjection.ready,
    degradedReason: !runtimeProjection.ready
      ? (runtimeProjection.reason || 'runtime_projection_stale')
      : (semanticSearch.ready ? null : semanticSearch.reason),
    reason: null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // /healthz is the internal (unauthenticated) liveness/startup probe target for Kubernetes only
    // (process is up). It intentionally never checks PostgreSQL/pgvector/seed state — that is /readyz.
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    // /readyz is the internal (unauthenticated), in-cluster-only readiness probe target. It is the
    // component the Console DUPA controller's Main Shell /readyz aggregation depends on
    // (CONSTITUTION-0004 §4.5). It returns 200 only once PostgreSQL is reachable, the pgvector
    // extension/schema exist, the bundled Manual Registry seed is present, and the tool registry
    // schema/seed is present. On failure it returns a structured 503 with per-component booleans
    // and a stable machine-readable reason — never secret material or a stack trace. This endpoint
    // is not proxied through nginx and must only be reachable from in-cluster probes.
    if (url.pathname === '/readyz') {
      const state = await computeReadiness().catch(() => ({ ready: false, components: {}, reason: 'readiness_check_failed' }));
      return json(res, state.ready ? 200 : 503, {
        service: 'opensphere-console-oaa-gateway',
        ready: state.ready,
        components: state.components,
        capabilities: state.capabilities || { lexicalSearch: false, semanticSearch: { ready: false, reason: 'core_not_ready' } },
        degraded: Boolean(state.degraded),
        degradedReason: state.degradedReason || null,
        reason: state.reason,
      });
    }
    // /api/oaa/health is the browser-facing, authenticated status contract the admin UI reads to
    // decide whether mutation/action tools may be surfaced. It must never be reachable without a
    // valid session, and it must expose explicit readiness/degraded/mutation gate state rather than
    // requiring the UI to infer it.
    if (url.pathname === '/api/oaa/health') {
      await verifyAuthed(req);
      const readiness = await computeReadiness({ probeSemantic: true }).catch(() => ({ ready: false, components: {}, reason: 'readiness_check_failed' }));
      let hasEnabledLlmKey = false;
      if (readiness.ready) {
        try { await loadEnabledKey(''); hasEnabledLlmKey = true; } catch { hasEnabledLlmKey = false; }
      }
      const semanticSearch = readiness.capabilities?.semanticSearch || { ready: false, reason: 'embedding_readiness_unknown' };
      const runtimeProjection = readiness.capabilities?.runtimeProjection || { ready: false, reason: 'runtime_projection_unknown' };
      const degraded = readiness.ready && (!hasEnabledLlmKey || !semanticSearch.ready || !runtimeProjection.ready);
      const status = !readiness.ready ? 'not_ready' : (degraded ? 'degraded' : 'ready');
      const degradedReason = !hasEnabledLlmKey
        ? 'llm_key_not_configured'
        : (!runtimeProjection.ready
          ? (runtimeProjection.reason || 'runtime_projection_stale')
          : (!semanticSearch.ready ? semanticSearch.reason : null));
      return json(res, 200, {
        service: 'opensphere-console-oaa-gateway',
        version: VERSION,
        namespace: OAA_NAMESPACE,
        ok: true,
        status,
        readiness: {
          ready: readiness.ready,
          components: readiness.components,
          capabilities: readiness.capabilities,
          reason: readiness.reason,
        },
        degraded,
        degradedReason,
        // Compatibility names describe controlled submission availability, not
        // a Kubernetes-write capability.  The Gateway direct-write path stays
        // permanently fail-closed even when this is true.
        mutationEnabled: OAA_ACTION_SUBMISSION_ENABLED,
        mutationGateReason: OAA_ACTION_SUBMISSION_ENABLED ? null : 'console_backend_action_submission_disabled',
        mutationGate: { enabled: OAA_ACTION_SUBMISSION_ENABLED, reason: OAA_ACTION_SUBMISSION_ENABLED ? null : 'console_backend_action_submission_disabled' },
        directKubernetesMutationEnabled: false,
        ragEnabled: OAA_RAG_ENABLED,
        lexicalSearchReady: readiness.ready,
        semanticSearchReady: Boolean(semanticSearch.ready),
        semanticSearch,
        runtimeProjection,
        pgConfigured: pgEnabled(),
        embedDim: OAA_EMBED_DIM,
        allowedNamespaces: OAA_ENV_NAMESPACES,
        mutationNamespaces: OAA_MUTATION_NAMESPACES,
        scaleMax: OAA_SCALE_MAX,
      });
    }
    if (url.pathname === '/api/oaa/admin/knowledge/stats' && req.method === 'GET') {
      await verifyAdmin(req);
      return json(res, 200, await knowledgeStats());
    }
    if (url.pathname === '/api/oaa/admin/usage' && req.method === 'GET') {
      const actor = await verifyAdmin(req);
      assertPermission(actor, 'oaa.usage.read');
      return json(res, 200, await llmUsageDashboard(url.searchParams.get('days') || 30));
    }
    if (url.pathname === '/api/oaa/admin/evidence' && req.method === 'GET') {
      const actor = await verifyAdmin(req);
      assertPermission(actor, 'oaa.evidence.read');
      return json(res, 200, await agentEvidenceDashboard(url.searchParams.get('days') || 30, url.searchParams.get('limit') || 25));
    }
    if (url.pathname === '/api/oaa/admin/evidence/retention' && req.method === 'POST') {
      const actor = await verifyAdmin(req);
      if (!OAA_ACTION_SUBMISSION_ENABLED) assertMutationEnabled(actor, 'oaa.evidence.retention.update');
      const body = await readBody(req);
      const result = await setEvidenceRetentionPolicy(actor, body);
      await recordToolRun(actor, {
        requestId: randomUUID(), toolId: 'oaa.evidence.retention.update', target: result.target,
        permissionCode: 'oaa.evidence.manage', reason: body.reason, input: body, status: 'applied', result,
      });
      audit(actor, 'oaa-evidence-retention-update', result.target, 'ok', body.reason);
      return json(res, 200, result);
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
      const actor = await verifyAuthed(req);
      const q = url.searchParams.get('q') || '';
      return json(res, 200, { items: await searchKnowledge(q, Number(url.searchParams.get('limit') || OAA_RAG_TOP_K), actor) });
    }
    if (url.pathname === '/api/oaa/knowledge/concepts' && req.method === 'GET') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await listManualConceptGraph(url.searchParams.get('q') || '', Number(url.searchParams.get('limit') || 64), actor));
    }
    if (url.pathname === '/api/manual/sources' && req.method === 'GET') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await listManualSources(actor));
    }
    if (url.pathname === '/api/manual/documents' && req.method === 'GET') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await listManualDocuments({
        q: url.searchParams.get('q') || '',
        source: url.searchParams.get('source') || '',
        limit: url.searchParams.get('limit') || 40,
      }, actor));
    }
    if (url.pathname === '/api/manual/document' && req.method === 'GET') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await getManualDocument(url.searchParams.get('sourceId') || '', actor));
    }
    if (url.pathname === '/api/manual/search' && req.method === 'GET') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await searchManualRegistry(url.searchParams.get('q') || '', Number(url.searchParams.get('limit') || 8), actor));
    }
    if (url.pathname === '/api/oaa/tools/manifest' && req.method === 'GET') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await gatedToolManifestForActor(actor));
    }
    if (url.pathname === '/api/oaa/tools/action-bindings' && req.method === 'GET') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await gatedActionBindingsForActor(actor));
    }
    if (url.pathname === '/api/oaa/tools/environment' && (req.method === 'GET' || req.method === 'POST')) {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.system.read');
      const body = req.method === 'POST' ? await readBody(req) : {};
      return json(res, 200, await environmentSnapshot(body, actor));
    }
    if (url.pathname === '/api/oaa/tools/control-plane/status' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'console.git.change');
      return json(res, 200, await controlPlaneStatus(actor));
    }
    if (url.pathname === '/api/oaa/tools/identity/status' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await identityStatusRead(actor));
    }
    if (url.pathname === '/api/oaa/tools/extensions/security' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await extensionSecurityStatusRead(actor));
    }
    if (url.pathname === '/api/oaa/tools/extensions/inspect' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await extensionImageInspectRead(await readBody(req), actor));
    }
    if (url.pathname === '/api/oaa/tools/notifications/status' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await notificationStatusRead(await readBody(req), actor));
    }
    if (url.pathname === '/api/oaa/tools/his/observability/config' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      requireClosedOwnerInputs(await readBody(req), []);
      return json(res, 200, await hisObservabilityConfigRead(actor));
    }
    if (url.pathname === '/api/oaa/tools/his/observability/plan' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await hisObservabilityPlanRead(await readBody(req), actor));
    }
    if (url.pathname === '/api/oaa/tools/ceph/status' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      requireClosedOwnerInputs(await readBody(req), []);
      return json(res, 200, await cephStatusRead(actor));
    }
    if (url.pathname === '/api/oaa/tools/ceph/plan' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await cephPlanRead(await readBody(req), actor));
    }
    if (url.pathname === '/api/oaa/tools/evidence/status' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.evidence.read');
      const body = await readBody(req);
      return json(res, 200, await agentEvidenceDashboard(body.days || 30, body.limit || 25));
    }
    if (url.pathname === '/api/oaa/tools/recovery/status' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      requireClosedOwnerInputs(await readBody(req), []);
      return json(res, 200, await recoveryStatusRead(actor));
    }
    if (url.pathname === '/api/oaa/tools/recovery/plan' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await recoveryPlanRead(await readBody(req), actor));
    }
    if (url.pathname === '/api/oaa/tools/observability/logs' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await observabilityRead(await readBody(req), actor, 'logs'));
    }
    if (url.pathname === '/api/oaa/tools/observability/traces' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      return json(res, 200, await observabilityRead(await readBody(req), actor, 'traces'));
    }
    if (url.pathname === '/api/oaa/tools/catalog/entities' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.system.read');
      return json(res, 200, await catalogEntitySearch(await readBody(req), actor));
    }
    if (url.pathname === '/api/oaa/tools/registry' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.system.read');
      return json(res, 200, await registryRead(actor));
    }
    if (url.pathname === '/api/oaa/tools/foundation/status' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.system.read');
      return json(res, 200, await foundationStatusRead(actor));
    }
    if (url.pathname === '/api/oaa/tools/k8s/resources' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.system.read');
      return json(res, 200, await listKubernetesResources(await readBody(req), actor));
    }
    if (url.pathname === '/api/oaa/tools/k8s/resource' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.system.read');
      return json(res, 200, await getKubernetesResource(await readBody(req), actor));
    }
    if (url.pathname === '/api/oaa/tools/k8s/pod-logs' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.logs.read');
      const body = await readBody(req);
      return json(res, 200, await podLogs(body, actor));
    }
    if (url.pathname === '/api/oaa/tools/k8s/pods-summary' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.system.read');
      const out = await clusterPodSummary();
      audit(actor, 'k8s-cluster-pod-summary', 'cluster', 'ok', `${out.totalPods || 0} pods`);
      return json(res, 200, { action: 'cluster-pod-summary', message: summarizeClusterPods(out), cluster: out });
    }
    if (url.pathname === '/api/oaa/tools/k8s/describe' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.system.read');
      const body = await readBody(req);
      const kind = String(body.kind || '').toLowerCase();
      if (kind === 'pod' || kind === 'pods') return json(res, 200, await describePod(body, actor));
      if (kind === 'deployment' || kind === 'deploy' || kind === 'deployments') return json(res, 200, await describeDeployment(body, actor));
      return json(res, 400, { error: 'kind must be pod or deployment' });
    }
    if (url.pathname === '/api/oaa/tools/k8s/rollout' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.system.read');
      const body = await readBody(req);
      return json(res, 200, await rolloutStatus(body, actor));
    }
    if (url.pathname === '/api/oaa/tools/k8s/services' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.system.read');
      const body = await readBody(req);
      const out = await selectedSnapshots(body.namespace || '');
      audit(actor, 'k8s-services', body.namespace || OAA_ENV_NAMESPACES.join(','), 'ok', `${out.length} namespaces`);
      return json(res, 200, { action: 'services', message: summarizeServices(out), namespaces: out });
    }
    if (url.pathname === '/api/oaa/tools/k8s/events' && req.method === 'POST') {
      const actor = await verifyAuthed(req);
      assertPermission(actor, 'oaa.system.read');
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
      assertPermission(actor, 'oaa.chat.use');
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
    // Stable machine-readable error code (e.g. mutation_disabled_until_his_ready) alongside the
    // human-readable message. Never include raw secrets/tokens/stack traces in the response body.
    const responseBody = { error: e.msg || e.message || String(e) };
    if (e.errorCode) responseBody.code = e.errorCode;
    return json(res, code, responseBody);
  }
});

async function initializeGatewayData(attempt = 1) {
  try {
    const builtin = await seedBuiltinKnowledge();
    if (builtin.seeded) console.log(`[oaa-db] seeded ${builtin.documents} docs / ${builtin.chunks} chunks (dim=${OAA_EMBED_DIM})`);
    else console.log(`[oaa-db] ready (${builtin.reason || 'ok'}, dim=${OAA_EMBED_DIM})`);
    const manuals = await reconcileBundledManualKnowledge();
    if (manuals.seeded) console.log(`[oaa-db] seeded bundled manuals ${manuals.documents} docs / ${manuals.chunks} chunks`);
    else console.log(`[oaa-db] bundled manuals ready (${manuals.reason || 'ok'})`);
    const registry = await seedToolRegistry();
    if (registry.seeded) console.log(`[oaa-db] seeded tool registry ${registry.tools} tools / ${registry.bindings} bindings`);
    else console.log(`[oaa-db] tool registry ready (${registry.reason || 'ok'})`);
  } catch (error) {
    if (attempt < 4) {
      const delayMs = attempt * 2000;
      console.warn(`[oaa-db] initialization retry ${attempt}/3 in ${delayMs}ms:`, error.message || error);
      const timer = setTimeout(() => { void initializeGatewayData(attempt + 1); }, delayMs);
      timer.unref();
      return;
    }
    console.error('[oaa-db] initialization failed after retries:', error.message || error);
  }
}

server.listen(PORT, () => {
  console.log(`opensphere-console-oaa-gateway v${VERSION} listening :${PORT} (ns=${OAA_NAMESPACE})`);
  void initializeGatewayData();
  void refreshRuntimeProjection();
  startRuntimeWatches();
  const runtimeTimer = setInterval(() => { void refreshRuntimeProjection(); }, OAA_RUNTIME_REFRESH_MS);
  runtimeTimer.unref();
});

function stopGateway() {
  runtimeWatchStopping = true;
  if (runtimeWatchHeartbeatTimer) clearInterval(runtimeWatchHeartbeatTimer);
  for (const controller of runtimeWatchControllers) controller.abort();
  server.close();
}
process.on('SIGTERM', stopGateway);
process.on('SIGINT', stopGateway);
