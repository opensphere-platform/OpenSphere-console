-- Deterministic OSAA verifiers are first-class agent steps.  Keep the
-- append-only evidence ledger strict while allowing the gateway to distinguish
-- model/tool execution from server-owned postcondition and grounding checks.

ALTER TABLE oaa.agent_step
  DROP CONSTRAINT IF EXISTS agent_step_step_kind_check;

ALTER TABLE oaa.agent_step
  ADD CONSTRAINT agent_step_step_kind_check
  CHECK (step_kind IN ('retrieval', 'llm', 'tool', 'verification'));

COMMENT ON COLUMN oaa.agent_step.step_kind IS
  'retrieval, llm, and tool record agent execution; verification records deterministic server-owned grounding or postcondition evidence.';
