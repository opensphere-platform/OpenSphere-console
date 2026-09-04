[CmdletBinding()]
param(
  [string]$Registry = 'ghcr.io/opensphere-platform',
  [string]$SourceRevision = '',
  [string]$Platform = '',
  [string]$SetupRepository = 'https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git',
  [string]$SetupSourcePath = '',
  [string]$CliUpdateSigningKeyPath = '',
  [string]$CliUpdateSigningKeyId = 'opensphere-cli-local-dev-v1',
  [string]$CliUpdateSigningPublicKey = '',
  [switch]$UseExistingRegistryLogin,
  [switch]$DeferChannelPromotion,
  [switch]$AdvanceOsShellUxConsoleEdge,
  [ValidateSet('console', 'consoleApi', 'extensionController', 'registry', 'osaaGateway', 'osdst', 'osaaGovernedAdapter', 'notificationDispatcher', 'gitea', 'supabasePostgres', 'supabaseAuth', 'supabaseRest', 'supabaseStorage', 'giteaPostgres', 'recovery', 'beszelHub', 'beszelAgent', 'beszelBootstrap', 'cliArtifacts', 'osShellControl', 'osShellRuntime', 'consoleIndexContent', 'backend')]
  [string[]]$Components = @('console', 'consoleApi', 'extensionController', 'registry', 'osaaGateway', 'osdst', 'osaaGovernedAdapter', 'notificationDispatcher', 'gitea', 'supabasePostgres', 'supabaseAuth', 'supabaseRest', 'supabaseStorage', 'giteaPostgres', 'recovery', 'beszelHub', 'beszelAgent', 'beszelBootstrap', 'cliArtifacts', 'osShellControl', 'osShellRuntime', 'consoleIndexContent')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$componentMode = $PSBoundParameters.ContainsKey('Components')
if ($DeferChannelPromotion -and $componentMode) {
  throw 'Deferred promotion requires a complete Console release.'
}

function Invoke-Checked {
  if ($args.Count -lt 1) {
    throw 'Invoke-Checked requires an executable.'
  }
  $executable = [string]$args[0]
  $arguments = @($args | Select-Object -Skip 1)
  & $executable @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$executable failed with exit code $LASTEXITCODE"
  }
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

function Get-RemoteDigest {
  param([Parameter(Mandatory)][string]$Reference)

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # A missing tag is the expected first-publication state. Windows
    # PowerShell can promote native stderr to a terminating ErrorRecord while
    # the script-wide preference is Stop, so inspect it under Continue and
    # decide from the native exit code below.
    $ErrorActionPreference = 'Continue'
    $output = & docker buildx imagetools inspect $Reference 2>$null
    $inspectExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($inspectExitCode -ne 0) {
    return $null
  }
  $line = $output | Where-Object { $_ -match '^Digest:\s+(sha256:[0-9a-f]{64})$' } | Select-Object -First 1
  if (-not $line) {
    throw "Could not parse registry digest for $Reference"
  }
  return ([regex]::Match($line, 'sha256:[0-9a-f]{64}')).Value
}

function Set-RemoteTag {
  param(
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$Digest,
    [Parameter(Mandatory)][string]$Tag,
    [switch]$Immutable
  )

  $target = "${Repository}:$Tag"
  $existing = Get-RemoteDigest -Reference $target
  if ($Immutable -and $existing -and $existing -ne $Digest) {
    throw "Immutable tag collision: $target is $existing, expected $Digest"
  }
  if ($existing -ne $Digest) {
    # A single-platform local edge digest must remain the tag digest. Without
    # --prefer-index=false Buildx wraps it in a new OCI index and silently
    # violates the immutable digest recorded in the release BOM.
    Invoke-Checked docker buildx imagetools create --prefer-index=false --tag $target "${Repository}@${Digest}"
  }
  $actual = Get-RemoteDigest -Reference $target
  if ($actual -ne $Digest) {
    throw "Tag verification failed: $target is $actual, expected $Digest"
  }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $SourceRevision) {
  $SourceRevision = (& git -C $repoRoot rev-parse HEAD).Trim()
}
if ($SourceRevision -notmatch '^[0-9a-f]{40}$') {
  throw 'SourceRevision must be a full lowercase Git commit.'
}

if ($env:OS -ne 'Windows_NT') {
  throw 'Local edge publishing is supported only from the Windows amd64 Docker Desktop development host.'
}

$kubeContext = (& kubectl config current-context).Trim()
if ($kubeContext -ne 'docker-desktop') {
  throw "Local edge deployment requires Kubernetes context docker-desktop; received: $kubeContext"
}
$nodeInventory = & kubectl get nodes -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) {
  throw "kubectl get nodes failed with exit code $LASTEXITCODE"
}
$nodeArchitectures = @($nodeInventory.items | ForEach-Object {
  [string]$_.status.nodeInfo.architecture
}) | Where-Object { $_ }
if (-not $nodeArchitectures -or ($nodeArchitectures | Where-Object { $_ -ne 'amd64' })) {
  throw "Every docker-desktop Kubernetes node must be amd64; received: $($nodeArchitectures -join ',')"
}

if (-not $Platform) {
  $dockerOs = (& docker info --format '{{.OSType}}').Trim().ToLowerInvariant()
  $dockerArch = (& docker info --format '{{.Architecture}}').Trim().ToLowerInvariant()
  $dockerArch = switch ($dockerArch) {
    'x86_64' { 'amd64' }
    'aarch64' { 'arm64' }
    default { $dockerArch }
  }
  $Platform = "$dockerOs/$dockerArch"
}
if ($Platform -ne 'linux/amd64') {
  throw "Windows local edge requires exactly linux/amd64; received: $Platform"
}

$dirty = & git -C $repoRoot status --short
if ($dirty) {
  throw 'The Console worktree must be clean before publishing local edge.'
}
# The current legacy Backend image and installer still execute the numeric
# backend/supabase lineage. Publishing that image under the fresh global
# lineage would create false release evidence, so stop before workspace setup,
# registry login, build, push, or tag movement.
if ($Components -contains 'backend') {
  throw 'Backend component publication is blocked until its runtime installer consumes the fresh Console migration lineage.'
}
$resolvedCliSigningKey = ''
if ($Components -contains 'cliArtifacts') {
  if (-not $CliUpdateSigningKeyPath -or -not (Test-Path -LiteralPath $CliUpdateSigningKeyPath)) {
    throw 'CLI local-edge publication requires a host-local Ed25519 private-key path.'
  }
  if (-not $CliUpdateSigningPublicKey) {
    throw 'CLI local-edge publication requires the matching SPKI DER public key in base64.'
  }
  $resolvedCliSigningKey = (Resolve-Path -LiteralPath $CliUpdateSigningKeyPath).Path
  if ($resolvedCliSigningKey.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'CLI local-edge signing key must be stored outside the source repository.'
  }
}

# This is the governed release family, not Setup's smaller bootstrapCore subset.
$canonicalComponentKeys = @(
  'console', 'consoleApi', 'extensionController', 'registry',
  'osaaGateway', 'osdst', 'osaaGovernedAdapter', 'notificationDispatcher',
  'gitea', 'supabasePostgres', 'supabaseAuth', 'supabaseRest', 'supabaseStorage',
  'giteaPostgres', 'recovery', 'beszelHub', 'beszelAgent', 'beszelBootstrap'
)
$auxiliaryComponentKeys = @('cliArtifacts', 'osShellControl', 'osShellRuntime', 'consoleIndexContent')
$completeReleaseComponentKeys = @($canonicalComponentKeys + $auxiliaryComponentKeys)
$requestedForGate = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($component in $Components) { [void]$requestedForGate.Add($component) }
$integratedRequest = $requestedForGate.Count -eq $completeReleaseComponentKeys.Count -and
  @($completeReleaseComponentKeys | Where-Object { -not $requestedForGate.Contains($_) }).Count -eq 0
# The Console edge anchor may move only after the full governed artifact set
# exists at one immutable revision. The explicit OS Shell UX exception retains
# the stricter full release-ready gate and cannot use the bootstrap profile.
$canonicalAnchorMayMove = $integratedRequest -or $AdvanceOsShellUxConsoleEdge

$epochText = (& git -C $repoRoot show -s --format=%ct $SourceRevision).Trim()
if ($epochText -notmatch '^\d+$') {
  throw "Could not resolve commit timestamp for $SourceRevision"
}
$seoulOffset = [TimeSpan]::FromHours(9)
$releaseTag = [DateTimeOffset]::FromUnixTimeSeconds([long]$epochText).ToOffset($seoulOffset).ToString('yyyyMMddHHmm')
$localTag = "local-$($SourceRevision.Substring(0, 12))"

$platformRoot = Split-Path $repoRoot -Parent
$workspaceSuffix = $DeferChannelPromotion ? '-staged' : ''
$workspace = Join-Path $platformRoot ".codex-tmp\local-edge-$($SourceRevision.Substring(0, 12))$workspaceSuffix"
$consoleCheckout = Join-Path $workspace 'OpenSphere-console'
$setupCheckout = Join-Path $workspace 'OpenSphere-Setup-CLI'
$metadataRoot = Join-Path $workspace 'metadata'

if (Test-Path -LiteralPath $workspace) {
  throw "Local edge workspace already exists: $workspace"
}
New-Item -ItemType Directory -Path $workspace, $metadataRoot | Out-Null

Write-Host "[start] Local OpenSphere edge publish"
Write-Host "[source] $SourceRevision"
Write-Host "[release] $releaseTag"
Write-Host "[immutable] $localTag"
Write-Host "[platform] $Platform"
Write-Host "[policy] build-authority=localhost, release-class=pre-ga, ga-eligible=false"

Write-Host '[step 01/06] Prepare clean Console and governed Setup source'
Invoke-Checked git -C $repoRoot worktree add --detach $consoleCheckout $SourceRevision
# Every publication validates repository contracts in the clean checkout.
# A complete BOM, or any exception that can move Console:edge, additionally
# proves the release-ready boundary before registry authentication or build.
Push-Location $consoleCheckout
try {
  # The detached checkout has no node_modules. Resolve only the committed lockfile;
  # lifecycle scripts are unnecessary for the read-only contract and migration gates.
  Invoke-Checked npm.cmd ci --ignore-scripts --no-audit --no-fund | Out-Null
  Invoke-Checked node scripts/verify-manual-seed.mjs | Out-Null
  $contractArguments = @('scripts/verify-console-contracts.mjs')
  if ($integratedRequest) {
    $contractArguments += @('--release-ready', '--release-profile=bootstrap-core')
  } elseif ($AdvanceOsShellUxConsoleEdge) {
    $contractArguments += '--release-ready'
  }
  Invoke-Checked node @contractArguments | Out-Null
} finally {
  Pop-Location
}
$migrationManifestPath = Join-Path $consoleCheckout 'migrations\manifest.json'
if (-not (Test-Path -LiteralPath $migrationManifestPath)) {
  throw "Fresh Console migration manifest is missing: $migrationManifestPath"
}
Invoke-Checked node (Join-Path $consoleCheckout 'scripts\console-migrations.mjs') verify | Out-Null
$migrationManifest = Get-Content -Raw -LiteralPath $migrationManifestPath | ConvertFrom-Json
if ($migrationManifest.schemaVersion -ne 1 -or
    [string]$migrationManifest.repository -ne 'OpenSphere-Console' -or
    [string]$migrationManifest.setDigest -notmatch '^sha256:[0-9a-f]{64}$' -or
    [string]$migrationManifest.latestGlobalId -notmatch '^opensphere-console/[0-9]{8}/[0-9]{4}$' -or
    [int]$migrationManifest.migrationCount -ne @($migrationManifest.migrations).Count) {
  throw 'Fresh Console migration manifest evidence is not canonical'
}
$backendSelected = $Components.Count -eq 0 -or $Components -contains 'backend'
$setupSourceRevision = ''
if ($backendSelected) {
  if ($SetupSourcePath) {
    $resolvedSetupSource = (Resolve-Path -LiteralPath $SetupSourcePath).Path
    $setupDirty = & git -C $resolvedSetupSource status --short
    if ($LASTEXITCODE -ne 0 -or $setupDirty) {
      throw 'SetupSourcePath must be a clean governed Setup CLI Git worktree.'
    }
    $setupSourceRevision = (& git -C $resolvedSetupSource rev-parse HEAD).Trim()
    Invoke-Checked git -C $resolvedSetupSource worktree add --detach $setupCheckout $setupSourceRevision
  } else {
    Invoke-Checked git clone --depth 1 --branch main $SetupRepository $setupCheckout
    $setupSourceRevision = (& git -C $setupCheckout rev-parse HEAD).Trim()
  }
  if ($setupSourceRevision -notmatch '^[0-9a-f]{40}$') {
    throw 'SetupSourceRevision must resolve to a full lowercase Git commit.'
  }
  $setupSourceLockPath = Join-Path $consoleCheckout 'apps\console-api\runtime\setup-source.lock'
  $expectedSetupSourceRevision = (Get-Content -LiteralPath $setupSourceLockPath -Raw).Trim()
  if ($expectedSetupSourceRevision -notmatch '^[0-9a-f]{40}$') {
    throw 'The governed Backend setup-source.lock is invalid.'
  }
  if ($setupSourceRevision -ne $expectedSetupSourceRevision) {
    throw "Setup source revision $setupSourceRevision differs from governed lock $expectedSetupSourceRevision."
  }
  Write-Host "[setup] $setupSourceRevision"
}

function Assert-LocalEdgeImageMetadata {
  param(
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$Digest,
    [Parameter(Mandatory)][string]$ExpectedSourceRevision,
    [Parameter(Mandatory)][string]$ExpectedReleaseTag,
    [Parameter(Mandatory)][string]$ExpectedPlatform,
    [Parameter(Mandatory)][ValidateSet('canonical', 'auxiliary')][string]$ExpectedReleaseScope
  )

  $reference = "${Repository}@${Digest}"
  $raw = & docker buildx imagetools inspect --format '{{json .Image}}' $reference
  if ($LASTEXITCODE -ne 0) {
    throw "OCI metadata inspection failed for $reference"
  }
  try {
    $image = ($raw -join "`n") | ConvertFrom-Json
  } catch {
    throw "OCI metadata inspection returned invalid JSON for ${reference}: $($_.Exception.Message)"
  }
  $actualPlatform = "$([string]$image.os)/$([string]$image.architecture)"
  if ($actualPlatform -ne $ExpectedPlatform) {
    throw "OCI platform mismatch for ${reference}: $actualPlatform, expected $ExpectedPlatform"
  }
  $expectedLabels = [ordered]@{
    'io.opensphere.channel' = 'edge'
    'io.opensphere.release-scope' = $ExpectedReleaseScope
    'io.opensphere.source-revision' = $ExpectedSourceRevision
    'io.opensphere.release-tag' = $ExpectedReleaseTag
    'org.opencontainers.image.version' = $ExpectedReleaseTag
    'org.opencontainers.image.source' = 'https://github.com/opensphere-platform/OpenSphere-console'
    'opensphere.io/build-authority' = 'localhost'
    'opensphere.io/release-class' = 'pre-ga'
    'opensphere.io/ga-eligible' = 'false'
  }
  foreach ($entry in $expectedLabels.GetEnumerator()) {
    $property = $image.config.Labels.PSObject.Properties[$entry.Key]
    $actual = if ($property) { [string]$property.Value } else { '' }
    if ($actual -ne [string]$entry.Value) {
      throw "OCI label mismatch for ${reference}: $($entry.Key)='$actual', expected '$($entry.Value)'"
    }
  }
  $remoteDigest = Get-RemoteDigest -Reference $reference
  if ($remoteDigest -ne $Digest) {
    throw "OCI digest mismatch for ${reference}: $remoteDigest, expected $Digest"
  }
  Write-Host "[preflight] $reference OCI metadata and $ExpectedPlatform platform verified (not a startup probe)"
}

Write-Host '[step 02/06] Declare the CLI platforms this host can build'
# The macOS CLI reaches the Keychain through cgo against Security.framework, so it
# is compiled natively by the GA workflow and no Windows host can produce it.
# Recycling the darwin binaries out of the previous edge image made every Console
# change depend on cmd/os-cli being untouched, and an unrelated CLI commit
# blocked a frontend fix from reaching docker-desktop. Edge now builds the
# platforms this host owns and the generated CLI manifest names the ones it
# omitted, so nothing claims a macOS artifact that was never rebuilt.
Write-Host '[cli] linux/amd64 and windows/amd64 are cross-built here; darwin is release-only'

Write-Host '[step 03/06] Confirm GHCR authentication mode'
if ($UseExistingRegistryLogin) {
  Write-Host '[auth] Reusing the existing Docker credential for ghcr.io'
} else {
  $registryActor = (& gh api user --jq .login).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $registryActor) {
    throw 'GitHub CLI did not return the authenticated registry actor.'
  }
  $token = (& gh auth token).Trim()
  if (-not $token) {
    throw 'GitHub CLI did not return an authentication token.'
  }
  try {
    $token | docker login ghcr.io -u $registryActor --password-stdin
    if ($LASTEXITCODE -ne 0) {
      throw "docker login failed with exit code $LASTEXITCODE"
    }
  } finally {
    Remove-Variable token
  }
}

$allImages = @(
  # The canonical release family covers Setup's governed install catalog;
  # bootstrapCore is a required subset selected by Setup. Keep
  # this list ordered and complete so the Console anchor always represents one
  # exact 18-component BOM.
  [ordered]@{ Key = 'console'; Image = 'opensphere-console'; Context = $consoleCheckout; File = (Join-Path $consoleCheckout 'apps\console-web\Dockerfile') },
  [ordered]@{ Key = 'consoleApi'; Image = 'opensphere-console-api'; Context = $consoleCheckout; File = (Join-Path $consoleCheckout 'apps\console-api\Dockerfile') },
  [ordered]@{ Key = 'extensionController'; Image = 'opensphere-extension-controller'; Context = $consoleCheckout; File = (Join-Path $consoleCheckout 'apps\extension-controller\Dockerfile') },
  [ordered]@{ Key = 'registry'; Image = 'opensphere-registry'; Context = (Join-Path $consoleCheckout 'backend\registry'); File = (Join-Path $consoleCheckout 'backend\registry\deploy\Dockerfile') },
  [ordered]@{ Key = 'osaaGateway'; Image = 'opensphere-console-osaa-gateway'; Context = (Join-Path $consoleCheckout 'apps\osaa-gateway'); File = (Join-Path $consoleCheckout 'apps\osaa-gateway\Dockerfile') },
  [ordered]@{ Key = 'osdst'; Image = 'opensphere-osdst'; Context = (Join-Path $consoleCheckout 'apps\osdst'); File = (Join-Path $consoleCheckout 'apps\osdst\Dockerfile') },
  [ordered]@{ Key = 'osaaGovernedAdapter'; Image = 'opensphere-osaa-governed-adapter'; Context = (Join-Path $consoleCheckout 'backend\osaa-governed-adapter'); File = (Join-Path $consoleCheckout 'backend\osaa-governed-adapter\Dockerfile') },
  [ordered]@{ Key = 'notificationDispatcher'; Image = 'opensphere-console-notification-dispatcher'; Context = (Join-Path $consoleCheckout 'apps\notification-dispatcher'); File = (Join-Path $consoleCheckout 'apps\notification-dispatcher\Dockerfile') },
  [ordered]@{ Key = 'gitea'; Image = 'opensphere-console-gitea'; Context = (Join-Path $consoleCheckout 'backend\gitea\image'); File = (Join-Path $consoleCheckout 'backend\gitea\image\Dockerfile') },
  [ordered]@{ Key = 'supabasePostgres'; Image = 'opensphere-console-supabase-postgres'; Context = (Join-Path $consoleCheckout 'backend\supabase\images\postgres'); File = (Join-Path $consoleCheckout 'backend\supabase\images\postgres\Dockerfile') },
  [ordered]@{ Key = 'supabaseAuth'; Image = 'opensphere-console-supabase-auth'; Context = (Join-Path $consoleCheckout 'backend\supabase\images\auth'); File = (Join-Path $consoleCheckout 'backend\supabase\images\auth\Dockerfile') },
  [ordered]@{ Key = 'supabaseRest'; Image = 'opensphere-console-supabase-rest'; Context = (Join-Path $consoleCheckout 'backend\supabase\images\rest'); File = (Join-Path $consoleCheckout 'backend\supabase\images\rest\Dockerfile') },
  [ordered]@{ Key = 'supabaseStorage'; Image = 'opensphere-console-supabase-storage'; Context = (Join-Path $consoleCheckout 'backend\supabase\images\storage'); File = (Join-Path $consoleCheckout 'backend\supabase\images\storage\Dockerfile') },
  [ordered]@{ Key = 'giteaPostgres'; Image = 'opensphere-console-gitea-postgres'; Context = (Join-Path $consoleCheckout 'backend\gitea\postgres-image'); File = (Join-Path $consoleCheckout 'backend\gitea\postgres-image\Dockerfile') },
  [ordered]@{ Key = 'recovery'; Image = 'opensphere-console-recovery'; Context = (Join-Path $consoleCheckout 'apps\recovery-owner'); File = (Join-Path $consoleCheckout 'apps\recovery-owner\Dockerfile') },
  [ordered]@{ Key = 'beszelHub'; Image = 'opensphere-console-beszel-hub'; Context = $consoleCheckout; File = (Join-Path $consoleCheckout 'deploy\baseline-monitoring\images\hub\Dockerfile') },
  [ordered]@{ Key = 'beszelAgent'; Image = 'opensphere-console-beszel-agent'; Context = $consoleCheckout; File = (Join-Path $consoleCheckout 'deploy\baseline-monitoring\images\agent\Dockerfile') },
  [ordered]@{ Key = 'beszelBootstrap'; Image = 'opensphere-console-beszel-bootstrap'; Context = $consoleCheckout; File = (Join-Path $consoleCheckout 'deploy\baseline-monitoring\images\bootstrap\Dockerfile') },
  # CLI and OS Shell artifacts are independently selectable auxiliary output.
  [ordered]@{ Key = 'cliArtifacts'; Image = 'opensphere-os-cli'; Context = (Join-Path $consoleCheckout 'cmd\os-cli'); File = (Join-Path $consoleCheckout 'cmd\os-cli\Dockerfile') },
  [ordered]@{ Key = 'osShellControl'; Image = 'opensphere-console-os-shell-control'; Context = $consoleCheckout; File = (Join-Path $consoleCheckout 'apps\os-shell-control\Dockerfile') },
  [ordered]@{ Key = 'osShellRuntime'; Image = 'opensphere-os-shell-runtime'; Context = $consoleCheckout; File = (Join-Path $consoleCheckout 'apps\os-shell-control\Dockerfile.runtime') },
  [ordered]@{ Key = 'consoleIndexContent'; Image = 'opensphere-console-index-content'; Context = (Join-Path $consoleCheckout 'apps\console-index-content'); File = (Join-Path $consoleCheckout 'apps\console-index-content\Dockerfile') },
  # Retained only to reject stale explicit callers before registry mutation.
  [ordered]@{ Key = 'backend'; Image = 'opensphere-console-backend'; Context = $consoleCheckout; File = (Join-Path $consoleCheckout 'apps\console-api\runtime\Dockerfile'); SetupContext = $setupCheckout }
)
$blockedLegacyComponentKeys = @('backend')
$canonicalImages = @($allImages | Where-Object {
  $_.Key -notin $auxiliaryComponentKeys -and $_.Key -notin $blockedLegacyComponentKeys
})
if ($canonicalImages.Count -ne 18) {
  throw "Canonical local edge release must contain exactly 18 components; found $($canonicalImages.Count)."
}
$requestedComponents = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($component in $Components) { [void]$requestedComponents.Add($component) }
$images = @($allImages | Where-Object { $requestedComponents.Contains($_.Key) })
if (-not $images.Count) { throw 'At least one Console component must be selected.' }
$integratedPublication = $images.Count -eq $completeReleaseComponentKeys.Count `
  -and @($images | Where-Object { $_.Key -in $blockedLegacyComponentKeys }).Count -eq 0 `
  -and @($completeReleaseComponentKeys | Where-Object { -not $requestedComponents.Contains($_) }).Count -eq 0
if ($integratedPublication -ne $integratedRequest) {
  throw 'Canonical release gate and image matrix disagree about integrated publication scope.'
}
$partialPublication = -not $integratedPublication
$osShellUxComponentSet = (@($images.Key | Sort-Object) -join ',') -eq 'console,osShellRuntime'
if ($AdvanceOsShellUxConsoleEdge -and -not $osShellUxComponentSet) {
  throw 'AdvanceOsShellUxConsoleEdge requires exactly console and osShellRuntime components'
}
$integratedAnchorBefore = if ($partialPublication -and ($images | Where-Object { $_.Key -eq 'console' })) {
  Get-RemoteDigest -Reference "$Registry/opensphere-console:edge"
} else {
  $null
}

Write-Host "[step 04/06] Reuse verified immutable images or build missing host-native images"
Write-Host "[scope] $($images.Key -join ', ')"
$digests = [ordered]@{}
$imagesToBuild = [Collections.Generic.List[object]]::new()
foreach ($item in $images) {
  $releaseScope = if ($item.Key -in $auxiliaryComponentKeys) { 'auxiliary' } else { 'canonical' }
  $repository = "$Registry/$($item.Image)"
  $localReference = "${repository}:$localTag"
  $versionReference = "${repository}:$releaseTag"
  $existingLocalDigest = Get-RemoteDigest -Reference $localReference
  $existingVersionDigest = Get-RemoteDigest -Reference $versionReference

  if ($existingLocalDigest) {
    Assert-LocalEdgeImageMetadata -Repository $repository -Digest $existingLocalDigest `
      -ExpectedSourceRevision $SourceRevision -ExpectedReleaseTag $releaseTag `
      -ExpectedPlatform $Platform -ExpectedReleaseScope $releaseScope
  }
  if ($existingVersionDigest) {
    Assert-LocalEdgeImageMetadata -Repository $repository -Digest $existingVersionDigest `
      -ExpectedSourceRevision $SourceRevision -ExpectedReleaseTag $releaseTag `
      -ExpectedPlatform $Platform -ExpectedReleaseScope $releaseScope
  }
  if ($existingVersionDigest -and -not $existingLocalDigest) {
    throw "Immutable publication is incomplete: $versionReference exists but $localReference is missing"
  }
  if ($existingLocalDigest -and $existingVersionDigest -and $existingLocalDigest -ne $existingVersionDigest) {
    throw "Immutable tag lineage mismatch: $localReference is $existingLocalDigest but $versionReference is $existingVersionDigest"
  }
  if ($existingLocalDigest) {
    $digests[$item.Key] = $existingLocalDigest
    Write-Host "[reused] $localReference -> $existingLocalDigest"
  } else {
    $imagesToBuild.Add($item)
  }
}

for ($index = 0; $index -lt $imagesToBuild.Count; $index += 1) {
  $item = $imagesToBuild[$index]
  $releaseScope = if ($item.Key -in $auxiliaryComponentKeys) { 'auxiliary' } else { 'canonical' }
  $repository = "$Registry/$($item.Image)"
  $metadataFile = Join-Path $metadataRoot "$($item.Image).json"
  Write-Host ("[build {0:d2}/{1:d2}] {2}:{3}" -f ($index + 1), $imagesToBuild.Count, $repository, $localTag)
  $arguments = @(
    'buildx', 'build',
    '--platform', $Platform,
    '--push',
    '--provenance=mode=max',
    '--metadata-file', $metadataFile,
    '--tag', "${repository}:$localTag",
    '--label', 'io.opensphere.channel=edge',
    '--label', "io.opensphere.release-scope=$releaseScope",
    '--label', "io.opensphere.source-revision=$SourceRevision",
    '--label', "io.opensphere.release-tag=$releaseTag",
    '--label', "org.opencontainers.image.version=$releaseTag",
    '--label', 'org.opencontainers.image.source=https://github.com/opensphere-platform/OpenSphere-console',
    '--label', 'opensphere.io/build-authority=localhost',
    '--label', 'opensphere.io/release-class=pre-ga',
    '--label', 'opensphere.io/ga-eligible=false',
    '--build-arg', 'CLI_UPDATE_SIGNING_PROFILE=local',
    '--file', $item.File
  )
  if ($item.Key -eq 'backend') {
    if (-not $setupSourceRevision -or -not (Test-Path -LiteralPath $item.SetupContext)) {
      throw 'Backend build requires the clean governed Setup CLI context.'
    }
    $arguments += @(
      '--build-context', "setup-cli=$($item.SetupContext)",
      '--build-arg', "SETUP_SOURCE_REVISION=$setupSourceRevision"
    )
  }
  if ($item.Key -eq 'consoleIndexContent') {
    Invoke-Checked node (Join-Path $consoleCheckout 'scripts/build-console-index-content.mjs') --source-revision $SourceRevision --version $releaseTag
    $arguments += @('--build-arg', "VERSION=$releaseTag", '--build-arg', "SOURCE_REVISION=$SourceRevision")
  }
  if ($item.Key -eq 'console') {
    $arguments += @('--label', 'io.opensphere.console-index-content=console-index-renderer/v1')
  }
  if ($item.Key -eq 'cliArtifacts') {
    $arguments += @(
      '--build-arg', "CLI_UPDATE_TRUST_ID=$CliUpdateSigningKeyId",
      '--build-arg', "CLI_UPDATE_TRUST_PUBLIC=$CliUpdateSigningPublicKey",
      '--secret', "id=cli_update_signing_key,src=$resolvedCliSigningKey"
    )
  }
  if ($item.Key -eq 'osShellRuntime') {
    $arguments += @('--build-arg', "OPENSPHERE_VERSION=$releaseTag")
  }
  if ($item.Key -eq 'osdst') {
    $arguments += @('--build-arg', "APP_VERSION=$releaseTag")
  }
  if ($item.Key -eq 'registry') {
    $arguments += @('--build-arg', "APP_VERSION=$releaseTag", '--build-arg', "SOURCE_REVISION=$SourceRevision")
  }
  $arguments += $item.Context
  Invoke-Checked docker @arguments
  $metadata = Get-Content -Raw -LiteralPath $metadataFile | ConvertFrom-Json
  $digest = $metadata.'containerimage.digest'
  if ($digest -notmatch '^sha256:[0-9a-f]{64}$') {
    throw "Build did not return a canonical digest for $repository"
  }
  # This is the only promotion path. Fail before any date/channel tag moves if
  # Buildx produced the wrong platform or if any policy label is absent/stale.
  Assert-LocalEdgeImageMetadata -Repository $repository -Digest $digest `
    -ExpectedSourceRevision $SourceRevision -ExpectedReleaseTag $releaseTag `
    -ExpectedPlatform $Platform -ExpectedReleaseScope $releaseScope
  $digests[$item.Key] = $digest
  Write-Host "[pushed] ${repository}:$localTag -> $digest"
}

# Immutable source images may be built above, but date/channel tags must not move
# until the exact packaged C_API digest has started and served DB-backed Ready.
if ($digests.Contains('consoleApi')) {
  $apiReference = "$Registry/opensphere-console-api@$($digests.consoleApi)"
  Write-Host '[gate] Run the exact Console API image against isolated PostgreSQL'
  Invoke-Checked docker pull $apiReference
  Invoke-Checked node (Join-Path $consoleCheckout 'scripts/verify-console-api-image.mjs') --image $apiReference
}
Write-Host "[step 05/06] Publish immutable date tag $releaseTag"
foreach ($item in $images) {
  $repository = "$Registry/$($item.Image)"
  Set-RemoteTag -Repository $repository -Digest $digests[$item.Key] -Tag $releaseTag -Immutable
}

$componentEvidence = [ordered]@{}
$auxiliaryArtifactEvidence = [ordered]@{}
foreach ($item in $images) {
  $repository = "$Registry/$($item.Image)"
  $evidence = [ordered]@{
    repository = $item.Image
    image = "${repository}@$($digests[$item.Key])"
    sourceRevision = $SourceRevision
  }
  if ($item.Key -in $auxiliaryComponentKeys) {
    $auxiliaryArtifactEvidence[$item.Key] = $evidence
  } else {
    $componentEvidence[$item.Key] = $evidence
  }
}
if (-not $partialPublication -and
    ($componentEvidence.Count -ne 18 -or $auxiliaryArtifactEvidence.Count -ne 4)) {
  throw "Complete local edge release must contain exactly 18 canonical components and 4 auxiliary artifacts; found $($componentEvidence.Count)+$($auxiliaryArtifactEvidence.Count)."
}
$releaseArtifacts = [ordered]@{
  supabaseMigrationManifest = [ordered]@{
    path = 'migrations/manifest.json'
    sha256 = Get-CanonicalTextSha256 -Path $migrationManifestPath
    setDigest = [string]$migrationManifest.setDigest
    latestGlobalId = [string]$migrationManifest.latestGlobalId
    migrationCount = [int]$migrationManifest.migrationCount
  }
}
if ($requestedComponents.Contains('osShellControl')) {
  $runtimeTemplatePath = Join-Path $consoleCheckout 'apps\os-shell-control\runtime-template.js'
  $releaseArtifacts['osShellControlRelease'] = [ordered]@{
    runtimeTemplate = [ordered]@{
      path = 'apps/os-shell-control/runtime-template.js'
      sha256 = Get-CanonicalTextSha256 -Path $runtimeTemplatePath
    }
    runtimeProcessPolicy = [ordered]@{
      maxProcesses = 256
      globalPodLimit = 8
      userNamespacePolicy = 'required-hostUsers-false'
      enforcement = 'linux-userns+rlimit-nproc+namespace-resourcequota'
    }
  }
}
$bom = [ordered]@{
  apiVersion = 'release.opensphere.io/v1alpha1'
  kind = $partialPublication ? 'OpenSphereEdgeComponentPublication' : 'OpenSphereReleaseBOM'
  publicationScope = $partialPublication ? 'ComponentSet' : 'CompleteConsoleRelease'
  channel = 'edge'
  status = $DeferChannelPromotion ? 'Staged' : 'Active'
  releaseTag = $releaseTag
  immutableTag = $localTag
  source = 'https://github.com/opensphere-platform/OpenSphere-console'
  sourceRevision = $SourceRevision
  artifacts = $releaseArtifacts
  buildAuthority = 'localhost'
  releaseClass = 'pre-ga'
  gaEligible = $false
  supportedPlatforms = @($Platform)
  components = $componentEvidence
}
if ($auxiliaryArtifactEvidence.Count -gt 0) {
  $bom['auxiliaryArtifacts'] = $auxiliaryArtifactEvidence
}
$bomPath = Join-Path $workspace ($partialPublication ? 'opensphere-local-component-publication.json' : 'opensphere-local-release-bom.json')
$bom | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $bomPath -Encoding utf8
if ($partialPublication) {
  foreach ($item in $images) {
    $singleComponentBom = [ordered]@{}
    foreach ($entry in $bom.GetEnumerator()) {
      $singleComponentBom[$entry.Key] = $entry.Value
    }
    if ($item.Key -in $auxiliaryComponentKeys) {
      $singleComponentBom['components'] = [ordered]@{}
      $singleComponentBom['auxiliaryArtifacts'] = [ordered]@{
        $item.Key = $auxiliaryArtifactEvidence[$item.Key]
      }
    } else {
      $singleComponentBom['components'] = [ordered]@{
        $item.Key = $componentEvidence[$item.Key]
      }
      [void]$singleComponentBom.Remove('auxiliaryArtifacts')
    }
    $singleComponentPath = Join-Path $workspace "opensphere-local-component-publication-$($item.Key).json"
    $singleComponentBom | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $singleComponentPath -Encoding utf8
    Write-Host "[component evidence] $singleComponentPath"
  }
}

# Staging publishes only immutable images. Run this same source again without
# DeferChannelPromotion after in-cluster acceptance; source tags are reused.
if ($DeferChannelPromotion) {
  Write-Host '[staged] Complete immutable release verified; no channel tags changed'
  Write-Host "[release] $releaseTag"
  Write-Host "[immutable] $localTag"
  Write-Host "[bom] $bomPath"
  return
}
Write-Host '[step 06/06] Advance selected component tags without moving a partial Console anchor'
foreach ($item in $images | Where-Object { $_.Key -ne 'console' }) {
  Set-RemoteTag -Repository "$Registry/$($item.Image)" -Digest $digests[$item.Key] -Tag edge
}
$console = $images | Where-Object { $_.Key -eq 'console' }
if ($console -and (-not $partialPublication -or $AdvanceOsShellUxConsoleEdge)) {
  Set-RemoteTag -Repository "$Registry/$($console.Image)" -Digest $digests.console -Tag edge
}
if ($console -and $partialPublication -and -not $AdvanceOsShellUxConsoleEdge) {
  $integratedAnchorAfter = Get-RemoteDigest -Reference "$Registry/opensphere-console:edge"
  if ($integratedAnchorAfter -ne $integratedAnchorBefore) {
    throw "Partial publication moved the integrated Console edge anchor: before=$integratedAnchorBefore after=$integratedAnchorAfter"
  }
}

foreach ($item in $images) {
  $verificationTag = if ($partialPublication -and $item.Key -eq 'console' -and -not $AdvanceOsShellUxConsoleEdge) { $localTag } else { 'edge' }
  $actual = Get-RemoteDigest -Reference "$Registry/$($item.Image):$verificationTag"
  if ($actual -ne $digests[$item.Key]) {
    throw "Final publication verification failed for $($item.Image):$verificationTag"
  }
}

Write-Host '[success] Local edge publish completed'
Write-Host "[release] $releaseTag"
Write-Host "[immutable] $localTag"
if ($console -and -not $partialPublication) {
  Write-Host "[anchor] $Registry/opensphere-console@$($digests.console)"
} elseif ($console) {
  Write-Host "[anchor] preserved $Registry/opensphere-console@$integratedAnchorBefore"
} else {
  Write-Host '[anchor] not selected; component-only edge publication'
}
Write-Host "[bom] $bomPath"
