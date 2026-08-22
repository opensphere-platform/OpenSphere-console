#requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('Enable','Disable')][string]$Operation,
  [Parameter(Mandatory)][ValidateLength(8,512)][string]$Reason,
  [Parameter(Mandatory)][string]$PublicationEvidence,
  [string]$RuntimePublicationEvidence = '',
  [string]$BackendPublicationEvidence = '',
  [string]$ConsolePublicationEvidence = '',
  [string]$ControlPublicationEvidence = '',
  [string]$DeploymentReceipt = '',
  [string]$RecoverySignedProfile = '',
  [string]$RecoverySignature = '',
  [string]$ReceiptPath = '',
  [string]$SigningKey = (Join-Path $env:USERPROFILE '.opensphere\keys\edge-local-v1-p256.pem'),
  [ValidateSet('opensphere-edge-local-v1')][string]$SigningKeyId = 'opensphere-edge-local-v1',
  [string]$KubeContext = 'docker-desktop'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'os-shell-edge-signing.ps1')

$controlNamespace = 'opensphere-console'
$sessionNamespace = 'opensphere-shell-sessions'
$endpoint = 'https://localhost:1114/api/platform/os-shell/feature-state/local-edge-automation'
$deployments = @('opensphere-shell-api','opensphere-shell-gateway','opensphere-shell-reconciler','opensphere-shell-console-api')

function Invoke-Kubectl {
  param([Parameter(Mandatory)][string[]]$Arguments)
  $output = & kubectl --context $KubeContext @Arguments
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
  return @($output)
}

function Get-FileSha256 {
  param([Parameter(Mandatory)][string]$Path)
  $stream = [IO.File]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

function New-LocalEdgeToken {
  $token = ((Invoke-Kubectl -Arguments @('-n',$controlNamespace,'create','token','opensphere-local-edge-release',
    '--audience','opensphere-local-edge-release','--duration','10m')) -join '').Trim()
  if ($token.Length -lt 100 -or $token -match '\s') { throw 'projected local edge release token is invalid' }
  return $token
}

function New-FeatureOperationId {
  param([Parameter(Mandatory)][ValidateSet('Enable','Disable')][string]$Kind,
    [Parameter(Mandatory)][string]$ReleaseIntentSha256)
  $material = [Text.UTF8Encoding]::new($false).GetBytes("opensphere-shell-feature-operation/v1|$Kind|$ReleaseIntentSha256")
  $sha = [Security.Cryptography.SHA256]::HashData($material)
  $hex = ([BitConverter]::ToString($sha[0..15])).Replace('-', '').ToLowerInvariant()
  return "$($hex.Substring(0,8))-$($hex.Substring(8,4))-$($hex.Substring(12,4))-$($hex.Substring(16,4))-$($hex.Substring(20,12))"
}

function Invoke-FeatureAuthority {
  param([Parameter(Mandatory)][bool]$Enabled,[Parameter(Mandatory)][System.Collections.IDictionary]$Evidence,
    [Parameter(Mandatory)][string]$OperationId)
  $token = New-LocalEdgeToken
  $headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }
  try {
    $current = Invoke-RestMethod -Uri $endpoint -Method Get -Headers $headers
    $body = [ordered]@{ enabled=$Enabled; expectedRevision=[long]$current.state.revision; operationId=$OperationId;
      reason=$Reason.Trim(); evidence=$Evidence }
    return Invoke-RestMethod -Uri $endpoint -Method Put -Headers $headers -ContentType 'application/json' `
      -Body ($body | ConvertTo-Json -Depth 10 -Compress)
  } finally { $token=$null; $headers.Authorization=$null }
}

function Invoke-ScaleDownFence {
  param([Parameter(Mandatory)][ValidateSet('Claim','Complete')][string]$Action,
    [Parameter(Mandatory)][string]$OperationId,[Parameter(Mandatory)][long]$ExpectedRevision,
    [Parameter(Mandatory)][string]$ScaleClaimToken)
  $token = New-LocalEdgeToken
  $suffix = if ($Action -eq 'Claim') { 'scale-down-claim' } else { 'scale-down-complete' }
  $body = [ordered]@{ expectedRevision=$ExpectedRevision; operationId=$OperationId; scaleClaimToken=$ScaleClaimToken }
  try {
    return Invoke-RestMethod -Uri "$endpoint/$suffix" -Method Post -Headers @{Authorization="Bearer $token";Accept='application/json'} `
      -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 4 -Compress)
  } finally { $token=$null }
}

if ($KubeContext -ne 'docker-desktop' -or (& kubectl config current-context).Trim() -ne 'docker-desktop') {
  throw 'OS Shell feature operation is restricted to Docker Desktop local edge'
}

if ($Operation -eq 'Enable') {
  # Migration -> trust -> exact rollout/readiness/SAR -> signed intent -> gate.
  # This also restores the exact replica profile after a completed Disable.
  $arguments = @{
    PublicationEvidence = $PublicationEvidence
    KubeContext = $KubeContext
    SigningKey = $SigningKey
    SigningKeyId = $SigningKeyId
  }
  if ($RuntimePublicationEvidence) { $arguments.RuntimePublicationEvidence = $RuntimePublicationEvidence }
  if ($BackendPublicationEvidence) { $arguments.BackendPublicationEvidence = $BackendPublicationEvidence }
  if ($ConsolePublicationEvidence) { $arguments.ConsolePublicationEvidence = $ConsolePublicationEvidence }
  if ($ControlPublicationEvidence) { $arguments.ControlPublicationEvidence = $ControlPublicationEvidence }
  if ($ReceiptPath) { $arguments.ReceiptPath = $ReceiptPath }
  & (Join-Path $PSScriptRoot 'Deploy-LocalEdgeOsShell.ps1') @arguments
  if ($LASTEXITCODE -ne 0) { throw "OS Shell enable deployment failed with exit code $LASTEXITCODE" }
  return
}

if (($DeploymentReceipt -and ($RecoverySignedProfile -or $RecoverySignature)) -or
    (-not $DeploymentReceipt -and (-not $RecoverySignedProfile -or -not $RecoverySignature))) {
  throw 'Disable requires exactly one authority input: DeploymentReceipt or RecoverySignedProfile+RecoverySignature'
}
$deploymentReceiptPath = $null
if ($DeploymentReceipt) {
  $deploymentReceiptPath = (Resolve-Path -LiteralPath $DeploymentReceipt).Path
  $deploymentReceiptObject = [IO.File]::ReadAllText($deploymentReceiptPath) | ConvertFrom-Json
  if ([string]$deploymentReceiptObject.kind -ne 'OpenSphereEdgeAuxiliaryDeploymentReceipt' -or
      [string]$deploymentReceiptObject.context -ne 'docker-desktop' -or [bool]$deploymentReceiptObject.signedProfile.gaPromotionEligible -or
      [string]$deploymentReceiptObject.signedProfile.keyId -ne $SigningKeyId -or
      [string]$deploymentReceiptObject.signedProfile.algorithm -ne 'ES256-P1363') {
    throw 'Disable receipt is outside the signed local edge OS Shell boundary'
  }
  $profilePath = (Resolve-Path -LiteralPath ([string]$deploymentReceiptObject.signedProfile.path)).Path
  $signaturePath = (Resolve-Path -LiteralPath ([string]$deploymentReceiptObject.signedProfile.signaturePath)).Path
  $expectedProfileSha256 = [string]$deploymentReceiptObject.signedProfile.sha256
  $expectedSignatureSha256 = [string]$deploymentReceiptObject.signedProfile.signatureSha256
} else {
  if (-not $RecoverySignedProfile -or -not $RecoverySignature -or -not $ReceiptPath) {
    throw 'Activation-failure recovery requires signed profile, detached signature, and an explicit disable ReceiptPath'
  }
  $profilePath = (Resolve-Path -LiteralPath $RecoverySignedProfile).Path
  $signaturePath = (Resolve-Path -LiteralPath $RecoverySignature).Path
  $expectedProfileSha256 = Get-FileSha256 -Path $profilePath
  $expectedSignatureSha256 = Get-FileSha256 -Path $signaturePath
}
if ((Get-FileSha256 -Path $profilePath) -ne $expectedProfileSha256 -or
    (Get-FileSha256 -Path $signaturePath) -ne $expectedSignatureSha256) {
  throw 'Disable authority no longer binds the signed profile bytes'
}
$trustMap = ((Invoke-Kubectl -Arguments @('-n',$controlNamespace,'get','configmap/dupa-trusted-keys','-o','json')) -join "`n") | ConvertFrom-Json
$trustedKeys = ([string]$trustMap.data.'trusted-keys.json' | ConvertFrom-Json -AsHashtable).trustedKeys
$trustedSpki = [string]$trustedKeys[$SigningKeyId]
if (-not $trustedSpki -or -not (Test-OsShellEdgeSignedDocument -DocumentPath $profilePath -SignaturePath $signaturePath `
    -TrustedPublicKeySpkiBase64 $trustedSpki -ExpectedKeyId $SigningKeyId)) {
  throw 'Disable signed release profile is not trusted by the Docker Desktop development trust store'
}
$profile = [IO.File]::ReadAllText($profilePath) | ConvertFrom-Json
if ([string]$profile.contract -ne 'opensphere-os-shell-composite-release-profile/v1' -or
    [string]$profile.channel -ne 'edge' -or [bool]$profile.gaPromotionEligible -or
    [string]$profile.migration.latestMigrationId -notmatch '^\d{4}$') {
  throw 'Disable signed profile is not bound to a canonical migration ledger revision'
}
$publicationPath = (Resolve-Path -LiteralPath $PublicationEvidence).Path
$publicationSha256 = Get-FileSha256 -Path $publicationPath
$basePublicationProperty = $profile.publicationEvidence.PSObject.Properties['baseSha256']
$boundBasePublicationSha256 = if ($basePublicationProperty) {
  [string]$basePublicationProperty.Value
} else {
  [string]$profile.publicationEvidence.consoleSha256
}
if ($boundBasePublicationSha256 -ne $publicationSha256) {
  throw 'Disable publication evidence is not bound by the trusted signed ReleaseIntent'
}
$evidence = [ordered]@{
  authority='kubernetes-workload'; channel='edge'; componentSetDigest=[string]$profile.componentSetDigest
  gaEligible=$false; latestMigrationId=[string]$profile.migration.latestMigrationId
  migrationSetDigest=[string]$profile.migration.manifestSetDigest
  publicationSha256=$publicationSha256
  releaseIntentKeyId=$SigningKeyId
  releaseIntentSha256=$expectedProfileSha256
  releaseIntentSignatureSha256=$expectedSignatureSha256
  sourceRevision=[string]$profile.sourceRevisions.console
}
$operationId = New-FeatureOperationId -Kind Disable -ReleaseIntentSha256 $expectedProfileSha256
$scaleClaimToken = [Guid]::NewGuid().ToString('D')
$operationResult = Invoke-FeatureAuthority -Enabled $false -Evidence $evidence -OperationId $operationId
if ([bool]$operationResult.state.enabled) { throw 'OS Shell admission gate did not close' }
$alreadyCompleted = [string]$operationResult.state.operationPhase -eq 'Completed'
if ([string]$operationResult.state.operationId -ne $operationId -or
    ([string]$operationResult.state.operationPhase -notin @('Draining','ScaleDownClaimed','Completed'))) {
  throw 'Disable operation response is not bound to the requested durable operation'
}

$deadline = [DateTimeOffset]::UtcNow.AddMinutes(10)
do {
  if ([DateTimeOffset]::UtcNow -ge $deadline) {
    throw "OS Shell drain timed out: sessions=$($operationResult.state.activeSessions), tickets=$($operationResult.state.activeTickets)"
  }
  if ([bool]$operationResult.state.scaleDownAllowed -and [long]$operationResult.state.activeSessions -eq 0 -and
      [long]$operationResult.state.activeTickets -eq 0) { break }
  Start-Sleep -Seconds 2
  $token = New-LocalEdgeToken
  try { $operationResult = Invoke-RestMethod -Uri $endpoint -Method Get -Headers @{Authorization="Bearer $token";Accept='application/json'} }
  finally { $token=$null }
} while ($true)

$runtimePods = ((Invoke-Kubectl -Arguments @('-n',$sessionNamespace,'get','pods','-l','app=opensphere-os-shell-runtime','-o','json')) -join "`n") | ConvertFrom-Json
if (@($runtimePods.items | Where-Object { -not $_.metadata.deletionTimestamp }).Count -ne 0) {
  throw 'Drain receipt is not complete while a runtime Pod remains'
}
if (-not $alreadyCompleted) {
  $claim = Invoke-ScaleDownFence -Action Claim -OperationId $operationId `
    -ExpectedRevision ([long]$operationResult.state.revision) -ScaleClaimToken $scaleClaimToken
  if ([string]$claim.state.operationPhase -ne 'ScaleDownClaimed' -or [string]$claim.state.operationId -ne $operationId) {
    throw 'Durable exclusive scale-down fence was not acquired'
  }
  foreach ($deployment in $deployments) {
    # Renew the exclusive DB claim before every external side effect. Enable is
    # rejected while this durable phase is active, and another scaler cannot
    # take over until the bounded claim expires.
    Invoke-ScaleDownFence -Action Claim -OperationId $operationId `
      -ExpectedRevision ([long]$operationResult.state.revision) -ScaleClaimToken $scaleClaimToken | Out-Null
    Invoke-Kubectl -Arguments @('-n',$controlNamespace,'scale',"deployment/$deployment",'--replicas=0') | Out-Null
  }
}
foreach ($deployment in $deployments) {
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(5)
  do {
    $live = ((Invoke-Kubectl -Arguments @('-n',$controlNamespace,'get',"deployment/$deployment",'-o','json')) -join "`n") | ConvertFrom-Json
    $selector = @($live.spec.selector.matchLabels.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ','
    $pods = ((Invoke-Kubectl -Arguments @('-n',$controlNamespace,'get','pods','-l',$selector,'-o','json')) -join "`n") | ConvertFrom-Json
    $remaining = @($pods.items | Where-Object { -not $_.metadata.deletionTimestamp }).Count
    if ([int]$live.spec.replicas -eq 0 -and $remaining -eq 0) { break }
    if ([DateTimeOffset]::UtcNow -ge $deadline) { throw "Deployment $deployment did not converge to replicas=0/Pods=0" }
    Start-Sleep -Seconds 2
  } while ($true)
}
if (-not $alreadyCompleted) {
  $completedFence = Invoke-ScaleDownFence -Action Complete -OperationId $operationId `
    -ExpectedRevision ([long]$operationResult.state.revision) -ScaleClaimToken $scaleClaimToken
  if ([string]$completedFence.state.operationPhase -ne 'Completed' -or [bool]$completedFence.state.enabled) {
    throw 'Durable scale-down operation did not reach Completed while the gate remained closed'
  }
  $operationResult = $completedFence
} elseif (-not $operationResult.state.operationCompletedAt) {
  throw 'Completed disable operation is missing its durable completion timestamp'
}

if (-not $ReceiptPath) {
  $ReceiptPath = Join-Path (Split-Path $deploymentReceiptPath -Parent) 'opensphere-local-os-shell-disable-receipt.json'
}
$operationReceipt = [ordered]@{
  apiVersion='release.opensphere.io/v1alpha1'; kind='OpenSphereOsShellFeatureOperationReceipt'
  contract='opensphere-shell-feature-operation/v1'; operation='Disable'; context=$KubeContext
  authority='system:serviceaccount:opensphere-console:opensphere-local-edge-release'
  sourceProfileSha256=$expectedProfileSha256
  operationId=$operationId; operationPhase='Completed'
  featureRevision=[long]$operationResult.state.revision; activeSessions=0; activeTickets=0; runtimePods=0
  deployments=[ordered]@{ api=0; gateway=0; reconciler=0; consoleApi=0 }
  scaleDownAllowed=$true; reason=[string]$operationResult.state.reason; completedAt=[string]$operationResult.state.operationCompletedAt
  releaseClass='pre-ga'; gaPromotionEligible=$false
}
$operationSignaturePath = "$ReceiptPath.sig.json"
$signed = New-OsShellEdgeSignedDocument -Document $operationReceipt -DocumentPath $ReceiptPath `
  -SignaturePath $operationSignaturePath -SigningKeyPath $SigningKey -KeyId $SigningKeyId
if (-not (Test-OsShellEdgeSignedDocument -DocumentPath $ReceiptPath -SignaturePath $operationSignaturePath `
    -TrustedPublicKeySpkiBase64 $trustedSpki -ExpectedKeyId $SigningKeyId)) { throw 'Disable receipt signature did not verify' }
Write-Host '[success] OS Shell disabled, drained, Pods=0, tickets=0, exact workloads scaled to zero'
Write-Host "[receipt] $ReceiptPath"
