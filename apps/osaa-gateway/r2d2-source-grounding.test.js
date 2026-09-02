'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groundCanonicalSourceAnswer } = require('./r2d2-source-grounding');

const revision = '4722bf8cf81fabe6fc0e78159573c023d5b7d4ad';
const values = [
  {
    tool: 'get_opensphere_source_catalog', arguments: {}, result: {
      authority: 'GitHub opensphere-platform', inventory: 'OpenSphere-Platform-V2/repository-inventory.json', coverage: 'partial',
      repositories: [{ id: 'platform-v2', accessible: false, blocker: 'github_source_credential_unavailable' }],
    },
  },
  {
    tool: 'read_opensphere_source', arguments: {}, result: {
      repositoryId: 'console', revision, path: 'apps/console-api/runtime/r2d2-engineering-remediation.js',
      digest: 'sha256:abc', startLine: 1, endLine: 8,
      text: "'use strict';\n\nconst { createHash } = require('crypto');\nconst path = require('path');\nconst { engineeringRepositoryPolicy } = require('./osaa-source-authority');\n\nconst REPOSITORIES = engineeringRepositoryPolicy();\nconst TEST_COMMANDS = new Set();",
    },
  },
  {
    tool: 'search_opensphere_source', arguments: {}, result: {
      repositoryId: 'console', revision, query: 'engineeringRepositoryPolicy', complete: true,
      items: [{ path: 'apps/console-api/runtime/r2d2-engineering-remediation.js', line: 7, excerpt: 'const REPOSITORIES = engineeringRepositoryPolicy();' }],
    },
  },
];

test('rejects the observed fabricated line 320 object definition and emits exact evidence', () => {
  const output = groundCanonicalSourceAnswer([
    'line 320에서 GitHub 정본을 확인했습니다.',
    '```javascript',
    "const REPOSITORIES = { console: { canonicalUrl: 'https://github.com/opensphere-platform/OpenSphere-console' } };",
    '```',
  ].join('\n'), values);
  assert.equal(output.state, 'model-draft-rejected');
  assert.equal(output.violations.length, 2);
  assert.doesNotMatch(output.content, /const REPOSITORIES = \{ console/);
  assert.match(output.content, /7 \| const REPOSITORIES = engineeringRepositoryPolicy\(\);/);
  assert.match(output.content, /#L1-L8/);
});

test('keeps grounded interpretation and appends server-generated citations', () => {
  const output = groundCanonicalSourceAnswer('line 7에서 위임된 repository policy를 사용합니다.', values);
  assert.equal(output.state, 'verified-with-coverage-gaps');
  assert.equal(output.violations.length, 0);
  assert.match(output.content, /line 7에서/);
  assert.match(output.content, /OSCE가 고정한 정본 소스 근거/);
  assert.ok(output.citations.includes(`console@${revision}/apps/console-api/runtime/r2d2-engineering-remediation.js#L1-L8`));
});

test('does not alter answers when canonical source tools were not used', () => {
  const output = groundCanonicalSourceAnswer('일반 답변', [{ tool: 'get_environment_snapshot', result: {} }]);
  assert.deepEqual(output, { content: '일반 답변', applied: false, state: 'not-applicable', violations: [], citations: [] });
});

test('fails closed when a source request produced no source tool evidence', () => {
  const output = groundCanonicalSourceAnswer('line 320의 객체입니다.', [], { required: true });
  assert.equal(output.state, 'source-evidence-missing');
  assert.doesNotMatch(output.content, /line 320의 객체/);
  assert.match(output.content, /도구가 실제 호출되지 않았습니다/);
});

test('catalog-only evidence cannot authorize a source-code answer', () => {
  const output = groundCanonicalSourceAnswer('코드가 존재합니다.', values.slice(0, 1), { required: true });
  assert.equal(output.state, 'source-file-evidence-missing');
  assert.doesNotMatch(output.content, /코드가 존재합니다/);
});
