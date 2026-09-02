[CmdletBinding()]
param(
  [string]$Registry = 'ghcr.io/opensphere-platform',
  [ValidateSet('console', 'dupaController', 'registry', 'backend', 'osaaGateway', 'cliArtifacts')]
  [string[]]$Components = @('console', 'dupaController'),
  [string]$CliUpdateSigningKeyPath = '',
  [string]$CliUpdateSigningKeyId = 'opensphere-cli-local-dev-v1',
  [string]$CliUpdateSigningPublicKey = '',
  [switch]$UseExistingRegistryLogin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked {
  if ($args.Count -lt 1) { throw 'Invoke-Checked requires an executable.' }
  $executable = [string]$args[0]
  $arguments = @($args | Select-Object -Skip 1)
  $output = & $executable @arguments
  if ($LASTEXITCODE -ne 0) { throw "$executable failed with exit code $LASTEXITCODE" }
  return $output
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

if ($env:OS -ne 'Windows_NT') { throw 'Atomic extension edge publishing requires Windows.' }
if (((Invoke-Checked kubectl config current-context) -join '').Trim() -ne 'docker-desktop') {
  throw 'Atomic extension edge publishing requires Kubernetes context docker-desktop.'
}
$dockerOs = ((Invoke-Checked docker info --format '{{.OSType}}') -join '').Trim().ToLowerInvariant()
$dockerArch = ((Invoke-Checked docker info --format '{{.Architecture}}') -join '').Trim().ToLowerInvariant()
if ($dockerOs -ne 'linux' -or $dockerArch -notin @('amd64', 'x86_64')) {
  throw "Atomic extension edge publishing requires Linux containers on amd64; received $dockerOs/$dockerArch"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$origin = ((Invoke-Checked git -C $repoRoot remote get-url origin) -join '').TrimEnd('/')
if ($origin -ne 'https://github.com/opensphere-platform/OpenSphere-console.git') {
  throw 'Console origin is not canonical.'
}
$branch = ((Invoke-Checked git -C $repoRoot branch --show-current) -join '').Trim()
if ($branch -ne 'main') { throw 'Atomic extension publishing runs only from canonical main.' }
if (& git -C $repoRoot status --short) { throw 'Console main must be clean before publishing.' }
Invoke-Checked git -C $repoRoot fetch --prune origin main | Out-Null
$sourceRevision = ((Invoke-Checked git -C $repoRoot rev-parse HEAD) -join '').Trim()
$originMain = ((Invoke-Checked git -C $repoRoot rev-parse refs/remotes/origin/main) -join '').Trim()
if ($sourceRevision -notmatch '^[0-9a-f]{40}$' -or $sourceRevision -ne $originMain) {
  throw 'Console main must equal fresh origin/main.'
}

$epoch = [long](((Invoke-Checked git -C $repoRoot show -s --format=%ct $sourceRevision) -join '').Trim())
$releaseTag = [DateTimeOffset]::FromUnixTimeSeconds($epoch).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyyMMddHHmm')
$buildTag = "build-$($sourceRevision.Substring(0, 12))"

$lockRaw = (Invoke-Checked kubectl -n opensphere-console get configmap opensphere-installation-lock -o 'jsonpath={.data.release\.json}') -join ''
$installedLock = $lockRaw | ConvertFrom-Json
if ([string]$installedLock.source -ne 'https://github.com/opensphere-platform/OpenSphere-console') {
  throw 'Installed release source is not the canonical Console repository.'
}
$componentNames = @($Components | Sort-Object -Unique)
if (-not $componentNames.Count) { throw 'At least one affected component is required.' }
$changedPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($componentName in $componentNames) {
  $componentProperty = $installedLock.components.PSObject.Properties[$componentName]
  $baseRevision = if ($componentProperty) { [string]$componentProperty.Value.sourceRevision } else { [string]$installedLock.sourceRevision }
  if ($baseRevision -notmatch '^[0-9a-f]{40}$') { throw "Installed $componentName source revision is not canonical." }
  Invoke-Checked git -C $repoRoot fetch --no-tags origin $baseRevision | Out-Null
  Invoke-Checked git -C $repoRoot cat-file -e "${baseRevision}^{commit}" | Out-Null
  foreach ($path in @(Invoke-Checked git -C $repoRoot diff --name-only $baseRevision $sourceRevision)) {
    if ($path) { [void]$changedPaths.Add([string]$path) }
  }
}

$commonGitDir = ((Invoke-Checked git -C $repoRoot rev-parse --git-common-dir) -join '').Trim()
if (-not [IO.Path]::IsPathRooted($commonGitDir)) { $commonGitDir = Join-Path $repoRoot $commonGitDir }
$canonicalConsoleRoot = Split-Path (Resolve-Path $commonGitDir).Path -Parent
$platformRoot = Split-Path $canonicalConsoleRoot -Parent
$outputRoot = Join-Path $platformRoot ".codex-tmp\atomic-extension-edge-$($sourceRevision.Substring(0, 12))"
if (Test-Path -LiteralPath $outputRoot) { throw "Publication output already exists: $outputRoot" }

$buildRoot = Join-Path ([IO.Path]::GetTempPath()) "opensphere-atomic-extension-$([Guid]::NewGuid().ToString('N'))"
$consoleCheckout = Join-Path $buildRoot 'OpenSphere-console'
$setupCheckout = Join-Path $buildRoot 'OpenSphere-Setup-CLI'
$metadataRoot = Join-Path $buildRoot 'metadata'
New-Item -ItemType Directory -Path $buildRoot, $metadataRoot, $outputRoot | Out-Null

$repositories = [ordered]@{
  console = "$Registry/opensphere-console"
  dupaController = "$Registry/opensphere-console-dupa-controller"
  registry = "$Registry/opensphere-registry"
  backend = "$Registry/opensphere-console-backend"
  osaaGateway = "$Registry/opensphere-console-osaa-gateway"
  cliArtifacts = "$Registry/opensphere-os-cli"
}
$digests = [ordered]@{}

try {
  Invoke-Checked git -C $repoRoot worktree add --detach $consoleCheckout $sourceRevision | Out-Null

  $setupRevision = ''
  if ($componentNames -contains 'backend') {
    $setupRevision = (Get-Content -Raw -LiteralPath (Join-Path $consoleCheckout 'apps\console-api\runtime\setup-source.lock')).Trim()
    if ($setupRevision -notmatch '^[0-9a-f]{40}$') { throw 'Backend setup-source.lock is not canonical.' }
    Invoke-Checked git init $setupCheckout | Out-Null
    Invoke-Checked git -C $setupCheckout remote add origin https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git | Out-Null
    Invoke-Checked git -C $setupCheckout fetch --depth 1 origin $setupRevision | Out-Null
    Invoke-Checked git -C $setupCheckout checkout --detach $setupRevision | Out-Null
    if (((Invoke-Checked git -C $setupCheckout rev-parse HEAD) -join '').Trim() -ne $setupRevision) {
      throw 'Setup CLI checkout differs from setup-source.lock.'
    }
  }

  Invoke-Checked node --test `
    (Join-Path $consoleCheckout 'backend\dupa-control\atomic-extension-cutover.test.js') `
    (Join-Path $consoleCheckout 'backend\dupa-control\extension-host-lifecycle.test.js') `
    (Join-Path $consoleCheckout 'backend\dupa-control\extension-serving-contract.test.js') | Out-Null

  if (-not $UseExistingRegistryLogin) {
    $token = ((Invoke-Checked gh auth token) -join '').Trim()
    try {
      $token | docker login ghcr.io -u opensphere-platform --password-stdin | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'GHCR login failed.' }
    } finally { $token = $null }
  }

  $labels = @(
    '--label', 'org.opencontainers.image.source=https://github.com/opensphere-platform/OpenSphere-console',
    '--label', "org.opencontainers.image.revision=$sourceRevision",
    '--label', "org.opencontainers.image.version=$releaseTag",
    '--label', "io.opensphere.source-revision=$sourceRevision",
    '--label', "io.opensphere.release-tag=$releaseTag",
    '--label', 'io.opensphere.channel=edge',
    '--label', 'opensphere.io/build-authority=localhost',
    '--label', 'opensphere.io/release-class=pre-ga',
    '--label', 'opensphere.io/ga-eligible=false',
    '--label', 'io.opensphere.image-platform=linux/amd64'
  )

  if ($componentNames -contains 'console') {
    $consoleMetadata = Join-Path $metadataRoot 'console.json'
    $consoleArgs = @(
      'buildx', 'build', '--platform', 'linux/amd64', '--push', '--provenance=mode=max',
      '--metadata-file', $consoleMetadata, '--tag', "$($repositories.console):$buildTag"
    ) + $labels + @('--file', (Join-Path $consoleCheckout 'apps\console-web\Dockerfile'), $consoleCheckout)
    Invoke-Checked docker @consoleArgs | Out-Null
    $digests.console = [string](Get-Content -Raw $consoleMetadata | ConvertFrom-Json).'containerimage.digest'
  }

  if ($componentNames -contains 'dupaController') {
    $controllerMetadata = Join-Path $metadataRoot 'dupa-controller.json'
    $controllerArgs = @(
      'buildx', 'build', '--platform', 'linux/amd64', '--push', '--provenance=mode=max',
      '--metadata-file', $controllerMetadata, '--tag', "$($repositories.dupaController):$buildTag"
    ) + $labels + @(
      '--file', (Join-Path $consoleCheckout 'backend\dupa-control\Dockerfile'),
      (Join-Path $consoleCheckout 'backend\dupa-control')
    )
    Invoke-Checked docker @controllerArgs | Out-Null
    $digests.dupaController = [string](Get-Content -Raw $controllerMetadata | ConvertFrom-Json).'containerimage.digest'
  }


  if ($componentNames -contains 'registry') {
    $registryMetadata = Join-Path $metadataRoot 'registry.json'
    $registryArgs = @(
      'buildx', 'build', '--platform', 'linux/amd64', '--push', '--provenance=mode=max',
      '--metadata-file', $registryMetadata, '--tag', "$($repositories.registry):$buildTag",
      '--build-arg', "APP_VERSION=$releaseTag", '--build-arg', "SOURCE_REVISION=$sourceRevision"
    ) + $labels + @(
      '--file', (Join-Path $consoleCheckout 'backend\registry\deploy\Dockerfile'),
      (Join-Path $consoleCheckout 'backend\registry')
    )
    Invoke-Checked docker @registryArgs | Out-Null
    $digests.registry = [string](Get-Content -Raw $registryMetadata | ConvertFrom-Json).'containerimage.digest'
  }

  if ($componentNames -contains 'backend') {
    $backendMetadata = Join-Path $metadataRoot 'backend.json'
    $backendArgs = @(
      'buildx', 'build', '--platform', 'linux/amd64', '--push', '--provenance=mode=max',
      '--metadata-file', $backendMetadata, '--tag', "$($repositories.backend):$buildTag",
      '--build-arg', "SETUP_SOURCE_REVISION=$setupRevision", '--build-context', "setup-cli=$setupCheckout"
    ) + $labels + @(
      '--file', (Join-Path $consoleCheckout 'apps\console-api\runtime\Dockerfile'),
      $consoleCheckout
    )
    Invoke-Checked docker @backendArgs | Out-Null
    $digests.backend = [string](Get-Content -Raw $backendMetadata | ConvertFrom-Json).'containerimage.digest'
  }

  if ($componentNames -contains 'osaaGateway') {
    $gatewayMetadata = Join-Path $metadataRoot 'osaa-gateway.json'
    $gatewayArgs = @(
      'buildx', 'build', '--platform', 'linux/amd64', '--push', '--provenance=mode=max',
      '--metadata-file', $gatewayMetadata, '--tag', "$($repositories.osaaGateway):$buildTag"
    ) + $labels + @(
      '--file', (Join-Path $consoleCheckout 'apps\osaa-gateway\Dockerfile'),
      (Join-Path $consoleCheckout 'apps\osaa-gateway')
    )
    Invoke-Checked docker @gatewayArgs | Out-Null
    $digests.osaaGateway = [string](Get-Content -Raw $gatewayMetadata | ConvertFrom-Json).'containerimage.digest'
  }

  if ($componentNames -contains 'cliArtifacts') {
    if (-not $CliUpdateSigningKeyPath -or -not (Test-Path -LiteralPath $CliUpdateSigningKeyPath)) {
      throw 'CLI artifact publication requires a host-local Ed25519 private-key path.'
    }
    if (-not $CliUpdateSigningPublicKey) {
      throw 'CLI artifact publication requires the matching SPKI DER public key in base64.'
    }
    $resolvedCliKey = (Resolve-Path -LiteralPath $CliUpdateSigningKeyPath).Path
    if ($resolvedCliKey.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'CLI signing key must be stored outside the source repository.'
    }
    $cliMetadata = Join-Path $metadataRoot 'os-cli.json'
    $cliArgs = @(
      'buildx', 'build', '--platform', 'linux/amd64', '--push', '--provenance=mode=max',
      '--metadata-file', $cliMetadata, '--tag', "$($repositories.cliArtifacts):$buildTag",
      '--build-arg', 'CLI_UPDATE_SIGNING_PROFILE=local',
      '--build-arg', "CLI_UPDATE_TRUST_ID=$CliUpdateSigningKeyId",
      '--build-arg', "CLI_UPDATE_TRUST_PUBLIC=$CliUpdateSigningPublicKey",
      '--secret', "id=cli_update_signing_key,src=$resolvedCliKey"
    ) + $labels + @(
      '--file', (Join-Path $consoleCheckout 'cmd\os-cli\Dockerfile'),
      (Join-Path $consoleCheckout 'cmd\os-cli')
    )
    Invoke-Checked docker @cliArgs | Out-Null
    $digests.cliArtifacts = [string](Get-Content -Raw $cliMetadata | ConvertFrom-Json).'containerimage.digest'
  }

  foreach ($componentName in $componentNames) {
    if ([string]$digests[$componentName] -notmatch '^sha256:[0-9a-f]{64}$') {
      throw "$componentName build did not produce an exact digest."
    }
  }

  # Build and verify both components before either channel pointer moves.
  foreach ($componentName in $componentNames) {
    Set-RemoteTag -Repository $repositories[$componentName] -Digest $digests[$componentName] -Tag $releaseTag -Immutable
  }
  foreach ($componentName in $componentNames) {
    Set-RemoteTag -Repository $repositories[$componentName] -Digest $digests[$componentName] -Tag edge
  }

  $publicationComponents = [ordered]@{}
  foreach ($componentName in $componentNames) {
    $publicationComponents[$componentName] = [ordered]@{
      image = "$($repositories[$componentName])@$($digests[$componentName])"
      sourceRevision = $sourceRevision
    }
  }
  $publication = [ordered]@{
    apiVersion = 'release.opensphere.io/v1alpha1'
    kind = 'OpenSphereEdgeComponentPublication'
    publicationScope = 'ComponentSet'
    channel = 'edge'
    status = 'Active'
    requestIntent = "Publish only the affected atomic extension components: $($componentNames -join ', ')."
    changedPaths = @($changedPaths | Sort-Object)
    affectedImages = @($componentNames | ForEach-Object { $repositories[$_] })
    releaseScope = 'component'
    fullReleaseJustification = $null
    releaseTag = $releaseTag
    immutableTag = $releaseTag
    source = 'https://github.com/opensphere-platform/OpenSphere-console'
    sourceRevision = $sourceRevision
    sdkSourceRevision = $sdkRevision
    buildAuthority = 'localhost'
    releaseClass = 'pre-ga'
    gaEligible = $false
    supportedPlatforms = @('linux/amd64')
    components = $publicationComponents
    verification = [ordered]@{
      atomicCutoverContracts = 'PASS'
      imageDigests = 'PASS'
      allAffectedImagesBuiltBeforeChannelMove = $true
    }
  }
  $publicationPath = Join-Path $outputRoot 'opensphere-atomic-extension-publication.json'
  $publication | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $publicationPath -Encoding utf8
  Write-Host '[success] Atomic extension component publication completed'
  Write-Host "[version] $releaseTag"
  Write-Host "[evidence] $publicationPath"
  Write-Output $publicationPath
} finally {
  if (Test-Path -LiteralPath $consoleCheckout) {
    & git -C $repoRoot worktree remove --force $consoleCheckout 2>$null | Out-Null
  }
  $resolvedBuildRoot = [IO.Path]::GetFullPath($buildRoot)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if ($resolvedBuildRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path $resolvedBuildRoot -Leaf) -like 'opensphere-atomic-extension-*' -and
      (Test-Path -LiteralPath $resolvedBuildRoot)) {
    Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force
  }
}
