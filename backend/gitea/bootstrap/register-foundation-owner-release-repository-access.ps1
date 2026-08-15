#requires -Version 7.2

[CmdletBinding()]
param(
  [string]$GiteaNamespace = 'opensphere-console-change',
  [string]$ConsoleNamespace = 'opensphere-console',
  [string]$Organization = 'opensphere',
  [string]$Repository = 'platform-declarations',
  [string]$ServiceAccount = 'opensphere-foundation-owner-release',
  [string]$ControlSecretName = 'opensphere-gitea-control-plane',
  [string]$SecretName = 'foundation-owner-release-gitea-readonly',
  [string]$KubeContext = ''
)

# Provisions one API-only identity that can read the governed declarations
# repository and nothing else. The token crosses the host only in memory and
# is written to the consumer Secret through stdin; it is never logged.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $false

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { throw 'kubectl is required' }
if ($Organization -cne 'opensphere' -or $Repository -cne 'platform-declarations') {
  throw 'Foundation owner release access is restricted to opensphere/platform-declarations.'
}
foreach ($value in @($ServiceAccount, $ControlSecretName, $SecretName)) {
  if ($value -notmatch '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$') { throw "Invalid bootstrap identifier: $value" }
}

$kubectlArgs = @()
if ($KubeContext) { $kubectlArgs += @('--context', $KubeContext) }

function Invoke-Kubectl([string[]]$Arguments, [string]$InputText = '') {
  if ($InputText) { $result = $InputText | & kubectl @kubectlArgs @Arguments }
  else { $result = & kubectl @kubectlArgs @Arguments }
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
  return $result
}

function Read-SecretValue([string]$Namespace, [string]$Name, [string]$Key) {
  $encoded = (& kubectl @kubectlArgs -n $Namespace get secret $Name --ignore-not-found -o "jsonpath={.data.$Key}" 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $encoded) { return '' }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
}

function Invoke-GiteaStatus([string]$Token, [string]$Method, [string]$ApiPath, [object]$Payload = $null) {
  $bodyArgument = ''
  if ($null -ne $Payload) {
    $json = $Payload | ConvertTo-Json -Depth 16 -Compress
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $bodyArgument = " --header 'Content-Type: application/json' --data-binary `"`$(printf '%s' '$encoded' | base64 -d)`""
  }
  $command = "set -eu; curl -sS -o /dev/null -w '%{http_code}' -X '$Method' --header 'Authorization: token $Token'$bodyArgument 'http://127.0.0.1:3000$ApiPath'"
  $status = (Invoke-Kubectl @('-n', $GiteaNamespace, 'exec', '-i', '-c', 'gitea', $script:giteaPod, '--', 'sh', '-s') "$command`n#" | Out-String).Trim()
  if ($status -notmatch '^[0-9]{3}$') { throw "Unable to validate Gitea permission at $ApiPath" }
  return [int]$status
}

function Invoke-GiteaJson([string]$Token, [string]$Method, [string]$ApiPath, [object]$Payload = $null) {
  $bodyArgument = ''
  if ($null -ne $Payload) {
    $json = $Payload | ConvertTo-Json -Depth 16 -Compress
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $bodyArgument = " --header 'Content-Type: application/json' --data-binary `"`$(printf '%s' '$encoded' | base64 -d)`""
  }
  $command = "set -eu; curl -fsS -X '$Method' --header 'Authorization: token $Token'$bodyArgument 'http://127.0.0.1:3000$ApiPath'"
  $response = Invoke-Kubectl @('-n', $GiteaNamespace, 'exec', '-i', '-c', 'gitea', $script:giteaPod, '--', 'sh', '-s') "$command`n#"
  return (($response | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop)
}

function Assert-UserIsNotAdmin([string]$Username) {
  $users = Invoke-Kubectl @('-n', $GiteaNamespace, 'exec', '-c', 'gitea', $script:giteaPod, '--',
    'gitea', '--config', '/etc/gitea/app.ini', 'admin', 'user', 'list')
  $line = (($users | Out-String) -split '\r?\n' |
      Where-Object { $_ -match "^\s*\d+\s+$([regex]::Escape($Username))\s" } | Select-Object -First 1)
  if (-not $line) { throw "Foundation owner Gitea service user was not found: $Username" }
  $columns = @($line.Trim() -split '\s+')
  if ($columns.Count -lt 5 -or $columns[4] -cne 'false') {
    throw "Foundation owner Gitea service user must be a non-admin: $Username"
  }
}

$script:giteaPod = (& kubectl @kubectlArgs -n $GiteaNamespace get pod -l app=opensphere-gitea -o 'jsonpath={.items[0].metadata.name}')
if (-not $script:giteaPod) { throw "Gitea pod not found in $GiteaNamespace" }
$controlToken = Read-SecretValue $ConsoleNamespace $ControlSecretName 'token'
if (-not $controlToken) { throw "Missing governed Gitea control credential: $ConsoleNamespace/$ControlSecretName" }

$existingText = (& kubectl @kubectlArgs -n $ConsoleNamespace get secret $SecretName --ignore-not-found -o json 2>$null)
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect $ConsoleNamespace/$SecretName" }
$token = ''
if ($existingText) {
  $existing = ($existingText | Out-String) | ConvertFrom-Json -ErrorAction Stop
  if ([string]$existing.metadata.labels.'opensphere.io/secret-scope' -cne 'foundation-owner-release-gitea-readonly' -or
      [string]$existing.metadata.annotations.'opensphere.io/gitea-scopes' -cne 'read:repository' -or
      -not $existing.data.PSObject.Properties['token']) {
    throw "Existing $ConsoleNamespace/$SecretName is outside the read-only Foundation owner contract."
  }
  $token = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$existing.data.token))
} else {
  $users = Invoke-Kubectl @('-n', $GiteaNamespace, 'exec', '-c', 'gitea', $script:giteaPod, '--',
    'gitea', '--config', '/etc/gitea/app.ini', 'admin', 'user', 'list')
  if (-not (($users | Out-String) -match "(?m)^\s*\d+\s+$([regex]::Escape($ServiceAccount))\s")) {
    $password = "Fo!$([Guid]::NewGuid().ToString('N'))$([Guid]::NewGuid().ToString('N'))"
    $createUser = "set -eu`nexec gitea --config /etc/gitea/app.ini admin user create --username '$ServiceAccount' --email '$ServiceAccount@opensphere.local' --password '$password' --must-change-password=false"
    try {
      Invoke-Kubectl @('-n', $GiteaNamespace, 'exec', '-i', '-c', 'gitea', $script:giteaPod, '--', 'sh', '-s') "$createUser`n#" | Out-Null
    } finally {
      Remove-Variable password, createUser -ErrorAction SilentlyContinue
    }
  }
  Assert-UserIsNotAdmin $ServiceAccount
  $permissionStatus = Invoke-GiteaStatus $controlToken 'PUT' "/api/v1/repos/$Organization/$Repository/collaborators/$ServiceAccount" @{ permission = 'read' }
  if ($permissionStatus -notin @(201, 204)) { throw "Unable to grant the Foundation owner read-only repository role (HTTP $permissionStatus)." }
  $tokenName = "foundation-owner-release-readonly-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
  $token = (& kubectl @kubectlArgs -n $GiteaNamespace exec -c gitea $script:giteaPod -- gitea --config /etc/gitea/app.ini admin user generate-access-token --username $ServiceAccount --token-name $tokenName --scopes 'read:repository' --raw 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $token) { throw 'Unable to generate the Foundation owner read-only repository token.' }
  $secret = @{
    apiVersion = 'v1'; kind = 'Secret'; type = 'Opaque'
    metadata = @{
      name = $SecretName; namespace = $ConsoleNamespace
      labels = @{ 'opensphere.io/secret-scope' = 'foundation-owner-release-gitea-readonly' }
      annotations = @{ 'opensphere.io/gitea-scopes' = 'read:repository'; 'opensphere.io/gitea-identity' = $ServiceAccount }
    }
    stringData = @{ token = $token }
  } | ConvertTo-Json -Depth 8 -Compress
  try { Invoke-Kubectl @('-n', $ConsoleNamespace, 'create', '-f', '-') $secret | Out-Null }
  finally { Remove-Variable secret -ErrorAction SilentlyContinue }
}

try {
  Assert-UserIsNotAdmin $ServiceAccount
  $permission = Invoke-GiteaJson $controlToken 'GET' "/api/v1/repos/$Organization/$Repository/collaborators/$ServiceAccount/permission"
  if ([string]$permission.permission -cne 'read' -or -not $permission.user -or
      [string]$permission.user.login -cne $ServiceAccount) {
    throw 'Foundation owner Gitea collaborator permission is not exactly read.'
  }
  if ((Invoke-GiteaStatus $token 'GET' "/api/v1/repos/$Organization/$Repository") -ne 200) {
    throw 'Foundation owner read-only token cannot read the governed repository.'
  }
  # PATCH with an empty document is a no-op for a writer. A read-only token
  # must be rejected before mutation, proving that no repository-write scope
  # or collaborator role leaked into this identity.
  if ((Invoke-GiteaStatus $token 'PATCH' "/api/v1/repos/$Organization/$Repository" @{}) -ne 403) {
    throw 'Foundation owner token unexpectedly has repository-write authority.'
  }
} finally {
  Remove-Variable token, controlToken -ErrorAction SilentlyContinue
}

Write-Host "Foundation owner read-only Gitea credential verified: $ConsoleNamespace/$SecretName"
