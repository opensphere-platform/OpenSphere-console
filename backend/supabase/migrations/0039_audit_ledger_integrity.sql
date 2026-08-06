-- 0039 — 원장 무결성: TRUNCATE 차단과 해시 사슬 실체화
--
-- arch-002 레드팀 감사 L2-7 시정.
--
-- 결함 1. append-only 트리거가 `BEFORE UPDATE OR DELETE ... FOR EACH ROW` 뿐이었다.
--   PostgreSQL 에서 TRUNCATE 는 **statement-level** 트리거로만 잡힌다. 따라서 UPDATE/DELETE 는
--   막히지만 `TRUNCATE audit.event` 한 줄로 원장 전체를 비울 수 있었고 트리거는 발동조차 하지 않았다.
--   이 저장소에 이미 올바른 패턴이 하나 있다(0024 `model_registry_approval_audit_no_truncate`).
--   나머지 10개 append-only 테이블에 같은 보호를 붙인다.
--
-- 결함 2. `audit.event.prev_hash` 컬럼이 선언만 되고 채우는 writer 가 없었다.
--   해시 사슬이 장식이었고, 행이 지워지거나 순서가 바뀌어도 탐지할 근거가 없었다.
--   서버가 삽입 시점에 직접 채운다 — 클라이언트가 보낸 값은 신뢰하지 않고 덮어쓴다.
--
-- ⚠ `event_hash` 는 건드리지 않는다. 기존 writer 들이 `ON CONFLICT (request_id, phase, event_hash)`
--   로 멱등성을 얻고 있어(0003·0007·0009·0010), 서버가 다시 계산하면 재시도가 중복 삽입이 된다.
--   `event_hash` = 내용 요약(멱등 키), `prev_hash` = 사슬 링크. 역할을 분리해 둔다.

BEGIN;

-- Released migration 0032 already established the stronger server-computed
-- chain_sequence/ledger_hash contract. Do not replace it with a second,
-- incompatible event_hash-linked chain. This migration only completes the
-- missing TRUNCATE protection for the other append-only ledgers.
DO $$
BEGIN
  IF to_regprocedure('audit.verify_event_ledger_chain()') IS NULL THEN
    RAISE EXCEPTION 'released audit ledger contract 0032 is missing';
  END IF;
END;
$$;

-- ── 4. TRUNCATE 차단 — append-only 테이블 전수 ────────────────────────────────
-- 각 테이블은 이미 자기 거부 함수를 갖고 있다. statement-level 트리거만 없었다.
DROP TRIGGER IF EXISTS image_revocation_no_truncate ON console.image_revocation;
CREATE TRIGGER image_revocation_no_truncate
  BEFORE TRUNCATE ON console.image_revocation
  FOR EACH STATEMENT EXECUTE FUNCTION console.reject_image_revocation_mutation();
ALTER TABLE console.image_revocation ENABLE ALWAYS TRIGGER image_revocation_no_truncate;

DROP TRIGGER IF EXISTS schema_migration_no_truncate ON console.schema_migration;
CREATE TRIGGER schema_migration_no_truncate
  BEFORE TRUNCATE ON console.schema_migration
  FOR EACH STATEMENT EXECUTE FUNCTION console.reject_schema_migration_mutation();
ALTER TABLE console.schema_migration ENABLE ALWAYS TRIGGER schema_migration_no_truncate;

DROP TRIGGER IF EXISTS llm_usage_event_no_truncate ON oaa.llm_usage_event;
CREATE TRIGGER llm_usage_event_no_truncate
  BEFORE TRUNCATE ON oaa.llm_usage_event
  FOR EACH STATEMENT EXECUTE FUNCTION oaa.reject_llm_usage_mutation();
ALTER TABLE oaa.llm_usage_event ENABLE ALWAYS TRIGGER llm_usage_event_no_truncate;

DROP TRIGGER IF EXISTS retrieval_trace_no_truncate ON oaa.retrieval_trace;
CREATE TRIGGER retrieval_trace_no_truncate
  BEFORE TRUNCATE ON oaa.retrieval_trace
  FOR EACH STATEMENT EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.retrieval_trace ENABLE ALWAYS TRIGGER retrieval_trace_no_truncate;

DROP TRIGGER IF EXISTS tool_run_no_truncate ON oaa.tool_run;
CREATE TRIGGER tool_run_no_truncate
  BEFORE TRUNCATE ON oaa.tool_run
  FOR EACH STATEMENT EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.tool_run ENABLE ALWAYS TRIGGER tool_run_no_truncate;

DROP TRIGGER IF EXISTS agent_step_no_truncate ON oaa.agent_step;
CREATE TRIGGER agent_step_no_truncate
  BEFORE TRUNCATE ON oaa.agent_step
  FOR EACH STATEMENT EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.agent_step ENABLE ALWAYS TRIGGER agent_step_no_truncate;

DROP TRIGGER IF EXISTS runtime_event_no_truncate ON oaa.runtime_event;
CREATE TRIGGER runtime_event_no_truncate
  BEFORE TRUNCATE ON oaa.runtime_event
  FOR EACH STATEMENT EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.runtime_event ENABLE ALWAYS TRIGGER runtime_event_no_truncate;

DROP TRIGGER IF EXISTS evidence_policy_event_no_truncate ON oaa.evidence_policy_event;
CREATE TRIGGER evidence_policy_event_no_truncate
  BEFORE TRUNCATE ON oaa.evidence_policy_event
  FOR EACH STATEMENT EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.evidence_policy_event ENABLE ALWAYS TRIGGER evidence_policy_event_no_truncate;

DROP TRIGGER IF EXISTS evidence_export_receipt_no_truncate ON oaa.evidence_export_receipt;
CREATE TRIGGER evidence_export_receipt_no_truncate
  BEFORE TRUNCATE ON oaa.evidence_export_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION oaa.reject_evidence_mutation();
ALTER TABLE oaa.evidence_export_receipt ENABLE ALWAYS TRIGGER evidence_export_receipt_no_truncate;

-- ── 5. 권한에서도 TRUNCATE 를 뺀다 ────────────────────────────────────────────
-- 트리거는 최후 방어선이다. 권한 자체를 주지 않는 것이 먼저다.
REVOKE TRUNCATE ON audit.event, console.image_revocation, console.schema_migration
  FROM anon, authenticated, service_role;
REVOKE TRUNCATE ON oaa.llm_usage_event, oaa.retrieval_trace, oaa.tool_run,
  oaa.agent_step, oaa.runtime_event, oaa.evidence_policy_event, oaa.evidence_export_receipt
  FROM anon, authenticated, service_role;

COMMIT;
