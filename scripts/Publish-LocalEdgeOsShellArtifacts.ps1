<#
  Component-only publisher for the two OS CLI artifacts.  The five-component
  publication passed as BasePublicationEvidence is an input contract, never a
  build descriptor: this script cannot rebuild or retag its three reused images.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BasePublicationEvidence,
  [switch]$UseExistingRegistryLogin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'local-edge-publication-core.psm1') -Force -ErrorAction Stop

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$registry = 'ghcr.io/opensphere-platform'
$canonicalOrigin = 'https://github.com/opensphere-platform/OpenSphere-console.git'
$canonicalSource = 'https://github.com/opensphere-platform/OpenSphere-console'
$artifactKeys = @('cliArtifacts', 'osShellRuntime')
$reusedKeys = @('console', 'backend', 'osShellControl')
$changedPathAllowlist = @(
  'backend/os-cli/Dockerfile', 'backend/os-cli/Dockerfile.runtime',
  'backend/os-cli/cmd/os/web_shell_agent.go', 'backend/os-cli/cmd/os/web_shell_agent_test.go',
  'scripts/local-edge-publication-core.psm1', 'scripts/local-edge-publication-core.test.mjs',
  'scripts/Publish-LocalEdge.ps1', 'scripts/Publish-LocalEdgeOsShellArtifacts.ps1',
  'scripts/os-shell-artifacts-publisher.test.mjs', 'scripts/Deploy-LocalEdgeOsShell.ps1',
  'backend/os-shell-control/deploy.test.js'
)

function Reject([string]$Message) { throw "OS Shell artifact publication rejected: $Message" }
function Read-Evidence([string]$Path) {
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  try { return [ordered]@{ path = $resolved; sha256 = Get-CanonicalTextSha256 -Path $resolved; value = (Get-Content -Raw -LiteralPath $resolved | ConvertFrom-Json) } }
  catch { Reject "base evidence is not valid JSON: $($_.Exception.Message)" }
}
function Assert-Text($Value, [string]$Path, [string]$Pattern = '') {
  if ($Value -isnot [string] -or ($Pattern -and $Value -notmatch $Pattern)) { Reject "$Path has an invalid type or value" }
}
function Assert-Integer($Value, [string]$Path) { if ($Value -isnot [int] -and $Value -isnot [long]) { Reject "$Path must be an integer" } }
function Assert-Boolean($Value, [string]$Path) { if ($Value -isnot [bool]) { Reject "$Path must be a boolean" } }
function Assert-StringArray($Value, [string]$Path, [string[]]$Expected) {
  if ($Value -isnot [Array] -or @($Value).Count -ne @($Expected).Count -or @(@($Value) | Where-Object { $_ -isnot [string] }).Count -or ((@($Value) -join "`0") -ne ($Expected -join "`0"))) { Reject "$Path must be the exact string array" }
}
function Assert-MigrationSchema($Value, [string]$Path) {
  Assert-ExactObjectKeys -Value $Value -Keys @('path','sha256','setDigest','latestMigrationId','migrationCount') -Path $Path
  Assert-Text $Value.path "$Path.path" '^backend/supabase/migrations/manifest[.]json$'; Assert-Text $Value.sha256 "$Path.sha256" '^sha256:[a-f0-9]{64}$'; Assert-Text $Value.setDigest "$Path.setDigest" '^sha256:[a-f0-9]{64}$'; Assert-Text $Value.latestMigrationId "$Path.latestMigrationId" '^\d{4}$'; Assert-Integer $Value.migrationCount "$Path.migrationCount"
}
function Assert-CliManifestSchema($Value, [string]$Path) {
  Assert-ExactObjectKeys -Value $Value -Keys @('image','imagePath','sha256','signatureAlgorithm','keyId') -Path $Path
  Assert-Text $Value.image "$Path.image" '^ghcr[.]io/opensphere-platform/opensphere-os-cli@sha256:[a-f0-9]{64}$'; Assert-Text $Value.imagePath "$Path.imagePath" '^/srv/index[.]json$'; Assert-Text $Value.sha256 "$Path.sha256" '^sha256:[a-f0-9]{64}$'; Assert-Text $Value.signatureAlgorithm "$Path.signatureAlgorithm" '^Ed25519$'; Assert-Text $Value.keyId "$Path.keyId" '^opensphere-cli-[a-z0-9-]+$'
}
function Assert-RuntimeBinarySchema($Value, [string]$Path) {
  Assert-ExactObjectKeys -Value $Value -Keys @('image','path','sha256') -Path $Path
  Assert-Text $Value.image "$Path.image" '^ghcr[.]io/opensphere-platform/opensphere-os-shell-runtime@sha256:[a-f0-9]{64}$'; Assert-Text $Value.path "$Path.path" '^/usr/local/bin/os$'; Assert-Text $Value.sha256 "$Path.sha256" '^sha256:[a-f0-9]{64}$'
}
function Assert-BaseEvidenceSchema($Value) {
  Assert-ExactObjectKeys -Value $Value -Keys @('apiVersion','kind','publicationScope','channel','status','releaseTag','immutableTag','source','sourceRevision','artifacts','buildAuthority','releaseClass','gaEligible','supportedPlatforms','components') -Path 'base'
  Assert-Text $Value.apiVersion 'base.apiVersion' '^release[.]opensphere[.]io/v1alpha1$'; Assert-Text $Value.kind 'base.kind' '^OpenSphereEdgeComponentPublication$'; Assert-Text $Value.publicationScope 'base.publicationScope' '^ComponentSet$'; Assert-Text $Value.channel 'base.channel' '^edge$'; Assert-Text $Value.status 'base.status' '^Active$'; Assert-Text $Value.releaseTag 'base.releaseTag' '^\d{12}$'; Assert-Text $Value.immutableTag 'base.immutableTag' '^local-[a-f0-9]{12}$'; Assert-Text $Value.source 'base.source' '^https://github[.]com/opensphere-platform/OpenSphere-console$'; Assert-Text $Value.sourceRevision 'base.sourceRevision' '^[a-f0-9]{40}$'; Assert-Text $Value.buildAuthority 'base.buildAuthority' '^localhost$'; Assert-Text $Value.releaseClass 'base.releaseClass' '^pre-ga$'; Assert-Boolean $Value.gaEligible 'base.gaEligible'; if ($Value.gaEligible) { Reject 'base.gaEligible must be false' }; Assert-StringArray $Value.supportedPlatforms 'base.supportedPlatforms' @('linux/amd64')
  Assert-ExactObjectKeys -Value $Value.components -Keys @('console','backend','cliArtifacts','osShellControl','osShellRuntime') -Path 'base.components'
  foreach ($entry in @(@{ key='console'; repo='opensphere-console'; inputs=$true },@{ key='backend'; repo='opensphere-console-backend'; inputs=$false },@{ key='cliArtifacts'; repo='opensphere-os-cli'; inputs=$false },@{ key='osShellControl'; repo='opensphere-console-os-shell-control'; inputs=$false },@{ key='osShellRuntime'; repo='opensphere-os-shell-runtime'; inputs=$false })) {
    $component = $Value.components.PSObject.Properties[$entry.key].Value; $keys = if ($entry.inputs) { @('repository','image','sourceRevision','inputs') } else { @('repository','image','sourceRevision') }
    Assert-ExactObjectKeys -Value $component -Keys $keys -Path "base.components.$($entry.key)"; Assert-Text $component.repository "base.components.$($entry.key).repository" "^$([regex]::Escape($entry.repo))$"; Assert-Text $component.image "base.components.$($entry.key).image" "^ghcr[.]io/opensphere-platform/$([regex]::Escape($entry.repo))@sha256:[a-f0-9]{64}$"; Assert-Text $component.sourceRevision "base.components.$($entry.key).sourceRevision" '^[a-f0-9]{40}$'
    if ($entry.inputs) { Assert-ExactObjectKeys -Value $component.inputs -Keys @('sdk') -Path 'base.components.console.inputs'; Assert-ExactObjectKeys -Value $component.inputs.sdk -Keys @('repository','sourceRevision') -Path 'base.components.console.inputs.sdk'; Assert-Text $component.inputs.sdk.repository 'base.components.console.inputs.sdk.repository' '^https://github[.]com/opensphere-platform/OpenSphere-SDK[.]git$'; Assert-Text $component.inputs.sdk.sourceRevision 'base.components.console.inputs.sdk.sourceRevision' '^[a-f0-9]{40}$' }
  }
  Assert-ExactObjectKeys -Value $Value.artifacts -Keys @('sdkSource','supabaseMigrationManifest','osShellRelease','osShellControlRelease') -Path 'base.artifacts'; Assert-ExactObjectKeys -Value $Value.artifacts.sdkSource -Keys @('repository','sourceRevision') -Path 'base.artifacts.sdkSource'; Assert-Text $Value.artifacts.sdkSource.repository 'base.artifacts.sdkSource.repository' '^https://github[.]com/opensphere-platform/OpenSphere-SDK[.]git$'; Assert-Text $Value.artifacts.sdkSource.sourceRevision 'base.artifacts.sdkSource.sourceRevision' '^[a-f0-9]{40}$'; Assert-MigrationSchema $Value.artifacts.supabaseMigrationManifest 'base.artifacts.supabaseMigrationManifest'
  Assert-ExactObjectKeys -Value $Value.artifacts.osShellRelease -Keys @('cliManifest','runtimeBinary','runtimeTemplate','sessionPolicyRevision','runtimeProcessPolicy') -Path 'base.artifacts.osShellRelease'; Assert-CliManifestSchema $Value.artifacts.osShellRelease.cliManifest 'base.artifacts.osShellRelease.cliManifest'; Assert-RuntimeBinarySchema $Value.artifacts.osShellRelease.runtimeBinary 'base.artifacts.osShellRelease.runtimeBinary'; Assert-Text $Value.artifacts.osShellRelease.sessionPolicyRevision 'base.artifacts.osShellRelease.sessionPolicyRevision' '^[A-Za-z0-9._-]+$'
  foreach ($releasePath in @('base.artifacts.osShellRelease','base.artifacts.osShellControlRelease')) { $release = if ($releasePath -match 'osShellRelease$') { $Value.artifacts.osShellRelease } else { $Value.artifacts.osShellControlRelease }; $keys = if ($releasePath -match 'osShellRelease$') { @('cliManifest','runtimeBinary','runtimeTemplate','sessionPolicyRevision','runtimeProcessPolicy') } else { @('runtimeTemplate','runtimeProcessPolicy') }; Assert-ExactObjectKeys -Value $release -Keys $keys -Path $releasePath; Assert-ExactObjectKeys -Value $release.runtimeTemplate -Keys @('path','sha256') -Path "$releasePath.runtimeTemplate"; Assert-Text $release.runtimeTemplate.path "$releasePath.runtimeTemplate.path" '^backend/os-shell-control/runtime-template[.]js$'; Assert-Text $release.runtimeTemplate.sha256 "$releasePath.runtimeTemplate.sha256" '^sha256:[a-f0-9]{64}$'; Assert-ExactObjectKeys -Value $release.runtimeProcessPolicy -Keys @('maxProcesses','globalPodLimit','userNamespacePolicy','enforcement') -Path "$releasePath.runtimeProcessPolicy"; Assert-Integer $release.runtimeProcessPolicy.maxProcesses "$releasePath.runtimeProcessPolicy.maxProcesses"; Assert-Integer $release.runtimeProcessPolicy.globalPodLimit "$releasePath.runtimeProcessPolicy.globalPodLimit"; Assert-Text $release.runtimeProcessPolicy.userNamespacePolicy "$releasePath.runtimeProcessPolicy.userNamespacePolicy" '^required-hostUsers-false$'; Assert-Text $release.runtimeProcessPolicy.enforcement "$releasePath.runtimeProcessPolicy.enforcement" '^linux-userns[+]rlimit-nproc[+]namespace-resourcequota$' }
}
function Get-ExactComponent($Evidence, [string]$Key, [string]$Repository) {
  $component = $Evidence.components.PSObject.Properties[$Key]
  if (-not $component) { Reject "base evidence omits $Key" }
  $value = $component.Value
  $expectedImagePattern = "^$([regex]::Escape("$registry/$Repository"))@(?<digest>sha256:[a-f0-9]{64})$"
  if ([string]$value.repository -ne $Repository -or [string]$value.image -notmatch $expectedImagePattern -or
      [string]$value.sourceRevision -notmatch '^[a-f0-9]{40}$') { Reject "base $Key identity is not canonical" }
  return $value
}
function Assert-ExactBaseImage($Component, [string]$Key, [string]$Repository, $Base) {
  $digest = [regex]::Match([string]$Component.image, '@(sha256:[a-f0-9]{64})$').Groups[1].Value
  Assert-LocalEdgeImageMetadata -Repository "$registry/$Repository" -Digest $digest `
    -ExpectedSourceRevision ([string]$Component.sourceRevision) -ExpectedReleaseTag ([string]$Base.releaseTag) `
    -ExpectedPlatform 'linux/amd64'
  return [ordered]@{ repository = $Repository; image = [string]$Component.image; digest = $digest; sourceRevision = [string]$Component.sourceRevision; releaseTag = [string]$Base.releaseTag; platform = 'linux/amd64' }
}
function Assert-RequiredOsShellBase($Base) {
  $release = $Base.artifacts.osShellRelease
  if (-not $release -or [string]$release.sessionPolicyRevision -notmatch '^[A-Za-z0-9._-]+$') { Reject 'base evidence has no canonical osShellRelease.sessionPolicyRevision' }
  if (-not $Base.artifacts.supabaseMigrationManifest -or [string]$Base.artifacts.supabaseMigrationManifest.sha256 -notmatch '^sha256:[a-f0-9]{64}$' -or [string]$Base.artifacts.supabaseMigrationManifest.setDigest -notmatch '^sha256:[a-f0-9]{64}$') { Reject 'base evidence has no canonical Supabase migration lineage' }
  return $release
}

# Fail closed before a mutable Docker operation.  Fetch is intentionally before
# source selection so origin/main is the audited canonical ref, not a stale one.
if ((& git -C $repoRoot remote get-url origin).Trim() -ne $canonicalOrigin) { Reject 'non-canonical origin' }
& git -C $repoRoot fetch --quiet origin main
if ($LASTEXITCODE -ne 0) { Reject 'cannot fetch canonical origin/main' }
if ((& git -C $repoRoot branch --show-current).Trim() -ne 'main') { Reject 'local branch must be main' }
$head = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($head -notmatch '^[a-f0-9]{40}$' -or $head -ne (& git -C $repoRoot rev-parse origin/main).Trim()) { Reject 'HEAD must equal origin/main' }
if (@(& git -C $repoRoot status --short).Count -ne 0) { Reject 'worktree must be clean' }
if ($env:OS -ne 'Windows_NT' -or (& docker info --format '{{.OSType}}').Trim() -ne 'linux' -or (& docker info --format '{{.Architecture}}').Trim() -notmatch '^(amd64|x86_64)$') { Reject 'requires Windows Docker Desktop linux/amd64' }
if (-not $UseExistingRegistryLogin) { Reject 'UseExistingRegistryLogin is required; this publisher never acquires registry credentials' }

$baseInput = Read-Evidence $BasePublicationEvidence
$base = $baseInput.value
Assert-BaseEvidenceSchema $base
if ([string]$base.kind -ne 'OpenSphereEdgeComponentPublication' -or [string]$base.publicationScope -ne 'ComponentSet' -or [string]$base.source -ne $canonicalSource -or [string]$base.sourceRevision -notmatch '^[a-f0-9]{40}$' -or [string]$base.releaseTag -notmatch '^\d{12}$' -or [string]$base.channel -ne 'edge') { Reject 'base evidence is not canonical five-component publication' }
if ((@($base.components.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'backend,cliArtifacts,console,osShellControl,osShellRuntime') { Reject 'base must contain exact five components' }
$baseOsShellRelease = Assert-RequiredOsShellBase $base
$reusedEvidence = [ordered]@{
  console = Assert-ExactBaseImage (Get-ExactComponent $base 'console' 'opensphere-console') 'console' 'opensphere-console' $base
  backend = Assert-ExactBaseImage (Get-ExactComponent $base 'backend' 'opensphere-console-backend') 'backend' 'opensphere-console-backend' $base
  osShellControl = Assert-ExactBaseImage (Get-ExactComponent $base 'osShellControl' 'opensphere-console-os-shell-control') 'osShellControl' 'opensphere-console-os-shell-control' $base
}

$changedPaths = @(& git -C $repoRoot diff --name-only ([string]$base.sourceRevision) $head | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
if (-not $changedPaths.Count -or @($changedPaths | Where-Object { $_ -notin $changedPathAllowlist }).Count) { Reject 'changed-path closure is outside artifact publisher authority' }
& git -C $repoRoot merge-base --is-ancestor ([string]$base.sourceRevision) $head
if ($LASTEXITCODE -ne 0) { Reject 'source revision is not a descendant of base publication' }
$identity = Get-LocalEdgeReleaseIdentity -RepositoryPath $repoRoot -SourceRevision $head
$releaseTag = [string]$identity.releaseTag

$items = @(
  [ordered]@{ key = 'cliArtifacts'; repository = 'opensphere-os-cli'; dockerfile = 'backend/os-cli/Dockerfile' },
  [ordered]@{ key = 'osShellRuntime'; repository = 'opensphere-os-shell-runtime'; dockerfile = 'backend/os-cli/Dockerfile.runtime' }
)
# A KST release tag is immutable.  Discover a collision before either build is
# admitted, so a bad caller cannot leave an otherwise usable digest orphaned.
foreach ($item in $items) {
  if (Get-RemoteDigest -Reference "$registry/$($item.repository):$releaseTag") { Reject "immutable KST tag already exists for $($item.key)" }
}
$digests = [ordered]@{}
foreach ($item in $items) {
  $repository = "$registry/$($item.repository)"
  # Keep the full local-edge OCI projection byte-for-byte equivalent to the
  # integrated publisher.  Runtime additionally consumes the visible release version.
  $buildArguments = @('buildx','build','--platform','linux/amd64','--push','--provenance=mode=max', '--tag', "$repository`:$($identity.immutableTag)", '--label','io.opensphere.channel=edge', '--label',"io.opensphere.source-revision=$head", '--label',"io.opensphere.release-tag=$releaseTag", '--label',"org.opencontainers.image.version=$releaseTag", '--label','opensphere.io/build-authority=localhost', '--label','opensphere.io/release-class=pre-ga', '--label','opensphere.io/ga-eligible=false', '--build-arg','CLI_UPDATE_SIGNING_PROFILE=local')
  if ($item.key -eq 'osShellRuntime') { $buildArguments += @('--build-arg', "OPENSPHERE_VERSION=$releaseTag") }
  $buildArguments += @('--file',(Join-Path $repoRoot $item.dockerfile),(Join-Path $repoRoot 'backend/os-cli'))
  Invoke-Checked docker @buildArguments
  $digest = Get-RemoteDigest -Reference "$repository`:$($identity.immutableTag)"
  if (-not $digest) { Reject "missing pushed digest for $($item.key)" }
  Assert-LocalEdgeImageMetadata -Repository $repository -Digest $digest -ExpectedSourceRevision $head -ExpectedReleaseTag $releaseTag -ExpectedPlatform 'linux/amd64'
  $digests[$item.key] = $digest
}

# Both immutable KST tags must be published and re-read before either mutable edge pointer moves.
foreach ($item in $items) { Set-RemoteTag -Repository "$registry/$($item.repository)" -Digest $digests[$item.key] -Tag $releaseTag -Immutable }
foreach ($item in $items) { if ((Get-RemoteDigest -Reference "$registry/$($item.repository):$releaseTag") -ne $digests[$item.key]) { Reject "KST immutable tag verification failed for $($item.key)" } }
foreach ($item in $items) { Set-RemoteTag -Repository "$registry/$($item.repository)" -Digest $digests[$item.key] -Tag 'edge' }
foreach ($item in $items) { if ((Get-RemoteDigest -Reference "$registry/$($item.repository):edge") -ne $digests[$item.key]) { Reject "edge tag verification failed for $($item.key)" } }

$evidenceRoot = Join-Path ([IO.Path]::GetTempPath()) "opensphere-os-shell-artifacts-$($head.Substring(0,12))-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $evidenceRoot -ErrorAction Stop | Out-Null
$publicationWritten = $false
try {
  $cliImage = "$registry/opensphere-os-cli@$($digests.cliArtifacts)"; $runtimeImage = "$registry/opensphere-os-shell-runtime@$($digests.osShellRuntime)"
  $cliContainer = "opensphere-os-cli-evidence-$([guid]::NewGuid().ToString('N'))"; $runtimeContainer = "opensphere-os-runtime-evidence-$([guid]::NewGuid().ToString('N'))"
  try {
    Invoke-Checked docker create --name $cliContainer $cliImage; Invoke-Checked docker create --name $runtimeContainer $runtimeImage
    Invoke-Checked docker cp "${cliContainer}:/srv/index.json" (Join-Path $evidenceRoot 'index.json'); Invoke-Checked docker cp "${runtimeContainer}:/usr/local/bin/os" (Join-Path $evidenceRoot 'os')
  } finally { & docker container rm $cliContainer 2>$null | Out-Null; & docker container rm $runtimeContainer 2>$null | Out-Null }
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $evidenceRoot 'index.json') | ConvertFrom-Json
  $linuxAmd64 = @($manifest.links | Where-Object { [string]$_.os -eq 'linux' -and [string]$_.arch -eq 'amd64' }); $runtimeSha = Get-FileSha256 -Path (Join-Path $evidenceRoot 'os')
  if ($linuxAmd64.Count -ne 1 -or [string]$linuxAmd64[0].sha256 -ne $runtimeSha.Replace('sha256:','') -or [string]$manifest.signature.algorithm -ne 'Ed25519' -or [string]$manifest.signature.keyId -notmatch '^opensphere-cli-[a-z0-9-]+$') { Reject 'signed manifest linux binary SHA differs from runtime binary or signature profile is not closed' }
  $publication = [ordered]@{
    apiVersion = 'release.opensphere.io/v1alpha1'; kind = 'OpenSphereEdgeComponentPublication'; publicationScope = 'ComponentSet'; channel = 'edge'; status = 'Active'; source = $canonicalSource; sourceRevision = $head; releaseTag = $releaseTag; immutableTag = [string]$identity.immutableTag; buildAuthority = 'localhost'; releaseClass = 'pre-ga'; gaEligible = $false; supportedPlatforms = @('linux/amd64')
    basePublication = [ordered]@{ pathSha256 = $baseInput.sha256; sourceRevision = [string]$base.sourceRevision; releaseTag = [string]$base.releaseTag; sessionPolicyRevision = [string]$baseOsShellRelease.sessionPolicyRevision; reused = $reusedEvidence }
    components = [ordered]@{ cliArtifacts = [ordered]@{ repository = 'opensphere-os-cli'; image = $cliImage; sourceRevision = $head }; osShellRuntime = [ordered]@{ repository = 'opensphere-os-shell-runtime'; image = $runtimeImage; sourceRevision = $head } }
    changedPaths = $changedPaths; affectedImages = $artifactKeys; reusedImages = $reusedKeys; releaseScope = 'component'; fullReleaseJustification = $null
    artifacts = [ordered]@{ supabaseMigrationManifest = $base.artifacts.supabaseMigrationManifest; osShellRelease = [ordered]@{ cliManifest = [ordered]@{ image = $cliImage; imagePath = '/srv/index.json'; sha256 = Get-FileSha256 -Path (Join-Path $evidenceRoot 'index.json'); signatureAlgorithm = [string]$manifest.signature.algorithm; keyId = [string]$manifest.signature.keyId }; runtimeBinary = [ordered]@{ image = $runtimeImage; path = '/usr/local/bin/os'; sha256 = $runtimeSha }; sessionPolicyRevision = [string]$baseOsShellRelease.sessionPolicyRevision; baseSessionPolicyRevision = [string]$baseOsShellRelease.sessionPolicyRevision } }
  }
  $outputPath = Join-Path $evidenceRoot 'opensphere-os-shell-artifacts-publication.json'
  $publication | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $outputPath -Encoding utf8
  $publicationWritten = $true
  Write-Output $outputPath
} finally {
  if (-not $publicationWritten -and (Test-Path -LiteralPath $evidenceRoot)) {
    $resolvedEvidenceRoot = [IO.Path]::GetFullPath($evidenceRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedEvidenceRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedEvidenceRoot) -notmatch '^opensphere-os-shell-artifacts-[a-f0-9]{12}-[a-f0-9]{32}$') {
      throw "Refusing to remove unverified failed publication evidence directory: $resolvedEvidenceRoot"
    }
    Remove-Item -LiteralPath $resolvedEvidenceRoot -Recurse -Force
  }
}
