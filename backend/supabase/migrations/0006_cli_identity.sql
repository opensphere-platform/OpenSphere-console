\set ON_ERROR_STOP on

-- OS CLI is a Console-native client.  Its device and automation credentials
-- are owned by the Supabase Console boundary, never by a parallel IdP/BFF.
CREATE TABLE IF NOT EXISTS console.cli_device (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 128),
  public_jwk jsonb NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  revoke_reason text,
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS cli_device_owner_idx ON console.cli_device (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS console.cli_enrollment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 128),
  public_jwk jsonb NOT NULL,
  fingerprint text NOT NULL,
  user_code_hash text NOT NULL,
  poll_token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'expired')),
  expires_at timestamptz NOT NULL,
  owner_id uuid REFERENCES console.operator(user_id) ON DELETE CASCADE,
  device_id uuid REFERENCES console.cli_device(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cli_enrollment_pending_idx ON console.cli_enrollment (status, expires_at);

CREATE TABLE IF NOT EXISTS console.cli_challenge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES console.cli_device(id) ON DELETE CASCADE,
  nonce_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cli_challenge_device_idx ON console.cli_challenge (device_id, expires_at);

CREATE TABLE IF NOT EXISTS console.cli_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES console.cli_device(id) ON DELETE CASCADE,
  credential_revision bigint NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS cli_session_owner_idx ON console.cli_session (owner_id, status, expires_at);

CREATE TABLE IF NOT EXISTS console.api_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 128),
  token_hash text NOT NULL UNIQUE,
  credential_revision bigint NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  revoke_reason text
);
CREATE INDEX IF NOT EXISTS api_token_owner_idx ON console.api_token (owner_id, status, expires_at);

ALTER TABLE console.cli_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.cli_enrollment ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.cli_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.cli_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.api_token ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS console_backend_cli_device ON console.cli_device;
DROP POLICY IF EXISTS console_backend_cli_enrollment ON console.cli_enrollment;
DROP POLICY IF EXISTS console_backend_cli_challenge ON console.cli_challenge;
DROP POLICY IF EXISTS console_backend_cli_session ON console.cli_session;
DROP POLICY IF EXISTS console_backend_api_token ON console.api_token;
CREATE POLICY console_backend_cli_device ON console.cli_device FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
CREATE POLICY console_backend_cli_enrollment ON console.cli_enrollment FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
CREATE POLICY console_backend_cli_challenge ON console.cli_challenge FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
CREATE POLICY console_backend_cli_session ON console.cli_session FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
CREATE POLICY console_backend_api_token ON console.api_token FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON console.cli_device, console.cli_enrollment,
  console.cli_challenge, console.cli_session, console.api_token TO opensphere_console_backend;

-- One transaction claims the one-time approval code and creates the device;
-- a concurrent browser cannot approve the same enrollment twice.
CREATE OR REPLACE FUNCTION console.approve_cli_enrollment(
  p_enrollment_id uuid,
  p_actor_id uuid,
  p_user_code_hash text
) RETURNS TABLE (device_id uuid, label text, fingerprint text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console
AS $$
DECLARE
  enrollment console.cli_enrollment%ROWTYPE;
  created_device console.cli_device%ROWTYPE;
BEGIN
  SELECT * INTO enrollment FROM console.cli_enrollment
   WHERE id = p_enrollment_id AND status = 'pending' AND expires_at > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND OR enrollment.user_code_hash <> p_user_code_hash THEN
    RAISE EXCEPTION 'invalid or expired CLI enrollment' USING ERRCODE = '22023';
  END IF;
  INSERT INTO console.cli_device (owner_id, label, public_jwk, fingerprint)
    VALUES (p_actor_id, enrollment.label, enrollment.public_jwk, enrollment.fingerprint)
    RETURNING * INTO created_device;
  UPDATE console.cli_enrollment
    SET status = 'approved', owner_id = p_actor_id, device_id = created_device.id, approved_at = clock_timestamp()
    WHERE id = enrollment.id;
  RETURN QUERY SELECT created_device.id, created_device.label, created_device.fingerprint;
END;
$$;
GRANT EXECUTE ON FUNCTION console.approve_cli_enrollment(uuid, uuid, text) TO opensphere_console_backend;
