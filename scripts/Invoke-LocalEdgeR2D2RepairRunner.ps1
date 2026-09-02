#requires -Version 7.2

[CmdletBinding()]
param(
  [switch]$Once,
  [string]$ConsoleUrl = 'https://localhost:1114'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked {
  if ($args.Count -lt 1) { throw 'Invoke-Checked requires an executable.' }
  $program = [string]$args[0]
  $arguments = @($args | Select-Object -Skip 1)
  $output = & $program @arguments
  if ($LASTEXITCODE -ne 0) { throw "$program failed with exit code $LASTEXITCODE" }
  return $output
}

if ($env:OS -ne 'Windows_NT') { throw 'R2D2 Repair Runner is restricted to the Windows Docker Desktop host.' }
if (((Invoke-Checked kubectl config current-context) -join '').Trim() -ne 'docker-desktop') {
  throw 'R2D2 Repair Runner requires Kubernetes context docker-desktop.'
}
if ($ConsoleUrl -notmatch '^https://localhost(?::\d+)?$') { throw 'ConsoleUrl must be an HTTPS localhost origin.' }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$origin = ((Invoke-Checked git -C $repoRoot remote get-url origin) -join '').TrimEnd('/')
if ($origin -cne 'https://github.com/opensphere-platform/OpenSphere-console.git') {
  throw 'Repair Runner source is not the canonical OpenSphere-console repository.'
}
$lockRaw = ((Invoke-Checked kubectl -n opensphere-console get configmap opensphere-installation-lock -o 'jsonpath={.data.release\.json}') -join '')
$lock = $lockRaw | ConvertFrom-Json
$backendRevision = [string]$lock.components.backend.sourceRevision
if ($backendRevision -notmatch '^[0-9a-f]{40}$') { throw 'Installed Backend source revision is not exact.' }

$runnerFiles = @(
  'scripts/r2d2-local-edge-repair-runner.mjs',
  'apps/console-api/runtime/r2d2-engineering-remediation.js',
  'apps/console-api/runtime/r2d2-repair-runner-contract.js'
)
Invoke-Checked git -C $repoRoot cat-file -e "${backendRevision}^{commit}" | Out-Null
$delta = @((Invoke-Checked git -C $repoRoot diff --name-only $backendRevision HEAD -- @runnerFiles) | Where-Object { $_ })
if ($delta.Count) {
  throw "Local Runner source differs from the deployed Backend authority: $($delta -join ', ')"
}

$priorUrl = $env:OPENSPHERE_CONSOLE_URL
$priorRevision = $env:OPENSPHERE_REPAIR_RUNNER_REVISION
try {
  $env:OPENSPHERE_CONSOLE_URL = $ConsoleUrl
  $env:OPENSPHERE_REPAIR_RUNNER_REVISION = $backendRevision
  $arguments = @((Join-Path $PSScriptRoot 'r2d2-local-edge-repair-runner.mjs'))
  if ($Once) { $arguments += '--once' }
  Invoke-Checked node @arguments
} finally {
  $env:OPENSPHERE_CONSOLE_URL = $priorUrl
  $env:OPENSPHERE_REPAIR_RUNNER_REVISION = $priorRevision
}
