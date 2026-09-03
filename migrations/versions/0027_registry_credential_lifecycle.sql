-- CON-FR-007/017: narrow Registry credential broker. No credential bytes enter Postgres.
CREATE OR REPLACE FUNCTION console_extension.assert_registry_credential_authority(p_session_id uuid, p_actor_ref uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_extension
AS $$
DECLARE v_session console_identity.browser_session;
BEGIN
  PERFORM console_extension.get_registry_connection(p_session_id,p_actor_ref,'registry-credential-authority');
  SELECT * INTO STRICT v_session FROM console_identity.browser_session WHERE session_id=p_session_id;
  IF v_session.aal <> 'aal2' OR v_session.last_reauthenticated_at IS NULL
     OR v_session.last_reauthenticated_at < statement_timestamp()-interval '5 minutes'
     OR v_session.last_reauthenticated_at > statement_timestamp()+interval '30 seconds' THEN
    RAISE EXCEPTION 'recent aal2 is required' USING ERRCODE='42501', DETAIL='StepUpRequired';
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION console_extension.record_registry_credential_result(
  p_operation_id uuid, p_event_id uuid, p_outcome text, p_generation uuid, p_code text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, console_operation, console_audit
AS $$
DECLARE v_operation console_operation.operation; v_actor text; v_correlation text;
BEGIN
  IF p_outcome NOT IN ('accepted','succeeded','failed','unknown') OR p_code NOT IN (
    'RefreshStarted','PullSecretsVerified','PullSecretsCleared','AuthorizationStartFailed',
    'InterruptedCredentialOperation','PermissionDenied','RegistryPullDenied','ReadOnlyPackagesScopeRequired',
    'IdentityMismatch','ReauthorizationRequired','CredentialExpired','ProviderUnavailable',
    'RegistryImageUnavailable','RegistryDigestMismatch','CredentialPropagationPending',
    'RegistryPullSecretMissing','CredentialAuthorityUnavailable','CredentialOperationFailed'
  ) OR p_event_id IS NULL OR p_generation IS NULL THEN
    RAISE EXCEPTION 'invalid registry credential result' USING ERRCODE='22023', DETAIL='ValidationFailed';
  END IF;
  v_correlation := 'registry:'||p_event_id::text||':'||p_outcome;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_correlation,0));
  IF EXISTS(SELECT 1 FROM console_audit.event WHERE correlation_id=v_correlation
    AND action='console.registry.credential.lifecycle') THEN RETURN true; END IF;
  v_actor := 'system:registry-credential-broker';
  IF p_operation_id IS NOT NULL THEN
    SELECT * INTO v_operation FROM console_operation.operation WHERE operation_id=p_operation_id FOR UPDATE;
    IF NOT FOUND OR v_operation.owner_ref <> 'C_API.registry-credential-broker'
      OR v_operation.action_id NOT IN ('console.registry.connection.replace','console.registry.connection.remove')
      OR v_operation.target_ref <> 'registry-connection:opensphere-ghcr'
      OR v_operation.required_permission <> 'console.registry.manage' OR v_operation.risk <> 'R2'
      OR v_operation.approval_required OR v_operation.aal <> 'aal2' THEN
      RAISE EXCEPTION 'registry operation authority mismatch' USING ERRCODE='42501', DETAIL='PermissionDenied';
    END IF;
    v_actor := v_operation.actor_ref::text;
    IF v_operation.state IN ('Applied','Verified') THEN RETURN true; END IF;
    UPDATE console_operation.operation SET
      state=CASE p_outcome WHEN 'succeeded' THEN 'Applied' WHEN 'unknown' THEN 'Unknown' ELSE 'Reconciling' END,
      state_version=state_version+1,updated_at=statement_timestamp(),
      observed_postcondition=jsonb_build_object('authority','RegistryCredentialBroker','generation',p_generation,'code',p_code)
      WHERE operation_id=p_operation_id;
    IF p_outcome IN ('succeeded','unknown') THEN
      UPDATE console_operation.outbox SET delivered_at=statement_timestamp() WHERE operation_id=p_operation_id AND delivered_at IS NULL;
    END IF;
  END IF;
  PERFORM console_audit.append_event_internal(p_operation_id,v_correlation,v_actor,
    'console.registry.credential.lifecycle','registry-connection:opensphere-ghcr',p_outcome,
    'Registry credential lifecycle',jsonb_build_object('generation',p_generation,'code',p_code));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION console_extension.assert_registry_credential_authority(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_extension.record_registry_credential_result(uuid,uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_extension.assert_registry_credential_authority(uuid,uuid) TO console_api;
GRANT EXECUTE ON FUNCTION console_extension.record_registry_credential_result(uuid,uuid,text,uuid,text) TO console_api;