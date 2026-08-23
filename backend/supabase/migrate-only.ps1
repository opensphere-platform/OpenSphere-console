param(
  [string]$Namespace = 'opensphere-console-data',
  [string]$KubeContext = '',
  [Parameter(Mandatory = $true)][string]$SourceRevision
)

$ErrorActionPreference = 'Stop'
if ($SourceRevision -notmatch '^[a-f0-9]{40}$') { throw 'SourceRevision must be an immutable 40-character commit SHA' }
if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { throw 'kubectl is required' }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$migrationDirectory = Join-Path $here 'migrations'
$manifestPath = Join-Path $migrationDirectory 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Canonical migration manifest is required' }

function Get-TextSha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Value)))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Get-CanonicalSha256([string]$Path) { return Get-TextSha256 ([IO.File]::ReadAllText($Path).Replace("`r`n", "`n")) }
function New-RandomSafePassword([int]$Length) {
  $alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  $buffer = New-Object byte[] $Length
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  $chars = New-Object char[] $Length
  for ($i = 0; $i -lt $Length; $i++) { $chars[$i] = $alphabet[$buffer[$i] % $alphabet.Length] }
  return -join $chars
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$migrations = @(Get-ChildItem -LiteralPath $migrationDirectory -Filter '*.sql' -File | Sort-Object Name)
$names = @($migrations | ForEach-Object { $_.Name })
$manifestNames = @($manifest.migrations | ForEach-Object { [string]$_.name })
if ($manifest.schemaVersion -ne 2 -or $manifest.migrationCount -ne $migrations.Count -or
    ($names -join "`n") -ne ($manifestNames -join "`n")) { throw 'Migration manifest inventory mismatch' }
$setRows = @()
$predecessorMigrationId = $null
foreach ($entry in $manifest.migrations) {
  if ([string]$entry.id -ne ([string]$entry.name).Substring(0,4) -or
      [string]$entry.path -ne "backend/supabase/migrations/$($entry.name)" -or
      [string]$entry.predecessorMigrationId -ne [string]$predecessorMigrationId) { throw "Invalid manifest lineage $($entry.name)" }
  $actual = Get-CanonicalSha256 (Join-Path $migrationDirectory ([string]$entry.name))
  if ($actual -ne [string]$entry.sha256) { throw "Migration digest mismatch: $($entry.name)" }
  $lineagePredecessor = '-'
  if ($null -ne $predecessorMigrationId) { $lineagePredecessor = [string]$predecessorMigrationId }
  $setRows += "$($entry.id)`n$lineagePredecessor`n$($entry.name)`n$($entry.sha256)"
  $predecessorMigrationId = [string]$entry.id
}
if ([string]$manifest.setDigest -ne ('sha256:' + (Get-TextSha256 ($setRows -join "`n"))) -or
    [string]$manifest.latestMigrationId -ne [string]$manifest.migrations[-1].id) { throw 'Migration manifest set digest mismatch' }

$kubectlArgs = @()
if ($KubeContext) { $kubectlArgs += @('--context', $KubeContext) }
function Invoke-Kubectl([string[]]$Arguments, [string]$InputText = '') {
  if ($InputText) { $InputText | & kubectl @kubectlArgs @Arguments } else { & kubectl @kubectlArgs @Arguments }
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
}

# The release executor embedded before OSAA Dialogue State v1.2 still checks
# the retired Gateway maintenance keys as globally required. Supply unusable
# sentinel values only while the installed legacy Gateway manifest references
# those optional keys. This is a compatibility fence, not a database login;
# the full installer removes it after the new Gateway manifest is active.
$legacyGatewayNeedsMaintenanceSentinel = $false
$legacyGatewayJson = (& kubectl @kubectlArgs -n opensphere-console get deployment opensphere-console-osaa-gateway -o json 2>$null)
if ($LASTEXITCODE -eq 0 -and $legacyGatewayJson) {
  $legacyGateway = $legacyGatewayJson | ConvertFrom-Json
  foreach ($container in @($legacyGateway.spec.template.spec.containers)) {
    foreach ($environment in @($container.env)) {
      $reference = $environment.valueFrom.secretKeyRef
      if ($reference.name -eq 'opensphere-osaa-runtime' -and
          $reference.key -in @('maintenance-pg-user', 'maintenance-pg-password')) {
        $legacyGatewayNeedsMaintenanceSentinel = $true
      }
    }
  }
}
if ($legacyGatewayNeedsMaintenanceSentinel) {
  $sentinelPatch = @{ stringData = @{
    'maintenance-pg-user' = 'opensphere_osaa_disabled'
    'maintenance-pg-password' = 'disabled-transition-only'
  } } | ConvertTo-Json -Compress
  Invoke-Kubectl @('-n','opensphere-console','patch','secret','opensphere-osaa-runtime','--type=merge','-p',$sentinelPatch)
}

# Component-scoped migrations may introduce RPC grants for Shell roles. Ensure
# those LOGIN roles and their one-role-only workload Secrets exist before SQL is
# evaluated; no owner/JWT/service-role credential is mirrored.
$shellRoleSecrets = @(
  @{ Role = 'opensphere_shell_api'; Key = 'shell-api-password'; Name = 'opensphere-shell-api-db'; Scope = 'shell-api-only' },
  @{ Role = 'opensphere_shell_gateway'; Key = 'shell-gateway-password'; Name = 'opensphere-shell-gateway-db'; Scope = 'shell-gateway-only' },
  @{ Role = 'opensphere_shell_reconciler'; Key = 'shell-reconciler-password'; Name = 'opensphere-shell-reconciler-db'; Scope = 'shell-reconciler-only' }
)
$shellControlKeys = @('shell-admission-secret','shell-delegation-secret')
foreach ($key in $shellControlKeys) {
  $encoded = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.$key}")
  if (-not $encoded) {
    $patch = @{ stringData = @{ $key = (New-RandomSafePassword 48) } } | ConvertTo-Json -Compress
    Invoke-Kubectl @('-n',$Namespace,'patch','secret','opensphere-supabase-secrets','--type=merge','-p',$patch)
  }
}
foreach ($shellRole in $shellRoleSecrets) {
  $encoded = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.$($shellRole.Key)}")
  if ($LASTEXITCODE -ne 0) { throw 'opensphere-supabase-secrets is required before component-scoped migration' }
  if (-not $encoded) {
    $patch = @{ stringData = @{ $shellRole.Key = (New-RandomSafePassword 36) } } | ConvertTo-Json -Compress
    Invoke-Kubectl @('-n',$Namespace,'patch','secret','opensphere-supabase-secrets','--type=merge','-p',$patch)
    $encoded = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.$($shellRole.Key)}")
  }
  if (-not $encoded) { throw "Shell database credential was not provisioned: $($shellRole.Key)" }
  $shellRole.PasswordB64 = $encoded
  $shellSecret = @"
apiVersion: v1
kind: Secret
metadata:
  name: $($shellRole.Name)
  namespace: opensphere-console
  labels:
    opensphere.io/secret-scope: $($shellRole.Scope)
    opensphere.io/authority: cbss
type: Opaque
data:
  password: $encoded
stringData:
  provider: postgres
  host: opensphere-supabase-postgres.$Namespace.svc.cluster.local
  port: "5432"
  database: postgres
  username: $($shellRole.Role)
  sslmode: prefer
"@
  Invoke-Kubectl @('apply','-f','-') $shellSecret
}
$shellAdmissionSecretB64 = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o 'jsonpath={.data.shell-admission-secret}')
$shellDelegationSecretB64 = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o 'jsonpath={.data.shell-delegation-secret}')
$shellControlRuntimeSecret = @"
apiVersion: v1
kind: Secret
metadata:
  name: opensphere-shell-control-runtime
  namespace: opensphere-console
  labels: { opensphere.io/secret-scope: shell-control-only, opensphere.io/authority: cbss }
type: Opaque
data:
  admission-secret: $shellAdmissionSecretB64
  delegation-secret: $shellDelegationSecretB64
"@
Invoke-Kubectl @('apply','-f','-') $shellControlRuntimeSecret

Invoke-Kubectl @('-n', $Namespace, 'get', 'statefulset/opensphere-supabase-postgres')
$pod = (& kubectl @kubectlArgs -n $Namespace get pod -l app=opensphere-supabase-postgres -o 'jsonpath={.items[0].metadata.name}')
if ($LASTEXITCODE -ne 0 -or -not $pod) { throw 'Supabase PostgreSQL pod not found' }
function Invoke-MigrationSql([string]$Sql) {
  Invoke-Kubectl @('-n',$Namespace,'exec','-i',$pod,'--','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1') $Sql
}

$shellRoleSql = @()
foreach ($shellRole in $shellRoleSecrets) {
  $password = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$shellRole.PasswordB64)).Replace("'", "''")
  $shellRoleSql += @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$($shellRole.Role)') THEN
    CREATE ROLE $($shellRole.Role) LOGIN PASSWORD '$password'
      NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE $($shellRole.Role) LOGIN PASSWORD '$password'
      NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
`$`$;
"@
}
Invoke-MigrationSql ($shellRoleSql -join "`n")

function Get-LedgerDigest([string]$Id) {
  if ($Id -notmatch '^[0-9]{4}_[a-z0-9_]+$') { throw "Invalid migration id $Id" }
  $rows = @(Invoke-Kubectl @('-n',$Namespace,'exec','-i',$pod,'--','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -U supabase_admin -d postgres -tA -v ON_ERROR_STOP=1') "SELECT COALESCE((SELECT sha256 FROM console.schema_migration WHERE migration_id='$Id'),'');")
  return (($rows | ForEach-Object { $_.Trim() } | Where-Object { $_ }) | Select-Object -Last 1)
}

$applied = 0
foreach ($migration in $migrations) {
  $id = [IO.Path]::GetFileNameWithoutExtension($migration.Name)
  $digest = Get-CanonicalSha256 $migration.FullName
  $recorded = Get-LedgerDigest $id
  if ($recorded -and $recorded -ne $digest) { throw "Migration checksum drift for ${id}: live=$recorded canonical=$digest" }
  if ($recorded) { continue }
  Invoke-MigrationSql (Get-Content -Raw -LiteralPath $migration.FullName)
  Invoke-MigrationSql "INSERT INTO console.schema_migration(migration_id,sha256,source_revision,executor) VALUES('$id','$digest','$SourceRevision',current_user) ON CONFLICT(migration_id) DO NOTHING;"
  if ((Get-LedgerDigest $id) -ne $digest) { throw "Migration ledger did not attest $id" }
  $applied += 1
}
if ($applied -gt 0) { Invoke-MigrationSql "NOTIFY pgrst, 'reload schema';" }
Write-Host "Supabase component-scoped migration complete; applied=$applied set=$($manifest.setDigest)"
