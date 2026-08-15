[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$PublicationEvidence,
  [string]$ManifestPath = '',
  [string]$KubeContext = 'docker-desktop',
  [string]$ControlNamespace = 'opensphere-console',
  [string]$SessionNamespace = 'opensphere-shell-sessions',
  [string]$ReceiptPath = '',
  [switch]$PrepareTrustOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'os-shell-tls-contract.ps1')

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

function Test-KubectlCanI {
  param(
    [Parameter(Mandatory)][string]$Subject,
    [Parameter(Mandatory)][string]$Verb,
    [Parameter(Mandatory)][string]$Resource,
    [string]$Namespace = ''
  )
  # This is the required kubectl auth can-i SelfSubjectAccessReview-compatible
  # projection. It never grants authority; it only verifies the installed RBAC.
  $arguments = @('auth', 'can-i', $Verb, $Resource, '--as', $Subject)
  if ($Namespace) { $arguments += @('--namespace', $Namespace) }
  $answer = (Invoke-Kubectl -Arguments $arguments | Select-Object -Last 1).Trim().ToLowerInvariant()
  if ($answer -notin @('yes', 'no')) { throw "Unexpected SAR answer for $Subject $Verb ${Resource}: $answer" }
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
    [Parameter(Mandatory)][string]$Digest
  )
  Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'rollout', 'status', "deployment/$Deployment", '--timeout=600s') | Out-Null
  $resource = ((Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', "deployment/$Deployment", '-o', 'json')) -join "`n") | ConvertFrom-Json
  $desired = [int]$resource.spec.replicas
  $ready = [int]$resource.status.readyReplicas
  if ($desired -le 0 -or $ready -ne $desired -or [int]$resource.status.availableReplicas -ne $desired) {
    throw "Prerequisite Deployment $Deployment is not fully Ready: ready=$ready desired=$desired"
  }
  $repository = ($Image -split '@', 2)[0]
  $boundContainers = @($resource.spec.template.spec.containers | Where-Object { [string]$_.image -like "$repository@*" })
  if ($boundContainers.Count -ne 1 -or [string]$boundContainers[0].image -ne $Image) {
    throw "Prerequisite Deployment $Deployment is not pinned to $Image"
  }
  $selector = @($resource.spec.selector.matchLabels.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ','
  if (-not $selector) { throw "Prerequisite Deployment $Deployment has no closed Pod selector" }
  $pods = ((Invoke-Kubectl -Arguments @('-n', $ControlNamespace, 'get', 'pods', '-l', $selector, '-o', 'json')) -join "`n") | ConvertFrom-Json
  if (@($pods.items).Count -ne $desired) { throw "Prerequisite Deployment $Deployment has an unexpected Pod count" }
  foreach ($pod in @($pods.items)) {
    $statuses = @($pod.status.containerStatuses | Where-Object { [string]$_.image -like "$repository@*" })
    if ($statuses.Count -ne 1 -or -not [bool]$statuses[0].ready -or
        [string]$statuses[0].image -ne $Image -or [string]$statuses[0].imageID -notmatch "@$([regex]::Escape($Digest))$") {
      throw "Prerequisite Pod $($pod.metadata.name) is not running the exact digest for $Deployment"
    }
  }
  return [ordered]@{ deployment = $Deployment; ready = "$ready/$desired"; image = $Image; digest = $Digest }
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
          ports = @([ordered]@{ name = 'shell-credential-tls'; containerPort = 8444; protocol = 'TCP' })
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
  $ports = @($activatedContainer[0].ports | Where-Object { [string]$_.name -eq 'shell-credential-tls' })
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
foreach ($command in @('git', 'docker', 'kubectl')) {
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
if ([string]$evidence.apiVersion -ne 'release.opensphere.io/v1alpha1' -or
    [string]$evidence.kind -ne 'OpenSphereEdgeComponentPublication' -or
    [string]$evidence.publicationScope -ne 'ComponentSet' -or
    [string]$evidence.channel -ne 'edge' -or
    [string]$evidence.status -ne 'Active' -or
    [string]$evidence.source -ne 'https://github.com/opensphere-platform/OpenSphere-console' -or
    [string]$evidence.buildAuthority -ne 'localhost' -or
    [string]$evidence.releaseClass -ne 'pre-ga' -or
    [bool]$evidence.gaEligible -or
    [string]$evidence.sourceRevision -notmatch '^[a-f0-9]{40}$' -or
    [string]$evidence.releaseTag -notmatch '^[0-9]{12}$') {
  throw 'Publication evidence is outside the local edge component authority boundary'
}
$platforms = @($evidence.supportedPlatforms | ForEach-Object { [string]$_ })
if ($platforms.Count -ne 1 -or $platforms[0] -ne 'linux/amd64') {
  throw 'OS Shell publication must contain exactly the linux/amd64 edge platform'
}
$componentKeys = @($evidence.components.PSObject.Properties.Name | Sort-Object)
if (($componentKeys -join ',') -ne 'backend,cliArtifacts,console,osShellControl,osShellRuntime') {
  throw "OS Shell deploy requires the exact five-component publication; received: $($componentKeys -join ',')"
}
if ([string]$evidence.immutableTag -ne "local-$(([string]$evidence.sourceRevision).Substring(0, 12))") {
  throw 'Publication immutableTag is not derived from the committed SourceRevision'
}

$console = Get-EvidenceComponent -Evidence $evidence -Key 'console' -Repository $consoleRepository
$backend = Get-EvidenceComponent -Evidence $evidence -Key 'backend' -Repository $backendRepository
$cliArtifacts = Get-EvidenceComponent -Evidence $evidence -Key 'cliArtifacts' -Repository $cliRepository
$control = Get-EvidenceComponent -Evidence $evidence -Key $controlComponent -Repository $controlRepository
$runtime = Get-EvidenceComponent -Evidence $evidence -Key $runtimeComponent -Repository $runtimeRepository
Assert-ImageMetadata -Repository $consoleRepository -Image $console.image -Digest $console.digest `
  -SourceRevision $evidence.sourceRevision -ReleaseTag $evidence.releaseTag -ExpectedPointerTag $evidence.immutableTag
Assert-ImageMetadata -Repository $backendRepository -Image $backend.image -Digest $backend.digest `
  -SourceRevision $evidence.sourceRevision -ReleaseTag $evidence.releaseTag
Assert-ImageMetadata -Repository $cliRepository -Image $cliArtifacts.image -Digest $cliArtifacts.digest `
  -SourceRevision $evidence.sourceRevision -ReleaseTag $evidence.releaseTag
Assert-ImageMetadata -Repository $controlRepository -Image $control.image -Digest $control.digest `
  -SourceRevision $evidence.sourceRevision -ReleaseTag $evidence.releaseTag
Assert-ImageMetadata -Repository $runtimeRepository -Image $runtime.image -Digest $runtime.digest `
  -SourceRevision $evidence.sourceRevision -ReleaseTag $evidence.releaseTag

$head = (& git -C $consoleRoot rev-parse HEAD).Trim()
$deploymentToolingSourceRevision = $head
if ($head -ne [string]$evidence.sourceRevision) {
  & git -C $consoleRoot merge-base --is-ancestor ([string]$evidence.sourceRevision) $head
  if ($LASTEXITCODE -ne 0) {
    throw "Deployment tooling HEAD $head is not a descendant of publication revision $($evidence.sourceRevision)"
  }
  $deploymentToolingAllowlist = @(
    'scripts/Deploy-LocalEdgeOsShell.ps1',
    'backend/os-shell-control/deploy.test.js'
  )
  $changedPaths = @(& git -C $consoleRoot diff --name-only ([string]$evidence.sourceRevision) $head |
    ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  $nonToolingChanges = @($changedPaths | Where-Object { $_ -notin $deploymentToolingAllowlist })
  if (-not $changedPaths.Count -or $nonToolingChanges.Count) {
    throw "Deployment tooling revision changes image or runtime inputs outside the closed allowlist: $($nonToolingChanges -join ', ')"
  }
}
$dirty = & git -C $consoleRoot status --short
if ($dirty) { throw 'The Console source must be clean before applying an OS Shell publication' }
$migrationPath = Join-Path $consoleRoot 'backend\supabase\migrations\0061_shell_session_ledger.sql'
$migrationManifestPath = Join-Path $consoleRoot 'backend\supabase\migrations\manifest.json'
$migrationRunner = Join-Path $consoleRoot 'backend\supabase\migrate-only.ps1'
foreach ($path in @($migrationPath, $migrationManifestPath, $migrationRunner)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Required committed migration input is missing: $path" }
}
& git -C $consoleRoot cat-file -e "$($evidence.sourceRevision):backend/supabase/migrations/0061_shell_session_ledger.sql"
if ($LASTEXITCODE -ne 0) { throw 'Migration 0061_shell_session_ledger.sql is not committed in SourceRevision' }
$migrationArtifact = $evidence.artifacts.supabaseMigrationManifest
if (-not $migrationArtifact -or
    [string]$migrationArtifact.path -ne 'backend/supabase/migrations/manifest.json' -or
    [string]$migrationArtifact.sha256 -ne (Get-CanonicalTextSha256 -Path $migrationManifestPath)) {
  throw 'Committed migration manifest does not match publication evidence'
}
$migrationManifest = Get-Content -Raw -LiteralPath $migrationManifestPath | ConvertFrom-Json
$migration0061 = @($migrationManifest.migrations | Where-Object { [string]$_.name -eq '0061_shell_session_ledger.sql' })
$migration0061Digest = (Get-CanonicalTextSha256 -Path $migrationPath).Substring('sha256:'.Length)
if ($migration0061.Count -ne 1 -or [string]$migration0061[0].sha256 -ne $migration0061Digest) {
  throw 'Migration 0061 is absent from or inconsistent with the canonical migration manifest'
}
if ([string]$migrationArtifact.setDigest -ne [string]$migrationManifest.setDigest -or
    [string]$migrationArtifact.latestMigrationId -ne [string]$migrationManifest.latestMigrationId) {
  throw 'Migration lineage evidence differs from the committed manifest'
}
$osShellRelease = $evidence.artifacts.osShellRelease
$runtimeTemplatePath = Join-Path $consoleRoot 'backend\os-shell-control\runtime-template.js'
if (-not $osShellRelease -or
    [string]$osShellRelease.cliManifest.image -ne [string]$cliArtifacts.image -or
    [string]$osShellRelease.cliManifest.imagePath -ne '/srv/index.json' -or
    [string]$osShellRelease.cliManifest.sha256 -notmatch '^sha256:[a-f0-9]{64}$' -or
    [string]$osShellRelease.cliManifest.signatureAlgorithm -ne 'Ed25519' -or
    [string]$osShellRelease.cliManifest.keyId -ne 'opensphere-cli-local-dev-v1' -or
    [string]$osShellRelease.runtimeTemplate.path -ne 'backend/os-shell-control/runtime-template.js' -or
    [string]$osShellRelease.runtimeTemplate.sha256 -ne (Get-CanonicalTextSha256 -Path $runtimeTemplatePath) -or
    [string]$osShellRelease.sessionPolicyRevision -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') {
  throw 'OS Shell signed manifest, runtime template or session policy evidence is absent or inconsistent'
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
$releaseEvidenceRef = "release://edge/$([string]$evidence.releaseTag)/$(([string]$evidence.sourceRevision).Substring(0, 12))"
$manifestSha256 = [string]$osShellRelease.cliManifest.sha256
$releaseKeyId = [string]$osShellRelease.cliManifest.keyId
$sessionPolicyRevision = [string]$osShellRelease.sessionPolicyRevision
$runtimeTemplateRevision = [string]$osShellRelease.runtimeTemplate.sha256

if ($PrepareTrustOnly) {
  Write-Host '[trust 1/2] Ensure Restricted session namespace and split internal TLS trust'
  Ensure-SessionNamespace
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
    releaseTag = [string]$evidence.releaseTag
    publicationEvidence = $publicationPath
    preparedAt = [DateTimeOffset]::UtcNow.ToString('o')
    privateSecrets = @($privateTlsProfiles | ForEach-Object { "$ControlNamespace/$($_.Secret)" })
    publicCaConfigMaps = @("$ControlNamespace/$controlCaConfigMap", "$SessionNamespace/$controlCaConfigMap")
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
    [regex]::Matches($manifestSource, [regex]::Escape($runtimePlaceholder)).Count -ne 3) {
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
Ensure-InternalTls

Write-Host '[step 2/7] Verify Console, Backend and CLI prerequisite exact digests'
$prerequisiteEvidence = [ordered]@{
  console = Assert-PrerequisiteDeployment -Deployment 'opensphere-console' -Image $console.image -Digest $console.digest
  backend = Assert-PrerequisiteDeployment -Deployment 'opensphere-console-backend' -Image $backend.image -Digest $backend.digest
  cliArtifacts = Assert-PrerequisiteDeployment -Deployment 'os-cli' -Image $cliArtifacts.image -Digest $cliArtifacts.digest
}

Write-Host '[step 3/7] Apply committed Supabase migration lineage including 0061'
& $migrationRunner -KubeContext $KubeContext -SourceRevision ([string]$evidence.sourceRevision)
if ($LASTEXITCODE -ne 0) { throw "migrate-only.ps1 failed with exit code $LASTEXITCODE" }

Write-Host '[step 4/7] Activate Backend admission and apply exact-digest OS Shell control manifest'
Set-BackendOsShellActivation -Image $backend.image -SourceRevision ([string]$evidence.sourceRevision) -ReleaseEvidenceRef $releaseEvidenceRef
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
    -SourceRevision ([string]$evidence.sourceRevision) -ReleaseEvidenceRef $releaseEvidenceRef `
    -RuntimeImage $runtime.image -OsArtifactDigest $cliArtifacts.digest `
    -ManifestSha256 $manifestSha256 -ReleaseKeyId $releaseKeyId `
    -SessionPolicyRevision $sessionPolicyRevision -RuntimeTemplateRevision $runtimeTemplateRevision
}
Set-ConsoleApiActivation -SourceRevision ([string]$evidence.sourceRevision) -ReleaseEvidenceRef $releaseEvidenceRef

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
  if (@($pods.items).Count -ne $desired) { throw "Deployment $name does not have the expected number of Pods" }
  foreach ($pod in @($pods.items)) {
    foreach ($status in @($pod.status.containerStatuses)) {
      if (-not [bool]$status.ready -or [string]$status.imageID -notmatch "@$([regex]::Escape($expectedWorkloadDigest))$") {
        throw "Pod $($pod.metadata.name) is not Ready on its exact published digest"
      }
    }
  }
  $deploymentEvidence[$name] = [ordered]@{ ready = "$ready/$desired"; serviceAccount = $serviceAccount; image = $expectedWorkloadImage }
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
  $candidateServiceAccount = [string]$candidate.spec.template.spec.serviceAccountName
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

Write-Host '[step 7/7] Record non-secret exact-digest deployment receipt'
if (-not $ReceiptPath) {
  $ReceiptPath = Join-Path (Split-Path $publicationPath -Parent) 'opensphere-local-os-shell-deployment-receipt.json'
}
$receipt = [ordered]@{
  apiVersion = 'release.opensphere.io/v1alpha1'
  kind = 'OpenSphereEdgeAuxiliaryDeploymentReceipt'
  componentSet = 'cbss-os-shell'
  context = $KubeContext
  sourceRevision = [string]$evidence.sourceRevision
  deploymentToolingSourceRevision = $deploymentToolingSourceRevision
  releaseTag = [string]$evidence.releaseTag
  publicationEvidence = $publicationPath
  deployedAt = [DateTimeOffset]::UtcNow.ToString('o')
  migration = [ordered]@{
    id = '0061_shell_session_ledger'
    manifestSetDigest = [string]$migrationManifest.setDigest
    sourceRevision = [string]$evidence.sourceRevision
  }
  images = [ordered]@{
    console = $console.image
    backend = $backend.image
    cliArtifacts = $cliArtifacts.image
    osShellControl = $control.image
    osShellRuntime = $runtime.image
  }
  releaseEvidence = [ordered]@{
    reference = $releaseEvidenceRef
    cliManifestSha256 = $manifestSha256
    keyId = $releaseKeyId
    osArtifactDigest = $cliArtifacts.digest
    runtimeTemplateRevision = $runtimeTemplateRevision
    sessionPolicyRevision = $sessionPolicyRevision
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
  deployments = $deploymentEvidence
  sar = 'verified'
}
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReceiptPath -Encoding utf8
Write-Host "[success] OS Shell auxiliary components deployed from exact publication evidence"
Write-Host "[control] $($control.image)"
Write-Host "[runtime] $($runtime.image)"
Write-Host "[receipt] $ReceiptPath"
