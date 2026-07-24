[CmdletBinding()]
param(
  [string]$Username = 'opensphere-platform'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Write-Host 'Paste a GitHub Personal Access Token (classic) with write:packages.'
Write-Host 'The token is entered as a masked password and is never printed.'
$credential = Get-Credential -UserName $Username -Message 'OpenSphere local edge — GHCR write credential'
if (-not $credential) {
  throw 'GHCR authentication was cancelled.'
}
if ($credential.UserName -ne $Username) {
  throw "GHCR username must remain $Username"
}

$token = $credential.GetNetworkCredential().Password
if (-not $token) {
  throw 'The GHCR token is empty.'
}
try {
  $token | docker login ghcr.io -u $Username --password-stdin
  if ($LASTEXITCODE -ne 0) {
    throw "docker login failed with exit code $LASTEXITCODE"
  }
  Write-Host 'GHCR credential stored in the Docker credential helper.' -ForegroundColor Green
} finally {
  $token = $null
  $credential = $null
}
