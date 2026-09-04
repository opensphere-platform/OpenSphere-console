import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

const canonical = [
  ['console', 'opensphere-console', 'apps/console-web/Dockerfile'],
  ['consoleApi', 'opensphere-console-api', 'apps/console-api/Dockerfile'],
  ['extensionController', 'opensphere-extension-controller', 'apps/extension-controller/Dockerfile'],
  ['registry', 'opensphere-registry', 'backend/registry/deploy/Dockerfile'],
  ['osaaGateway', 'opensphere-console-osaa-gateway', 'apps/osaa-gateway/Dockerfile'],
  ['osdst', 'opensphere-osdst', 'apps/osdst/Dockerfile'],
  ['osaaGovernedAdapter', 'opensphere-osaa-governed-adapter', 'backend/osaa-governed-adapter/Dockerfile'],
  ['notificationDispatcher', 'opensphere-console-notification-dispatcher', 'apps/notification-dispatcher/Dockerfile'],
  ['gitea', 'opensphere-console-gitea', 'backend/gitea/image/Dockerfile'],
  ['supabasePostgres', 'opensphere-console-supabase-postgres', 'backend/supabase/images/postgres/Dockerfile'],
  ['supabaseAuth', 'opensphere-console-supabase-auth', 'backend/supabase/images/auth/Dockerfile'],
  ['supabaseRest', 'opensphere-console-supabase-rest', 'backend/supabase/images/rest/Dockerfile'],
  ['supabaseStorage', 'opensphere-console-supabase-storage', 'backend/supabase/images/storage/Dockerfile'],
  ['giteaPostgres', 'opensphere-console-gitea-postgres', 'backend/gitea/postgres-image/Dockerfile'],
  ['recovery', 'opensphere-console-recovery', 'apps/recovery-owner/Dockerfile'],
  ['beszelHub', 'opensphere-console-beszel-hub', 'deploy/baseline-monitoring/images/hub/Dockerfile'],
  ['beszelAgent', 'opensphere-console-beszel-agent', 'deploy/baseline-monitoring/images/agent/Dockerfile'],
  ['beszelBootstrap', 'opensphere-console-beszel-bootstrap', 'deploy/baseline-monitoring/images/bootstrap/Dockerfile'],
];
const auxiliary = [
  ['cliArtifacts', 'opensphere-os-cli', 'cmd/os-cli/Dockerfile'],
  ['osShellControl', 'opensphere-console-os-shell-control', 'apps/os-shell-control/Dockerfile'],
  ['osShellRuntime', 'opensphere-os-shell-runtime', 'apps/os-shell-control/Dockerfile.runtime'],
  ['consoleIndexContent', 'opensphere-console-index-content', 'apps/console-index-content/Dockerfile'],
];

const canonicalKeys = canonical.map(([key]) => key);
const canonicalImages = canonical.map(([, image]) => image);
const auxiliaryKeys = auxiliary.map(([key]) => key);
const auxiliaryImages = auxiliary.map(([, image]) => image);

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function bashArray(source, name) {
  const match = source.match(new RegExp(`(?:^|\\n)\\s*${name}=\\(\\n([\\s\\S]*?)\\n\\s*\\)`, 'u'));
  assert.ok(match, `${name} bash array is missing`);
  return match[1].split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
}

function quotedPowerShellArray(source, declaration) {
  const escaped = declaration.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*=\\s*@\\(([^)]*)\\)`, 'u'));
  assert.ok(match, `${declaration} PowerShell array is missing`);
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]);
}

function stepRun(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `workflow step is missing: ${name}`);
  assert.equal(typeof step.run, 'string', `${name} must be a script step`);
  return step.run;
}

test('candidate matrix has 18 canonical and four signed auxiliary artifacts', async () => {
  const workflow = yaml.load(await read('.github/workflows/publish-candidate-images.yml'));
  const publish = workflow.jobs.publish;
  assert.equal(publish.if, '${{ false }}', 'candidate publication HOLD must remain fail-closed');

  const matrix = publish.strategy.matrix.include;
  assert.equal(matrix.length, 22);
  const canonicalMatrix = matrix.filter(({ scope }) => scope === 'canonical');
  const auxiliaryMatrix = matrix.filter(({ scope }) => scope === 'auxiliary');
  assert.equal(canonicalMatrix.length, 18);
  assert.equal(auxiliaryMatrix.length, 4);
  assert.deepEqual(sorted(canonicalMatrix.map(({ image }) => image)), sorted(canonicalImages));
  assert.deepEqual(sorted(auxiliaryMatrix.map(({ image }) => image)), sorted(auxiliaryImages));

  const expectedFiles = new Map([...canonical, ...auxiliary].map(([, image, file]) => [image, `OpenSphere-console/${file}`]));
  for (const entry of matrix) {
    assert.equal(entry.file, expectedFiles.get(entry.image), `${entry.image} Dockerfile differs`);
    await read(entry.file.replace(/^OpenSphere-console\//u, ''));
  }

  const source = await read('.github/workflows/publish-candidate-images.yml');
  assert.match(source, /io\.opensphere\.release-scope=\$\{\{ matrix\.scope \}\}/u);
  assert.match(source, /io\.opensphere\.console-index-content=console-index-renderer\/v1/u);
  assert.match(source, /CLI_DARWIN_CONTEXT=macos-cli/u);
  assert.match(source, /CLI_REQUIRE_DARWIN=true/u);
  assert.match(source, /cli_update_signing_key=\$\{\{ secrets\.CLI_UPDATE_SIGNING_PRIVATE_KEY \}\}/u);
  assert.doesNotMatch(source, /opensphere-console-backend/u);
});

test('candidate BOM and anchor-last tag arrays contain exactly the canonical family', async () => {
  const workflow = yaml.load(await read('.github/workflows/publish-candidate-images.yml'));
  const job = workflow.jobs['publish-candidate'];
  assert.equal(job.needs[0] ?? job.needs, 'publish');

  const bom = stepRun(job, 'Verify immutable release and prepare signed BOM');
  const bomImages = bashArray(bom, 'images');
  const bomKeys = bashArray(bom, 'component_keys');
  assert.equal(bomImages.length, 18);
  assert.equal(bomKeys.length, 18);
  assert.doesNotMatch(bom, /-eq 19/u);
  assert.ok((bom.match(/-eq 18/gu) || []).length >= 2, 'candidate BOM shell count gates must use canonical 18');
  assert.deepEqual(sorted(bomImages), sorted(canonicalImages));
  assert.deepEqual(new Map(bomKeys.map((key, index) => [key, bomImages[index]])), new Map(canonical.map(([key, image]) => [key, image])));
  assert.match(bom, /\(\.components \| length\) == 18/u);
  assert.match(bom, /\["io\.opensphere\.release-scope"\]/u);
  assert.match(bom, /"\$scope" != canonical/u);

  const advance = stepRun(job, 'Advance candidate with Console anchor last');
  assert.deepEqual(sorted(bashArray(advance, 'images')), sorted(canonicalImages.filter((image) => image !== 'opensphere-console')));
  assert.deepEqual(bashArray(advance, 'auxiliary_images'), auxiliaryImages);
  assert.match(advance, /publish_immutable_tag "\$repository" "\$digest"/u);
  assert.ok(
    advance.indexOf('for index in "${!images[@]}"') < advance.indexOf('anchor_repository="ghcr.io/opensphere-platform/opensphere-console"'),
    'Console candidate anchor must move after every non-anchor canonical tag',
  );
});

test('stable and GA stay held and describe only an 18-component canonical promotion', async () => {
  const workflow = yaml.load(await read('.github/workflows/promote-release.yml'));
  const promote = workflow.jobs.promote;
  assert.equal(promote.if, '${{ false }}', 'stable/GA HOLD must remain fail-closed');
  const verify = stepRun(promote, 'Verify adjacent source channel and exact release family');
  assert.deepEqual(bashArray(verify, 'canonical_images'), canonicalImages);
  assert.deepEqual(bashArray(verify, 'auxiliary_images'), auxiliaryImages);
  assert.match(verify, /test "\$\{#canonical_images\[@\]\}" -eq 18/u);
  assert.match(verify, /\(\.components \| length\) == 18/u);
  assert.match(verify, /Auxiliary artifacts are intentionally outside this canonical/u);

  const advance = stepRun(promote, 'Advance target channel with Console anchor last');
  assert.doesNotMatch(advance, /auxiliaryComponents|auxiliary_images/u);
  assert.ok(
    advance.indexOf("select(. != \"opensphere-console\")") < advance.indexOf("anchor_repository='ghcr.io/opensphere-platform/opensphere-console'"),
    'Console promotion anchor must move last',
  );
});

test('local edge moves its anchor only with canonical 18 and auxiliary four at one revision', async () => {
  const source = await read('scripts/Publish-LocalEdge.ps1');
  assert.deepEqual(quotedPowerShellArray(source, '[string[]]$Components'), [...canonicalKeys, ...auxiliaryKeys]);
  assert.deepEqual(quotedPowerShellArray(source, '$canonicalComponentKeys'), canonicalKeys);
  assert.deepEqual(quotedPowerShellArray(source, '$auxiliaryComponentKeys'), auxiliaryKeys);
  assert.match(source, /\$completeReleaseComponentKeys = @\(\$canonicalComponentKeys \+ \$auxiliaryComponentKeys\)/u);
  assert.deepEqual(quotedPowerShellArray(source, '$blockedLegacyComponentKeys'), ['backend']);
  assert.match(source, /if \(\$Components -contains 'backend'\) \{\s*throw /u);
  assert.ok(source.indexOf("if ($Components -contains 'backend')") < source.indexOf('New-Item -ItemType Directory'));
  assert.ok(source.indexOf("if ($Components -contains 'cliArtifacts')") < source.indexOf('New-Item -ItemType Directory'));
  assert.match(source, /\$canonicalImages\.Count -ne 18/u);
  assert.match(source, /\$componentEvidence\.Count -ne 18/u);
  assert.match(source, /\$auxiliaryArtifactEvidence\.Count -ne 4/u);
  assert.match(source, /\$bom\['auxiliaryArtifacts'\] = \$auxiliaryArtifactEvidence/u);
  assert.match(source, /\$canonicalAnchorMayMove = \$integratedRequest -or \$AdvanceOsShellUxConsoleEdge/u);
  assert.match(source, /if \(\$integratedRequest\) \{[\s\S]*'--release-ready', '--release-profile=bootstrap-core'/u);
  assert.match(source, /elseif \(\$AdvanceOsShellUxConsoleEdge\) \{\s*\$contractArguments \+= '--release-ready'/u);
  assert.match(source, /Invoke-Checked node @contractArguments/u);
  assert.ok(
    source.indexOf("Invoke-Checked node @contractArguments") < source.indexOf("Write-Host '[step 03/06] Confirm GHCR authentication mode'"),
    'contract and release-ready gates must run before GHCR authentication or image build',
  );
  assert.match(source, /io\.opensphere\.release-scope=\$releaseScope/u);
  assert.match(source, /\$item\.Key -eq 'console'[\s\S]*io\.opensphere\.console-index-content=console-index-renderer\/v1/u);
  assert.doesNotMatch(source, /--no-cache/u);
  assert.match(source, /ExpectedReleaseScope \$releaseScope/u);
  const builtImageMetadataCheck = source.slice(
    source.indexOf('$metadata = Get-Content -Raw -LiteralPath $metadataFile'),
    source.indexOf('$digests[$item.Key] = $digest'),
  );
  assert.match(
    builtImageMetadataCheck,
    /Assert-LocalEdgeImageMetadata[\s\S]*-ExpectedPlatform \$Platform -ExpectedReleaseScope \$releaseScope/u,
    'a newly built image must verify the canonical or auxiliary release-scope label before publication',
  );
  assert.match(source, /-Tag \$releaseTag -Immutable/u);
  const runtimeBytesGate = source.indexOf('[preflight] Console API runtime contract bytes match source');
  const immutableTagPromotion = source.indexOf("Write-Host \"[step 05/06] Publish immutable date tag");
  assert.ok(runtimeBytesGate > 0 && runtimeBytesGate < immutableTagPromotion,
    'Console API runtime contract bytes must match source before immutable or channel tags move');
  assert.match(source, /docker run --rm --pull always --entrypoint sha256sum/u);
  assert.match(source, /gh api user --jq \.login/u);
  assert.match(source, /docker login ghcr\.io -u \$registryActor --password-stdin/u);
  assert.doesNotMatch(source, /docker login ghcr\.io -u opensphere-platform/u);
  assert.doesNotMatch(
    source.match(/\[string\[\]\]\$Components\s*=\s*@\(([^)]*)\)/u)?.[1] ?? '',
    /backend/u,
  );

  const entries = [...source.matchAll(/\[ordered\]@\{ Key = '([^']+)'; Image = '([^']+)';[^\r\n]*?File = \(Join-Path \$consoleCheckout '([^']+)'\)/gu)]
    .map(([, key, image, file]) => [key, image, file.replaceAll('\\', '/')]);
  const entryMap = new Map(entries.map((entry) => [entry[0], entry]));
  for (const expected of [...canonical, ...auxiliary]) {
    assert.deepEqual(entryMap.get(expected[0]), expected);
  }
});
