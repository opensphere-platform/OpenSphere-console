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
  assert.match(workflow, /crane tag "\$repository@\$\{digests\[\$image\]\}" edge/);
});

test('edge workflow triggers on every source that changes the released manifests or runtime contract', () => {
  const pushSection = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('permissions:'));
  const requiredPaths = [
    'backend/backbone/images/**',
    'backend/backbone/bootstrap/**',
    'backend/backbone/console-services.yaml',
    'deploy/**',
  ];
  for (const requiredPath of requiredPaths) {
    const pattern = new RegExp(`^\\s+- ${requiredPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
    assert.match(
      pushSection,
      pattern,
      `publish-edge-images.yml push.paths must include "${requiredPath}" so Clean Setup / atomic edge releases stay in sync with CBS manifests and the Main Shell runtime contract`,
    );
  }
});

test('production image build does not fetch external fonts while compiling', () => {
  const optimization = angularConfig.projects['opensphere-console'].architect.build.configurations.production.optimization;
  assert.equal(optimization.fonts, false);
});
