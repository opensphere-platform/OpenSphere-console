#requires -Version 7.2

[CmdletBinding(DefaultParameterSetName = 'SignedB')]
param(
  [Parameter(Mandatory)][ValidateLength(8,500)][string]$Reason,
  [Parameter(Mandatory)][string]$SigningKey,
  [Parameter(Mandatory)][string]$EvidenceDirectory,
  [Parameter(Mandatory, ParameterSetName = 'SignedB')][string]$BootstrapFromEvidence,
  [Parameter(Mandatory, ParameterSetName = 'BootstrapA')][switch]$BootstrapA,
  [string]$SetupSourcePath = '',
  [string]$Registry = 'ghcr.io/opensphere-platform',
  [ValidateSet('opensphere-edge-local-v1')][string]$SigningKeyId = 'opensphere-edge-local-v1',
  [switch]$UseExistingRegistryLogin,
  [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$workspaceRoot = Split-Path $repositoryRoot -Parent
if (-not $SetupSourcePath) { $SetupSourcePath = Join-Path $workspaceRoot 'OpenSphere-Setup-CLI' }
. (Join-Path $PSScriptRoot 'os-shell-edge-signing.ps1')

function Invoke-Checked {
  $program = [string]$args[0]; $arguments = @($args | Select-Object -Skip 1)
  $result = & $program @arguments
  if ($LASTEXITCODE -ne 0) { throw "$program failed with exit code $LASTEXITCODE" }
  return $result
}

function Get-GitBlobBytes([string]$Repository,[string]$ObjectPath) {
  $start = [Diagnostics.ProcessStartInfo]::new('git')
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in @('-C',$Repository,'cat-file','blob',$ObjectPath)) {
    [void]$start.ArgumentList.Add($argument)
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw 'git cat-file did not start.' }
    $memory = [IO.MemoryStream]::new()
    try {
      $process.StandardOutput.BaseStream.CopyTo($memory)
      $errorText = $process.StandardError.ReadToEnd()
      $process.WaitForExit()
      if ($process.ExitCode -ne 0) {
        throw "git cat-file failed with exit code $($process.ExitCode): $errorText"
      }
      return ,$memory.ToArray()
    } finally { $memory.Dispose() }
  } finally { $process.Dispose() }
}

function Assert-CanonicalMain {
  param([string]$Path,[string]$ExpectedUrl,[string]$Label)
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  if (Invoke-Checked git -C $resolved status --porcelain=v1 --untracked-files=all) {
    throw "$Label publication requires a completely clean worktree."
  }
  Invoke-Checked git -C $resolved fetch --quiet origin main | Out-Null
  $actual = (Invoke-Checked git -C $resolved remote get-url origin).Trim()
  $branch = (Invoke-Checked git -C $resolved branch --show-current).Trim()
  $upstream = (Invoke-Checked git -C $resolved rev-parse --abbrev-ref --symbolic-full-name '@{upstream}').Trim()
  $head = (Invoke-Checked git -C $resolved rev-parse HEAD).Trim()
  $remote = (Invoke-Checked git -C $resolved rev-parse origin/main).Trim()
  if ($actual -cne $ExpectedUrl -or $branch -cne 'main' -or $upstream -cne 'origin/main' `
      -or $head -cne $remote -or $head -notmatch '^[a-f0-9]{40}$') {
    throw "$Label source must be clean fetched canonical origin/main."
  }
  return [pscustomobject]@{ Path=$resolved; Revision=$head; Repository=$actual }
}

function Get-CommittedTool {
  param([string]$Path)
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $relative = [IO.Path]::GetRelativePath($repositoryRoot,$resolved).Replace('\','/')
  if ($relative -match '^(?:[A-Za-z]:|/|\\)' -or $relative -match '(^|/)\.\.(/|$)') { throw 'Tool path escaped Console.' }
  Invoke-Checked git -C $repositoryRoot ls-files --error-unmatch -- $relative | Out-Null
  Invoke-Checked git -C $repositoryRoot diff --quiet HEAD -- $relative | Out-Null
  return [ordered]@{ path=$relative; gitBlob=(Invoke-Checked git -C $repositoryRoot rev-parse "HEAD:$relative").Trim();
    sha256=Get-OsShellSha256 -Bytes ([IO.File]::ReadAllBytes($resolved)) }
}

function Get-CommittedFile {
  param([string]$Repository,[string]$Path)
  $relative = $Path.Replace('\','/')
  if ($relative -match '^(?:[A-Za-z]:|/|\\)' -or $relative -match '(^|/)\.\.(/|$)') {
    throw 'Committed evidence path escaped its repository.'
  }
  $resolved = Join-Path $Repository $relative
  Invoke-Checked git -C $Repository ls-files --error-unmatch -- $relative | Out-Null
  Invoke-Checked git -C $Repository diff --quiet HEAD -- $relative | Out-Null
  return [ordered]@{
    path = $relative
    gitBlob = (Invoke-Checked git -C $Repository rev-parse "HEAD:$relative").Trim()
    sha256 = Get-OsShellSha256 -Bytes ([IO.File]::ReadAllBytes($resolved))
  }
}

function New-DetachedTree {
  param([string]$Repository,[string]$Revision,[string]$Target)
  if (Test-Path -LiteralPath $Target) { throw "Detached source target already exists: $Target" }
  Invoke-Checked git -C $Repository worktree add --detach $Target $Revision | Out-Null
  $observed = (Invoke-Checked git -C $Target rev-parse HEAD).Trim()
  if ($observed -cne $Revision -or (Invoke-Checked git -C $Target status --porcelain=v1 --untracked-files=all)) {
    throw "Detached source did not reproduce exact revision $Revision"
  }
  return (Resolve-Path -LiteralPath $Target).Path
}

function Remove-DetachedTree {
  param([string]$Repository,[string]$Target)
  if (-not $Target) { return }
  try { Invoke-Checked git -C $Repository worktree remove --force $Target | Out-Null } catch {
    Write-Warning "Detached source cleanup needs attention: $Target ($($_.Exception.Message))"
  }
}

function Invoke-EvidenceCommand {
  param([string]$Id,[string]$WorkingDirectory,[string]$LogPath,[string]$Program,[string[]]$Arguments)
  $started = [DateTimeOffset]::UtcNow
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $Program @Arguments 2>&1 | Tee-Object -FilePath $LogPath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$Id failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
  return [ordered]@{
    id = $Id
    result = 'PASS'
    artifactUri = "evidence://$(Split-Path -Leaf $LogPath)"
    artifactSha256 = Get-OsShellSha256 -Bytes ([IO.File]::ReadAllBytes($LogPath))
    startedAt = $started.ToString('o')
    completedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
}

function Invoke-BootstrapManifestProjection {
  param(
    [string]$HelperPath,
    [string]$Manifest,
    [string]$SourceRevision,
    [string]$BackendImage,
    [AllowNull()]$BootstrapFrom
  )
  $start = [Diagnostics.ProcessStartInfo]::new('node')
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in @(
    $HelperPath,
    '--source-revision', $SourceRevision,
    '--backend-image', $BackendImage
  )) { [void]$start.ArgumentList.Add($argument) }
  if ($null -ne $BootstrapFrom) {
    $bootstrapJson = $BootstrapFrom | ConvertTo-Json -Depth 12 -Compress
    $bootstrapBase64 = [Convert]::ToBase64String(
      [Text.Encoding]::UTF8.GetBytes($bootstrapJson)).TrimEnd('=').Replace('+','-').Replace('/','_')
    [void]$start.ArgumentList.Add('--bootstrap-from-base64')
    [void]$start.ArgumentList.Add($bootstrapBase64)
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw 'Bootstrap manifest projection did not start.' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($Manifest)
    $process.StandardInput.Close()
    $process.WaitForExit()
    $projected = $stdout.GetAwaiter().GetResult()
    $errorText = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      throw "Bootstrap manifest projection failed with exit code $($process.ExitCode): $errorText"
    }
    if ([string]::IsNullOrWhiteSpace($projected)) {
      throw 'Bootstrap manifest projection returned an empty manifest.'
    }
    return $projected
  } finally { $process.Dispose() }
}

function Get-RemoteDigest([string]$Reference) {
  $raw = Invoke-Checked docker buildx imagetools inspect $Reference
  $match = [regex]::Match(($raw -join "`n"),'Digest:\s*(sha256:[a-f0-9]{64})')
  if (-not $match.Success) { throw "Unable to resolve digest for $Reference" }
  return $match.Groups[1].Value
}

function Get-ValidatedBootstrapFrom {
  param([string]$Path,[string]$ExpectedImage,[string]$ExpectedSourceRevision)
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $document = Get-Content -Raw -LiteralPath $resolved | ConvertFrom-Json
  $value = if ($null -ne $document.bootstrapFrom) { $document.bootstrapFrom } else { $document }
  $expectedKeys = @(
    'contract','requestId','releaseDigest','sourceRevision','image','mergeRevision',
    'receiptOperationId','governedDocumentSha256','receiptSha256','handoffState',
    'convergenceState','foundationFeatureGate','trustConfigUid','trustConfigResourceVersion',
    'trustKeySpkiSha256'
  )
  $actualKeys = @($value.PSObject.Properties.Name | Sort-Object)
  if ((Compare-Object ($expectedKeys | Sort-Object) $actualKeys)) {
    throw 'Bootstrap evidence is not the exact opensphere-backend-component-bootstrap/v1 object.'
  }
  if ([string]$value.contract -cne 'opensphere-backend-component-bootstrap/v1' `
      -or [string]$value.requestId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' `
      -or [string]$value.releaseDigest -notmatch '^sha256:[a-f0-9]{64}$' `
      -or [string]$value.sourceRevision -notmatch '^[a-f0-9]{40}$' `
      -or [string]$value.image -notmatch '^ghcr[.]io/opensphere-platform/opensphere-console-backend@sha256:[a-f0-9]{64}$' `
      -or [string]$value.mergeRevision -notmatch '^[a-f0-9]{40,64}$' `
      -or [string]$value.receiptOperationId -notmatch '^[A-Za-z0-9:._-]{8,255}$' `
      -or [string]$value.governedDocumentSha256 -notmatch '^sha256:[a-f0-9]{64}$' `
      -or [string]$value.receiptSha256 -notmatch '^sha256:[a-f0-9]{64}$' `
      -or [string]$value.trustConfigUid -notmatch '^[A-Za-z0-9._:-]{8,128}$' `
      -or [string]$value.trustConfigResourceVersion -notmatch '^[A-Za-z0-9._:-]{1,128}$' `
      -or [string]$value.trustKeySpkiSha256 -notmatch '^sha256:[a-f0-9]{64}$' `
      -or [string]$value.handoffState -cne 'BootstrapApplied' `
      -or [string]$value.convergenceState -cne 'PendingConvergence' `
      -or [string]$value.foundationFeatureGate -cne 'Closed' `
      -or [string]$value.image -cne $ExpectedImage `
      -or [string]$value.sourceRevision -cne $ExpectedSourceRevision) {
    throw 'Bootstrap evidence is invalid or differs from the live A release.'
  }
  return [ordered]@{
    contract=[string]$value.contract; requestId=[string]$value.requestId
    releaseDigest=[string]$value.releaseDigest; sourceRevision=[string]$value.sourceRevision
    image=[string]$value.image; mergeRevision=[string]$value.mergeRevision
    receiptOperationId=[string]$value.receiptOperationId
    governedDocumentSha256=[string]$value.governedDocumentSha256
    receiptSha256=[string]$value.receiptSha256; handoffState=[string]$value.handoffState
    convergenceState=[string]$value.convergenceState
    foundationFeatureGate=[string]$value.foundationFeatureGate
    trustConfigUid=[string]$value.trustConfigUid
    trustConfigResourceVersion=[string]$value.trustConfigResourceVersion
    trustKeySpkiSha256=[string]$value.trustKeySpkiSha256
  }
}

function Set-RemoteTag([string]$Repository,[string]$Digest,[string]$Tag,[switch]$Immutable) {
  $target = "${Repository}:$Tag"; $current = $null
  try { $current = Get-RemoteDigest $target } catch {}
  if ($Immutable -and $current -and $current -cne $Digest) { throw "Immutable tag collision: $target" }
  if ($current -cne $Digest) {
    Invoke-Checked docker buildx imagetools create --prefer-index=false --tag $target "${Repository}@${Digest}" | Out-Null
  }
  if ((Get-RemoteDigest $target) -cne $Digest) { throw "Remote tag verification failed: $target" }
}

function Assert-BackendPathClosure([string[]]$Paths) {
  $allowed = @(
    '^backend/opensphere-console-backend/',
    '^backend/supabase/migrations/(?:0063_foundation_owner_release_consumer\.sql|manifest\.json)$',
    '^backend/supabase/(?:supabase-contract\.test\.mjs|verify-ledger-integrity\.mjs)$',
    '^backend/gitea/bootstrap/(?:install\.ps1|register-foundation-owner-release-repository-access\.ps1|bootstrap-contract\.test\.js)$',
    '^scripts/(?:Initialize-FoundationOwnerInstallationLock\.ps1|Invoke-LocalEdgePlatformRelease\.ps1|Publish-LocalEdgeBackendComponent\.ps1|backend-component-workflow\.test\.mjs)$',
    '^package\.json$'
  )
  $outside = @($Paths | Where-Object { $candidate=$_; -not ($allowed | Where-Object { $candidate -match $_ }) })
  if (-not $Paths.Count -or $outside.Count) { throw "Backend component changed-path closure failed: $($outside -join ', ')" }
}

function Assert-BootstrapAPathClosure([string[]]$Paths) {
  $allowed = @(
    'backend/opensphere-console-backend/Dockerfile',
    'backend/opensphere-console-backend/deploy.yaml',
    'backend/opensphere-console-backend/local-edge-automation-token.js',
    'backend/opensphere-console-backend/local-edge-automation-token.test.js',
    'backend/opensphere-console-backend/foundation-owner-release.js',
    'backend/opensphere-console-backend/foundation-owner-release.test.js',
    'backend/opensphere-console-backend/platform-release-contract.js',
    'backend/opensphere-console-backend/platform-release-admission.test.js',
    'backend/opensphere-console-backend/platform-release-executor.mjs',
    'backend/opensphere-console-backend/platform-release-internal-transport.js',
    'backend/opensphere-console-backend/platform-release-internal-transport.test.js',
    'backend/opensphere-console-backend/platform-release-manifest-projection.js',
    'backend/opensphere-console-backend/platform-release-manifest-projection.test.js',
    'backend/opensphere-console-backend/platform-release-reconciler.js',
    'backend/opensphere-console-backend/platform-release-tls-initializer.mjs',
    'backend/opensphere-console-backend/platform-release-tls-initializer.test.mjs',
    'backend/opensphere-console-backend/platform-release.test.js',
    'backend/opensphere-console-backend/platform-release-bootstrap-cross-version.test.js',
    'backend/opensphere-console-backend/server.js',
    'backend/opensphere-console-backend/setup-source.lock',
    'scripts/Invoke-LocalEdgePlatformRelease.ps1',
    'scripts/Publish-LocalEdgeBackendComponent.ps1',
    'scripts/backend-bootstrap-a-invoke-fixture.test.ps1',
    'scripts/backend-component-workflow.test.mjs',
    'package.json'
  )
  $outside = @($Paths | Where-Object { $_ -notin $allowed })
  if (-not $Paths.Count -or $outside.Count) {
    throw "Backend Bootstrap A changed-path closure failed: $($outside -join ', ')"
  }
}

function Assert-BootstrapAManifestSource([string]$Manifest) {
  foreach ($required in @(
    'name: platform-release-executor-job-boundary',
    'name: platform-release-executor-pod-boundary',
    'name: platform-release-reconciler-deployment-boundary',
    'name: platform-release-reconciler-pod-boundary',
    'name: platform-release-reconciler',
    'name: platform-release-executor',
    'name: platform-release-tls-initializer',
    'name: opensphere-platform-release-authority-service-custody',
    'name: opensphere-bootstrap-a-initializer-cleanup-journal-custody',
    'PLATFORM_RELEASE_TLS_INITIALIZER_PROFILE',
    'opensphere-platform-release-authority-tls',
    'opensphere-platform-release-control-ca',
    'PLATFORM_RELEASE_AUTHORITY_ENABLED',
    'containerPort: 8446',
    'port: 8446'
  )) {
    if (-not $Manifest.Contains($required)) {
      throw "Backend Bootstrap A manifest lacks hardened Platform boundary: $required"
    }
  }
  foreach ($forbidden in @(
    'foundation-owner-release-reconciler',
    '0063_foundation_owner_release_consumer.sql'
  )) {
    if ($Manifest.Contains($forbidden)) {
      throw "Backend Bootstrap A manifest contains a final-convergence dependency: $forbidden"
    }
  }
}

function Assert-BootstrapADockerfileSource([string]$Dockerfile) {
  foreach ($required in @(
    'COPY opensphere-console-backend/server.js ./server.js',
    'COPY opensphere-console-backend/platform-release-contract.js ./platform-release-contract.js',
    'COPY opensphere-console-backend/platform-release-internal-transport.js ./platform-release-internal-transport.js',
    'COPY opensphere-console-backend/platform-release-manifest-projection.js ./platform-release-manifest-projection.js',
    'COPY opensphere-console-backend/platform-release-reconciler.js ./platform-release-reconciler.js',
    'COPY opensphere-console-backend/platform-release-executor.mjs ./platform-release-executor.mjs',
    'COPY opensphere-console-backend/platform-release-tls-initializer.mjs ./platform-release-tls-initializer.mjs',
    'COPY --from=setup-cli src /app/opensphere-setup-cli/src'
  )) {
    if (-not $Dockerfile.Contains($required)) {
      throw "Backend Bootstrap A Dockerfile lacks a required transitional input: $required"
    }
  }
  foreach ($forbidden in @(
    'COPY opensphere-console-backend/foundation-owner-release-reconciler.js',
    'COPY opensphere-console-backend/foundation-owner-release-executor.mjs'
  )) {
    if ($Dockerfile.Contains($forbidden)) {
      throw "Backend Bootstrap A Dockerfile includes a final Foundation worker: $forbidden"
    }
  }
}

if ($env:OS -ne 'Windows_NT' -or (Invoke-Checked kubectl config current-context).Trim() -cne 'docker-desktop') {
  throw 'Backend component publication is restricted to Windows Docker Desktop.'
}
$platform = Assert-CanonicalMain $workspaceRoot `
  'https://github.com/opensphere-platform/OpenSphere-Platform-V2.git' 'Platform authority'
$inventoryEvidence = Get-CommittedFile $workspaceRoot 'repository-inventory.json'
$inventory = Get-Content -Raw -LiteralPath (Join-Path $workspaceRoot 'repository-inventory.json') | ConvertFrom-Json
$platformEntry = @($inventory.repositories | Where-Object { [string]$_.path -ceq '.' })
$consoleEntry = @($inventory.repositories | Where-Object { [string]$_.path -ceq 'OpenSphere-console' })
$setupEntry = @($inventory.repositories | Where-Object { [string]$_.path -ceq 'OpenSphere-Setup-CLI' })
if ($platformEntry.Count -ne 1 -or
    [string]$platformEntry[0].github -cne 'https://github.com/opensphere-platform/OpenSphere-Platform-V2.git' -or
    $consoleEntry.Count -ne 1 -or $setupEntry.Count -ne 1) {
  throw 'Canonical Platform/Console/Setup inventory is incomplete.'
}
$console = Assert-CanonicalMain $repositoryRoot ([string]$consoleEntry[0].github) 'Console'
$setup = Assert-CanonicalMain $SetupSourcePath ([string]$setupEntry[0].github) 'Setup CLI'
$setupLockPath = Join-Path $repositoryRoot 'backend\opensphere-console-backend\setup-source.lock'
$setupLockBytes = [IO.File]::ReadAllBytes($setupLockPath)
$setupLockRevision = ([Text.Encoding]::UTF8.GetString($setupLockBytes)).Trim()
if ($setupLockRevision -notmatch '^[a-f0-9]{40}$' -or $setupLockRevision -cne $setup.Revision) {
  throw 'Console setup-source.lock must equal the fetched canonical Setup origin/main revision.'
}
$setupLockSha256 = Get-OsShellSha256 -Bytes $setupLockBytes
$setupProjectionTool = Get-CommittedFile $setup.Path 'src/platform-release-bootstrap-manifest.mjs'

# Validate every workstation tool before registry, trust or cluster mutation.
$tooling = [ordered]@{
  publisher=Get-CommittedTool $MyInvocation.MyCommand.Path
  deployer=Get-CommittedTool (Join-Path $PSScriptRoot 'Invoke-LocalEdgePlatformRelease.ps1')
  signingHelper=Get-CommittedTool (Join-Path $PSScriptRoot 'os-shell-edge-signing.ps1')
  initializer=Get-CommittedTool (Join-Path $PSScriptRoot 'Initialize-FoundationOwnerInstallationLock.ps1')
}
if ($BootstrapA) {
  $tooling.bootstrapAValidator = Get-CommittedTool (Join-Path $repositoryRoot `
    'backend\opensphere-console-backend\platform-release-contract.js')
}
$deployment = ((Invoke-Checked kubectl -n opensphere-console get deployment opensphere-console-backend -o json) -join "`n") | ConvertFrom-Json
$previousSource = [string]$deployment.spec.template.metadata.annotations.'io.opensphere.source-revision'
$previousImage = [string](@($deployment.spec.template.spec.containers | Where-Object name -eq 'backend')[0].image)
if ($previousSource -notmatch '^[a-f0-9]{40}$' -or $previousImage -notmatch '^ghcr\.io/opensphere-platform/opensphere-console-backend@sha256:[a-f0-9]{64}$') {
  throw 'Live Backend base is not a canonical exact release.'
}
Invoke-Checked git -C $repositoryRoot merge-base --is-ancestor $previousSource $console.Revision | Out-Null
$changedPaths = @(Invoke-Checked git -C $repositoryRoot diff --name-only "$previousSource..$($console.Revision)" --) |
  ForEach-Object { [string]$_ } | Where-Object { $_ } | Sort-Object -Unique
if ($BootstrapA) { Assert-BootstrapAPathClosure $changedPaths }
else { Assert-BackendPathClosure $changedPaths }

$imageJson = (Invoke-Checked docker buildx imagetools inspect --format '{{json .Image}}' $previousImage) -join "`n" | ConvertFrom-Json
$previousSetup = [string]$imageJson.config.Labels.'io.opensphere.setup-source-revision'
if ($previousSetup -notmatch '^[a-f0-9]{40}$') { throw 'Live Backend image lacks the exact Setup source label.' }
Invoke-Checked git -C $setup.Path merge-base --is-ancestor $previousSetup $setup.Revision | Out-Null
$setupChangedPaths = @(Invoke-Checked git -C $setup.Path diff --name-only "$previousSetup..$($setup.Revision)" --) |
  ForEach-Object { [string]$_ } | Where-Object { $_ } | Sort-Object -Unique
$setupAllowed = @(
  'src/bootstrap.mjs','src/release.mjs','src/verify.mjs',
  'src/New-PlatformReleaseAuthorityCertificates.ps1','src/platform-release-authority-tls.mjs',
  'src/platform-release-bootstrap-cleanup.mjs',
  'src/platform-release-bootstrap-manifest.mjs',
  'test/base-runtime.test.mjs','test/release.test.mjs','test/upgrade.test.mjs',
  'test/platform-release-authority-tls.test.mjs',
  'test/platform-release-bootstrap-cleanup.test.mjs',
  'test/platform-release-bootstrap-manifest.test.mjs'
)
$setupOutside = @($setupChangedPaths | Where-Object { $_ -notin $setupAllowed })
if ($setupOutside.Count) { throw "Setup component closure failed: $($setupOutside -join ', ')" }
if ($previousSetup -eq $setup.Revision -and $setupChangedPaths.Count) {
  throw 'Unchanged Setup revision cannot declare changed paths.'
}
if ($previousSetup -ne $setup.Revision -and -not $setupChangedPaths.Count) {
  throw 'Changed Setup revision requires an exact non-empty changed-path set.'
}
$bootstrapFrom = if ($BootstrapA) { $null }
else { Get-ValidatedBootstrapFrom $BootstrapFromEvidence $previousImage $previousSource }

$epoch = (Invoke-Checked git -C $repositoryRoot show -s --format=%ct $console.Revision).Trim()
$releaseTag = [DateTimeOffset]::FromUnixTimeSeconds([long]$epoch).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyyMMddHHmm')
$immutableTag = "local-$($console.Revision.Substring(0,12))"
$repository = "$Registry/opensphere-console-backend"
$evidenceRoot = [IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
$metadataPath = Join-Path $evidenceRoot 'opensphere-console-backend-build-metadata.json'
$detachedRoot = Join-Path ([IO.Path]::GetTempPath()) "opensphere-backend-component-$PID-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $detachedRoot | Out-Null
$detachedConsole = ''
$detachedSetup = ''

try {
  $detachedConsole = New-DetachedTree $console.Path $console.Revision (Join-Path $detachedRoot 'console')
  $detachedSetup = New-DetachedTree $setup.Path $setup.Revision (Join-Path $detachedRoot 'setup')
  $verificationResults = @()
  $verificationResults += Invoke-EvidenceCommand 'console-full-test' $detachedConsole `
    (Join-Path $evidenceRoot 'console-full-test.log') 'npm' @('ci')
  $verificationResults += Invoke-EvidenceCommand 'console-test' $detachedConsole `
    (Join-Path $evidenceRoot 'console-test.log') 'npm' @('test')
  $verificationResults += Invoke-EvidenceCommand 'setup-full-test' $detachedSetup `
    (Join-Path $evidenceRoot 'setup-full-test.log') 'npm' @('ci')
  $verificationResults += Invoke-EvidenceCommand 'setup-test' $detachedSetup `
    (Join-Path $evidenceRoot 'setup-test.log') 'npm' @('test')
  $verificationResults += Invoke-EvidenceCommand 'fresh-ledger-verifier' $detachedConsole `
    (Join-Path $evidenceRoot 'fresh-ledger-verifier.log') 'node' @('backend/supabase/verify-ledger-integrity.mjs')
  if ($BootstrapA) {
    $verificationResults += Invoke-EvidenceCommand 'bootstrap-a-invoke-fixture' $detachedConsole `
      (Join-Path $evidenceRoot 'bootstrap-a-invoke-fixture.log') 'pwsh' `
      @('-NoProfile','-File','scripts/backend-bootstrap-a-invoke-fixture.test.ps1')
  }

if (-not $UseExistingRegistryLogin) {
  $ghToken = (Invoke-Checked gh auth token).Trim()
  try { $ghToken | docker login ghcr.io -u opensphere-platform --password-stdin | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'docker login failed' } }
  finally { $ghToken=$null }
}
Invoke-Checked docker buildx build --platform linux/amd64 --push --provenance=mode=max `
  --metadata-file $metadataPath --tag "${repository}:$immutableTag" `
  --label 'io.opensphere.channel=edge' --label "io.opensphere.source-revision=$($console.Revision)" `
  --label "io.opensphere.release-tag=$releaseTag" --label "org.opencontainers.image.version=$releaseTag" `
  --label 'opensphere.io/build-authority=localhost' --label 'opensphere.io/release-class=pre-ga' `
  --label 'opensphere.io/ga-eligible=false' --build-context "setup-cli=$detachedSetup" `
  --build-arg "SETUP_SOURCE_REVISION=$($setup.Revision)" `
  --file (Join-Path $detachedConsole 'backend\opensphere-console-backend\Dockerfile') (Join-Path $detachedConsole 'backend') | Out-Null
$metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
$digest = [string]$metadata.'containerimage.digest'
if ($digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Backend build did not return an exact digest.' }
$exactImage = "${repository}@${digest}"
$built = (Invoke-Checked docker buildx imagetools inspect --format '{{json .Image}}' $exactImage) -join "`n" | ConvertFrom-Json
if ([string]$built.os -cne 'linux' -or [string]$built.architecture -cne 'amd64' `
    -or [string]$built.config.Labels.'io.opensphere.source-revision' -cne $console.Revision `
    -or [string]$built.config.Labels.'io.opensphere.setup-source-revision' -cne $setup.Revision) {
  throw 'Backend image metadata differs from the canonical Console/Setup sources.'
}

$migrationPath = Join-Path $detachedConsole 'backend\supabase\migrations\manifest.json'
$migrationBytes = Get-GitBlobBytes $detachedConsole `
  "$($console.Revision):backend/supabase/migrations/manifest.json"
$migration = [Text.Encoding]::UTF8.GetString($migrationBytes) | ConvertFrom-Json
if ([string]$migration.setDigest -notmatch '^sha256:[a-f0-9]{64}$' `
    -or [string]$migration.latestMigrationId -notmatch '^\d{4}$') {
  throw 'Backend component publication requires a canonical migration manifest.'
}
if (-not $BootstrapA -and [string]$migration.latestMigrationId -cne '0063') {
  throw 'Signed Backend B publication requires canonical migration 0063.'
}
$manifestSource = [IO.File]::ReadAllText((Join-Path $detachedConsole 'backend\opensphere-console-backend\deploy.yaml'))
if ($BootstrapA) {
  Assert-BootstrapAManifestSource $manifestSource
  Assert-BootstrapADockerfileSource ([IO.File]::ReadAllText((Join-Path $detachedConsole `
    'backend\opensphere-console-backend\Dockerfile')))
  $previousMigrationText = (Invoke-Checked git -C $repositoryRoot show `
    "${previousSource}:backend/supabase/migrations/manifest.json") -join "`n"
  $previousMigration = $previousMigrationText | ConvertFrom-Json
  if ([string]$migration.latestMigrationId -cne [string]$previousMigration.latestMigrationId `
      -or [string]$migration.setDigest -cne [string]$previousMigration.setDigest `
      -or [int]$migration.migrationCount -ne [int]$previousMigration.migrationCount) {
    throw 'Backend Bootstrap A must retain the installed migration set exactly.'
  }
}
$renderedManifestPath = Join-Path $evidenceRoot 'opensphere-console-backend-rendered.yaml'
$renderedManifest = [regex]::Replace($manifestSource,
  'ghcr\.io/opensphere-platform/opensphere-console-backend@sha256:[a-f0-9]{64}', $exactImage)
$renderedManifest = $renderedManifest.Replace('__OPENSPHERE_RELEASE_REVISION__',$console.Revision)
$renderedManifest = Invoke-BootstrapManifestProjection `
  -HelperPath (Join-Path $detachedSetup 'src\platform-release-bootstrap-manifest.mjs') `
  -Manifest $renderedManifest -SourceRevision $console.Revision -BackendImage $exactImage `
  -BootstrapFrom $bootstrapFrom
if ($renderedManifest -notmatch [regex]::Escape($exactImage)) {
  throw 'Rendered Backend manifest did not bind the target exact image.'
}
if ($renderedManifest.Contains('__OPENSPHERE_RELEASE_REVISION__')) {
  throw 'Rendered Backend manifest retained an unresolved source-revision placeholder.'
}
[IO.File]::WriteAllText($renderedManifestPath,$renderedManifest,[Text.UTF8Encoding]::new($false))
$verificationResults += Invoke-EvidenceCommand 'rendered-manifest-client-dry-run' $evidenceRoot `
  (Join-Path $evidenceRoot 'rendered-manifest-client-dry-run.log') 'kubectl' `
  @('apply','--dry-run=client','-f',$renderedManifestPath,'-o','name')
$verificationResults += Invoke-EvidenceCommand 'rendered-manifest-server-dry-run' $evidenceRoot `
  (Join-Path $evidenceRoot 'rendered-manifest-server-dry-run.log') 'kubectl' `
  @('apply','--dry-run=server','-f',$renderedManifestPath,'-o','name')
$verificationDocument = [ordered]@{
  contract = 'opensphere-backend-component-verification-set/v1'
  results = @($verificationResults)
  renderedManifest = [ordered]@{
    artifactUri = "evidence://$(Split-Path -Leaf $renderedManifestPath)"
    sha256 = Get-OsShellSha256 -Bytes ([IO.File]::ReadAllBytes($renderedManifestPath))
  }
}
$verificationSetBytes = [Text.Encoding]::UTF8.GetBytes(($verificationDocument | ConvertTo-Json -Depth 12 -Compress))
$verificationSetDigest = Get-OsShellSha256 -Bytes $verificationSetBytes
$publicationPath = Join-Path $evidenceRoot 'opensphere-local-backend-component-publication.json'
$publication = [ordered]@{
  apiVersion='release.opensphere.io/v1alpha1'
  kind=if ($BootstrapA) { 'OpenSphereBackendComponentBootstrapAPublication' } else { 'OpenSphereEdgeComponentPublication' }
  contract=if ($BootstrapA) { 'opensphere-backend-component-bootstrap-a-publication/v1' } else { $null }
  bootstrapPhase=if ($BootstrapA) { 'A' } else { $null }
  publicationScope='ComponentSet'
  channel='edge'; status='Active'; releaseTag=$releaseTag; immutableTag=$immutableTag
  source='https://github.com/opensphere-platform/OpenSphere-console'; sourceRevision=$console.Revision
  buildAuthority='localhost'; releaseClass='pre-ga'; gaEligible=$false; supportedPlatforms=@('linux/amd64')
  requestIntent=$Reason; changedPaths=@($changedPaths); affectedImages=@('backend'); releaseScope='component'; fullReleaseJustification=$null
  previous=[ordered]@{ image=$previousImage; sourceRevision=$previousSource; setupSourceRevision=$previousSetup }
  platformAuthority=[ordered]@{ repository=$platform.Repository; sourceRevision=$platform.Revision;
    inventory=$inventoryEvidence }
  setupSource=[ordered]@{ repository=$setup.Repository; sourceRevision=$setup.Revision;
    changedPaths=@($setupChangedPaths); lockSha256=$setupLockSha256;
    manifestProjectionTool=$setupProjectionTool }
  artifacts=[ordered]@{ supabaseMigrationManifest=[ordered]@{ path='backend/supabase/migrations/manifest.json'; sha256=Get-OsShellSha256 -Bytes $migrationBytes;
    setDigest=[string]$migration.setDigest; latestMigrationId=[string]$migration.latestMigrationId; migrationCount=[int]$migration.migrationCount } }
  components=[ordered]@{ backend=[ordered]@{ image=$exactImage; sourceRevision=$console.Revision; registryCredentialsRequired=$false } }
  tooling=$tooling
  bootstrapFrom=if ($BootstrapA) { $null } else { $bootstrapFrom }
  verification=[ordered]@{ contract=$verificationDocument.contract; setDigest=$verificationSetDigest;
    results=@($verificationDocument.results); renderedManifest=$verificationDocument.renderedManifest }
  generatedAt=[DateTimeOffset]::UtcNow.ToString('o')
}
if ($BootstrapA) {
  $publication.Remove('bootstrapFrom')
} else {
  $publication.Remove('contract')
  $publication.Remove('bootstrapPhase')
}
$signed = New-OsShellEdgeSignedDocument -Document $publication -DocumentPath $publicationPath `
  -SignaturePath "$publicationPath.sig.json" -SigningKeyPath $SigningKey -KeyId $SigningKeyId
if (-not (Test-OsShellEdgeSignedDocument -DocumentPath $publicationPath -SignaturePath "$publicationPath.sig.json" `
  -TrustedPublicKeySpkiBase64 $signed.PublicKeySpkiBase64 -ExpectedKeyId $SigningKeyId)) { throw 'Backend publication signature failed.' }

Set-RemoteTag $repository $digest $releaseTag -Immutable
Set-RemoteTag $repository $digest 'edge'
if ($SkipDeploy) { Write-Host "[publication] $publicationPath"; return }

$deployer = Join-Path $detachedConsole 'scripts\Invoke-LocalEdgePlatformRelease.ps1'
if ((Get-OsShellSha256 -Bytes ([IO.File]::ReadAllBytes($deployer))) -cne [string]$tooling.deployer.sha256) {
  throw 'Detached deployer differs from the signed committed tooling evidence.'
}
if ($BootstrapA) {
  $detachedValidator = Join-Path $detachedConsole `
    'backend\opensphere-console-backend\platform-release-contract.js'
  if ((Get-OsShellSha256 -Bytes ([IO.File]::ReadAllBytes($detachedValidator))) -cne `
      [string]$tooling.bootstrapAValidator.sha256) {
    throw 'Detached Bootstrap A validator differs from the signed committed tooling evidence.'
  }
}
$apply = if ($BootstrapA) {
  & $deployer -BootstrapA -PublicationEvidence $publicationPath -Reason $Reason -Components @('backend') `
    -TrustedPublicKeySpkiBase64 $signed.PublicKeySpkiBase64 -ExpectedKeyId $SigningKeyId `
    -PlatformAuthorityPath $workspaceRoot -SetupAuthorityPath $setup.Path
} else {
  & $deployer -PublicationEvidence $publicationPath -Reason $Reason -Components @('backend')
}
if ($LASTEXITCODE -ne 0 -or [string]$apply.releaseDigest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Backend image phase failed.' }

$receiptPath = Join-Path $evidenceRoot 'opensphere-backend-component-deployment-receipt.json'
$receipt = [ordered]@{ contract=if ($BootstrapA) {
    'opensphere-console-backend-bootstrap-a-deployment-receipt/v1'
  } else { 'opensphere-console-backend-component-deployment-receipt/v2' }; requestIntent=$Reason
  sourceRevision=$console.Revision; setupSourceRevision=$setup.Revision; image=$exactImage; releaseDigest=[string]$apply.releaseDigest
  publicationSha256=$signed.DocumentSha256; migrationSetDigest=[string]$migration.setDigest
  latestMigrationId=[string]$migration.latestMigrationId
  phases=@([ordered]@{ action=if ($BootstrapA) { 'bootstrap-a' } else { 'apply' }; requestId=[string]$apply.requestId; mergeRevision=[string]$apply.mergeRevision; operationId=[string]$apply.operationId })
  convergenceState=if ($BootstrapA) { 'PendingConvergence' } else { 'Converged' }
  foundationFeatureGate=if ($BootstrapA) { 'Closed' } else { 'Open' }
  affectedImages=@('backend'); observedAt=[DateTimeOffset]::UtcNow.ToString('o') }
New-OsShellEdgeSignedDocument -Document $receipt -DocumentPath $receiptPath -SignaturePath "$receiptPath.sig.json" `
  -SigningKeyPath $SigningKey -KeyId $SigningKeyId | Out-Null
Write-Host "[receipt] $receiptPath"
} finally {
  Remove-DetachedTree $setup.Path $detachedSetup
  Remove-DetachedTree $console.Path $detachedConsole
  if (Test-Path -LiteralPath $detachedRoot) {
    Remove-Item -LiteralPath $detachedRoot -Force -Recurse
  }
}
