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

function Invoke-ConsolePostJson {
  param(
    [Parameter(Mandatory)][uri]$Uri,
    [Parameter(Mandatory)][string]$BearerToken,
    [Parameter(Mandatory)][string]$JsonBody
  )

  # Setup CLI creates a private installation CA for the localhost Console and
  # stores only its public certificate beside the serving certificate. Trust
  # that exact CA for this request without changing the Windows trust store or
  # disabling certificate or hostname validation.
  $encodedCa = ([string](Invoke-Checked kubectl -n opensphere-console get secret shell-tls `
    -o 'jsonpath={.data.ca\.crt}')).Trim()
  if (-not $encodedCa) { throw 'Console TLS Secret shell-tls does not contain ca.crt.' }

  try {
    $caCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
      [Convert]::FromBase64String($encodedCa)
    )
  } catch {
    throw 'Console TLS Secret shell-tls contains an invalid ca.crt.'
  }
  $basicConstraints = @($caCertificate.Extensions | Where-Object {
    $_ -is [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]
  })
  $now = [DateTimeOffset]::UtcNow
  if (-not $basicConstraints.Count -or -not $basicConstraints[0].CertificateAuthority -or
      $caCertificate.Subject -ne $caCertificate.Issuer -or
      $now -lt [DateTimeOffset]$caCertificate.NotBefore -or
      $now -gt [DateTimeOffset]$caCertificate.NotAfter) {
    $caCertificate.Dispose()
    throw 'Console TLS Secret shell-tls does not contain a current self-signed CA certificate.'
  }

  $chainPolicy = [Security.Cryptography.X509Certificates.X509ChainPolicy]::new()
  $chainPolicy.TrustMode = [Security.Cryptography.X509Certificates.X509ChainTrustMode]::CustomRootTrust
  [void]$chainPolicy.CustomTrustStore.Add($caCertificate)
  # The private installation CA has no network CRL endpoint. Chain and
  # localhost hostname validation remain enabled by SslStream.
  $chainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
  $handler = [Net.Http.SocketsHttpHandler]::new()
  $handler.SslOptions.CertificateChainPolicy = $chainPolicy
  $client = [Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(60)
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $Uri)
  $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $BearerToken)
  $request.Content = [Net.Http.StringContent]::new($JsonBody, [Text.Encoding]::UTF8, 'application/json')

  try {
    $httpResponse = $client.SendAsync($request).GetAwaiter().GetResult()
    try {
      $responseBody = $httpResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if (-not $httpResponse.IsSuccessStatusCode) {
        throw "Console release request failed with HTTP $([int]$httpResponse.StatusCode): $responseBody"
      }
      if (-not $responseBody) { throw 'Console release request returned an empty response.' }
      return $responseBody | ConvertFrom-Json
    } finally {
      $httpResponse.Dispose()
    }
  } finally {
    $request.Dispose()
    $client.Dispose()
    $handler.Dispose()
    $caCertificate.Dispose()
  }
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
  $response = Invoke-ConsolePostJson `
    -Uri "$($ConsoleUrl.TrimEnd('/'))/api/platform/releases/local-edge-automation" `
    -BearerToken $token `
    -JsonBody $payload
  if (-not $response.requestId -or [string]$response.targetReleaseDigest -notmatch '^sha256:[0-9a-f]{64}$') {
    throw 'Console response did not contain a governed request and target release digest.'
  }
  Write-Host "[request] $($response.requestId)"
  Write-Host "[target] $($response.targetReleaseDigest)"

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $jobs = (Invoke-Checked kubectl -n opensphere-console get jobs `
      -l "opensphere.io/request-id=$($response.requestId)" -o json) | ConvertFrom-Json
    $job = @($jobs.items | Sort-Object { $_.metadata.creationTimestamp } | Select-Object -Last 1)
    if ($job.Count) {
      $conditionsProperty = $job[0].status.PSObject.Properties['conditions']
      $conditions = if ($conditionsProperty) { @($conditionsProperty.Value) } else { @() }
      $failed = @($conditions | Where-Object { $_.type -eq 'Failed' -and $_.status -eq 'True' })
      if ($failed.Count) {
        $logs = (& kubectl -n opensphere-console logs "job/$($job[0].metadata.name)" --all-containers=true 2>&1) -join "`n"
        throw "Platform Release Job failed: $($job[0].metadata.name)`n$logs"
      }
      $complete = @($conditions | Where-Object { $_.type -eq 'Complete' -and $_.status -eq 'True' })
      if ($complete.Count) {
        $lockConfig = (Invoke-Checked kubectl -n opensphere-console get configmap opensphere-installation-lock -o json) |
          ConvertFrom-Json
        $releaseLockProperty = $lockConfig.data.PSObject.Properties['release.json']
        if (-not $releaseLockProperty -or -not [string]$releaseLockProperty.Value) {
          throw 'Installation lock ConfigMap does not contain canonical release.json data.'
        }
        $lock = [string]$releaseLockProperty.Value | ConvertFrom-Json
        if ([string]$lock.releaseDigest -ne [string]$response.targetReleaseDigest) {
          throw "Completed Platform Release Job did not commit target lock $($response.targetReleaseDigest)."
        }
        Write-Host "[success] Platform Release Job completed with exact target digest $($lock.releaseDigest)"
        [pscustomobject]@{
          requestId = [string]$response.requestId
          releaseDigest = [string]$lock.releaseDigest
          job = [string]$job[0].metadata.name
          changedComponents = @($response.changedComponents)
          observedAt = [DateTimeOffset]::UtcNow.ToString('o')
        }
        return
      }
    }
    Start-Sleep -Seconds 5
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Timed out waiting for terminal Platform Release Job and lock $($response.targetReleaseDigest). Request: $($response.requestId)"
} finally {
  $token = $null
}
