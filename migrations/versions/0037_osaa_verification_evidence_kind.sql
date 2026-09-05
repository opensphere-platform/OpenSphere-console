-- C_AI emits deterministic verification evidence as a distinct execution step.
-- Extend the existing immutable ledger; do not rewrite 0031, rows, roles or RLS.
ALTER TABLE osaa.agent_step DROP CONSTRAINT agent_step_step_kind_check;
ALTER TABLE osaa.agent_step ADD CONSTRAINT agent_step_step_kind_check
  CHECK (step_kind IN ('retrieval', 'llm', 'tool', 'verification'));
