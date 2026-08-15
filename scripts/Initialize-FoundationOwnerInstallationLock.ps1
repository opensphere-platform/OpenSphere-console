#requires -Version 7.2

[CmdletBinding()]
param([string]$KubeContext = 'docker-desktop')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ((& kubectl --context $KubeContext config current-context).Trim() -cne 'docker-desktop') {
  throw 'Foundation owner installation-lock initialization is restricted to docker-desktop.'
}
$name = 'foundation-owner-installation-lock'
$namespace = 'opensphere-console'
$expected = '{"contract":"opensphere.foundation.owner.installation-lock/v1","revision":0,"phase":"Uninitialized"}'
$initializerIdentity = 'system:serviceaccount:opensphere-console:foundation-owner-installation-lock-initializer'
$initializerKubectlArgs = @('--context', $KubeContext, '--as', $initializerIdentity)

function Test-UtcTimestamp([object]$Value) {
  if ($Value -is [DateTime]) { return $Value.Kind -eq [DateTimeKind]::Utc }
  if ($Value -is [DateTimeOffset]) { return $Value.Offset -eq [TimeSpan]::Zero }
  return [string]$Value -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
}

function Assert-ReleaseProjection([object]$Value, [string]$Reference) {
  if (-not $Value -or -not $Value.PSObject.Properties['image'] -or
      -not $Value.PSObject.Properties['sourceRevision'] -or
      [string]$Value.image -notmatch '^ghcr\.io/opensphere-platform/opensphere-shell-foundation@sha256:[a-f0-9]{64}$' -or
      [string]$Value.sourceRevision -notmatch '^[a-f0-9]{40}$') {
    throw "Foundation owner release projection is invalid ($Reference)."
  }
  $allowed = @('image','sourceRevision','releaseTag','digest')
  if (@($Value.PSObject.Properties | Where-Object { $_.Name -notin $allowed }).Count -ne 0 -or
      ($Value.PSObject.Properties['releaseTag'] -and [string]$Value.releaseTag -notmatch '^[0-9]{12}$') -or
      ($Value.PSObject.Properties['digest'] -and
        ([string]$Value.digest -notmatch '^sha256:[a-f0-9]{64}$' -or -not ([string]$Value.image).EndsWith("@$($Value.digest)")))) {
    throw "Foundation owner release projection is not canonical ($Reference)."
  }
}

function Assert-OperationFields([object]$State, [string]$Source) {
  $required = @('action','operationId','requestId','attempt','leaseExpiresAt','mergeRevision','updatedAt',
    'previous','target','current','publicationSha256')
  if (@($required | Where-Object { -not $State.PSObject.Properties[$_] }).Count -ne 0 -or
      [string]$State.action -notin @('Apply','Rollback') -or
      [string]$State.operationId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
      [string]$State.requestId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
      -not ($State.attempt -is [int] -or $State.attempt -is [long]) -or
      [long]$State.attempt -lt 1 -or [long]$State.attempt -gt 9999 -or
      -not (Test-UtcTimestamp $State.leaseExpiresAt) -or
      [string]$State.mergeRevision -notmatch '^[a-f0-9]{40,64}$' -or
      [string]$State.publicationSha256 -notmatch '^sha256:[a-f0-9]{64}$' -or
      -not (Test-UtcTimestamp $State.updatedAt)) {
    throw "Foundation owner installation lock operation fence is invalid ($Source)."
  }
  Assert-ReleaseProjection $State.previous "$Source previous"
  Assert-ReleaseProjection $State.target "$Source target"
  Assert-ReleaseProjection $State.current "$Source current"
}

function ConvertFrom-ValidatedLockDocument([string]$Document, [string]$Source) {
  try { $configMap = $Document | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "Foundation owner installation lock ConfigMap JSON is invalid ($Source)." }
  if (-not $configMap.data -or -not $configMap.data.PSObject.Properties['release.json'] -or
      [string]::IsNullOrWhiteSpace([string]$configMap.data.'release.json')) {
    throw "Foundation owner installation lock lacks data/release.json ($Source)."
  }
  try { $state = [string]$configMap.data.'release.json' | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "Foundation owner installation lock release.json is invalid ($Source)." }
  if ([string]$state.contract -cne 'opensphere.foundation.owner.installation-lock/v1' -or
      -not ($state.revision -is [int] -or $state.revision -is [long]) -or
      [long]$state.revision -lt 0 -or
      [string]$state.phase -notin @('Uninitialized','Applying','Completed','Failed')) {
    throw "Foundation owner installation lock schema is invalid ($Source)."
  }
  if ([string]$state.phase -ceq 'Uninitialized' -and
      ([long]$state.revision -ne 0 -or @($state.PSObject.Properties).Count -ne 3)) {
    throw "Uninitialized Foundation owner installation lock is not canonical ($Source)."
  }
  if ([string]$state.phase -cne 'Uninitialized') {
    Assert-OperationFields $state $Source
    $commonKeys = @('contract','revision','phase','action','operationId','requestId','attempt',
      'leaseExpiresAt','mergeRevision','previous','target','current','publicationSha256','updatedAt')
    if ([string]$state.phase -ceq 'Applying') {
      if ([long]$state.revision -lt 1 -or
          @($state.PSObject.Properties).Count -ne $commonKeys.Count -or
          @($state.PSObject.Properties | Where-Object { $_.Name -notin $commonKeys }).Count -ne 0 -or
          [string]$state.current.image -cne [string]$state.previous.image -or
          [string]$state.current.sourceRevision -cne [string]$state.previous.sourceRevision) {
        throw "Applying Foundation owner installation lock is invalid ($Source)."
      }
    } elseif ([string]$state.phase -ceq 'Completed') {
      $completedKeys = $commonKeys + @('result','observedGeneration','completedAt')
      if ([long]$state.revision -lt 2 -or
          @($state.PSObject.Properties).Count -ne $completedKeys.Count -or
          @($state.PSObject.Properties | Where-Object { $_.Name -notin $completedKeys }).Count -ne 0 -or
          [string]::IsNullOrWhiteSpace([string]$state.result) -or
          [string]$state.publicationSha256 -notmatch '^sha256:[a-f0-9]{64}$' -or
          -not ($state.observedGeneration -is [int] -or $state.observedGeneration -is [long]) -or
          [long]$state.observedGeneration -lt 1 -or
          -not (Test-UtcTimestamp $state.completedAt) -or
          [string]$state.current.image -cne [string]$state.target.image -or
          [string]$state.current.sourceRevision -cne [string]$state.target.sourceRevision) {
        throw "Completed Foundation owner installation lock is invalid ($Source)."
      }
    } else {
      $failedKeys = $commonKeys + @('rollbackComplete','errorCode','error','failedAt')
      if ([long]$state.revision -lt 2 -or
          @($state.PSObject.Properties).Count -ne $failedKeys.Count -or
          @($state.PSObject.Properties | Where-Object { $_.Name -notin $failedKeys }).Count -ne 0 -or
          -not ($state.rollbackComplete -is [bool]) -or
          [string]$state.errorCode -cne 'foundation-owner-release-execution-failed' -or
          [string]::IsNullOrWhiteSpace([string]$state.error) -or
          -not (Test-UtcTimestamp $state.failedAt)) {
        throw "Failed Foundation owner installation lock is invalid ($Source)."
      }
    }
  }
  return $state
}

$existingText = & kubectl @initializerKubectlArgs -n $namespace get configmap $name -o json 2>$null
if ($LASTEXITCODE -eq 0) {
  $state = ConvertFrom-ValidatedLockDocument ($existingText -join "`n") 'existing state'
  Write-Host "[lock] preserved existing $namespace/$name revision=$($state.revision) phase=$($state.phase)"
  return
}

& kubectl @initializerKubectlArgs -n $namespace create configmap $name --from-literal="release.json=$expected" | Out-Null
if ($LASTEXITCODE -ne 0) {
  # A concurrent create may have won. Re-enter once through the validation path
  # rather than using apply/replace, which could reset a durable revision.
  $existingText = & kubectl @initializerKubectlArgs -n $namespace get configmap $name -o json 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Foundation owner installation lock create failed.' }
  $state = ConvertFrom-ValidatedLockDocument ($existingText -join "`n") 'concurrent create winner'
  Write-Host "[lock] preserved concurrent $namespace/$name revision=$($state.revision) phase=$($state.phase)"
  return
}
Write-Host "[lock] created $namespace/$name without replacing any prior durable state"
