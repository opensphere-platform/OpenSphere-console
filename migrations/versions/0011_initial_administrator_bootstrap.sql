CREATE OR REPLACE FUNCTION console_identity.get_initial_administrator_bootstrap_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM console_identity.subject_authority) THEN
    RETURN jsonb_build_object('state', 'complete');
  END IF;
  RETURN jsonb_build_object('state', 'required');
END;
$$;

CREATE OR REPLACE FUNCTION console_identity.claim_initial_administrator(
  p_subject_id uuid,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_permissions constant text[] := ARRAY[
    'console.audit.read',
    'console.data_identity.read',
    'console.extension.install',
    'console.extension.remove',
    'console.extension.revoke',
    'console.operation.approve',
    'console.operation.verify',
    'console.registry.manage'
  ];
  v_event console_audit.event;
BEGIN
  IF p_subject_id IS NULL
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]' THEN
    RAISE EXCEPTION 'initial administrator bootstrap request is invalid'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  PERFORM pg_advisory_xact_lock(471920260902);
  IF EXISTS (SELECT 1 FROM console_identity.subject_authority) THEN
    RAISE EXCEPTION 'initial administrator already exists'
      USING ERRCODE = '23505', DETAIL = 'BootstrapComplete';
  END IF;

  INSERT INTO console_identity.subject_authority(
    subject_id, person_ref, permission_revision, revoke_epoch
  ) VALUES (p_subject_id, gen_random_uuid(), 1, 0);

  INSERT INTO console_identity.permission_grant(
    subject_id, permission, grant_revision, granted_by
  )
  SELECT p_subject_id, permission, 1, p_subject_id
    FROM unnest(v_permissions) AS permission;

  v_event := console_audit.append_event_internal(
    NULL,
    p_correlation_id,
    p_subject_id::text,
    'console.identity.bootstrap.initial_administrator',
    'subject:' || p_subject_id::text,
    'succeeded',
    'initial-administrator-bootstrap',
    jsonb_build_object(
      'permissionRevision', 1,
      'permissionCount', cardinality(v_permissions)
    )
  );

  RETURN jsonb_build_object(
    'state', 'complete',
    'subjectId', p_subject_id,
    'permissionRevision', 1,
    'permissionCount', cardinality(v_permissions),
    'auditEventId', v_event.event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION console_identity.get_initial_administrator_bootstrap_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION console_identity.claim_initial_administrator(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_identity.get_initial_administrator_bootstrap_status() TO console_api;
GRANT EXECUTE ON FUNCTION console_identity.claim_initial_administrator(uuid, text) TO console_api;

COMMENT ON FUNCTION console_identity.get_initial_administrator_bootstrap_status()
  IS 'Public-safe C_API projection of whether the first Console authority still needs to be claimed.';
COMMENT ON FUNCTION console_identity.claim_initial_administrator(uuid, text)
  IS 'C_API-only single-winner creation of the first Console authority and its closed administrator permission set.';
