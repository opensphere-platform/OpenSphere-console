-- Keep the database-side audit guard aligned with the exact local edge
-- development MFA exception enforced by the OSAA Gateway. The boolean is not
-- accepted from a browser request: it is derived once from immutable runtime
-- deployment coordinates and this RPC remains executable only by the dedicated
-- opensphere_osaa_gateway database role. The original ten-argument overload
-- remains as the strict-AAL2 compatibility path during rolling upgrades.

CREATE FUNCTION osaa.c_ai_append_audit_event(
  p_request uuid,
  p_actor uuid,
  p_session uuid,
  p_action text,
  p_target_type text,
  p_target text,
  p_reason text,
  p_phase text,
  p_result text,
  p_digest text,
  p_allow_development_user_aal1 boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,osaa,console_audit
AS $$
DECLARE receipt console_audit.event;
BEGIN
  IF p_request IS NULL OR p_actor IS NULL OR p_session IS NULL
    OR p_action NOT IN (
      'osaa-llm-key-upsert',
      'osaa-llm-key-delete',
      'osaa-llm-key-validate',
      'osaa-dialogue-state-mode-change'
    )
    OR p_target_type NOT IN ('osaa-llm-credential','osaa-dialogue-state-policy')
    OR length(COALESCE(p_target,'')) NOT BETWEEN 1 AND 300 OR p_target ~ '[\r\n]'
    OR length(trim(COALESCE(p_reason,''))) NOT BETWEEN 8 AND 1000
    OR p_phase NOT IN ('intent','applied','failed')
    OR p_result !~ '^[a-z][a-z0-9-]{1,63}$'
    OR p_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_allow_development_user_aal1 IS NULL
  THEN
    RAISE EXCEPTION 'Invalid native C_AI audit binding' USING ERRCODE='22023';
  END IF;

  PERFORM osaa.assert_current_actor(
    p_actor,
    p_session,
    'osaa.knowledge.manage',
    NOT p_allow_development_user_aal1
  );

  receipt:=console_audit.append_event_internal(
    NULL,
    'osaa:'||p_request::text,
    p_actor::text,
    p_action,
    p_target_type||':'||p_target,
    CASE p_phase
      WHEN 'intent' THEN 'accepted'
      WHEN 'applied' THEN 'succeeded'
      ELSE 'failed'
    END,
    p_reason,
    jsonb_build_object(
      'requestId',p_request,
      'payloadDigest',p_digest,
      'phase',p_phase,
      'result',p_result,
      'developmentUserMfaDisabled',p_allow_development_user_aal1
    )
  );

  RETURN jsonb_build_object(
    'requestId',p_request,
    'eventId',receipt.event_id,
    'eventHash',receipt.event_hash
  );
END $$;

REVOKE ALL ON FUNCTION osaa.c_ai_append_audit_event(
  uuid,uuid,uuid,text,text,text,text,text,text,text,boolean
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION osaa.c_ai_append_audit_event(
  uuid,uuid,uuid,text,text,text,text,text,text,text,boolean
) TO opensphere_osaa_gateway;
