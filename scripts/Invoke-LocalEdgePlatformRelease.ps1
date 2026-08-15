#requires -Version 7.2

[CmdletBinding(DefaultParameterSetName = 'Submit')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Submit')]
  [Parameter(Mandatory, ParameterSetName = 'BootstrapA')][string]$PublicationEvidence,
  [Parameter(ParameterSetName = 'Submit')]
  [Parameter(ParameterSetName = 'BootstrapA')][string]$PublicationSignatureEvidence = '',
  [Parameter(Mandatory, ParameterSetName = 'Submit')]
  [Parameter(Mandatory, ParameterSetName = 'BootstrapA')][ValidateLength(8, 500)][string]$Reason,
  [Parameter(ParameterSetName = 'Submit')]
  [Parameter(ParameterSetName = 'BootstrapA')][string[]]$Components = @(),
  [Parameter(Mandatory, ParameterSetName = 'BootstrapA')][switch]$BootstrapA,
  [Parameter(Mandatory, ParameterSetName = 'BootstrapA')][string]$TrustedPublicKeySpkiBase64,
  [Parameter(Mandatory, ParameterSetName = 'BootstrapA')][string]$PlatformAuthorityPath,
  [Parameter(Mandatory, ParameterSetName = 'BootstrapA')][string]$SetupAuthorityPath,
  [Parameter(ParameterSetName = 'BootstrapA')][string]$ExpectedKeyId = 'opensphere-edge-local-v1',
  [Parameter(ParameterSetName = 'Submit')]
  [Parameter(ParameterSetName = 'BootstrapA')]
  [Parameter(Mandatory, ParameterSetName = 'Resume')][string]$ResumeStatePath = '',
  [Parameter(Mandatory, ParameterSetName = 'Resume')][switch]$Resume,
  [string]$ConsoleUrl = 'https://localhost:1114',
  [ValidateRange(3100, 7200)][int]$TimeoutSeconds = 3600
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$resumeContract = 'opensphere-local-edge-platform-release-resume/v1'
$bootstrapATrustContract = 'opensphere-bootstrap-a-trust-observation/v1'
. (Join-Path $PSScriptRoot 'os-shell-edge-signing.ps1')

function Invoke-Checked {
  if ($args.Count -lt 1) { throw 'Invoke-Checked requires an executable.' }
  $executable = [string]$args[0]
  $arguments = @($args | Select-Object -Skip 1)
  $output = & $executable @arguments
  if ($LASTEXITCODE -ne 0) { throw "$executable failed with exit code $LASTEXITCODE" }
  return $output
}

function New-LocalEdgeToken {
  $value = (Invoke-Checked kubectl -n opensphere-console create token opensphere-local-edge-release `
    --audience opensphere-local-edge-release --duration=10m).Trim()
  if (-not $value) { throw 'Kubernetes did not issue the local edge automation token.' }
  return $value
}

function Get-Sha256([byte[]]$Bytes) {
  $hash = [Security.Cryptography.SHA256]::HashData($Bytes)
  return 'sha256:' + [Convert]::ToHexString($hash).ToLowerInvariant()
}

function Get-GitBlobBytes([string]$Repository, [string]$ObjectPath) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = 'git'
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  [void]$start.ArgumentList.Add('-C')
  [void]$start.ArgumentList.Add($Repository)
  [void]$start.ArgumentList.Add('cat-file')
  [void]$start.ArgumentList.Add('blob')
  [void]$start.ArgumentList.Add($ObjectPath)
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

function Get-BootstrapATrustObservation(
  [string]$SuppliedSpkiBase64,
  [string]$KeyId
) {
  if ($KeyId -cne 'opensphere-edge-local-v1') {
    throw 'Bootstrap A requires the exact Docker Desktop edge-local key ID.'
  }
  $configMap = ((Invoke-Checked kubectl -n opensphere-console get configmap dupa-trusted-keys -o json) -join "`n") |
    ConvertFrom-Json
  if ([string]$configMap.metadata.uid -notmatch '^[A-Za-z0-9._:-]{8,128}$' -or
      [string]$configMap.metadata.resourceVersion -notmatch '^[A-Za-z0-9._:-]{1,128}$' -or
      (@($configMap.data.PSObject.Properties.Name) -join ',') -cne 'trusted-keys.json') {
    throw 'Cluster edge trust ConfigMap lacks an exact UID/resourceVersion/data contract.'
  }
  $keyDocument = [string]$configMap.data.'trusted-keys.json' | ConvertFrom-Json
  if ((@($keyDocument.PSObject.Properties.Name) -join ',') -cne 'trustedKeys') {
    throw 'Cluster edge trust document is not the exact trustedKeys contract.'
  }
  $clusterSpkiBase64 = [string]$keyDocument.trustedKeys.$KeyId
  if (-not $clusterSpkiBase64 -or $clusterSpkiBase64 -cne $SuppliedSpkiBase64) {
    throw 'Supplied Bootstrap A public key differs from the cluster trust authority.'
  }
  try {
    $spki = [Convert]::FromBase64String($clusterSpkiBase64)
    if ([Convert]::ToBase64String($spki) -cne $clusterSpkiBase64) { throw 'non-canonical base64' }
    $publicKey = [Security.Cryptography.ECDsa]::Create()
    try {
      [void]$publicKey.ImportSubjectPublicKeyInfo($spki, [ref]0)
      if ($publicKey.KeySize -ne 256) { throw 'not P-256' }
    } finally { $publicKey.Dispose() }
  } catch { throw 'Cluster Bootstrap A trust key is not canonical P-256 SPKI.' }
  return [ordered]@{
    configMapResourceVersion = [string]$configMap.metadata.resourceVersion
    configMapUid = [string]$configMap.metadata.uid
    contract = $bootstrapATrustContract
    keyId = $KeyId
    keySpkiSha256 = Get-Sha256 $spki
  }
}

function Assert-ExactBootstrapAEvidence([object]$Evidence) {
  $expected = @(
    'apiVersion','kind','contract','bootstrapPhase','publicationScope','channel','status',
    'releaseTag','immutableTag','source','sourceRevision','buildAuthority','releaseClass',
    'gaEligible','supportedPlatforms','requestIntent','changedPaths','affectedImages',
    'releaseScope','fullReleaseJustification','previous','platformAuthority','setupSource',
    'artifacts','components','tooling','verification','generatedAt'
  )
  $actual = @($Evidence.PSObject.Properties.Name | Sort-Object)
  if (Compare-Object ($expected | Sort-Object) $actual) {
    throw 'Bootstrap A publication contains missing or unsupported top-level fields.'
  }
  if ([string]$Evidence.apiVersion -cne 'release.opensphere.io/v1alpha1' -or
      [string]$Evidence.kind -cne 'OpenSphereBackendComponentBootstrapAPublication' -or
      [string]$Evidence.contract -cne 'opensphere-backend-component-bootstrap-a-publication/v1' -or
      [string]$Evidence.bootstrapPhase -cne 'A' -or
      [string]$Evidence.publicationScope -cne 'ComponentSet' -or
      [string]$Evidence.channel -cne 'edge' -or [string]$Evidence.status -cne 'Active' -or
      [string]$Evidence.source -cne 'https://github.com/opensphere-platform/OpenSphere-console' -or
      [string]$Evidence.buildAuthority -cne 'localhost' -or
      [string]$Evidence.releaseClass -cne 'pre-ga' -or [bool]$Evidence.gaEligible -or
      [string]$Evidence.releaseScope -cne 'component' -or $null -ne $Evidence.fullReleaseJustification -or
      (@($Evidence.affectedImages) -join ',') -cne 'backend' -or
      (@($Evidence.supportedPlatforms) -join ',') -cne 'linux/amd64' -or
      [string]$Evidence.sourceRevision -notmatch '^[a-f0-9]{40}$' -or
      [string]$Evidence.components.backend.sourceRevision -cne [string]$Evidence.sourceRevision -or
      [string]$Evidence.components.backend.image -notmatch '^ghcr[.]io/opensphere-platform/opensphere-console-backend@sha256:[a-f0-9]{64}$' -or
      [bool]$Evidence.components.backend.registryCredentialsRequired -or
      [string]$Evidence.previous.image -ceq [string]$Evidence.components.backend.image -or
      [string]$Evidence.previous.sourceRevision -ceq [string]$Evidence.sourceRevision -or
      [string]$Evidence.verification.contract -cne 'opensphere-backend-component-verification-set/v1' -or
      [string]$Evidence.verification.setDigest -notmatch '^sha256:[a-f0-9]{64}$') {
    throw 'Bootstrap A publication is outside the exact signed offline contract.'
  }
}

function Assert-BootstrapAClusterBase([object]$Evidence) {
  $lockConfig = ((Invoke-Checked kubectl -n opensphere-console get configmap opensphere-installation-lock -o json) -join "`n") |
    ConvertFrom-Json
  $lock = [string]$lockConfig.data.'release.json' | ConvertFrom-Json
  if ([string]$lock.components.backend.image -cne [string]$Evidence.previous.image -or
      [string]$lock.components.backend.sourceRevision -cne [string]$Evidence.previous.sourceRevision -or
      [string]$lock.releaseDigest -notmatch '^sha256:[a-f0-9]{64}$') {
    throw 'Bootstrap A signed previous identity differs from the installed Backend base.'
  }
  $repositoryRoot = Split-Path -Parent $PSScriptRoot
  [byte[]]$expectedMigrationBytes = Get-GitBlobBytes $repositoryRoot `
    "$([string]$Evidence.previous.sourceRevision):backend/supabase/migrations/manifest.json"
  $expectedMigration = [Text.UTF8Encoding]::new($false,$true).GetString($expectedMigrationBytes) |
    ConvertFrom-Json
  $installedMigrationSetDigest = if ($null -ne $lock.componentPublication -and
      [string]$lock.componentPublication.migrationSetDigest) {
    [string]$lock.componentPublication.migrationSetDigest
  } elseif ($null -ne $lock.releaseBom -and [string]$lock.releaseBom.migrationManifest.setDigest) {
    [string]$lock.releaseBom.migrationManifest.setDigest
  } else { [string]$expectedMigration.setDigest }
  if ($installedMigrationSetDigest -cne [string]$expectedMigration.setDigest) {
    throw 'Installed migration authority differs from the exact previous-source manifest.'
  }
  $published = $Evidence.artifacts.supabaseMigrationManifest
  if ([string]$expectedMigration.setDigest -notmatch '^sha256:[a-f0-9]{64}$' -or
      [string]$published.sha256 -cne (Get-Sha256 $expectedMigrationBytes) -or
      [string]$published.setDigest -cne [string]$expectedMigration.setDigest -or
      ($null -ne $expectedMigration.latestMigrationId -and
        [string]$published.latestMigrationId -cne [string]$expectedMigration.latestMigrationId) -or
      ($null -ne $expectedMigration.migrationCount -and
        [int]$published.migrationCount -ne [int]$expectedMigration.migrationCount)) {
    throw 'Bootstrap A publication changes the installed migration set.'
  }
}

function Assert-BootstrapASourceEvidence(
  [object]$Evidence,
  [string]$EvidencePath,
  [string]$PlatformPath,
  [string]$SetupPath
) {
  $console = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
  $platform = (Resolve-Path -LiteralPath $PlatformPath).Path
  $setup = (Resolve-Path -LiteralPath $SetupPath).Path
  foreach ($authority in @(
    [pscustomobject]@{ Path=$console; Revision=[string]$Evidence.sourceRevision;
      Remote='https://github.com/opensphere-platform/OpenSphere-console.git'; Label='Console' },
    [pscustomobject]@{ Path=$platform; Revision=[string]$Evidence.platformAuthority.sourceRevision;
      Remote='https://github.com/opensphere-platform/OpenSphere-Platform-V2.git'; Label='Platform' },
    [pscustomobject]@{ Path=$setup; Revision=[string]$Evidence.setupSource.sourceRevision;
      Remote='https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git'; Label='Setup' }
  )) {
    $head = ((Invoke-Checked git -C $authority.Path rev-parse HEAD) -join "`n").Trim()
    $remote = ((Invoke-Checked git -C $authority.Path remote get-url origin) -join "`n").Trim()
    $dirty = @(@((Invoke-Checked git -C $authority.Path status --porcelain=v1 --untracked-files=all)) |
      Where-Object { [string]$_ })
    if ($head -cne $authority.Revision -or $remote -cne $authority.Remote -or $dirty.Count) {
      throw "Bootstrap A $($authority.Label) authority is not the signed clean exact source."
    }
  }
  Invoke-Checked git -C $console merge-base --is-ancestor `
    ([string]$Evidence.previous.sourceRevision) ([string]$Evidence.sourceRevision) | Out-Null
  $actualChanged = @(@((Invoke-Checked git -C $console diff --name-only `
    "$([string]$Evidence.previous.sourceRevision)..$([string]$Evidence.sourceRevision)" --)) |
    ForEach-Object { [string]$_ } | Where-Object { $_ } | Sort-Object -Unique)
  if (Compare-Object @($Evidence.changedPaths) $actualChanged) {
    throw 'Bootstrap A signed changedPaths differ from the exact previous-to-target Console diff.'
  }
  Invoke-Checked git -C $setup merge-base --is-ancestor `
    ([string]$Evidence.previous.setupSourceRevision) ([string]$Evidence.setupSource.sourceRevision) | Out-Null
  $actualSetupChanged = @(@((Invoke-Checked git -C $setup diff --name-only `
    "$([string]$Evidence.previous.setupSourceRevision)..$([string]$Evidence.setupSource.sourceRevision)" --)) |
    ForEach-Object { [string]$_ } | Where-Object { $_ } | Sort-Object -Unique)
  if (Compare-Object @($Evidence.setupSource.changedPaths) $actualSetupChanged) {
    throw 'Bootstrap A signed Setup changedPaths differ from its exact revision transition.'
  }
  $expectedToolPaths = [ordered]@{
    publisher='scripts/Publish-LocalEdgeBackendComponent.ps1'
    deployer='scripts/Invoke-LocalEdgePlatformRelease.ps1'
    signingHelper='scripts/os-shell-edge-signing.ps1'
    initializer='scripts/Initialize-FoundationOwnerInstallationLock.ps1'
    bootstrapAValidator='backend/opensphere-console-backend/platform-release-contract.js'
  }
  if ((@($Evidence.tooling.PSObject.Properties.Name | Sort-Object) -join ',') -cne
      (@($expectedToolPaths.Keys | Sort-Object) -join ',')) {
    throw 'Bootstrap A signed tooling set is incomplete or unsupported.'
  }
  foreach ($name in $expectedToolPaths.Keys) {
    $tool = $Evidence.tooling.$name
    $relative = [string]$expectedToolPaths[$name]
    $blobId = ((Invoke-Checked git -C $console rev-parse `
      "$([string]$Evidence.sourceRevision):$relative") -join "`n").Trim()
    $checkedOutSha256 = Get-Sha256 ([IO.File]::ReadAllBytes((Join-Path $console $relative)))
    if ([string]$tool.path -cne $relative -or [string]$tool.gitBlob -cne $blobId -or
        [string]$tool.sha256 -cne $checkedOutSha256) {
      throw "Bootstrap A signed tooling evidence differs from source blob $relative."
    }
  }
  [byte[]]$inventoryBlob = Get-GitBlobBytes $platform `
    "$([string]$Evidence.platformAuthority.sourceRevision):repository-inventory.json"
  $inventoryBlobId = ((Invoke-Checked git -C $platform rev-parse `
    "$([string]$Evidence.platformAuthority.sourceRevision):repository-inventory.json") -join "`n").Trim()
  $inventorySha256 = Get-Sha256 ([IO.File]::ReadAllBytes(
    (Join-Path $platform 'repository-inventory.json')))
  if ([string]$Evidence.platformAuthority.inventory.path -cne 'repository-inventory.json' -or
      [string]$Evidence.platformAuthority.inventory.gitBlob -cne $inventoryBlobId -or
      [string]$Evidence.platformAuthority.inventory.sha256 -cne $inventorySha256) {
    throw 'Bootstrap A Platform inventory evidence differs from its signed exact source.'
  }
  [byte[]]$setupLockBlob = Get-GitBlobBytes $console `
    "$([string]$Evidence.sourceRevision):backend/opensphere-console-backend/setup-source.lock"
  $setupLockRevision = [Text.UTF8Encoding]::new($false,$true).GetString($setupLockBlob).Trim()
  $setupLockSha256 = Get-Sha256 ([IO.File]::ReadAllBytes((Join-Path $console `
    'backend/opensphere-console-backend/setup-source.lock')))
  if ($setupLockRevision -cne [string]$Evidence.setupSource.sourceRevision -or
      [string]$Evidence.setupSource.lockSha256 -cne $setupLockSha256) {
    throw 'Bootstrap A Setup source differs from the signed Console setup-source.lock.'
  }
  $projection = $Evidence.setupSource.manifestProjectionTool
  $projectionPath = 'src/platform-release-bootstrap-manifest.mjs'
  $projectionKeys = @($projection.PSObject.Properties.Name | Sort-Object)
  if (($projectionKeys -join ',') -cne 'gitBlob,path,sha256') {
    throw 'Bootstrap A Setup manifest projection tool evidence is not exact.'
  }
  $projectionBlob = ((Invoke-Checked git -C $setup rev-parse `
    "$([string]$Evidence.setupSource.sourceRevision):$projectionPath") -join "`n").Trim()
  $projectionSha256 = Get-Sha256 ([IO.File]::ReadAllBytes((Join-Path $setup $projectionPath)))
  if ([string]$projection.path -cne $projectionPath -or
      [string]$projection.gitBlob -cne $projectionBlob -or
      [string]$projection.sha256 -cne $projectionSha256) {
    throw 'Bootstrap A Setup manifest projection tool differs from its signed exact source.'
  }
  $evidenceDirectory = Split-Path -Parent $EvidencePath
  foreach ($result in @($Evidence.verification.results)) {
    $leaf = ([string]$result.artifactUri).Substring('evidence://'.Length)
    $artifactPath = Join-Path $evidenceDirectory $leaf
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf) -or
        [string]$result.artifactSha256 -cne (Get-Sha256 ([IO.File]::ReadAllBytes($artifactPath)))) {
      throw "Bootstrap A verification artifact is missing or changed: $leaf"
    }
  }
  $renderedLeaf = ([string]$Evidence.verification.renderedManifest.artifactUri).Substring(
    'evidence://'.Length)
  $renderedPath = Join-Path $evidenceDirectory $renderedLeaf
  if (-not (Test-Path -LiteralPath $renderedPath -PathType Leaf) -or
      [string]$Evidence.verification.renderedManifest.sha256 -cne `
        (Get-Sha256 ([IO.File]::ReadAllBytes($renderedPath)))) {
    throw 'Bootstrap A rendered manifest artifact is missing or changed.'
  }
}

function Add-BootstrapATrustSuffix([string]$OperatorReason, [object]$Observation) {
  if ($OperatorReason.Contains('[bootstrap-a-trust:')) {
    throw 'Bootstrap A operator reason cannot contain a trust observation marker.'
  }
  $json = $Observation | ConvertTo-Json -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+','-').Replace('/','_')
  $governedReason = "$($OperatorReason.Trim()) [bootstrap-a-trust:$encoded]"
  if ([Text.Encoding]::UTF8.GetByteCount($OperatorReason.Trim()) -lt 8 -or
      [Text.Encoding]::UTF8.GetByteCount($governedReason) -gt 500) {
    throw 'Bootstrap A governed reason must retain an 8+ byte operator reason within the 500-byte old contract.'
  }
  return $governedReason
}

function New-BootstrapAResumeProof(
  [string]$EvidencePath,
  [string]$SignaturePath,
  [string]$TrustedSpkiBase64,
  [string]$KeyId,
  [string]$PlatformPath,
  [string]$SetupPath
) {
  return [ordered]@{
    contract = 'opensphere-backend-bootstrap-a-resume-proof/v1'
    evidencePath = [IO.Path]::GetFullPath($EvidencePath)
    evidenceSha256 = Get-Sha256 ([IO.File]::ReadAllBytes($EvidencePath))
    signaturePath = [IO.Path]::GetFullPath($SignaturePath)
    signatureSha256 = Get-Sha256 ([IO.File]::ReadAllBytes($SignaturePath))
    trustedPublicKeySpkiBase64 = $TrustedSpkiBase64
    expectedKeyId = $KeyId
    platformAuthorityPath = [IO.Path]::GetFullPath($PlatformPath)
    setupAuthorityPath = [IO.Path]::GetFullPath($SetupPath)
  }
}

function Assert-BootstrapARequestPendingProof(
  [object]$Proof,
  [object]$StoredObservation,
  [string]$RequestBodyBase64
) {
  $proofKeys = @($Proof.PSObject.Properties.Name | Sort-Object)
  $expectedProofKeys = @(
    'contract','evidencePath','evidenceSha256','signaturePath','signatureSha256',
    'trustedPublicKeySpkiBase64','expectedKeyId','platformAuthorityPath','setupAuthorityPath'
  ) | Sort-Object
  if (($proofKeys -join ',') -cne ($expectedProofKeys -join ',') -or
      [string]$Proof.contract -cne 'opensphere-backend-bootstrap-a-resume-proof/v1') {
    throw 'Bootstrap A RequestPending state lacks the exact signed resume proof.'
  }
  $evidencePath = (Resolve-Path -LiteralPath ([string]$Proof.evidencePath)).Path
  $signaturePath = (Resolve-Path -LiteralPath ([string]$Proof.signaturePath)).Path
  if ((Get-Sha256 ([IO.File]::ReadAllBytes($evidencePath))) -cne [string]$Proof.evidenceSha256 -or
      (Get-Sha256 ([IO.File]::ReadAllBytes($signaturePath))) -cne [string]$Proof.signatureSha256) {
    throw 'Bootstrap A RequestPending signed evidence changed after validation.'
  }
  $evidence = Get-Content -Raw -LiteralPath $evidencePath | ConvertFrom-Json
  Assert-ExactBootstrapAEvidence $evidence
  $contractPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot `
    '..\backend\opensphere-console-backend\platform-release-contract.js')).Path
  $validator = "const fs=require('fs');const c=require(process.argv[1]);c.validateBackendBootstrapAPublication(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));"
  Invoke-Checked node -e $validator $contractPath $evidencePath | Out-Null
  Assert-BootstrapASourceEvidence $evidence $evidencePath `
    ([string]$Proof.platformAuthorityPath) ([string]$Proof.setupAuthorityPath)
  Assert-BootstrapAClusterBase $evidence
  $observation = Get-BootstrapATrustObservation `
    ([string]$Proof.trustedPublicKeySpkiBase64) ([string]$Proof.expectedKeyId)
  if (($observation | ConvertTo-Json -Compress) -cne ($StoredObservation | ConvertTo-Json -Compress)) {
    throw 'Bootstrap A RequestPending trust observation differs from current cluster authority.'
  }
  if (-not (Test-OsShellEdgeSignedDocument -DocumentPath $evidencePath -SignaturePath $signaturePath `
      -TrustedPublicKeySpkiBase64 ([string]$Proof.trustedPublicKeySpkiBase64) `
      -ExpectedKeyId ([string]$Proof.expectedKeyId))) {
    throw 'Bootstrap A RequestPending signature verification failed.'
  }
  try {
    $payloadBytes = [Convert]::FromBase64String($RequestBodyBase64)
    if ([Convert]::ToBase64String($payloadBytes) -cne $RequestBodyBase64) { throw 'non-canonical' }
    $payload = [Text.Encoding]::UTF8.GetString($payloadBytes)
    $pending = $payload | ConvertFrom-Json
  } catch { throw 'Bootstrap A RequestPending state has invalid exact request bytes.' }
  if ((@($pending.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'components,reason,sourceRevision' -or
      (@($pending.components.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'backend' -or
      (@($pending.components.backend.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'image' -or
      [string]$pending.sourceRevision -cne [string]$evidence.sourceRevision -or
      [string]$pending.components.backend.image -cne [string]$evidence.components.backend.image) {
    throw 'Bootstrap A RequestPending state is not the signed exact old 3-key request.'
  }
  $marker = ' [bootstrap-a-trust:'
  $markerIndex = ([string]$pending.reason).LastIndexOf($marker, [StringComparison]::Ordinal)
  if ($markerIndex -lt 8) { throw 'Bootstrap A RequestPending reason lacks its trust observation.' }
  $operatorReason = ([string]$pending.reason).Substring(0,$markerIndex)
  if ($operatorReason -cne [string]$evidence.requestIntent -or
      [string]$pending.reason -cne (Add-BootstrapATrustSuffix $operatorReason $observation)) {
    throw 'Bootstrap A RequestPending reason differs from signed request intent or trust authority.'
  }
  return $payload
}

function Get-AbsoluteStatePath([string]$Value, [string]$DefaultPath = '') {
  $candidate = if ($Value) { $Value } else { $DefaultPath }
  if (-not $candidate) { throw 'ResumeStatePath is required.' }
  return [IO.Path]::GetFullPath($candidate)
}

function Read-ResumeState([string]$Path) {
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $state = Get-Content -Raw -LiteralPath $resolved | ConvertFrom-Json
  $requestPending = [string]$state.mode -ceq 'BootstrapA' -and
    [string]$state.phase -ceq 'RequestPending' -and -not [string]$state.requestId -and
    -not [string]$state.targetReleaseDigest -and [string]$state.requestBodyBase64
  $durableRequest = [string]$state.requestId -match '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -and
    [string]$state.targetReleaseDigest -match '^sha256:[0-9a-f]{64}$'
  if ($state.contract -ne $resumeContract -or (-not $requestPending -and -not $durableRequest)) {
    throw 'ResumeStatePath does not contain an exact Platform Release resume identity.'
  }
  return [pscustomobject]@{ Path = $resolved; State = $state }
}

function Save-ResumeState(
  [string]$Path,
  [string]$RequestId,
  [string]$TargetReleaseDigest,
  [string]$Phase,
  [string]$LastError = '',
  [object]$OperationStatus = $null,
  [string]$Mode = 'SignedB',
  [string]$RequestBodyBase64 = '',
  [object]$TrustObservation = $null,
  [object]$BootstrapAProof = $null
) {
  if (Test-Path -LiteralPath $Path) {
    $existing = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ($existing.contract -ne $resumeContract -or
        ([string]$existing.requestId -and [string]$existing.requestId -ne $RequestId) -or
        ([string]$existing.targetReleaseDigest -and
          [string]$existing.targetReleaseDigest -ne $TargetReleaseDigest)) {
      throw 'ResumeStatePath is occupied by a different release operation.'
    }
  }
  $document = [ordered]@{
    contract = $resumeContract
    mode = $Mode
    requestId = $RequestId
    targetReleaseDigest = $TargetReleaseDigest
    phase = $Phase
    statusUrl = "$($ConsoleUrl.TrimEnd('/'))/api/platform/releases/local-edge-automation/$RequestId"
    lastError = if ($LastError) { $LastError } else { $null }
    operationStatus = $OperationStatus
    requestBodyBase64 = if ($RequestBodyBase64) { $RequestBodyBase64 } else { $null }
    trustObservation = $TrustObservation
    bootstrapAProof = $BootstrapAProof
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "Resume state parent directory does not exist: $parent"
  }
  $temporary = Join-Path $parent ".$(Split-Path -Leaf $Path).$PID.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $document | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -NoNewline -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
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

$requestId = ''
$targetReleaseDigest = ''
$changedComponents = @()
$resumePath = ''
$terminal = $false
$needsAttentionRecorded = $false
$token = $null
$mode = 'SignedB'
$requestBodyBase64 = ''
$trustObservation = $null
$bootstrapAProof = $null

try {
  if ($PSCmdlet.ParameterSetName -ne 'Resume') {
    $evidencePath = (Resolve-Path -LiteralPath $PublicationEvidence).Path
    $signaturePath = if ($PublicationSignatureEvidence) {
      (Resolve-Path -LiteralPath $PublicationSignatureEvidence).Path
    } else {
      (Resolve-Path -LiteralPath "$evidencePath.sig.json").Path
    }
    $evidenceBytes = [IO.File]::ReadAllBytes($evidencePath)
    $evidence = Get-Content -Raw -LiteralPath $evidencePath | ConvertFrom-Json
    $publicationSignature = Get-Content -Raw -LiteralPath $signaturePath | ConvertFrom-Json
    if ($PSCmdlet.ParameterSetName -eq 'BootstrapA') {
      Assert-ExactBootstrapAEvidence $evidence
      $contractPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot `
        '..\backend\opensphere-console-backend\platform-release-contract.js')).Path
      $validator = "const fs=require('fs');const c=require(process.argv[1]);c.validateBackendBootstrapAPublication(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));"
      Invoke-Checked node -e $validator $contractPath $evidencePath | Out-Null
      Assert-BootstrapASourceEvidence $evidence $evidencePath $PlatformAuthorityPath $SetupAuthorityPath
      Assert-BootstrapAClusterBase $evidence
      $trustObservation = Get-BootstrapATrustObservation $TrustedPublicKeySpkiBase64 $ExpectedKeyId
      if (-not (Test-OsShellEdgeSignedDocument -DocumentPath $evidencePath -SignaturePath $signaturePath `
        -TrustedPublicKeySpkiBase64 $TrustedPublicKeySpkiBase64 -ExpectedKeyId $ExpectedKeyId)) {
        throw 'Bootstrap A offline publication signature verification failed.'
      }
      if ([string]$evidence.requestIntent -cne $Reason) {
        throw 'Bootstrap A operator reason must exactly equal the signed request intent.'
      }
      $bootstrapAProof = New-BootstrapAResumeProof $evidencePath $signaturePath `
        $TrustedPublicKeySpkiBase64 $ExpectedKeyId $PlatformAuthorityPath $SetupAuthorityPath
    } elseif ($evidence.apiVersion -ne 'release.opensphere.io/v1alpha1' -or
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
    if ([string]$evidence.immutableTag -notmatch '^[a-z0-9][a-z0-9._-]{0,127}$') {
      throw 'PublicationEvidence does not contain a canonical immutable tag.'
    }
    $resumePath = Get-AbsoluteStatePath $ResumeStatePath `
      "$evidencePath.$([string]$evidence.immutableTag).platform-release.resume.json"
    if (Test-Path -LiteralPath $resumePath) {
      throw "Resume state already exists; resume it instead of submitting another mutation: $resumePath"
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

    $payload = if ($PSCmdlet.ParameterSetName -eq 'BootstrapA') {
      [ordered]@{
        reason = Add-BootstrapATrustSuffix $Reason $trustObservation
        sourceRevision = [string]$evidence.sourceRevision
        components = $componentRequest
      } | ConvertTo-Json -Depth 8 -Compress
    } else {
      [ordered]@{
        reason = $Reason
        sourceRevision = [string]$evidence.sourceRevision
        components = $componentRequest
        publicationDocumentBase64 = [Convert]::ToBase64String($evidenceBytes)
        publicationSignature = $publicationSignature
      } | ConvertTo-Json -Depth 8 -Compress
    }
    $mode = if ($PSCmdlet.ParameterSetName -eq 'BootstrapA') { 'BootstrapA' } else { 'SignedB' }
    $requestBodyBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    if ($mode -eq 'BootstrapA') {
      Save-ResumeState $resumePath '' '' 'RequestPending' '' $null $mode $requestBodyBase64 `
        $trustObservation $bootstrapAProof
    }
    $token = New-LocalEdgeToken
    Write-Host '[authority] docker-desktop ServiceAccount/audience opensphere-local-edge-release'
    Write-Host "[scope] $($selected -join ', ')"
    # The exact request is idempotent across the A -> B Backend
    # replacement. If the old server durably records the request but its HTTP
    # response is lost, retry the identical bytes; A/B returns only the same
    # governed request identity and never creates a second mutation.
    $response = $null
    $submitLastError = ''
    $submitDeadline = [DateTimeOffset]::UtcNow.AddSeconds([Math]::Min(600,$TimeoutSeconds))
    do {
      try {
        $response = Invoke-RestMethod -Method Post `
          -Uri "$($ConsoleUrl.TrimEnd('/'))/api/platform/releases/local-edge-automation" `
          -Headers @{ Authorization = "Bearer $token"; Accept = 'application/json' } `
          -ContentType 'application/json' -Body $payload -TimeoutSec 120
        break
      } catch {
        $submitLastError = [string]$_.Exception.Message
        if ([DateTimeOffset]::UtcNow -lt $submitDeadline) { Start-Sleep -Seconds 5 }
      }
    } while ([DateTimeOffset]::UtcNow -lt $submitDeadline)
    if (-not $response) {
      if ($mode -eq 'SignedB') {
        throw "Exact signed Platform Release request response was not recovered: $submitLastError"
      }
      throw "Exact Bootstrap A request response was not recovered: $submitLastError"
    }
    if (-not $response.requestId -or [string]$response.targetReleaseDigest -notmatch '^sha256:[0-9a-f]{64}$') {
      throw 'Console response did not contain a governed request and target release digest.'
    }
    $requestId = [string]$response.requestId
    $targetReleaseDigest = [string]$response.targetReleaseDigest
    $changedComponents = @($response.changedComponents)
    Save-ResumeState $resumePath $requestId $targetReleaseDigest 'Applying' '' $null $mode `
      $requestBodyBase64 $trustObservation $bootstrapAProof
    Write-Host "[request] $requestId"
    Write-Host "[target] $targetReleaseDigest"
    Write-Host "[resume] $resumePath"
  } else {
    $loaded = Read-ResumeState (Get-AbsoluteStatePath $ResumeStatePath)
    $resumePath = $loaded.Path
    $mode = [string]$loaded.State.mode
    $requestBodyBase64 = [string]$loaded.State.requestBodyBase64
    $trustObservation = $loaded.State.trustObservation
    $bootstrapAProof = $loaded.State.bootstrapAProof
    $requestId = [string]$loaded.State.requestId
    $targetReleaseDigest = [string]$loaded.State.targetReleaseDigest
    if ([string]$loaded.State.phase -ceq 'RequestPending') {
      $payload = Assert-BootstrapARequestPendingProof $bootstrapAProof $trustObservation $requestBodyBase64
      $token = New-LocalEdgeToken
      $response = Invoke-RestMethod -Method Post `
        -Uri "$($ConsoleUrl.TrimEnd('/'))/api/platform/releases/local-edge-automation" `
        -Headers @{ Authorization = "Bearer $token"; Accept = 'application/json' } `
        -ContentType 'application/json' -Body $payload -TimeoutSec 120
      if (-not $response.requestId -or [string]$response.targetReleaseDigest -notmatch '^sha256:[0-9a-f]{64}$') {
        throw 'Console response did not contain a governed Bootstrap A request and target release digest.'
      }
      $requestId = [string]$response.requestId
      $targetReleaseDigest = [string]$response.targetReleaseDigest
      $changedComponents = @($response.changedComponents)
      Save-ResumeState $resumePath $requestId $targetReleaseDigest 'Applying' '' $null $mode `
        $requestBodyBase64 $loaded.State.trustObservation $bootstrapAProof
    }
    Write-Host "[resume] exact request $requestId -> $targetReleaseDigest"
  }

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $operationStatus = $null
    try {
      $statusToken = New-LocalEdgeToken
      try {
        $operationStatus = Invoke-RestMethod -Method Get `
          -Uri "$($ConsoleUrl.TrimEnd('/'))/api/platform/releases/local-edge-automation/$requestId" `
          -Headers @{ Authorization = "Bearer $statusToken"; Accept = 'application/json' } `
          -TimeoutSec 30
      } finally { $statusToken = $null }
    } catch {
      # Backend replacement is expected. The durable request is resumed by its
      # exact identity; no second mutation request is ever submitted.
      $operationStatus = $null
    }
    if ($operationStatus) {
      Save-ResumeState $resumePath $requestId $targetReleaseDigest ([string]$operationStatus.phase) `
        ([string]$operationStatus.lastError) $operationStatus $mode $requestBodyBase64 `
        $trustObservation $bootstrapAProof
    }
    if ($operationStatus -and [string]$operationStatus.phase -eq 'Failed') {
      $terminal = $true
      throw "Governed apply operation failed: $([string]$operationStatus.lastError)"
    }
    if ($operationStatus -and [string]$operationStatus.phase -eq 'NeedsAttention') {
      throw "Governed apply operation requires operator attention: $([string]$operationStatus.lastError)"
    }
    $expectedTerminalPhase = if ($mode -eq 'BootstrapA') { 'BootstrapApplied' } else { 'Completed' }
    if ($operationStatus -and [string]$operationStatus.phase -eq $expectedTerminalPhase -and
        $operationStatus.receipt -and [bool]$operationStatus.receipt.succeeded) {
      $lockConfig = (Invoke-Checked kubectl -n opensphere-console get configmap opensphere-installation-lock -o json) |
        ConvertFrom-Json
      $lock = [string]$lockConfig.data.'release.json' | ConvertFrom-Json
      if ([string]$lock.releaseDigest -ne $targetReleaseDigest) {
        throw 'Governed receipt completed but the installation lock differs from its target.'
      }
      Save-ResumeState $resumePath $requestId $targetReleaseDigest $expectedTerminalPhase '' $operationStatus `
        $mode $requestBodyBase64 $trustObservation $bootstrapAProof
      $terminal = $true
      Write-Host "[success] apply receipt and exact installation lock verified: $($lock.releaseDigest)"
      [pscustomobject]@{
        requestId = $requestId
        releaseDigest = [string]$lock.releaseDigest
        changedComponents = $changedComponents
        operation = 'apply'
        mergeRevision = [string]$operationStatus.mergeRevision
        operationId = [string]$operationStatus.receipt.operationId
        receiptEvidence = $operationStatus.receipt.evidence
        bootstrapFrom = $operationStatus.bootstrapFrom
        resumeStatePath = $resumePath
        observedAt = [DateTimeOffset]::UtcNow.ToString('o')
      }
      return
    }
    Start-Sleep -Seconds 5
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Timed out after $TimeoutSeconds seconds waiting for governed apply receipt $requestId."
} catch {
  $failure = [string]$_.Exception.Message
  if (-not $requestId -and $mode -eq 'BootstrapA' -and $resumePath -and $requestBodyBase64) {
    Save-ResumeState $resumePath '' '' 'RequestPending' $failure $null $mode `
      $requestBodyBase64 $trustObservation $bootstrapAProof
    throw "$failure Resume only this exact Bootstrap A request with: pwsh -File `"$PSCommandPath`" -Resume -ResumeStatePath `"$resumePath`""
  }
  if ($requestId -and -not $terminal) {
    Save-ResumeState $resumePath $requestId $targetReleaseDigest 'NeedsAttention' $failure $null `
      $mode $requestBodyBase64 $trustObservation $bootstrapAProof
    $needsAttentionRecorded = $true
    throw "$failure Resume only this exact durable operation with: pwsh -File `"$PSCommandPath`" -Resume -ResumeStatePath `"$resumePath`""
  }
  throw
} finally {
  $token = $null
  if ($requestId -and -not $terminal -and -not $needsAttentionRecorded -and $resumePath) {
    # PowerShell normally runs finally for pipeline interruption. Preserve an
    # exact resume identity even when catch was skipped by host cancellation.
    try {
      Save-ResumeState $resumePath $requestId $targetReleaseDigest 'NeedsAttention' `
        'caller stopped before a terminal governed receipt' $null $mode $requestBodyBase64 `
        $trustObservation $bootstrapAProof
    } catch { }
  }
}
