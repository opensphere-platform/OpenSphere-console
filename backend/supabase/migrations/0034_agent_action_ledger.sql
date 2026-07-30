-- 0034 — 에이전트 행위를 사람과 **같은 원장**에 결속
--
-- 결함: oaa.* 마이그레이션 중 audit.event 에 쓰는 것이 하나도 없었다.
--   에이전트 실행 증거(oaa.tool_run · oaa.agent_step · oaa.llm_usage_event)는 별도 스키마에
--   append-only 로 잘 쌓이지만, 콘솔 원장(audit.event)과 correlation 으로 이어지지 않았다.
--
--   그래서 "누가 무엇을 왜 했는가" 를 한 원장에서 재구성할 때 **에이전트가 한 일만 빠졌다.**
--   특히 oaa.tool_run.status 의 'blocked' — 즉 정책이 에이전트를 **막은 사실** — 이
--   원장에 남지 않았다. 제품 주장이 "에이전트가 판단 앞에서 멈춘다" 인데,
--   멈췄다는 증거가 감사 원장 밖에 있으면 그 주장은 사후에 확인할 수 없다.
--
-- 시정: 트리거로 결속한다. 함수로 만들면 미래의 writer 가 부르는 것을 잊을 수 있다.
--   현재 writer 는 oaa-gateway 한 곳(server.js `INSERT INTO tool_run`)뿐이고 단말 상태를
--   INSERT 시점에 확정하므로, AFTER INSERT 에서 단말 상태만 원장에 옮긴다.
--
-- 표현 규약:
--   actor_type = 'service'  — 실행 주체가 에이전트다. 사람 판단과 구분된다.
--   actor_id   = 위임한 운영자(oaa.tool_run.actor_id). 권한의 출처이자 책임 소재다.
--   phase      = applied | failed  ('blocked' 는 failed 로 접되 result 에 구분해 남긴다)
--   reason     = 실행 사유 + permission_code. 어느 권한으로 움직였는지가 사유의 일부다.
--
-- ⚠ 한계를 적어 둔다. audit.event 에는 위임자와 에이전트를 따로 담을 컬럼이 없다
--   (actor_type + actor_id 뿐). 지금은 책임 소재(위임 운영자)를 actor_id 에 두고
--   실행 주체가 에이전트라는 사실을 actor_type='service' 와 action 접두사로 표현한다.
--   에이전트 자신의 신원(subject)과 보증수준까지 원장에 남기려면 컬럼 추가가 필요하며
--   그건 이 마이그레이션의 범위가 아니다.

BEGIN;

CREATE OR REPLACE FUNCTION oaa.record_tool_run_to_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oaa, audit, console, extensions
AS $$
DECLARE
  event_digest text;
  outcome_phase text;
  outcome_result text;
BEGIN
  -- 중간 상태(intent/authorized)는 원장에 옮기지 않는다. 단말 사실만 남긴다.
  IF NEW.status NOT IN ('applied', 'failed', 'blocked') THEN
    RETURN NEW;
  END IF;

  outcome_phase := CASE WHEN NEW.status = 'applied' THEN 'applied' ELSE 'failed' END;
  outcome_result := CASE
    WHEN NEW.status = 'applied' THEN 'agent-tool-applied'
    WHEN NEW.status = 'blocked' THEN 'agent-tool-blocked'   -- 정책이 막았다는 사실
    ELSE 'agent-tool-failed'
  END;

  event_digest := encode(digest(concat_ws('|',
    NEW.request_id::text, NEW.actor_id::text, NEW.tool_id, NEW.target,
    NEW.permission_code, NEW.status, coalesce(NEW.result_digest, '')
  ), 'sha256'), 'hex');

  INSERT INTO audit.event (
    request_id, correlation_id, actor_type, actor_id, action, target_type, target_id,
    reason, phase, result, payload_digest, event_hash
  ) VALUES (
    NEW.request_id, NEW.request_id::text, 'service', NEW.actor_id,
    'agent.tool.' || NEW.tool_id, 'oaa-tool', NEW.target,
    coalesce(nullif(btrim(NEW.reason), ''), 'agent tool execution')
      || ' [permission:' || NEW.permission_code || ']',
    outcome_phase, outcome_result,
    NEW.input_digest, event_digest
  ) ON CONFLICT (request_id, phase, event_hash) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tool_run_to_ledger ON oaa.tool_run;
CREATE TRIGGER tool_run_to_ledger
  AFTER INSERT ON oaa.tool_run
  FOR EACH ROW EXECUTE FUNCTION oaa.record_tool_run_to_ledger();
ALTER TABLE oaa.tool_run ENABLE ALWAYS TRIGGER tool_run_to_ledger;

COMMIT;
