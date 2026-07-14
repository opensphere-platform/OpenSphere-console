const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'publish-edge-images.yml'), 'utf8');

test('edge is advanced only after every immutable console component is verified', () => {
  const matrixMetadata = workflow.slice(workflow.indexOf('      - name: Image metadata'), workflow.indexOf('      - name: Build and push'));
  assert.match(matrixMetadata, /type=sha,prefix=sha-/);
  assert.doesNotMatch(matrixMetadata, /type=raw,value=edge/);
  assert.match(workflow, /publish-edge:\s*\n\s+needs: \[publish\]/);
  assert.match(workflow, /source_tag="sha-\$\{GITHUB_SHA:0:7\}"/);
  assert.match(workflow, /Do not move any channel tag until every immutable component was/);
  assert.match(workflow, /crane tag "\$repository@\$\{digests\[\$image\]\}" edge/);
});
