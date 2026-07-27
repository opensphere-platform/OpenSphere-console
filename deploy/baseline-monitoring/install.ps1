[CmdletBinding()]
param(
  [string]$KubectlContext = 'docker-desktop',
  [string]$Manifest = (Join-Path $PSScriptRoot 'beszel-release.yaml')
)

$ErrorActionPreference = 'Stop'

function Invoke-Kubectl {
  param([string[]]$Arguments, [string]$InputText = '')
  $args = @('--context', $KubectlContext) + $Arguments
  if ($InputText) { $InputText | & kubectl @args } else { & kubectl @args }
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
}

function New-RandomBase64([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  [Convert]::ToBase64String($buffer)
}

function New-RandomHex([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  [Convert]::ToHexString($buffer).ToLowerInvariant()
}

& kubectl --context $KubectlContext get namespace opensphere-monitoring *> $null
if ($LASTEXITCODE -ne 0) {
  Invoke-Kubectl -Arguments @('create', 'namespace', 'opensphere-monitoring')
}

$secretExists = $true
& kubectl --context $KubectlContext -n opensphere-monitoring get secret beszel-runtime *> $null
if ($LASTEXITCODE -ne 0) { $secretExists = $false }

if (-not $secretExists) {
  $adminPassword = New-RandomBase64 36
  $readerPassword = New-RandomBase64 36
  $agentToken = [guid]::NewGuid().ToString()
  $webhookToken = New-RandomHex 32
  $secret = @{
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
      'admin-password' = $adminPassword
      'reader-email' = 'opensphere-beszel-reader@internal.invalid'
      'reader-password' = $readerPassword
      'agent-token' = $agentToken
      'webhook-token' = $webhookToken
    }
  } | ConvertTo-Json -Depth 8 -Compress
  Invoke-Kubectl -Arguments @('apply', '-f', '-') -InputText $secret
} else {
  Write-Host 'Reusing existing Beszel runtime credentials; values are not rotated implicitly.'
  $webhookTokenData = (& kubectl --context $KubectlContext -n opensphere-monitoring get secret beszel-runtime -o 'jsonpath={.data.webhook-token}')
  if (-not $webhookTokenData) {
    $existingSecret = (& kubectl --context $KubectlContext -n opensphere-monitoring get secret beszel-runtime -o json | ConvertFrom-Json)
    $replacement = @{
      apiVersion = 'v1'
      kind = 'Secret'
      metadata = @{
        name = 'beszel-runtime'
        namespace = 'opensphere-monitoring'
        labels = @{ 'opensphere.io/secret-scope' = 'baseline-monitoring-only' }
      }
      type = 'Opaque'
      data = @{}
      stringData = @{ 'webhook-token' = (New-RandomHex 32) }
    }
    foreach ($property in $existingSecret.data.PSObject.Properties) {
      $replacement.data[$property.Name] = $property.Value
    }
    Invoke-Kubectl -Arguments @('apply', '-f', '-') -InputText ($replacement | ConvertTo-Json -Depth 8 -Compress)
  }
}

Invoke-Kubectl -Arguments @('apply', '-f', $Manifest)

# Mirror only the reader credential into the Console Backend namespace.
$readerEmail = (& kubectl --context $KubectlContext -n opensphere-monitoring get secret beszel-runtime -o 'jsonpath={.data.reader-email}')
$readerPassword = (& kubectl --context $KubectlContext -n opensphere-monitoring get secret beszel-runtime -o 'jsonpath={.data.reader-password}')
$webhookToken = (& kubectl --context $KubectlContext -n opensphere-monitoring get secret beszel-runtime -o 'jsonpath={.data.webhook-token}')
$backendSecret = @"
apiVersion: v1
kind: Secret
metadata:
  name: opensphere-baseline-monitoring-reader
  namespace: opensphere-console
  labels:
    opensphere.io/secret-scope: console-backend-only
type: Opaque
data:
  email: $readerEmail
  password: $readerPassword
  webhook-token: $webhookToken
"@
Invoke-Kubectl -Arguments @('apply', '-f', '-') -InputText $backendSecret

Invoke-Kubectl -Arguments @('-n', 'opensphere-monitoring', 'rollout', 'status', 'statefulset/beszel-hub', '--timeout=5m')
Invoke-Kubectl -Arguments @('-n', 'opensphere-monitoring', 'delete', 'job', 'beszel-bootstrap-v0187', '--ignore-not-found=true')
Invoke-Kubectl -Arguments @('apply', '-f', $Manifest)
Invoke-Kubectl -Arguments @('-n', 'opensphere-monitoring', 'wait', '--for=condition=complete', 'job/beszel-bootstrap-v0187', '--timeout=5m')

$publicKey = (& kubectl --context $KubectlContext -n opensphere-monitoring get configmap beszel-agent-public-key -o 'jsonpath={.data.key}')
if (-not $publicKey -or $publicKey -eq 'bootstrap-pending') {
  throw 'Beszel bootstrap did not publish the Hub public key.'
}

Invoke-Kubectl -Arguments @('-n', 'opensphere-monitoring', 'rollout', 'restart', 'daemonset/beszel-agent')
Invoke-Kubectl -Arguments @('-n', 'opensphere-monitoring', 'rollout', 'status', 'daemonset/beszel-agent', '--timeout=5m')

Write-Host 'Baseline Infrastructure Monitoring is ready.'
