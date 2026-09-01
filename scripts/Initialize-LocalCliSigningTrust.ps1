[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path $env:LOCALAPPDATA 'OpenSphere\trust\cli-update')
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$resolvedParent = [IO.Path]::GetFullPath($OutputDirectory)
if ($resolvedParent.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Local CLI signing trust must be created outside the source repository.'
}

& node (Join-Path $PSScriptRoot 'initialize-local-cli-signing-trust.mjs') $resolvedParent
if ($LASTEXITCODE -ne 0) {
  throw "Local CLI signing trust initialization failed with exit code $LASTEXITCODE"
}

if ($env:OS -eq 'Windows_NT') {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $grant = $identity + ':(OI)(CI)F'
  & icacls $resolvedParent /inheritance:r /grant:r $grant | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to restrict local CLI signing trust ACL.'
  }
}

Write-Host "Local CLI signing trust created under $resolvedParent"
