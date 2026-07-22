param(
  [string]$GiteaNamespace = 'opensphere-console-change',
  [string]$ConsoleNamespace = 'opensphere-console',
  [string]$Organization = 'opensphere',
  [string]$Repository = 'platform-declarations',
  [string]$ServiceAccount = 'opensphere-control',
  [string]$ReviewServiceAccount = 'opensphere-review',
  [string]$SecretName = 'opensphere-gitea-control-plane',
  [string]$KubeContext = ''
)

# Creates the non-human, least-privilege Gitea control-plane identity and the
# private declarations repository.  The only values written to Kubernetes are
# server-side Secret values; no token or generated password is printed.
$ErrorActionPreference = 'Stop'
# A missing bootstrap Secret is an expected first-run condition. PowerShell 7
# otherwise turns kubectl's non-zero probe into a terminating NativeCommandError
# before Read-SecretValue can return an empty value.
$PSNativeCommandUseErrorActionPreference = $false

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { throw 'kubectl is required' }
$kubectlArgs = @()
if ($KubeContext) { $kubectlArgs += @('--context', $KubeContext) }

function Invoke-Kubectl([string[]]$Arguments, [string]$InputText = '') {
  if ($InputText) { $InputText | & kubectl @kubectlArgs @Arguments }
  else { & kubectl @kubectlArgs @Arguments }
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
}

function New-RandomHex([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) }
  finally { $rng.Dispose() }
  return (([BitConverter]::ToString($buffer) -replace '-', '')).ToLowerInvariant()
}

function Read-SecretValue([string]$Key) {
  $encoded = (& kubectl @kubectlArgs -n $ConsoleNamespace get secret $SecretName --ignore-not-found -o "jsonpath={.data.$Key}" 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $encoded) { return '' }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
}

$giteaPod = (& kubectl @kubectlArgs -n $GiteaNamespace get pod -l app=opensphere-gitea -o 'jsonpath={.items[0].metadata.name}')
if (-not $giteaPod) { throw "Gitea pod not found in $GiteaNamespace" }

$token = Read-SecretValue 'token'
$reviewToken = Read-SecretValue 'review-token'
$webhookSecret = Read-SecretValue 'webhook-secret'
$reconcilerToken = Read-SecretValue 'reconciler-token'

if (-not $token) {
  $users = (& kubectl @kubectlArgs -n $GiteaNamespace exec -c gitea $giteaPod -- gitea --config /etc/gitea/app.ini admin user list)
  if ($LASTEXITCODE -ne 0) { throw 'Unable to list Gitea service users' }
  if (-not (($users | Out-String) -match "(?m)^\s*\d+\s+$([regex]::Escape($ServiceAccount))\s")) {
    $password = "Cp!$([Guid]::NewGuid().ToString('N'))$([Guid]::NewGuid().ToString('N'))"
    Invoke-Kubectl @('-n', $GiteaNamespace, 'exec', '-c', 'gitea', $giteaPod, '--', 'gitea', '--config', '/etc/gitea/app.ini', 'admin', 'user', 'create', '--username', $ServiceAccount, '--email', "$ServiceAccount@opensphere.local", '--password', $password, '--must-change-password=false')
  }
  # Repository and organization scopes are sufficient for this adapter. The
  # account has no interactive Console role and its generated password is not
  # retained after this command.
  $tokenName = "console-platform-control-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
  $token = (& kubectl @kubectlArgs -n $GiteaNamespace exec -c gitea $giteaPod -- gitea --config /etc/gitea/app.ini admin user generate-access-token --username $ServiceAccount --token-name $tokenName --scopes 'read:organization,write:organization,read:repository,write:repository' --raw 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $token) { throw 'Unable to generate the Gitea control-plane token' }
}

if (-not $reviewToken) {
  $users = (& kubectl @kubectlArgs -n $GiteaNamespace exec -c gitea $giteaPod -- gitea --config /etc/gitea/app.ini admin user list)
  if ($LASTEXITCODE -ne 0) { throw 'Unable to list Gitea review users' }
  if (-not (($users | Out-String) -match "(?m)^\s*\d+\s+$([regex]::Escape($ReviewServiceAccount))\s")) {
    $password = "Rv!$([Guid]::NewGuid().ToString('N'))$([Guid]::NewGuid().ToString('N'))"
    # The review identity is an API-only Gitea administrator so it can review
    # the private organization repository without becoming an interactive
    # Console identity. Its token is restricted to repository operations.
    Invoke-Kubectl @('-n', $GiteaNamespace, 'exec', '-c', 'gitea', $giteaPod, '--', 'gitea', '--config', '/etc/gitea/app.ini', 'admin', 'user', 'create', '--username', $ReviewServiceAccount, '--email', "$ReviewServiceAccount@opensphere.local", '--password', $password, '--admin', '--must-change-password=false')
  }
  $reviewTokenName = "console-platform-review-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
  $reviewToken = (& kubectl @kubectlArgs -n $GiteaNamespace exec -c gitea $giteaPod -- gitea --config /etc/gitea/app.ini admin user generate-access-token --username $ReviewServiceAccount --token-name $reviewTokenName --scopes 'read:repository,write:repository' --raw 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $reviewToken) { throw 'Unable to generate the Gitea review token' }
}

if (-not $webhookSecret) { $webhookSecret = New-RandomHex 32 }
if (-not $reconcilerToken) { $reconcilerToken = New-RandomHex 32 }

$secret = @{
  apiVersion = 'v1'; kind = 'Secret'
  metadata = @{ name = $SecretName; namespace = $ConsoleNamespace; labels = @{ 'opensphere.io/secret-scope' = 'platform-control-server-only' } }
  type = 'Opaque'
  stringData = @{ token = $token; 'review-token' = $reviewToken; 'webhook-secret' = $webhookSecret; 'reconciler-token' = $reconcilerToken }
} | ConvertTo-Json -Depth 8 -Compress
Invoke-Kubectl @('apply', '-f', '-') $secret

function Test-GiteaApi([string]$ApiPath) {
  $command = "wget -qO- --header 'Authorization: token $token' 'http://127.0.0.1:3000$ApiPath'"
  $priorErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $discard = (& kubectl @kubectlArgs -n $GiteaNamespace exec -c gitea $giteaPod -- sh -ec $command 2>$null)
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $priorErrorAction
  }
}

function Invoke-GiteaRequest([string]$Method, [string]$ApiPath, [object]$Payload) {
  $body = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Payload | ConvertTo-Json -Depth 32 -Compress)))
  $command = "set -eu; body=`$(printf '%s' '$body' | base64 -d); printf '%s' `"`$body`" | curl -fsS -X '$Method' --header 'Authorization: token $token' --header 'Content-Type: application/json' --data-binary @- 'http://127.0.0.1:3000$ApiPath'"
  $discard = (& kubectl @kubectlArgs -n $GiteaNamespace exec -c gitea $giteaPod -- sh -ec $command 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "Gitea $Method failed: $ApiPath" }
}

function Invoke-GiteaPost([string]$ApiPath, [object]$Payload) {
  Invoke-GiteaRequest 'POST' $ApiPath $Payload
}

if (-not (Test-GiteaApi "/api/v1/orgs/$Organization")) {
  Invoke-GiteaPost '/api/v1/orgs' @{ username = $Organization; full_name = 'OpenSphere Platform Control'; description = 'OpenSphere declarative Console control-plane source'; visibility = 'private' }
}
if (-not (Test-GiteaApi "/api/v1/repos/$Organization/$Repository")) {
  Invoke-GiteaPost "/api/v1/orgs/$Organization/repos" @{ name = $Repository; description = 'Reviewed OpenSphere Console desired-state declarations'; private = $true; auto_init = $true; default_branch = 'main' }
}

$protectionsCommand = "wget -qO- --header 'Authorization: token $token' 'http://127.0.0.1:3000/api/v1/repos/$Organization/$Repository/branch_protections'"
$protectionsJson = (& kubectl @kubectlArgs -n $GiteaNamespace exec -c gitea $giteaPod -- sh -ec $protectionsCommand 2>$null)
if ($LASTEXITCODE -ne 0) { throw 'Unable to list Gitea branch protections' }
$protections = @()
if ($protectionsJson) { $protections = @($protectionsJson | ConvertFrom-Json) }
$mainProtection = $protections | Where-Object { $_.branch_name -eq 'main' } | Select-Object -First 1
$protectionPayload = @{
  branch_name = 'main'; enable_push = $false; enable_push_whitelist = $false;
  enable_merge_whitelist = $false; enable_status_check = $false; required_approvals = 1;
  block_on_rejected_reviews = $true; dismiss_stale_approvals = $true;
  require_signed_commits = $true
}
if (-not $mainProtection) {
  Invoke-GiteaPost "/api/v1/repos/$Organization/$Repository/branch_protections" $protectionPayload
} else {
  # Gitea addresses an existing rule by branch rule name, not an internal id.
  Invoke-GiteaRequest 'PATCH' "/api/v1/repos/$Organization/$Repository/branch_protections/main" $protectionPayload
}

$hookTarget = 'http://opensphere-console-backend.opensphere-console.svc.cluster.local:8080/api/platform/gitea/webhook'
$hooksCommand = "wget -qO- --header 'Authorization: token $token' 'http://127.0.0.1:3000/api/v1/repos/$Organization/$Repository/hooks'"
$hooksJson = (& kubectl @kubectlArgs -n $GiteaNamespace exec -c gitea $giteaPod -- sh -ec $hooksCommand 2>$null)
if ($LASTEXITCODE -ne 0) { throw 'Unable to list Gitea repository webhooks' }
$hooks = @()
if ($hooksJson) { $hooks = @($hooksJson | ConvertFrom-Json) }
if (-not ($hooks | Where-Object { $_.config.url -eq $hookTarget })) {
  Invoke-GiteaPost "/api/v1/repos/$Organization/$Repository/hooks" @{ type = 'gitea'; active = $true; events = @('pull_request'); config = @{ url = $hookTarget; content_type = 'json'; secret = $webhookSecret } }
}

Write-Host "Gitea Platform Control bootstrap ready: $Organization/$Repository (private)"
Write-Host "The Console backend Secret '$SecretName' contains only server-side token material."
