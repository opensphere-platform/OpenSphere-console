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
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) { return $null }
  $line = $output | Where-Object { $_ -match '^Digest:\s+(sha256:[0-9a-f]{64})$' } | Select-Object -First 1
  if (-not $line) { throw "Could not parse registry digest for $Reference" }
  return ([regex]::Match($line, 'sha256:[0-9a-f]{64}')).Value
}

function Set-RemoteTag {
  param(
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$Digest,
    [Parameter(Mandatory)][string]$Tag,
    [switch]$Immutable
  )
  $reference = "${Repository}:$Tag"
  $existing = Get-RemoteDigest -Reference $reference
  if ($Immutable -and $existing -and $existing -ne $Digest) {
    throw "Immutable tag collision: $reference is $existing, expected $Digest"
  }
  if ($existing -ne $Digest) {
    Invoke-Checked docker buildx imagetools create --prefer-index=false --tag $reference "${Repository}@${Digest}" | Out-Null
  }
  if ((Get-RemoteDigest -Reference $reference) -ne $Digest) {
    throw "Tag verification failed: $reference"
  }
}

if ($env:OS -ne 'Windows_NT') { throw 'Backend edge publishing requires Windows.' }
if (((Invoke-Checked kubectl config current-context) -join '').Trim() -ne 'docker-desktop') {
  throw 'Backend edge publishing requires Kubernetes context docker-desktop.'
}
$dockerOs = ((Invoke-Checked docker info --format '{{.OSType}}') -join '').Trim().ToLowerInvariant()
$dockerArch = ((Invoke-Checked docker info --format '{{.Architecture}}') -join '').Trim().ToLowerInvariant()
if ($dockerOs -ne 'linux' -or $dockerArch -notin @('amd64', 'x86_64')) {
  throw "Backend edge publishing requires Linux containers on amd64; received $dockerOs/$dockerArch"
}
if ($Registry -cne 'ghcr.io/opensphere-platform') { throw 'Registry must be the canonical OpenSphere GHCR namespace.' }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$origin = ((Invoke-Checked git -C $repoRoot remote get-url origin) -join '').TrimEnd('/')
if ($origin -cne 'https://github.com/opensphere-platform/OpenSphere-console.git') {
  throw 'Console origin is not canonical.'
}
if (((Invoke-Checked git -C $repoRoot branch --show-current) -join '').Trim() -cne 'main') {
  throw 'Backend edge publishing runs only from canonical main.'
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
if ([string]$installedLock.source -cne 'https://github.com/opensphere-platform/OpenSphere-console') {
  throw 'Installed release source is not the canonical Console repository.'
}
$baseRevision = [string]$installedLock.components.backend.sourceRevision
if ($baseRevision -notmatch '^[a-f0-9]{40}$') { throw 'Installed backend source revision is not canonical.' }
Invoke-Checked git -C $repoRoot fetch --no-tags origin $baseRevision | Out-Null
Invoke-Checked git -C $repoRoot cat-file -e "${baseRevision}^{commit}" | Out-Null
$changedPaths = @(Invoke-Checked git -C $repoRoot diff --name-only $baseRevision $sourceRevision | Where-Object { $_ })
if (-not $changedPaths.Count) { throw 'Backend publication has no source delta.' }
$backendPaths = @($changedPaths | Where-Object {
  $_ -like 'backend/opensphere-console-backend/*' -or $_ -eq 'scripts/Publish-LocalEdgeBackendBridge.ps1' -or
  $_ -eq 'scripts/backend-bridge-publisher.test.mjs'
})
if (-not $backendPaths.Count) { throw 'Backend publication delta does not contain a backend or publisher change.' }

$setupRevision = (Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'backend\opensphere-console-backend\setup-source.lock')).Trim()
if ($setupRevision -notmatch '^[a-f0-9]{40}$') { throw 'setup-source.lock is not canonical.' }
$epoch = [long](((Invoke-Checked git -C $repoRoot show -s --format=%ct $sourceRevision) -join '').Trim())
$releaseTag = [DateTimeOffset]::FromUnixTimeSeconds($epoch).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyyMMddHHmm')
$repository = "$Registry/opensphere-console-backend"
$localTag = "local-$($sourceRevision.Substring(0,12))"

$platformRoot = Split-Path $repoRoot -Parent
$outputRootBase = Join-Path $platformRoot ".codex-tmp\backend-edge-$($sourceRevision.Substring(0,12))"
$outputRoot = if (Test-Path -LiteralPath $outputRootBase) {
  "$outputRootBase-retry-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))"
} else { $outputRootBase }
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) "opensphere-backend-edge-$([Guid]::NewGuid().ToString('N'))"
$consoleCheckout = Join-Path $buildRoot 'OpenSphere-console'
$setupCheckout = Join-Path $buildRoot 'OpenSphere-Setup-CLI'
$metadataFile = Join-Path $buildRoot 'metadata.json'
New-Item -ItemType Directory -Path $buildRoot, $outputRoot | Out-Null

try {
  Invoke-Checked git -C $repoRoot worktree add --detach $consoleCheckout $sourceRevision | Out-Null
  Invoke-Checked git init $setupCheckout | Out-Null
  Invoke-Checked git -C $setupCheckout remote add origin https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git | Out-Null
  Invoke-Checked git -C $setupCheckout fetch --depth 1 origin $setupRevision | Out-Null
  Invoke-Checked git -C $setupCheckout checkout --detach $setupRevision | Out-Null
  if (((Invoke-Checked git -C $setupCheckout rev-parse HEAD) -join '').Trim() -cne $setupRevision) {
    throw 'Detached Setup source differs from setup-source.lock.'
  }

  Invoke-Checked node --test `
    (Join-Path $consoleCheckout 'backend\opensphere-console-backend\platform-release.test.js') `
    (Join-Path $consoleCheckout 'scripts\backend-bridge-publisher.test.mjs') | Out-Null

  if (-not $UseExistingRegistryLogin) {
    $token = ((Invoke-Checked gh auth token) -join '').Trim()
    try {
      $token | docker login ghcr.io -u opensphere-platform --password-stdin | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'GHCR login failed.' }
    } finally { $token = $null }
  }

  $arguments = @(
    'buildx','build','--platform','linux/amd64','--push','--provenance=mode=max',
    '--metadata-file',$metadataFile,'--tag',"${repository}:$localTag",
    '--label','io.opensphere.channel=edge',
    '--label',"io.opensphere.source-revision=$sourceRevision",
    '--label',"io.opensphere.release-tag=$releaseTag",
    '--label',"org.opencontainers.image.version=$releaseTag",
    '--label','org.opencontainers.image.source=https://github.com/opensphere-platform/OpenSphere-console',
    '--label','opensphere.io/build-authority=localhost',
    '--label','opensphere.io/release-class=pre-ga',
    '--label','opensphere.io/ga-eligible=false',
    '--build-context',"setup-cli=$setupCheckout",
    '--build-arg',"SETUP_SOURCE_REVISION=$setupRevision",
    '--file',(Join-Path $consoleCheckout 'backend\opensphere-console-backend\Dockerfile'),
    (Join-Path $consoleCheckout 'backend')
  )
  Invoke-Checked docker @arguments | Out-Null
  $digest = [string](Get-Content -Raw -LiteralPath $metadataFile | ConvertFrom-Json).'containerimage.digest'
  if ($digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Backend build did not produce an exact digest.' }

  Set-RemoteTag -Repository $repository -Digest $digest -Tag $releaseTag -Immutable
  Set-RemoteTag -Repository $repository -Digest $digest -Tag edge

  $publication = [ordered]@{
    apiVersion = 'release.opensphere.io/v1alpha1'
    kind = 'OpenSphereEdgeComponentPublication'
    publicationScope = 'ComponentSet'
    channel = 'edge'
    status = 'Active'
    requestIntent = 'Publish the Console Backend installed-lock bridge required for the one-way legacy agent identity to OSAA cutover.'
    changedPaths = @($changedPaths | Sort-Object -Unique)
    affectedImages = @($repository)
    releaseScope = 'component'
    fullReleaseJustification = $null
    releaseTag = $releaseTag
    immutableTag = $releaseTag
    source = 'https://github.com/opensphere-platform/OpenSphere-console'
    sourceRevision = $sourceRevision
    setupSourceRevision = $setupRevision
    buildAuthority = 'localhost'
    releaseClass = 'pre-ga'
    gaEligible = $false
    supportedPlatforms = @('linux/amd64')
    components = [ordered]@{
      backend = [ordered]@{
        repository = 'opensphere-console-backend'
        image = "${repository}@${digest}"
        sourceRevision = $sourceRevision
      }
    }
    verification = [ordered]@{
      backendBridgeTests = 'PASS'
      exactDigest = $digest
      integratedConsoleImagesChanged = $false
    }
  }
  $evidencePath = Join-Path $outputRoot 'opensphere-backend-bridge-publication.json'
  $publication | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $evidencePath -Encoding utf8
  Write-Host '[success] Backend-only local edge publication completed'
  Write-Host "[version] $releaseTag"
  Write-Host "[digest] ${repository}@${digest}"
  Write-Host "[evidence] $evidencePath"
  Write-Output $evidencePath
} finally {
  if (Test-Path -LiteralPath $consoleCheckout) {
    & git -C $repoRoot worktree remove --force $consoleCheckout 2>$null | Out-Null
  }
  $resolvedBuildRoot = [IO.Path]::GetFullPath($buildRoot)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if ($resolvedBuildRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path $resolvedBuildRoot -Leaf) -like 'opensphere-backend-edge-*' -and
      (Test-Path -LiteralPath $resolvedBuildRoot)) {
    Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force
  }
}
