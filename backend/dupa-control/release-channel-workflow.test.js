const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'publish-edge-images.yml'), 'utf8');
const angularConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'angular.json'), 'utf8'));
const localEdgePublisher = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'Publish-LocalEdge.ps1'), 'utf8');

test('edge is advanced only after every immutable console component is verified', () => {
  const matrixMetadata = workflow.slice(workflow.indexOf('      - name: Image metadata'), workflow.indexOf('      - name: Build and push'));
  assert.match(matrixMetadata, /type=sha,prefix=sha-/);
  assert.doesNotMatch(matrixMetadata, /type=raw,value=edge/);
  assert.match(workflow, /publish-edge:\s*\n\s+needs: \[publish\]/);
  assert.match(workflow, /source_tag="sha-\$\{GITHUB_SHA:0:7\}"/);
  assert.match(workflow, /Do not move any channel tag until every immutable component was/);
  assert.match(workflow, /bom="\$RUNNER_TEMP\/opensphere-release-bom\.json"/);
  assert.match(workflow, /digest="\$\(jq -r --arg key "\$key" '\.components\[\$key\]\.image \| split\("@\"\)\[1\]' "\$bom"\)"/);
  assert.match(workflow, /crane tag "\$repository@\$digest" edge/);
  assert.match(workflow, /crane tag "\$anchor_repository@\$anchor_digest" edge/);
});

test('edge workflow is manual and its fallback images are amd64 only', () => {
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(workflow, /platforms: linux\/amd64/);
  assert.doesNotMatch(workflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(workflow, /--argjson supportedPlatforms '\["linux\/amd64"\]'/);
  assert.doesNotMatch(workflow, /opensphere-cbs-/);
  assert.match(workflow, /image: opensphere-console-gitea/);
  assert.match(workflow, /context: OpenSphere-console\/backend\/gitea\/image/);
  assert.match(workflow, /image: opensphere-oaa-governed-adapter/);
  const componentKeyBlocks = [...workflow.matchAll(/component_keys=\(\s*([\s\S]*?)\s*\)/g)]
    .map((match) => match[1].trim().split(/\s+/));
  const releaseComponents = [
    'console',
    'backend',
    'dupaController',
    'oaaGateway',
    'oaaGovernedAdapter',
    'notificationDispatcher',
    'recovery',
    'gitea',
    'supabasePostgres',
    'supabaseAuth',
    'supabaseRest',
    'supabaseStorage',
    'giteaPostgres',
  ];
  const publishedImages = [...workflow.matchAll(/^\s+- image: ([a-z0-9-]+)$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(publishedImages, [
    'opensphere-console',
    'opensphere-console-backend',
    'opensphere-console-dupa-controller',
    'opensphere-console-oaa-gateway',
    'opensphere-oaa-governed-adapter',
    'opensphere-console-notification-dispatcher',
    'opensphere-console-recovery',
    'opensphere-console-gitea',
    'opensphere-console-supabase-postgres',
    'opensphere-console-supabase-auth',
    'opensphere-console-supabase-rest',
    'opensphere-console-supabase-storage',
    'opensphere-console-gitea-postgres',
  ]);
  assert.deepEqual(componentKeyBlocks, [releaseComponents, releaseComponents.slice(1)]);
});

test('Windows local edge publisher preserves the dotted OCI label key as one Docker argument', () => {
  assert.match(localEdgePublisher, /\$sourceRevisionTemplate = '\{\{ index \.Config\.Labels "io\.opensphere\.source-revision" \}\}'/);
  assert.match(localEdgePublisher, /docker image inspect \$currentEdge --format \$sourceRevisionTemplate/);
});

test('public Console edge workflow reads private Setup through a dedicated read-only secret', () => {
  const checkout = workflow.slice(
    workflow.indexOf('      - name: Require private Setup read credential'),
    workflow.indexOf('      - name: Checkout Cluster Manager'),
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
