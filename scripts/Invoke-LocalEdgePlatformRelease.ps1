[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PublicationEvidence,
  [Parameter(Mandatory)][ValidateLength(8, 500)][string]$Reason,
  [string[]]$Components = @(),
  [string]$ConsoleUrl = 'https://localhost:1114',
  [ValidateRange(3100, 7200)][int]$TimeoutSeconds = 3600
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

if ($env:OS -ne 'Windows_NT') {
  throw 'Local edge automation is available only on the Windows Docker Desktop development host.'
}
if ((Invoke-Checked kubectl config current-context).Trim() -ne 'docker-desktop') {
  throw 'Local edge automation requires Kubernetes context docker-desktop.'
}
if ($ConsoleUrl -notmatch '^https://localhost(?::\d+)?$') {
  throw 'ConsoleUrl must be an HTTPS localhost origin.'
}

$evidencePath = (Resolve-Path -LiteralPath $PublicationEvidence).Path
$evidence = Get-Content -Raw -LiteralPath $evidencePath | ConvertFrom-Json
if ($evidence.apiVersion -ne 'release.opensphere.io/v1alpha1' -or
    $evidence.kind -ne 'OpenSphereEdgeComponentPublication' -or
    $evidence.publicationScope -ne 'ComponentSet' -or
    $evidence.channel -ne 'edge' -or
    $evidence.buildAuthority -ne 'localhost' -or
    $evidence.gaEligible -ne $false) {
  throw 'PublicationEvidence is not canonical localhost edge component evidence.'
}
if ([string]$evidence.sourceRevision -notmatch '^[0-9a-f]{40}$') {
  throw 'PublicationEvidence does not contain a full source revision.'
}
if (@($evidence.supportedPlatforms).Count -ne 1 -or
    [string]$evidence.supportedPlatforms[0] -ne 'linux/amd64') {
  throw 'PublicationEvidence must be restricted to linux/amd64.'
}

$available = @($evidence.components.PSObject.Properties.Name)
if (-not $available.Count) { throw 'PublicationEvidence has no components.' }
$selected = if ($Components.Count) { @($Components | Sort-Object -Unique) } else { @($available | Sort-Object) }
$unknown = @($selected | Where-Object { $_ -notin $available })
if ($unknown.Count) { throw "Requested components are absent from publication evidence: $($unknown -join ', ')" }

$componentRequest = [ordered]@{}
foreach ($name in $selected) {
  $item = $evidence.components.$name
  if ([string]$item.sourceRevision -ne [string]$evidence.sourceRevision -or
      [string]$item.image -notmatch '^ghcr\.io/opensphere-platform/[a-z0-9._-]+@sha256:[0-9a-f]{64}$') {
    throw "Component $name does not carry canonical source and exact-digest evidence."
  }
  $componentRequest[$name] = [ordered]@{ image = [string]$item.image }
}

$token = (Invoke-Checked kubectl -n opensphere-console create token opensphere-local-edge-release `
  --audience opensphere-local-edge-release --duration=10m).Trim()
if (-not $token) { throw 'Kubernetes did not issue the local edge automation token.' }

try {
  $payload = [ordered]@{
    reason = $Reason
    sourceRevision = [string]$evidence.sourceRevision
    components = $componentRequest
  } | ConvertTo-Json -Depth 8
  Write-Host '[authority] docker-desktop ServiceAccount/audience opensphere-local-edge-release'
  Write-Host "[scope] $($selected -join ', ')"
  $response = Invoke-RestMethod -Method Post `
    -Uri "$($ConsoleUrl.TrimEnd('/'))/api/platform/releases/local-edge-automation" `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType 'application/json' `
    -Body $payload
  if (-not $response.requestId -or [string]$response.targetReleaseDigest -notmatch '^sha256:[0-9a-f]{64}$') {
    throw 'Console response did not contain a governed request and target release digest.'
  }
  Write-Host "[request] $($response.requestId)"
  Write-Host "[target] $($response.targetReleaseDigest)"

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $lockConfig = (Invoke-Checked kubectl -n opensphere-console get configmap opensphere-installation-lock -o json) |
      ConvertFrom-Json
    $lock = [string]$lockConfig.data.'release-lock.json' | ConvertFrom-Json
    if ([string]$lock.releaseDigest -eq [string]$response.targetReleaseDigest) {
      Write-Host "[success] Installation lock observed exact target digest $($lock.releaseDigest)"
      [pscustomobject]@{
        requestId = [string]$response.requestId
        releaseDigest = [string]$lock.releaseDigest
        changedComponents = @($response.changedComponents)
        observedAt = [DateTimeOffset]::UtcNow.ToString('o')
      }
      return
    }
    Start-Sleep -Seconds 5
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Timed out waiting for installation lock $($response.targetReleaseDigest). Request: $($response.requestId)"
} finally {
  $token = $null
}
