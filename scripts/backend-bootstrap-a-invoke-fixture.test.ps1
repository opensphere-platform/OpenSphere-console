#requires -Version 7.2

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256([byte[]]$Bytes) {
  return 'sha256:' + [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Invoke-Git([string]$Repository, [string[]]$Arguments) {
  $output = & git -C $Repository @Arguments
  if ($LASTEXITCODE -ne 0) { throw "git failed: $($Arguments -join ' ')" }
  return $output
}

function Get-GitBlobBytes([string]$Repository, [string]$ObjectPath) {
  $start = [Diagnostics.ProcessStartInfo]::new('git')
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in @('-C',$Repository,'cat-file','blob',$ObjectPath)) {
    [void]$start.ArgumentList.Add($argument)
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw 'git cat-file did not start' }
    $memory = [IO.MemoryStream]::new()
    try {
      $process.StandardOutput.BaseStream.CopyTo($memory)
      $errorText = $process.StandardError.ReadToEnd()
      $process.WaitForExit()
      if ($process.ExitCode -ne 0) { throw "git cat-file failed: $errorText" }
      return ,$memory.ToArray()
    } finally { $memory.Dispose() }
  } finally { $process.Dispose() }
}

function Set-CurrentUserOnlyAcl([string]$Path) {
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $currentSid,
    [Security.AccessControl.FileSystemRights]::Read -bor
      [Security.AccessControl.FileSystemRights]::Write,
    [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function New-ToolEvidence([string]$Repository, [string]$RelativePath) {
  $path = Join-Path $Repository $RelativePath
  return [ordered]@{
    path = $RelativePath.Replace('\','/')
    gitBlob = (Invoke-Git $Repository @('rev-parse',"HEAD:$($RelativePath.Replace('\','/'))")).Trim()
    sha256 = Get-Sha256 ([IO.File]::ReadAllBytes($path))
  }
}

function New-VerificationResult([string]$EvidenceRoot, [string]$Id) {
  $leaf = "$Id.log"
  $path = Join-Path $EvidenceRoot $leaf
  [IO.File]::WriteAllText($path,"PASS $Id`n",[Text.UTF8Encoding]::new($false))
  return [ordered]@{
    id = $Id
    result = 'PASS'
    artifactUri = "evidence://$leaf"
    artifactSha256 = Get-Sha256 ([IO.File]::ReadAllBytes($path))
    startedAt = '2026-08-15T00:00:00.000Z'
    completedAt = '2026-08-15T00:00:01.000Z'
  }
}

function Write-SignedEvidence(
  [System.Collections.IDictionary]$Document,
  [string]$DocumentPath,
  [string]$SignaturePath,
  [string]$KeyPath
) {
  return New-OsShellEdgeSignedDocument -Document $Document -DocumentPath $DocumentPath `
    -SignaturePath $SignaturePath -SigningKeyPath $KeyPath
}

function Assert-ThrowsWithoutPost([scriptblock]$Action, [string]$Label) {
  $before = $global:bootstrapAFixturePostBodies.Count
  try {
    & $Action *> $null
    throw "$Label was accepted"
  } catch {
    if ($_.Exception.Message -eq "$Label was accepted") { throw }
  }
  if ($global:bootstrapAFixturePostBodies.Count -ne $before) { throw "$Label reached the mutation endpoint" }
}

$sourceRoot = Split-Path $PSScriptRoot -Parent
$workspaceSourceRoot = Split-Path $sourceRoot -Parent
$setupProjectionRelativePath = 'OpenSphere-Setup-CLI\src\platform-release-bootstrap-manifest.mjs'
if (-not (Test-Path -LiteralPath (Join-Path $workspaceSourceRoot $setupProjectionRelativePath) -PathType Leaf)) {
  $workspaceSourceRoot = Split-Path $workspaceSourceRoot -Parent
}
if (-not (Test-Path -LiteralPath (Join-Path $workspaceSourceRoot $setupProjectionRelativePath) -PathType Leaf)) {
  throw "Canonical Setup projection source is missing: $setupProjectionRelativePath"
}
$workspace = Join-Path ([IO.Path]::GetTempPath()) `
  "opensphere-bootstrap-a-fixture-$PID-$([guid]::NewGuid().ToString('N'))"
$keyRoot = Join-Path $env:USERPROFILE '.opensphere\keys'
$keyDirectory = Join-Path $keyRoot "bootstrap-a-fixture-$([guid]::NewGuid().ToString('N'))"
$repository = Join-Path $workspace 'OpenSphere-console'
$platformRepository = Join-Path $workspace 'OpenSphere-Platform-V2'
$setupRepository = Join-Path $workspace 'OpenSphere-Setup-CLI'
$evidenceRoot = Join-Path $workspace 'evidence'
$global:bootstrapAFixturePostBodies = [Collections.Generic.List[string]]::new()
$global:bootstrapAFixturePostFailuresRemaining = 0
$global:bootstrapAFixtureSubmitted = $false
$global:bootstrapAFixtureDurableWriteBeforeResponseLoss = $false
$global:bootstrapAFixtureTrustSpki = ''
$global:bootstrapAFixtureBaseLockJson = ''
$global:bootstrapAFixtureTargetLockJson = ''
$requestId = '12345678-1234-4123-8123-123456789abc'
$targetDigest = 'sha256:' + ('c' * 64)
$global:bootstrapAFixtureRequestId = $requestId
$global:bootstrapAFixtureTargetDigest = $targetDigest

try {
  New-Item -ItemType Directory -Path $repository,$platformRepository,$setupRepository,
    $evidenceRoot,$keyDirectory -Force | Out-Null
  Invoke-Git $platformRepository @('init','-q','-b','main') | Out-Null
  Invoke-Git $platformRepository @('config','user.name','OpenSphere Fixture') | Out-Null
  Invoke-Git $platformRepository @('config','user.email','fixture@opensphere.invalid') | Out-Null
  Invoke-Git $platformRepository @('remote','add','origin',
    'https://github.com/opensphere-platform/OpenSphere-Platform-V2.git') | Out-Null
  $inventoryPath = Join-Path $platformRepository 'repository-inventory.json'
  [IO.File]::WriteAllText($inventoryPath,'{"repositories":[]}',[Text.UTF8Encoding]::new($false))
  Invoke-Git $platformRepository @('add','repository-inventory.json') | Out-Null
  Invoke-Git $platformRepository @('commit','-q','-m','fixture platform authority') | Out-Null
  $platformRevision = (Invoke-Git $platformRepository @('rev-parse','HEAD')).Trim()
  Invoke-Git $setupRepository @('init','-q','-b','main') | Out-Null
  Invoke-Git $setupRepository @('config','user.name','OpenSphere Fixture') | Out-Null
  Invoke-Git $setupRepository @('config','user.email','fixture@opensphere.invalid') | Out-Null
  Invoke-Git $setupRepository @('remote','add','origin',
    'https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git') | Out-Null
  [IO.File]::WriteAllText((Join-Path $setupRepository 'README.md'),'fixture setup',
    [Text.UTF8Encoding]::new($false))
  $fixtureProjectionPath = Join-Path $setupRepository 'src/platform-release-bootstrap-manifest.mjs'
  New-Item -ItemType Directory -Path (Split-Path -Parent $fixtureProjectionPath) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $workspaceSourceRoot $setupProjectionRelativePath) `
    -Destination $fixtureProjectionPath
  Invoke-Git $setupRepository @('add','README.md','src/platform-release-bootstrap-manifest.mjs') | Out-Null
  Invoke-Git $setupRepository @('commit','-q','-m','fixture setup authority') | Out-Null
  $setupRevision = (Invoke-Git $setupRepository @('rev-parse','HEAD')).Trim()
  foreach ($relative in @(
    'scripts/Invoke-LocalEdgePlatformRelease.ps1',
    'scripts/Publish-LocalEdgeBackendComponent.ps1',
    'scripts/os-shell-edge-signing.ps1',
    'scripts/Initialize-FoundationOwnerInstallationLock.ps1',
    'backend/opensphere-console-backend/platform-release-contract.js'
  )) {
    $destination = Join-Path $repository $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination $destination
  }
  $manifestPath = Join-Path $repository 'backend/supabase/migrations/manifest.json'
  New-Item -ItemType Directory -Path (Split-Path -Parent $manifestPath) -Force | Out-Null
  $migration = [ordered]@{
    schemaVersion = 2
    latestMigrationId = '0062'
    migrationCount = 61
    setDigest = 'sha256:' + ('d' * 64)
    migrations = @()
  }
  [IO.File]::WriteAllText($manifestPath,($migration | ConvertTo-Json -Depth 5),
    [Text.UTF8Encoding]::new($false))
  $setupLockPath = Join-Path $repository 'backend/opensphere-console-backend/setup-source.lock'
  [IO.File]::WriteAllText($setupLockPath,"$setupRevision`n",[Text.UTF8Encoding]::new($false))
  Invoke-Git $repository @('init','-q','-b','main') | Out-Null
  Invoke-Git $repository @('config','user.name','OpenSphere Fixture') | Out-Null
  Invoke-Git $repository @('config','user.email','fixture@opensphere.invalid') | Out-Null
  Invoke-Git $repository @('remote','add','origin',
    'https://github.com/opensphere-platform/OpenSphere-console.git') | Out-Null
  Invoke-Git $repository @('add','.') | Out-Null
  Invoke-Git $repository @('commit','-q','-m','fixture base') | Out-Null
  $previousRevision = (Invoke-Git $repository @('rev-parse','HEAD')).Trim()
  $contractPath = Join-Path $repository `
    'backend/opensphere-console-backend/platform-release-contract.js'
  [IO.File]::AppendAllText($contractPath,"`n",[Text.UTF8Encoding]::new($false))
  Invoke-Git $repository @('add','backend/opensphere-console-backend/platform-release-contract.js') | Out-Null
  Invoke-Git $repository @('commit','-q','-m','fixture bootstrap A') | Out-Null
  $sourceRevision = (Invoke-Git $repository @('rev-parse','HEAD')).Trim()

  . (Join-Path $repository 'scripts/os-shell-edge-signing.ps1')
  $keyPath = Join-Path $keyDirectory 'edge-key.pem'
  $key = [Security.Cryptography.ECDsa]::Create(
    [Security.Cryptography.ECCurve+NamedCurves]::nistP256)
  try { [IO.File]::WriteAllText($keyPath,$key.ExportPkcs8PrivateKeyPem()) }
  finally { $key.Dispose() }
  Set-CurrentUserOnlyAcl $keyPath

  $results = @(
    'bootstrap-a-invoke-fixture','console-full-test','console-test','fresh-ledger-verifier',
    'rendered-manifest-client-dry-run','rendered-manifest-server-dry-run',
    'setup-full-test','setup-test'
  ) | ForEach-Object { New-VerificationResult $evidenceRoot $_ }
  $renderedPath = Join-Path $evidenceRoot 'opensphere-console-backend-rendered.yaml'
  [IO.File]::WriteAllText($renderedPath,"kind: List`n",[Text.UTF8Encoding]::new($false))
  $rendered = [ordered]@{
    artifactUri = 'evidence://opensphere-console-backend-rendered.yaml'
    sha256 = Get-Sha256 ([IO.File]::ReadAllBytes($renderedPath))
  }
  $verificationContract = 'opensphere-backend-component-verification-set/v1'
  $verificationBytes = [Text.Encoding]::UTF8.GetBytes((
    [ordered]@{ contract=$verificationContract; results=@($results); renderedManifest=$rendered } |
      ConvertTo-Json -Depth 12 -Compress))
  $migrationBytes = Get-GitBlobBytes $repository `
    "$previousRevision`:backend/supabase/migrations/manifest.json"
  $targetImage = 'ghcr.io/opensphere-platform/opensphere-console-backend@sha256:' + ('b' * 64)
  $previousImage = 'ghcr.io/opensphere-platform/opensphere-console-backend@sha256:' + ('a' * 64)
  $tooling = [ordered]@{
    publisher = New-ToolEvidence $repository 'scripts/Publish-LocalEdgeBackendComponent.ps1'
    deployer = New-ToolEvidence $repository 'scripts/Invoke-LocalEdgePlatformRelease.ps1'
    signingHelper = New-ToolEvidence $repository 'scripts/os-shell-edge-signing.ps1'
    initializer = New-ToolEvidence $repository 'scripts/Initialize-FoundationOwnerInstallationLock.ps1'
    bootstrapAValidator = New-ToolEvidence $repository `
      'backend/opensphere-console-backend/platform-release-contract.js'
  }
  $publication = [ordered]@{
    apiVersion = 'release.opensphere.io/v1alpha1'
    kind = 'OpenSphereBackendComponentBootstrapAPublication'
    contract = 'opensphere-backend-component-bootstrap-a-publication/v1'
    bootstrapPhase = 'A'
    publicationScope = 'ComponentSet'
    channel = 'edge'
    status = 'Active'
    releaseTag = '202608150000'
    immutableTag = "local-$($sourceRevision.Substring(0,12))"
    source = 'https://github.com/opensphere-platform/OpenSphere-console'
    sourceRevision = $sourceRevision
    buildAuthority = 'localhost'
    releaseClass = 'pre-ga'
    gaEligible = $false
    supportedPlatforms = @('linux/amd64')
    requestIntent = 'install transitional backend bootstrap A'
    changedPaths = @('backend/opensphere-console-backend/platform-release-contract.js')
    affectedImages = @('backend')
    releaseScope = 'component'
    fullReleaseJustification = $null
    previous = [ordered]@{
      image=$previousImage; sourceRevision=$previousRevision; setupSourceRevision=$setupRevision
    }
    platformAuthority = [ordered]@{
      repository='https://github.com/opensphere-platform/OpenSphere-Platform-V2.git'
      sourceRevision=$platformRevision
      inventory=[ordered]@{
        path='repository-inventory.json'
        gitBlob=(Invoke-Git $platformRepository @('rev-parse','HEAD:repository-inventory.json')).Trim()
        sha256=Get-Sha256 ([IO.File]::ReadAllBytes($inventoryPath))
      }
    }
    setupSource = [ordered]@{
      repository='https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git'
      sourceRevision=$setupRevision; changedPaths=@()
      lockSha256=Get-Sha256 ([IO.File]::ReadAllBytes($setupLockPath))
      manifestProjectionTool=New-ToolEvidence $setupRepository `
        'src/platform-release-bootstrap-manifest.mjs'
    }
    artifacts = [ordered]@{
      supabaseMigrationManifest=[ordered]@{
        path='backend/supabase/migrations/manifest.json'
        sha256=Get-Sha256 $migrationBytes
        setDigest=[string]$migration.setDigest
        latestMigrationId=[string]$migration.latestMigrationId
        migrationCount=[int]$migration.migrationCount
      }
    }
    components = [ordered]@{
      backend=[ordered]@{
        image=$targetImage; sourceRevision=$sourceRevision; registryCredentialsRequired=$false
      }
    }
    tooling = $tooling
    verification = [ordered]@{
      contract=$verificationContract
      setDigest=Get-Sha256 $verificationBytes
      results=@($results)
      renderedManifest=$rendered
    }
    generatedAt='2026-08-15T00:00:02.000Z'
  }
  $publicationPath = Join-Path $evidenceRoot 'bootstrap-a.json'
  $signaturePath = "$publicationPath.sig.json"
  $signed = Write-SignedEvidence $publication $publicationPath $signaturePath $keyPath
  $global:bootstrapAFixtureTrustSpki = $signed.PublicKeySpkiBase64
  $baseLock = [ordered]@{
    releaseDigest='sha256:' + ('9' * 64)
    components=[ordered]@{ backend=[ordered]@{
      image=$previousImage; sourceRevision=$previousRevision
    } }
    componentPublication=[ordered]@{ migrationSetDigest=[string]$migration.setDigest }
  }
  $targetLock = [ordered]@{ releaseDigest=$targetDigest }
  $global:bootstrapAFixtureBaseLockJson = $baseLock | ConvertTo-Json -Depth 8 -Compress
  $global:bootstrapAFixtureTargetLockJson = $targetLock | ConvertTo-Json -Depth 8 -Compress

  function global:kubectl {
    $arguments = @($args)
    $global:LASTEXITCODE = 0
    $text = $arguments -join ' '
    if ($text -ceq 'config current-context') { return 'docker-desktop' }
    if ($text -match 'create token opensphere-local-edge-release') { return 'fixture-token' }
    if ($text -match 'get configmap dupa-trusted-keys -o json') {
      return ([ordered]@{
        metadata=[ordered]@{ uid='fixture-trust-uid-1234'; resourceVersion='42' }
        data=[ordered]@{ 'trusted-keys.json'=([ordered]@{
          trustedKeys=[ordered]@{ 'opensphere-edge-local-v1'=$global:bootstrapAFixtureTrustSpki }
        } | ConvertTo-Json -Depth 5 -Compress) }
      } | ConvertTo-Json -Depth 8 -Compress)
    }
    if ($text -match 'get configmap opensphere-installation-lock -o json') {
      $release = if ($global:bootstrapAFixtureSubmitted) {
        $global:bootstrapAFixtureTargetLockJson
      } else { $global:bootstrapAFixtureBaseLockJson }
      return ([ordered]@{ data=[ordered]@{ 'release.json'=$release } } |
        ConvertTo-Json -Depth 8 -Compress)
    }
    throw "unexpected kubectl fixture call: $text"
  }
  function global:Start-Sleep { param([int]$Seconds) }
  function global:Invoke-RestMethod {
    param($Method,$Uri,$Headers,$ContentType,$Body,$TimeoutSec)
    if ([string]$Method -ceq 'Post') {
      $global:bootstrapAFixturePostBodies.Add([string]$Body)
      if ($global:bootstrapAFixturePostFailuresRemaining -gt 0) {
        $global:bootstrapAFixturePostFailuresRemaining--
        # The server has durably accepted the exact request, but the response is
        # lost before the caller can persist requestId. A retry must recover the
        # same operation without creating a second mutation.
        $global:bootstrapAFixtureSubmitted = $true
        $global:bootstrapAFixtureDurableWriteBeforeResponseLoss = $true
        throw 'simulated response loss after durable write'
      }
      $global:bootstrapAFixtureSubmitted = $true
      return [pscustomobject]@{
        requestId=$global:bootstrapAFixtureRequestId
        targetReleaseDigest=$global:bootstrapAFixtureTargetDigest
        changedComponents=@('backend')
      }
    }
    if ([string]$Method -ceq 'Get') {
      return [pscustomobject]@{
        phase='BootstrapApplied'; lastError=$null; mergeRevision='4' * 40
        receipt=[pscustomobject]@{
          succeeded=$true; operationId='platform-release:bootstrap-a-fixture'; evidence=[pscustomobject]@{}
        }
        bootstrapFrom=[pscustomobject]@{ contract='opensphere-backend-component-bootstrap/v1' }
      }
    }
    throw "unexpected REST fixture call: $Method $Uri"
  }

  $invokePath = Join-Path $repository 'scripts/Invoke-LocalEdgePlatformRelease.ps1'
  $resumePath = Join-Path $evidenceRoot 'bootstrap-a.resume.json'
  $global:bootstrapAFixturePostFailuresRemaining = 1
  $result = & $invokePath -BootstrapA -PublicationEvidence $publicationPath `
    -PublicationSignatureEvidence $signaturePath -Reason $publication.requestIntent `
    -Components @('backend') -TrustedPublicKeySpkiBase64 $signed.PublicKeySpkiBase64 `
    -ExpectedKeyId 'opensphere-edge-local-v1' -PlatformAuthorityPath $platformRepository `
    -SetupAuthorityPath $setupRepository -ResumeStatePath $resumePath
  if ($global:bootstrapAFixturePostBodies.Count -ne 2 -or
      $global:bootstrapAFixturePostBodies[0] -cne $global:bootstrapAFixturePostBodies[1] -or
      $global:bootstrapAFixtureDurableWriteBeforeResponseLoss -ne $true) {
    throw 'Bootstrap A response-loss retry changed request bytes or mutation count.'
  }
  $body = $global:bootstrapAFixturePostBodies[0] | ConvertFrom-Json
  if ((@($body.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'components,reason,sourceRevision' -or
      [string]$body.sourceRevision -cne $sourceRevision -or
      [string]$body.components.backend.image -cne $targetImage -or
      [string]$result.releaseDigest -cne $targetDigest) {
    throw 'Bootstrap A did not submit and complete the exact old 3-key operation.'
  }
  $state = Get-Content -Raw -LiteralPath $resumePath | ConvertFrom-Json
  if ([string]$state.phase -cne 'BootstrapApplied' -or
      [string]$state.bootstrapAProof.contract -cne 'opensphere-backend-bootstrap-a-resume-proof/v1') {
    throw 'Bootstrap A terminal state omitted its signed resume proof.'
  }

  # Exercise the RequestPending recovery branch with the exact bytes and proof
  # emitted by the validated first call. No unsigned state may reach POST.
  $pendingPath = Join-Path $evidenceRoot 'bootstrap-a-pending.resume.json'
  $state.phase='RequestPending'; $state.requestId=''; $state.targetReleaseDigest=''
  $state.operationStatus=$null; $state.lastError='simulated host stop before response'
  $state | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $pendingPath -NoNewline -Encoding utf8
  $global:bootstrapAFixtureSubmitted=$false
  $resumeResult = & $invokePath -Resume -ResumeStatePath $pendingPath
  if ([string]$resumeResult.releaseDigest -cne $targetDigest) {
    throw 'Bootstrap A RequestPending resume did not recover the exact durable operation.'
  }

  $forgedPath = Join-Path $evidenceRoot 'bootstrap-a-forged.resume.json'
  $forged = Get-Content -Raw -LiteralPath $pendingPath | ConvertFrom-Json
  $forged.phase='RequestPending'; $forged.requestId=''; $forged.targetReleaseDigest=''
  $forgedBody = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(
    [string]$forged.requestBodyBase64)) | ConvertFrom-Json
  $forgedBody | Add-Member -NotePropertyName publicationSignature -NotePropertyValue 'forged'
  $forged.requestBodyBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
    ($forgedBody | ConvertTo-Json -Depth 8 -Compress)))
  $forged | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $forgedPath -NoNewline -Encoding utf8
  Assert-ThrowsWithoutPost { & $invokePath -Resume -ResumeStatePath $forgedPath } `
    'unsigned RequestPending body'

  $extraPublication = [ordered]@{}
  foreach ($property in $publication.GetEnumerator()) { $extraPublication[$property.Key]=$property.Value }
  $extraPublication.unexpected='attacker'
  $extraPath=Join-Path $evidenceRoot 'bootstrap-a-extra.json'; $extraSig="$extraPath.sig.json"
  Write-SignedEvidence $extraPublication $extraPath $extraSig $keyPath | Out-Null
  Assert-ThrowsWithoutPost {
    & $invokePath -BootstrapA -PublicationEvidence $extraPath -PublicationSignatureEvidence $extraSig `
      -Reason $publication.requestIntent -Components @('backend') `
      -TrustedPublicKeySpkiBase64 $signed.PublicKeySpkiBase64 `
      -PlatformAuthorityPath $platformRepository -SetupAuthorityPath $setupRepository -ResumeStatePath `
      (Join-Path $evidenceRoot 'extra.resume.json')
  } 'signed extra-field publication'

  $escapePublication = [ordered]@{}
  foreach ($property in $publication.GetEnumerator()) { $escapePublication[$property.Key]=$property.Value }
  $escapePublication.changedPaths=@('../../escape')
  $escapePath=Join-Path $evidenceRoot 'bootstrap-a-escape.json'; $escapeSig="$escapePath.sig.json"
  Write-SignedEvidence $escapePublication $escapePath $escapeSig $keyPath | Out-Null
  Assert-ThrowsWithoutPost {
    & $invokePath -BootstrapA -PublicationEvidence $escapePath -PublicationSignatureEvidence $escapeSig `
      -Reason $publication.requestIntent -Components @('backend') `
      -TrustedPublicKeySpkiBase64 $signed.PublicKeySpkiBase64 `
      -PlatformAuthorityPath $platformRepository -SetupAuthorityPath $setupRepository -ResumeStatePath `
      (Join-Path $evidenceRoot 'escape.resume.json')
  } 'signed path-escape publication'

  $wrongKey = [Security.Cryptography.ECDsa]::Create(
    [Security.Cryptography.ECCurve+NamedCurves]::nistP256)
  try { $wrongSpki=[Convert]::ToBase64String($wrongKey.ExportSubjectPublicKeyInfo()) }
  finally { $wrongKey.Dispose() }
  Assert-ThrowsWithoutPost {
    & $invokePath -BootstrapA -PublicationEvidence $publicationPath `
      -PublicationSignatureEvidence $signaturePath -Reason $publication.requestIntent `
      -Components @('backend') -TrustedPublicKeySpkiBase64 $wrongSpki `
      -PlatformAuthorityPath $platformRepository -SetupAuthorityPath $setupRepository `
      -ResumeStatePath (Join-Path $evidenceRoot 'wrong-key.resume.json')
  } 'non-authority signing key'

  $signatureTamperPath = Join-Path $evidenceRoot 'bootstrap-a-tampered-signature.json'
  Copy-Item -LiteralPath $signaturePath -Destination $signatureTamperPath
  $tamperedEnvelope = Get-Content -Raw -LiteralPath $signatureTamperPath | ConvertFrom-Json
  $signatureBytes = ConvertFrom-OsShellBase64Url ([string]$tamperedEnvelope.signature)
  $signatureBytes[0] = $signatureBytes[0] -bxor 1
  $tamperedEnvelope.signature = ConvertTo-OsShellBase64Url $signatureBytes
  $tamperedEnvelope | ConvertTo-Json -Compress | Set-Content -LiteralPath $signatureTamperPath `
    -NoNewline -Encoding utf8
  Assert-ThrowsWithoutPost {
    & $invokePath -BootstrapA -PublicationEvidence $publicationPath `
      -PublicationSignatureEvidence $signatureTamperPath -Reason $publication.requestIntent `
      -Components @('backend') -TrustedPublicKeySpkiBase64 $signed.PublicKeySpkiBase64 `
      -PlatformAuthorityPath $platformRepository -SetupAuthorityPath $setupRepository `
      -ResumeStatePath (Join-Path $evidenceRoot 'tampered-signature.resume.json')
  } 'tampered publication signature'

  $toolPath=Join-Path $evidenceRoot 'bootstrap-a-tool-tamper.json'; $toolSig="$toolPath.sig.json"
  $savedDeployerSha256 = [string]$publication.tooling.deployer.sha256
  $publication.tooling.deployer.sha256 = 'sha256:' + ('8' * 64)
  try { Write-SignedEvidence $publication $toolPath $toolSig $keyPath | Out-Null }
  finally { $publication.tooling.deployer.sha256 = $savedDeployerSha256 }
  Assert-ThrowsWithoutPost {
    & $invokePath -BootstrapA -PublicationEvidence $toolPath -PublicationSignatureEvidence $toolSig `
      -Reason $publication.requestIntent -Components @('backend') `
      -TrustedPublicKeySpkiBase64 $signed.PublicKeySpkiBase64 `
      -PlatformAuthorityPath $platformRepository -SetupAuthorityPath $setupRepository `
      -ResumeStatePath (Join-Path $evidenceRoot 'tool-tamper.resume.json')
  } 'signed false tooling hash'

  $artifactPath = Join-Path $evidenceRoot 'console-test.log'
  $artifactBytes = [IO.File]::ReadAllBytes($artifactPath)
  try {
    [IO.File]::AppendAllText($artifactPath,'tampered',[Text.UTF8Encoding]::new($false))
    Assert-ThrowsWithoutPost {
      & $invokePath -BootstrapA -PublicationEvidence $publicationPath `
        -PublicationSignatureEvidence $signaturePath -Reason $publication.requestIntent `
        -Components @('backend') -TrustedPublicKeySpkiBase64 $signed.PublicKeySpkiBase64 `
        -PlatformAuthorityPath $platformRepository -SetupAuthorityPath $setupRepository `
        -ResumeStatePath (Join-Path $evidenceRoot 'artifact-tamper.resume.json')
    } 'changed verification artifact'
  } finally { [IO.File]::WriteAllBytes($artifactPath,$artifactBytes) }

  $p384 = [Security.Cryptography.ECDsa]::Create(
    [Security.Cryptography.ECCurve+NamedCurves]::nistP384)
  try { $p384Spki=[Convert]::ToBase64String($p384.ExportSubjectPublicKeyInfo()) }
  finally { $p384.Dispose() }
  $savedTrustSpki = $global:bootstrapAFixtureTrustSpki
  try {
    $global:bootstrapAFixtureTrustSpki = $p384Spki
    Assert-ThrowsWithoutPost {
      & $invokePath -BootstrapA -PublicationEvidence $publicationPath `
        -PublicationSignatureEvidence $signaturePath -Reason $publication.requestIntent `
        -Components @('backend') -TrustedPublicKeySpkiBase64 $p384Spki `
        -PlatformAuthorityPath $platformRepository -SetupAuthorityPath $setupRepository `
        -ResumeStatePath (Join-Path $evidenceRoot 'p384.resume.json')
    } 'non-P256 cluster trust key'
  } finally { $global:bootstrapAFixtureTrustSpki = $savedTrustSpki }

  Write-Host 'PASS: Bootstrap A exact 3-key submit, response-loss/resume proof, source/trust mutation0 negatives'
} finally {
  foreach ($name in @('kubectl','Start-Sleep','Invoke-RestMethod')) {
    Remove-Item -LiteralPath "function:\global:$name" -ErrorAction SilentlyContinue
  }
  foreach ($name in @(
    'bootstrapAFixturePostBodies','bootstrapAFixturePostFailuresRemaining',
    'bootstrapAFixtureSubmitted','bootstrapAFixtureDurableWriteBeforeResponseLoss','bootstrapAFixtureTrustSpki',
    'bootstrapAFixtureBaseLockJson','bootstrapAFixtureTargetLockJson',
    'bootstrapAFixtureRequestId','bootstrapAFixtureTargetDigest'
  )) { Remove-Variable -Name $name -Scope Global -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $workspace) { Remove-Item -LiteralPath $workspace -Recurse -Force }
  if (Test-Path -LiteralPath $keyDirectory) { Remove-Item -LiteralPath $keyDirectory -Recurse -Force }
}
