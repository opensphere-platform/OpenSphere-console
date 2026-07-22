param(
  [ValidateSet('Prepare', 'Restore', 'Verify')]
  [string]$Phase = 'Prepare',
  [string]$SourceNamespace = 'opensphere-console-change',
  [string]$TargetNamespace = 'opensphere-console-recovery',
  [string]$SourceRuntimeSecretName = 'opensphere-gitea-runtime',
  [string]$SourceSigningSecretName = 'opensphere-gitea-signing',
  [string]$SourceGiteaSelector = 'app=opensphere-gitea',
  [string]$BackupDirectory = '',
  [string]$GiteaImage = 'opensphere-console-gitea:platform-control-v2',
  [string]$KubeContext = ''
)

# Non-destructive Gitea namespace migration helper.  It prepares a parallel
# Change Authority and never changes Console consumers or deletes the source.
# A separate, approved release step performs those irreversible transitions.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Join-Path $here 'bootstrap\gitea.yaml'
$kubectlArgs = @()
if ($KubeContext) { $kubectlArgs += @('--context', $KubeContext) }

function Invoke-Kubectl([string[]]$Arguments, [string]$InputText = '') {
  if ($InputText) { $InputText | & kubectl @kubectlArgs @Arguments }
  else { & kubectl @kubectlArgs @Arguments }
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
}

function Get-Pod([string]$Namespace, [string]$Selector) {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $pod = [string](& kubectl @kubectlArgs -n $Namespace get pod -l $Selector -o "jsonpath={.items[0].metadata.name}")
    if ($pod) { return $pod }
    Start-Sleep -Seconds 2
  }
  throw "No pod for selector $Selector in namespace $Namespace"
}

function Wait-ForPodRunning([string]$Namespace, [string]$Pod) {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $phase = [string](& kubectl @kubectlArgs -n $Namespace get pod $Pod -o "jsonpath={.status.phase}")
    if ($phase -eq 'Running') { return }
    if ($phase -in @('Failed', 'Succeeded')) { throw "Pod $Namespace/$Pod ended before archive transfer: $phase" }
    Start-Sleep -Seconds 2
  }
  throw "Timed out waiting for $Namespace/$Pod to reach Running"
}

function New-RandomSafePassword([int]$Length) {
  $alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  $buffer = New-Object byte[] $Length
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  $chars = New-Object char[] $Length
  for ($i = 0; $i -lt $Length; $i++) { $chars[$i] = $alphabet[$buffer[$i] % $alphabet.Length] }
  return -join $chars
}

function Get-PostgresScalar([string]$Namespace, [string]$Pod, [string]$ShellPsql, [string]$Sql) {
  $value = $Sql | & kubectl @kubectlArgs -n $Namespace exec -i $Pod -- sh -ec $ShellPsql
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL query failed in $Namespace" }
  $text = ([string]($value -join [Environment]::NewLine)).Trim()
  if (-not $text) { throw "PostgreSQL query returned no scalar value in $Namespace" }
  return $text
}

function New-TargetRuntimeSecret {
  $sourceSecretJson = & kubectl @kubectlArgs -n $SourceNamespace get secret $SourceRuntimeSecretName -o json
  if ($LASTEXITCODE -ne 0) { throw "Missing source runtime secret $SourceNamespace/$SourceRuntimeSecretName" }
  $sourceSecret = $sourceSecretJson | ConvertFrom-Json
  foreach ($name in @('db-password', 'admin-user', 'admin-password', 'postgres-password')) {
    if (-not $sourceSecret.data.PSObject.Properties[$name]) { throw "Source Gitea secret lacks $name" }
  }
  $secret = @{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = @{ name = 'opensphere-gitea-runtime'; namespace = $TargetNamespace; labels = @{ 'opensphere.io/secret-scope' = 'gitea-runtime-only' } }
    type = 'Opaque'
    data = @{
      'db-password' = $sourceSecret.data.'db-password'
      'admin-user' = $sourceSecret.data.'admin-user'
      'admin-password' = $sourceSecret.data.'admin-password'
      'postgres-password' = $sourceSecret.data.'postgres-password'
    }
  } | ConvertTo-Json -Depth 20 -Compress
  Invoke-Kubectl @('apply', '-f', '-') $secret
}

function Copy-PrivateGiteaConfig {
  $sourceGitea = Get-Pod $SourceNamespace $SourceGiteaSelector
  # app.ini contains Gitea cryptographic material needed to decrypt the
  # restored database.  It stays in process memory and is written only to a
  # namespaced Kubernetes Secret; it is never logged or committed.
  $sourceIni = & kubectl @kubectlArgs -n $SourceNamespace exec $sourceGitea -- sh -ec 'cat /etc/gitea/app.ini'
  if ($LASTEXITCODE -ne 0 -or -not $sourceIni) { throw 'Unable to read source Gitea private configuration' }
  $iniText = $sourceIni -join [Environment]::NewLine
  $config = @{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = @{ name = 'opensphere-gitea-config'; namespace = $TargetNamespace; labels = @{ 'opensphere.io/secret-scope' = 'gitea-config-only' } }
    type = 'Opaque'
    data = @{ 'app.ini' = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($iniText)) }
  } | ConvertTo-Json -Depth 20 -Compress
  Invoke-Kubectl @('apply', '-f', '-') $config
}

function Copy-PrivateGiteaSigningKey {
  # The Gitea server signing key is required to preserve verification of
  # existing controlled history after a recovery namespace transition. It is
  # copied Secret-to-Secret and never logged, written to Git, or exposed to a
  # Console workload.
  $sourceSecretJson = & kubectl @kubectlArgs -n $SourceNamespace get secret $SourceSigningSecretName -o json
  if ($LASTEXITCODE -ne 0) { throw "Missing source Gitea signing Secret $SourceNamespace/$SourceSigningSecretName" }
  $sourceSecret = $sourceSecretJson | ConvertFrom-Json
  foreach ($name in @('gitea-signing-key', 'gitea-signing-key.pub')) {
    if (-not $sourceSecret.data.PSObject.Properties[$name]) { throw "Source Gitea signing Secret lacks $name" }
  }
  $secret = @{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = @{ name = 'opensphere-gitea-signing'; namespace = $TargetNamespace; labels = @{ 'opensphere.io/secret-scope' = 'gitea-server-signing-only' } }
    type = 'Opaque'
    data = @{
      'gitea-signing-key' = $sourceSecret.data.'gitea-signing-key'
      'gitea-signing-key.pub' = $sourceSecret.data.'gitea-signing-key.pub'
    }
  } | ConvertTo-Json -Depth 20 -Compress
  Invoke-Kubectl @('apply', '-f', '-') $secret
}

if ($SourceNamespace -eq $TargetNamespace) { throw 'SourceNamespace and TargetNamespace must differ' }
if (-not (Test-Path -LiteralPath $manifest)) { throw "Missing manifest: $manifest" }

switch ($Phase) {
  'Prepare' {
    $namespaceManifest = @"
apiVersion: v1
kind: Namespace
metadata:
  name: $TargetNamespace
  labels:
    opensphere.io/layer: console-change
    opensphere.io/change-authority: gitea
"@
    Invoke-Kubectl @('apply', '-f', '-') $namespaceManifest
    New-TargetRuntimeSecret
    Copy-PrivateGiteaConfig
    Copy-PrivateGiteaSigningKey
    $renderedManifest = (Get-Content -Raw -LiteralPath $manifest).
      Replace('opensphere-console-change', $TargetNamespace).
      Replace('__OPENSPHERE_GITEA_IMAGE__', $GiteaImage)
    Invoke-Kubectl @('apply', '-f', '-') $renderedManifest
    Invoke-Kubectl @('-n', $TargetNamespace, 'rollout', 'status', 'deployment/opensphere-gitea-postgres', '--timeout=10m')
    Write-Host "Prepared parallel Gitea Change Authority: $TargetNamespace"
  }
  'Restore' {
    if (-not $BackupDirectory) { throw 'BackupDirectory is required for Restore' }
    $archive = Join-Path $BackupDirectory 'gitea.tar.gz'
    if (-not (Test-Path -LiteralPath $archive)) { throw "Missing Gitea archive: $archive" }
    $sourcePostgres = Get-Pod $SourceNamespace 'app=opensphere-gitea-postgres'
    $repositoryCount = Get-PostgresScalar $SourceNamespace $sourcePostgres 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U postgres -d gitea -At -v ON_ERROR_STOP=1' 'SELECT count(*) FROM repository;'
    if ($repositoryCount -ne '0') {
      throw "Source Gitea has $repositoryCount repositories. Restore repository and LFS data before this metadata-only migration."
    }
    $giteaReplicas = [string](& kubectl @kubectlArgs -n $TargetNamespace get deployment opensphere-gitea -o "jsonpath={.spec.replicas}")
    if ($giteaReplicas -and $giteaReplicas -ne '0') { throw 'Target Gitea must be scaled to zero before restore' }

    $archiveSecretName = 'opensphere-gitea-restore-archive'
    $archiveSecret = @{
      apiVersion = 'v1'
      kind = 'Secret'
      metadata = @{ name = $archiveSecretName; namespace = $TargetNamespace; labels = @{ 'opensphere.io/secret-scope' = 'one-time-gitea-restore' } }
      type = 'Opaque'
      data = @{ 'gitea.tar.gz' = [Convert]::ToBase64String([IO.File]::ReadAllBytes($archive)) }
    } | ConvertTo-Json -Depth 20 -Compress
    Invoke-Kubectl @('-n', $TargetNamespace, 'delete', 'secret', $archiveSecretName, '--ignore-not-found=true')
    Invoke-Kubectl @('apply', '-f', '-') $archiveSecret
    $jobName = "opensphere-gitea-restore-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))"
    $restoreJob = @"
apiVersion: batch/v1
kind: Job
metadata:
  name: $jobName
  namespace: $TargetNamespace
  labels: { app: opensphere-gitea, opensphere.io/operation: restore }
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 86400
  template:
    metadata: { labels: { app: opensphere-gitea, opensphere.io/operation: restore } }
    spec:
      restartPolicy: Never
      serviceAccountName: opensphere-gitea
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: restore
          image: postgres:17-alpine
          imagePullPolicy: IfNotPresent
          command: [sh, -ec]
          args:
            - |
              set -eu
              test -s /backup/gitea.tar.gz
              if find /var/lib/gitea -mindepth 1 -print -quit | grep -q .; then
                echo 'target Gitea data PVC is not empty; refusing overlay restore' >&2
                exit 1
              fi
              mkdir -p /tmp/gitea-restore
              tar -xzf /backup/gitea.tar.gz -C /tmp/gitea-restore
              test -f /tmp/gitea-restore/gitea-db.sql
              test -d /tmp/gitea-restore/data
              cp -a /tmp/gitea-restore/data/. /var/lib/gitea/
              PGPASSWORD="`$GITEA_DB_PASSWORD" psql -h opensphere-gitea-postgres -U gitea -d gitea -v ON_ERROR_STOP=1 -f /tmp/gitea-restore/gitea-db.sql
          env:
            - name: GITEA_DB_PASSWORD
              valueFrom: { secretKeyRef: { name: opensphere-gitea-runtime, key: db-password } }
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
          volumeMounts:
            - { name: data, mountPath: /var/lib/gitea }
            - { name: backup, mountPath: /backup }
      volumes:
        - { name: data, persistentVolumeClaim: { claimName: opensphere-gitea-data } }
        - { name: backup, secret: { secretName: $archiveSecretName, defaultMode: 256 } }
"@
    try {
      Invoke-Kubectl @('apply', '-f', '-') $restoreJob
      Invoke-Kubectl @('-n', $TargetNamespace, 'wait', '--for=condition=complete', "job/$jobName", '--timeout=10m')
    }
    finally { Invoke-Kubectl @('-n', $TargetNamespace, 'delete', 'secret', $archiveSecretName, '--ignore-not-found=true') }
    Invoke-Kubectl @('-n', $TargetNamespace, 'scale', 'deployment/opensphere-gitea', '--replicas=1')
    Invoke-Kubectl @('-n', $TargetNamespace, 'rollout', 'status', 'deployment/opensphere-gitea', '--timeout=10m')
    Write-Host "Restored Gitea into $TargetNamespace. Source remains online."
  }
  'Verify' {
    $sourcePostgres = Get-Pod $SourceNamespace 'app=opensphere-gitea-postgres'
    $targetPostgres = Get-Pod $TargetNamespace 'app=opensphere-gitea-postgres'
    $checks = @(
      @{ label = 'users'; sql = 'SELECT count(*) FROM "user";' },
      @{ label = 'repositories'; sql = 'SELECT count(*) FROM repository;' },
      @{ label = 'issues'; sql = 'SELECT count(*) FROM issue;' }
    )
    foreach ($check in $checks) {
      $sourceValue = Get-PostgresScalar $SourceNamespace $sourcePostgres 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U postgres -d gitea -At -v ON_ERROR_STOP=1' $check['sql']
      $targetValue = Get-PostgresScalar $TargetNamespace $targetPostgres 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U postgres -d gitea -At -v ON_ERROR_STOP=1' $check['sql']
      if ($sourceValue -ne $targetValue) { throw "Verification mismatch Gitea $($check['label']): source=$sourceValue target=$targetValue" }
      Write-Host "Gitea $($check['label']): $sourceValue (matched)"
    }
    $ready = [string](& kubectl @kubectlArgs -n $TargetNamespace get deployment opensphere-gitea -o "jsonpath={.status.readyReplicas}")
    if ($ready -ne '1') { throw "Target Gitea is not Ready: readyReplicas=$ready" }
    Write-Host 'Parallel Gitea restore verification passed. No Console consumer was changed.'
  }
}
