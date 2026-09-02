// 감사 원장 내구성 — **동작 시험**.
//
// arch-002 레드팀 감사에서 우리 쪽 결함으로 확인된 것을 잠근다:
//   L2-8  `logAudit` 의 기본 분기가 `persistAuditNow(e).catch(console.error)` fire-and-forget 이어서
//         Supabase insert 실패 이벤트가 소실됐다. 호출자는 K8s Warning 폴러 1곳.
//   같은 발견의 더 나쁜 절반 — 폴러가 `seenEvents.add(uid)` 를 지속 **전에** 실행해
//         실패한 이벤트가 "이미 봤다" 로 표시되고 재시도되지 않았다.
//
// 이 파일은 소스 문자열을 정규식으로 보지 않는다. 그건 집행되지 않는 코드의 존재만 확인하는
// 동어반복이고(감사 패턴 B), 회귀를 못 잡는다. 실제로 호출해서 확인한다.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// controller.js 는 로드 시점에 환경을 읽는다. require 전에 세워야 한다.
process.env.SUPABASE_REST_URL = 'https://supabase.test/rest/v1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
process.env.KUBERNETES_SERVICE_HOST = 'k8s.test';
process.env.KUBERNETES_SERVICE_PORT = '443';

// projected SA 토큰을 임시 디렉터리에 만든다 — 실제 /var/run 경로를 건드리지 않는다.
const saDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-audit-sa-'));
fs.writeFileSync(path.join(saDir, 'token'), 'test-sa-token');
process.env.SA_TOKEN_DIR = saDir;

const { logAudit, durableAudit, persistAuditNow, pollK8sEvents, auditCounters } = require('./controller');

/** fetch 스텁. supabase 호출과 k8s 호출을 URL 로 갈라 기록한다. */
function stubFetch({ supabaseOk = true, events = [] } = {}) {
  const calls = { supabase: 0, k8s: 0, supabaseBodies: [] };
  const original = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://supabase.test')) {
      calls.supabase += 1;
      if (init.body) calls.supabaseBodies.push(JSON.parse(init.body));
      if (!supabaseOk) return { ok: false, status: 503, text: async () => '', json: async () => ({}) };
      return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
    }
    calls.k8s += 1;
    const body = JSON.stringify({ items: events });
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const warning = (uid, name) => ({
  metadata: { uid, namespace: 'opensphere-console' },
  reason: 'BackOff', message: `pod ${name} restarting`,
  involvedObject: { kind: 'Pod', name },
});

test('logAudit 은 지속을 시도하지 않는다 — fire-and-forget 분기가 제거되었다', async () => {
  const { calls, restore } = stubFetch();
  try {
    const e = logAudit('tester', 'unit.probe', 'target/1', 'applied', 'behavioural check', 'op-1');
    assert.equal(e.action, 'unit.probe');
    assert.equal(e.opId, 'op-1');
    // 이벤트 객체는 만들어지지만 네트워크 호출은 0 이어야 한다.
    // 여기서 1 이 나오면 누군가 fire-and-forget 지속을 되살린 것이다.
    assert.equal(calls.supabase, 0, 'logAudit 이 스스로 지속을 시도했다 — fail-open 분기가 되살아났다');
  } finally { restore(); }
});

test('durableAudit 은 지속 성공 시 원장에 13필드 계약대로 넣는다', async () => {
  const { calls, restore } = stubFetch({ supabaseOk: true });
  try {
    await durableAudit({ subject: '380021cb-fa2a-4e96-9f8c-91577d2e3fb9', username: 'kim' },
      'plugin.enable', 'registration/developer', 'applied', '승인된 변경', 'op-2');
    assert.equal(calls.supabase, 1);
    const [row] = calls.supabaseBodies[0];
    assert.equal(row.action, 'plugin.enable');
    assert.equal(row.actor_type, 'human');
    assert.equal(row.actor_id, '380021cb-fa2a-4e96-9f8c-91577d2e3fb9');
    assert.equal(row.correlation_id, 'op-2');
    assert.equal(row.reason, '승인된 변경');
    assert.equal(row.phase, 'applied');
    assert.match(row.event_hash, /^sha256:[0-9a-f]{64}$/);
  } finally { restore(); }
});

test('durableAudit 은 지속 실패를 삼키지 않고 던진다 — 호출자가 mutation 을 닫을 수 있어야 한다', async () => {
  const { calls, restore } = stubFetch({ supabaseOk: false });
  const before = auditCounters().failures;
  try {
    await assert.rejects(
      () => durableAudit('tester', 'plugin.enable', 'registration/x', 'applied', 'r', 'op-3'),
      /Supabase audit HTTP 503/,
      'durableAudit 이 실패를 삼켰다 — 감사 없이 관리 변경이 성립한다',
    );
    assert.equal(calls.supabase, 1);
    assert.equal(auditCounters().failures, before + 1, '실패가 계수되지 않았다 — 조용한 소실이다');
    assert.match(auditCounters().lastFailure, /Supabase audit HTTP 503/);
  } finally { restore(); }
});

test('K8s 폴러는 원장에 넣기 전에 seen 표시하지 않는다 — 실패 이벤트는 재시도된다', async () => {
  const events = [warning('uid-fail-1', 'console-abc')];

  // 1) 원장이 죽은 상태에서 폴 → 지속 실패 → seen 표시 금지
  const down = stubFetch({ supabaseOk: false, events });
  try {
    await pollK8sEvents();
    assert.equal(down.calls.supabase, 1, '지속을 시도하지 않았다');
    assert.ok(auditCounters().pending >= 1, '미기록 이벤트가 pending 으로 드러나지 않았다');
  } finally { down.restore(); }

  // 2) 원장이 살아난 뒤 같은 이벤트를 다시 폴 → 이번엔 기록되어야 한다.
  //    예전 코드는 1)에서 이미 seen 처리했으므로 여기서 supabase 호출이 0 이 되고 이벤트는 영구 소실됐다.
  const up = stubFetch({ supabaseOk: true, events });
  try {
    await pollK8sEvents();
    assert.equal(up.calls.supabase, 1, '실패한 이벤트가 재시도되지 않았다 — 영구 소실이다');
    const [row] = up.calls.supabaseBodies[0];
    assert.equal(row.action, 'BackOff');
    assert.equal(row.target_id, 'Pod/console-abc');
    assert.equal(auditCounters().pending, 0, '기록 후에도 pending 이 남아 있다');
  } finally { up.restore(); }

  // 3) 이제는 seen 이므로 세 번째 폴에서 중복 기록하지 않는다.
  const again = stubFetch({ supabaseOk: true, events });
  try {
    await pollK8sEvents();
    assert.equal(again.calls.supabase, 0, '같은 이벤트를 중복 기록했다 — dedup 이 깨졌다');
  } finally { again.restore(); }
});
