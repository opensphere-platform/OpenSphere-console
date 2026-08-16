#requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BasePublicationEvidence,
  [Parameter(Mandatory)][string]$PreviousConsolePublicationEvidence,
  [Parameter(Mandatory)][string]$BackendPublicationEvidence,
  [Parameter(Mandatory)][string]$ControlPublicationEvidence,
  [string]$SourceRevision = '',
  [switch]$UseExistingRegistryLogin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$registry = 'ghcr.io/opensphere-platform'
$publisher = Join-Path $PSScriptRoot 'Publish-LocalEdge.ps1'
$boundaryVerifier = Join-Path $PSScriptRoot 'os-shell-runtime-override-boundary.mjs'
$consolePaths = @(
  'nginx/default.conf.template',
  'public/os-shell-frame/index.html',
  'scripts/os-shell-frontend-contract.test.mjs',
  'src/app/app.config.ts',
  'src/app/core/system-plugin-registry.service.ts',
  'src/app/pages/admin-plugins-state.spec.ts',
  'src/app/pages/admin-plugins.ts',
  'src/app/system-plugins/os-shell/os-shell-launcher.ts',
  'src/app/system-plugins/os-shell/os-shell-page.scss',
  'src/app/system-plugins/os-shell/os-shell-page.ts',
  'src/app/system-plugins/os-shell/os-shell-terminal-surface.ts'
)

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
  $match = [regex]::Match([string]$Publication.components.$Key.image, '@(sha256:[a-f0-9]{64})$')
  if (-not $match.Success) { throw "$Key publication image is not digest pinned" }
  return $match.Groups[1].Value
}

function Get-RemoteDigest {
  param([Parameter(Mandatory)][string]$Reference)
  $output = & docker buildx imagetools inspect $Reference 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Image reference is not readable from GHCR: $Reference" }
  $line = $output | Where-Object { $_ -match '^Digest:\s+(sha256:[0-9a-f]{64})$' } | Select-Object -First 1
  if (-not $line) { throw "Could not parse registry digest for $Reference" }
  return ([regex]::Match($line, 'sha256:[0-9a-f]{64}')).Value
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

function Get-CanonicalTextSha256 {
  param([Parameter(Mandatory)][string]$Path)
  $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return 'sha256:' + ([BitConverter]::ToString(
      $sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($text))
    )).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

if (-not $SourceRevision) { $SourceRevision = (& git -C $repoRoot rev-parse HEAD).Trim() }
if ($SourceRevision -notmatch '^[a-f0-9]{40}$' -or $SourceRevision -ne (& git -C $repoRoot rev-parse HEAD).Trim()) {
  throw 'SourceRevision must be the clean current Console HEAD'
}
if (& git -C $repoRoot status --short) { throw 'The Console worktree must be clean before OS Shell Console publication' }
if ((& git -C $repoRoot remote get-url origin).Trim() -ne 'https://github.com/opensphere-platform/OpenSphere-console.git') {
  throw 'OS Shell Console publication requires the canonical GitHub Console origin'
}
& git -C $repoRoot fetch --quiet --prune origin
if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the canonical Console origin' }
$upstream = (& git -C $repoRoot rev-parse --abbrev-ref --symbolic-full-name '@{u}').Trim()
if ((& git -C $repoRoot rev-parse $upstream).Trim() -ne $SourceRevision) {
  throw 'OS Shell Console publication HEAD must equal its pushed canonical upstream revision'
}
if ((& kubectl config current-context).Trim() -ne 'docker-desktop') {
  throw 'OS Shell edge publication is restricted to the docker-desktop context'
}

$base = Read-Publication -Path $BasePublicationEvidence `
  -ExpectedComponents @('backend', 'cliArtifacts', 'console', 'osShellControl', 'osShellRuntime') -Purpose 'base publication'
$previousConsole = Read-Publication -Path $PreviousConsolePublicationEvidence `
  -ExpectedComponents @('console') -Purpose 'deployed Console publication'
$backend = Read-Publication -Path $BackendPublicationEvidence -ExpectedComponents @('backend') -Purpose 'deployed Backend publication'
$control = Read-Publication -Path $ControlPublicationEvidence -ExpectedComponents @('osShellControl') -Purpose 'deployed Control publication'
foreach ($revision in @([string]$previousConsole.Document.sourceRevision, [string]$backend.Document.sourceRevision,
    [string]$control.Document.sourceRevision, $SourceRevision)) {
  & git -C $repoRoot merge-base --is-ancestor ([string]$base.Document.sourceRevision) $revision
  if ($LASTEXITCODE -ne 0) { throw "Target authority $revision does not descend from the base OS Shell publication" }
}
foreach ($revision in @([string]$previousConsole.Document.sourceRevision, [string]$backend.Document.sourceRevision,
    [string]$control.Document.sourceRevision)) {
  & git -C $repoRoot merge-base --is-ancestor $revision $SourceRevision
  if ($LASTEXITCODE -ne 0) { throw "Target source does not descend from deployed component revision $revision" }
}

$boundaryOutput = & node $boundaryVerifier --repository $repoRoot --base ([string]$base.Document.sourceRevision) `
  --backend ([string]$backend.Document.sourceRevision) --console $SourceRevision `
  --control ([string]$control.Document.sourceRevision) --head $SourceRevision
if ($LASTEXITCODE -ne 0) { throw 'OS Shell Console source boundary verification failed' }
$boundary = ($boundaryOutput -join "`n") | ConvertFrom-Json
if ((@($boundary.consolePaths | Sort-Object) -join ',') -ne (($consolePaths | Sort-Object) -join ',')) {
  throw 'OS Shell Console source boundary did not attribute the exact UI and Nginx inputs'
}

$consoleRepository = "$registry/opensphere-console"
$backendRepository = "$registry/opensphere-console-backend"
$controlRepository = "$registry/opensphere-console-os-shell-control"
if ((Get-LiveDeploymentDigest -Deployment 'opensphere-console' -Repository $consoleRepository) -ne
    (Get-ComponentDigest -Publication $previousConsole.Document -Key 'console')) {
  throw 'Live Console differs from the supplied deployed Console publication evidence'
}
if ((Get-LiveDeploymentDigest -Deployment 'opensphere-console-backend' -Repository $backendRepository) -ne
    (Get-ComponentDigest -Publication $backend.Document -Key 'backend')) {
  throw 'Live Backend differs from the supplied deployed publication evidence'
}
foreach ($deployment in @('opensphere-shell-api', 'opensphere-shell-gateway', 'opensphere-shell-reconciler')) {
  if ((Get-LiveDeploymentDigest -Deployment $deployment -Repository $controlRepository) -ne
      (Get-ComponentDigest -Publication $control.Document -Key 'osShellControl')) {
    throw "Live Control deployment $deployment differs from the supplied deployed publication evidence"
  }
}
$consoleEdgeBefore = Get-RemoteDigest -Reference "${consoleRepository}:edge"

$targetMigrationPath = Join-Path $repoRoot 'backend\supabase\migrations\manifest.json'
$targetMigration = Get-Content -Raw -LiteralPath $targetMigrationPath | ConvertFrom-Json
$baseMigration = $base.Document.artifacts.supabaseMigrationManifest
if ((Get-CanonicalTextSha256 -Path $targetMigrationPath) -ne [string]$baseMigration.sha256 -or
    [string]$targetMigration.setDigest -ne [string]$baseMigration.setDigest -or
    [string]$targetMigration.latestMigrationId -ne [string]$baseMigration.latestMigrationId) {
  throw 'Target source changes the deployed OS Shell migration lineage'
}

$scope = [ordered]@{
  requestIntent = 'deploy'
  comparisonBase = [ordered]@{
    console = [string]$previousConsole.Document.sourceRevision
    backend = [string]$backend.Document.sourceRevision
    osShellControl = [string]$control.Document.sourceRevision
  }
  targetRevision = $SourceRevision
  edgePointerBefore = $consoleEdgeBefore
  changedPaths = @($consolePaths + @(
    'scripts/Deploy-LocalEdgeOsShell.ps1',
    'scripts/Publish-LocalEdgeOsShellConsole.ps1',
    'scripts/os-shell-console-publisher.test.mjs',
    'scripts/os-shell-runtime-override-boundary.mjs',
    'scripts/os-shell-runtime-override-boundary.test.mjs'
  ))
  affectedImages = @($consoleRepository)
  reusedImages = @(
    [ordered]@{ component = 'backend'; image = [string]$backend.Document.components.backend.image },
    [ordered]@{ component = 'osShellControl'; image = [string]$control.Document.components.osShellControl.image },
    [ordered]@{ component = 'cliArtifacts'; image = [string]$base.Document.components.cliArtifacts.image },
    [ordered]@{ component = 'osShellRuntime'; image = [string]$base.Document.components.osShellRuntime.image }
  )
  releaseScope = 'component'
  fullReleaseJustification = $null
}
Write-Host '[scope] OS Shell Console-only component publication'
Write-Host ($scope | ConvertTo-Json -Depth 7)

$publisherParameters = @{ SourceRevision = $SourceRevision; Components = @('console') }
if ($UseExistingRegistryLogin) { $publisherParameters.UseExistingRegistryLogin = $true }
& $publisher @publisherParameters
if ($LASTEXITCODE -ne 0) { throw 'The governed Console component publisher failed' }

$workspace = Join-Path (Split-Path $repoRoot -Parent) ".codex-tmp\local-edge-$($SourceRevision.Substring(0, 12))"
$combinedPath = Join-Path $workspace 'opensphere-local-component-publication.json'
$published = Read-Publication -Path $combinedPath -ExpectedComponents @('console') -Purpose 'new OS Shell Console publication'
$publishedMigration = $published.Document.artifacts.supabaseMigrationManifest
if ([string]$publishedMigration.sha256 -ne [string]$baseMigration.sha256 -or
    [string]$publishedMigration.setDigest -ne [string]$baseMigration.setDigest -or
    [string]$publishedMigration.latestMigrationId -ne [string]$baseMigration.latestMigrationId) {
  throw 'OS Shell Console publication changed the base migration lineage'
}
$publishedDigest = Get-ComponentDigest -Publication $published.Document -Key 'console'
& docker buildx imagetools create --tag "${consoleRepository}:edge" ([string]$published.Document.components.console.image)
if ($LASTEXITCODE -ne 0) { throw 'Could not advance the OS Shell Console edge pointer' }
$consoleEdgeAfter = Get-RemoteDigest -Reference "${consoleRepository}:edge"
if ($consoleEdgeAfter -ne $publishedDigest) { throw 'OS Shell Console edge pointer does not match the published digest' }
$scope['edgePointerAfter'] = $consoleEdgeAfter
$consolePath = Join-Path $workspace 'opensphere-local-os-shell-console-publication.json'
$scopePath = Join-Path $workspace 'opensphere-local-os-shell-console-scope.json'
$published.Document | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $consolePath -Encoding utf8
$scope | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $scopePath -Encoding utf8

Write-Host '[success] OS Shell Console-only edge publication completed'
Write-Host "[console] $consolePath"
Write-Host "[scope] $scopePath"
