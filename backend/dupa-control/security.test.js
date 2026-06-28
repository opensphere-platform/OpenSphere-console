// 보안 회귀 테스트(감사 P2-4) — DUPA 컨트롤러의 순수 보안 검증 로직.
// 실행: node --test  (또는 npm test). require.main!==module 가드로 서버는 기동되지 않는다.
const test = require('node:test');
const assert = require('node:assert');
const { assertClaims, isAdminGroups, safeName } = require('./controller.js');

const ISS = 'https://localhost:8444/oauth2/openid/opensphere-console';
const AZP = 'opensphere-console';
const future = Math.floor(Date.now() / 1000) + 3600;
const goodHeader = { alg: 'ES256', kid: 'k1' };
const goodClaims = { iss: ISS, azp: AZP, exp: future, preferred_username: 'mars' };

// assertClaims는 Error가 아니라 {code,msg} 객체를 throw → msg를 검사하는 predicate로 단언.
const rejects = (fn, re) => assert.throws(fn, (e) => e && e.code === 401 && re.test(e.msg || ''));

test('assertClaims: 정상 토큰 통과', () => {
  assert.doesNotThrow(() => assertClaims(goodHeader, goodClaims));
});

test('assertClaims: alg!=ES256 거부 (alg-confusion/none 방어)', () => {
  rejects(() => assertClaims({ alg: 'none' }, goodClaims), /alg/);
  rejects(() => assertClaims({ alg: 'RS256' }, goodClaims), /alg/);
  rejects(() => assertClaims({ alg: 'HS256' }, goodClaims), /alg/);
});

test('assertClaims: 잘못된 iss 거부', () => {
  rejects(() => assertClaims(goodHeader, { ...goodClaims, iss: 'https://evil.example' }), /iss/);
});

test('assertClaims: azp/aud 불일치 거부', () => {
  rejects(() => assertClaims(goodHeader, { ...goodClaims, azp: 'other', aud: ['other'] }), /azp|aud/);
});

test('assertClaims: aud 배열에 azp 포함 시 통과', () => {
  assert.doesNotThrow(() => assertClaims(goodHeader, { iss: ISS, azp: 'x', aud: [AZP], exp: future }));
});

test('assertClaims: 만료 토큰 거부', () => {
  rejects(() => assertClaims(goodHeader, { ...goodClaims, exp: Math.floor(Date.now() / 1000) - 10 }), /expired/);
});

test('assertClaims: nbf 미래 토큰 거부', () => {
  rejects(() => assertClaims(goodHeader, { ...goodClaims, nbf: Math.floor(Date.now() / 1000) + 600 }), /not yet valid/);
});

test('isAdminGroups: admin 그룹만 true', () => {
  assert.equal(isAdminGroups(['opensphere-console-admins']), true);
  assert.equal(isAdminGroups(['viewers', 'opensphere-console-admins']), true);
  assert.equal(isAdminGroups(['viewers']), false);
  assert.equal(isAdminGroups([]), false);
  assert.equal(isAdminGroups(undefined), false);
});

test('safeName: RFC1123 라벨만 허용 (SSRF 가드)', () => {
  // 허용(정상 plugin/binding 서비스 id)
  for (const ok of ['cluster-manager', 'os-cli', 'ai', 'a', 'a1', 'shell-template']) {
    assert.equal(safeName(ok), true, `expected valid: ${ok}`);
  }
  // 거부(SSRF/인젝션 시도)
  for (const bad of ['UPPER', 'has_underscore', '-leadingdash', 'trailingdash-', 'has.dot', 'a/b', 'a b', '', '..', 'svc:8080', null, undefined, 123]) {
    assert.equal(safeName(bad), false, `expected invalid: ${bad}`);
  }
});
