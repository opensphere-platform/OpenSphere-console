[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^ghcr\.io/opensphere-platform/opensphere-os-cli@sha256:[a-f0-9]{64}$')]
  [string]$Image
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ((& kubectl config current-context).Trim() -ne 'docker-desktop') {
  throw 'CLI artifact deployment is supported only on the docker-desktop edge cluster.'
}

$digest = ($Image -split '@', 2)[1]
$remote = & docker buildx imagetools inspect $Image
if ($LASTEXITCODE -ne 0 -or -not ($remote -match "Digest:\s+$([regex]::Escape($digest))")) {
  throw "The exact CLI artifact image is not readable from GHCR: $Image"
}

$manifestPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'cmd\os-cli\deploy.yaml'
$source = Get-Content -Raw -LiteralPath $manifestPath
if (($source.Split('__OPENSPHERE_OS_CLI_IMAGE__').Count - 1) -ne 1) {
  throw 'CLI artifact manifest must contain exactly one closed image placeholder.'
}
$rendered = $source.Replace('__OPENSPHERE_OS_CLI_IMAGE__', $Image)
$rendered | & kubectl apply -f -
if ($LASTEXITCODE -ne 0) { throw "kubectl apply failed with exit code $LASTEXITCODE" }

& kubectl -n opensphere-console rollout status deployment/os-cli --timeout=600s
if ($LASTEXITCODE -ne 0) { throw "os-cli rollout failed with exit code $LASTEXITCODE" }
$actual = (& kubectl -n opensphere-console get deployment os-cli -o jsonpath='{.spec.template.spec.containers[?(@.name=="serve")].image}').Trim()
if ($actual -ne $Image) {
  throw "os-cli deployment image is $actual, expected $Image"
}
$ready = (& kubectl -n opensphere-console get deployment os-cli -o jsonpath='{.status.readyReplicas}/{.spec.replicas}').Trim()
if ($ready -ne '2/2') { throw "os-cli deployment is not fully Ready: $ready" }

Write-Host "[success] CLI artifacts deployed: $Image ($ready Ready)"
