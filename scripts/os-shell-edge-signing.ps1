#requires -Version 7.2

Set-StrictMode -Version Latest

$script:OsShellEdgeSigningKeyId = 'opensphere-edge-local-v1'
$script:OsShellEdgeSigningAlgorithm = 'ES256-P1363'

function Assert-OsShellEdgePrivateKeyBoundary {
  param([Parameter(Mandatory)][string]$Path)
  if ($env:OS -ne 'Windows_NT') { throw 'OS Shell edge-local signing is restricted to the Windows Docker Desktop host' }
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $keyRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.opensphere\keys')).TrimEnd('\') + '\'
  if (-not ([IO.Path]::GetFullPath($resolved).StartsWith($keyRoot, [StringComparison]::OrdinalIgnoreCase))) {
    throw 'OS Shell edge signing key must remain under the current user .opensphere/keys directory'
  }
  if (([IO.File]::GetAttributes($resolved) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'OS Shell edge signing key must not be a reparse point'
  }
  $acl = Get-Acl -LiteralPath $resolved
  if (-not $acl.AreAccessRulesProtected) { throw 'OS Shell edge signing key ACL inheritance must be disabled' }
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $currentAllow = $false
  foreach ($rule in @($acl.Access)) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier])
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
      if ($sid -ne $currentSid) { throw 'OS Shell edge signing key ACL permits a principal other than the current user' }
      if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -ne 0) { $currentAllow = $true }
    }
  }
  if (-not $currentAllow) { throw 'OS Shell edge signing key is not readable by the current user' }
  return $resolved
}

function ConvertTo-OsShellBase64Url {
  param([Parameter(Mandatory)][byte[]]$Bytes)
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertFrom-OsShellBase64Url {
  param([Parameter(Mandatory)][string]$Value)
  if ($Value -notmatch '^[A-Za-z0-9_-]+$') { throw 'signature is not canonical base64url' }
  $text = $Value.Replace('-', '+').Replace('_', '/')
  switch ($text.Length % 4) { 0 {} 2 { $text += '==' } 3 { $text += '=' } default { throw 'signature is not canonical base64url' } }
  $bytes = [Convert]::FromBase64String($text)
  if ((ConvertTo-OsShellBase64Url -Bytes $bytes) -cne $Value) { throw 'signature is not canonical base64url' }
  return $bytes
}

function Get-OsShellSha256 {
  param([Parameter(Mandatory)][byte[]]$Bytes)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function New-OsShellEdgeSignedDocument {
  param(
    [Parameter(Mandatory)][System.Collections.IDictionary]$Document,
    [Parameter(Mandatory)][string]$DocumentPath,
    [Parameter(Mandatory)][string]$SignaturePath,
    [Parameter(Mandatory)][string]$SigningKeyPath,
    [string]$KeyId = 'opensphere-edge-local-v1',
    [string]$TrustReference = 'configmap://opensphere-console/dupa-trusted-keys#opensphere-edge-local-v1'
  )
  if ($KeyId -cne $script:OsShellEdgeSigningKeyId) { throw "OS Shell edge evidence must use $($script:OsShellEdgeSigningKeyId)" }
  $resolvedKey = Assert-OsShellEdgePrivateKeyBoundary -Path $SigningKeyPath
  $privatePem = [IO.File]::ReadAllText($resolvedKey)
  if (($privatePem -split '-----BEGIN PRIVATE KEY-----').Length -ne 2 -or
      ($privatePem -split '-----END PRIVATE KEY-----').Length -ne 2 -or
      $privatePem -match 'BEGIN EC PRIVATE KEY|BEGIN ENCRYPTED PRIVATE KEY') {
    throw 'OS Shell edge evidence signing key must be a single unencrypted PKCS8 P-256 key'
  }
  $key = [Security.Cryptography.ECDsa]::Create()
  try {
    $key.ImportFromPem($privatePem)
    if ($key.KeySize -ne 256) { throw 'OS Shell edge evidence signing key must be P-256' }
    $documentJson = $Document | ConvertTo-Json -Depth 20 -Compress
    $documentBytes = [Text.UTF8Encoding]::new($false).GetBytes($documentJson)
    [IO.File]::WriteAllBytes($DocumentPath, $documentBytes)
    $signatureBytes = $key.SignData(
      $documentBytes,
      [Security.Cryptography.HashAlgorithmName]::SHA256,
      [Security.Cryptography.DSASignatureFormat]::IeeeP1363FixedFieldConcatenation
    )
    if ($signatureBytes.Length -ne 64) { throw 'P-256 signature must be a 64-byte P1363 value' }
    $spki = $key.ExportSubjectPublicKeyInfo()
    $envelope = [ordered]@{
      contract = 'opensphere-edge-detached-signature/v1'
      algorithm = $script:OsShellEdgeSigningAlgorithm
      keyId = $KeyId
      trustReference = $TrustReference
      documentSha256 = Get-OsShellSha256 -Bytes $documentBytes
      publicKeySpkiSha256 = Get-OsShellSha256 -Bytes $spki
      signature = ConvertTo-OsShellBase64Url -Bytes $signatureBytes
      releaseClass = 'pre-ga'
      gaPromotionEligible = $false
    }
    $signatureBytesJson = [Text.UTF8Encoding]::new($false).GetBytes(($envelope | ConvertTo-Json -Depth 8 -Compress))
    [IO.File]::WriteAllBytes($SignaturePath, $signatureBytesJson)
    return [pscustomobject]@{
      Envelope = $envelope
      PublicKeySpkiBase64 = [Convert]::ToBase64String($spki)
      DocumentSha256 = [string]$envelope.documentSha256
      SignatureSha256 = Get-OsShellSha256 -Bytes $signatureBytesJson
    }
  } finally {
    $key.Dispose()
  }
}

function Test-OsShellEdgeSignedDocument {
  param(
    [Parameter(Mandatory)][string]$DocumentPath,
    [Parameter(Mandatory)][string]$SignaturePath,
    [Parameter(Mandatory)][string]$TrustedPublicKeySpkiBase64,
    [string]$ExpectedKeyId = 'opensphere-edge-local-v1'
  )
  $documentBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $DocumentPath).Path)
  $envelope = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $SignaturePath).Path) | ConvertFrom-Json
  $keys = @($envelope.PSObject.Properties.Name | Sort-Object)
  $expected = @('algorithm','contract','documentSha256','gaPromotionEligible','keyId','publicKeySpkiSha256','releaseClass','signature','trustReference')
  if (($keys -join ',') -cne (($expected | Sort-Object) -join ',')) { throw 'detached signature envelope is not closed' }
  if ([string]$envelope.contract -cne 'opensphere-edge-detached-signature/v1' -or
      [string]$envelope.algorithm -cne $script:OsShellEdgeSigningAlgorithm -or
      [string]$envelope.keyId -cne $ExpectedKeyId -or
      [string]$envelope.releaseClass -cne 'pre-ga' -or [bool]$envelope.gaPromotionEligible) {
    throw 'detached signature policy is not the Docker Desktop edge-only contract'
  }
  $spki = [Convert]::FromBase64String($TrustedPublicKeySpkiBase64)
  if ([string]$envelope.documentSha256 -cne (Get-OsShellSha256 -Bytes $documentBytes) -or
      [string]$envelope.publicKeySpkiSha256 -cne (Get-OsShellSha256 -Bytes $spki)) {
    throw 'signed document or trusted public key digest mismatch'
  }
  $publicKey = [Security.Cryptography.ECDsa]::Create()
  try {
    [void]$publicKey.ImportSubjectPublicKeyInfo($spki, [ref]0)
    if ($publicKey.KeySize -ne 256 -or -not $publicKey.VerifyData(
      $documentBytes,
      (ConvertFrom-OsShellBase64Url -Value ([string]$envelope.signature)),
      [Security.Cryptography.HashAlgorithmName]::SHA256,
      [Security.Cryptography.DSASignatureFormat]::IeeeP1363FixedFieldConcatenation
    )) { throw 'OS Shell edge evidence signature verification failed' }
  } finally {
    $publicKey.Dispose()
  }
  return $true
}
