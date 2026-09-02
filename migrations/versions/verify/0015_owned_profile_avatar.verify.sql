\set ON_ERROR_STOP on

DO $$
DECLARE
  v_subject uuid := '11111111-1111-4111-8111-111111111111';
  v_session jsonb;
  v_read jsonb;
  v_select jsonb;
  v_before_events bigint;
  v_failed boolean := false;
BEGIN
  IF to_regprocedure('console_identity.prepare_owned_profile_avatar_access(bytea,bytea,text,text)') IS NULL THEN
    RAISE EXCEPTION 'owned profile avatar access function is missing';
  END IF;
  IF has_function_privilege('public', 'console_identity.prepare_owned_profile_avatar_access(bytea,bytea,text,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_identity.prepare_owned_profile_avatar_access(bytea,bytea,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'owned profile avatar access grants are not closed to console_api';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'console-uploads' AND name = 'console-uploads' AND public = false
      AND file_size_limit = 163840
      AND allowed_mime_types = ARRAY['image/webp', 'image/png', 'image/jpeg']::text[]
  ) THEN
    RAISE EXCEPTION 'owned profile avatar bucket is absent or overbroad';
  END IF;

  v_session := console_identity.issue_browser_session(
    v_subject,
    sha256(convert_to('profile-avatar-handle', 'UTF8')),
    sha256(convert_to('profile-avatar-csrf', 'UTF8')),
    'v1.UFJPRklMRUFWQVRBUkFDQ0VTUw.UFJPRklMRUFWQVRBUkFDQ0VTUw.UFJPRklMRUFWQVRBUkFDQ0VTUw',
    'v1.UFJPRklMRUFWQVRBUlJFRlJFU0g.UFJPRklMRUFWQVRBUlJFRlJFU0g.UFJPRklMRUFWQVRBUlJFRlJFU0g',
    'auth-profile-avatar', 'aal2', statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '24 hours', '24h', false,
    'profile-avatar-issue-0001'
  );

  SELECT count(*) INTO v_before_events FROM console_audit.event;
  v_read := console_identity.prepare_owned_profile_avatar_access(
    sha256(convert_to('profile-avatar-handle', 'UTF8')),
    NULL, 'read', 'profile-avatar-read-0001'
  );
  IF (v_read->>'sessionId')::uuid <> (v_session->>'sessionId')::uuid
      OR (v_read->>'subjectId')::uuid <> v_subject
      OR v_read->>'accessTokenCiphertext' NOT LIKE 'v1.%'
      OR v_read ? 'auditEventId'
      OR (SELECT count(*) FROM console_audit.event) <> v_before_events THEN
    RAISE EXCEPTION 'owned profile avatar read context is invalid or appended audit';
  END IF;

  v_select := console_identity.prepare_owned_profile_avatar_access(
    sha256(convert_to('profile-avatar-handle', 'UTF8')),
    sha256(convert_to('profile-avatar-csrf', 'UTF8')),
    'select', 'profile-avatar-select-0001'
  );
  IF (v_select->>'subjectId')::uuid <> v_subject
      OR v_select->>'accessTokenCiphertext' NOT LIKE 'v1.%'
      OR (v_select->>'auditEventId') IS NULL
      OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'owned profile avatar mutation context or intent is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console_audit.event
    WHERE event_id = (v_select->>'auditEventId')::uuid
      AND actor_ref = v_subject::text
      AND action = 'console.identity.profile.avatar.select'
      AND target_ref = 'subject:' || v_subject::text || ':profile-avatar'
      AND outcome = 'accepted'
      AND reason = 'self-service-profile-avatar'
      AND evidence = jsonb_build_object(
        'sessionId', (v_session->>'sessionId')::uuid,
        'operation', 'select', 'permissionRevision', 7, 'revokeEpoch', 2
      )
  ) THEN
    RAISE EXCEPTION 'owned profile avatar intent evidence is incomplete or contains unexpected data';
  END IF;

  BEGIN
    PERFORM console_identity.prepare_owned_profile_avatar_access(
      sha256(convert_to('profile-avatar-handle', 'UTF8')),
      sha256(convert_to('wrong-profile-avatar-csrf', 'UTF8')),
      'upload', 'profile-avatar-upload-0001'
    );
  EXCEPTION WHEN invalid_authorization_specification THEN
    v_failed := true;
  END;
  IF NOT v_failed OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'invalid avatar CSRF proof appended an intent';
  END IF;

  v_failed := false;
  BEGIN
    PERFORM console_identity.prepare_owned_profile_avatar_access(
      sha256(convert_to('profile-avatar-handle', 'UTF8')),
      NULL, 'delete', 'profile-avatar-delete-0001'
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_failed := true;
  END;
  IF NOT v_failed OR (SELECT count(*) FROM console_audit.event) <> v_before_events + 1 THEN
    RAISE EXCEPTION 'unknown avatar operation was not rejected before audit';
  END IF;
END;
$$;
