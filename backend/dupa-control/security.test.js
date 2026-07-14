// 보안 회귀 테스트(감사 P2-4) — DUPA 컨트롤러의 순수 보안 검증 로직.
// 실행: node --test  (또는 npm test). require.main!==module 가드로 서버는 기동되지 않는다.
const test = require('node:test');
const assert = require('node:assert');
const { assertClaims, assertManagedTokenActive, isAdminGroups, safeName, allowedCLIResourcePath } = require('./controller.js');

const ISS = 'https://localhost:8444/oauth2/openid/opensphere-console';
const AZP = 'opensphere-console';
const future = Math.floor(Date.now() / 1000) + 3600;
const nowS = Math.floor(Date.now() / 1000);
const goodHeader = { alg: 'ES256', kid: 'k1' };
const goodClaims = { iss: ISS, azp: AZP, exp: future, iat: nowS, sub: 'uuid-mars', preferred_username: 'mars' };

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
  assert.doesNotThrow(() => assertClaims(goodHeader, { iss: ISS, azp: 'x', aud: [AZP], exp: future, iat: nowS, sub: 'uuid' }));
});

test('assertClaims: 만료 토큰 거부', () => {
  rejects(() => assertClaims(goodHeader, { ...goodClaims, exp: Math.floor(Date.now() / 1000) - 10 }), /expired/);
});

test('assertClaims: nbf 미래 토큰 거부', () => {
  rejects(() => assertClaims(goodHeader, { ...goodClaims, nbf: Math.floor(Date.now() / 1000) + 600 }), /not yet valid/);
});

// 재감사 P2-2: 필수 claim 부재 거부
test('assertClaims: exp 부재 거부', () => {
  const c = { ...goodClaims }; delete c.exp;
  rejects(() => assertClaims(goodHeader, c), /missing exp/);
});

test('assertClaims: sub 부재 거부', () => {
  const c = { ...goodClaims }; delete c.sub;
  rejects(() => assertClaims(goodHeader, c), /missing sub/);
});

test('assertClaims: iat 부재 거부', () => {
  const c = { ...goodClaims }; delete c.iat;
  rejects(() => assertClaims(goodHeader, c), /missing iat/);
});

test('isAdminGroups: admin 그룹만 true', () => {
  assert.equal(isAdminGroups(['opensphere-console-admins']), true);
  assert.equal(isAdminGroups(['viewers', 'opensphere-console-admins']), true);
  assert.equal(isAdminGroups(['viewers']), false);
  assert.equal(isAdminGroups([]), false);
  assert.equal(isAdminGroups(undefined), false);
});

test('assertManagedTokenActive: 브라우저 OIDC 세션도 live identity 상태와 일치해야 한다', () => {
  const active = { active: true, type: 'browser_session', sub: goodClaims.sub, username: goodClaims.preferred_username, exp: goodClaims.exp };
  assert.doesNotThrow(() => assertManagedTokenActive(goodClaims, active));
  rejects(() => assertManagedTokenActive(goodClaims, null), /inactive|revoked/);
  rejects(() => assertManagedTokenActive(goodClaims, { ...active, type: 'pat' }), /browser session state mismatch/);
  rejects(() => assertManagedTokenActive(goodClaims, { ...active, sub: 'other-user' }), /state mismatch/);
});

test('assertManagedTokenActive: 활성 PAT의 서명 claim과 서버 상태가 모두 일치해야 한다', () => {
  const claims = { ...goodClaims, typ: 'pat', jti: 'pat-1' };
  const active = { active: true, jti: 'pat-1', sub: claims.sub, username: claims.preferred_username, exp: claims.exp };
  assert.doesNotThrow(() => assertManagedTokenActive(claims, active));
  rejects(() => assertManagedTokenActive(claims, { active: false }), /inactive|revoked/);
  rejects(() => assertManagedTokenActive(claims, { ...active, jti: 'other' }), /state mismatch/);
  rejects(() => assertManagedTokenActive(claims, { ...active, exp: claims.exp + 1 }), /state mismatch/);
});

test('assertManagedTokenActive: CLI 단기 세션은 등록 디바이스와 결속된다', () => {
  const claims = { ...goodClaims, typ: 'cli_session', jti: 'session-1', device_id: 'device-1' };
  const active = { active: true, jti: 'session-1', deviceId: 'device-1', sub: claims.sub, username: claims.preferred_username, exp: claims.exp };
  assert.doesNotThrow(() => assertManagedTokenActive(claims, active));
  rejects(() => assertManagedTokenActive(claims, { ...active, deviceId: 'device-2' }), /device state mismatch/);
});

test('assertManagedTokenActive: 알 수 없는 관리 토큰 형식은 fail-closed', () => {
  rejects(() => assertManagedTokenActive({ ...goodClaims, typ: 'unknown' }, { active: true }), /unsupported token type/);
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

test('allowedCLIResourcePath: Console 제품 CRD의 읽기 경로만 허용', () => {
  for (const ok of [
    '/apis/config.opensphere.io/v1alpha1/platformconfigs',
    '/apis/platform.opensphere.io/v1alpha1/platformversions/release-edge',
    '/apis/backbone.opensphere.io/v1alpha1/backboneclaims',
    '/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-console/uipluginpackages/cluster-manager',
    '/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-console/uipluginregistrations',
  ]) {
    assert.equal(allowedCLIResourcePath(ok), true, `expected allowlisted: ${ok}`);
  }

  for (const denied of [
    '/api/v1/secrets',
    '/apis/apps/v1/deployments',
    '/apis/plugins.opensphere.io/v1alpha1/namespaces/default/uipluginpackages',
    '/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-console/uipluginpackages/name/status',
    '/apis/backbone.opensphere.io/v1alpha1/backboneclaims/../../secrets',
    '/apis/backbone.opensphere.io/v1alpha1/backboneclaims/name%2Fstatus',
  ]) {
    assert.equal(allowedCLIResourcePath(denied), false, `expected denied: ${denied}`);
  }
});
