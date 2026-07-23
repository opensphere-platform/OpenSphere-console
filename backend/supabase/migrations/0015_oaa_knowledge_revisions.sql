\set ON_ERROR_STOP on

-- Keep retrieved knowledge immutable.  A retrieval trace must continue to
-- identify the exact chunk revision that was used even after a manual update.
ALTER TABLE oaa.oaa_knowledge_chunks
  ADD COLUMN IF NOT EXISTS document_revision text,
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

-- Existing serving rows become a legacy immutable revision.  The next
-- declarative seed writes the content-addressed revision and atomically makes
-- it active without deleting evidence-referenced rows.
UPDATE oaa.oaa_knowledge_chunks c
SET document_revision = md5('legacy:' || c.document_id::text) || md5(c.document_id::text || ':legacy')
WHERE document_revision IS NULL;

ALTER TABLE oaa.oaa_knowledge_chunks
  ALTER COLUMN document_revision SET NOT NULL;

ALTER TABLE oaa.oaa_knowledge_chunks
  DROP CONSTRAINT IF EXISTS oaa_knowledge_chunks_document_id_chunk_index_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'oaa.oaa_knowledge_chunks'::regclass
      AND conname = 'oaa_knowledge_chunks_revision_index_key'
  ) THEN
    ALTER TABLE oaa.oaa_knowledge_chunks
      ADD CONSTRAINT oaa_knowledge_chunks_revision_index_key
      UNIQUE (document_id, document_revision, chunk_index);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'oaa.oaa_knowledge_chunks'::regclass
      AND conname = 'oaa_knowledge_chunks_revision_digest_check'
  ) THEN
    ALTER TABLE oaa.oaa_knowledge_chunks
      ADD CONSTRAINT oaa_knowledge_chunks_revision_digest_check
      CHECK (document_revision ~ '^[0-9a-f]{64}$');
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS oaa_knowledge_chunks_active_idx
  ON oaa.oaa_knowledge_chunks (document_id, active, document_revision, chunk_index);

ALTER TABLE oaa.retrieval_trace
  ADD COLUMN IF NOT EXISTS document_revision text
    CHECK (document_revision IS NULL OR document_revision ~ '^[0-9a-f]{64}$');

-- SET NULL would mutate append-only evidence during knowledge retirement.
-- Retention is now explicit: referenced documents/chunks cannot be deleted.
ALTER TABLE oaa.retrieval_trace
  DROP CONSTRAINT IF EXISTS retrieval_trace_document_id_fkey,
  DROP CONSTRAINT IF EXISTS retrieval_trace_chunk_id_fkey;
ALTER TABLE oaa.retrieval_trace
  ADD CONSTRAINT retrieval_trace_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES oaa.oaa_knowledge_documents(id) ON DELETE RESTRICT,
  ADD CONSTRAINT retrieval_trace_chunk_id_fkey
    FOREIGN KEY (chunk_id) REFERENCES oaa.oaa_knowledge_chunks(id) ON DELETE RESTRICT;

COMMENT ON COLUMN oaa.oaa_knowledge_chunks.document_revision IS
  'SHA-256 content revision. Chunk content is immutable within this revision.';
COMMENT ON COLUMN oaa.oaa_knowledge_chunks.active IS
  'Serving selector for the current document revision; old revisions remain for evidence.';
COMMENT ON COLUMN oaa.retrieval_trace.document_revision IS
  'Content revision used for this retrieval. Historical rows before migration may be null.';
