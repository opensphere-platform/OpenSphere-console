-- CON-FR-007/018 · C_API · CON-RT-08/13: recover an accepted request
-- after transport/Gateway failure, without resubmitting an installation.
CREATE OR REPLACE FUNCTION console_operation.get_operation_by_request(
  p_session_id uuid, p_actor_ref uuid, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_operation
AS $$
DECLARE
  v_operation_id uuid;
BEGIN
  IF length(COALESCE(p_idempotency_key, '')) NOT BETWEEN 8 AND 256 THEN
    RAISE EXCEPTION 'invalid operation request key' USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  -- The existing unique (actor_ref,idempotency_key) index defines the request.
  SELECT operation_id INTO v_operation_id
    FROM console_operation.operation
    WHERE actor_ref = p_actor_ref AND idempotency_key = p_idempotency_key
      AND action_id = 'console.extension.install';
  -- Even a miss must pass current session/revocation checks. A nil UUID has no
  -- matching operation and get_operation returns null only after authorization.
  RETURN console_operation.get_operation(p_session_id, p_actor_ref,
    COALESCE(v_operation_id, '00000000-0000-0000-0000-000000000000'::uuid));
END;
$$;
REVOKE ALL ON FUNCTION console_operation.get_operation_by_request(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_operation.get_operation_by_request(uuid, uuid, text) TO console_api;
