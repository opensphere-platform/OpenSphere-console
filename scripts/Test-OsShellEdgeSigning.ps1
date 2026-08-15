#requires -Version 7.2
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'os-shell-edge-signing.ps1')

$keyHome = Join-Path $env:USERPROFILE '.opensphere\keys'
New-Item -ItemType Directory -Path $keyHome -Force | Out-Null
$root = Join-Path $keyHome "opensphere-os-shell-signing-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $root | Out-Null
$key = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
$wrongKey = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
try {
  $keyPath = Join-Path $root 'edge-key.pem'
  $documentPath = Join-Path $root 'profile.json'
  $signaturePath = Join-Path $root 'profile.json.sig.json'
  [IO.File]::WriteAllText($keyPath, $key.ExportPkcs8PrivateKeyPem())
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $keyAcl = [Security.AccessControl.FileSecurity]::new()
  $keyAcl.SetAccessRuleProtection($true, $false)
  $keyAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentSid,
    [Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write,
    [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $keyPath -AclObject $keyAcl
  $signed = New-OsShellEdgeSignedDocument -Document ([ordered]@{
    contract = 'opensphere-os-shell-composite-release-profile/v1'
    releaseClass = 'pre-ga'
    gaPromotionEligible = $false
    values = @('control', 'runtime', 'console', 'backend', 'cli')
  }) -DocumentPath $documentPath -SignaturePath $signaturePath -SigningKeyPath $keyPath
  if (-not (Test-OsShellEdgeSignedDocument -DocumentPath $documentPath -SignaturePath $signaturePath `
      -TrustedPublicKeySpkiBase64 $signed.PublicKeySpkiBase64)) { throw 'valid edge signature was rejected' }

  $permissiveKeyPath = Join-Path $root 'permissive-key.pem'
  [IO.File]::WriteAllText($permissiveKeyPath, $key.ExportPkcs8PrivateKeyPem())
  $permissiveAcl = [Security.AccessControl.FileSecurity]::new()
  $permissiveAcl.SetAccessRuleProtection($true, $false)
  $permissiveAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentSid,
    [Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write,
    [Security.AccessControl.AccessControlType]::Allow))
  $permissiveAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::WorldSid, $null),
    [Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $permissiveKeyPath -AclObject $permissiveAcl
  try {
    New-OsShellEdgeSignedDocument -Document ([ordered]@{contract='negative/v1'}) `
      -DocumentPath (Join-Path $root 'permissive.json') -SignaturePath (Join-Path $root 'permissive.sig.json') `
      -SigningKeyPath $permissiveKeyPath | Out-Null
    throw 'permissive signing-key ACL was accepted'
  } catch {
    if ($_.Exception.Message -eq 'permissive signing-key ACL was accepted') { throw }
  }

  $wrongSpki = [Convert]::ToBase64String($wrongKey.ExportSubjectPublicKeyInfo())
  try {
    Test-OsShellEdgeSignedDocument -DocumentPath $documentPath -SignaturePath $signaturePath `
      -TrustedPublicKeySpkiBase64 $wrongSpki | Out-Null
    throw 'wrong-key signature was accepted'
  } catch {
    if ($_.Exception.Message -eq 'wrong-key signature was accepted') { throw }
  }

  $bytes = [IO.File]::ReadAllBytes($documentPath)
  $bytes[$bytes.Length - 1] = $bytes[$bytes.Length - 1] -bxor 1
  [IO.File]::WriteAllBytes($documentPath, $bytes)
  try {
    Test-OsShellEdgeSignedDocument -DocumentPath $documentPath -SignaturePath $signaturePath `
      -TrustedPublicKeySpkiBase64 $signed.PublicKeySpkiBase64 | Out-Null
    throw 'tampered signed document was accepted'
  } catch {
    if ($_.Exception.Message -eq 'tampered signed document was accepted') { throw }
  }
  Write-Host 'PASS: valid P-256 edge signature accepted; tamper and wrong-key rejected'
} finally {
  $key.Dispose()
  $wrongKey.Dispose()
  $resolvedRoot = [IO.Path]::GetFullPath($root)
  $resolvedKeyHome = [IO.Path]::GetFullPath($keyHome).TrimEnd('\') + '\'
  if ($resolvedRoot.StartsWith($resolvedKeyHome, [StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetFileName($resolvedRoot) -match '^opensphere-os-shell-signing-[a-f0-9]{32}$') {
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
  }
}
