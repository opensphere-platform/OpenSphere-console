#!/usr/bin/env node
'use strict';

/*
 * One-way OAA knowledge cutover helper.
 *
 * It deliberately does NOT copy legacy hash vectors.  It copies document,
 * chunk, concept, relation, capability and binding metadata, then requires a
 * real embedding provider for every target chunk.  Run with --dry-run first;
 * --apply is idempotent per document and safe to resume after a failure.
 */
const { createHash, randomUUID } = require('crypto');
const { Pool } = require('pg');

const apply = process.argv.includes('--apply');
const dim = Number(process.env.OAA_EMBED_DIM || 1536);
const required = ['LEGACY_PG_URL', 'OAA_TARGET_PG_URL', 'OAA_EMBED_BASE_URL', 'OAA_EMBED_API_KEY', 'OAA_EMBED_MODEL'];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required`);
if (!Number.isInteger(dim) || dim < 16 || dim > 4096) throw new Error('OAA_EMBED_DIM must be 16..4096');

const legacy = new Pool({ connectionString: process.env.LEGACY_PG_URL, options: '-c search_path=oaa,public' });
const target = new Pool({ connectionString: process.env.OAA_TARGET_PG_URL, options: '-c search_path=oaa,extensions,public' });
const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
const vec = (values) => `[${values.join(',')}]`;

async function embed(text) {
  const response = await fetch(`${process.env.OAA_EMBED_BASE_URL.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OAA_EMBED_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.OAA_EMBED_MODEL, input: text, dimensions: dim }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => ({}));
  const values = body?.data?.[0]?.embedding;
  if (!response.ok || !Array.isArray(values) || values.length !== dim || !values.every(Number.isFinite)) {
    throw new Error(`embedding failed for target chunk: ${body?.error?.message || response.status}`);
  }
  return values;
}

async function migrateDocuments() {
  const docs = await legacy.query(`
    SELECT id, namespace, source_type, source_id, title, version, metadata, content_hash, created_at, updated_at
    FROM oaa_knowledge_documents ORDER BY source_type, source_id
  `);
  let chunks = 0;
  for (const doc of docs.rows) {
    const sourceChunks = await legacy.query(`
      SELECT chunk_index, content, metadata FROM oaa_knowledge_chunks WHERE document_id = $1 ORDER BY chunk_index
    `, [doc.id]);
    if (!apply) {
      chunks += sourceChunks.rows.length;
      continue;
    }
    const enriched = [];
    for (const chunk of sourceChunks.rows) {
      const embedding = await embed(`${doc.title}\n${chunk.content}`);
      enriched.push({ ...chunk, embedding });
    }
    const client = await target.connect();
    try {
      await client.query('BEGIN');
      const metadata = doc.metadata || {};
      const acl = metadata.acl && typeof metadata.acl === 'object' ? metadata.acl : { visibility: 'authenticated' };
      const authorityTier = Number.isInteger(Number(metadata.authorityTier)) ? Number(metadata.authorityTier) : 3;
      await client.query(`
        INSERT INTO oaa_knowledge_documents
          (id, namespace, source_type, source_id, title, version, metadata, content_hash, status, authority_tier, acl, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'active',$9,$10::jsonb,$11,$12)
        ON CONFLICT (namespace, source_type, source_id) DO UPDATE SET
          title=EXCLUDED.title, version=EXCLUDED.version, metadata=EXCLUDED.metadata, content_hash=EXCLUDED.content_hash,
          status='active', authority_tier=EXCLUDED.authority_tier, acl=EXCLUDED.acl, updated_at=EXCLUDED.updated_at
        RETURNING id
      `, [doc.id, doc.namespace, doc.source_type, doc.source_id, doc.title, doc.version, JSON.stringify(metadata), doc.content_hash, authorityTier, JSON.stringify(acl), doc.created_at, doc.updated_at]);
      await client.query('DELETE FROM oaa_knowledge_chunks WHERE document_id = $1', [doc.id]);
      for (const chunk of enriched) {
        const metadata = { ...(chunk.metadata || {}), embedding: { mode: 'provider', provider: 'migration', model: process.env.OAA_EMBED_MODEL } };
        await client.query(`
          INSERT INTO oaa_knowledge_chunks (id, document_id, chunk_index, content, embedding, metadata)
          VALUES ($1,$2,$3,$4,$5::vector,$6::jsonb)
        `, [randomUUID(), doc.id, chunk.chunk_index, chunk.content, vec(chunk.embedding), JSON.stringify(metadata)]);
      }
      await client.query('COMMIT');
      chunks += enriched.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => null);
      throw new Error(`${doc.source_type}/${doc.source_id}: ${error.message}`);
    } finally { client.release(); }
  }
  return { documents: docs.rows.length, chunks };
}

async function copyTable(table, columns, conflict) {
  const rows = await legacy.query(`SELECT ${columns.join(', ')} FROM ${table}`);
  if (!apply || !rows.rows.length) return rows.rows.length;
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT ${conflict}`;
  for (const row of rows.rows) await target.query(sql, columns.map((column) => row[column]));
  return rows.rows.length;
}

(async () => {
  try {
    const documents = await migrateDocuments();
    const concepts = await copyTable('oaa_manual_concepts', ['id','namespace','type','name','aliases','summary','definition','authority_tier','status','source_ids','section_ids','tags','metadata','created_at','updated_at'], '(id) DO UPDATE SET name=EXCLUDED.name, summary=EXCLUDED.summary, definition=EXCLUDED.definition, metadata=EXCLUDED.metadata, updated_at=EXCLUDED.updated_at');
    const relations = await copyTable('oaa_manual_relations', ['id','namespace','from_id','to_id','relation','confidence','authority_tier','source_id','section_id','metadata','created_at','updated_at'], '(id) DO UPDATE SET metadata=EXCLUDED.metadata, updated_at=EXCLUDED.updated_at');
    const tools = await copyTable('oaa_tool_capabilities', ['id','name','version','channel','read_only','spec','created_at','updated_at'], '(id) DO UPDATE SET name=EXCLUDED.name, version=EXCLUDED.version, channel=EXCLUDED.channel, read_only=EXCLUDED.read_only, spec=EXCLUDED.spec, updated_at=EXCLUDED.updated_at');
    const bindings = await copyTable('oaa_manual_action_bindings', ['id','source_id','section_id','tool_id','intent','risk_level','confirmation','spec','created_at','updated_at'], '(id) DO UPDATE SET source_id=EXCLUDED.source_id, section_id=EXCLUDED.section_id, tool_id=EXCLUDED.tool_id, intent=EXCLUDED.intent, risk_level=EXCLUDED.risk_level, confirmation=EXCLUDED.confirmation, spec=EXCLUDED.spec, updated_at=EXCLUDED.updated_at');
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', ...documents, concepts, relations, tools, bindings, embeddingModel: process.env.OAA_EMBED_MODEL, hashVectorsCopied: false }, null, 2));
  } finally {
    await legacy.end();
    await target.end();
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
