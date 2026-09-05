import test from 'node:test';
import assert from 'node:assert/strict';
import {validHostCompatibility, hostCompatibilitySatisfied as matches} from './host-compatibility.mjs';
test('real published host range is accepted by the shared provider/consumer contract', () => {
  assert.equal(validHostCompatibility('^1.0.0'), true);
  assert.equal(matches('1.0.0', '^1.0.0'), true);
  assert.equal(matches('1.9.2', '^1.0.0'), true);
  assert.equal(matches('2.0.0', '^1.0.0'), false);
  assert.equal(matches('0.9.9', '^1.0.0'), false);
});
test('zero-major caret, tilde, intersections and alternatives preserve boundaries', () => {
  for (const [v,r,expected] of [['0.2.9','^0.2.3',true],['0.3.0','^0.2.3',false],['0.0.4','^0.0.3',false],['1.3.0','~1.2.3',false],['1.2.9','~1.2.3',true],['1.8.0','>=1.0.0 <2.0.0',true],['3.0.0','^1.0.0 || =3.0.0',true]]) assert.equal(matches(v,r), expected, `${v} ${r}`);
});
test('invalid or unsupported compatibility syntax never authorizes a host', () => {
  for (const r of ['', '*', '^', '1', '^01.0.0', '1.0.0 ||', '>=1.0.0 surprise', '1.0.0-beta', '1.0.0\n', '1.0.0'.repeat(40)]) {
    assert.equal(validHostCompatibility(r), false, r); assert.equal(matches('1.0.0',r), false,r);
  }
});
