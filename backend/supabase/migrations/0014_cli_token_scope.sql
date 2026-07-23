\set ON_ERROR_STOP on

-- PAT authority is persisted server-side so revocation and least-privilege
-- policy do not depend only on claims carried by the signed token.
ALTER TABLE console.api_token
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'console-admin';

ALTER TABLE console.api_token
  DROP CONSTRAINT IF EXISTS api_token_scope_check;

ALTER TABLE console.api_token
  ADD CONSTRAINT api_token_scope_check
  CHECK (scope IN ('console-read', 'console-change', 'console-admin'));

COMMENT ON COLUMN console.api_token.scope IS
  'console-read: safe reads; console-change: reads plus governed change submit/approve; console-admin: all Console admin APIs';

NOTIFY pgrst, 'reload schema';
