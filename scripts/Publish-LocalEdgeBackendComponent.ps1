#requires -Version 7.2
<#
  Closed PFSS component publisher.  Despite the historical Setup contract
  name, this script is intentionally limited to the Backend and OAA Gateway
  pair; it must never become a generic Console publisher.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$BaseSourceRevision,
  [Parameter(Mandatory)][string]$SetupSourcePath,
  [Parameter(Mandatory)][string]$PlatformSourcePath,
  [Parameter(Mandatory)][string]$SigningKey,
  [switch]$UseExistingRegistryLogin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'local-edge-publication-core.psm1') -Force -ErrorAction Stop
. (Join-Path $PSScriptRoot 'os-shell-edge-signing.ps1')

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$registry = 'ghcr.io/opensphere-platform'
$canonicalOrigin = 'https://github.com/opensphere-platform/OpenSphere-console.git'
$componentKeys = @('backend', 'oaaGateway')
$sourceAllowlist = @(
  'backend/opensphere-console-backend/r2d2-durable-operation.js',
  'backend/opensphere-console-backend/r2d2-operation-api.js',
  'backend/opensphere-console-oaa-gateway/server.js',
  'scripts/Publish-LocalEdgeBackendComponent.ps1',
  'scripts/Deploy-LocalEdgeBackendComponent.ps1',
  'backend/opensphere-console-backend/platform-release-contract.js',
  'backend/opensphere-console-backend/server.js',
  'backend/opensphere-console-backend/platform-release-executor.mjs',
  'backend/opensphere-console-backend/platform-release.test.js',
  'scripts/pfss-component-publisher.test.mjs',
  'scripts/pfss-component-deployer.test.mjs'
)

function Reject([string]$Message) { throw "PFSS component publication rejected: $Message" }
function Get-TextSha256([string]$Text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Assert-CleanCanonicalMain([string]$Path, [string]$Origin, [string]$Label) {
  if ((& git -C $Path remote get-url origin).Trim() -ne $Origin) { Reject "$Label origin is not canonical" }
  & git -C $Path fetch --quiet origin main
  if ($LASTEXITCODE -ne 0) { Reject "$Label cannot fetch origin/main" }
  if ((& git -C $Path branch --show-current).Trim() -ne 'main') { Reject "$Label branch must be main" }
  if ((& git -C $Path rev-parse HEAD).Trim() -ne (& git -C $Path rev-parse origin/main).Trim()) { Reject "$Label HEAD must equal origin/main" }
  if (@(& git -C $Path status --short).Count -ne 0) { Reject "$Label worktree must be clean" }
}

Assert-CleanCanonicalMain $repoRoot $canonicalOrigin 'Console'
if (-not $UseExistingRegistryLogin) { Reject 'UseExistingRegistryLogin is required; this publisher never acquires registry credentials' }
if ($env:OS -ne 'Windows_NT' -or (& docker info --format '{{.OSType}}').Trim() -ne 'linux') { Reject 'requires Windows Docker Desktop linux containers' }
$head = (& git -C $repoRoot rev-parse HEAD).Trim()
& git -C $repoRoot merge-base --is-ancestor $BaseSourceRevision $head
if ($LASTEXITCODE -ne 0) { Reject 'BaseSourceRevision is not an ancestor of canonical main' }
$changedPaths = @(& git -C $repoRoot diff --name-only $BaseSourceRevision $head | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if (-not $changedPaths.Count -or @($changedPaths | Where-Object { $_ -notin $sourceAllowlist }).Count) { Reject 'changed-path closure affects a source outside the PFSS two-image authority' }

$setupRoot = (Resolve-Path $SetupSourcePath).Path
if (@(& git -C $setupRoot status --short).Count -ne 0) { Reject 'Setup source must be clean' }
$setupLockPath = Join-Path $repoRoot 'backend/opensphere-console-backend/setup-source.lock'
$setupRevision = (Get-Content -Raw $setupLockPath).Trim()
if (($setupRevision -notmatch '^[a-f0-9]{40}$') -or $setupRevision -ne (& git -C $setupRoot rev-parse HEAD).Trim()) { Reject 'Setup source must equal backend setup-source.lock' }
$platformRoot = (Resolve-Path $PlatformSourcePath).Path
if (@(& git -C $platformRoot status --short).Count -ne 0) { Reject 'Platform source must be clean' }
$platformRevision = (& git -C $platformRoot rev-parse HEAD).Trim()
$inventoryPath = Join-Path $platformRoot 'repository-inventory.json'
if (-not (Test-Path $inventoryPath)) { Reject 'Platform repository inventory is unavailable' }

$identity = Get-LocalEdgeReleaseIdentity -RepositoryPath $repoRoot -SourceRevision $head
$releaseTag = [string]$identity.releaseTag
$items = @(
  [ordered]@{ key='backend'; repository='opensphere-console-backend'; context=(Join-Path $repoRoot 'backend'); dockerfile=(Join-Path $repoRoot 'backend/opensphere-console-backend/Dockerfile') },
  [ordered]@{ key='oaaGateway'; repository='opensphere-console-oaa-gateway'; context=(Join-Path $repoRoot 'backend/opensphere-console-oaa-gateway'); dockerfile=(Join-Path $repoRoot 'backend/opensphere-console-oaa-gateway/Dockerfile') }
)
foreach ($item in $items) { if (Get-RemoteDigest -Reference "$registry/$($item.repository):$releaseTag") { Reject "immutable KST tag already exists for $($item.key)" } }
$digests = [ordered]@{}
foreach ($item in $items) {
  $repository = "$registry/$($item.repository)"
  $arguments = @('buildx','build','--platform','linux/amd64','--push','--provenance=mode=max','--tag',"$repository`:$($identity.immutableTag)", '--label','io.opensphere.channel=edge','--label',"io.opensphere.source-revision=$head",'--label',"io.opensphere.release-tag=$releaseTag",'--label',"org.opencontainers.image.version=$releaseTag",'--label','org.opencontainers.image.source=https://github.com/opensphere-platform/OpenSphere-console','--label','opensphere.io/build-authority=localhost','--label','opensphere.io/release-class=pre-ga','--label','opensphere.io/ga-eligible=false','--file',$item.dockerfile)
  if ($item.key -eq 'backend') { $arguments += @('--build-context',"setup-cli=$setupRoot",'--build-arg',"SETUP_SOURCE_REVISION=$setupRevision") }
  $arguments += $item.context
  Invoke-Checked docker @arguments
  $digest = Get-RemoteDigest -Reference "$repository`:$($identity.immutableTag)"
  if (-not $digest) { Reject "missing pushed digest for $($item.key)" }
  Assert-LocalEdgeImageMetadata -Repository $repository -Digest $digest -ExpectedSourceRevision $head -ExpectedReleaseTag $releaseTag -ExpectedPlatform 'linux/amd64'
  $digests[$item.key] = $digest
}
foreach ($item in $items) { Set-RemoteTag -Repository "$registry/$($item.repository)" -Digest $digests[$item.key] -Tag $releaseTag -Immutable }
foreach ($item in $items) { Set-RemoteTag -Repository "$registry/$($item.repository)" -Digest $digests[$item.key] -Tag 'edge' }

$migration = Get-Content -Raw (Join-Path $repoRoot 'backend/supabase/migrations/manifest.json') | ConvertFrom-Json
if ([string]$migration.setDigest -notmatch '^sha256:[a-f0-9]{64}$') { Reject 'Supabase migration manifest setDigest is invalid' }
$publication = [ordered]@{
  apiVersion='release.opensphere.io/v1alpha1'; kind='OpenSphereEdgeComponentPublication'; publicationScope='ComponentSet'; channel='edge'; status='Active'; source='https://github.com/opensphere-platform/OpenSphere-console'; sourceRevision=$head; releaseTag=$releaseTag; immutableTag=[string]$identity.immutableTag; buildAuthority='localhost'; releaseClass='pre-ga'; gaEligible=$false; supportedPlatforms=@('linux/amd64')
  components=[ordered]@{
    backend=[ordered]@{ repository='opensphere-console-backend'; image="$registry/opensphere-console-backend@$($digests.backend)"; sourceRevision=$head }
    oaaGateway=[ordered]@{ repository='opensphere-console-oaa-gateway'; image="$registry/opensphere-console-oaa-gateway@$($digests.oaaGateway)"; sourceRevision=$head }
  }
  changedPaths=$changedPaths; affectedImages=$componentKeys; releaseScope='component'; fullReleaseJustification=$null
}
$out = Join-Path ([IO.Path]::GetTempPath()) "opensphere-pfss-components-$($head.Substring(0,12))-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $out -ErrorAction Stop | Out-Null
$documentPath = Join-Path $out 'publication.json'; $signaturePath = Join-Path $out 'publication.signature.json'
$signed = New-OsShellEdgeSignedDocument -Document $publication -DocumentPath $documentPath -SignaturePath $signaturePath -SigningKeyPath $SigningKey
$publisherPath = 'scripts/Publish-LocalEdgeBackendComponent.ps1'
$publisherBlob = (& git -C $repoRoot rev-parse "HEAD:$publisherPath").Trim()
$setupProjectionPath = Join-Path $setupRoot 'src/release.mjs'
$setupProjectionBlob = (& git -C $setupRoot rev-parse "$setupRevision`:src/release.mjs").Trim()
$verificationInputs = @($sourceAllowlist | Sort-Object | ForEach-Object { "$($_):$(Get-CanonicalTextSha256 (Join-Path $repoRoot $_))" }) -join "`n"
$binding = [ordered]@{
  contract='opensphere-edge-component-publication-binding/v1'; publisher=$publisherPath; publisherGitBlob=$publisherBlob; publisherSha256=(Get-CanonicalTextSha256 (Join-Path $repoRoot $publisherPath)); documentSha256=$signed.DocumentSha256; signatureSha256=$signed.SignatureSha256; keyId='opensphere-edge-local-v1'; setupSourceRevision=$setupRevision; setupSourceLockSha256=(Get-CanonicalTextSha256 $setupLockPath); setupManifestProjectionGitBlob=$setupProjectionBlob; setupManifestProjectionSha256=(Get-CanonicalTextSha256 $setupProjectionPath); migrationSetDigest=[string]$migration.setDigest; platformRevision=$platformRevision; inventorySha256=(Get-CanonicalTextSha256 $inventoryPath); verificationSetDigest=(Get-TextSha256 $verificationInputs)
}
$bindingPath = Join-Path $out 'component-publication-binding.json'
$binding | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $bindingPath -Encoding utf8
[pscustomobject]@{ publication=$documentPath; signature=$signaturePath; binding=$bindingPath; affectedImages=$componentKeys; sourceRevision=$head }
