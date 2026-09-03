[CmdletBinding()]
param(
  [string]$KubectlContext = 'docker-desktop',
  [string]$Manifest = (Join-Path $PSScriptRoot 'beszel-release.yaml'),

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^ghcr\.io/opensphere-platform/opensphere-console-beszel-hub@sha256:[a-f0-9]{64}$')]
  [string]$BeszelHubImage,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^ghcr\.io/opensphere-platform/opensphere-console-beszel-agent@sha256:[a-f0-9]{64}$')]
  [string]$BeszelAgentImage,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^ghcr\.io/opensphere-platform/opensphere-console-beszel-bootstrap@sha256:[a-f0-9]{64}$')]
  [string]$BeszelBootstrapImage
)

$ErrorActionPreference = 'Stop'

function Invoke-Kubectl {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [AllowEmptyString()][string]$InputText
  )

  $kubectlArguments = @('--context', $KubectlContext) + $Arguments
  if ($PSBoundParameters.ContainsKey('InputText')) {
    $InputText | & kubectl @kubectlArguments
  } else {
    & kubectl @kubectlArguments
  }
  if ($LASTEXITCODE -ne 0) {
    throw "kubectl failed: $($Arguments -join ' ')"
  }
}

function Get-KubectlValue {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $value = (& kubectl --context $KubectlContext @Arguments)
  if ($LASTEXITCODE -ne 0) {
    throw "kubectl read failed: $($Arguments -join ' ')"
  }
  return [string]$value
}

function New-RandomBase64([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToBase64String($buffer)
}

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
  throw 'kubectl is required.'
}
if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) {
  throw "Beszel manifest is absent: $Manifest"
}

Invoke-Kubectl -Arguments @('cluster-info')
Invoke-Kubectl -Arguments @('get', 'namespace', 'opensphere-console')

& kubectl --context $KubectlContext get namespace opensphere-monitoring *> $null
if ($LASTEXITCODE -ne 0) {
  Invoke-Kubectl -Arguments @('create', 'namespace', 'opensphere-monitoring')
}

# Setup owns registry authentication. Do not copy a credential from another
# namespace or fall back to an anonymous/mutable image.
Invoke-Kubectl -Arguments @('-n', 'opensphere-monitoring', 'get', 'secret', 'opensphere-ghcr-pull')

$secretExists = $true
& kubectl --context $KubectlContext -n opensphere-monitoring get secret beszel-runtime *> $null
if ($LASTEXITCODE -ne 0) {
  $secretExists = $false
}

if (-not $secretExists) {
  $runtimeSecret = @{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = @{
      name = 'beszel-runtime'
      namespace = 'opensphere-monitoring'
      labels = @{ 'opensphere.io/secret-scope' = 'baseline-monitoring-only' }
    }
    type = 'Opaque'
    stringData = @{
      'admin-email' = 'opensphere-beszel-admin@internal.invalid'
      'admin-password' = (New-RandomBase64 36)
      'reader-email' = 'opensphere-beszel-reader@internal.invalid'
      'reader-password' = (New-RandomBase64 36)
      'agent-token' = [guid]::NewGuid().ToString()
    }
  } | ConvertTo-Json -Depth 8 -Compress
  Invoke-Kubectl -Arguments @('apply', '-f', '-') -InputText $runtimeSecret
} else {
  Write-Host 'Reusing existing Beszel runtime credentials; values are not rotated implicitly.'
}

$manifestSource = Get-Content -Raw -LiteralPath $Manifest
$renderInputs = [ordered]@{
  '__OPENSPHERE_BESZEL_HUB_IMAGE__' = $BeszelHubImage
  '__OPENSPHERE_BESZEL_AGENT_IMAGE__' = $BeszelAgentImage
  '__OPENSPHERE_BESZEL_BOOTSTRAP_IMAGE__' = $BeszelBootstrapImage
}
$renderedManifest = $manifestSource
foreach ($entry in $renderInputs.GetEnumerator()) {
  $placeholderCount = [regex]::Matches(
    $manifestSource,
    [regex]::Escape([string]$entry.Key)
  ).Count
  if ($placeholderCount -ne 1) {
    throw "$($entry.Key) must occur exactly once; found $placeholderCount"
  }
  $renderedManifest = $renderedManifest.Replace(
    [string]$entry.Key,
    [string]$entry.Value
  )
}
if ($renderedManifest -match '__OPENSPHERE_[A-Z0-9_]+__') {
  throw 'Rendered Beszel manifest still contains an unresolved release input.'
}
if ($renderedManifest -match '(?m)^\s*image:\s*(?!ghcr\.io/opensphere-platform/opensphere-console-beszel-)[^\s]+') {
  throw 'Every Beszel workload image must come from the governed OpenSphere release.'
}

# Mirror only the bounded reader projection into the target C_API namespace.
$readerEmail = Get-KubectlValue -Arguments @(
  '-n', 'opensphere-monitoring', 'get', 'secret', 'beszel-runtime',
  '-o', 'jsonpath={.data.reader-email}'
)
$readerPassword = Get-KubectlValue -Arguments @(
  '-n', 'opensphere-monitoring', 'get', 'secret', 'beszel-runtime',
  '-o', 'jsonpath={.data.reader-password}'
)
$readerSecret = @"
apiVersion: v1
kind: Secret
metadata:
  name: opensphere-baseline-monitoring-reader
  namespace: opensphere-console
  labels:
    opensphere.io/secret-scope: console-api-only
type: Opaque
data:
  email: $readerEmail
  password: $readerPassword
"@
Invoke-Kubectl -Arguments @('apply', '-f', '-') -InputText $readerSecret

$hubClusterIp = (& kubectl --context $KubectlContext -n opensphere-monitoring get service beszel-hub -o 'jsonpath={.spec.clusterIP}' 2>$null)
if ($LASTEXITCODE -eq 0 -and $hubClusterIp -eq 'None') {
  Write-Host 'Replacing legacy headless Beszel Hub Service with a private ClusterIP Service.'
  Invoke-Kubectl -Arguments @('-n', 'opensphere-monitoring', 'delete', 'service', 'beszel-hub')
}

Invoke-Kubectl -Arguments @(
  '-n', 'opensphere-monitoring', 'delete', 'job',
  'beszel-bootstrap-v0187', '--ignore-not-found=true'
)
Invoke-Kubectl -Arguments @('apply', '-f', '-') -InputText $renderedManifest

Invoke-Kubectl -Arguments @(
  '-n', 'opensphere-monitoring', 'rollout', 'status',
  'statefulset/beszel-hub', '--timeout=5m'
)
Invoke-Kubectl -Arguments @(
  '-n', 'opensphere-monitoring', 'wait', '--for=condition=complete',
  'job/beszel-bootstrap-v0187', '--timeout=5m'
)

$publicKey = Get-KubectlValue -Arguments @(
  '-n', 'opensphere-monitoring', 'get', 'configmap',
  'beszel-agent-public-key', '-o', 'jsonpath={.data.key}'
)
if (-not $publicKey -or $publicKey -eq 'bootstrap-pending') {
  throw 'Beszel bootstrap did not publish the Hub public key.'
}

# ConfigMap subPath content is fixed at container start.
Invoke-Kubectl -Arguments @(
  '-n', 'opensphere-monitoring', 'rollout', 'restart', 'daemonset/beszel-agent'
)
Invoke-Kubectl -Arguments @(
  '-n', 'opensphere-monitoring', 'rollout', 'status',
  'daemonset/beszel-agent', '--timeout=5m'
)

$installedImages = [ordered]@{
  'StatefulSet/beszel-hub' = Get-KubectlValue -Arguments @(
    '-n', 'opensphere-monitoring', 'get', 'statefulset', 'beszel-hub',
    '-o', 'jsonpath={.spec.template.spec.containers[0].image}'
  )
  'DaemonSet/beszel-agent' = Get-KubectlValue -Arguments @(
    '-n', 'opensphere-monitoring', 'get', 'daemonset', 'beszel-agent',
    '-o', 'jsonpath={.spec.template.spec.containers[0].image}'
  )
  'Job/beszel-bootstrap-v0187' = Get-KubectlValue -Arguments @(
    '-n', 'opensphere-monitoring', 'get', 'job', 'beszel-bootstrap-v0187',
    '-o', 'jsonpath={.spec.template.spec.containers[0].image}'
  )
}
$expectedImages = @(
  $BeszelHubImage,
  $BeszelAgentImage,
  $BeszelBootstrapImage
)
$installedIndex = 0
foreach ($installedImage in $installedImages.GetEnumerator()) {
  if ([string]$installedImage.Value -ne $expectedImages[$installedIndex]) {
    throw "$($installedImage.Key) differs from the signed release BOM digest."
  }
  $installedIndex += 1
}

$hubService = Get-KubectlValue -Arguments @(
  '-n', 'opensphere-monitoring', 'get', 'service', 'beszel-hub', '-o', 'json'
) | ConvertFrom-Json
if ($hubService.spec.type -ne 'ClusterIP' -or $hubService.spec.clusterIP -eq 'None') {
  throw 'Beszel Hub must remain reachable only through a private ClusterIP Service.'
}
if (@($hubService.spec.ports | Where-Object { $null -ne $_.nodePort }).Count -ne 0) {
  throw 'Beszel Hub must not allocate a NodePort.'
}

$ingressJson = Get-KubectlValue -Arguments @(
  '-n', 'opensphere-monitoring', 'get', 'ingress', '-o', 'json'
)
if ($ingressJson -match 'beszel-hub') {
  throw 'Beszel Hub must not be referenced by an Ingress.'
}

# Fresh bootstrap creates the reader Secret before C_API exists. On an
# existing install, restart only the present consumer to reload its env.
$consoleApi = Get-KubectlValue -Arguments @(
  '-n', 'opensphere-console', 'get', 'deployment', 'opensphere-console-api',
  '--ignore-not-found', '-o', 'name'
)
if (-not [string]::IsNullOrWhiteSpace($consoleApi)) {
  if ($consoleApi.Trim() -ne 'deployment.apps/opensphere-console-api') {
    throw 'Unexpected Console API deployment identity during reader refresh.'
  }
  Invoke-Kubectl -Arguments @(
    '-n', 'opensphere-console', 'rollout', 'restart',
    'deployment/opensphere-console-api'
  )
  Invoke-Kubectl -Arguments @(
    '-n', 'opensphere-console', 'rollout', 'status',
    'deployment/opensphere-console-api', '--timeout=5m'
  )
} else {
  Write-Host 'Beszel reader is ready; Setup will create Console API next.'
}

Write-Host 'Console baseline host observation is ready from signed exact-digest artifacts.'
