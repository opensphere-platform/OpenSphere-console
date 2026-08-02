const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const consoleRoot = path.join(__dirname, '..', '..');
const gaWorkflow = fs.readFileSync(path.join(consoleRoot, '.github', 'workflows', 'publish-ga-images.yml'), 'utf8');
const angularConfig = JSON.parse(fs.readFileSync(path.join(consoleRoot, 'angular.json'), 'utf8'));
const localEdgePublisher = fs.readFileSync(path.join(consoleRoot, 'scripts', 'Publish-LocalEdge.ps1'), 'utf8');

test('GA is rebuilt by a manual GitHub workflow and never publishes edge', () => {
  assert.match(gaWorkflow, /^\s*workflow_dispatch:\s*$/m);
  assert.doesNotMatch(gaWorkflow, /^  push:/m);
  assert.match(gaWorkflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(gaWorkflow, /io\.opensphere\.channel=ga/);
  assert.match(gaWorkflow, /opensphere\.io\/build-authority=github-actions/);
  assert.match(gaWorkflow, /opensphere\.io\/release-class=ga/);
  assert.match(gaWorkflow, /opensphere\.io\/ga-eligible=true/);
  assert.match(gaWorkflow, /org\.opencontainers\.image\.version=\$\{\{ steps\.release\.outputs\.version \}\}/);
  assert.doesNotMatch(gaWorkflow, /crane tag [^\n]+ edge/);
  assert.match(gaWorkflow, /crane tag "\$repository@\$digest" ga/);
  assert.match(gaWorkflow, /crane tag "\$anchor_repository@\$anchor_digest" ga/);
});

test('GA channel moves only after a complete immutable Console BOM is prepared', () => {
  assert.match(gaWorkflow, /publish-ga:\s*\n\s+needs: \[publish\]/);
  assert.match(gaWorkflow, /source_tag="sha-\$\{GITHUB_SHA:0:7\}"/);
  assert.match(gaWorkflow, /release_tag="\$\(TZ=Asia\/Seoul date -d "@\$release_epoch" \+%Y%m%d%H%M\)"/);
  assert.match(gaWorkflow, /bom="\$RUNNER_TEMP\/opensphere-release-bom\.json"/);
  assert.match(gaWorkflow, /Do not move any channel tag until every immutable component was/);
  assert.match(gaWorkflow, /--argjson supportedPlatforms '\["linux\/amd64","linux\/arm64"\]'/);
  assert.match(gaWorkflow, /Advance GA with Console anchor last/);
});

test('Windows local edge publisher is host-native, GHCR-backed, and KST-versioned', () => {
  assert.match(localEdgePublisher, /\$env:OS -ne 'Windows_NT'/);
  assert.match(localEdgePublisher, /\$kubeContext -ne 'docker-desktop'/);
  assert.match(localEdgePublisher, /\$Platform -ne 'linux\/amd64'/);
  assert.match(localEdgePublisher, /--platform', \$Platform/);
  assert.match(localEdgePublisher, /--push/);
  assert.match(localEdgePublisher, /io\.opensphere\.channel=edge/);
  assert.match(localEdgePublisher, /io\.opensphere\.release-tag=\$releaseTag/);
  assert.match(localEdgePublisher, /org\.opencontainers\.image\.version=\$releaseTag/);
  assert.match(localEdgePublisher, /opensphere\.io\/build-authority=localhost/);
  assert.match(localEdgePublisher, /Set-RemoteTag -Repository .* -Tag \$releaseTag -Immutable/);
  assert.match(localEdgePublisher, /Set-RemoteTag -Repository .* -Tag edge/);
});

test('local edge publisher can rebuild only explicitly affected Console components', () => {
  // No component selector means the governed integrated release. An explicit
  // selector narrows the publication without weakening the full-release default.
  assert.match(localEdgePublisher, /\[string\[\]\]\$Components = @\('console', 'backend',/);
  assert.match(localEdgePublisher, /\$partialPublication = \$images\.Count -lt \$canonicalComponentCount/);
  assert.match(localEdgePublisher, /Where-Object \{ \$requestedComponents\.Contains\(\$_.Key\) \}/);
  assert.match(localEdgePublisher, /OpenSphereEdgeComponentPublication/);
  assert.match(localEdgePublisher, /\$componentEvidence = \[ordered\]@\{\}/);
  assert.match(localEdgePublisher, /\[string\]\$SetupSourcePath = ''/);
  assert.match(localEdgePublisher, /SetupSourcePath must be a clean governed Setup CLI Git worktree/);
  assert.match(localEdgePublisher, /worktree add --detach \$setupCheckout \$setupSourceRevision/);
  assert.doesNotMatch(localEdgePublisher, /\$components = \[ordered\]@\{\}/i);
  assert.match(localEdgePublisher, /Advance selected component tags without moving a partial Console anchor/);
});

test('retag-only promotion workflow is absent because channel identity is immutable image metadata', () => {
  assert.equal(fs.existsSync(path.join(consoleRoot, '.github', 'workflows', 'promote-image-channel.yml')), false);
});

test('public Console GA workflow reads private Setup through a dedicated read-only secret', () => {
  const checkout = gaWorkflow.slice(
    gaWorkflow.indexOf('      - name: Require private Setup read credential'),
    gaWorkflow.indexOf('      - name: Checkout Cluster Manager'),
  );
  assert.match(checkout, /SETUP_REPOSITORY_SSH_KEY/);
  assert.match(checkout, /ssh-key: \$\{\{ secrets\.SETUP_REPOSITORY_SSH_KEY \}\}/);
  assert.match(checkout, /persist-credentials: false/);
  assert.doesNotMatch(checkout, /secrets\.GITHUB_TOKEN/);
});

test('production image build does not fetch external fonts while compiling', () => {
  const optimization = angularConfig.projects['opensphere-console'].architect.build.configurations.production.optimization;
  assert.equal(optimization.fonts, false);
});
