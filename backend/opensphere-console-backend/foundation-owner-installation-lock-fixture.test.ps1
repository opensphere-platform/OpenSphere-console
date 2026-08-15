#requires -Version 7.2

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$initializer = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path `
  'scripts\Initialize-FoundationOwnerInstallationLock.ps1'

function global:kubectl {
  if ($args -contains 'current-context') { $global:LASTEXITCODE = 0; return 'docker-desktop' }
  if ($args -contains 'get') {
    $global:LASTEXITCODE = 0
    return '{"apiVersion":"v1","kind":"ConfigMap","data":{"release.json":"{\"contract\":\"opensphere.foundation.owner.installation-lock/v1\",\"revision\":0,\"phase\":\"Uninitialized\"}"}}'
  }
  throw "Unexpected fixture kubectl invocation: $args"
}

. $initializer

$digestA = 'a' * 64 -join ''
$digestB = 'b' * 64 -join ''
$sourceA = 'c' * 40 -join ''
$sourceB = 'd' * 40 -join ''
$previous = [ordered]@{
  image = "ghcr.io/opensphere-platform/opensphere-shell-foundation@sha256:$digestA"
  sourceRevision = $sourceA
  releaseTag = '202608151200'
}
$target = [ordered]@{
  image = "ghcr.io/opensphere-platform/opensphere-shell-foundation@sha256:$digestB"
  digest = "sha256:$digestB"
  sourceRevision = $sourceB
  releaseTag = '202608151300'
}

function Assert-LockFixture([string]$Action, [string]$Phase) {
  $expectedTarget = if ($Action -ceq 'Rollback') { $previous } else { $target }
  $state = [ordered]@{
    contract = 'opensphere.foundation.owner.installation-lock/v1'
    revision = if ($Phase -ceq 'Applying') { 1 } else { 2 }
    phase = $Phase
    action = $Action
    operationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    requestId = '11111111-2222-4333-8444-555555555555'
    attempt = 2
    leaseExpiresAt = '2026-08-15T12:50:00.000Z'
    mergeRevision = 'e' * 40 -join ''
    previous = $previous
    target = $expectedTarget
    current = if ($Phase -ceq 'Completed') { $expectedTarget } else { $previous }
    publicationSha256 = 'sha256:' + ('f' * 64 -join '')
    updatedAt = '2026-08-15T12:40:00.000Z'
  }
  if ($Phase -ceq 'Completed') {
    $state.result = if ($Action -ceq 'Rollback') { 'RolledBack' } else { 'Applied' }
    $state.observedGeneration = 7
    $state.completedAt = '2026-08-15T12:40:00.000Z'
  } elseif ($Phase -ceq 'Failed') {
    $state.rollbackComplete = $true
    $state.errorCode = 'foundation-owner-release-execution-failed'
    $state.error = 'fixture failure'
    $state.failedAt = '2026-08-15T12:40:00.000Z'
  }
  $document = @{
    apiVersion = 'v1'; kind = 'ConfigMap'
    data = @{ 'release.json' = ($state | ConvertTo-Json -Depth 10 -Compress) }
  } | ConvertTo-Json -Depth 12 -Compress
  $validated = ConvertFrom-ValidatedLockDocument $document "$Action/$Phase fixture"
  if ([string]$validated.action -cne $Action -or [string]$validated.phase -cne $Phase) {
    throw "Fixture round trip mismatch: $Action/$Phase"
  }
}

foreach ($action in @('Apply','Rollback')) {
  foreach ($phase in @('Applying','Completed','Failed')) { Assert-LockFixture $action $phase }
}

Write-Output 'PASS Apply/Rollback x Applying/Completed/Failed lock fixtures'
