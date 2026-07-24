[CmdletBinding()]
param(
  [string]$Owner = 'opensphere-platform',
  [string[]]$ChannelTags = @('edge', 'candidate', 'stable', 'ga'),
  [switch]$Execute
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-GhJson {
  param([Parameter(Mandatory)][string]$Endpoint)

  $json = & gh api --paginate --slurp $Endpoint
  if ($LASTEXITCODE -ne 0) {
    throw "GitHub API read failed: $Endpoint"
  }
  $pages = $json | ConvertFrom-Json -Depth 100
  return @($pages | ForEach-Object { @($_) })
}

function Wait-GhApiCapacity {
  $json = & gh api rate_limit
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not inspect GitHub API rate limit.'
  }
  $rate = ($json | ConvertFrom-Json).resources.core
  if ([int]$rate.remaining -ge 100) {
    return
  }

  $reset = [DateTimeOffset]::FromUnixTimeSeconds([long]$rate.reset)
  $seconds = [Math]::Max(1, [Math]::Ceiling(($reset - [DateTimeOffset]::UtcNow).TotalSeconds) + 5)
  Write-Host "[rate-limit] remaining=$($rate.remaining); waiting ${seconds}s until reset"
  while ($seconds -gt 0) {
    $slice = [Math]::Min(60, $seconds)
    Start-Sleep -Seconds $slice
    $seconds -= $slice
  }
}

function Remove-GhResource {
  param(
    [Parameter(Mandatory)][string]$Endpoint,
    [Parameter(Mandatory)][string]$Description
  )

  $output = & gh api --method DELETE $Endpoint --silent 2>&1
  if ($LASTEXITCODE -eq 0) {
    return
  }
  if (($output -join "`n") -match 'HTTP 404') {
    Write-Host "[already-absent] $Description"
    return
  }
  throw "GitHub deletion failed: $Description`n$($output -join "`n")"
}

function Get-ManifestChildren {
  param(
    [Parameter(Mandatory)][string]$PackageName,
    [Parameter(Mandatory)][string]$Digest
  )

  $reference = "ghcr.io/$Owner/${PackageName}@$Digest"
  $raw = & docker buildx imagetools inspect $reference --raw 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Cannot inspect retained manifest graph: $reference"
  }
  $document = ($raw -join [Environment]::NewLine) | ConvertFrom-Json -Depth 100
  if ((-not ($document.PSObject.Properties.Name -contains 'manifests')) -or
      (-not $document.manifests)) {
    return @()
  }
  return @($document.manifests |
    ForEach-Object { $_.digest } |
    Where-Object { $_ -match '^sha256:[0-9a-f]{64}$' })
}

function Get-RetainedDigests {
  param(
    [Parameter(Mandatory)][string]$PackageName,
    [Parameter(Mandatory)][object[]]$Versions
  )

  $channelRoots = @($Versions | Where-Object {
    $tags = @($_.metadata.container.tags)
    @($tags | Where-Object { $ChannelTags -contains $_ }).Count -gt 0
  })
  if ($channelRoots.Count -eq 0) {
    return [System.Collections.Generic.HashSet[string]]::new(
      [System.StringComparer]::OrdinalIgnoreCase
    )
  }

  $byDigest = @{}
  foreach ($version in $Versions) {
    $byDigest[$version.name] = $version
  }

  $roots = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($root in $channelRoots) {
    $null = $roots.Add($root.name)
    $subjectTag = "sha256-$($root.name.Substring(7))"
    foreach ($referrer in $Versions | Where-Object {
      @($_.metadata.container.tags) -contains $subjectTag
    }) {
      $null = $roots.Add($referrer.name)
    }
  }

  $retained = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($rootDigest in $roots) {
    $null = $retained.Add($rootDigest)
    foreach ($child in Get-ManifestChildren -PackageName $PackageName -Digest $rootDigest) {
      if ($byDigest.ContainsKey($child)) {
        $null = $retained.Add($child)
      }
    }
  }
  return $retained
}

$packages = Invoke-GhJson -Endpoint "/users/$Owner/packages?package_type=container&per_page=100"
$packageDeletes = @($packages | Where-Object { $_.name -like '*-cbs-*' })
$versionDeletes = [System.Collections.Generic.List[object]]::new()
$packageSummaries = [System.Collections.Generic.List[object]]::new()

Write-Host "[inventory] $($packages.Count) container packages"
foreach ($package in $packages | Sort-Object name) {
  if ($package.name -like '*-cbs-*') {
    Write-Host "[delete-package] $($package.name)"
    continue
  }

  $encoded = [uri]::EscapeDataString($package.name)
  $versions = Invoke-GhJson -Endpoint "/users/$Owner/packages/container/$encoded/versions?per_page=100"
  $retained = Get-RetainedDigests -PackageName $package.name -Versions $versions
  $deletions = @($versions | Where-Object { -not $retained.Contains($_.name) })
  foreach ($version in $deletions) {
    $versionDeletes.Add([pscustomobject]@{
      owner = $Owner
      package = $package.name
      encodedPackage = $encoded
      id = [long]$version.id
      digest = $version.name
      tags = @($version.metadata.container.tags)
    })
  }
  $channelRoots = @($versions | Where-Object {
    $tags = @($_.metadata.container.tags)
    @($tags | Where-Object { $ChannelTags -contains $_ }).Count -gt 0
  }).Count
  $packageSummaries.Add([pscustomobject]@{
    package = $package.name
    versions = $versions.Count
    channelRoots = $channelRoots
    retained = $retained.Count
    delete = $deletions.Count
  })
  Write-Host "[scan] $($package.name) roots=$channelRoots retain=$($retained.Count) delete=$($deletions.Count)"
}

Write-Host ''
Write-Host "[summary] package deletes: $($packageDeletes.Count)"
Write-Host "[summary] version deletes: $($versionDeletes.Count)"
Write-Host "[summary] retained graph versions: $(($packageSummaries | Measure-Object retained -Sum).Sum)"

if (-not $Execute) {
  Write-Host '[dry-run] No package or version was deleted.'
  $packageDeletes | Sort-Object name | ForEach-Object { Write-Host "  package: $($_.name)" }
  $packageSummaries |
    Where-Object { $_.delete -gt 0 } |
    Sort-Object package |
    Format-Table package, versions, channelRoots, retained, delete -AutoSize
  exit 0
}

Write-Host '[execute] Deleting complete *-cbs-* packages'
foreach ($package in $packageDeletes | Sort-Object name) {
  Wait-GhApiCapacity
  $encoded = [uri]::EscapeDataString($package.name)
  Remove-GhResource `
    -Endpoint "/users/$Owner/packages/container/$encoded" `
    -Description "package $($package.name)"
  Write-Host "[deleted-package] $($package.name)"
}

Write-Host '[execute] Deleting versions outside every retained channel graph'
$orderedDeletes = @($versionDeletes | Sort-Object package, id)
$batchSize = 50
for ($offset = 0; $offset -lt $orderedDeletes.Count; $offset += $batchSize) {
  Wait-GhApiCapacity
  $last = [Math]::Min($offset + $batchSize - 1, $orderedDeletes.Count - 1)
  $batch = @($orderedDeletes[$offset..$last])
  $results = @($batch | ForEach-Object -Parallel {
    $endpoint = "/users/$($_.owner)/packages/container/$($_.encodedPackage)/versions/$($_.id)"
    $output = & gh api --method DELETE $endpoint --silent 2>&1
    $exitCode = $LASTEXITCODE
    $detail = $output -join "`n"
    [pscustomobject]@{
      package = $_.package
      id = $_.id
      digest = $_.digest
      status = if ($exitCode -eq 0) {
        'deleted'
      } elseif ($detail -match 'HTTP 404') {
        'already-absent'
      } else {
        'failed'
      }
      detail = $detail
    }
  } -ThrottleLimit 8)

  $failed = @($results | Where-Object { $_.status -eq 'failed' })
  if ($failed.Count -gt 0) {
    $failure = $failed[0]
    throw "Version deletion failed: $($failure.package) $($failure.id)`n$($failure.detail)"
  }
  foreach ($result in $results | Sort-Object package, id) {
    if ($result.status -eq 'already-absent') {
      Write-Host "[already-absent] version $($result.package) $($result.id)"
    } else {
      Write-Host "[deleted-version] $($result.package) $($result.id) $($result.digest)"
    }
  }
}

Write-Host '[success] GHCR package cleanup completed.'
