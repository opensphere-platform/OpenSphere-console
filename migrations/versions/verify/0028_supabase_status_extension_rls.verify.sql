\set ON_ERROR_STOP on

-- Verification runs against the complete current migration set.
BEGIN;
DO $$
DECLARE
  v_status jsonb;
BEGIN
  v_status := console_identity.get_supabase_status(
    '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
    7, 2, 'verify-extension-rls-0028');
  IF v_status->'data'->'components'->5->>'state' <> 'Ready'
      OR v_status->'data'->'components'->5->>'protectedTables' <> '16' THEN
    RAISE EXCEPTION 'complete extension RLS inventory was not Ready';
  END IF;
  ALTER TABLE console_extension.presentation_preference NO FORCE ROW LEVEL SECURITY;
  v_status := console_identity.get_supabase_status(
    '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
    7, 2, 'verify-extension-rls-force-0028');
  IF v_status->'data'->'components'->5->>'state' <> 'Blocked'
      OR v_status->'data'->'components'->5->>'reasonCode' <> 'RlsCoverageIncomplete' THEN
    RAISE EXCEPTION 'missing FORCE RLS was not blocked';
  END IF;
  ALTER TABLE console_extension.presentation_preference FORCE ROW LEVEL SECURITY;
  ALTER TABLE console_extension.presentation_preference DISABLE ROW LEVEL SECURITY;
  v_status := console_identity.get_supabase_status(
    '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
    7, 2, 'verify-extension-rls-disabled-0028');
  IF v_status->'data'->'components'->5->>'state' <> 'Blocked' THEN
    RAISE EXCEPTION 'disabled RLS was not blocked';
  END IF;
END;
$$;
ROLLBACK;
