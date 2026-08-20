Set-StrictMode -Version Latest

function Assert-ExactObjectKeys {
  param(
    [Parameter(Mandatory)]$Value,
    [Parameter(Mandatory)][string[]]$Keys,
    [Parameter(Mandatory)][string]$Path
  )
  if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType] -or $Value -is [Array]) {
    throw "$Path must be an object with an exact closed schema"
  }
  $actual = @($Value.PSObject.Properties | Where-Object { $_.MemberType -in @('NoteProperty','Property') } | ForEach-Object { [string]$_.Name } | Sort-Object)
  $expected = @($Keys | Sort-Object)
  if (($actual -join "`0") -ne ($expected -join "`0")) {
    throw "$Path keys are not exact: actual=[$($actual -join ',')] expected=[$($expected -join ',')]"
  }
}

function Invoke-Checked {
  if ($args.Count -lt 1) { throw 'Invoke-Checked requires an executable.' }
  $executable = [string]$args[0]
  $arguments = @($args | Select-Object -Skip 1)
  & $executable @arguments
  if ($LASTEXITCODE -ne 0) { throw "$executable failed with exit code $LASTEXITCODE" }
}

function Get-CanonicalTextSha256 {
  param([Parameter(Mandatory)][string]$Path)
  $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($text)))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Get-FileSha256 {
  param([Parameter(Mandatory)][string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose(); $stream.Dispose() }
}

function Get-RemoteDigest {
  param([Parameter(Mandatory)][string]$Reference)
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & docker buildx imagetools inspect $Reference 2>$null
    $inspectExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousErrorActionPreference }
  if ($inspectExitCode -ne 0) { return $null }
  $line = $output | Where-Object { $_ -match '^Digest:\s+(sha256:[0-9a-f]{64})$' } | Select-Object -First 1
  if (-not $line) { throw "Could not parse registry digest for $Reference" }
  return ([regex]::Match($line, 'sha256:[0-9a-f]{64}')).Value
}

function Set-RemoteTag {
  param(
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$Digest,
    [Parameter(Mandatory)][string]$Tag,
    [switch]$Immutable
  )
  if ($Repository -notmatch '^ghcr\.io/opensphere-platform/[a-z0-9-]+$' -or $Digest -notmatch '^sha256:[a-f0-9]{64}$' -or $Tag -notmatch '^[A-Za-z0-9._-]+$') {
    throw 'Remote tag inputs are outside the canonical local-edge boundary'
  }
  $target = "${Repository}:$Tag"
  $existing = Get-RemoteDigest -Reference $target
  if ($Immutable -and $existing -and $existing -ne $Digest) { throw "Immutable tag collision: $target is $existing, expected $Digest" }
  if ($existing -ne $Digest) { Invoke-Checked docker buildx imagetools create --prefer-index=false --tag $target "${Repository}@${Digest}" }
  $actual = Get-RemoteDigest -Reference $target
  if ($actual -ne $Digest) { throw "Tag verification failed: $target is $actual, expected $Digest" }
}

function Get-LocalEdgeReleaseIdentity {
  param([Parameter(Mandatory)][string]$RepositoryPath,[Parameter(Mandatory)][string]$SourceRevision)
  if ($SourceRevision -notmatch '^[0-9a-f]{40}$') { throw 'SourceRevision must be a full lowercase Git commit.' }
  $epochText = (& git -C $RepositoryPath show -s --format=%ct $SourceRevision).Trim()
  if ($epochText -notmatch '^\d+$') { throw "Could not resolve commit timestamp for $SourceRevision" }
  return [ordered]@{
    sourceRevision = $SourceRevision
    releaseTag = [DateTimeOffset]::FromUnixTimeSeconds([long]$epochText).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyyMMddHHmm')
    immutableTag = "local-$($SourceRevision.Substring(0,12))"
  }
}

function Assert-LocalEdgeImageMetadata {
  param(
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$Digest,
    [Parameter(Mandatory)][string]$ExpectedSourceRevision,
    [Parameter(Mandatory)][string]$ExpectedReleaseTag,
    [Parameter(Mandatory)][string]$ExpectedPlatform,
    [string]$ExpectedSdkSourceRevision = ''
  )
  if ($Repository -notmatch '^ghcr\.io/opensphere-platform/[a-z0-9-]+$' -or $Digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'OCI metadata inputs are outside the canonical local-edge boundary' }
  $reference = "${Repository}@${Digest}"
  $raw = & docker buildx imagetools inspect --format '{{json .Image}}' $reference
  if ($LASTEXITCODE -ne 0) { throw "OCI metadata inspection failed for $reference" }
  try { $image = ($raw -join "`n") | ConvertFrom-Json } catch { throw "OCI metadata inspection returned invalid JSON for ${reference}: $($_.Exception.Message)" }
  $actualPlatform = "$([string]$image.os)/$([string]$image.architecture)"
  if ($actualPlatform -ne $ExpectedPlatform) { throw "OCI platform mismatch for ${reference}: $actualPlatform, expected $ExpectedPlatform" }
  $expectedLabels = [ordered]@{
    'io.opensphere.channel'='edge'; 'io.opensphere.source-revision'=$ExpectedSourceRevision;
    'io.opensphere.release-tag'=$ExpectedReleaseTag; 'org.opencontainers.image.version'=$ExpectedReleaseTag;
    'opensphere.io/build-authority'='localhost'; 'opensphere.io/release-class'='pre-ga'; 'opensphere.io/ga-eligible'='false'
  }
  if ($ExpectedSdkSourceRevision) { $expectedLabels['io.opensphere.sdk-source-revision']=$ExpectedSdkSourceRevision }
  foreach ($entry in $expectedLabels.GetEnumerator()) {
    $property=$image.config.Labels.PSObject.Properties[$entry.Key]; $actual=if($property){[string]$property.Value}else{''}
    if ($actual -ne [string]$entry.Value) { throw "OCI label mismatch for ${reference}: $($entry.Key)='$actual', expected '$($entry.Value)'" }
  }
  if ((Get-RemoteDigest -Reference $reference) -ne $Digest) { throw "OCI digest mismatch for ${reference}" }
}

Export-ModuleMember -Function Invoke-Checked,Get-CanonicalTextSha256,Get-FileSha256,Get-RemoteDigest,Set-RemoteTag,Get-LocalEdgeReleaseIdentity,Assert-LocalEdgeImageMetadata,Assert-ExactObjectKeys
