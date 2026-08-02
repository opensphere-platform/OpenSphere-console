[CmdletBinding()]
param(
  [string]$GiteaNamespace = 'opensphere-console-change',
  [string]$ArgoNamespace = 'argocd',
  [string]$RepositoryUrl = 'http://opensphere-gitea.opensphere-console-change.svc.cluster.local:3000/opensphere/platform-declarations.git',
  [string]$ServiceAccount = 'opensphere-control',
  [string]$SecretName = 'opensphere-platform-declarations-repository',
  [string]$KubeContext = ''
)

# Argo CD needs its own read-only credential for the one governed repository.
# Never copy the Console control token (which can create reviewed proposals),
# and never print the generated token on the host or in a Kubernetes event.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $false

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { throw 'kubectl is required' }
if ($RepositoryUrl -notmatch '^http://opensphere-gitea\.opensphere-console-change\.svc\.cluster\.local:3000/opensphere/platform-declarations\.git$') {
  throw 'RepositoryUrl must be the canonical in-cluster OpenSphere declarations repository'
}
if ($ServiceAccount -notmatch '^[a-z][a-z0-9-]{1,62}$' -or $SecretName -notmatch '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$') {
  throw 'invalid service account or Secret name'
}

$kubectlArgs = @()
if ($KubeContext) { $kubectlArgs += @('--context', $KubeContext) }
function Invoke-Kubectl([string[]]$Arguments, [string]$InputText = '') {
  if ($InputText) { $InputText | & kubectl @kubectlArgs @Arguments }
  else { & kubectl @kubectlArgs @Arguments }
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
}

$existing = (& kubectl @kubectlArgs -n $ArgoNamespace get secret $SecretName --ignore-not-found -o json 2>$null)
if ($LASTEXITCODE -eq 0 -and $existing) {
  $parsed = $existing | ConvertFrom-Json
  $kind = [string]$parsed.metadata.labels.'argocd.argoproj.io/secret-type'
  if ($kind -ne 'repository') { throw "Existing $ArgoNamespace/$SecretName is not an Argo CD repository Secret" }
  Write-Host "Argo CD repository credential already exists: $ArgoNamespace/$SecretName"
  exit 0
}

$giteaPod = (& kubectl @kubectlArgs -n $GiteaNamespace get pod -l app=opensphere-gitea -o 'jsonpath={.items[0].metadata.name}')
if (-not $giteaPod) { throw "Gitea pod not found in $GiteaNamespace" }
$tokenName = "argocd-readonly-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
$token = (& kubectl @kubectlArgs -n $GiteaNamespace exec -c gitea $giteaPod -- gitea --config /etc/gitea/app.ini admin user generate-access-token --username $ServiceAccount --token-name $tokenName --scopes 'read:repository' --raw 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or -not $token) { throw 'Unable to generate the Argo CD read-only repository token' }

try {
  $secret = @{
    apiVersion = 'v1'; kind = 'Secret'
    metadata = @{
      name = $SecretName; namespace = $ArgoNamespace
      labels = @{ 'argocd.argoproj.io/secret-type' = 'repository'; 'opensphere.io/secret-scope' = 'argocd-readonly-repository' }
    }
    type = 'Opaque'
    stringData = @{ type = 'git'; url = $RepositoryUrl; username = $ServiceAccount; password = $token }
  } | ConvertTo-Json -Depth 8 -Compress
  Invoke-Kubectl @('apply', '-f', '-') $secret
} finally {
  Remove-Variable token -ErrorAction SilentlyContinue
}

$verified = (& kubectl @kubectlArgs -n $ArgoNamespace get secret $SecretName -o json | ConvertFrom-Json)
if ([string]$verified.metadata.labels.'argocd.argoproj.io/secret-type' -ne 'repository' -or -not $verified.data.password) {
  throw 'Argo CD repository credential verification failed'
}
Write-Host "Argo CD read-only repository credential configured: $ArgoNamespace/$SecretName"
