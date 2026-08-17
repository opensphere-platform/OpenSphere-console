#requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PreviousConsolePublicationEvidence,
  [Parameter(Mandatory)][string]$PreviousBackendPublicationEvidence,
  [string]$SourceRevision = '',
  [switch]$UseExistingRegistryLogin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$publisher = Join-Path $PSScriptRoot 'Publish-LocalEdge.ps1'
$registry = 'ghcr.io/opensphere-platform'
$components = @('backend', 'console')
$featurePaths = @(
  'backend/opensphere-console-backend/browser-session.js',
  'backend/opensphere-console-backend/browser-session.test.js',
  'backend/opensphere-console-backend/mfa-assurance.test.js',
  'backend/opensphere-console-backend/platform-release.test.js',
  'backend/opensphere-console-backend/server.js',
  'scripts/Publish-LocalEdgeConsoleSession.ps1',
  'src/app/core/auth.service.ts',
  'src/app/pages/login.ts',
  'src/app/pages/my-info.ts'
)
$consoleImageInputs = @(
  'scripts/Publish-LocalEdgeConsoleSession.ps1',
  'src/app/core/auth.service.ts',
  'src/app/pages/login.ts',
  'src/app/pages/my-info.ts'
)
$backendImageInputs = @(
  'backend/opensphere-console-backend/browser-session.js',
  'backend/opensphere-console-backend/server.js'
)

function Invoke-Checked {
  if ($args.Count -lt 1) { throw 'Invoke-Checked requires an executable' }
  $executable = [string]$args[0]
  $arguments = @($args | Select-Object -Skip 1)
  & $executable @arguments
  if ($LASTEXITCODE -ne 0) { throw "$executable failed with exit code $LASTEXITCODE" }
}

function Read-Publication {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Component)
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
    throw "$Component evidence is not canonical localhost edge publication evidence"
  }
  $keys = @($document.components.PSObject.Properties.Name)
  if ($keys.Count -ne 1 -or $keys[0] -ne $Component) {
    throw "$Component evidence must contain exactly $Component"
  }
  $image = [string]$document.components.$Component.image
  if ($image -notmatch "^$([regex]::Escape($registry))/opensphere-console(?:-backend)?@sha256:[a-f0-9]{64}$") {
    throw "$Component evidence image is not canonical and digest pinned"
  }
  return [ordered]@{ Path = $resolved; Document = $document; Image = $image }
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

function Get-RemoteDigest {
  param([Parameter(Mandatory)][string]$Reference)
  $output = & docker buildx imagetools inspect $Reference 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Image reference is not readable: $Reference" }
  $line = $output | Where-Object { $_ -match '^Digest:\s+(sha256:[a-f0-9]{64})$' } | Select-Object -First 1
  if (-not $line) { throw "Could not parse digest for $Reference" }
  return ([regex]::Match($line, 'sha256:[a-f0-9]{64}')).Value
}

function Get-ComponentDigest {
  param([Parameter(Mandatory)][string]$Image)
  return ([regex]::Match($Image, '@(sha256:[a-f0-9]{64})$')).Groups[1].Value
}

function Assert-ExactPaths {
  param([Parameter(Mandatory)][string[]]$Actual, [Parameter(Mandatory)][string[]]$Expected, [Parameter(Mandatory)][string]$Purpose)
  $actualSet = @($Actual | Sort-Object -Unique)
  $expectedSet = @($Expected | Sort-Object -Unique)
  if (($actualSet -join "`n") -ne ($expectedSet -join "`n")) {
    throw "$Purpose differs from the closed release scope. Actual: $($actualSet -join ', ')"
  }
}

function Get-ChangedPaths {
  param([Parameter(Mandatory)][string]$BaseRevision)
  Invoke-Checked git -C $repoRoot merge-base --is-ancestor $BaseRevision $SourceRevision
  return @(& git -C $repoRoot diff --name-only "$BaseRevision..$SourceRevision")
}

if (-not $SourceRevision) { $SourceRevision = (& git -C $repoRoot rev-parse HEAD).Trim() }
if ($SourceRevision -notmatch '^[a-f0-9]{40}$' -or $SourceRevision -ne (& git -C $repoRoot rev-parse HEAD).Trim()) {
  throw 'SourceRevision must be the current clean Console HEAD'
}
if (& git -C $repoRoot status --short) { throw 'Console worktree must be clean before component publication' }
if ((& git -C $repoRoot remote get-url origin).Trim() -ne 'https://github.com/opensphere-platform/OpenSphere-console.git') {
  throw 'Component publication requires the canonical Console origin'
}
Invoke-Checked git -C $repoRoot fetch --quiet --prune origin main
if ((& git -C $repoRoot branch --show-current).Trim() -ne 'main' -or
    (& git -C $repoRoot rev-parse origin/main).Trim() -ne $SourceRevision) {
  throw 'Component publication requires clean canonical main equal to fresh origin/main'
}
if ((& kubectl config current-context).Trim() -ne 'docker-desktop') {
  throw 'Component publication is restricted to docker-desktop'
}

$previousConsole = Read-Publication -Path $PreviousConsolePublicationEvidence -Component 'console'
$previousBackend = Read-Publication -Path $PreviousBackendPublicationEvidence -Component 'backend'
$consoleBase = [string]$previousConsole.Document.sourceRevision
$backendBase = [string]$previousBackend.Document.sourceRevision
$consoleChanges = Get-ChangedPaths -BaseRevision $consoleBase
Assert-ExactPaths -Actual $consoleChanges -Expected $featurePaths -Purpose 'Console-base source delta'

$backendChanges = Get-ChangedPaths -BaseRevision $backendBase
$observedBackendInputs = @($backendChanges | Where-Object { $_ -in $backendImageInputs })
Assert-ExactPaths -Actual $observedBackendInputs -Expected $backendImageInputs -Purpose 'Backend image input delta'
$observedConsoleInputs = @($consoleChanges | Where-Object {
  $_ -like 'src/*' -or $_ -like 'scripts/*' -or $_ -like 'nginx/*' -or $_ -like 'public/*' -or
  $_ -in @('Dockerfile', 'angular.json', 'package.json', 'package-lock.json', 'sdk-source.lock', 'tsconfig.json', 'tsconfig.app.json')
})
Assert-ExactPaths -Actual $observedConsoleInputs -Expected $consoleImageInputs -Purpose 'Console image input delta'

$migrationPath = Join-Path $repoRoot 'backend\supabase\migrations\manifest.json'
$migration = Get-Content -Raw -LiteralPath $migrationPath | ConvertFrom-Json
foreach ($publication in @($previousConsole.Document, $previousBackend.Document)) {
  $prior = $publication.artifacts.supabaseMigrationManifest
  if ((Get-CanonicalTextSha256 -Path $migrationPath) -ne [string]$prior.sha256 -or
      [string]$migration.setDigest -ne [string]$prior.setDigest -or
      [string]$migration.latestMigrationId -ne [string]$prior.latestMigrationId) {
    throw 'Session preference component release must not change the Supabase migration lineage'
  }
}

$lockConfig = Invoke-Checked kubectl --context docker-desktop -n opensphere-console get configmap opensphere-installation-lock -o json
$lockObject = ($lockConfig -join "`n") | ConvertFrom-Json
$releaseProperty = $lockObject.data.PSObject.Properties['release.json']
if (-not $releaseProperty) { throw 'Installation lock has no release.json' }
$releaseLock = [string]$releaseProperty.Value | ConvertFrom-Json
foreach ($binding in @(
  [ordered]@{ Name = 'console'; Evidence = $previousConsole },
  [ordered]@{ Name = 'backend'; Evidence = $previousBackend }
)) {
  $liveComponent = $releaseLock.components.($binding.Name)
  if ([string]$liveComponent.image -ne [string]$binding.Evidence.Image -or
      [string]$liveComponent.sourceRevision -ne [string]$binding.Evidence.Document.sourceRevision) {
    throw "Installation lock $($binding.Name) differs from supplied publication evidence"
  }
}

$scope = [ordered]@{
  requestIntent = 'modify,publish,deploy'
  changedPaths = @($featurePaths)
  affectedImages = @(
    "$registry/opensphere-console",
    "$registry/opensphere-console-backend"
  )
  releaseScope = 'component'
  fullReleaseJustification = $null
  comparisonBase = [ordered]@{ console = $consoleBase; backend = $backendBase }
  targetRevision = $SourceRevision
}
Write-Host '[scope] Console session preference two-component publication'
Write-Host ($scope | ConvertTo-Json -Depth 6)

$parameters = @{ SourceRevision = $SourceRevision; Components = @('console', 'backend') }
if ($UseExistingRegistryLogin) { $parameters.UseExistingRegistryLogin = $true }
& $publisher @parameters
if ($LASTEXITCODE -ne 0) { throw 'Governed component build/publish failed' }

$workspace = Join-Path (Split-Path $repoRoot -Parent) ".codex-tmp\local-edge-$($SourceRevision.Substring(0, 12))"
$publicationPath = Join-Path $workspace 'opensphere-local-component-publication.json'
$publication = Get-Content -Raw -LiteralPath $publicationPath | ConvertFrom-Json
$publishedKeys = @($publication.components.PSObject.Properties.Name | Sort-Object)
if (($publishedKeys -join ',') -ne 'backend,console' -or [string]$publication.sourceRevision -ne $SourceRevision) {
  throw 'Published evidence is not the exact Console+Backend component set'
}
foreach ($name in $components) {
  if ([string]$publication.components.$name.image -notmatch "^$([regex]::Escape($registry))/opensphere-console(?:-backend)?@sha256:[a-f0-9]{64}$") {
    throw "Published $name image is not canonical and digest pinned"
  }
}

$consoleDigest = Get-ComponentDigest -Image ([string]$publication.components.console.image)
Invoke-Checked docker buildx imagetools create --prefer-index=false --tag "$registry/opensphere-console:edge" `
  ([string]$publication.components.console.image)
if ((Get-RemoteDigest -Reference "$registry/opensphere-console:edge") -ne $consoleDigest) {
  throw 'Console edge pointer does not match the published exact digest'
}
$scopePath = Join-Path $workspace 'opensphere-local-console-session-scope.json'
$scope | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $scopePath -Encoding utf8
Write-Host '[success] Console session preference component publication completed'
Write-Host "[publication] $publicationPath"
Write-Host "[scope] $scopePath"
