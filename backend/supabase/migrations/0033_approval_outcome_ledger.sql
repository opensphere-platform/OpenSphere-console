-- 0033 — 결재 **결과**를 원장에 결속
--
-- 결함: `console.record_change_approval_result` 가 console.change_approval 만 갱신하고
--   audit.event 에는 아무것도 남기지 않았다. 그래서 원장에는 결재 **의도**만 있고
--   (0010 begin_change_approval → phase 'authorized') 그 결재가 실제로 적용됐는지 실패했는지가 없었다.
--
--   결과적으로 "누가 왜 승인했는지 3년 뒤에도 남는다" 는 절반만 참이었다.
--   누가 승인하려 했는지는 남지만, 그 승인이 효력을 발휘했는지는 원장 밖 테이블에만 있었다.
--   사고 조사에서 필요한 것은 후자다.
--
--   audit.event.phase 는 이미 'applied' | 'failed' 를 허용한다(0001). 스키마는 이 사실을
--   담을 준비가 되어 있었고 함수만 쓰지 않고 있었다.
--
-- 시정: 결과 기록 시 audit.event 에도 남긴다. 같은 correlation_id(request_id) 로 묶여
--   의도 → 결과가 한 사슬에 이어진다(0032 prev_hash 사슬이 순서를 보증한다).

BEGIN;

CREATE OR REPLACE FUNCTION console.record_change_approval_result(
  p_request_id uuid,
  p_approver_id uuid,
  p_succeeded boolean,
  p_gitea_review_id bigint DEFAULT NULL,
  p_error_code text DEFAULT NULL
) RETURNS console.change_approval
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console, audit, extensions
AS $$
DECLARE
  approval console.change_approval;
  change_row console.change_request;
  event_digest text;
  outcome_phase text;
  outcome_result text;
BEGIN
  UPDATE console.change_approval SET
    status = CASE WHEN p_succeeded THEN 'applied' ELSE 'failed' END,
    gitea_review_id = p_gitea_review_id,
    error_code = CASE WHEN p_succeeded THEN NULL ELSE nullif(btrim(p_error_code), '') END,
    completed_at = clock_timestamp()
  WHERE request_id = p_request_id AND approver_id = p_approver_id
  RETURNING * INTO approval;
  IF approval.id IS NULL THEN RAISE EXCEPTION 'approval intent is absent'; END IF;

  SELECT * INTO change_row FROM console.change_request WHERE request_id = p_request_id;

  outcome_phase := CASE WHEN p_succeeded THEN 'applied' ELSE 'failed' END;
  outcome_result := CASE
    WHEN p_succeeded THEN 'approval-applied'
    ELSE 'approval-failed:' || coalesce(nullif(btrim(p_error_code), ''), 'unspecified')
  END;

  -- 결재 사유는 승인 시점의 것을 그대로 옮긴다. 결과 기록이 사유를 새로 지어내지 않는다.
  -- gitea_review_id 는 사람 판단과 봇 리뷰를 구분하는 근거라 사유에 붙여 남긴다(0010 주석 참조).
  event_digest := encode(digest(concat_ws('|',
    p_request_id::text, p_approver_id::text, outcome_phase,
    coalesce(p_gitea_review_id::text, ''), coalesce(nullif(btrim(p_error_code), ''), '')
  ), 'sha256'), 'hex');

  INSERT INTO audit.event (
    request_id, correlation_id, actor_type, actor_id, action, target_type, target_id,
    reason, phase, result, event_hash
  ) VALUES (
    p_request_id, p_request_id::text, 'human', p_approver_id,
    'change-approval-result', 'declarative-change', coalesce(change_row.target, 'unknown'),
    approval.reason || CASE
      WHEN p_gitea_review_id IS NOT NULL THEN ' [gitea-review:' || p_gitea_review_id::text || ']'
      ELSE ''
    END,
    outcome_phase, outcome_result, event_digest
  ) ON CONFLICT (request_id, phase, event_hash) DO NOTHING;

  RETURN approval;
END;
$$;

REVOKE ALL ON FUNCTION console.record_change_approval_result(uuid, uuid, boolean, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION console.record_change_approval_result(uuid, uuid, boolean, bigint, text) TO opensphere_console_backend;

COMMIT;
