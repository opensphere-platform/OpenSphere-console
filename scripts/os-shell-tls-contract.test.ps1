$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'os-shell-tls-contract.ps1')

function New-TestCertificate {
  param([Parameter(Mandatory)][string[]]$DnsNames)
  $key = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
  try {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
      "CN=$($DnsNames[0])",
      $key,
      [Security.Cryptography.HashAlgorithmName]::SHA256
    )
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    foreach ($name in $DnsNames) { $san.AddDnsName($name) }
    $request.CertificateExtensions.Add($san.Build($true))
    return $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1), [DateTimeOffset]::UtcNow.AddDays(1))
  } finally {
    $key.Dispose()
  }
}

$expected = @('service', 'service.opensphere-console.svc', 'service.opensphere-console.svc.cluster.local')
$exactCertificate = New-TestCertificate -DnsNames $expected
$extraCertificate = New-TestCertificate -DnsNames ($expected + 'attacker.example')
try {
  Assert-ExactCertificateDnsNames -Certificate $exactCertificate -ExpectedDnsNames $expected -Name 'exact fixture'
  $extraRejected = $false
  try {
    Assert-ExactCertificateDnsNames -Certificate $extraCertificate -ExpectedDnsNames $expected -Name 'extra fixture'
  } catch {
    $extraRejected = $_.Exception.Message -match 'DNS SAN set is not exact'
  }
  if (-not $extraRejected) { throw 'An extra DNS SAN was not rejected' }
  Write-Output 'OS Shell exact SAN contract: PASS'
} finally {
  $exactCertificate.Dispose()
  $extraCertificate.Dispose()
}
