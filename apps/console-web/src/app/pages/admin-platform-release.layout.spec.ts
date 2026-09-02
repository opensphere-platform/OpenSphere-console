import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./admin-platform-release.ts', import.meta.url), 'utf8');

test('Release Lock JSON 편집기는 검토 카드의 가용 폭 전체를 사용한다', () => {
  assert.match(source, /class="release-json-field"/);
  assert.match(source, /class="release-json-editor" rows="12"/);
  assert.doesNotMatch(source, /class="release-json-editor" clrTextarea/);
  assert.match(source, /\.release-json-field \.release-json-editor\{box-sizing:border-box;display:block;width:100%;max-width:none;min-height:18rem;padding:\.55rem/);
});

test('Release Lock 식별자는 버전이 아니라 digest와 source revision으로 표시한다', () => {
  assert.match(source, /<dt>Release digest<\/dt>/);
  assert.match(source, /<dt>Source revision<\/dt>/);
  assert.doesNotMatch(source, /<dt>Release<\/dt>/);
  assert.doesNotMatch(source, /<dt>Source<\/dt>/);
});

test('MFA 재확인 전에 기존 확인 모달을 닫아 중첩된 Clarity focus trap을 만들지 않는다', () => {
  assert.match(source, /async generateComponentTarget\(reason: string\)[\s\S]*?this\.pendingGenerate\.set\(false\);[\s\S]*?this\.generating\.set\(true\);/);
  assert.match(source, /async submit\(reason: string\)[\s\S]*?this\.pendingSubmit\.set\(false\);[\s\S]*?this\.submitting\.set\(true\);/);
});
