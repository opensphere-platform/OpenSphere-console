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

if ($env:OS -ne 'Windows_NT') { throw 'OSAA cutover edge publishing requires Windows.' }
if (((Invoke-Checked kubectl config current-context) -join '').Trim() -ne 'docker-desktop') {
  throw 'OSAA cutover edge publishing requires Kubernetes context docker-desktop.'
}
$dockerOs = ((Invoke-Checked docker info --format '{{.OSType}}') -join '').Trim().ToLowerInvariant()
$dockerArch = ((Invoke-Checked docker info --format '{{.Architecture}}') -join '').Trim().ToLowerInvariant()
if ($dockerOs -ne 'linux' -or $dockerArch -notin @('amd64','x86_64')) {
  throw "OSAA cutover edge publishing requires Linux containers on amd64; received $dockerOs/$dockerArch"
}
if ($Registry -cne 'ghcr.io/opensphere-platform') { throw 'Registry must be the canonical OpenSphere GHCR namespace.' }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (((Invoke-Checked git -C $repoRoot remote get-url origin) -join '').TrimEnd('/') -cne
    'https://github.com/opensphere-platform/OpenSphere-console.git') { throw 'Console origin is not canonical.' }
if (((Invoke-Checked git -C $repoRoot branch --show-current) -join '').Trim() -cne 'main') {
  throw 'OSAA cutover publishing runs only from canonical main.'
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
$installedKeys = @($installedLock.components.PSObject.Properties.Name | Sort-Object)
foreach ($required in @('backend','console','dupaController','recovery','supabasePostgres')) {
  if ($required -notin $installedKeys) { throw "Installed lock is not the exact pre-cutover legacy agent state: missing $required" }
}
if ('osaaGateway' -in $installedKeys -or 'osaaGovernedAdapter' -in $installedKeys) {
  throw 'Installed lock already contains a canonical OSAA identity.'
}
$backendDeployment = ((Invoke-Checked kubectl -n opensphere-console get deployment opensphere-console-backend -o json) -join "`n") | ConvertFrom-Json
$backendContainer = @($backendDeployment.spec.template.spec.containers | Where-Object { [string]$_.name -eq 'api' })
if ($backendContainer.Count -ne 1 -or [int]$backendDeployment.status.observedGeneration -ne [int]$backendDeployment.metadata.generation -or
    [int]$backendDeployment.status.readyReplicas -ne [int]$backendDeployment.spec.replicas) {
  throw 'The live Console Backend bridge must have one exact api container and all replicas Ready.'
}
$bridgeImage = [string]$backendContainer[0].image
if ($bridgeImage -notmatch '^ghcr[.]io/opensphere-platform/opensphere-console-backend@sha256:[a-f0-9]{64}$') {
  throw 'The live Console Backend bridge image is not an exact canonical digest.'
}
$bridgeMetadataRaw = Invoke-Checked docker buildx imagetools inspect --format '{{json .Image}}' $bridgeImage
$bridgeMetadata = (($bridgeMetadataRaw -join "`n") | ConvertFrom-Json)
$bridgeRevision = [string]$bridgeMetadata.config.Labels.'io.opensphere.source-revision'
if ($bridgeRevision -notmatch '^[a-f0-9]{40}$') { throw 'The installed Backend bridge revision is invalid.' }
Invoke-Checked git -C $repoRoot fetch --no-tags origin $bridgeRevision | Out-Null
$minimumBridgeRevision = '125922f96634572763c040924c8c4f3fe72af167'
Invoke-Checked git -C $repoRoot merge-base --is-ancestor $minimumBridgeRevision $bridgeRevision | Out-Null
Invoke-Checked git -C $repoRoot merge-base --is-ancestor $bridgeRevision $sourceRevision | Out-Null

$legacyGateway = @($installedLock.components.PSObject.Properties | Where-Object {
  [string]$_.Value.repository -like 'opensphere-console-*-gateway' -and [string]$_.Value.repository -notlike '*-osaa-*'
})
$legacyAdapter = @($installedLock.components.PSObject.Properties | Where-Object {
  [string]$_.Value.repository -like 'opensphere-*-governed-adapter' -and [string]$_.Value.repository -notlike '*-osaa-*'
})
if ($legacyGateway.Count -ne 1 -or $legacyAdapter.Count -ne 1) {
  throw 'Installed lock does not contain one exact legacy gateway and governed adapter.'
}

$profile = @(
  [ordered]@{ Key='console'; BaseRevision=[string]$installedLock.components.console.sourceRevision; Image='opensphere-console'; Context='OpenSphere-console'; File='OpenSphere-console\Dockerfile'; Sdk=$false },
  [ordered]@{ Key='dupaController'; BaseRevision=[string]$installedLock.components.dupaController.sourceRevision; Image='opensphere-console-dupa-controller'; Context='OpenSphere-console\backend\dupa-control'; File='OpenSphere-console\backend\dupa-control\Dockerfile'; Sdk=$false },
  [ordered]@{ Key='osaaGateway'; BaseRevision=[string]$legacyGateway[0].Value.sourceRevision; Image='opensphere-console-osaa-gateway'; Context='OpenSphere-console\apps\osaa-gateway'; File='OpenSphere-console\apps\osaa-gateway\Dockerfile'; Sdk=$false },
  [ordered]@{ Key='osaaGovernedAdapter'; BaseRevision=[string]$legacyAdapter[0].Value.sourceRevision; Image='opensphere-osaa-governed-adapter'; Context='OpenSphere-console\backend\osaa-governed-adapter'; File='OpenSphere-console\backend\osaa-governed-adapter\Dockerfile'; Sdk=$false },
  [ordered]@{ Key='recovery'; BaseRevision=[string]$installedLock.components.recovery.sourceRevision; Image='opensphere-console-recovery'; Context='OpenSphere-console\apps\recovery-owner'; File='OpenSphere-console\apps\recovery-owner\Dockerfile'; Sdk=$false },
  [ordered]@{ Key='supabasePostgres'; BaseRevision=[string]$installedLock.components.supabasePostgres.sourceRevision; Image='opensphere-console-supabase-postgres'; Context='OpenSphere-console\backend\supabase\images\postgres'; File='OpenSphere-console\backend\supabase\images\postgres\Dockerfile'; Sdk=$false }
)

$changedPathSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($item in $profile) {
  $baseRevision = [string]$item.BaseRevision
  if ($baseRevision -notmatch '^[a-f0-9]{40}$') { throw "Installed $($item.Key) source revision is invalid." }
  Invoke-Checked git -C $repoRoot fetch --no-tags origin $baseRevision | Out-Null
  Invoke-Checked git -C $repoRoot cat-file -e "${baseRevision}^{commit}" | Out-Null
  foreach ($path in @(Invoke-Checked git -C $repoRoot diff --name-only $baseRevision $sourceRevision)) {
    if ($path) { [void]$changedPathSet.Add([string]$path) }
  }
}
$changedPaths = @($changedPathSet | Sort-Object)
if (-not $changedPaths.Count) { throw 'OSAA cutover publication has no source delta.' }

$epoch = [long](((Invoke-Checked git -C $repoRoot show -s --format=%ct $sourceRevision) -join '').Trim())
$releaseTag = [DateTimeOffset]::FromUnixTimeSeconds($epoch).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyyMMddHHmm')
$localTag = "local-$($sourceRevision.Substring(0,12))"

$platformRoot = Split-Path $repoRoot -Parent
$outputBase = Join-Path $platformRoot ".codex-tmp\osaa-cutover-edge-$($sourceRevision.Substring(0,12))"
$outputRoot = if (Test-Path -LiteralPath $outputBase) {
  "$outputBase-retry-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))"
} else { $outputBase }
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) "opensphere-osaa-cutover-$([Guid]::NewGuid().ToString('N'))"
$consoleCheckout = Join-Path $buildRoot 'OpenSphere-console'
$metadataRoot = Join-Path $buildRoot 'metadata'
New-Item -ItemType Directory -Path $buildRoot,$metadataRoot,$outputRoot | Out-Null
$digests = [ordered]@{}

try {
  Invoke-Checked git -C $repoRoot worktree add --detach $consoleCheckout $sourceRevision | Out-Null

  Invoke-Checked node --test `
    (Join-Path $consoleCheckout 'scripts\osaa-canonical-identity.test.mjs') `
    (Join-Path $consoleCheckout 'scripts\osaa-cutover-publisher.test.mjs') `
    (Join-Path $consoleCheckout 'apps\osaa-gateway\conversation-store.test.js') | Out-Null

  if (-not $UseExistingRegistryLogin) {
    $token = ((Invoke-Checked gh auth token) -join '').Trim()
    try {
      $token | docker login ghcr.io -u opensphere-platform --password-stdin | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'GHCR login failed.' }
    } finally { $token = $null }
  }

  foreach ($item in $profile) {
    $repository = "$Registry/$($item.Image)"
    $metadataFile = Join-Path $metadataRoot "$($item.Key).json"
    $context = Join-Path $buildRoot $item.Context
    $dockerfile = Join-Path $buildRoot $item.File
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
      '--file',$dockerfile
    )
    $arguments += $context
    Invoke-Checked docker @arguments | Out-Null
    $digest = [string](Get-Content -Raw -LiteralPath $metadataFile | ConvertFrom-Json).'containerimage.digest'
    if ($digest -notmatch '^sha256:[a-f0-9]{64}$') { throw "$($item.Key) build did not produce an exact digest." }
    $digests[$item.Key] = $digest
  }

  foreach ($item in $profile) {
    Set-RemoteTag -Repository "$Registry/$($item.Image)" -Digest $digests[$item.Key] -Tag $releaseTag -Immutable
  }
  foreach ($item in $profile) {
    Set-RemoteTag -Repository "$Registry/$($item.Image)" -Digest $digests[$item.Key] -Tag edge
  }

  $componentEvidence = [ordered]@{}
  foreach ($item in $profile) {
    $repository = "$Registry/$($item.Image)"
    $componentEvidence[$item.Key] = [ordered]@{
      repository = $item.Image
      image = "${repository}@$($digests[$item.Key])"
      sourceRevision = $sourceRevision
    }
  }
  $publication = [ordered]@{
    apiVersion='release.opensphere.io/v1alpha1'
    kind='OpenSphereEdgeComponentPublication'
    publicationScope='ComponentSet'
    channel='edge'
    status='Active'
    requestIntent='Publish only the six components required for the one-way legacy agent identity to OSAA cutover and durable R2D2 conversations.'
    changedPaths=$changedPaths
    affectedImages=@($profile | ForEach-Object { "$Registry/$($_.Image)" })
    releaseScope='component'
    fullReleaseJustification=$null
    releaseTag=$releaseTag
    immutableTag=$releaseTag
    source='https://github.com/opensphere-platform/OpenSphere-console'
    sourceRevision=$sourceRevision
    sdkSourceRevision=$sdkRevision
    buildAuthority='localhost'
    releaseClass='pre-ga'
    gaEligible=$false
    supportedPlatforms=@('linux/amd64')
    components=$componentEvidence
    verification=[ordered]@{
      canonicalOsaaIdentity='PASS'
      durableConversationStore='PASS'
      exactAffectedComponentSet=@($profile.Key)
      unchangedComponentBuildCount=0
    }
  }
  $evidencePath = Join-Path $outputRoot 'opensphere-osaa-cutover-publication.json'
  $publication | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $evidencePath -Encoding utf8
  Write-Host '[success] OSAA cutover component publication completed'
  Write-Host "[version] $releaseTag"
  Write-Host "[components] $($profile.Key -join ', ')"
  Write-Host "[evidence] $evidencePath"
  Write-Output $evidencePath
} finally {
  if (Test-Path -LiteralPath $consoleCheckout) {
    & git -C $repoRoot worktree remove --force $consoleCheckout 2>$null | Out-Null
  }
  $resolvedBuildRoot = [IO.Path]::GetFullPath($buildRoot)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if ($resolvedBuildRoot.StartsWith($tempPrefix,[StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path $resolvedBuildRoot -Leaf) -like 'opensphere-osaa-cutover-*' -and
      (Test-Path -LiteralPath $resolvedBuildRoot)) {
    Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force
  }
}
