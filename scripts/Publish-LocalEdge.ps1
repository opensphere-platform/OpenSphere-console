[CmdletBinding()]
param(
  [string]$Registry = 'ghcr.io/opensphere-platform',
  [string]$SourceRevision = '',
  [string]$Platforms = 'linux/amd64,linux/arm64',
  [string]$SdkRepository = 'https://github.com/opensphere-platform/OpenSphere-SDK.git'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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

function Get-RemoteDigest {
  param([Parameter(Mandatory)][string]$Reference)

  $output = & docker buildx imagetools inspect $Reference 2>$null
  if ($LASTEXITCODE -ne 0) {
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
    Invoke-Checked docker buildx imagetools create --tag $target "${Repository}@${Digest}"
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

$dirty = & git -C $repoRoot status --short
if ($dirty) {
  throw 'The Console worktree must be clean before publishing local edge.'
}

$epochText = (& git -C $repoRoot show -s --format=%ct $SourceRevision).Trim()
if ($epochText -notmatch '^\d+$') {
  throw "Could not resolve commit timestamp for $SourceRevision"
}
$seoulOffset = [TimeSpan]::FromHours(9)
$releaseTag = [DateTimeOffset]::FromUnixTimeSeconds([long]$epochText).ToOffset($seoulOffset).ToString('yyyyMMddHHmm')
$localTag = "local-$($SourceRevision.Substring(0, 12))"

$platformRoot = Split-Path $repoRoot -Parent
$workspace = Join-Path $platformRoot ".codex-tmp\local-edge-$($SourceRevision.Substring(0, 12))"
$consoleCheckout = Join-Path $workspace 'OpenSphere-console'
$sdkCheckout = Join-Path $workspace 'OpenSphere-SDK'
$macosCli = Join-Path $workspace 'macos-cli'
$metadataRoot = Join-Path $workspace 'metadata'

if (Test-Path -LiteralPath $workspace) {
  throw "Local edge workspace already exists: $workspace"
}
New-Item -ItemType Directory -Path $workspace, $macosCli, $metadataRoot | Out-Null

Write-Host "[start] Local OpenSphere edge publish"
Write-Host "[source] $SourceRevision"
Write-Host "[release] $releaseTag"
Write-Host "[immutable] $localTag"
Write-Host "[policy] build-authority=localhost, release-class=pre-ga, ga-eligible=false"

Write-Host '[step 01/06] Prepare clean Console and SDK source'
Invoke-Checked git -C $repoRoot worktree add --detach $consoleCheckout $SourceRevision
Invoke-Checked git clone --depth 1 --branch main $SdkRepository $sdkCheckout

Write-Host '[step 02/06] Reuse signed macOS CLI only when CLI source is unchanged'
$currentEdge = "${Registry}/opensphere-console:edge"
Invoke-Checked docker pull $currentEdge
$priorRevision = (& docker image inspect $currentEdge --format '{{ index .Config.Labels "io.opensphere.source-revision" }}').Trim()
if ($priorRevision -notmatch '^[0-9a-f]{40}$') {
  throw "Current edge image has no canonical source revision: $currentEdge"
}
& git -C $repoRoot cat-file -e "${priorRevision}^{commit}" 2>$null
if ($LASTEXITCODE -ne 0) {
  Invoke-Checked git -C $repoRoot fetch github $priorRevision
}
& git -C $repoRoot diff --quiet $priorRevision $SourceRevision -- backend/os-cli
if ($LASTEXITCODE -ne 0) {
  throw 'backend/os-cli changed; Windows local publishing requires newly signed macOS CLI artifacts from a macOS builder.'
}

$containerName = "opensphere-local-edge-cli-$PID"
try {
  Invoke-Checked docker create --name $containerName $currentEdge
  Invoke-Checked docker cp "${containerName}:/usr/share/nginx/html/api/cli/opensphere-cli-darwin-arm64" (Join-Path $macosCli 'opensphere-cli-darwin-arm64')
  Invoke-Checked docker cp "${containerName}:/usr/share/nginx/html/api/cli/opensphere-cli-darwin-amd64" (Join-Path $macosCli 'opensphere-cli-darwin-amd64')
} finally {
  & docker rm $containerName 2>$null | Out-Null
}

Write-Host '[step 03/06] Authenticate to GHCR without printing credentials'
$token = (& gh auth token).Trim()
if (-not $token) {
  throw 'GitHub CLI did not return an authentication token.'
}
try {
  $token | docker login ghcr.io -u opensphere-platform --password-stdin
  if ($LASTEXITCODE -ne 0) {
    throw "docker login failed with exit code $LASTEXITCODE"
  }
} finally {
  Remove-Variable token
}

$images = @(
  [ordered]@{ Key = 'console'; Image = 'opensphere-console'; Context = $workspace; File = (Join-Path $consoleCheckout 'Dockerfile') },
  [ordered]@{ Key = 'backend'; Image = 'opensphere-console-backend'; Context = (Join-Path $consoleCheckout 'backend'); File = (Join-Path $consoleCheckout 'backend\opensphere-console-backend\Dockerfile') },
  [ordered]@{ Key = 'dupaController'; Image = 'opensphere-console-dupa-controller'; Context = (Join-Path $consoleCheckout 'backend\dupa-control'); File = (Join-Path $consoleCheckout 'backend\dupa-control\Dockerfile') },
  [ordered]@{ Key = 'oaaGateway'; Image = 'opensphere-console-oaa-gateway'; Context = (Join-Path $consoleCheckout 'backend\opensphere-console-oaa-gateway'); File = (Join-Path $consoleCheckout 'backend\opensphere-console-oaa-gateway\Dockerfile') },
  [ordered]@{ Key = 'oaaGovernedAdapter'; Image = 'opensphere-oaa-governed-adapter'; Context = (Join-Path $consoleCheckout 'backend\oaa-governed-adapter'); File = (Join-Path $consoleCheckout 'backend\oaa-governed-adapter\Dockerfile') },
  [ordered]@{ Key = 'notificationDispatcher'; Image = 'opensphere-console-notification-dispatcher'; Context = (Join-Path $consoleCheckout 'backend\notification-dispatcher'); File = (Join-Path $consoleCheckout 'backend\notification-dispatcher\Dockerfile') },
  [ordered]@{ Key = 'recovery'; Image = 'opensphere-console-recovery'; Context = (Join-Path $consoleCheckout 'backend\recovery'); File = (Join-Path $consoleCheckout 'backend\recovery\Dockerfile') },
  [ordered]@{ Key = 'gitea'; Image = 'opensphere-console-gitea'; Context = (Join-Path $consoleCheckout 'backend\gitea\image'); File = (Join-Path $consoleCheckout 'backend\gitea\image\Dockerfile') },
  [ordered]@{ Key = 'supabasePostgres'; Image = 'opensphere-console-supabase-postgres'; Context = (Join-Path $consoleCheckout 'backend\supabase\images\postgres'); File = (Join-Path $consoleCheckout 'backend\supabase\images\postgres\Dockerfile') },
  [ordered]@{ Key = 'supabaseAuth'; Image = 'opensphere-console-supabase-auth'; Context = (Join-Path $consoleCheckout 'backend\supabase\images\auth'); File = (Join-Path $consoleCheckout 'backend\supabase\images\auth\Dockerfile') },
  [ordered]@{ Key = 'supabaseRest'; Image = 'opensphere-console-supabase-rest'; Context = (Join-Path $consoleCheckout 'backend\supabase\images\rest'); File = (Join-Path $consoleCheckout 'backend\supabase\images\rest\Dockerfile') },
  [ordered]@{ Key = 'supabaseStorage'; Image = 'opensphere-console-supabase-storage'; Context = (Join-Path $consoleCheckout 'backend\supabase\images\storage'); File = (Join-Path $consoleCheckout 'backend\supabase\images\storage\Dockerfile') },
  [ordered]@{ Key = 'giteaPostgres'; Image = 'opensphere-console-gitea-postgres'; Context = (Join-Path $consoleCheckout 'backend\gitea\postgres-image'); File = (Join-Path $consoleCheckout 'backend\gitea\postgres-image\Dockerfile') }
)

Write-Host "[step 04/06] Build and push $($images.Count) multi-platform images"
$digests = [ordered]@{}
for ($index = 0; $index -lt $images.Count; $index += 1) {
  $item = $images[$index]
  $repository = "$Registry/$($item.Image)"
  $metadataFile = Join-Path $metadataRoot "$($item.Image).json"
  Write-Host ("[build {0:d2}/{1:d2}] {2}:{3}" -f ($index + 1), $images.Count, $repository, $localTag)
  $arguments = @(
    'buildx', 'build',
    '--platform', $Platforms,
    '--push',
    '--provenance=mode=max',
    '--metadata-file', $metadataFile,
    '--tag', "${repository}:$localTag",
    '--label', 'io.opensphere.channel=edge',
    '--label', "io.opensphere.source-revision=$SourceRevision",
    '--label', "io.opensphere.release-tag=$releaseTag",
    '--label', 'opensphere.io/build-authority=localhost',
    '--label', 'opensphere.io/release-class=pre-ga',
    '--label', 'opensphere.io/ga-eligible=false',
    '--build-context', "macos-cli=$macosCli",
    '--build-arg', 'CLI_UPDATE_SIGNING_PROFILE=local',
    '--file', $item.File,
    $item.Context
  )
  Invoke-Checked docker @arguments
  $metadata = Get-Content -Raw -LiteralPath $metadataFile | ConvertFrom-Json
  $digest = $metadata.'containerimage.digest'
  if ($digest -notmatch '^sha256:[0-9a-f]{64}$') {
    throw "Build did not return a canonical digest for $repository"
  }
  $digests[$item.Key] = $digest
  Write-Host "[pushed] ${repository}:$localTag -> $digest"
}

Write-Host "[step 05/06] Publish immutable date tag $releaseTag"
foreach ($item in $images) {
  $repository = "$Registry/$($item.Image)"
  Set-RemoteTag -Repository $repository -Digest $digests[$item.Key] -Tag $releaseTag -Immutable
}

$components = [ordered]@{}
foreach ($item in $images) {
  $repository = "$Registry/$($item.Image)"
  $components[$item.Key] = [ordered]@{
    repository = $item.Image
    image = "${repository}@$($digests[$item.Key])"
    sourceRevision = $SourceRevision
  }
}
$bom = [ordered]@{
  apiVersion = 'release.opensphere.io/v1alpha1'
  kind = 'OpenSphereReleaseBOM'
  channel = 'edge'
  status = 'Active'
  releaseTag = $releaseTag
  immutableTag = $localTag
  source = 'https://github.com/opensphere-platform/OpenSphere-console'
  sourceRevision = $SourceRevision
  buildAuthority = 'localhost'
  releaseClass = 'pre-ga'
  gaEligible = $false
  supportedPlatforms = @('linux/amd64', 'linux/arm64')
  components = $components
}
$bomPath = Join-Path $workspace 'opensphere-local-release-bom.json'
$bom | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $bomPath -Encoding utf8

Write-Host '[step 06/06] Advance edge atomically with Console anchor last'
foreach ($item in $images | Where-Object { $_.Key -ne 'console' }) {
  Set-RemoteTag -Repository "$Registry/$($item.Image)" -Digest $digests[$item.Key] -Tag edge
}
$console = $images | Where-Object { $_.Key -eq 'console' }
Set-RemoteTag -Repository "$Registry/$($console.Image)" -Digest $digests.console -Tag edge

foreach ($item in $images) {
  $actual = Get-RemoteDigest -Reference "$Registry/$($item.Image):edge"
  if ($actual -ne $digests[$item.Key]) {
    throw "Final edge verification failed for $($item.Image)"
  }
}

Write-Host '[success] Local edge publish completed'
Write-Host "[release] $releaseTag"
Write-Host "[immutable] $localTag"
Write-Host "[anchor] $Registry/opensphere-console@$($digests.console)"
Write-Host "[bom] $bomPath"
