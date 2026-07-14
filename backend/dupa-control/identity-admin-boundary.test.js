const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

// AG-1: opensphere-console-backend의 group 매핑 경로는 '콘솔 역할 그룹' allowlist로만 멤버 변경을 허용해야 한다.
// (allowlist가 없으면 콘솔 admin이 Kanidm 시스템 그룹 idm_admins 등에 escalation 가능)
test('AG-1: opensphere-console-backend group mapping is allowlisted to console role groups', () => {
  const s = read('backend', 'opensphere-console-backend', 'server.js');
  assert.match(s, /const CONSOLE_ROLE_GROUPS = new Set\(/);
  assert.match(s, /opensphere-console-admins,opensphere-console-operators,opensphere-console-viewers/);
  // group 쓰기 전에 allowlist 검사 → 미허용 그룹은 403.
  assert.match(s, /if \(!CONSOLE_ROLE_GROUPS\.has\(gname\)\)/);
  assert.match(s, /콘솔 역할 그룹만 매핑할 수 있습니다/);
});

// AG-2: admin 그룹은 본인이 본인에게 직접 부여/회수할 수 없다(자가 상승·자가 잠금 차단) — 두 경로 모두.
test('AG-2: self admin-group change is blocked on both the BFF and opensphere-console-backend paths', () => {
  const bff = read('backend', 'identity', 'opensphere-console-auth', 'server.mjs');
  assert.match(bff, /const ADMIN_ROLE_GROUP = 'opensphere-console-admins'/);
  assert.match(bff, /form\.role === ADMIN_ROLE_GROUP && user === actor/);
  assert.match(bff, /self_admin_change_forbidden/);

  const be = read('backend', 'opensphere-console-backend', 'server.js');
  assert.match(be, /gname === KANIDM_ADMIN_GROUP && uname === actor\.username/);
  assert.match(be, /self admin change blocked \(AG-2\)/);
});

// AG-6(회귀): 계정 생성은 입력 검증 + 중복 거부.
test('AG-6: user creation validates input and rejects duplicates', () => {
  const s = read('backend', 'opensphere-console-backend', 'server.js');
  assert.match(s, /p === '\/api\/identity\/users' && req\.method === 'POST'/);
  assert.match(s, /\^\[a-z\]\[a-z0-9\._-\]\{1,62\}\$/); // username 형식 검증
  assert.match(s, /이미 존재하는 사용자명입니다/); // 중복 409
});

test('IGA writes require an audit-quality reason across every identity mutation path', () => {
  const s = read('backend', 'opensphere-console-backend', 'server.js');
  assert.match(s, /function managementReason\(value\)/);
  assert.match(s, /return reason\.length >= 8 \? reason : null/);
  assert.match(s, /minimumLength: 8/);
  assert.equal((s.match(/managementReason\(body\.reason\)/g) || []).length, 4);
});

// AG-1(회귀): 생성 시 역할 부여도 콘솔 역할 그룹 allowlist로만 허용하고, admin은 강조 감사.
test('AG-1: create-time role assignment is allowlisted and admin is elevated-audited', () => {
  const s = read('backend', 'opensphere-console-backend', 'server.js');
  // roles 배열은 CONSOLE_ROLE_GROUPS로 검증(미허용 그룹 400).
  assert.match(s, /if \(!CONSOLE_ROLE_GROUPS\.has\(g\)\) return json\(res, 400/);
  // 검증된 역할만 group member로 부여, admin은 ok-admin-change로 강조 감사.
  assert.match(s, /kreq\('POST', `\/v1\/group\/\$\{g\}\/_attr\/member`, \[username\]\)/);
  assert.match(s, /g === KANIDM_ADMIN_GROUP \? 'ok-admin-change' : 'ok'/);
});

// B(회귀): group 매핑이 역할 '이름'(body.group)도 수용하되, AG-1 allowlist는 그대로 강제해야 한다.
test('B: group endpoint accepts a role name yet still enforces the console-role allowlist', () => {
  const s = read('backend', 'opensphere-console-backend', 'server.js');
  assert.match(s, /body\.group \? String\(body\.group\)\.trim\(\) : await groupNameByUuid/);
  assert.match(s, /if \(!CONSOLE_ROLE_GROUPS\.has\(gname\)\)/); // 이름 수용 후에도 allowlist 유지
});

// 속성 편집(IGA): displayname은 비울 수 없고, email은 비우면 제거. admin 게이트 + reason + 감사.
test('attrs: user attribute update validates and edits displayname/mail via Kanidm', () => {
  const s = read('backend', 'opensphere-console-backend', 'server.js');
  assert.match(s, /const mAttrs = p\.match/); // /api/identity/users/<uuid>/attrs 라우트
  assert.match(s, /'iga-update-attrs'/); // IGA attempt 감사
  assert.match(s, /displayName은 비울 수 없습니다/);
  assert.match(s, /_attr\/displayname`, \[displayName\]/);
  assert.match(s, /_attr\/mail`, \[email\]/); // email 설정
  assert.match(s, /kreq\('DELETE', `\/v1\/person\/\$\{uname\}\/_attr\/mail`\)/); // 비우면 제거
});

// 디자인 가이드(§4.1): 생성 폼은 자작 input이 아니라 Clarity form을 쓴다.
test('DESIGN: console-admins create form uses Clarity form (no raw os-in inputs)', () => {
  const page = read('src', 'app', 'pages', 'console-admins.ts');
  assert.match(page, /clr-input-container/);
  assert.match(page, /clrInput/);
  assert.match(page, /clrCheckbox/);
  assert.doesNotMatch(page, /class="os-in"/); // 자작 input 잔존 없음
});
