param(
  [string]$GiteaNamespace = 'opensphere-console-change',
  [string]$SecretName = 'opensphere-gitea-signing',
  [string]$KubeContext = ''
)

# Creates the server-only SSH signing key used by Gitea's own API and merge
# operations. Existing key material is retained so a re-run cannot invalidate
# historical signature verification. The private key is never printed or
# written to Git, a ConfigMap, or the Console namespace.
$ErrorActionPreference = 'Stop'
$kubectlArgs = @()
if ($KubeContext) { $kubectlArgs += "--context=$KubeContext" }

$existing = & kubectl @kubectlArgs -n $GiteaNamespace get secret $SecretName -o json 2>$null
if ($LASTEXITCODE -eq 0) {
  $secret = $existing | ConvertFrom-Json
  if (-not $secret.data.'gitea-signing-key' -or -not $secret.data.'gitea-signing-key.pub') {
    throw "Existing Secret '$SecretName' is incomplete; refusing implicit key rotation."
  }
  Write-Host "Gitea signing Secret '$SecretName' already exists; existing key retained."
  return
}

$sshKeygen = Get-Command ssh-keygen -ErrorAction SilentlyContinue
if (-not $sshKeygen) { throw 'ssh-keygen is required to create the Gitea signing key.' }

$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("opensphere-gitea-signing-" + [Guid]::NewGuid().ToString('N'))
$privateKey = Join-Path $tempDirectory 'gitea-signing-key'
try {
  New-Item -ItemType Directory -Path $tempDirectory -Force | Out-Null
  & $sshKeygen.Source -q -t ed25519 -N '' -C 'OpenSphere Gitea signing <gitea-signing@opensphere.local>' -f $privateKey
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $privateKey) -or -not (Test-Path -LiteralPath "$privateKey.pub")) {
    throw 'Unable to generate the Gitea SSH signing key.'
  }
  & kubectl @kubectlArgs -n $GiteaNamespace create secret generic $SecretName --from-file="gitea-signing-key=$privateKey" --from-file="gitea-signing-key.pub=$privateKey.pub" --dry-run=client -o yaml | kubectl @kubectlArgs apply -f -
  if ($LASTEXITCODE -ne 0) { throw "Unable to create Secret '$SecretName'." }
  Write-Host "Gitea signing Secret '$SecretName' created (private material remains server-side)."
} finally {
  if (Test-Path -LiteralPath $tempDirectory) { Remove-Item -LiteralPath $tempDirectory -Recurse -Force }
}
