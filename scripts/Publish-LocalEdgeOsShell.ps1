#requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BasePublicationEvidence,
  [Parameter(Mandatory)][string]$PreviousBackendPublicationEvidence,
  [Parameter(Mandatory)][string]$ConsolePublicationEvidence,
  [Parameter(Mandatory)][string]$PreviousControlPublicationEvidence,
  [string]$SourceRevision = '',
  [string]$SetupSourcePath = '',
  [switch]$UseExistingRegistryLogin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$registry = 'ghcr.io/opensphere-platform'
$publisher = Join-Path $PSScriptRoot 'Publish-LocalEdge.ps1'
$boundaryVerifier = Join-Path $PSScriptRoot 'os-shell-runtime-override-boundary.mjs'

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
  if ($exitCode -ne 0) { throw "Image reference is not readable from GHCR: $Reference" }
  $line = $output | Where-Object { $_ -match '^Digest:\s+(sha256:[0-9a-f]{64})$' } | Select-Object -First 1
  if (-not $line) { throw "Could not parse registry digest for $Reference" }
  return ([regex]::Match($line, 'sha256:[0-9a-f]{64}')).Value
}

function Get-CanonicalTextSha256 {
  param([Parameter(Mandatory)][string]$Path)
  $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return 'sha256:' + ([BitConverter]::ToString(
      $sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($text))
    )).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Read-Publication {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string[]]$ExpectedComponents,
    [Parameter(Mandatory)][string]$Purpose
  )
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $document = Get-Content -Raw -LiteralPath $resolved | ConvertFrom-Json
  if ([string]$document.apiVersion -ne 'release.opensphere.io/v1alpha1' -or
      [string]$document.kind -ne 'OpenSphereEdgeComponentPublication' -or
      [string]$document.publicationScope -ne 'ComponentSet' -or
      [string]$document.channel -ne 'edge' -or
      [string]$document.status -ne 'Active' -or
      [string]$document.source -ne 'https://github.com/opensphere-platform/OpenSphere-console' -or
      [string]$document.sourceRevision -notmatch '^[a-f0-9]{40}$' -or
      [string]$document.buildAuthority -ne 'localhost' -or
      [bool]$document.gaEligible) {
    throw "$Purpose is not canonical local-edge component publication evidence"
  }
  $actual = @($document.components.PSObject.Properties.Name | Sort-Object)
  $expected = @($ExpectedComponents | Sort-Object)
  if (($actual -join ',') -ne ($expected -join ',')) {
    throw "$Purpose components are not the exact closed set: $($actual -join ',')"
  }
  return [ordered]@{ Path = $resolved; Document = $document }
}

function Get-ComponentDigest {
  param([Parameter(Mandatory)]$Publication, [Parameter(Mandatory)][string]$Key)
  $image = [string]$Publication.components.$Key.image
  $match = [regex]::Match($image, '@(sha256:[a-f0-9]{64})$')
  if (-not $match.Success) { throw "$Key publication image is not digest pinned" }
  return $match.Groups[1].Value
}

function Get-LiveDeploymentDigest {
  param(
    [Parameter(Mandatory)][string]$Deployment,
    [Parameter(Mandatory)][string]$Repository
  )
  $image = (& kubectl --context docker-desktop -n opensphere-console get "deployment/$Deployment" `
    -o 'jsonpath={.spec.template.spec.containers[0].image}').Trim()
  if ($LASTEXITCODE -ne 0) { throw "Could not read live deployment $Deployment" }
  $match = [regex]::Match($image, "^$([regex]::Escape($Repository))@(sha256:[a-f0-9]{64})$")
  if (-not $match.Success) { throw "Live deployment $Deployment is not pinned to the canonical repository digest" }
  return $match.Groups[1].Value
}

if (-not $SourceRevision) { $SourceRevision = (& git -C $repoRoot rev-parse HEAD).Trim() }
if ($SourceRevision -notmatch '^[a-f0-9]{40}$' -or $SourceRevision -ne (& git -C $repoRoot rev-parse HEAD).Trim()) {
  throw 'SourceRevision must be the clean current Console HEAD'
}
if (& git -C $repoRoot status --short) { throw 'The Console worktree must be clean before OS Shell publication' }
if ((& git -C $repoRoot remote get-url origin).Trim() -ne 'https://github.com/opensphere-platform/OpenSphere-console.git') {
  throw 'OS Shell publication requires the canonical GitHub Console origin'
}
& git -C $repoRoot fetch --quiet --prune origin
if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the canonical Console origin' }
$upstream = (& git -C $repoRoot rev-parse --abbrev-ref --symbolic-full-name '@{u}').Trim()
if ((& git -C $repoRoot rev-parse $upstream).Trim() -ne $SourceRevision) {
  throw 'OS Shell publication HEAD must equal its pushed canonical upstream revision'
}

$base = Read-Publication -Path $BasePublicationEvidence `
  -ExpectedComponents @('backend', 'cliArtifacts', 'console', 'osShellControl', 'osShellRuntime') -Purpose 'base publication'
$previousBackend = Read-Publication -Path $PreviousBackendPublicationEvidence `
  -ExpectedComponents @('backend') -Purpose 'previous Backend publication'
$console = Read-Publication -Path $ConsolePublicationEvidence `
  -ExpectedComponents @('console') -Purpose 'Console publication'
$previousControl = Read-Publication -Path $PreviousControlPublicationEvidence `
  -ExpectedComponents @('osShellControl') -Purpose 'previous Control publication'

foreach ($publication in @($previousBackend.Document, $console.Document, $previousControl.Document)) {
  & git -C $repoRoot merge-base --is-ancestor ([string]$base.Document.sourceRevision) ([string]$publication.sourceRevision)
  if ($LASTEXITCODE -ne 0) { throw 'A component publication is not descended from the base OS Shell publication' }
}
foreach ($revision in @([string]$previousBackend.Document.sourceRevision, [string]$previousControl.Document.sourceRevision)) {
  & git -C $repoRoot merge-base --is-ancestor $revision $SourceRevision
  if ($LASTEXITCODE -ne 0) { throw "Target source does not descend from deployed component revision $revision" }
}

$boundaryOutput = & node $boundaryVerifier --repository $repoRoot --base ([string]$base.Document.sourceRevision) `
  --backend $SourceRevision --console ([string]$console.Document.sourceRevision) --control $SourceRevision --head $SourceRevision
if ($LASTEXITCODE -ne 0) { throw 'OS Shell two-component source boundary verification failed' }
$boundary = ($boundaryOutput -join "`n") | ConvertFrom-Json
if (($boundary.backendPaths -join ',') -ne 'apps/os-shell-control/authority/os-shell-admission.js,apps/os-shell-control/authority/os-shell-admission.test.js,backend/opensphere-console-backend/Dockerfile,backend/opensphere-console-backend/local-edge-automation-token.test.js,backend/opensphere-console-backend/server.js' -or
    @($boundary.controlPaths).Count -ne 4) {
  throw 'OS Shell source boundary did not attribute the exact Backend and Control inputs'
}

$previousBackendDigest = Get-ComponentDigest -Publication $previousBackend.Document -Key 'backend'
$previousControlDigest = Get-ComponentDigest -Publication $previousControl.Document -Key 'osShellControl'
if ((& kubectl config current-context).Trim() -ne 'docker-desktop') {
  throw 'OS Shell edge publication is restricted to the docker-desktop context'
}
$backendRepository = "$registry/opensphere-console-backend"
$controlRepository = "$registry/opensphere-console-os-shell-control"
if ((Get-LiveDeploymentDigest -Deployment 'opensphere-console-backend' -Repository $backendRepository) -ne $previousBackendDigest) {
  throw 'Live Backend differs from the supplied deployed publication evidence'
}
foreach ($deployment in @('opensphere-shell-api', 'opensphere-shell-gateway', 'opensphere-shell-reconciler')) {
  if ((Get-LiveDeploymentDigest -Deployment $deployment -Repository $controlRepository) -ne $previousControlDigest) {
    throw "Live Control deployment $deployment differs from the supplied deployed publication evidence"
  }
}
$backendEdgeBefore = Get-RemoteDigest -Reference "${backendRepository}:edge"
$controlEdgeBefore = Get-RemoteDigest -Reference "${controlRepository}:edge"

$targetMigrationPath = Join-Path $repoRoot 'backend\supabase\migrations\manifest.json'
$targetMigration = Get-Content -Raw -LiteralPath $targetMigrationPath | ConvertFrom-Json
$baseMigration = $base.Document.artifacts.supabaseMigrationManifest
if ((Get-CanonicalTextSha256 -Path $targetMigrationPath) -ne [string]$baseMigration.sha256 -or
    [string]$targetMigration.setDigest -ne [string]$baseMigration.setDigest -or
    [string]$targetMigration.latestMigrationId -ne [string]$baseMigration.latestMigrationId) {
  throw 'Target source changes the deployed OS Shell migration lineage'
}

$scopeDeclaration = [ordered]@{
  requestIntent = 'deploy'
  comparisonBase = [ordered]@{
    backend = [string]$previousBackend.Document.sourceRevision
    osShellControl = [string]$previousControl.Document.sourceRevision
  }
  edgePointersBefore = [ordered]@{
    backend = $backendEdgeBefore
    osShellControl = $controlEdgeBefore
  }
  targetRevision = $SourceRevision
  changedPaths = @(
    'apps/os-shell-control/authority/os-shell-admission.js',
    'apps/os-shell-control/authority/os-shell-admission.test.js',
    'apps/os-shell-control/deploy.test.js',
    'scripts/Deploy-LocalEdgeOsShell.ps1',
    'scripts/Publish-LocalEdgeOsShell.ps1',
    'scripts/os-shell-component-publisher.test.mjs',
    'scripts/os-shell-runtime-override-boundary.mjs',
    'scripts/os-shell-runtime-override-boundary.test.mjs'
  )
  affectedImages = @("$registry/opensphere-console-backend", "$registry/opensphere-console-os-shell-control")
  reusedImages = @(
    [ordered]@{ component = 'console'; image = [string]$console.Document.components.console.image },
    [ordered]@{ component = 'cliArtifacts'; image = [string]$base.Document.components.cliArtifacts.image },
    [ordered]@{ component = 'osShellRuntime'; image = [string]$base.Document.components.osShellRuntime.image }
  )
  releaseScope = 'component'
  fullReleaseJustification = $null
}
Write-Host '[scope] OS Shell Backend + Control component publication'
Write-Host ($scopeDeclaration | ConvertTo-Json -Depth 6)

$publisherParameters = @{
  SourceRevision = $SourceRevision
  Components = @('backend', 'osShellControl')
}
if ($SetupSourcePath) { $publisherParameters.SetupSourcePath = $SetupSourcePath }
if ($UseExistingRegistryLogin) { $publisherParameters.UseExistingRegistryLogin = $true }
& $publisher @publisherParameters
if ($LASTEXITCODE -ne 0) { throw 'The governed Console component publisher failed' }

$workspace = Join-Path (Split-Path $repoRoot -Parent) ".codex-tmp\local-edge-$($SourceRevision.Substring(0, 12))"
$combinedPath = Join-Path $workspace 'opensphere-local-component-publication.json'
$combined = Read-Publication -Path $combinedPath -ExpectedComponents @('backend', 'osShellControl') `
  -Purpose 'new OS Shell publication'
$publishedMigration = $combined.Document.artifacts.supabaseMigrationManifest
if ([string]$publishedMigration.sha256 -ne [string]$baseMigration.sha256 -or
    [string]$publishedMigration.setDigest -ne [string]$baseMigration.setDigest -or
    [string]$publishedMigration.latestMigrationId -ne [string]$baseMigration.latestMigrationId) {
  throw 'OS Shell component publication changed the base migration lineage'
}
if (-not $combined.Document.artifacts.osShellControlRelease) {
  throw 'OS Shell Control publication artifact is missing'
}

$backendDocument = $combined.Document | ConvertTo-Json -Depth 12 | ConvertFrom-Json
$backendDocument.components.PSObject.Properties.Remove('osShellControl')
$controlDocument = $combined.Document | ConvertTo-Json -Depth 12 | ConvertFrom-Json
$controlDocument.components.PSObject.Properties.Remove('backend')
$backendPath = Join-Path $workspace 'opensphere-local-os-shell-backend-publication.json'
$controlPath = Join-Path $workspace 'opensphere-local-os-shell-control-publication.json'
$scopePath = Join-Path $workspace 'opensphere-local-os-shell-scope.json'
$backendDocument | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $backendPath -Encoding utf8
$controlDocument | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $controlPath -Encoding utf8
$scopeDeclaration | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $scopePath -Encoding utf8

Write-Host '[success] OS Shell two-component edge publication completed'
Write-Host "[combined] $combinedPath"
Write-Host "[backend] $backendPath"
Write-Host "[control] $controlPath"
Write-Host "[scope] $scopePath"
