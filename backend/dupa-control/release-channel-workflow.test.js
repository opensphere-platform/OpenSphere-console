const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const consoleRoot = path.join(__dirname, '..', '..');
const candidateWorkflow = fs.readFileSync(path.join(consoleRoot, '.github', 'workflows', 'publish-candidate-images.yml'), 'utf8');
const promoteWorkflow = fs.readFileSync(path.join(consoleRoot, '.github', 'workflows', 'promote-release.yml'), 'utf8');
const angularConfig = JSON.parse(fs.readFileSync(path.join(consoleRoot, 'angular.json'), 'utf8'));
const localEdgePublisher = fs.readFileSync(path.join(consoleRoot, 'scripts', 'Publish-LocalEdge.ps1'), 'utf8');
const setupSourceLock = fs.readFileSync(
  path.join(consoleRoot, 'backend', 'opensphere-console-backend', 'setup-source.lock'),
  'utf8'
).trim();

test('GA lineage is clean-built as candidate and never publishes edge or ga directly', () => {
  assert.match(candidateWorkflow, /^\s*workflow_dispatch:\s*$/m);
  assert.doesNotMatch(candidateWorkflow, /^  push:/m);
  assert.match(candidateWorkflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(candidateWorkflow, /io\.opensphere\.channel=candidate/);
  assert.match(candidateWorkflow, /io\.opensphere\.built-channel=candidate/);
  assert.match(candidateWorkflow, /opensphere\.io\/build-authority=github-actions/);
  assert.match(candidateWorkflow, /opensphere\.io\/release-class=pre-ga/);
  assert.match(candidateWorkflow, /opensphere\.io\/ga-eligible=true/);
  assert.match(candidateWorkflow, /org\.opencontainers\.image\.version=\$\{\{ steps\.release\.outputs\.version \}\}/);
  assert.doesNotMatch(candidateWorkflow, /crane tag [^\n]+ (?:edge|stable|ga)/);
  assert.match(candidateWorkflow, /crane tag "\$repository@\$digest" candidate/);
  assert.match(candidateWorkflow, /crane tag "\$anchor_repository@\$anchor_digest" candidate/);
});

test('candidate moves only after a complete immutable Console BOM is prepared', () => {
  assert.match(candidateWorkflow, /publish-candidate:\s*\n\s+needs: \[publish\]/);
  assert.match(candidateWorkflow, /source_tag="sha-\$\{GITHUB_SHA:0:7\}"/);
  assert.match(candidateWorkflow, /release_tag="\$\(TZ=Asia\/Seoul date -d "@\$release_epoch" \+%Y%m%d%H%M\)"/);
  assert.match(candidateWorkflow, /bom="\$RUNNER_TEMP\/opensphere-release-bom\.json"/);
  assert.match(candidateWorkflow, /Do not move any channel tag until every immutable component was/);
  assert.match(candidateWorkflow, /--argjson supportedPlatforms '\["linux\/amd64","linux\/arm64"\]'/);
  assert.match(candidateWorkflow, /Advance candidate with Console anchor last/);
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
  assert.match(localEdgePublisher, /\$auxiliaryComponentKeys = @\('cliArtifacts', 'osShellControl', 'osShellRuntime'\)/);
  assert.match(localEdgePublisher, /\$canonicalImages = @\(\$allImages \| Where-Object \{ \$_\.Key -notin \$auxiliaryComponentKeys \}\)/);
  assert.match(localEdgePublisher, /\$partialPublication = -not \$integratedPublication/);
  assert.match(localEdgePublisher, /Where-Object \{ \$requestedComponents\.Contains\(\$_.Key\) \}/);
  assert.match(localEdgePublisher, /OpenSphereEdgeComponentPublication/);
  assert.match(localEdgePublisher, /ValidateSet\('console', 'cliArtifacts', 'osShellControl', 'osShellRuntime', 'backend'/);
  assert.match(localEdgePublisher, /Key = 'cliArtifacts'; Image = 'opensphere-os-cli'/);
  assert.match(localEdgePublisher, /\$componentEvidence = \[ordered\]@\{\}/);
  assert.match(localEdgePublisher, /\[string\]\$SetupSourcePath = ''/);
  assert.match(localEdgePublisher, /SetupSourcePath must be a clean governed Setup CLI Git worktree/);
  assert.match(localEdgePublisher, /worktree add --detach \$setupCheckout \$setupSourceRevision/);
  assert.match(setupSourceLock, /^[a-f0-9]{40}$/);
  assert.match(localEdgePublisher, /setup-source\.lock/);
  assert.match(localEdgePublisher, /differs from governed lock/);
  assert.doesNotMatch(localEdgePublisher, /\$components = \[ordered\]@\{\}/i);
  assert.match(localEdgePublisher, /Advance selected component tags without moving a partial Console anchor/);
  assert.match(localEdgePublisher, /opensphere-local-component-publication-\$\(\$item\.Key\)\.json/);
  assert.match(localEdgePublisher, /\$singleComponentBom\['components'\] = \[ordered\]@\{/);
  assert.match(localEdgePublisher, /AdvanceOsShellUxConsoleEdge requires exactly console and osShellRuntime components/);
  assert.match(localEdgePublisher, /-not \$partialPublication -or \$AdvanceOsShellUxConsoleEdge/);
});

test('promotion is adjacent, approval-gated, exact-digest and moves the Console anchor last', () => {
  assert.match(promoteWorkflow, /stable\) source_channel=candidate/);
  assert.match(promoteWorkflow, /ga\) source_channel=stable; test -n "\$AZURE_RELEASE_EVIDENCE"/);
  assert.match(promoteWorkflow, /environment: \$\{\{ inputs\.target_channel == 'ga' && 'console-ga' \|\| 'console-stable' \}\}/);
  assert.match(promoteWorkflow, /test "\$source_digest" = "\$release_digest"/);
  assert.match(promoteWorkflow, /test "\$built_channel" = candidate/);
  assert.match(promoteWorkflow, /Attest promotion receipt before moving the channel/);
  assert.match(promoteWorkflow, /Advance target channel with Console anchor last/);
});

test('candidate backend build reads private Setup through a dedicated read-only secret', () => {
  const start = candidateWorkflow.indexOf('      - name: Require private Setup read credential');
  const checkout = candidateWorkflow.slice(
    start,
    candidateWorkflow.indexOf('      - name: Record Setup source revision', start),
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
