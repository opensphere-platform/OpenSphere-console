#requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$PublicationEvidence,
  [string]$RuntimePublicationEvidence = '',
  [string]$CliRuntimePublicationEvidence = '',
  [string]$BackendPublicationEvidence = '',
  [string]$ConsolePublicationEvidence = '',
  [string]$ControlPublicationEvidence = '',
  [string]$ManifestPath = '',
  [string]$KubeContext = 'docker-desktop',
  [string]$ControlNamespace = 'opensphere-console',
  [string]$SessionNamespace = 'opensphere-shell-sessions',
  [string]$ReceiptPath = '',
  [string]$SigningKey = (Join-Path $env:USERPROFILE '.opensphere\keys\edge-local-v1-p256.pem'),
  [ValidateSet('opensphere-edge-local-v1')][string]$SigningKeyId = 'opensphere-edge-local-v1',
  [switch]$PrepareTrustOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'local-edge-publication-core.psm1') -Force -ErrorAction Stop
. (Join-Path $PSScriptRoot 'os-shell-tls-contract.ps1')
. (Join-Path $PSScriptRoot 'os-shell-edge-signing.ps1')

$canonicalRegistry = 'ghcr.io/opensphere-platform'
$consoleRepository = "$canonicalRegistry/opensphere-console"
$backendRepository = "$canonicalRegistry/opensphere-console-backend"
$cliRepository = "$canonicalRegistry/opensphere-os-cli"
$controlRepository = "$canonicalRegistry/opensphere-console-os-shell-control"
$runtimeRepository = "$canonicalRegistry/opensphere-os-shell-runtime"
$controlComponent = 'osShellControl'
$runtimeComponent = 'osShellRuntime'
$consolePlaceholder = '__OPENSPHERE_CONSOLE_IMAGE__'
$controlPlaceholder = '__OPENSPHERE_OS_SHELL_CONTROL_IMAGE__'
$runtimePlaceholder = '__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__'
$controlCaConfigMap = 'opensphere-shell-control-ca'
$registryPullSecret = 'opensphere-ghcr-pull'
$runtimeMaxProcesses = 256
$runtimeGlobalPodLimit = 8
$runtimeUserNamespacePolicy = 'required-hostUsers-false'
$controlDeploymentProfiles = @(
  [ordered]@{
    Deployment = 'opensphere-shell-api'; Container = 'api'; Replicas = 2
    Flags = [ordered]@{
      OS_SHELL_CONTROL_ENABLED = 'true'; OS_SHELL_RUNTIME_CONTROL_ENABLED = 'true'
      OS_SHELL_ATTACH_ENABLED = 'false'; OS_SHELL_RECONCILER_ENABLED = 'false'
      OS_SHELL_RUNTIME_REGISTRATION_ENABLED = 'false'
    }
  },
  [ordered]@{
    Deployment = 'opensphere-shell-gateway'; Container = 'gateway'; Replicas = 2
    Flags = [ordered]@{
      OS_SHELL_CONTROL_ENABLED = 'true'; OS_SHELL_RUNTIME_CONTROL_ENABLED = 'false'
      OS_SHELL_ATTACH_ENABLED = 'true'; OS_SHELL_RECONCILER_ENABLED = 'false'
      OS_SHELL_RUNTIME_REGISTRATION_ENABLED = 'false'
    }
  },
  [ordered]@{
    Deployment = 'opensphere-shell-reconciler'; Container = 'reconciler'; Replicas = 1
    Flags = [ordered]@{
      OS_SHELL_CONTROL_ENABLED = 'true'; OS_SHELL_RUNTIME_CONTROL_ENABLED = 'false'
      OS_SHELL_ATTACH_ENABLED = 'false'; OS_SHELL_RECONCILER_ENABLED = 'true'
      OS_SHELL_RUNTIME_REGISTRATION_ENABLED = 'true'
    }
  }
)
$expectedControlServices = @(
  'opensphere-shell-api',
  'opensphere-shell-gateway',
  'opensphere-shell-reconciler',
  'opensphere-shell-credential-authority',
  'opensphere-shell-console-api'
)
$privateTlsProfiles = @(
  [ordered]@{ Secret = 'opensphere-shell-api-tls'; Service = 'opensphere-shell-api'; Deployment = 'opensphere-shell-api' },
  [ordered]@{ Secret = 'opensphere-shell-reconciler-tls'; Service = 'opensphere-shell-reconciler'; Deployment = 'opensphere-shell-reconciler' },
  [ordered]@{
    Secret = 'opensphere-shell-credential-authority-tls'
    Service = 'opensphere-shell-credential-authority'
    Deployment = 'opensphere-console-backend'
  },
  [ordered]@{ Secret = 'opensphere-shell-console-api-tls'; Service = 'opensphere-shell-console-api'; Deployment = 'opensphere-shell-console-api' }
)
$consoleRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Invoke-Checked {
  if ($args.Count -lt 1) { throw 'Invoke-Checked requires an executable.' }
  $executable = [string]$args[0]
  $arguments = @($args | Select-Object -Skip 1)
  & $executable @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$executable failed with exit code $LASTEXITCODE"
  }
}

function Invoke-Kubectl {
  param(
    [Parameter(Mandatory)][string[]]$Arguments,
    [string]$InputText = ''
  )
  $allArguments = @('--context', $KubeContext) + $Arguments
  if ($InputText) {
    $output = $InputText | & kubectl @allArguments
  } else {
    $output = & kubectl @allArguments
  }
  if ($LASTEXITCODE -ne 0) {
    throw "kubectl failed: $($Arguments -join ' ')"
  }
  return @($output)
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

function Get-FileSha256 {
  param([Parameter(Mandatory)][string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

function Get-CanonicalObjectSha256 {
  param([Parameter(Mandatory)][object]$Value)
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20 -Compress))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function New-FeatureOperationId {
  param([Parameter(Mandatory)][ValidateSet('Enable','Disable')][string]$Kind,
    [Parameter(Mandatory)][string]$ReleaseIntentSha256)
  $material = [Text.UTF8Encoding]::new($false).GetBytes("opensphere-shell-feature-operation/v1|$Kind|$ReleaseIntentSha256")
  $sha = [Security.Cryptography.SHA256]::HashData($material)
  $hex = ([BitConverter]::ToString($sha[0..15])).Replace('-', '').ToLowerInvariant()
  return "$($hex.Substring(0,8))-$($hex.Substring(8,4))-$($hex.Substring(12,4))-$($hex.Substring(16,4))-$($hex.Substring(20,12))"
}

function Ensure-OsShellEdgeEvidenceTrust {
  param([Parameter(Mandatory)][string]$PublicKeySpkiBase64)
  $configMap = ((Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', 'configmap/dupa-trusted-keys', '-o', 'json')) -join "`n") | ConvertFrom-Json
  $document = [string]$configMap.data.'trusted-keys.json' | ConvertFrom-Json -AsHashtable
  if (-not $document.ContainsKey('trustedKeys') -or $document.trustedKeys -isnot [System.Collections.IDictionary]) {
    throw 'Console development trust store is not a canonical trustedKeys map'
  }
  $trusted = @{}
  foreach ($entry in $document.trustedKeys.GetEnumerator()) { $trusted[[string]$entry.Key] = [string]$entry.Value }
  if ($trusted.ContainsKey($SigningKeyId) -and $trusted[$SigningKeyId] -cne $PublicKeySpkiBase64) {
    throw "The development trust store contains a different public key for $SigningKeyId"
  }
  if (-not $trusted.ContainsKey($SigningKeyId)) {
    $trusted[$SigningKeyId] = $PublicKeySpkiBase64
    $patch = @{ data = @{ 'trusted-keys.json' = (@{ trustedKeys = $trusted } | ConvertTo-Json -Depth 5 -Compress) } } |
      ConvertTo-Json -Depth 6 -Compress
    Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'patch', 'configmap/dupa-trusted-keys', '--type', 'merge', '-p', $patch) | Out-Null
    Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'rollout', 'restart', 'deployment/opensphere-console-dupa-controller') | Out-Null
    Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'rollout', 'status', 'deployment/opensphere-console-dupa-controller', '--timeout=300s') | Out-Null
  }
  $verified = ((Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', 'configmap/dupa-trusted-keys', '-o', 'json')) -join "`n") | ConvertFrom-Json
  $verifiedKeys = ([string]$verified.data.'trusted-keys.json' | ConvertFrom-Json -AsHashtable).trustedKeys
  if ([string]$verifiedKeys[$SigningKeyId] -cne $PublicKeySpkiBase64) { throw 'OS Shell edge evidence trust registration did not converge' }
}

function New-LocalEdgeAutomationToken {
  $token = ((Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'create', 'token', 'opensphere-local-edge-release',
    '--audience', 'opensphere-local-edge-release', '--duration', '10m')) -join '').Trim()
  if ($token.Length -lt 100 -or $token -match '\s') { throw 'local edge release-controller returned no canonical short-lived token' }
  return $token
}

function Invoke-LocalEdgeShellFeatureOperation {
  param(
    [Parameter(Mandatory)][bool]$Enabled,
    [Parameter(Mandatory)][System.Collections.IDictionary]$Evidence,
    [Parameter(Mandatory)][string]$Reason,
    [Parameter(Mandatory)][string]$OperationId
  )
  $token = New-LocalEdgeAutomationToken
  $headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }
  $endpoint = 'https://localhost:1114/api/platform/os-shell/feature-state/local-edge-automation'
  try {
    $current = Invoke-RestMethod -Uri $endpoint -Method Get -Headers $headers
    $request = [ordered]@{ enabled = $Enabled; expectedRevision = [long]$current.state.revision;
      operationId = $OperationId; reason = $Reason; evidence = $Evidence }
    $result = Invoke-RestMethod -Uri $endpoint -Method Put -Headers $headers -ContentType 'application/json' `
      -Body ($request | ConvertTo-Json -Depth 10 -Compress)
    if ([bool]$result.state.enabled -ne $Enabled) { throw 'durable OS Shell feature gate did not converge' }
    return $result
  } finally {
    $token = $null
    $headers.Authorization = $null
  }
}

function Get-RemoteDigest {
  param([Parameter(Mandatory)][string]$Reference)
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & docker buildx imagetools inspect $Reference 2>$null
    $inspectExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($inspectExitCode -ne 0) { return $null }
  $line = $output | Where-Object { $_ -match '^Digest:\s+(sha256:[0-9a-f]{64})$' } | Select-Object -First 1
  if (-not $line) { throw "Could not parse registry digest for $Reference" }
  return ([regex]::Match($line, 'sha256:[0-9a-f]{64}')).Value
}

function Assert-ImageMetadata {
  param(
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$Image,
    [Parameter(Mandatory)][string]$Digest,
    [Parameter(Mandatory)][string]$SourceRevision,
    [Parameter(Mandatory)][string]$ReleaseTag,
    [string]$ExpectedPointerTag = 'edge'
  )
  if ($Image -ne "${Repository}@${Digest}") {
    throw "Non-canonical image reference in publication evidence: $Image"
  }
  if ((Get-RemoteDigest -Reference $Image) -ne $Digest) {
    throw "Exact image digest is not readable from GHCR: $Image"
  }
  if ((Get-RemoteDigest -Reference "${Repository}:$ReleaseTag") -ne $Digest) {
    throw "The immutable release tag no longer points to the publication digest: ${Repository}:$ReleaseTag"
  }
  if ((Get-RemoteDigest -Reference "${Repository}:$ExpectedPointerTag") -ne $Digest) {
    throw "The governed publication pointer no longer points to the evidence digest: ${Repository}:$ExpectedPointerTag"
  }
  $raw = & docker buildx imagetools inspect --format '{{json .Image}}' $Image
  if ($LASTEXITCODE -ne 0) { throw "OCI metadata inspection failed for $Image" }
  try {
    $metadata = ($raw -join "`n") | ConvertFrom-Json
  } catch {
    throw "OCI metadata is invalid for ${Image}: $($_.Exception.Message)"
  }
  if ("$([string]$metadata.os)/$([string]$metadata.architecture)" -ne 'linux/amd64') {
    throw "OS Shell edge images must be exactly linux/amd64: $Image"
  }
  $expectedLabels = [ordered]@{
    'io.opensphere.channel' = 'edge'
    'io.opensphere.source-revision' = $SourceRevision
    'io.opensphere.release-tag' = $ReleaseTag
    'org.opencontainers.image.version' = $ReleaseTag
    'opensphere.io/build-authority' = 'localhost'
    'opensphere.io/release-class' = 'pre-ga'
    'opensphere.io/ga-eligible' = 'false'
  }
  foreach ($expected in $expectedLabels.GetEnumerator()) {
    $property = $metadata.config.Labels.PSObject.Properties[$expected.Key]
    $actual = if ($property) { [string]$property.Value } else { '' }
    if ($actual -ne [string]$expected.Value) {
      throw "OCI label mismatch for ${Image}: $($expected.Key)='$actual' expected '$($expected.Value)'"
    }
  }
}

function Get-EvidenceComponent {
  param(
    [Parameter(Mandatory)]$Evidence,
    [Parameter(Mandatory)][string]$Key,
    [Parameter(Mandatory)][string]$Repository
  )
  $property = $Evidence.components.PSObject.Properties[$Key]
  if (-not $property) { throw "Publication evidence is missing component $Key" }
  $component = $property.Value
  $digestMatch = [regex]::Match([string]$component.image, '@(sha256:[0-9a-f]{64})$')
  if (-not $digestMatch.Success) { throw "Component $Key is not pinned to an exact digest" }
  if ([string]$component.repository -ne ($Repository -replace '^ghcr.io/opensphere-platform/', '')) {
    throw "Component $Key has a non-canonical repository"
  }
  if ([string]$component.sourceRevision -ne [string]$Evidence.sourceRevision) {
    throw "Component $Key source revision differs from the publication"
  }
  return [ordered]@{
    image = [string]$component.image
    digest = $digestMatch.Groups[1].Value
  }
}

function Assert-EvidenceText($Value, [string]$Path, [string]$Pattern = '') {
  if ($Value -isnot [string] -or ($Pattern -and $Value -notmatch $Pattern)) { throw "$Path has an invalid type or value" }
}
function Assert-EvidenceInteger($Value, [string]$Path) { if ($Value -isnot [int] -and $Value -isnot [long]) { throw "$Path must be an integer" } }
function Assert-EvidenceBoolean($Value, [string]$Path) { if ($Value -isnot [bool]) { throw "$Path must be a boolean" } }
function Assert-EvidenceStringArray($Value, [string]$Path, [string[]]$Expected = @()) {
  if ($Value -isnot [Array] -or @(@($Value) | Where-Object { $_ -isnot [string] }).Count) { throw "$Path must be a string array" }
  if (@($Expected).Count -and ((@($Value) -join "`0") -ne ($Expected -join "`0"))) { throw "$Path must be the exact string array" }
}
function Assert-PairOverrideSchema($Value) {
  Assert-ExactObjectKeys -Value $Value -Keys @('apiVersion','kind','publicationScope','channel','status','source','sourceRevision','releaseTag','immutableTag','buildAuthority','releaseClass','gaEligible','supportedPlatforms','basePublication','components','changedPaths','affectedImages','reusedImages','releaseScope','fullReleaseJustification','artifacts') -Path 'CLI/runtime override'
  foreach ($field in @(@{ n='apiVersion'; p='^release[.]opensphere[.]io/v1alpha1$' },@{ n='kind'; p='^OpenSphereEdgeComponentPublication$' },@{ n='publicationScope'; p='^ComponentSet$' },@{ n='channel'; p='^edge$' },@{ n='status'; p='^Active$' },@{ n='source'; p='^https://github[.]com/opensphere-platform/OpenSphere-console$' },@{ n='sourceRevision'; p='^[a-f0-9]{40}$' },@{ n='releaseTag'; p='^\d{12}$' },@{ n='immutableTag'; p='^local-[a-f0-9]{12}$' },@{ n='buildAuthority'; p='^localhost$' },@{ n='releaseClass'; p='^pre-ga$' },@{ n='releaseScope'; p='^component$' })) { Assert-EvidenceText $Value.($field.n) "CLI/runtime override.$($field.n)" $field.p }
  Assert-EvidenceBoolean $Value.gaEligible 'CLI/runtime override.gaEligible'; if ($Value.gaEligible) { throw 'CLI/runtime override.gaEligible must be false' }; if ($null -ne $Value.fullReleaseJustification) { throw 'CLI/runtime override.fullReleaseJustification must be null' }; Assert-EvidenceStringArray $Value.supportedPlatforms 'CLI/runtime override.supportedPlatforms' @('linux/amd64'); Assert-EvidenceStringArray $Value.affectedImages 'CLI/runtime override.affectedImages' @('cliArtifacts','osShellRuntime'); Assert-EvidenceStringArray $Value.reusedImages 'CLI/runtime override.reusedImages' @('console','backend','osShellControl'); Assert-EvidenceStringArray $Value.changedPaths 'CLI/runtime override.changedPaths'
  Assert-ExactObjectKeys -Value $Value.components -Keys @('cliArtifacts','osShellRuntime') -Path 'CLI/runtime override.components'
  foreach ($entry in @(@{ key='cliArtifacts'; repo='opensphere-os-cli' },@{ key='osShellRuntime'; repo='opensphere-os-shell-runtime' })) { $component = $Value.components.PSObject.Properties[$entry.key].Value; Assert-ExactObjectKeys -Value $component -Keys @('repository','image','sourceRevision') -Path "CLI/runtime override.components.$($entry.key)"; Assert-EvidenceText $component.repository "CLI/runtime override.components.$($entry.key).repository" "^$([regex]::Escape($entry.repo))$"; Assert-EvidenceText $component.image "CLI/runtime override.components.$($entry.key).image" "^ghcr[.]io/opensphere-platform/$([regex]::Escape($entry.repo))@sha256:[a-f0-9]{64}$"; Assert-EvidenceText $component.sourceRevision "CLI/runtime override.components.$($entry.key).sourceRevision" '^[a-f0-9]{40}$' }
  Assert-ExactObjectKeys -Value $Value.basePublication -Keys @('pathSha256','sourceRevision','releaseTag','sessionPolicyRevision','reused') -Path 'CLI/runtime override.basePublication'; Assert-EvidenceText $Value.basePublication.pathSha256 'CLI/runtime override.basePublication.pathSha256' '^sha256:[a-f0-9]{64}$'; Assert-EvidenceText $Value.basePublication.sourceRevision 'CLI/runtime override.basePublication.sourceRevision' '^[a-f0-9]{40}$'; Assert-EvidenceText $Value.basePublication.releaseTag 'CLI/runtime override.basePublication.releaseTag' '^\d{12}$'; Assert-EvidenceText $Value.basePublication.sessionPolicyRevision 'CLI/runtime override.basePublication.sessionPolicyRevision' '^[A-Za-z0-9._-]+$'; Assert-ExactObjectKeys -Value $Value.basePublication.reused -Keys @('console','backend','osShellControl') -Path 'CLI/runtime override.basePublication.reused'
  foreach ($entry in @(@{ key='console'; repo='opensphere-console' },@{ key='backend'; repo='opensphere-console-backend' },@{ key='osShellControl'; repo='opensphere-console-os-shell-control' })) { $reuse = $Value.basePublication.reused.PSObject.Properties[$entry.key].Value; Assert-ExactObjectKeys -Value $reuse -Keys @('repository','image','digest','sourceRevision','releaseTag','platform') -Path "CLI/runtime override.basePublication.reused.$($entry.key)"; Assert-EvidenceText $reuse.repository "CLI/runtime override.basePublication.reused.$($entry.key).repository" "^$([regex]::Escape($entry.repo))$"; Assert-EvidenceText $reuse.image "CLI/runtime override.basePublication.reused.$($entry.key).image" "^ghcr[.]io/opensphere-platform/$([regex]::Escape($entry.repo))@sha256:[a-f0-9]{64}$"; Assert-EvidenceText $reuse.digest "CLI/runtime override.basePublication.reused.$($entry.key).digest" '^sha256:[a-f0-9]{64}$'; Assert-EvidenceText $reuse.sourceRevision "CLI/runtime override.basePublication.reused.$($entry.key).sourceRevision" '^[a-f0-9]{40}$'; Assert-EvidenceText $reuse.releaseTag "CLI/runtime override.basePublication.reused.$($entry.key).releaseTag" '^\d{12}$'; Assert-EvidenceText $reuse.platform "CLI/runtime override.basePublication.reused.$($entry.key).platform" '^linux/amd64$' }
  Assert-ExactObjectKeys -Value $Value.artifacts -Keys @('supabaseMigrationManifest','osShellRelease') -Path 'CLI/runtime override.artifacts'; $migration = $Value.artifacts.supabaseMigrationManifest; Assert-ExactObjectKeys -Value $migration -Keys @('path','sha256','setDigest','latestMigrationId','migrationCount') -Path 'CLI/runtime override.artifacts.supabaseMigrationManifest'; Assert-EvidenceText $migration.path 'CLI/runtime override.artifacts.supabaseMigrationManifest.path' '^backend/supabase/migrations/manifest[.]json$'; foreach ($field in @('sha256','setDigest')) { Assert-EvidenceText $migration.$field "CLI/runtime override.artifacts.supabaseMigrationManifest.$field" '^sha256:[a-f0-9]{64}$' }; Assert-EvidenceText $migration.latestMigrationId 'CLI/runtime override.artifacts.supabaseMigrationManifest.latestMigrationId' '^\d{4}$'; Assert-EvidenceInteger $migration.migrationCount 'CLI/runtime override.artifacts.supabaseMigrationManifest.migrationCount'
  $release = $Value.artifacts.osShellRelease; Assert-ExactObjectKeys -Value $release -Keys @('cliManifest','runtimeBinary','sessionPolicyRevision','baseSessionPolicyRevision') -Path 'CLI/runtime override.artifacts.osShellRelease'; Assert-EvidenceText $release.sessionPolicyRevision 'CLI/runtime override.artifacts.osShellRelease.sessionPolicyRevision' '^[A-Za-z0-9._-]+$'; Assert-EvidenceText $release.baseSessionPolicyRevision 'CLI/runtime override.artifacts.osShellRelease.baseSessionPolicyRevision' '^[A-Za-z0-9._-]+$'; $manifest = $release.cliManifest; Assert-ExactObjectKeys -Value $manifest -Keys @('image','imagePath','sha256','signatureAlgorithm','keyId') -Path 'CLI/runtime override.artifacts.osShellRelease.cliManifest'; Assert-EvidenceText $manifest.image 'CLI/runtime override.artifacts.osShellRelease.cliManifest.image' '^ghcr[.]io/opensphere-platform/opensphere-os-cli@sha256:[a-f0-9]{64}$'; Assert-EvidenceText $manifest.imagePath 'CLI/runtime override.artifacts.osShellRelease.cliManifest.imagePath' '^/srv/index[.]json$'; Assert-EvidenceText $manifest.sha256 'CLI/runtime override.artifacts.osShellRelease.cliManifest.sha256' '^sha256:[a-f0-9]{64}$'; Assert-EvidenceText $manifest.signatureAlgorithm 'CLI/runtime override.artifacts.osShellRelease.cliManifest.signatureAlgorithm' '^Ed25519$'; Assert-EvidenceText $manifest.keyId 'CLI/runtime override.artifacts.osShellRelease.cliManifest.keyId' '^opensphere-cli-[a-z0-9-]+$'; $binary = $release.runtimeBinary; Assert-ExactObjectKeys -Value $binary -Keys @('image','path','sha256') -Path 'CLI/runtime override.artifacts.osShellRelease.runtimeBinary'; Assert-EvidenceText $binary.image 'CLI/runtime override.artifacts.osShellRelease.runtimeBinary.image' '^ghcr[.]io/opensphere-platform/opensphere-os-shell-runtime@sha256:[a-f0-9]{64}$'; Assert-EvidenceText $binary.path 'CLI/runtime override.artifacts.osShellRelease.runtimeBinary.path' '^/usr/local/bin/os$'; Assert-EvidenceText $binary.sha256 'CLI/runtime override.artifacts.osShellRelease.runtimeBinary.sha256' '^sha256:[a-f0-9]{64}$'
}

function Assert-EdgePublicationEnvelope {
  param(
    [Parameter(Mandatory)]$Evidence,
    [Parameter(Mandatory)][string]$Purpose
  )
  if ([string]$Evidence.apiVersion -ne 'release.opensphere.io/v1alpha1' -or
      [string]$Evidence.kind -ne 'OpenSphereEdgeComponentPublication' -or
      [string]$Evidence.publicationScope -ne 'ComponentSet' -or
      [string]$Evidence.channel -ne 'edge' -or
      [string]$Evidence.status -ne 'Active' -or
      [string]$Evidence.source -ne 'https://github.com/opensphere-platform/OpenSphere-console' -or
      [string]$Evidence.buildAuthority -ne 'localhost' -or
      [string]$Evidence.releaseClass -ne 'pre-ga' -or
      [bool]$Evidence.gaEligible -or
      [string]$Evidence.sourceRevision -notmatch '^[a-f0-9]{40}$' -or
      [string]$Evidence.releaseTag -notmatch '^[0-9]{12}$') {
    throw "$Purpose publication evidence is outside the local edge component authority boundary"
  }
  $platforms = @($Evidence.supportedPlatforms | ForEach-Object { [string]$_ })
  if ($platforms.Count -ne 1 -or $platforms[0] -ne 'linux/amd64') {
    throw "$Purpose publication must contain exactly the linux/amd64 edge platform"
  }
  if ([string]$Evidence.immutableTag -ne "local-$(([string]$Evidence.sourceRevision).Substring(0, 12))") {
    throw "$Purpose publication immutableTag is not derived from its committed SourceRevision"
  }
}

function Test-KubectlCanI {
  param(
    [Parameter(Mandatory)][string]$Subject,
    [Parameter(Mandatory)][string]$Verb,
    [Parameter(Mandatory)][string]$Resource,
    [string]$Namespace = ''
  )
  # This is the required kubectl auth can-i SelfSubjectAccessReview-compatible
  # projection. It never grants authority; it only verifies the installed RBAC.
  $resourceParts = @($Resource -split '/', 2)
  $resourceName = [string]$resourceParts[0]
  $arguments = @('auth', 'can-i', $Verb, $resourceName, '--as', $Subject)
  if ($resourceParts.Count -eq 2) {
    if (-not [string]$resourceParts[1]) { throw "Invalid empty SAR subresource: $Resource" }
    $arguments += @('--subresource', [string]$resourceParts[1])
  }
  if ($Namespace) { $arguments += @('--namespace', $Namespace) }
  $allArguments = @('--context', $KubeContext) + $arguments
  $answerOutput = & kubectl @allArguments
  $sarExitCode = $LASTEXITCODE
  if ($sarExitCode -notin @(0, 1)) {
    throw "kubectl auth can-i failed with exit code $sarExitCode for $Subject $Verb $Resource"
  }
  $answer = ($answerOutput | Select-Object -Last 1).Trim().ToLowerInvariant()
  if ($answer -notin @('yes', 'no')) { throw "Unexpected SAR answer for $Subject $Verb ${Resource}: $answer" }
  if (($answer -eq 'yes' -and $sarExitCode -ne 0) -or ($answer -eq 'no' -and $sarExitCode -ne 1)) {
    throw "Inconsistent SAR answer/exit code for $Subject $Verb ${Resource}: answer=$answer exit=$sarExitCode"
  }
  return $answer -eq 'yes'
}

function Assert-Denied {
  param(
    [Parameter(Mandatory)][string]$Subject,
    [Parameter(Mandatory)][string]$Verb,
    [Parameter(Mandatory)][string]$Resource,
    [string]$Namespace = ''
  )
  if (Test-KubectlCanI -Subject $Subject -Verb $Verb -Resource $Resource -Namespace $Namespace) {
    throw "Negative SAR failed: $Subject can $Verb $Resource in namespace '$Namespace'"
  }
}

function Assert-Allowed {
  param(
    [Parameter(Mandatory)][string]$Subject,
    [Parameter(Mandatory)][string]$Verb,
    [Parameter(Mandatory)][string]$Resource,
    [string]$Namespace = ''
  )
  if (-not (Test-KubectlCanI -Subject $Subject -Verb $Verb -Resource $Resource -Namespace $Namespace)) {
    throw "Required SAR failed: $Subject cannot $Verb $Resource in namespace '$Namespace'"
  }
}

function Ensure-SessionNamespace {
  $namespaceDocument = @"
apiVersion: v1
kind: Namespace
metadata:
  name: $SessionNamespace
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
"@
  Invoke-Kubectl -Arguments @('apply', '-f', '-') -InputText $namespaceDocument | Out-Null
}

function Ensure-SessionRegistryPullSecret {
  $source = ((Invoke-Kubectl -Arguments @(
    '-n', $ControlNamespace, 'get', "secret/$registryPullSecret", '-o', 'json'
  )) -join "`n") | ConvertFrom-Json
  $sourceDataProperties = @($source.data.PSObject.Properties)
  if ([string]$source.type -ne 'kubernetes.io/dockerconfigjson' -or
      $sourceDataProperties.Count -ne 1 -or
      [string]$sourceDataProperties[0].Name -ne '.dockerconfigjson' -or
      -not [string]$sourceDataProperties[0].Value) {
    throw "The canonical registry pull Secret $ControlNamespace/$registryPullSecret is malformed"
  }
  $projection = [ordered]@{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = [ordered]@{ name = $registryPullSecret; namespace = $SessionNamespace }
    type = 'kubernetes.io/dockerconfigjson'
    data = [ordered]@{ '.dockerconfigjson' = [string]$sourceDataProperties[0].Value }
  }
  Invoke-Kubectl -Arguments @('apply', '-f', '-') -InputText ($projection | ConvertTo-Json -Depth 6) | Out-Null
  $target = ((Invoke-Kubectl -Arguments @(
    '-n', $SessionNamespace, 'get', "secret/$registryPullSecret", '-o', 'json'
  )) -join "`n") | ConvertFrom-Json
  $targetDataProperties = @($target.data.PSObject.Properties)
  if ([string]$target.type -ne 'kubernetes.io/dockerconfigjson' -or
      $targetDataProperties.Count -ne 1 -or
      [string]$targetDataProperties[0].Name -ne '.dockerconfigjson' -or
      [string]$targetDataProperties[0].Value -cne [string]$sourceDataProperties[0].Value) {
    throw "The session registry pull Secret $SessionNamespace/$registryPullSecret is not an exact projection"
  }
}

function Assert-CertificateLifetime {
  param(
    [Parameter(Mandatory)][Security.Cryptography.X509Certificates.X509Certificate2]$Certificate,
    [Parameter(Mandatory)][string]$Name
  )
  $now = [DateTime]::UtcNow
  if ($Certificate.NotBefore.ToUniversalTime() -gt $now -or
      $Certificate.NotAfter.ToUniversalTime() -lt $now.AddHours(24)) {
    throw "$Name is not currently valid with at least 24 hours remaining"
  }
}

function Assert-ExistingInternalTls {
  param(
    [Parameter(Mandatory)][string]$ControlCaPem,
    [Parameter(Mandatory)][string]$SessionCaPem
  )
  if (-not $ControlCaPem -or $SessionCaPem -ne $ControlCaPem) {
    throw 'OS Shell public CA ConfigMap projections are incomplete or divergent'
  }
  $caCertificate = $null
  try {
    $caCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($ControlCaPem)
    Assert-CertificateLifetime -Certificate $caCertificate -Name 'OS Shell local edge CA'
    $caBasicConstraints = @($caCertificate.Extensions | Where-Object {
      $_ -is [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]
    })
    if ($caBasicConstraints.Count -ne 1 -or -not $caBasicConstraints[0].CertificateAuthority) {
      throw 'OS Shell public trust anchor is not a CA certificate'
    }

    foreach ($profile in $privateTlsProfiles) {
      $tlsCrt = (Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', 'secret', $profile.Secret, '-o', 'jsonpath={.data.tls\.crt}')) -join ''
      $tlsKey = (Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', 'secret', $profile.Secret, '-o', 'jsonpath={.data.tls\.key}')) -join ''
      if (-not $tlsCrt -or -not $tlsKey) { throw "OS Shell private TLS Secret is incomplete: $($profile.Secret)" }
      $leafCertificate = $null
      $leafPrivateKey = $null
      $chain = $null
      try {
        $leafPem = [Text.UTF8Encoding]::new($false).GetString([Convert]::FromBase64String($tlsCrt))
        $keyPem = [Text.UTF8Encoding]::new($false).GetString([Convert]::FromBase64String($tlsKey))
        # CreateFromPem rejects a certificate/private-key mismatch.
        $leafCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($leafPem, $keyPem)
        if (-not $leafCertificate.HasPrivateKey) { throw "OS Shell TLS leaf has no private key: $($profile.Secret)" }
        $leafPrivateKey = [Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($leafCertificate)
        if (-not $leafPrivateKey) { throw "OS Shell TLS leaf is not P-256 ECDSA: $($profile.Secret)" }
        Assert-CertificateLifetime -Certificate $leafCertificate -Name $profile.Secret

        $expectedNames = @(
          [string]$profile.Service,
          "$($profile.Service).${ControlNamespace}.svc",
          "$($profile.Service).${ControlNamespace}.svc.cluster.local"
        )
        Assert-ExactCertificateDnsNames -Certificate $leafCertificate -ExpectedDnsNames $expectedNames -Name $profile.Secret
        $serverAuth = @($leafCertificate.Extensions | Where-Object {
          $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]
        } | ForEach-Object { $_.EnhancedKeyUsages } | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.1' })
        if ($serverAuth.Count -ne 1) { throw "OS Shell TLS leaf lacks serverAuth EKU: $($profile.Secret)" }

        $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
        $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        $chain.ChainPolicy.TrustMode = [Security.Cryptography.X509Certificates.X509ChainTrustMode]::CustomRootTrust
        [void]$chain.ChainPolicy.CustomTrustStore.Add($caCertificate)
        if (-not $chain.Build($leafCertificate)) {
          throw "OS Shell TLS leaf does not chain to the projected CA: $($profile.Secret)"
        }
      } catch {
        throw "Existing OS Shell TLS validation failed for $($profile.Secret): $($_.Exception.Message)"
      } finally {
        if ($chain) { $chain.Dispose() }
        if ($leafPrivateKey) { $leafPrivateKey.Dispose() }
        if ($leafCertificate) { $leafCertificate.Dispose() }
      }
    }
  } catch {
    throw "Existing OS Shell trust set is invalid: $($_.Exception.Message)"
  } finally {
    if ($caCertificate) { $caCertificate.Dispose() }
  }
}

function Ensure-InternalTls {
  $resourcePresence = @()
  foreach ($profile in $privateTlsProfiles) {
    $exists = $true
    try { Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', 'secret', $profile.Secret, '-o', 'name') | Out-Null } catch { $exists = $false }
    $resourcePresence += $exists
  }
  foreach ($namespace in @($ControlNamespace, $SessionNamespace)) {
    $exists = $true
    try { Invoke-Kubectl -Arguments @('-n', $namespace, 'get', 'configmap', $controlCaConfigMap, '-o', 'name') | Out-Null } catch { $exists = $false }
    $resourcePresence += $exists
  }
  $existingTlsResources = @($resourcePresence | Where-Object { $_ }).Count
  if ($existingTlsResources -notin @(0, 6)) {
    throw 'OS Shell split TLS trust set is partial; all four private leaves and both public CA projections must move together'
  }
  if ($existingTlsResources -eq 6) {
    $controlCaCrt = (Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', 'configmap', $controlCaConfigMap, '-o', 'jsonpath={.data.ca\.crt}')) -join ''
    $sessionCaCrt = (Invoke-Kubectl -Arguments @('-n', $SessionNamespace, 'get', 'configmap', $controlCaConfigMap, '-o', 'jsonpath={.data.ca\.crt}')) -join ''
    Assert-ExistingInternalTls -ControlCaPem $controlCaCrt -SessionCaPem $sessionCaCrt
    return
  }

  $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $tlsDirectory = Join-Path $systemTemp "opensphere-os-shell-tls-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $tlsDirectory | Out-Null
  Invoke-Checked icacls $tlsDirectory /inheritance:r /grant:r "$env:USERNAME`:(OI)(CI)F"
  $caPrivateKey = $null
  $caCertificate = $null
  try {
    $caCert = Join-Path $tlsDirectory 'ca.crt'
    $notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
    $notAfter = [DateTimeOffset]::UtcNow.AddDays(397)
    $caPrivateKey = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
    $caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
      'CN=OpenSphere OS Shell local edge CA',
      $caPrivateKey,
      [Security.Cryptography.HashAlgorithmName]::SHA256
    )
    $caRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $true, 0, $true)
    )
    $caKeyUsage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor `
      [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
    $caRequest.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($caKeyUsage, $true)
    )
    $caCertificate = $caRequest.CreateSelfSigned($notBefore, $notAfter)
    [IO.File]::WriteAllText($caCert, $caCertificate.ExportCertificatePem(), [Text.UTF8Encoding]::new($false))
    foreach ($profile in $privateTlsProfiles) {
      $leafKey = Join-Path $tlsDirectory "$($profile.Service).key"
      $leafCert = Join-Path $tlsDirectory "$($profile.Service).crt"
      $serviceDns = "$($profile.Service).${ControlNamespace}.svc.cluster.local"
      $leafPrivateKey = $null
      $leafCertificate = $null
      $leafCertificateWithKey = $null
      try {
        $leafPrivateKey = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
        $leafRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
          "CN=$serviceDns",
          $leafPrivateKey,
          [Security.Cryptography.HashAlgorithmName]::SHA256
        )
        $leafRequest.CertificateExtensions.Add(
          [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
        )
        $leafRequest.CertificateExtensions.Add(
          [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
            [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
            $true
          )
        )
        $serverAuthOids = [Security.Cryptography.OidCollection]::new()
        [void]$serverAuthOids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
        $leafRequest.CertificateExtensions.Add(
          [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($serverAuthOids, $true)
        )
        $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        $san.AddDnsName([string]$profile.Service)
        $san.AddDnsName("$($profile.Service).${ControlNamespace}.svc")
        $san.AddDnsName($serviceDns)
        $leafRequest.CertificateExtensions.Add($san.Build($true))
        $serial = [Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
        $leafCertificate = $leafRequest.Create($caCertificate, $notBefore, $notAfter, $serial)
        $leafCertificateWithKey = [Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::CopyWithPrivateKey(
          $leafCertificate,
          $leafPrivateKey
        )
        [IO.File]::WriteAllText($leafCert, $leafCertificateWithKey.ExportCertificatePem(), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($leafKey, $leafPrivateKey.ExportPkcs8PrivateKeyPem(), [Text.UTF8Encoding]::new($false))
      } finally {
        if ($leafCertificateWithKey) { $leafCertificateWithKey.Dispose() }
        if ($leafCertificate) { $leafCertificate.Dispose() }
        if ($leafPrivateKey) { $leafPrivateKey.Dispose() }
      }
      $secretYaml = & kubectl --context $KubeContext -n $ControlNamespace create secret tls $profile.Secret `
        --cert=$leafCert --key=$leafKey --dry-run=client -o yaml
      if ($LASTEXITCODE -ne 0) { throw "Failed to render split TLS Secret $($profile.Secret)" }
      ($secretYaml -join "`n") | & kubectl --context $KubeContext apply -f - | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Failed to apply split TLS Secret $($profile.Secret)" }
    }

    foreach ($namespace in @($ControlNamespace, $SessionNamespace)) {
      $caYaml = & kubectl --context $KubeContext -n $namespace create configmap $controlCaConfigMap `
        --from-file=ca.crt=$caCert --dry-run=client -o yaml
      if ($LASTEXITCODE -ne 0) { throw "Failed to render OS Shell public CA ConfigMap in $namespace" }
      ($caYaml -join "`n") | & kubectl --context $KubeContext apply -f - | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Failed to apply OS Shell public CA ConfigMap in $namespace" }
    }
  } finally {
    if ($caCertificate) { $caCertificate.Dispose() }
    if ($caPrivateKey) { $caPrivateKey.Dispose() }
    $resolvedTlsDirectory = [IO.Path]::GetFullPath($tlsDirectory)
    if (-not $resolvedTlsDirectory.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedTlsDirectory) -notmatch '^opensphere-os-shell-tls-[a-f0-9]{32}$') {
      throw "Refusing to remove unverified TLS temporary directory: $resolvedTlsDirectory"
    }
    if (Test-Path -LiteralPath $resolvedTlsDirectory) {
      Remove-Item -LiteralPath $resolvedTlsDirectory -Recurse -Force
    }
  }
}

function Assert-PrerequisiteDeployment {
  param(
    [Parameter(Mandatory)][string]$Deployment,
    [Parameter(Mandatory)][string]$Image,
    [Parameter(Mandatory)][string]$Digest,
    [Parameter(Mandatory)][string]$SourceRevision
  )
  Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'rollout', 'status', "deployment/$Deployment", '--timeout=600s') | Out-Null
  $resource = ((Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', "deployment/$Deployment", '-o', 'json')) -join "`n") | ConvertFrom-Json
  $desired = [int]$resource.spec.replicas
  $ready = [int]$resource.status.readyReplicas
  if ($desired -le 0 -or $ready -ne $desired -or [int]$resource.status.availableReplicas -ne $desired) {
    throw "Prerequisite Deployment $Deployment is not fully Ready: ready=$ready desired=$desired"
  }
  $repository = ($Image -split '@', 2)[0]
  $boundContainers = @($resource.spec.template.spec.containers | Where-Object { [string]$_.image -like "${repository}@*" })
  if ($boundContainers.Count -ne 1 -or [string]$boundContainers[0].image -ne $Image) {
    throw "Prerequisite Deployment $Deployment is not pinned to $Image"
  }
  $boundContainerName = [string]$boundContainers[0].name
  $selector = @($resource.spec.selector.matchLabels.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ','
  if (-not $selector) { throw "Prerequisite Deployment $Deployment has no closed Pod selector" }
  $pods = ((Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', 'pods', '-l', $selector, '-o', 'json')) -join "`n") | ConvertFrom-Json
  $activePods = @($pods.items | Where-Object { -not $_.metadata.PSObject.Properties['deletionTimestamp'] })
  if ($activePods.Count -ne $desired) { throw "Prerequisite Deployment $Deployment has an unexpected active Pod count" }
  foreach ($pod in $activePods) {
    $statuses = @($pod.status.containerStatuses | Where-Object { [string]$_.name -eq $boundContainerName })
    if ($statuses.Count -ne 1 -or -not [bool]$statuses[0].ready -or
        [string]$statuses[0].imageID -notmatch "@$([regex]::Escape($Digest))$") {
      throw "Prerequisite Pod $($pod.metadata.name) is not running the exact digest for $Deployment"
    }
  }
  return [ordered]@{
    deployment = $Deployment
    ready = "$ready/$desired"
    image = $Image
    digest = $Digest
    sourceRevision = $SourceRevision
  }
}

function Set-BackendOsShellActivation {
  param(
    [Parameter(Mandatory)][string]$Image,
    [Parameter(Mandatory)][string]$SourceRevision,
    [Parameter(Mandatory)][string]$ReleaseEvidenceRef
  )
  $deployment = ((Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', 'deployment/opensphere-console-backend', '-o', 'json')) -join "`n") | ConvertFrom-Json
  $containers = @($deployment.spec.template.spec.containers | Where-Object { [string]$_.image -eq $Image })
  if ($containers.Count -ne 1) {
    throw 'Console Backend activation patch requires exactly one exact-image container'
  }
  $patch = [ordered]@{
    metadata = [ordered]@{ annotations = [ordered]@{
      'opensphere.io/os-shell-source-revision' = $SourceRevision
      'opensphere.io/os-shell-release-evidence' = $ReleaseEvidenceRef
    } }
    spec = [ordered]@{ template = [ordered]@{
      metadata = [ordered]@{ annotations = [ordered]@{
        'opensphere.io/os-shell-source-revision' = $SourceRevision
        'opensphere.io/os-shell-release-evidence' = $ReleaseEvidenceRef
      } }
      spec = [ordered]@{
        containers = @([ordered]@{
          name = [string]$containers[0].name
          env = @(
            [ordered]@{ name = 'OS_SHELL_ADMISSION_ENABLED'; value = 'true' },
            [ordered]@{ name = 'OS_SHELL_CREDENTIAL_AUTHORITY_ENABLED'; value = 'true' },
            [ordered]@{ name = 'OS_SHELL_CREDENTIAL_AUTHORITY_CERT_FILE'; value = '/var/run/opensphere-shell-credential-authority/tls.crt' },
            [ordered]@{ name = 'OS_SHELL_CREDENTIAL_AUTHORITY_KEY_FILE'; value = '/var/run/opensphere-shell-credential-authority/tls.key' },
            [ordered]@{ name = 'OS_SHELL_ADMISSION_SECRET'; valueFrom = [ordered]@{ secretKeyRef = [ordered]@{
              name = 'opensphere-shell-control-runtime'; key = 'admission-secret'; optional = $false
            } } },
            [ordered]@{ name = 'OS_SHELL_DELEGATION_SECRET'; valueFrom = [ordered]@{ secretKeyRef = [ordered]@{
              name = 'opensphere-shell-control-runtime'; key = 'delegation-secret'; optional = $false
            } } }
          )
          ports = @([ordered]@{ name = 'shell-cred-tls'; containerPort = 8444; protocol = 'TCP' })
          volumeMounts = @([ordered]@{
            name = 'shell-credential-authority-tls'; mountPath = '/var/run/opensphere-shell-credential-authority'; readOnly = $true
          })
        })
        volumes = @([ordered]@{ name = 'shell-credential-authority-tls'; secret = [ordered]@{
          secretName = 'opensphere-shell-credential-authority-tls'; optional = $false
        } })
      }
    } }
  }
  Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'patch', 'deployment/opensphere-console-backend', '--type=strategic', '--patch', ($patch | ConvertTo-Json -Depth 12 -Compress)) | Out-Null
  Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'rollout', 'status', 'deployment/opensphere-console-backend', '--timeout=600s') | Out-Null
  $activated = ((Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', 'deployment/opensphere-console-backend', '-o', 'json')) -join "`n") | ConvertFrom-Json
  $activatedContainer = @($activated.spec.template.spec.containers | Where-Object { [string]$_.image -eq $Image })
  foreach ($name in @('OS_SHELL_ADMISSION_ENABLED', 'OS_SHELL_CREDENTIAL_AUTHORITY_ENABLED')) {
    $values = @($activatedContainer[0].env | Where-Object { [string]$_.name -eq $name })
    if ($values.Count -ne 1 -or [string]$values[0].value -ne 'true') {
      throw "Console Backend activation flag is not exact: $name"
    }
  }
  foreach ($binding in @(
    [ordered]@{ Name = 'OS_SHELL_CREDENTIAL_AUTHORITY_CERT_FILE'; Value = '/var/run/opensphere-shell-credential-authority/tls.crt' },
    [ordered]@{ Name = 'OS_SHELL_CREDENTIAL_AUTHORITY_KEY_FILE'; Value = '/var/run/opensphere-shell-credential-authority/tls.key' }
  )) {
    $values = @($activatedContainer[0].env | Where-Object { [string]$_.name -eq [string]$binding.Name })
    if ($values.Count -ne 1 -or [string]$values[0].value -ne [string]$binding.Value) {
      throw "Console Backend credential authority path is not exact: $($binding.Name)"
    }
  }
  foreach ($binding in @(
    [ordered]@{ Name = 'OS_SHELL_ADMISSION_SECRET'; Key = 'admission-secret' },
    [ordered]@{ Name = 'OS_SHELL_DELEGATION_SECRET'; Key = 'delegation-secret' }
  )) {
    $values = @($activatedContainer[0].env | Where-Object { [string]$_.name -eq [string]$binding.Name })
    if ($values.Count -ne 1 -or [string]$values[0].valueFrom.secretKeyRef.name -ne 'opensphere-shell-control-runtime' -or
        [string]$values[0].valueFrom.secretKeyRef.key -ne [string]$binding.Key -or [bool]$values[0].valueFrom.secretKeyRef.optional) {
      throw "Console Backend service credential projection is not exact: $($binding.Name)"
    }
  }
  $ports = @($activatedContainer[0].ports | Where-Object { [string]$_.name -eq 'shell-cred-tls' })
  if ($ports.Count -ne 1 -or [int]$ports[0].containerPort -ne 8444) { throw 'Console Backend credential authority port 8444 is not exact' }
  $mounts = @($activatedContainer[0].volumeMounts | Where-Object { [string]$_.name -eq 'shell-credential-authority-tls' })
  if ($mounts.Count -ne 1 -or [string]$mounts[0].mountPath -ne '/var/run/opensphere-shell-credential-authority' -or -not [bool]$mounts[0].readOnly) {
    throw 'Console Backend credential authority private-key mount is not exact'
  }
  $volumes = @($activated.spec.template.spec.volumes | Where-Object { [string]$_.name -eq 'shell-credential-authority-tls' })
  if ($volumes.Count -ne 1 -or [string]$volumes[0].secret.secretName -ne 'opensphere-shell-credential-authority-tls' -or [bool]$volumes[0].secret.optional) {
    throw 'Console Backend credential authority TLS Secret projection is not exact'
  }
}

function Set-ControlDeploymentActivation {
  param(
    [Parameter(Mandatory)]$Profile,
    [Parameter(Mandatory)][string]$SourceRevision,
    [Parameter(Mandatory)][string]$ReleaseEvidenceRef,
    [Parameter(Mandatory)][string]$RuntimeImage,
    [Parameter(Mandatory)][string]$OsArtifactDigest,
    [Parameter(Mandatory)][string]$ManifestSha256,
    [Parameter(Mandatory)][string]$ReleaseKeyId,
    [Parameter(Mandatory)][string]$SessionPolicyRevision,
    [Parameter(Mandatory)][string]$RuntimeTemplateRevision
  )
  $environment = @()
  foreach ($flag in $Profile.Flags.GetEnumerator()) {
    $environment += [ordered]@{ name = [string]$flag.Key; value = [string]$flag.Value }
  }
  $environment += @(
    [ordered]@{ name = 'OS_SHELL_RUNTIME_IMAGE'; value = $RuntimeImage },
    [ordered]@{ name = 'OS_SHELL_OS_ARTIFACT_DIGEST'; value = $OsArtifactDigest },
    [ordered]@{ name = 'OS_SHELL_MANIFEST_SHA256'; value = $ManifestSha256 },
    [ordered]@{ name = 'OS_SHELL_RELEASE_EVIDENCE_REF'; value = $ReleaseEvidenceRef },
    [ordered]@{ name = 'OS_SHELL_RELEASE_KEY_ID'; value = $ReleaseKeyId },
    [ordered]@{ name = 'OS_SHELL_SESSION_POLICY_REVISION'; value = $SessionPolicyRevision },
    [ordered]@{ name = 'OS_SHELL_RUNTIME_TEMPLATE_REVISION'; value = $RuntimeTemplateRevision }
  )
  $patch = [ordered]@{
    metadata = [ordered]@{ annotations = [ordered]@{
      'opensphere.io/os-shell-source-revision' = $SourceRevision
      'opensphere.io/os-shell-release-evidence' = $ReleaseEvidenceRef
    } }
    spec = [ordered]@{
      replicas = [int]$Profile.Replicas
      template = [ordered]@{
        metadata = [ordered]@{ annotations = [ordered]@{
          'opensphere.io/os-shell-source-revision' = $SourceRevision
          'opensphere.io/os-shell-release-evidence' = $ReleaseEvidenceRef
        } }
        spec = [ordered]@{ containers = @([ordered]@{
          name = [string]$Profile.Container
          env = $environment
        }) }
      }
    }
  }
  Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'patch', "deployment/$($Profile.Deployment)", '--type=strategic', '--patch', ($patch | ConvertTo-Json -Depth 12 -Compress)) | Out-Null
}

function Set-ConsoleApiActivation {
  param(
    [Parameter(Mandatory)][string]$SourceRevision,
    [Parameter(Mandatory)][string]$ReleaseEvidenceRef
  )
  $patch = [ordered]@{
    metadata = [ordered]@{ annotations = [ordered]@{
      'opensphere.io/os-shell-source-revision' = $SourceRevision
      'opensphere.io/os-shell-release-evidence' = $ReleaseEvidenceRef
    } }
    spec = [ordered]@{
      replicas = 1
      template = [ordered]@{ metadata = [ordered]@{ annotations = [ordered]@{
        'opensphere.io/os-shell-source-revision' = $SourceRevision
        'opensphere.io/os-shell-release-evidence' = $ReleaseEvidenceRef
      } } }
    }
  }
  Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'patch', 'deployment/opensphere-shell-console-api', '--type=strategic', '--patch', ($patch | ConvertTo-Json -Depth 10 -Compress)) | Out-Null
}

if ($env:OS -ne 'Windows_NT') {
  throw 'OS Shell local edge deployment is supported only from Windows Docker Desktop'
}
foreach ($command in @('git', 'docker', 'kubectl', 'node')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is required" }
}
if ($KubeContext -ne 'docker-desktop' -or (& kubectl config current-context).Trim() -ne 'docker-desktop') {
  throw 'OS Shell local edge deployment is restricted to the docker-desktop context'
}
$nodes = ((Invoke-Kubectl -Arguments @('get', 'nodes', '-o', 'json')) -join "`n") | ConvertFrom-Json
$nodeArchitectures = @($nodes.items | ForEach-Object { [string]$_.status.nodeInfo.architecture })
if (-not $nodeArchitectures.Count -or @($nodeArchitectures | Where-Object { $_ -ne 'amd64' }).Count) {
  throw "Every docker-desktop node must be amd64; received: $($nodeArchitectures -join ',')"
}

$publicationPath = (Resolve-Path -LiteralPath $PublicationEvidence).Path
$evidence = Get-Content -Raw -LiteralPath $publicationPath | ConvertFrom-Json
Assert-EdgePublicationEnvelope -Evidence $evidence -Purpose 'OS Shell base'
$componentKeys = @($evidence.components.PSObject.Properties.Name | Sort-Object)
if (($componentKeys -join ',') -ne 'backend,cliArtifacts,console,osShellControl,osShellRuntime') {
  throw "OS Shell deploy requires the exact five-component publication; received: $($componentKeys -join ',')"
}

$runtimePublicationPath = ''
$runtimeEvidence = $evidence
$cliRuntimePublicationPath = ''
$cliRuntimeEvidence = $evidence
if ($CliRuntimePublicationEvidence) {
  $cliRuntimePublicationPath = (Resolve-Path -LiteralPath $CliRuntimePublicationEvidence).Path
  if ($cliRuntimePublicationPath -eq $publicationPath) { throw 'CliRuntimePublicationEvidence must be distinct from base publication' }
  $cliRuntimeEvidence = Get-Content -Raw -LiteralPath $cliRuntimePublicationPath | ConvertFrom-Json
  Assert-PairOverrideSchema $cliRuntimeEvidence
  Assert-EdgePublicationEnvelope -Evidence $cliRuntimeEvidence -Purpose 'OS Shell CLI/runtime override'
  if ((@($cliRuntimeEvidence.components.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'cliArtifacts,osShellRuntime') { throw 'CLI/runtime override requires exactly cliArtifacts,osShellRuntime' }
  & git -C $consoleRoot merge-base --is-ancestor ([string]$evidence.sourceRevision) ([string]$cliRuntimeEvidence.sourceRevision)
  if ($LASTEXITCODE -ne 0) { throw 'CLI/runtime override SourceRevision is not a descendant of base OS Shell publication' }
  $baseMigration = $evidence.artifacts.supabaseMigrationManifest; $overrideMigration = $cliRuntimeEvidence.artifacts.supabaseMigrationManifest
  if (-not $overrideMigration -or [string]$overrideMigration.sha256 -ne [string]$baseMigration.sha256 -or [string]$overrideMigration.setDigest -ne [string]$baseMigration.setDigest -or [string]$overrideMigration.latestMigrationId -ne [string]$baseMigration.latestMigrationId) { throw 'CLI/runtime override changes base Supabase migration lineage' }
  $baseSessionPolicyRevision = [string]$evidence.artifacts.osShellRelease.sessionPolicyRevision
  $overrideOsShellRelease = $cliRuntimeEvidence.artifacts.osShellRelease
  if ($baseSessionPolicyRevision -notmatch '^[A-Za-z0-9._-]+$' -or -not $overrideOsShellRelease -or
      [string]$overrideOsShellRelease.cliManifest.image -ne [string]$cliRuntimeEvidence.components.cliArtifacts.image -or
      [string]$overrideOsShellRelease.runtimeBinary.image -ne [string]$cliRuntimeEvidence.components.osShellRuntime.image -or
      [string]$overrideOsShellRelease.runtimeBinary.sha256 -notmatch '^sha256:[a-f0-9]{64}$' -or
      [string]$overrideOsShellRelease.sessionPolicyRevision -ne $baseSessionPolicyRevision -or
      [string]$overrideOsShellRelease.baseSessionPolicyRevision -ne $baseSessionPolicyRevision) {
    throw 'CLI/runtime override OS Shell binary identity or canonical session policy evidence is absent or inconsistent'
  }
  if ([string]$cliRuntimeEvidence.basePublication.pathSha256 -ne (Get-CanonicalTextSha256 -Path $publicationPath) -or
      [string]$cliRuntimeEvidence.basePublication.sourceRevision -ne [string]$evidence.sourceRevision -or
      [string]$cliRuntimeEvidence.basePublication.releaseTag -ne [string]$evidence.releaseTag -or
      [string]$cliRuntimeEvidence.basePublication.sessionPolicyRevision -ne $baseSessionPolicyRevision) {
    throw 'CLI/runtime override base publication binding differs from the canonical base evidence file'
  }
  foreach ($entry in @(@{ key='console'; repo='opensphere-console' },@{ key='backend'; repo='opensphere-console-backend' },@{ key='osShellControl'; repo='opensphere-console-os-shell-control' })) {
    $baseComponent = $evidence.components.PSObject.Properties[$entry.key].Value
    $reused = $cliRuntimeEvidence.basePublication.reused.PSObject.Properties[$entry.key].Value
    $baseDigest = [regex]::Match([string]$baseComponent.image, '@(sha256:[a-f0-9]{64})$').Groups[1].Value
    if ([string]$reused.repository -ne [string]$baseComponent.repository -or [string]$reused.image -ne [string]$baseComponent.image -or
        [string]$reused.digest -ne $baseDigest -or [string]$reused.sourceRevision -ne [string]$baseComponent.sourceRevision -or
        [string]$reused.releaseTag -ne [string]$evidence.releaseTag -or [string]$reused.platform -ne 'linux/amd64') {
      throw "CLI/runtime override reused $($entry.key) projection differs from the canonical base evidence"
    }
  }
}
if ($RuntimePublicationEvidence) {
  $runtimePublicationPath = (Resolve-Path -LiteralPath $RuntimePublicationEvidence).Path
  if ($runtimePublicationPath -eq $publicationPath) {
    throw 'RuntimePublicationEvidence must be a distinct component-only publication'
  }
  $runtimeEvidence = Get-Content -Raw -LiteralPath $runtimePublicationPath | ConvertFrom-Json
  Assert-EdgePublicationEnvelope -Evidence $runtimeEvidence -Purpose 'OS Shell runtime override'
  $runtimeComponentKeys = @($runtimeEvidence.components.PSObject.Properties.Name | Sort-Object)
  if (($runtimeComponentKeys -join ',') -ne 'osShellRuntime') {
    throw "Runtime override requires exactly osShellRuntime; received: $($runtimeComponentKeys -join ',')"
  }
  & git -C $consoleRoot merge-base --is-ancestor ([string]$evidence.sourceRevision) ([string]$runtimeEvidence.sourceRevision)
  if ($LASTEXITCODE -ne 0) {
    throw 'Runtime override SourceRevision is not a descendant of the base OS Shell publication'
  }
  $baseMigration = $evidence.artifacts.supabaseMigrationManifest
  $runtimeMigration = $runtimeEvidence.artifacts.supabaseMigrationManifest
  if (-not $runtimeMigration -or [string]$runtimeMigration.sha256 -ne [string]$baseMigration.sha256 -or
      [string]$runtimeMigration.setDigest -ne [string]$baseMigration.setDigest -or
      [string]$runtimeMigration.latestMigrationId -ne [string]$baseMigration.latestMigrationId) {
    throw 'Runtime override changes the base Supabase migration lineage'
  }
}

$backendPublicationPath = ''
$backendEvidence = $evidence
if ($BackendPublicationEvidence) {
  $backendPublicationPath = (Resolve-Path -LiteralPath $BackendPublicationEvidence).Path
  if ($backendPublicationPath -eq $publicationPath -or
      ($runtimePublicationPath -and $backendPublicationPath -eq $runtimePublicationPath)) {
    throw 'BackendPublicationEvidence must be a distinct component-only publication'
  }
  $backendEvidence = Get-Content -Raw -LiteralPath $backendPublicationPath | ConvertFrom-Json
  Assert-EdgePublicationEnvelope -Evidence $backendEvidence -Purpose 'OS Shell backend override'
  $backendComponentKeys = @($backendEvidence.components.PSObject.Properties.Name | Sort-Object)
  if (($backendComponentKeys -join ',') -ne 'backend') {
    throw "Backend override requires exactly backend; received: $($backendComponentKeys -join ',')"
  }
  if ([string]$backendEvidence.sourceRevision -eq [string]$evidence.sourceRevision) {
    throw 'Backend override SourceRevision must differ from the base OS Shell publication'
  }
  $baseMigration = $evidence.artifacts.supabaseMigrationManifest
  $backendMigration = $backendEvidence.artifacts.supabaseMigrationManifest
  if (-not $backendMigration -or [string]$backendMigration.sha256 -ne [string]$baseMigration.sha256 -or
      [string]$backendMigration.setDigest -ne [string]$baseMigration.setDigest -or
      [string]$backendMigration.latestMigrationId -ne [string]$baseMigration.latestMigrationId) {
    throw 'Backend override changes the base Supabase migration lineage'
  }
}

$consolePublicationPath = ''
$consoleEvidence = $evidence
if ($ConsolePublicationEvidence) {
  $consolePublicationPath = (Resolve-Path -LiteralPath $ConsolePublicationEvidence).Path
  if ($consolePublicationPath -eq $publicationPath -or
      ($runtimePublicationPath -and $consolePublicationPath -eq $runtimePublicationPath) -or
      ($backendPublicationPath -and $consolePublicationPath -eq $backendPublicationPath)) {
    throw 'ConsolePublicationEvidence must be a distinct component-only publication'
  }
  $consoleEvidence = Get-Content -Raw -LiteralPath $consolePublicationPath | ConvertFrom-Json
  Assert-EdgePublicationEnvelope -Evidence $consoleEvidence -Purpose 'OS Shell Console override'
  $consoleComponentKeys = @($consoleEvidence.components.PSObject.Properties.Name | Sort-Object)
  if (($consoleComponentKeys -join ',') -ne 'console') {
    throw "Console override requires exactly console; received: $($consoleComponentKeys -join ',')"
  }
  if ([string]$consoleEvidence.sourceRevision -eq [string]$evidence.sourceRevision) {
    throw 'Console override SourceRevision must differ from the base OS Shell publication'
  }
  $baseMigration = $evidence.artifacts.supabaseMigrationManifest
  $consoleMigration = $consoleEvidence.artifacts.supabaseMigrationManifest
  if (-not $consoleMigration -or [string]$consoleMigration.sha256 -ne [string]$baseMigration.sha256 -or
      [string]$consoleMigration.setDigest -ne [string]$baseMigration.setDigest -or
      [string]$consoleMigration.latestMigrationId -ne [string]$baseMigration.latestMigrationId) {
    throw 'Console override changes the base Supabase migration lineage'
  }
}

$controlPublicationPath = ''
$controlEvidence = $evidence
if ($ControlPublicationEvidence) {
  $controlPublicationPath = (Resolve-Path -LiteralPath $ControlPublicationEvidence).Path
  if ($controlPublicationPath -eq $publicationPath -or
      ($runtimePublicationPath -and $controlPublicationPath -eq $runtimePublicationPath) -or
      ($backendPublicationPath -and $controlPublicationPath -eq $backendPublicationPath) -or
      ($consolePublicationPath -and $controlPublicationPath -eq $consolePublicationPath)) {
    throw 'ControlPublicationEvidence must be a distinct component-only publication'
  }
  $controlEvidence = Get-Content -Raw -LiteralPath $controlPublicationPath | ConvertFrom-Json
  Assert-EdgePublicationEnvelope -Evidence $controlEvidence -Purpose 'OS Shell control override'
  $controlComponentKeys = @($controlEvidence.components.PSObject.Properties.Name | Sort-Object)
  if (($controlComponentKeys -join ',') -ne 'osShellControl') {
    throw "Control override requires exactly osShellControl; received: $($controlComponentKeys -join ',')"
  }
  if ([string]$controlEvidence.sourceRevision -eq [string]$evidence.sourceRevision) {
    throw 'Control override SourceRevision must differ from the base OS Shell publication'
  }
  $baseMigration = $evidence.artifacts.supabaseMigrationManifest
  $controlMigration = $controlEvidence.artifacts.supabaseMigrationManifest
  if (-not $controlMigration -or [string]$controlMigration.sha256 -ne [string]$baseMigration.sha256 -or
      [string]$controlMigration.setDigest -ne [string]$baseMigration.setDigest -or
      [string]$controlMigration.latestMigrationId -ne [string]$baseMigration.latestMigrationId) {
    throw 'Control override changes the base Supabase migration lineage'
  }
}

$console = Get-EvidenceComponent -Evidence $consoleEvidence -Key 'console' -Repository $consoleRepository
$backend = Get-EvidenceComponent -Evidence $backendEvidence -Key 'backend' -Repository $backendRepository
$cliArtifacts = Get-EvidenceComponent -Evidence $cliRuntimeEvidence -Key 'cliArtifacts' -Repository $cliRepository
$control = Get-EvidenceComponent -Evidence $controlEvidence -Key $controlComponent -Repository $controlRepository
$runtime = Get-EvidenceComponent -Evidence $(if ($CliRuntimePublicationEvidence) { $cliRuntimeEvidence } else { $runtimeEvidence }) -Key $runtimeComponent -Repository $runtimeRepository
$effectiveRuntimeSourceRevision = if ($CliRuntimePublicationEvidence) { [string]$cliRuntimeEvidence.sourceRevision } else { [string]$runtimeEvidence.sourceRevision }
$effectiveRuntimeReleaseTag = if ($CliRuntimePublicationEvidence) { [string]$cliRuntimeEvidence.releaseTag } else { [string]$runtimeEvidence.releaseTag }
Assert-ImageMetadata -Repository $consoleRepository -Image $console.image -Digest $console.digest `
  -SourceRevision $consoleEvidence.sourceRevision -ReleaseTag $consoleEvidence.releaseTag -ExpectedPointerTag $consoleEvidence.immutableTag
Assert-ImageMetadata -Repository $backendRepository -Image $backend.image -Digest $backend.digest `
  -SourceRevision $backendEvidence.sourceRevision -ReleaseTag $backendEvidence.releaseTag
Assert-ImageMetadata -Repository $cliRepository -Image $cliArtifacts.image -Digest $cliArtifacts.digest `
  -SourceRevision $cliRuntimeEvidence.sourceRevision -ReleaseTag $cliRuntimeEvidence.releaseTag
Assert-ImageMetadata -Repository $controlRepository -Image $control.image -Digest $control.digest `
  -SourceRevision $controlEvidence.sourceRevision -ReleaseTag $controlEvidence.releaseTag
Assert-ImageMetadata -Repository $runtimeRepository -Image $runtime.image -Digest $runtime.digest `
  -SourceRevision $effectiveRuntimeSourceRevision -ReleaseTag $effectiveRuntimeReleaseTag

$head = (& git -C $consoleRoot rev-parse HEAD).Trim()
$deploymentToolingSourceRevision = $head
$deploymentToolingAllowlist = @(
  'scripts/Deploy-LocalEdgeOsShell.ps1',
  'scripts/os-shell-edge-signing.ps1',
  'scripts/Test-OsShellEdgeSigning.ps1',
  'scripts/Test-OsShellRuntimeAdmission.ps1',
  'scripts/Invoke-OsShellFeatureOperation.ps1',
  'scripts/Publish-LocalEdge.ps1',
  'scripts/Publish-LocalEdgeOsShellArtifacts.ps1',
  'scripts/local-edge-publication-core.psm1',
  'scripts/os-shell-runtime-override-boundary.mjs',
  'scripts/os-shell-runtime-override-boundary.test.mjs',
  'backend/os-shell-control/deploy.yaml',
  'backend/os-shell-control/deploy.test.js'
)
$boundaryEvidence = $null
$backendBoundaryEvidence = $null
$consoleBoundaryEvidence = $null
$controlBoundaryEvidence = $null
$componentOverrideBoundary = $null
if ($runtimePublicationPath -or $backendPublicationPath -or $consolePublicationPath -or $controlPublicationPath) {
  $boundaryVerifier = Join-Path $consoleRoot 'scripts\os-shell-runtime-override-boundary.mjs'
  if (-not (Test-Path -LiteralPath $boundaryVerifier)) { throw 'Component override boundary verifier is missing' }
  if ((& git -C $consoleRoot remote get-url origin).Trim() -ne 'https://github.com/opensphere-platform/OpenSphere-console.git') {
    throw 'Component override verification requires the canonical GitHub Console origin'
  }
  & git -C $consoleRoot fetch --quiet --prune origin
  if ($LASTEXITCODE -ne 0) { throw 'Canonical GitHub Console refs could not be fetched for component override verification' }
  $boundaryArguments = @($boundaryVerifier, '--repository', $consoleRoot, '--base',
    ([string]$evidence.sourceRevision), '--head', $head)
  if ($runtimePublicationPath) { $boundaryArguments += @('--runtime', ([string]$runtimeEvidence.sourceRevision)) }
  if ($backendPublicationPath) { $boundaryArguments += @('--backend', ([string]$backendEvidence.sourceRevision)) }
  if ($consolePublicationPath) { $boundaryArguments += @('--console', ([string]$consoleEvidence.sourceRevision)) }
  if ($controlPublicationPath) { $boundaryArguments += @('--control', ([string]$controlEvidence.sourceRevision)) }
  $boundaryOutput = & node @boundaryArguments
  if ($LASTEXITCODE -ne 0) { throw 'Composite component override source boundary verification failed' }
  $componentOverrideBoundary = ($boundaryOutput -join "`n") | ConvertFrom-Json
  if ($runtimePublicationPath) { $boundaryEvidence = $componentOverrideBoundary }
  if ($backendPublicationPath) { $backendBoundaryEvidence = $componentOverrideBoundary }
  if ($consolePublicationPath) { $consoleBoundaryEvidence = $componentOverrideBoundary }
  if ($controlPublicationPath) { $controlBoundaryEvidence = $componentOverrideBoundary }
} elseif ($head -ne [string]$evidence.sourceRevision) {
  & git -C $consoleRoot merge-base --is-ancestor ([string]$evidence.sourceRevision) $head
  if ($LASTEXITCODE -ne 0) {
    throw "Deployment tooling HEAD $head is not a descendant of publication revision $($evidence.sourceRevision)"
  }
  $changedPaths = @(& git -C $consoleRoot diff --name-only ([string]$evidence.sourceRevision) $head |
    ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  $nonToolingChanges = @($changedPaths | Where-Object { $_ -notin $deploymentToolingAllowlist })
  if (-not $changedPaths.Count -or $nonToolingChanges.Count) {
    throw "Deployment tooling revision changes image or runtime inputs outside the closed allowlist: $($nonToolingChanges -join ', ')"
  }
}
$dirty = & git -C $consoleRoot status --short
if ($dirty) { throw 'The Console source must be clean before applying an OS Shell publication' }
$deploymentToolingEvidence = [ordered]@{}
foreach ($relativePath in $deploymentToolingAllowlist) {
  $toolingPath = Join-Path $consoleRoot $relativePath
  if (Test-Path -LiteralPath $toolingPath) {
    $deploymentToolingEvidence[$relativePath] = Get-CanonicalTextSha256 -Path $toolingPath
  }
}
$migration0061Path = Join-Path $consoleRoot 'backend\supabase\migrations\0061_shell_session_ledger.sql'
$migration0062Path = Join-Path $consoleRoot 'backend\supabase\migrations\0062_shell_session_quota_and_kill_switch.sql'
$migrationManifestPath = Join-Path $consoleRoot 'backend\supabase\migrations\manifest.json'
$migrationRunner = Join-Path $consoleRoot 'backend\supabase\migrate-only.ps1'
foreach ($path in @($migration0061Path, $migration0062Path, $migrationManifestPath, $migrationRunner)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Required committed migration input is missing: $path" }
}
& git -C $consoleRoot cat-file -e "$($evidence.sourceRevision):backend/supabase/migrations/0061_shell_session_ledger.sql"
if ($LASTEXITCODE -ne 0) { throw 'Migration 0061_shell_session_ledger.sql is not committed in SourceRevision' }
& git -C $consoleRoot cat-file -e "$($evidence.sourceRevision):backend/supabase/migrations/0062_shell_session_quota_and_kill_switch.sql"
if ($LASTEXITCODE -ne 0) { throw 'Migration 0062_shell_session_quota_and_kill_switch.sql is not committed in SourceRevision' }
$migrationArtifact = $evidence.artifacts.supabaseMigrationManifest
if (-not $migrationArtifact -or
    [string]$migrationArtifact.path -ne 'backend/supabase/migrations/manifest.json' -or
    [string]$migrationArtifact.sha256 -ne (Get-CanonicalTextSha256 -Path $migrationManifestPath)) {
  throw 'Committed migration manifest does not match publication evidence'
}
$migrationManifest = Get-Content -Raw -LiteralPath $migrationManifestPath | ConvertFrom-Json
$migration0061 = @($migrationManifest.migrations | Where-Object { [string]$_.name -eq '0061_shell_session_ledger.sql' })
$migration0062 = @($migrationManifest.migrations | Where-Object { [string]$_.name -eq '0062_shell_session_quota_and_kill_switch.sql' })
$migration0061Digest = (Get-CanonicalTextSha256 -Path $migration0061Path).Substring('sha256:'.Length)
$migration0062Digest = (Get-CanonicalTextSha256 -Path $migration0062Path).Substring('sha256:'.Length)
if ($migration0061.Count -ne 1 -or [string]$migration0061[0].sha256 -ne $migration0061Digest) {
  throw 'Migration 0061 is absent from or inconsistent with the canonical migration manifest'
}
if ($migration0062.Count -ne 1 -or [string]$migration0062[0].sha256 -ne $migration0062Digest -or
    [string]$migrationManifest.latestMigrationId -ne '0062') {
  throw 'Migration 0062 is not the exact latest migration in the canonical migration manifest'
}
if ([string]$migrationArtifact.setDigest -ne [string]$migrationManifest.setDigest -or
    [string]$migrationArtifact.latestMigrationId -ne [string]$migrationManifest.latestMigrationId) {
  throw 'Migration lineage evidence differs from the committed manifest'
}
$osShellRelease = $cliRuntimeEvidence.artifacts.osShellRelease
$osShellControlRelease = if ($controlPublicationPath) {
  $controlEvidence.artifacts.osShellControlRelease
} else {
  $osShellRelease
}
$runtimeTemplatePath = Join-Path $consoleRoot 'backend\os-shell-control\runtime-template.js'
if (-not $osShellRelease -or
    [string]$osShellRelease.cliManifest.image -ne [string]$cliArtifacts.image -or
    [string]$osShellRelease.cliManifest.imagePath -ne '/srv/index.json' -or
    [string]$osShellRelease.cliManifest.sha256 -notmatch '^sha256:[a-f0-9]{64}$' -or
    [string]$osShellRelease.cliManifest.signatureAlgorithm -ne 'Ed25519' -or
    [string]$osShellRelease.cliManifest.keyId -ne 'opensphere-cli-local-dev-v1' -or
    [string]$osShellRelease.sessionPolicyRevision -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') {
  throw 'OS Shell signed CLI manifest or session policy evidence is absent or inconsistent'
}
if ($CliRuntimePublicationEvidence -and [string]$osShellRelease.sessionPolicyRevision -ne [string]$evidence.artifacts.osShellRelease.sessionPolicyRevision) {
  throw 'CLI/runtime override session policy revision differs from the canonical base publication'
}
if (-not $osShellControlRelease -or
    [string]$osShellControlRelease.runtimeTemplate.path -ne 'backend/os-shell-control/runtime-template.js' -or
    [string]$osShellControlRelease.runtimeTemplate.sha256 -ne (Get-CanonicalTextSha256 -Path $runtimeTemplatePath) -or
    [int]$osShellControlRelease.runtimeProcessPolicy.maxProcesses -ne $runtimeMaxProcesses -or
    [int]$osShellControlRelease.runtimeProcessPolicy.globalPodLimit -ne $runtimeGlobalPodLimit -or
    [string]$osShellControlRelease.runtimeProcessPolicy.userNamespacePolicy -ne $runtimeUserNamespacePolicy -or
    [string]$osShellControlRelease.runtimeProcessPolicy.enforcement -ne 'linux-userns+rlimit-nproc+namespace-resourcequota') {
  throw 'OS Shell control runtime template or user-namespace process policy evidence is absent or inconsistent'
}
# Re-open the exact cliArtifacts image without executing it and independently
# verify the signed manifest bytes recorded by publication. This prevents a
# locally edited evidence JSON from choosing a different manifest/key binding.
$cliEvidenceDirectory = Join-Path ([IO.Path]::GetFullPath([IO.Path]::GetTempPath())) "opensphere-os-shell-cli-evidence-$([guid]::NewGuid().ToString('N'))"
$cliEvidenceContainer = "opensphere-os-shell-cli-evidence-$([guid]::NewGuid().ToString('N'))"
$cliEvidenceContainerCreated = $false
New-Item -ItemType Directory -Path $cliEvidenceDirectory | Out-Null
try {
  Invoke-Checked docker create --name $cliEvidenceContainer $cliArtifacts.image
  $cliEvidenceContainerCreated = $true
  $cliManifestPath = Join-Path $cliEvidenceDirectory 'index.json'
  Invoke-Checked docker cp "${cliEvidenceContainer}:/srv/index.json" $cliManifestPath
  $liveCliManifest = Get-Content -Raw -LiteralPath $cliManifestPath | ConvertFrom-Json
  if ((Get-FileSha256 -Path $cliManifestPath) -ne [string]$osShellRelease.cliManifest.sha256 -or
      [string]$liveCliManifest.signature.algorithm -ne [string]$osShellRelease.cliManifest.signatureAlgorithm -or
      [string]$liveCliManifest.signature.keyId -ne [string]$osShellRelease.cliManifest.keyId) {
    throw 'Signed CLI manifest evidence differs from the exact cliArtifacts image'
  }
} finally {
  if ($cliEvidenceContainerCreated) { Invoke-Checked docker container rm $cliEvidenceContainer }
  $resolvedCliEvidenceDirectory = [IO.Path]::GetFullPath($cliEvidenceDirectory)
  $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (-not $resolvedCliEvidenceDirectory.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolvedCliEvidenceDirectory) -notmatch '^opensphere-os-shell-cli-evidence-[a-f0-9]{32}$') {
    throw "Refusing to remove unverified CLI evidence directory: $resolvedCliEvidenceDirectory"
  }
  if (Test-Path -LiteralPath $resolvedCliEvidenceDirectory) {
    Remove-Item -LiteralPath $resolvedCliEvidenceDirectory -Recurse -Force
  }
}
$releaseOverrides = @()
if ($runtimePublicationPath) {
  $releaseOverrides += "osShellRuntime/$([string]$runtimeEvidence.releaseTag)/$(([string]$runtimeEvidence.sourceRevision).Substring(0, 12))"
}
if ($cliRuntimePublicationPath) {
  $releaseOverrides += "cliArtifacts+osShellRuntime/$([string]$cliRuntimeEvidence.releaseTag)/$(([string]$cliRuntimeEvidence.sourceRevision).Substring(0, 12))"
}
if ($backendPublicationPath) {
  $releaseOverrides += "backend/$([string]$backendEvidence.releaseTag)/$(([string]$backendEvidence.sourceRevision).Substring(0, 12))"
}
if ($consolePublicationPath) {
  $releaseOverrides += "console/$([string]$consoleEvidence.releaseTag)/$(([string]$consoleEvidence.sourceRevision).Substring(0, 12))"
}
if ($controlPublicationPath) {
  $releaseOverrides += "osShellControl/$([string]$controlEvidence.releaseTag)/$(([string]$controlEvidence.sourceRevision).Substring(0, 12))"
}
$releaseEvidenceRef = if ($releaseOverrides.Count) {
  "release://edge-composite/$([string]$evidence.releaseTag)/$(([string]$evidence.sourceRevision).Substring(0, 12))/$($releaseOverrides -join '/')"
} else {
  "release://edge/$([string]$evidence.releaseTag)/$(([string]$evidence.sourceRevision).Substring(0, 12))"
}
$manifestSha256 = [string]$osShellRelease.cliManifest.sha256
$releaseKeyId = [string]$osShellRelease.cliManifest.keyId
$sessionPolicyRevision = [string]$osShellRelease.sessionPolicyRevision
$runtimeTemplateRevision = [string]$osShellControlRelease.runtimeTemplate.sha256

if ($PrepareTrustOnly) {
  Write-Host '[trust 1/2] Ensure Restricted session namespace and split internal TLS trust'
  Ensure-SessionNamespace
  Ensure-SessionRegistryPullSecret
  Ensure-InternalTls
  if (-not $ReceiptPath) {
    $ReceiptPath = Join-Path (Split-Path $publicationPath -Parent) 'opensphere-local-os-shell-trust-preparation-receipt.json'
  }
  $trustReceipt = [ordered]@{
    apiVersion = 'release.opensphere.io/v1alpha1'
    kind = 'OpenSphereEdgeAuxiliaryTrustPreparationReceipt'
    componentSet = 'cbss-os-shell'
    context = $KubeContext
    sourceRevision = [string]$evidence.sourceRevision
    deploymentToolingSourceRevision = $deploymentToolingSourceRevision
    deploymentToolingSha256 = $deploymentToolingEvidence
    releaseTag = [string]$evidence.releaseTag
    publicationEvidence = $publicationPath
    runtimePublicationEvidence = $runtimePublicationPath
    cliRuntimePublicationEvidence = $cliRuntimePublicationPath
    backendPublicationEvidence = $backendPublicationPath
    consolePublicationEvidence = $consolePublicationPath
    controlPublicationEvidence = $controlPublicationPath
    componentSourceRevisions = [ordered]@{
      base = [string]$evidence.sourceRevision
      backend = [string]$backendEvidence.sourceRevision
      console = [string]$consoleEvidence.sourceRevision
      osShellControl = [string]$controlEvidence.sourceRevision
      cliArtifacts = [string]$cliRuntimeEvidence.sourceRevision
      osShellRuntime = $effectiveRuntimeSourceRevision
    }
    preparedAt = [DateTimeOffset]::UtcNow.ToString('o')
    privateSecrets = @($privateTlsProfiles | ForEach-Object { "$ControlNamespace/$($_.Secret)" })
    publicCaConfigMaps = @("$ControlNamespace/$controlCaConfigMap", "$SessionNamespace/$controlCaConfigMap")
    registryPullSecret = "$SessionNamespace/$registryPullSecret"
  }
  $trustReceipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReceiptPath -Encoding utf8
  Write-Host '[trust 2/2] Split TLS trust prepared; no workload was deployed'
  Write-Host "[receipt] $ReceiptPath"
  return
}

if (-not $ManifestPath) { $ManifestPath = Join-Path $consoleRoot 'backend\os-shell-control\deploy.yaml' }
if (-not (Test-Path -LiteralPath $ManifestPath)) {
  throw "OS Shell deployment manifest is not available at '$ManifestPath'; publication remains non-deployed"
}
$resolvedManifestPath = (Resolve-Path -LiteralPath $ManifestPath).Path
$manifestSource = Get-Content -Raw -LiteralPath $resolvedManifestPath
if ([regex]::Matches($manifestSource, [regex]::Escape($consolePlaceholder)).Count -ne 1 -or
    [regex]::Matches($manifestSource, [regex]::Escape($controlPlaceholder)).Count -ne 3 -or
    [regex]::Matches($manifestSource, [regex]::Escape($runtimePlaceholder)).Count -ne 4) {
  throw 'OS Shell manifest must bind one Console frontdoor, three control workloads and three runtime template references'
}
if ($manifestSource -match '(?m)^\s*image:\s*[^\s]+:(edge|latest)\s*$') {
  throw 'OS Shell deployment manifest contains a mutable workload image tag'
}
if ([regex]::Matches($manifestSource, '(?m)^\s*replicas:\s*0\s*$').Count -ne 4) {
  throw 'OS Shell source manifest must remain exactly default-off for all four auxiliary workloads'
}
foreach ($flagName in @(
  'OS_SHELL_CONTROL_ENABLED', 'OS_SHELL_RUNTIME_CONTROL_ENABLED', 'OS_SHELL_ATTACH_ENABLED',
  'OS_SHELL_RECONCILER_ENABLED', 'OS_SHELL_RUNTIME_REGISTRATION_ENABLED'
)) {
  $flagPattern = 'name:\s*{0},\s*value:\s*"false"' -f [regex]::Escape($flagName)
  if ([regex]::Matches($manifestSource, $flagPattern).Count -ne 3) {
    throw "OS Shell source manifest must declare $flagName=false in every control workload"
  }
}
foreach ($profile in $controlDeploymentProfiles) {
  if ($manifestSource -notmatch "name:\s*$([regex]::Escape([string]$profile.Deployment)),\s*namespace:\s*$([regex]::Escape($ControlNamespace))") {
    throw "OS Shell manifest is missing exact Deployment $($profile.Deployment)"
  }
}
if ($manifestSource -notmatch "name:\s*opensphere-shell-console-api,\s*namespace:\s*$([regex]::Escape($ControlNamespace))") {
  throw 'OS Shell manifest is missing exact Deployment opensphere-shell-console-api'
}
foreach ($service in $expectedControlServices) {
  if ($manifestSource -notmatch "name:\s*$([regex]::Escape($service)),\s*namespace:\s*$([regex]::Escape($ControlNamespace))") {
    throw "OS Shell manifest is missing exact Service $service"
  }
}
$backendManifestSource = Get-Content -Raw -LiteralPath (Join-Path $consoleRoot 'backend\opensphere-console-backend\deploy.yaml')
foreach ($profile in $privateTlsProfiles) {
  $mountAuthoritySource = if ([string]$profile.Deployment -eq 'opensphere-console-backend') { $backendManifestSource } else { $manifestSource }
  if ($mountAuthoritySource -notmatch "secretName:\s*$([regex]::Escape([string]$profile.Secret))") {
    throw "OS Shell manifest is missing the private TLS Secret mount $($profile.Secret)"
  }
}
if ($manifestSource -notmatch "configMap:\s*\{\s*name:\s*$([regex]::Escape($controlCaConfigMap))") {
  throw "OS Shell manifest is missing public CA ConfigMap $controlCaConfigMap"
}

Write-Host '[step 1/7] Ensure Restricted session namespace and split internal TLS trust'
Ensure-SessionNamespace
Ensure-SessionRegistryPullSecret
Ensure-InternalTls

Write-Host '[step 2/7] Verify Console, Backend and CLI prerequisite exact digests'
$prerequisiteEvidence = [ordered]@{
  console = Assert-PrerequisiteDeployment -Deployment 'opensphere-console' -Image $console.image -Digest $console.digest `
    -SourceRevision ([string]$consoleEvidence.sourceRevision)
  backend = Assert-PrerequisiteDeployment -Deployment 'opensphere-console-backend' -Image $backend.image -Digest $backend.digest `
    -SourceRevision ([string]$backendEvidence.sourceRevision)
  cliArtifacts = Assert-PrerequisiteDeployment -Deployment 'os-cli' -Image $cliArtifacts.image -Digest $cliArtifacts.digest `
    -SourceRevision ([string]$evidence.sourceRevision)
}

Write-Host '[step 3/7] Apply committed Supabase migration lineage through additive 0062'
& $migrationRunner -KubeContext $KubeContext -SourceRevision ([string]$evidence.sourceRevision)
if ($LASTEXITCODE -ne 0) { throw "migrate-only.ps1 failed with exit code $LASTEXITCODE" }

Write-Host '[step 4/7] Activate Backend admission and apply exact-digest OS Shell control manifest'
Set-BackendOsShellActivation -Image $backend.image -SourceRevision ([string]$backendEvidence.sourceRevision) -ReleaseEvidenceRef $releaseEvidenceRef
$renderedManifest = $manifestSource.Replace($consolePlaceholder, $console.image).Replace($controlPlaceholder, $control.image).Replace($runtimePlaceholder, $runtime.image)
if ($renderedManifest.Contains($consolePlaceholder) -or $renderedManifest.Contains($controlPlaceholder) -or $renderedManifest.Contains($runtimePlaceholder) -or
    $renderedManifest -match '(?m)^\s*image:\s*[^\s]+:(edge|latest)\s*$') {
  throw 'Rendered OS Shell manifest is not closed over exact image digests'
}
$applied = Invoke-Kubectl -Arguments @('apply', '-f', '-', '-o', 'name') -InputText $renderedManifest
$deploymentResources = @($applied | Where-Object { $_ -match '^deployment(?:\.apps)?/' } | Sort-Object -Unique)
$expectedDeploymentResources = @(
  @($controlDeploymentProfiles | ForEach-Object { "deployment.apps/$($_.Deployment)" }) +
  'deployment.apps/opensphere-shell-console-api' |
  Sort-Object
)
if (($deploymentResources -join ',') -ne ($expectedDeploymentResources -join ',')) {
  throw "OS Shell manifest applied an unexpected Deployment set: $($deploymentResources -join ',')"
}
foreach ($profile in $controlDeploymentProfiles) {
  Set-ControlDeploymentActivation -Profile $profile `
    -SourceRevision ([string]$controlEvidence.sourceRevision) -ReleaseEvidenceRef $releaseEvidenceRef `
    -RuntimeImage $runtime.image -OsArtifactDigest $cliArtifacts.digest `
    -ManifestSha256 $manifestSha256 -ReleaseKeyId $releaseKeyId `
    -SessionPolicyRevision $sessionPolicyRevision -RuntimeTemplateRevision $runtimeTemplateRevision
}
Set-ConsoleApiActivation -SourceRevision ([string]$consoleEvidence.sourceRevision) -ReleaseEvidenceRef $releaseEvidenceRef

Write-Host '[step 5/7] Verify rollout, readiness, exact Pod image IDs and runtime binding'
$deploymentEvidence = [ordered]@{}
$runtimeBindingCount = 0
foreach ($resource in $deploymentResources) {
  $name = ($resource -split '/', 2)[1]
  $profile = @($controlDeploymentProfiles | Where-Object { [string]$_.Deployment -eq $name })
  $isConsoleApi = $name -eq 'opensphere-shell-console-api'
  if (-not $isConsoleApi -and $profile.Count -ne 1) { throw "Deployment $name has no closed activation profile" }
  if (-not $isConsoleApi) { $profile = $profile[0] }
  Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'rollout', 'status', "deployment/$name", '--timeout=600s') | Out-Null
  $deployment = ((Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', "deployment/$name", '-o', 'json')) -join "`n") | ConvertFrom-Json
  $desired = [int]$deployment.spec.replicas
  $ready = [int]$deployment.status.readyReplicas
  $expectedReplicas = if ($isConsoleApi) { 1 } else { [int]$profile.Replicas }
  if ($desired -ne $expectedReplicas -or $ready -ne $desired -or [int]$deployment.status.availableReplicas -ne $desired) {
    throw "Deployment $name is not fully Ready: ready=$ready desired=$desired"
  }
  $serviceAccount = [string]$deployment.spec.template.spec.serviceAccountName
  if (-not $serviceAccount) { throw "Deployment $name must use an explicit ServiceAccount" }
  $containers = @($deployment.spec.template.spec.containers)
  $expectedWorkloadImage = if ($isConsoleApi) { [string]$console.image } else { [string]$control.image }
  $expectedWorkloadDigest = if ($isConsoleApi) { [string]$console.digest } else { [string]$control.digest }
  foreach ($container in $containers) {
    if ([string]$container.image -ne $expectedWorkloadImage) {
      throw "Deployment $name container $($container.name) does not use its exact published image"
    }
    if (-not $container.readinessProbe) { throw "Deployment $name container $($container.name) has no readiness probe" }
  }
  if (-not $isConsoleApi) {
    $runtimeBindings = @($containers | ForEach-Object { @($_.env) } | Where-Object { $_.name -eq 'OS_SHELL_RUNTIME_IMAGE' })
    $runtimeBindingCount += $runtimeBindings.Count
    if ($runtimeBindings.Count -and @($runtimeBindings | Where-Object { [string]$_.value -ne $runtime.image }).Count) {
      throw "Deployment $name has a stale runtime image binding"
    }
    $expectedEnvironment = [ordered]@{}
    foreach ($flag in $profile.Flags.GetEnumerator()) { $expectedEnvironment[[string]$flag.Key] = [string]$flag.Value }
    $expectedEnvironment['OS_SHELL_RUNTIME_IMAGE'] = [string]$runtime.image
    $expectedEnvironment['OS_SHELL_RUNTIME_MAX_PROCESSES'] = [string]$runtimeMaxProcesses
    $expectedEnvironment['OS_SHELL_RUNTIME_GLOBAL_POD_LIMIT'] = [string]$runtimeGlobalPodLimit
    $expectedEnvironment['OS_SHELL_OS_ARTIFACT_DIGEST'] = [string]$cliArtifacts.digest
    $expectedEnvironment['OS_SHELL_MANIFEST_SHA256'] = $manifestSha256
    $expectedEnvironment['OS_SHELL_RELEASE_EVIDENCE_REF'] = $releaseEvidenceRef
    $expectedEnvironment['OS_SHELL_RELEASE_KEY_ID'] = $releaseKeyId
    $expectedEnvironment['OS_SHELL_SESSION_POLICY_REVISION'] = $sessionPolicyRevision
    $expectedEnvironment['OS_SHELL_RUNTIME_TEMPLATE_REVISION'] = $runtimeTemplateRevision
    $targetContainer = @($containers | Where-Object { [string]$_.name -eq [string]$profile.Container })
    if ($targetContainer.Count -ne 1) { throw "Deployment $name does not have its exact profiled container" }
    foreach ($expected in $expectedEnvironment.GetEnumerator()) {
      $bindings = @($targetContainer[0].env | Where-Object { [string]$_.name -eq [string]$expected.Key })
      if ($bindings.Count -ne 1 -or [string]$bindings[0].value -ne [string]$expected.Value) {
        throw "Deployment $name has a non-exact activation binding: $($expected.Key)"
      }
    }
  }
  $selector = @($deployment.spec.selector.matchLabels.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ','
  if (-not $selector) { throw "Deployment $name has no closed Pod selector" }
  $pods = ((Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', 'pods', '-l', $selector, '-o', 'json')) -join "`n") | ConvertFrom-Json
  $activePods = @($pods.items | Where-Object { -not $_.metadata.PSObject.Properties['deletionTimestamp'] })
  if ($activePods.Count -ne $desired) { throw "Deployment $name does not have the expected number of active Pods" }
  foreach ($pod in $activePods) {
    foreach ($status in @($pod.status.containerStatuses)) {
      if (-not [bool]$status.ready -or [string]$status.imageID -notmatch "@$([regex]::Escape($expectedWorkloadDigest))$") {
        throw "Pod $($pod.metadata.name) is not Ready on its exact published digest"
      }
    }
  }
  $deploymentEvidence[$name] = [ordered]@{
    ready = "$ready/$desired"
    serviceAccount = $serviceAccount
    image = $expectedWorkloadImage
    sourceRevision = if ($isConsoleApi) { [string]$consoleEvidence.sourceRevision } else { [string]$controlEvidence.sourceRevision }
    userNamespacePolicy = if ($isConsoleApi) { 'not-applicable' } else { $runtimeUserNamespacePolicy }
  }
}
if ($runtimeBindingCount -lt 1) { throw 'No deployed control workload is bound to the exact runtime image' }
foreach ($service in $expectedControlServices) {
  Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', "service/$service", '-o', 'name') | Out-Null
}

# The four leaf keys are intentionally non-shareable. Scan every live control
# namespace Deployment, including the separately released Console Backend, so a
# hidden cross-mount cannot pass merely because it was outside this manifest.
$secretOwnerEvidence = [ordered]@{}
foreach ($profile in $privateTlsProfiles) { $secretOwnerEvidence[$profile.Secret] = @() }
$allControlDeployments = ((Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', 'deployments', '-o', 'json')) -join "`n") | ConvertFrom-Json
foreach ($candidate in @($allControlDeployments.items)) {
  $candidateName = [string]$candidate.metadata.name
  $candidateServiceAccountProperty = $candidate.spec.template.spec.PSObject.Properties['serviceAccountName']
  $candidateServiceAccount = if ($candidateServiceAccountProperty) {
    [string]$candidateServiceAccountProperty.Value
  } else {
    'default'
  }
  $volumesProperty = $candidate.spec.template.spec.PSObject.Properties['volumes']
  if (-not $volumesProperty) { continue }
  foreach ($volume in @($volumesProperty.Value)) {
    $secretProperty = $volume.PSObject.Properties['secret']
    if (-not $secretProperty) { continue }
    $secretName = [string]$secretProperty.Value.secretName
    if (-not $secretOwnerEvidence.Contains($secretName)) { continue }
    $mounted = $false
    foreach ($container in @($candidate.spec.template.spec.containers)) {
      $mountsProperty = $container.PSObject.Properties['volumeMounts']
      if ($mountsProperty -and @($mountsProperty.Value | Where-Object { [string]$_.name -eq [string]$volume.name }).Count) {
        $mounted = $true
      }
    }
    if (-not $mounted) { throw "Private TLS volume $($volume.name) is declared but not mounted by $candidateName" }
    $secretOwnerEvidence[$secretName] = @($secretOwnerEvidence[$secretName]) + [ordered]@{
      deployment = $candidateName
      serviceAccount = $candidateServiceAccount
      volume = [string]$volume.name
    }
  }
}
foreach ($profile in $privateTlsProfiles) {
  $owners = @($secretOwnerEvidence[$profile.Secret])
  if ($owners.Count -ne 1 -or [string]$owners[0].deployment -ne [string]$profile.Deployment) {
    throw "Private TLS Secret $($profile.Secret) must be mounted only by Deployment $($profile.Deployment)"
  }
}

Write-Host '[step 6/7] Verify positive and negative ServiceAccount SAR boundaries'
$serviceAccounts = @($deploymentEvidence.GetEnumerator() | ForEach-Object { [string]$_.Value.serviceAccount } | Sort-Object -Unique)
$reconcilerAccounts = @($serviceAccounts | Where-Object { $_ -match 'reconciler' })
if ($reconcilerAccounts.Count -ne 1) { throw 'Exactly one OS Shell reconciler ServiceAccount is required' }
$reconcilerSubject = "system:serviceaccount:${ControlNamespace}:$($reconcilerAccounts[0])"
foreach ($verb in @('get', 'list', 'watch', 'create', 'delete')) {
  Assert-Allowed -Subject $reconcilerSubject -Verb $verb -Resource 'pods' -Namespace $SessionNamespace
}
Assert-Allowed -Subject $reconcilerSubject -Verb 'create' -Resource 'tokenreviews.authentication.k8s.io'
foreach ($account in $serviceAccounts) {
  $subject = "system:serviceaccount:${ControlNamespace}:$account"
  Assert-Denied -Subject $subject -Verb 'create' -Resource 'pods/exec' -Namespace $SessionNamespace
  foreach ($verb in @('get', 'list', 'create', 'delete')) {
    Assert-Denied -Subject $subject -Verb $verb -Resource 'secrets' -Namespace $SessionNamespace
  }
  Assert-Denied -Subject $subject -Verb 'create' -Resource 'roles.rbac.authorization.k8s.io' -Namespace $SessionNamespace
  Assert-Denied -Subject $subject -Verb 'create' -Resource 'rolebindings.rbac.authorization.k8s.io' -Namespace $SessionNamespace
  Assert-Denied -Subject $subject -Verb 'get' -Resource 'nodes'
  Assert-Denied -Subject $subject -Verb 'create' -Resource 'pods' -Namespace 'default'
}
$runtimeSubject = "system:serviceaccount:${SessionNamespace}:opensphere-shell-runtime"
Assert-Denied -Subject $runtimeSubject -Verb 'get' -Resource 'pods' -Namespace $SessionNamespace
Assert-Denied -Subject $runtimeSubject -Verb 'get' -Resource 'secrets' -Namespace $SessionNamespace
Assert-Denied -Subject $runtimeSubject -Verb 'create' -Resource 'tokenreviews.authentication.k8s.io'

$componentImages = [ordered]@{
  console = $console.image
  backend = $backend.image
  cliArtifacts = $cliArtifacts.image
  osShellControl = $control.image
  osShellRuntime = $runtime.image
}
$componentSetDigest = Get-CanonicalObjectSha256 -Value $componentImages
Write-Host '[step 7/7] Sign exact release intent, open durable gate, and record deployment receipt'
if (-not $ReceiptPath) {
  $ReceiptPath = Join-Path (Split-Path $publicationPath -Parent) 'opensphere-local-os-shell-deployment-receipt.json'
}
$receiptDirectory = Split-Path ([IO.Path]::GetFullPath($ReceiptPath)) -Parent
if (-not (Test-Path -LiteralPath $receiptDirectory)) { throw "Receipt directory does not exist: $receiptDirectory" }
$profilePath = Join-Path $receiptDirectory 'opensphere-local-os-shell-release-profile.json'
$signaturePath = "$profilePath.sig.json"
$verificationInputs = [ordered]@{}
foreach ($relativePath in @(
  'backend/os-shell-control/deploy.yaml',
  'backend/os-shell-control/deploy.test.js',
  'backend/os-shell-control/runtime-template.test.js',
  'backend/os-shell-control/server.test.js',
  'backend/supabase/verify-ledger-integrity.mjs',
  'scripts/Test-OsShellRuntimeAdmission.ps1',
  'scripts/Test-OsShellEdgeSigning.ps1',
  'scripts/Invoke-OsShellFeatureOperation.ps1',
  'scripts/os-shell-edge-signing.ps1'
)) {
  $verificationPath = Join-Path $consoleRoot $relativePath
  if (-not (Test-Path -LiteralPath $verificationPath)) { throw "Release verification input is missing: $relativePath" }
  $verificationInputs[$relativePath] = Get-CanonicalTextSha256 -Path $verificationPath
}
$applicableLimbs = @(
  'G-01/full-page-positive','G-01/drawer-capability-negative','G-02','G-03','G-04','G-05','G-06','G-07','G-08','G-09',
  'G-10','G-11','G-12','G-13','G-14/operator-persona-binding','G-14/unsupported-persona',
  'G-14/unsupported-runtime-class','G-15','G-16','G-17',
  'P-01','P-02/session-attach-grant-missing','P-04','P-05/full-page-route-history',
  'P-06/full-page-feature-disable','P-06/logout-revoke','P-06/permission-revision-revoke','P-06/frame-port-handler-cleanup',
  'P-08','P-09','P-10','P-11','P-12','P-13','P-14','P-15','P-16','P-17','P-18','P-19','P-20','P-21','P-22','P-23',
  'P-24','P-25','P-26','P-27','P-28','P-29','P-30','P-31','P-32','P-33','P-34','P-35','P-36','P-37','P-38',
  'P-39','P-40','P-41','P-42','P-43','P-44','P-45/unregistered-kubevirt-adapter','P-46','P-47','P-48','P-49','P-50'
)
$applicableEvidence = [ordered]@{}
foreach ($limb in $applicableLimbs) {
  $artifact = if ($limb -match '^P-(22|39|48)') { 'scripts/Test-OsShellRuntimeAdmission.ps1' }
    elseif ($limb -match '^P-04') { 'scripts/Test-OsShellEdgeSigning.ps1' }
    elseif ($limb -match '^P-(06|41)') { 'scripts/Invoke-OsShellFeatureOperation.ps1' }
    elseif ($limb -match '^P-2[467]') { 'backend/os-shell-control/runtime-template.test.js' }
    elseif ($limb -match '^P-(15|16|17|18|19|20|21|23|25|28|29|30|31|32|33|34|35|36|37|38|40|42|43)') {
      'backend/supabase/verify-ledger-integrity.mjs'
    } else { 'backend/os-shell-control/deploy.test.js' }
  $applicableEvidence[$limb] = [ordered]@{
    result = 'NOT_EXECUTED'
    artifactUri = "source://OpenSphere-console/$artifact"
    artifactSha256 = [string]$verificationInputs[$artifact]
    completionPhase = 'post-activation-live-verification'
  }
}
$applicableEvidenceSetDigest = Get-CanonicalObjectSha256 -Value $applicableEvidence
$releaseProfile = [ordered]@{
  apiVersion = 'release.opensphere.io/v1alpha1'
  kind = 'OpenSphereOsShellCompositeReleaseProfile'
  contract = 'opensphere-os-shell-composite-release-profile/v1'
  profileId = 'os-shell-full-page-operator-local-edge/v1'
  profileRevision = 'v1'
  channel = 'edge'
  releaseClass = 'pre-ga'
  gaPromotionEligible = $false
  context = $KubeContext
  releaseTag = [string]$evidence.releaseTag
  releaseEvidenceRef = $releaseEvidenceRef
  publicationEvidence = [ordered]@{
    baseSha256 = Get-FileSha256 -Path $publicationPath
    consoleSha256 = if ($consolePublicationPath) { Get-FileSha256 -Path $consolePublicationPath }
      else { Get-FileSha256 -Path $publicationPath }
    controlSha256 = if ($controlPublicationPath) { Get-FileSha256 -Path $controlPublicationPath }
      else { Get-FileSha256 -Path $publicationPath }
    backendSha256 = if ($backendPublicationPath) { Get-FileSha256 -Path $backendPublicationPath }
      else { Get-FileSha256 -Path $publicationPath }
    runtimeSha256 = if ($runtimePublicationPath) { Get-FileSha256 -Path $runtimePublicationPath }
      else { Get-FileSha256 -Path $publicationPath }
    cliRuntimeSha256 = if ($cliRuntimePublicationPath) { Get-FileSha256 -Path $cliRuntimePublicationPath }
      else { Get-FileSha256 -Path $publicationPath }
  }
  sourceRevisions = [ordered]@{
    base = [string]$evidence.sourceRevision
    console = [string]$consoleEvidence.sourceRevision
    backend = [string]$backendEvidence.sourceRevision
    osShellControl = [string]$controlEvidence.sourceRevision
    cliArtifacts = [string]$cliRuntimeEvidence.sourceRevision
    osShellRuntime = $effectiveRuntimeSourceRevision
    deploymentTooling = $deploymentToolingSourceRevision
  }
  images = $componentImages
  componentSetDigest = $componentSetDigest
  migration = [ordered]@{
    latestMigrationId = [string]$migrationManifest.latestMigrationId
    migrationCount = [int]$migrationManifest.migrationCount
    manifestSha256 = Get-CanonicalTextSha256 -Path $migrationManifestPath
    manifestSetDigest = [string]$migrationManifest.setDigest
    immutable0061Sha256 = "sha256:$migration0061Digest"
    additive0062Sha256 = "sha256:$migration0062Digest"
  }
  runtimePolicy = [ordered]@{
    maxProcesses = $runtimeMaxProcesses
    globalPodLimit = $runtimeGlobalPodLimit
    userNamespacePolicy = $runtimeUserNamespacePolicy
    enforcement = 'linux-userns+rlimit-nproc+namespace-resourcequota'
    runtimeTemplateRevision = $runtimeTemplateRevision
    sessionPolicyRevision = $sessionPolicyRevision
  }
  cliManifest = [ordered]@{ sha256 = $manifestSha256; keyId = $releaseKeyId; image = $cliArtifacts.image }
  verificationSet = [ordered]@{
    inputs = $verificationInputs
    digest = Get-CanonicalObjectSha256 -Value $verificationInputs
    admission = 'canonical-dryrun+single-field-policy-attributed-negative+optional-live-create'
    database = 'fresh-postgresql+two-connection-cas+fencing+quota+drain'
  }
  applicableEvidenceSet = [ordered]@{
    schema = 'opensphere-os-shell-evidence/v1'
    status = 'RELEASE_INTENT_ONLY'
    completionClaim = $false
    countNotApplicableAsPass = $false
    countDeferredAsPass = $false
    applicableLimbCount = $applicableEvidence.Count
    passCount = 0
    results = $applicableEvidence
    manifestDigest = $applicableEvidenceSetDigest
    finalCompletionReceiptRequired = $true
  }
  excludedScope = [ordered]@{
    notApplicable = @('P-02/drawer-grant-missing','P-03/persistent-drawer','P-05/drawer-persistence','P-06/drawer-cleanup')
    deferred = @('G-14/developer-shell-positive','G-14/agent-shell-positive','G-14/kubevirt-adapter-positive','P-07','P-45/registered-kubevirt-adapter-positive','P-51')
  }
  deployedWorkloads = $deploymentEvidence
}
$signedProfile = New-OsShellEdgeSignedDocument -Document $releaseProfile -DocumentPath $profilePath `
  -SignaturePath $signaturePath -SigningKeyPath $SigningKey -KeyId $SigningKeyId
Ensure-OsShellEdgeEvidenceTrust -PublicKeySpkiBase64 $signedProfile.PublicKeySpkiBase64
if (-not (Test-OsShellEdgeSignedDocument -DocumentPath $profilePath -SignaturePath $signaturePath `
    -TrustedPublicKeySpkiBase64 $signedProfile.PublicKeySpkiBase64 -ExpectedKeyId $SigningKeyId)) {
  throw 'signed OS Shell composite release profile did not verify'
}
$featureOperationEvidence = [ordered]@{
  authority = 'kubernetes-workload'
  channel = 'edge'
  componentSetDigest = $componentSetDigest
  gaEligible = $false
  latestMigrationId = [string]$migrationManifest.latestMigrationId
  migrationSetDigest = [string]$migrationManifest.setDigest
  publicationSha256 = Get-FileSha256 -Path $publicationPath
  releaseIntentKeyId = $SigningKeyId
  releaseIntentSha256 = $signedProfile.DocumentSha256
  releaseIntentSignatureSha256 = $signedProfile.SignatureSha256
  sourceRevision = [string]$consoleEvidence.sourceRevision
}
Write-Host '[owner] Open durable gate only after the signed release intent and trust verification converge'
$enableOperationId = New-FeatureOperationId -Kind Enable -ReleaseIntentSha256 $signedProfile.DocumentSha256
$featureOperation = Invoke-LocalEdgeShellFeatureOperation -Enabled $true -Evidence $featureOperationEvidence `
  -Reason "Enable exact local edge OS Shell release $([string]$evidence.releaseTag) after verified rollout" `
  -OperationId $enableOperationId
if ([bool]$featureOperation.state.enabled -ne $true -or [long]$featureOperation.state.activeTickets -ne 0) {
  throw 'OS Shell feature gate opened with a non-canonical state'
}
try {
$receipt = [ordered]@{
  apiVersion = 'release.opensphere.io/v1alpha1'
  kind = 'OpenSphereEdgeAuxiliaryDeploymentReceipt'
  receiptClass = 'ActivationReceipt'
  profileId = 'os-shell-full-page-operator-local-edge/v1'
  profileRevision = 'v1'
  plan011CompletionClaim = $false
  applicableEvidenceSetDigest = $applicableEvidenceSetDigest
  completionNextAction = 'Run every applicable Browser/CNI/lifecycle limb and issue a separately signed completion evidence-set receipt.'
  componentSet = 'cbss-os-shell'
  context = $KubeContext
  sourceRevision = [string]$evidence.sourceRevision
  deploymentToolingSourceRevision = $deploymentToolingSourceRevision
  deploymentToolingSha256 = $deploymentToolingEvidence
  releaseTag = [string]$evidence.releaseTag
  publicationEvidence = $publicationPath
  runtimePublicationEvidence = $runtimePublicationPath
  cliRuntimePublicationEvidence = $cliRuntimePublicationPath
  backendPublicationEvidence = $backendPublicationPath
  consolePublicationEvidence = $consolePublicationPath
  controlPublicationEvidence = $controlPublicationPath
  componentSourceRevisions = [ordered]@{
    base = [string]$evidence.sourceRevision
    backend = [string]$backendEvidence.sourceRevision
    console = [string]$consoleEvidence.sourceRevision
    osShellControl = [string]$controlEvidence.sourceRevision
    cliArtifacts = [string]$cliRuntimeEvidence.sourceRevision
    osShellRuntime = $effectiveRuntimeSourceRevision
  }
  runtimeOverrideBoundary = $boundaryEvidence
  backendOverrideBoundary = $backendBoundaryEvidence
  consoleOverrideBoundary = $consoleBoundaryEvidence
  controlOverrideBoundary = $controlBoundaryEvidence
  deployedAt = [DateTimeOffset]::UtcNow.ToString('o')
  migration = [ordered]@{
    id = '0062_shell_session_quota_and_kill_switch'
    predecessor = '0061_shell_session_ledger'
    migrationCount = [int]$migrationManifest.migrationCount
    manifestSetDigest = [string]$migrationManifest.setDigest
    sourceRevision = [string]$evidence.sourceRevision
  }
  images = $componentImages
  releaseEvidence = [ordered]@{
    reference = $releaseEvidenceRef
    cliManifestSha256 = $manifestSha256
    keyId = $releaseKeyId
    osArtifactDigest = $cliArtifacts.digest
    runtimeTemplateRevision = $runtimeTemplateRevision
    sessionPolicyRevision = $sessionPolicyRevision
  }
  runtimeProcessPolicy = [ordered]@{
    maxProcesses = $runtimeMaxProcesses
    globalPodLimit = $runtimeGlobalPodLimit
    userNamespacePolicy = $runtimeUserNamespacePolicy
    enforcement = 'linux-userns+rlimit-nproc+namespace-resourcequota'
  }
  featureOperation = $featureOperation
  signedProfile = [ordered]@{
    path = $profilePath
    sha256 = $signedProfile.DocumentSha256
    signaturePath = $signaturePath
    signatureSha256 = $signedProfile.SignatureSha256
    algorithm = 'ES256-P1363'
    keyId = $SigningKeyId
    publicTrustReference = 'configmap://opensphere-console/dupa-trusted-keys#opensphere-edge-local-v1'
    gaPromotionEligible = $false
  }
  prerequisites = $prerequisiteEvidence
  tls = [ordered]@{
    privateSecrets = [ordered]@{
      api = "$ControlNamespace/opensphere-shell-api-tls"
      reconciler = "$ControlNamespace/opensphere-shell-reconciler-tls"
      credentialAuthority = "$ControlNamespace/opensphere-shell-credential-authority-tls"
      consoleApi = "$ControlNamespace/opensphere-shell-console-api-tls"
    }
    publicCaConfigMaps = @("$ControlNamespace/$controlCaConfigMap", "$SessionNamespace/$controlCaConfigMap")
    owners = $secretOwnerEvidence
  }
  registryPullSecret = "$SessionNamespace/$registryPullSecret"
  deployments = $deploymentEvidence
  sar = 'verified'
  detachedSignatureUri = "$ReceiptPath.sig.json"
}
$receiptSignaturePath = "$ReceiptPath.sig.json"
$signedReceipt = New-OsShellEdgeSignedDocument -Document $receipt -DocumentPath $ReceiptPath `
  -SignaturePath $receiptSignaturePath -SigningKeyPath $SigningKey -KeyId $SigningKeyId
if (-not (Test-OsShellEdgeSignedDocument -DocumentPath $ReceiptPath -SignaturePath $receiptSignaturePath `
    -TrustedPublicKeySpkiBase64 $signedProfile.PublicKeySpkiBase64 -ExpectedKeyId $SigningKeyId)) {
  throw 'signed OS Shell activation receipt did not verify'
}
} catch {
  $activationReceiptError = $_
  try {
    # The activation receipt does not yet exist, so recovery uses the already
    # trust-registered signed ReleaseIntent directly. It executes the same
    # durable drain/Pod0/exclusive-claim/scale0/complete owner path as a normal
    # Disable and emits its own signed recovery receipt.
    & (Join-Path $PSScriptRoot 'Invoke-OsShellFeatureOperation.ps1') -Operation Disable `
      -Reason "Disable OS Shell after activation receipt failure for $([string]$evidence.releaseTag)" `
      -PublicationEvidence $publicationPath -RecoverySignedProfile $profilePath -RecoverySignature $signaturePath `
      -ReceiptPath "$ReceiptPath.activation-failure-disable.json" -SigningKey $SigningKey `
      -SigningKeyId $SigningKeyId -KubeContext $KubeContext
  } catch {
    throw "Activation receipt failed and durable emergency disable also failed: receipt=$($activationReceiptError.Exception.Message); disable=$($_.Exception.Message)"
  }
  throw $activationReceiptError
}
Write-Host "[success] OS Shell auxiliary components deployed from exact publication evidence"
Write-Host "[control] $($control.image)"
Write-Host "[runtime] $($runtime.image)"
Write-Host "[receipt] $ReceiptPath"
Write-Host "[receipt-signature] $receiptSignaturePath ($($signedReceipt.SignatureSha256))"
