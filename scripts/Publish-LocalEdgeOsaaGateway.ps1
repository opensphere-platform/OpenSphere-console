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
  $result = & $program @arguments
  if ($LASTEXITCODE -ne 0) { throw "$program failed with exit code $LASTEXITCODE" }
  return $result
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

function Set-RemoteTag {
  param([string]$Repository,[string]$Digest,[string]$Tag,[switch]$Immutable)
  $reference = "${Repository}:$Tag"
  $existing = Get-RemoteDigest $reference
  if ($Immutable -and $existing -and $existing -ne $Digest) {
    throw "Immutable tag collision: $reference is $existing, expected $Digest"
  }
  if ($existing -ne $Digest) {
    Invoke-Checked docker buildx imagetools create --prefer-index=false --tag $reference "${Repository}@${Digest}" | Out-Null
  }
  if ((Get-RemoteDigest $reference) -ne $Digest) { throw "Tag verification failed: $reference" }
}

if ($env:OS -ne 'Windows_NT') { throw 'OSAA Gateway edge publishing requires Windows.' }
if (((Invoke-Checked kubectl config current-context) -join '').Trim() -ne 'docker-desktop') {
  throw 'OSAA Gateway edge publishing requires Kubernetes context docker-desktop.'
}
$dockerOs = ((Invoke-Checked docker info --format '{{.OSType}}') -join '').Trim().ToLowerInvariant()
$dockerArch = ((Invoke-Checked docker info --format '{{.Architecture}}') -join '').Trim().ToLowerInvariant()
if ($dockerOs -ne 'linux' -or $dockerArch -notin @('amd64','x86_64')) {
  throw "OSAA Gateway edge publishing requires Linux containers on amd64; received $dockerOs/$dockerArch"
}
if ($Registry -cne 'ghcr.io/opensphere-platform') { throw 'Registry must be the canonical OpenSphere GHCR namespace.' }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (((Invoke-Checked git -C $repoRoot remote get-url origin) -join '').TrimEnd('/') -cne
    'https://github.com/opensphere-platform/OpenSphere-console.git') { throw 'Console origin is not canonical.' }
if (((Invoke-Checked git -C $repoRoot branch --show-current) -join '').Trim() -cne 'main') {
  throw 'OSAA Gateway publishing runs only from canonical main.'
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

$lockRaw = (Invoke-Checked kubectl -n opensphere-console get configmap opensphere-installation-lock -o 'jsonpath={.data.release\.json}') -join ''
$installedLock = $lockRaw | ConvertFrom-Json
$installedGateway = $installedLock.components.PSObject.Properties['osaaGateway']
if (-not $installedGateway -or
    [string]$installedGateway.Value.repository -cne 'opensphere-console-osaa-gateway' -or
    [string]$installedGateway.Value.image -notmatch '^ghcr[.]io/opensphere-platform/opensphere-console-osaa-gateway@sha256:[a-f0-9]{64}$') {
  throw 'Installed release does not contain the canonical OSAA Gateway component.'
}
$baseRevision = [string]$installedGateway.Value.sourceRevision
if ($baseRevision -notmatch '^[a-f0-9]{40}$') { throw 'Installed OSAA Gateway source revision is invalid.' }
Invoke-Checked git -C $repoRoot fetch --no-tags origin $baseRevision | Out-Null
Invoke-Checked git -C $repoRoot merge-base --is-ancestor $baseRevision $sourceRevision | Out-Null
$changedPaths = @(Invoke-Checked git -C $repoRoot diff --name-only $baseRevision $sourceRevision)
$allowedPublisherPaths = @(
  'scripts/Publish-LocalEdgeOsaaGateway.ps1',
  'scripts/osaa-gateway-publisher.test.mjs'
)
$unsupported = @($changedPaths | Where-Object {
  $_ -notlike 'backend/opensphere-console-osaa-gateway/*' -and $_ -notin $allowedPublisherPaths
})
if (-not $changedPaths.Count -or $unsupported.Count) {
  throw "OSAA Gateway component scope contains unsupported paths: $($unsupported -join ', ')"
}

$epoch = [long](((Invoke-Checked git -C $repoRoot show -s --format=%ct $sourceRevision) -join '').Trim())
$releaseTag = [DateTimeOffset]::FromUnixTimeSeconds($epoch).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyyMMddHHmm')
$localTag = "local-$($sourceRevision.Substring(0,12))"
$repository = "$Registry/opensphere-console-osaa-gateway"
$outputBase = Join-Path (Split-Path $repoRoot -Parent) ".codex-tmp\osaa-gateway-edge-$($sourceRevision.Substring(0,12))"
$outputRoot = if (Test-Path -LiteralPath $outputBase) {
  "$outputBase-retry-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))"
} else { $outputBase }
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) "opensphere-osaa-gateway-$([Guid]::NewGuid().ToString('N'))"
$checkout = Join-Path $buildRoot 'OpenSphere-console'
$metadataFile = Join-Path $buildRoot 'metadata.json'
New-Item -ItemType Directory -Path $buildRoot,$outputRoot | Out-Null

try {
  Invoke-Checked git -C $repoRoot worktree add --detach $checkout $sourceRevision | Out-Null
  Invoke-Checked node --test `
    (Join-Path $checkout 'backend\opensphere-console-osaa-gateway\conversation-store.test.js') `
    (Join-Path $checkout 'backend\opensphere-console-osaa-gateway\extension-presentation.test.js') `
    (Join-Path $checkout 'scripts\osaa-gateway-publisher.test.mjs') | Out-Null

  if (-not $UseExistingRegistryLogin) {
    $token = ((Invoke-Checked gh auth token) -join '').Trim()
    try {
      $token | docker login ghcr.io -u opensphere-platform --password-stdin | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'GHCR login failed.' }
    } finally { $token = $null }
  }

  Invoke-Checked docker buildx build --platform linux/amd64 --push --provenance=mode=max `
    --metadata-file $metadataFile --tag "${repository}:$localTag" `
    --label io.opensphere.channel=edge `
    --label "io.opensphere.source-revision=$sourceRevision" `
    --label "io.opensphere.release-tag=$releaseTag" `
    --label "org.opencontainers.image.version=$releaseTag" `
    --label org.opencontainers.image.source=https://github.com/opensphere-platform/OpenSphere-console `
    --label opensphere.io/build-authority=localhost `
    --label opensphere.io/release-class=pre-ga `
    --label opensphere.io/ga-eligible=false `
    --file (Join-Path $checkout 'backend\opensphere-console-osaa-gateway\Dockerfile') `
    (Join-Path $checkout 'backend\opensphere-console-osaa-gateway') | Out-Null
  $digest = [string](Get-Content -Raw -LiteralPath $metadataFile | ConvertFrom-Json).'containerimage.digest'
  if ($digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'OSAA Gateway build did not produce an exact digest.' }
  Set-RemoteTag -Repository $repository -Digest $digest -Tag $releaseTag -Immutable
  Set-RemoteTag -Repository $repository -Digest $digest -Tag edge

  $publication = [ordered]@{
    apiVersion='release.opensphere.io/v1alpha1'; kind='OpenSphereEdgeComponentPublication'
    publicationScope='ComponentSet'; channel='edge'; status='Active'
    requestIntent='Publish only the OSAA Gateway runtime packaging correction.'
    changedPaths=@($changedPaths | Sort-Object -Unique); affectedImages=@($repository)
    releaseScope='component'; fullReleaseJustification=$null; releaseTag=$releaseTag; immutableTag=$releaseTag
    source='https://github.com/opensphere-platform/OpenSphere-console'; sourceRevision=$sourceRevision
    buildAuthority='localhost'; releaseClass='pre-ga'; gaEligible=$false; supportedPlatforms=@('linux/amd64')
    components=[ordered]@{ osaaGateway=[ordered]@{
      repository='opensphere-console-osaa-gateway'; image="${repository}@${digest}"; sourceRevision=$sourceRevision
    }}
    verification=[ordered]@{ conversationStorePackaging='PASS'; exactAffectedComponentSet=@('osaaGateway'); unchangedComponentBuildCount=0 }
  }
  $evidencePath = Join-Path $outputRoot 'opensphere-osaa-gateway-publication.json'
  $publication | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $evidencePath -Encoding utf8
  Write-Host '[success] OSAA Gateway-only local edge publication completed'
  Write-Host "[version] $releaseTag"
  Write-Host "[digest] ${repository}@${digest}"
  Write-Host "[evidence] $evidencePath"
  Write-Output $evidencePath
} finally {
  if (Test-Path -LiteralPath $checkout) { & git -C $repoRoot worktree remove --force $checkout 2>$null | Out-Null }
  $resolvedBuildRoot = [IO.Path]::GetFullPath($buildRoot)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if ($resolvedBuildRoot.StartsWith($tempPrefix,[StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path $resolvedBuildRoot -Leaf) -like 'opensphere-osaa-gateway-*' -and
      (Test-Path -LiteralPath $resolvedBuildRoot)) {
    Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force
  }
}
