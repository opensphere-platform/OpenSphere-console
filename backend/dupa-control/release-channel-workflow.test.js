const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'publish-edge-images.yml'), 'utf8');
const angularConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'angular.json'), 'utf8'));

test('edge is advanced only after every immutable console component is verified', () => {
  const matrixMetadata = workflow.slice(workflow.indexOf('      - name: Image metadata'), workflow.indexOf('      - name: Build and push'));
  assert.match(matrixMetadata, /type=sha,prefix=sha-/);
  assert.doesNotMatch(matrixMetadata, /type=raw,value=edge/);
  assert.match(workflow, /publish-edge:\s*\n\s+needs: \[publish\]/);
  assert.match(workflow, /source_tag="sha-\$\{GITHUB_SHA:0:7\}"/);
  assert.match(workflow, /Do not move any channel tag until every immutable component was/);
  assert.match(workflow, /bom="\$RUNNER_TEMP\/opensphere-release-bom\.json"/);
  assert.match(workflow, /digest="\$\(jq -r --arg key "\$key" '\.components\[\$key\]\.image \| split\("@"\)\[1\]' "\$bom"\)"/);
  assert.match(workflow, /crane tag "\$repository@\$digest" edge/);
  assert.match(workflow, /crane tag "\$anchor_repository@\$anchor_digest" edge/);
});

test('edge workflow triggers on every source that changes the released manifests or runtime contract', () => {
  const pushSection = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('permissions:'));
  const requiredPaths = [
    'backend/supabase/**',
    'backend/gitea/**',
    'backend/recovery/**',
    'deploy/**',
  ];
  for (const requiredPath of requiredPaths) {
    const pattern = new RegExp(`^\\s+- ${requiredPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
    assert.match(
      pushSection,
      pattern,
      `publish-edge-images.yml push.paths must include "${requiredPath}" so atomic edge releases stay in sync with the Supabase/Gitea runtime contract`,
    );
  }
  assert.doesNotMatch(pushSection, /backend\/backbone\//);
  assert.doesNotMatch(workflow, /opensphere-cbs-/);
  assert.match(workflow, /image: opensphere-console-gitea/);
  assert.match(workflow, /context: OpenSphere-console\/backend\/gitea\/image/);
  assert.match(workflow, /component_keys=\(\s*console\s+backend\s+dupaController\s+oaaGateway\s+gitea\s*\)/);
  assert.match(workflow, /component_keys=\(backend dupaController oaaGateway gitea\)/);
});

test('production image build does not fetch external fonts while compiling', () => {
  const optimization = angularConfig.projects['opensphere-console'].architect.build.configurations.production.optimization;
  assert.equal(optimization.fonts, false);
});
