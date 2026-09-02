#requires -Version 7.2

[CmdletBinding()]
param(
  [string]$Registry = 'ghcr.io/opensphere-platform',
  [switch]$UseExistingRegistryLogin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked {
  if ($args.Count -lt 1) { throw 'Invoke-Checked requires an executable.' }
  $program = [string]$args[0]
  $arguments = @($args | Select-Object -Skip 1)
  $output = & $program @arguments
  if ($LASTEXITCODE -ne 0) { throw "$program failed with exit code $LASTEXITCODE" }
  return $output
}

function Get-RemoteDigest {
  param([Parameter(Mandatory)][string]$Reference)
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & docker buildx imagetools inspect $Reference 2>$null
    $exitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($exitCode -ne 0) { return $null }
  $line = $output | Where-Object { $_ -match '^Digest:\s+(sha256:[a-f0-9]{64})$' } | Select-Object -First 1
  if (-not $line) { throw "Could not parse registry digest for $Reference" }
  return ([regex]::Match($line, 'sha256:[a-f0-9]{64}')).Value
}

function Get-ImageMetadata {
  param([Parameter(Mandatory)][string]$Reference)
  $raw = Invoke-Checked docker buildx imagetools inspect --format '{{json .Image}}' $Reference
  return (($raw -join "`n") | ConvertFrom-Json)
}

function Get-SourceRevision {
  param([Parameter(Mandatory)][string]$Reference)
  $metadata = Get-ImageMetadata -Reference $Reference
  $property = $metadata.config.Labels.PSObject.Properties['io.opensphere.source-revision']
  $revision = if ($property) { [string]$property.Value } else { '' }
  if ($revision -notmatch '^[a-f0-9]{40}$') { throw "Live image has no canonical source revision: $Reference" }
  return $revision
}

function Assert-ImageMetadata {
  param(
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$Digest,
    [Parameter(Mandatory)][string]$SourceRevision,
    [Parameter(Mandatory)][string]$ReleaseTag
  )
  $reference = "${Repository}@${Digest}"
  $metadata = Get-ImageMetadata -Reference $reference
  if ("$($metadata.os)/$($metadata.architecture)" -ne 'linux/amd64') {
    throw "Image platform is not linux/amd64: $reference"
  }
  $expected = [ordered]@{
    'io.opensphere.channel' = 'edge'
    'io.opensphere.source-revision' = $SourceRevision
    'io.opensphere.release-tag' = $ReleaseTag
    'org.opencontainers.image.version' = $ReleaseTag
    'org.opencontainers.image.source' = 'https://github.com/opensphere-platform/OpenSphere-console'
    'opensphere.io/build-authority' = 'localhost'
    'opensphere.io/release-class' = 'pre-ga'
    'opensphere.io/ga-eligible' = 'false'
  }
  foreach ($entry in $expected.GetEnumerator()) {
    $property = $metadata.config.Labels.PSObject.Properties[$entry.Key]
    $actual = if ($property) { [string]$property.Value } else { '' }
    if ($actual -ne [string]$entry.Value) {
      throw "Image label $($entry.Key) is '$actual', expected '$($entry.Value)': $reference"
    }
  }
  if ((Get-RemoteDigest -Reference $reference) -ne $Digest) { throw "Image digest verification failed: $reference" }
}

function Set-RemoteTag {
  param([string]$Repository,[string]$Digest,[string]$Tag,[switch]$Immutable)
  $reference = "${Repository}:$Tag"
  $existing = Get-RemoteDigest -Reference $reference
  if ($Immutable -and $existing -and $existing -ne $Digest) {
    throw "Immutable tag collision: $reference is $existing, expected $Digest"
  }
  if ($existing -ne $Digest) {
    Invoke-Checked docker buildx imagetools create --prefer-index=false --tag $reference "${Repository}@${Digest}" | Out-Null
  }
  if ((Get-RemoteDigest -Reference $reference) -ne $Digest) { throw "Tag verification failed: $reference" }
}

if ($env:OS -ne 'Windows_NT') { throw 'OSAA chat edge publishing requires Windows.' }
if (((Invoke-Checked kubectl config current-context) -join '').Trim() -ne 'docker-desktop') {
  throw 'OSAA chat edge publishing requires Kubernetes context docker-desktop.'
}
$dockerOs = ((Invoke-Checked docker info --format '{{.OSType}}') -join '').Trim().ToLowerInvariant()
$dockerArch = ((Invoke-Checked docker info --format '{{.Architecture}}') -join '').Trim().ToLowerInvariant()
if ($dockerOs -ne 'linux' -or $dockerArch -notin @('amd64','x86_64')) {
  throw "OSAA chat edge publishing requires Linux containers on amd64; received $dockerOs/$dockerArch"
}
if ($Registry -cne 'ghcr.io/opensphere-platform') { throw 'Registry must be the canonical OpenSphere GHCR namespace.' }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (((Invoke-Checked git -C $repoRoot remote get-url origin) -join '').TrimEnd('/') -cne
    'https://github.com/opensphere-platform/OpenSphere-console.git') { throw 'Console origin is not canonical.' }
if (((Invoke-Checked git -C $repoRoot branch --show-current) -join '').Trim() -cne 'main') {
  throw 'OSAA chat publishing runs only from canonical main.'
}
if (Invoke-Checked git -C $repoRoot status --porcelain=v1 --untracked-files=all) {
  throw 'Console main must be completely clean before publishing.'
}
Invoke-Checked git -C $repoRoot fetch --prune origin main | Out-Null
$sourceRevision = ((Invoke-Checked git -C $repoRoot rev-parse HEAD) -join '').Trim()
$originMain = ((Invoke-Checked git -C $repoRoot rev-parse refs/remotes/origin/main) -join '').Trim()
if ($sourceRevision -notmatch '^[a-f0-9]{40}$' -or $sourceRevision -cne $originMain) {
  throw 'Console main must equal fresh origin/main.'
}

$consoleRepository = "$Registry/opensphere-console"
$gatewayRepository = "$Registry/opensphere-console-osaa-gateway"
$liveConsoleImage = ((Invoke-Checked kubectl -n opensphere-console get deployment opensphere-console `
  -o 'jsonpath={.spec.template.spec.containers[0].image}') -join '').Trim()
$liveGatewayImage = ((Invoke-Checked kubectl -n opensphere-console get deployment opensphere-console-osaa-gateway `
  -o 'jsonpath={.spec.template.spec.containers[0].image}') -join '').Trim()
if ($liveConsoleImage -notmatch '^ghcr[.]io/opensphere-platform/opensphere-console@sha256:[a-f0-9]{64}$' -or
    $liveGatewayImage -notmatch '^ghcr[.]io/opensphere-platform/opensphere-console-osaa-gateway@sha256:[a-f0-9]{64}$') {
  throw 'Live OSAA chat components are not pinned to canonical exact digests.'
}
$consoleBaseRevision = Get-SourceRevision -Reference $liveConsoleImage
$gatewayBaseRevision = Get-SourceRevision -Reference $liveGatewayImage
foreach ($baseRevision in @($consoleBaseRevision,$gatewayBaseRevision)) {
  Invoke-Checked git -C $repoRoot fetch --no-tags origin $baseRevision | Out-Null
  Invoke-Checked git -C $repoRoot merge-base --is-ancestor $baseRevision $sourceRevision | Out-Null
}
$consoleChangedPaths = @(Invoke-Checked git -C $repoRoot diff --name-only $consoleBaseRevision $sourceRevision -- `
  Dockerfile angular.json package.json package-lock.json packages/contracts nginx public scripts src)
$gatewayChangedPaths = @(Invoke-Checked git -C $repoRoot diff --name-only $gatewayBaseRevision $sourceRevision -- `
  apps/osaa-gateway)
if ('src/app/os/os-osaa-agent.ts' -notin $consoleChangedPaths -or -not $gatewayChangedPaths.Count) {
  throw 'OSAA chat publication requires both the native Console agent and Gateway component changes.'
}
$changedPaths = @($consoleChangedPaths + $gatewayChangedPaths | Sort-Object -Unique)

$epoch = [long](((Invoke-Checked git -C $repoRoot show -s --format=%ct $sourceRevision) -join '').Trim())
$releaseTag = [DateTimeOffset]::FromUnixTimeSeconds($epoch).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyyMMddHHmm')
$localTag = "local-$($sourceRevision.Substring(0,12))"
$outputBase = Join-Path (Split-Path $repoRoot -Parent) ".codex-tmp\osaa-chat-edge-$($sourceRevision.Substring(0,12))"
$outputRoot = if (Test-Path -LiteralPath $outputBase) {
  "$outputBase-retry-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))"
} else { $outputBase }
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) "opensphere-osaa-chat-$([Guid]::NewGuid().ToString('N'))"
$checkout = Join-Path $buildRoot 'OpenSphere-console'
$metadataRoot = Join-Path $buildRoot 'metadata'
New-Item -ItemType Directory -Path $buildRoot,$metadataRoot,$outputRoot | Out-Null

try {
  Invoke-Checked git -C $repoRoot worktree add --detach $checkout $sourceRevision | Out-Null
  Invoke-Checked node --test `
    (Join-Path $checkout 'apps\osaa-gateway\r2d2-prompt-boundary.test.js') `
    (Join-Path $checkout 'apps\osaa-gateway\r2d2-source-grounding.test.js') `
    (Join-Path $checkout 'apps\osaa-gateway\r2d2-surface-diagnostics.test.js') `
    (Join-Path $checkout 'apps\osaa-gateway\conversation-store.test.js') `
    (Join-Path $checkout 'backend\dupa-control\osaa-native-ui.test.js') `
    (Join-Path $checkout 'scripts\osaa-chat-publisher.test.mjs') | Out-Null

  if (-not $UseExistingRegistryLogin) {
    $token = ((Invoke-Checked gh auth token) -join '').Trim()
    try {
      $token | docker login ghcr.io -u opensphere-platform --password-stdin | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'GHCR login failed.' }
    } finally { $token = $null }
  }

  $commonLabels = @(
    '--label', 'io.opensphere.channel=edge',
    '--label', "io.opensphere.source-revision=$sourceRevision",
    '--label', "io.opensphere.release-tag=$releaseTag",
    '--label', "org.opencontainers.image.version=$releaseTag",
    '--label', 'org.opencontainers.image.source=https://github.com/opensphere-platform/OpenSphere-console',
    '--label', 'opensphere.io/build-authority=localhost',
    '--label', 'opensphere.io/release-class=pre-ga',
    '--label', 'opensphere.io/ga-eligible=false'
  )
  $consoleMetadata = Join-Path $metadataRoot 'console.json'
  $gatewayMetadata = Join-Path $metadataRoot 'osaa-gateway.json'
  Invoke-Checked docker buildx build --platform linux/amd64 --push --provenance=mode=max `
    --metadata-file $consoleMetadata --tag "${consoleRepository}:$localTag" @commonLabels `
    --file (Join-Path $checkout 'Dockerfile') $checkout | Out-Null
  Invoke-Checked docker buildx build --platform linux/amd64 --push --provenance=mode=max `
    --metadata-file $gatewayMetadata --tag "${gatewayRepository}:$localTag" @commonLabels `
    --file (Join-Path $checkout 'apps\osaa-gateway\Dockerfile') `
    (Join-Path $checkout 'apps\osaa-gateway') | Out-Null

  $consoleDigest = [string](Get-Content -Raw -LiteralPath $consoleMetadata | ConvertFrom-Json).'containerimage.digest'
  $gatewayDigest = [string](Get-Content -Raw -LiteralPath $gatewayMetadata | ConvertFrom-Json).'containerimage.digest'
  if ($consoleDigest -notmatch '^sha256:[a-f0-9]{64}$' -or $gatewayDigest -notmatch '^sha256:[a-f0-9]{64}$') {
    throw 'OSAA chat builds did not produce two exact digests.'
  }
  Assert-ImageMetadata -Repository $consoleRepository -Digest $consoleDigest -SourceRevision $sourceRevision -ReleaseTag $releaseTag
  Assert-ImageMetadata -Repository $gatewayRepository -Digest $gatewayDigest -SourceRevision $sourceRevision -ReleaseTag $releaseTag

  # Move neither channel until both affected images have built and verified.
  Set-RemoteTag -Repository $consoleRepository -Digest $consoleDigest -Tag $releaseTag -Immutable
  Set-RemoteTag -Repository $gatewayRepository -Digest $gatewayDigest -Tag $releaseTag -Immutable
  Set-RemoteTag -Repository $consoleRepository -Digest $consoleDigest -Tag edge
  Set-RemoteTag -Repository $gatewayRepository -Digest $gatewayDigest -Tag edge

  $publication = [ordered]@{
    apiVersion='release.opensphere.io/v1alpha1'; kind='OpenSphereEdgeComponentPublication'
    publicationScope='ComponentSet'; channel='edge'; status='Active'
    requestIntent='Publish only the native OSAA chat UI and OSAA Gateway model-authority correction.'
    changedPaths=$changedPaths; affectedImages=@($consoleRepository,$gatewayRepository)
    releaseScope='component'; fullReleaseJustification=$null; releaseTag=$releaseTag; immutableTag=$releaseTag
    source='https://github.com/opensphere-platform/OpenSphere-console'; sourceRevision=$sourceRevision
    buildAuthority='localhost'; releaseClass='pre-ga'; gaEligible=$false; supportedPlatforms=@('linux/amd64')
    components=[ordered]@{
      console=[ordered]@{ repository='opensphere-console'; image="${consoleRepository}@${consoleDigest}"; sourceRevision=$sourceRevision }
      osaaGateway=[ordered]@{ repository='opensphere-console-osaa-gateway'; image="${gatewayRepository}@${gatewayDigest}"; sourceRevision=$sourceRevision }
    }
    verification=[ordered]@{
      configuredModelAuthority='PASS'; exactAffectedComponentSet=@('console','osaaGateway')
      allAffectedImagesBuiltBeforeChannelMove=$true; unchangedComponentBuildCount=0
    }
  }
  $evidencePath = Join-Path $outputRoot 'opensphere-osaa-chat-publication.json'
  $publication | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $evidencePath -Encoding utf8
  Write-Host '[success] OSAA chat two-component local edge publication completed'
  Write-Host "[version] $releaseTag"
  Write-Host "[console] ${consoleRepository}@${consoleDigest}"
  Write-Host "[gateway] ${gatewayRepository}@${gatewayDigest}"
  Write-Host "[evidence] $evidencePath"
  Write-Output $evidencePath
} finally {
  if (Test-Path -LiteralPath $checkout) { & git -C $repoRoot worktree remove --force $checkout 2>$null | Out-Null }
  $resolvedBuildRoot = [IO.Path]::GetFullPath($buildRoot)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if ($resolvedBuildRoot.StartsWith($tempPrefix,[StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path $resolvedBuildRoot -Leaf) -like 'opensphere-osaa-chat-*' -and
      (Test-Path -LiteralPath $resolvedBuildRoot)) {
    Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force
  }
}
