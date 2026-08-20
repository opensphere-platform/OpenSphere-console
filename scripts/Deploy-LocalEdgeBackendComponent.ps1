#requires -Version 7.2
<#
  PFSS component deployment bridge. It has no Kubernetes mutation authority:
  it submits one signed, digest-pinned request to the governed Platform API and
  observes the reconciler receipt. A lost POST response is never replayed.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PublicationPath,
  [Parameter(Mandatory)][string]$SignaturePath,
  [Parameter(Mandatory)][string]$BindingPath,
  [Parameter(Mandatory)][string]$TrustedPublicKeySpkiBase64,
  [Parameter(Mandatory)][ValidateLength(8,500)][string]$Reason,
  [string]$ConsoleUrl = 'https://localhost:1114',
  [ValidateRange(30,7200)][int]$TimeoutSeconds = 3600
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'local-edge-publication-core.psm1') -Force -ErrorAction Stop
. (Join-Path $PSScriptRoot 'os-shell-edge-signing.ps1')
$expectedComponents = @('backend','oaaGateway')
$expectedBinding = @('contract','publisher','publisherGitBlob','publisherSha256','documentSha256','signatureSha256','keyId','setupSourceRevision','setupSourceLockSha256','setupManifestProjectionGitBlob','setupManifestProjectionSha256','migrationSetDigest','platformRevision','inventorySha256','verificationSetDigest') | Sort-Object
function Reject([string]$Message) { throw "PFSS component deployment rejected: $Message" }
function Invoke-Checked { param([Parameter(Mandatory)][string]$Exe,[string[]]$Arguments); $out=& $Exe @Arguments; if ($LASTEXITCODE -ne 0) { throw "$Exe failed with exit code $LASTEXITCODE" }; return $out }

if ($env:OS -ne 'Windows_NT') { Reject 'requires the Windows Docker Desktop host' }
if ((Invoke-Checked kubectl @('config','current-context')).Trim() -ne 'docker-desktop') { Reject 'requires Kubernetes context docker-desktop' }
if ($ConsoleUrl -notmatch '^https://localhost(?::\d+)?$') { Reject 'ConsoleUrl must be HTTPS localhost' }
$publicationFile = (Resolve-Path $PublicationPath).Path; $signatureFile = (Resolve-Path $SignaturePath).Path; $bindingFile = (Resolve-Path $BindingPath).Path
$publicationJson = Get-Content -Raw $publicationFile
$signatureJson = Get-Content -Raw $signatureFile
$publication = $publicationJson | ConvertFrom-Json
$binding = Get-Content -Raw $bindingFile | ConvertFrom-Json
if ((@($publication.components.PSObject.Properties.Name | Sort-Object) -join ',') -ne ($expectedComponents -join ',') -or
    [string]$publication.kind -ne 'OpenSphereEdgeComponentPublication' -or [string]$publication.publicationScope -ne 'ComponentSet' -or
    [string]$publication.channel -ne 'edge' -or [string]$publication.buildAuthority -ne 'localhost' -or [bool]$publication.gaEligible -or
    [string]$publication.sourceRevision -notmatch '^[a-f0-9]{40}$' -or (@($publication.affectedImages | Sort-Object) -join ',') -ne ($expectedComponents -join ',')) { Reject 'publication is not the exact two-component local-edge contract' }
if ((@($binding.PSObject.Properties.Name | Sort-Object) -join ',') -ne ($expectedBinding -join ',') -or
    [string]$binding.contract -ne 'opensphere-edge-component-publication-binding/v1' -or
    [string]$binding.publisher -ne 'scripts/Publish-LocalEdgeBackendComponent.ps1' -or
    [string]$binding.keyId -ne 'opensphere-edge-local-v1' -or
    [string]$binding.documentSha256 -ne (Get-FileSha256 $publicationFile) -or
    [string]$binding.signatureSha256 -ne (Get-FileSha256 $signatureFile)) { Reject 'component publication binding is not exact' }
Test-OsShellEdgeSignedDocument -DocumentPath $publicationFile -SignaturePath $signatureFile -TrustedPublicKeySpkiBase64 $TrustedPublicKeySpkiBase64 -ExpectedKeyId 'opensphere-edge-local-v1' | Out-Null
$components = [ordered]@{}
foreach ($name in $expectedComponents) {
  $item = $publication.components.$name
  $repository = if ($name -eq 'backend') { 'opensphere-console-backend' } else { 'opensphere-console-oaa-gateway' }
  if ([string]$item.repository -ne $repository -or [string]$item.sourceRevision -ne [string]$publication.sourceRevision -or
      [string]$item.image -notmatch "^ghcr\.io/opensphere-platform/$repository@sha256:[a-f0-9]{64}$") { Reject "$name image identity is invalid" }
  $digest = [regex]::Match([string]$item.image,'@(sha256:[a-f0-9]{64})$').Groups[1].Value
  Assert-LocalEdgeImageMetadata -Repository "ghcr.io/opensphere-platform/$repository" -Digest $digest -ExpectedSourceRevision $publication.sourceRevision -ExpectedReleaseTag $publication.releaseTag -ExpectedPlatform 'linux/amd64'
  $components[$name] = [string]$item.image
}
$token = (Invoke-Checked kubectl @('-n','opensphere-console','create','token','opensphere-local-edge-release','--audience','opensphere-local-edge-release','--duration=10m')).Trim()
if ($token.Length -lt 100 -or $token -match '\s') { Reject 'local edge token is invalid' }
try {
  $operationId = 'pfss:' + ([string]$binding.documentSha256).Substring('sha256:'.Length)
  $payload = [ordered]@{ operationId=$operationId; reason=$Reason; sourceRevision=[string]$publication.sourceRevision; components=$components; componentPublication=$binding; publicationDocument=$publicationJson; publicationSignature=$signatureJson } | ConvertTo-Json -Depth 12 -Compress
  $baseUrl = $ConsoleUrl.TrimEnd('/')
  # This is the only mutation POST. If its response is lost, recover the
  # precomputed operation identifier through GET; never replay a mutation.
  $response = $null
  try { $response = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/platform/releases/local-edge-automation/pfss" -Headers @{ Authorization="Bearer $token" } -ContentType 'application/json' -Body $payload }
  catch {
    $response = Invoke-RestMethod -Method Get -Uri "$baseUrl/api/platform/releases/local-edge-automation/pfss/$([uri]::EscapeDataString($operationId))" -Headers @{ Authorization="Bearer $token" }
  }
  if ([string]$response.operationId -ne $operationId -or [string]$response.requestId -notmatch '^[0-9a-f-]{36}$' -or
      (($response.targetReleaseDigest -and [string]$response.targetReleaseDigest -notmatch '^sha256:[a-f0-9]{64}$')) -or
      ($response.changedComponents -and ((@($response.changedComponents | Sort-Object) -join ',') -ne ($expectedComponents -join ',')))) { Reject 'governed Platform response is not the exact PFSS component target' }
  $requestId = [string]$response.requestId
  $targetReleaseDigest = [string]$response.targetReleaseDigest
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $receipt = Invoke-RestMethod -Method Get -Uri "$baseUrl/api/platform/releases/local-edge-automation/pfss/$([uri]::EscapeDataString($operationId))" -Headers @{ Authorization="Bearer $token" }
    if ([string]$receipt.requestId -ne $requestId -or [string]$receipt.operationId -ne $operationId) { Reject 'PFSS resume response does not bind the original operation' }
    if ($receipt.receipt) {
      if (-not [bool]$receipt.receipt.succeeded -or ($targetReleaseDigest -and [string]$receipt.receipt.evidence.installedReleaseDigest -ne $targetReleaseDigest) -or
          [string]$receipt.receipt.evidence.componentPublication.documentSha256 -ne [string]$binding.documentSha256 -or
          [string]$receipt.receipt.evidence.componentPublication.signatureSha256 -ne [string]$binding.signatureSha256) { Reject 'governed Platform receipt does not bind the signed target digest' }
      [pscustomobject]@{ requestId=$requestId; operationId=$operationId; releaseDigest=[string]$receipt.receipt.evidence.installedReleaseDigest; changedComponents=$expectedComponents; receipt=$receipt.receipt }
      return
    }
    Start-Sleep -Seconds 5
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  Reject "governed Platform receipt timed out for request $requestId"
} finally { $token = $null }
