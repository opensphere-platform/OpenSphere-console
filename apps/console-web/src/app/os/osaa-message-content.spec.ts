import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOsaaInline, parseOsaaMessage } from './osaa-message-parser.ts';

test('parses headings, lists, fenced code and tables as structured blocks', () => {
    const blocks = parseOsaaMessage([
      '## 실행 계획',
      '',
      '- 첫 단계',
      '- 두 번째 단계',
      '',
      '```sql',
      'select now();',
      '```',
      '',
      '| 항목 | 상태 |',
      '| --- | --- |',
      '| DB | Ready |',
    ].join('\n'));

  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'list', 'code', 'table']);
  assert.deepEqual(blocks[2], { type: 'code', language: 'sql', code: 'select now();' });
});

test('allows only HTTPS links and leaves unsafe markup as text', () => {
  const tokens = parseOsaaInline('[문서](https://docs.example.test/a) [위험](javascript:alert(1)) <img src=x onerror=alert(1)>');

  assert.equal(tokens.some((token) => token.type === 'link' && token.href === 'https://docs.example.test/a'), true);
  assert.equal(tokens.some((token) => token.type === 'link' && token.href.startsWith('javascript:')), false);
  assert.match(tokens.map((token) => token.text).join(''), /<img src=x onerror=alert\(1\)>/);
});

test('does not interpret raw HTML as executable content', () => {
  const blocks = parseOsaaMessage('<script>alert(1)</script>');
  assert.deepEqual(blocks, [{
    type: 'paragraph',
    content: [{ type: 'text', text: '<script>alert(1)</script>' }],
  }]);
});
