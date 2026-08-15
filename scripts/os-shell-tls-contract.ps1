Set-StrictMode -Version Latest

function Assert-ExactCertificateDnsNames {
  param(
    [Parameter(Mandatory)][Security.Cryptography.X509Certificates.X509Certificate2]$Certificate,
    [Parameter(Mandatory)][string[]]$ExpectedDnsNames,
    [Parameter(Mandatory)][string]$Name
  )
  $sanExtensions = @($Certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' })
  if ($sanExtensions.Count -ne 1) { throw "$Name must have exactly one SAN extension" }
  $parsedSan = [Security.Cryptography.X509Certificates.X509SubjectAlternativeNameExtension]::new(
    $sanExtensions[0].RawData,
    $sanExtensions[0].Critical
  )
  $actualNames = @($parsedSan.EnumerateDnsNames() | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
  $expectedNames = @($ExpectedDnsNames | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
  if ($actualNames.Count -ne $expectedNames.Count -or
      ($actualNames -join "`n") -cne ($expectedNames -join "`n")) {
    throw "$Name DNS SAN set is not exact: actual=[$($actualNames -join ',')] expected=[$($expectedNames -join ',')]"
  }
}
