#requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^ghcr[.]io/opensphere-platform/opensphere-os-shell-runtime@sha256:[a-f0-9]{64}$')][string]$RuntimeImage,
  [string]$KubeContext = 'docker-desktop',
  [switch]$LiveCreate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$namespace = 'opensphere-shell-sessions'
$reconciler = 'system:serviceaccount:opensphere-console:opensphere-shell-reconciler'
$module = (Resolve-Path (Join-Path $PSScriptRoot '../backend/os-shell-control/runtime-template.js')).Path
$sessionId = [guid]::NewGuid().ToString()
$actorId = [guid]::NewGuid().ToString()
$canonical = & node -e @'
const { buildRuntimePod } = require(process.argv[1]);
const [image, sessionId, actorId] = process.argv.slice(2);
const digest = `sha256:${'1'.repeat(64)}`;
process.stdout.write(JSON.stringify(buildRuntimePod({ session_id: sessionId, actor_id: actorId,
  origin: 'https://localhost:1114', permission_revision: digest, aal: 'aal2',
  release_evidence_ref: 'release://admission-conformance', generation: 1, fencing_epoch: 1 }, {
  namespace: 'opensphere-shell-sessions', runtimeServiceAccount: 'opensphere-shell-runtime', runtimeImage: image,
  runtimeMaxProcesses: 256,
  registrationURL: 'https://opensphere-shell-reconciler.opensphere-console.svc.cluster.local:8443/internal/runtime/register',
  runtimeControlURL: 'https://opensphere-shell-api.opensphere-console.svc.cluster.local:8443/api/os-shell/runtime',
  consoleAPIURL: 'https://opensphere-shell-console-api.opensphere-console.svc.cluster.local:8445' })));
'@ $module $RuntimeImage $sessionId $actorId
if ($LASTEXITCODE -ne 0 -or -not $canonical) { throw 'canonical runtime Pod fixture generation failed' }

$pod = $canonical | ConvertFrom-Json -Depth 100
$name = [string]$pod.metadata.name
& kubectl --context $KubeContext -n $namespace get pod $name --ignore-not-found -o name | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'runtime admission preflight failed' }
if ((& kubectl --context $KubeContext -n $namespace get pod $name --ignore-not-found -o name)) {
  throw "refusing to test over an existing Pod: $namespace/$name"
}

$canonical | & kubectl --context $KubeContext --as $reconciler create --dry-run=server -f - -o name | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'canonical runtime Pod was rejected by server dry-run' }
$policy = & kubectl --context $KubeContext get validatingadmissionpolicy opensphere-shell-runtime-template-v1 -o json | ConvertFrom-Json -Depth 100
if ($LASTEXITCODE -ne 0 -or [long]$policy.metadata.generation -lt 1 -or
    $policy.metadata.annotations.'opensphere.io/admission-contract' -ne 'opensphere-shell-runtime-template-v1') {
  throw 'the exact runtime admission policy is not installed'
}
$rules = @($policy.spec.matchConstraints.resourceRules)
if ($rules.Count -ne 2 -or (@($rules[0].resources) -join ',') -ne 'pods' -or
    (@($rules[1].resources) -join ',') -ne 'pods/ephemeralcontainers,pods/resize' -or
    (@($rules[1].operations) -join ',') -ne 'UPDATE') {
  throw 'runtime admission policy does not close ephemeral-container and in-place resize subresources'
}
$expressions = (($policy.spec.validations | ForEach-Object { [string]$_.expression }) -join "`n$([char]30)`n").Replace($RuntimeImage, '__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__')
$sha = [System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($expressions))
$observedExpressionDigest = 'sha256:' + [Convert]::ToHexString($sha).ToLowerInvariant()
if ($observedExpressionDigest -ne [string]$policy.metadata.annotations.'opensphere.io/expression-set-sha256') {
  throw "deployed admission expressions do not match their source digest: $observedExpressionDigest"
}

$negativeCases = @(
  @{ Name = 'image'; Apply = { param($p) $p.spec.containers[0].image = 'docker.io/library/alpine@sha256:' + ('0' * 64) } },
  @{ Name = 'command'; Apply = { param($p) $p.spec.containers[0] | Add-Member -NotePropertyName command -NotePropertyValue @('/bin/sh') -Force } },
  @{ Name = 'duplicate-env'; Apply = { param($p) $p.spec.containers[0].env += $p.spec.containers[0].env[0] } },
  @{ Name = 'env-value-from'; Apply = { param($p) $p.spec.containers[0].env[0].PSObject.Properties.Remove('value'); $p.spec.containers[0].env[0] | Add-Member -NotePropertyName valueFrom -NotePropertyValue @{ secretKeyRef = @{ name = 'stolen'; key = 'token' } } } },
  @{ Name = 'node-selector'; Apply = { param($p) $p.spec | Add-Member -NotePropertyName nodeSelector -NotePropertyValue @{ 'kubernetes.io/hostname' = 'attacker-selected' } -Force } },
  @{ Name = 'runtime-class'; Apply = { param($p) $p.spec | Add-Member -NotePropertyName runtimeClassName -NotePropertyValue 'attacker-runtime' -Force } },
  @{ Name = 'extra-toleration'; Apply = { param($p) $p.spec | Add-Member -NotePropertyName tolerations -NotePropertyValue @(@{ key='attacker'; operator='Exists'; effect='NoSchedule' }) -Force } },
  @{ Name = 'duplicate-default-toleration'; Apply = { param($p) $p.spec | Add-Member -NotePropertyName tolerations -NotePropertyValue @(
    @{ key='node.kubernetes.io/not-ready'; operator='Exists'; effect='NoExecute'; tolerationSeconds=300 },
    @{ key='node.kubernetes.io/not-ready'; operator='Exists'; effect='NoExecute'; tolerationSeconds=300 }) -Force } },
  @{ Name = 'toleration-seconds'; Apply = { param($p) $p.spec | Add-Member -NotePropertyName tolerations -NotePropertyValue @(
    @{ key='node.kubernetes.io/not-ready'; operator='Exists'; effect='NoExecute'; tolerationSeconds=301 }) -Force } },
  @{ Name = 'toleration-effect'; Apply = { param($p) $p.spec | Add-Member -NotePropertyName tolerations -NotePropertyValue @(
    @{ key='node.kubernetes.io/not-ready'; operator='Exists'; effect='NoSchedule' }) -Force } },
  @{ Name = 'toleration-operator'; Apply = { param($p) $p.spec | Add-Member -NotePropertyName tolerations -NotePropertyValue @(
    @{ key='node.kubernetes.io/not-ready'; operator='Equal'; value=''; effect='NoExecute'; tolerationSeconds=300 }) -Force } },
  @{ Name = 'toleration-value'; Apply = { param($p) $p.spec | Add-Member -NotePropertyName tolerations -NotePropertyValue @(
    @{ key='node.kubernetes.io/not-ready'; operator='Equal'; value='attacker'; effect='NoExecute'; tolerationSeconds=300 }) -Force } },
  @{ Name = 'service-account'; Apply = { param($p) $p.spec.serviceAccountName = 'default' } },
  @{ Name = 'extra-volume'; Apply = { param($p) $p.spec.volumes += @{ name = 'extra'; emptyDir = @{ medium = 'Memory'; sizeLimit = '1Mi' } } } },
  @{ Name = 'share-process'; Apply = { param($p) $p.spec | Add-Member -NotePropertyName shareProcessNamespace -NotePropertyValue $true -Force } },
  @{ Name = 'capability-add'; Apply = { param($p) $p.spec.containers[0].securityContext.capabilities | Add-Member -NotePropertyName add -NotePropertyValue @('NET_BIND_SERVICE') -Force } },
  @{ Name = 'init-container'; Apply = { param($p) $init = $p.spec.containers[0] | ConvertTo-Json -Depth 100 | ConvertFrom-Json -Depth 100; $init.name = 'init'; $p.spec | Add-Member -NotePropertyName initContainers -NotePropertyValue @($init) -Force } },
  @{ Name = 'working-dir'; Apply = { param($p) $p.spec.containers[0] | Add-Member -NotePropertyName workingDir -NotePropertyValue '/run/opensphere-shell' -Force } },
  @{ Name = 'extra-label'; Apply = { param($p) $p.metadata.labels | Add-Member -NotePropertyName attacker -NotePropertyValue 'true' -Force } },
  @{ Name = 'arbitrary-name'; Apply = { param($p) $p.metadata.name = 'os-shell-attacker-duplicate' } },
  @{ Name = 'generate-name'; Apply = { param($p) $p.metadata | Add-Member -NotePropertyName generateName -NotePropertyValue 'os-shell-attacker-' -Force } }
)
foreach ($case in $negativeCases) {
  $candidate = $canonical | ConvertFrom-Json -Depth 100
  & $case.Apply $candidate
  $candidateOutput = ($candidate | ConvertTo-Json -Depth 100 -Compress) |
    & kubectl --context $KubeContext --as $reconciler create --dry-run=server -f - 2>&1
  if ($LASTEXITCODE -eq 0 -or ($candidateOutput -join "`n") -notmatch 'opensphere-shell-runtime-template-v1') {
    throw "runtime admission negative '$($case.Name)' was not denied: $($candidateOutput -join ' ')"
  }
}

$negative = $canonical | ConvertFrom-Json -Depth 100
$negative.metadata.name = 'os-shell-admission-negative'
$negative.spec.containers[0].image = 'docker.io/library/alpine@sha256:' + ('0' * 64)
$negativeJson = $negative | ConvertTo-Json -Depth 100 -Compress
$negativeOutput = $negativeJson | & kubectl --context $KubeContext --as $reconciler create --dry-run=server -f - 2>&1
if ($LASTEXITCODE -eq 0 -or ($negativeOutput -join "`n") -notmatch 'opensphere-shell-runtime-template-v1') {
  throw "mutated runtime Pod was not denied by server dry-run: $($negativeOutput -join ' ')"
}

$actualNegative = $negativeJson | & kubectl --context $KubeContext --as $reconciler create -f - 2>&1
if ($LASTEXITCODE -eq 0) {
  & kubectl --context $KubeContext -n $namespace delete pod os-shell-admission-negative --wait=true | Out-Null
  throw 'mutated runtime Pod was admitted; it was immediately removed'
}
$remaining = & kubectl --context $KubeContext -n $namespace get pod os-shell-admission-negative --ignore-not-found -o name
if ($LASTEXITCODE -ne 0 -or $remaining) { throw 'negative admission canary left a workload behind' }

if ($LiveCreate) {
  $created = $null
  try {
    $created = $canonical | & kubectl --context $KubeContext --as $reconciler create -f - -o json | ConvertFrom-Json -Depth 100
    if ($LASTEXITCODE -ne 0 -or -not $created.metadata.uid) { throw 'canonical runtime Pod create was rejected' }
    $ephemeralPatch = @{
      spec = @{ ephemeralContainers = @(@{
        name='admission-canary'; image=$RuntimeImage; imagePullPolicy='IfNotPresent'; command=@('/nonexistent')
        securityContext=@{ allowPrivilegeEscalation=$false; readOnlyRootFilesystem=$true; runAsNonRoot=$true
          runAsUser=65532; runAsGroup=65532; capabilities=@{drop=@('ALL')}; seccompProfile=@{type='RuntimeDefault'} }
      }) }
    } | ConvertTo-Json -Depth 20 -Compress
    $ephemeralOutput = & kubectl --context $KubeContext --as $reconciler --as-group system:masters `
      -n $namespace patch pod $name --subresource=ephemeralcontainers `
      --type merge -p $ephemeralPatch 2>&1
    if ($LASTEXITCODE -eq 0 -or ($ephemeralOutput -join "`n") -notmatch 'opensphere-shell-runtime-template-v1') {
      throw "ephemeral-container injection was not attributed to the runtime policy: $($ephemeralOutput -join ' ')"
    }
    $afterEphemeral = & kubectl --context $KubeContext -n $namespace get pod $name -o json | ConvertFrom-Json -Depth 100
    if (@($afterEphemeral.spec.ephemeralContainers).Count -ne 0) { throw 'denied ephemeral container mutated the live runtime Pod' }

    $api = & kubectl --context $KubeContext get --raw /api/v1 | ConvertFrom-Json -Depth 30
    if (@($api.resources.name) -contains 'pods/resize') {
      $resizePatch = @{ spec=@{ containers=@(
        @{name='pty';resources=@{requests=@{cpu='25m';memory='32Mi'};limits=@{cpu='750m';memory='256Mi'}}},
        @{name='agent';resources=@{requests=@{cpu='25m';memory='32Mi'};limits=@{cpu='500m';memory='128Mi'}}}
      ) } } | ConvertTo-Json -Depth 20 -Compress
      $resizeOutput = & kubectl --context $KubeContext --as $reconciler --as-group system:masters `
        -n $namespace patch pod $name --subresource=resize --type merge -p $resizePatch 2>&1
      if ($LASTEXITCODE -eq 0 -or ($resizeOutput -join "`n") -notmatch 'opensphere-shell-runtime-template-v1') {
        throw "in-place resize was not attributed to the runtime policy: $($resizeOutput -join ' ')"
      }
    }
  } finally {
    if ($created -and $created.metadata.uid) {
      & kubectl --context $KubeContext -n $namespace delete pod $name --wait=true | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "canonical admission canary cleanup failed for UID $($created.metadata.uid)" }
    }
  }
}

[ordered]@{
  pass = $true
  contract = 'opensphere-shell-runtime-template-v1'
  canonicalServerDryRun = 'Allowed'
  canonicalLiveCreate = if ($LiveCreate) { 'AllowedThenDeleted' } else { 'NotRequested' }
  defaultTolerations = 'ExactNotReadyAndUnreachableNoExecute300s'
  mutatedServerDryRun = 'Denied'
  mutatedLiveCreate = 'Denied'
  ephemeralContainerSubresource = if ($LiveCreate) { 'DeniedByExactPolicy' } else { 'NotRequested' }
  resizeSubresource = if ($LiveCreate) { 'DeniedWhenSupported' } else { 'NotRequested' }
  remainingNegativeWorkloads = 0
} | ConvertTo-Json -Depth 5
