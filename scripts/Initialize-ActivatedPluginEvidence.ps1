[CmdletBinding()]
param([string]$Namespace = 'opensphere-console')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked {
  if ($args.Count -lt 1) { throw 'Invoke-Checked requires an executable.' }
  $executable = [string]$args[0]
  $arguments = @($args | Select-Object -Skip 1)
  $output = & $executable @arguments
  if ($LASTEXITCODE -ne 0) { throw "$executable failed with exit code $LASTEXITCODE" }
  return $output
}

if ((Invoke-Checked kubectl config current-context).Trim() -ne 'docker-desktop') {
  throw 'Activated plugin evidence migration is restricted to docker-desktop.'
}

$registrations = (Invoke-Checked kubectl -n $Namespace get uipluginregistrations.plugins.opensphere.io -o json) |
  ConvertFrom-Json
$migrated = @()

foreach ($registration in @($registrations.items)) {
  $lastActivated = $registration.status.PSObject.Properties['lastActivatedDigest']?.Value
  if ($registration.spec.desiredState -ne 'Enabled' -or
      $registration.status.phase -ne 'DependencyPending' -or
      -not $registration.status.previousDigest -or
      $lastActivated) { continue }

  $name = [string]$registration.metadata.name
  $package = (Invoke-Checked kubectl -n $Namespace get "uipluginpackages.plugins.opensphere.io/$name" -o json) |
    ConvertFrom-Json
  $digest = [string]$package.spec.image.digest
  $manifest = [string]$package.spec.manifest.sha256
  if ($digest -notmatch '^sha256:[0-9a-f]{64}$' -or $manifest -notmatch '^[0-9a-f]{64}$' -or
      [string]$registration.status.currentDigest -ne $digest -or
      [string]$registration.status.currentManifestSha256 -ne $manifest -or
      [string]$registration.status.channelState -ne 'Current') {
    throw "Registration $name does not have one exact current package release eligible for migration."
  }

  $deployment = (Invoke-Checked kubectl -n $Namespace get "deployment.apps/$name" -o json) |
    ConvertFrom-Json
  $desired = [int]$deployment.spec.replicas
  $images = @($deployment.spec.template.spec.containers | ForEach-Object { [string]$_.image })
  if ($desired -lt 1 -or [int]$deployment.status.observedGeneration -lt [int]$deployment.metadata.generation -or
      [int]$deployment.status.readyReplicas -ne $desired -or
      [int]$deployment.status.updatedReplicas -ne $desired -or
      [int]$deployment.status.availableReplicas -ne $desired -or
      -not ($images | Where-Object { $_.EndsWith("@$digest", [StringComparison]::Ordinal) })) {
    throw "Deployment $name is not a fully observed Ready workload for package digest $digest."
  }

  Invoke-Checked kubectl -n $Namespace annotate --overwrite `
    "uipluginregistrations.plugins.opensphere.io/$name" `
    "opensphere.io/activated-digest-migration=$digest" `
    "opensphere.io/activated-manifest-migration=$manifest" | Out-Null
  $migrated += $name
  Write-Host "[migrated] $name $digest"
}

if (-not $migrated.Count) {
  Write-Host '[migration] no eligible legacy plugin registration'
} else {
  Write-Host "[success] bound $($migrated.Count) verified legacy plugin releases: $($migrated -join ', ')"
}
