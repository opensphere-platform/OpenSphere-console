const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const installer = read('install.ps1');
const manifest = read('gitea.yaml');
const signing = read('configure-signing.ps1');
const controlPlane = read('control-plane-bootstrap.ps1');

test('fresh Gitea install is digest-locked, resumable, and owns the safe zero-to-one transition', () => {
  assert.match(installer, /opensphere-console-gitea@sha256:\[a-f0-9\]\{64\}/);
  assert.match(installer, /opensphere-console-gitea-postgres@sha256:\[a-f0-9\]\{64\}/);
  assert.match(installer, /Reusing existing Gitea runtime credentials/);
  assert.match(installer, /Reusing existing private Gitea configuration/);
  assert.match(installer, /configure-signing\.ps1/);
  assert.match(installer, /control-plane-bootstrap\.ps1/);
  assert.match(installer, /scale', 'deployment\/opensphere-gitea', '--replicas=1'/);
  assert.doesNotMatch(installer, /--from-literal/);
  assert.match(manifest, /name: opensphere-gitea[\s\S]+?replicas: 0/);
});

test('Gitea change authority keeps signing and control credentials server-side', () => {
  assert.match(signing, /opensphere-gitea-signing/);
  assert.match(manifest, /emptyDir: \{ medium: Memory \}/);
  assert.match(manifest, /require signed|rejects unsigned|CRUD_ACTIONS/i);
  assert.match(controlPlane, /opensphere-gitea-control-plane/);
  assert.match(controlPlane, /exec', '-i', '-c', 'gitea'[\s\S]+?'sh', '-s'/);
  assert.doesNotMatch(controlPlane, /'--password', \$password/);
  assert.doesNotMatch(controlPlane, /--\s+sh\s+-ec\s+\$(?:command|protectionsCommand|hooksCommand)/);
  assert.doesNotMatch(
    controlPlane,
    /Write-Host.*\$(?:token|reviewToken|webhookSecret|reconcilerToken|password)/i
  );
});
