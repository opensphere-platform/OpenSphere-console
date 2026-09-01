param(
  [Parameter(Mandatory = $true)]
  [string]$ConsoleApiImage,
  [string]$KubeContext = ''
)

$ErrorActionPreference = 'Stop'
$DataNamespace = 'opensphere-console-data'
$RuntimeNamespace = 'opensphere-console'
$roleName = 'opensphere_console_api_runtime'
$authorityRole = 'console_api'
$secretName = 'opensphere-console-api-runtime'
$secretKey = 'database-url'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repositoryRoot 'migrations\manifest.json'
$deploymentPath = Join-Path $repositoryRoot 'apps\console-api\deploy.yaml'

if ($ConsoleApiImage -notmatch '^ghcr[.]io/opensphere-platform/opensphere-console-api@sha256:[a-f0-9]{64}$') {
  throw 'ConsoleApiImage must be the exact official C_API GHCR digest'
}
if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { throw 'kubectl is required' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node is required' }
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing fresh migration manifest: $manifestPath" }
if (-not (Test-Path -LiteralPath $deploymentPath)) { throw "Missing C_API deployment manifest: $deploymentPath" }

$migrationManifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($migrationManifest.schemaVersion -ne 1 -or
    [string]$migrationManifest.latestGlobalId -notmatch '^opensphere-console/[0-9]{8}/[0-9]{4}$' -or
    [string]$migrationManifest.setDigest -notmatch '^sha256:[a-f0-9]{64}$' -or
    [int]$migrationManifest.migrationCount -ne 1) {
  throw 'Fresh migration manifest identity is invalid'
}

$kubectlArgs = @()
if ($KubeContext) { $kubectlArgs += @('--context', $KubeContext) }

function Invoke-Kubectl([string[]]$Arguments, [string]$InputText = '') {
  if ($InputText) { $output = $InputText | & kubectl @kubectlArgs @Arguments }
  else { $output = & kubectl @kubectlArgs @Arguments }
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
  return @($output)
}

$runtimeNamespaceObject = Invoke-Kubectl @('get', 'namespace', $RuntimeNamespace, '-o', 'name')
if (($runtimeNamespaceObject -join '').Trim() -ne "namespace/$RuntimeNamespace") {
  throw "Runtime namespace is unavailable: $RuntimeNamespace"
}
$dataNamespaceObject = Invoke-Kubectl @('get', 'namespace', $DataNamespace, '-o', 'name')
if (($dataNamespaceObject -join '').Trim() -ne "namespace/$DataNamespace") {
  throw "Data namespace is unavailable: $DataNamespace"
}
foreach ($secretRef in @(
  @{ Namespace = $DataNamespace; Name = 'opensphere-supabase-secrets' },
  @{ Namespace = $RuntimeNamespace; Name = 'opensphere-ghcr-pull' }
)) {
  $secretObject = Invoke-Kubectl @('-n', $secretRef.Namespace, 'get', 'secret', $secretRef.Name, '-o', 'name')
  if (($secretObject -join '').Trim() -ne "secret/$($secretRef.Name)") {
    throw "Required install input Secret is unavailable: $($secretRef.Namespace)/$($secretRef.Name)"
  }
}

$dataWorkloads = @(
  @{ Resource = 'statefulset/opensphere-supabase-postgres'; Artifact = 'opensphere-console-supabase-postgres' },
  @{ Resource = 'deployment/opensphere-supabase-auth'; Artifact = 'opensphere-console-supabase-auth' },
  @{ Resource = 'deployment/opensphere-supabase-rest'; Artifact = 'opensphere-console-supabase-rest' },
  @{ Resource = 'deployment/opensphere-supabase-storage'; Artifact = 'opensphere-console-supabase-storage' }
)
foreach ($workload in $dataWorkloads) {
  $image = ((Invoke-Kubectl @('-n', $DataNamespace, 'get', $workload.Resource, '-o', 'jsonpath={.spec.template.spec.containers[0].image}')) -join '').Trim()
  $expectedImage = '^ghcr[.]io/opensphere-platform/' + [regex]::Escape($workload.Artifact) + '@sha256:[a-f0-9]{64}$'
  if ($image -notmatch $expectedImage) {
    throw "Supabase workload is not an exact official target image: $($workload.Resource)"
  }
}

$postgresPods = (Invoke-Kubectl @('-n', $DataNamespace, 'get', 'pod', '-l', 'app=opensphere-supabase-postgres', '-o', 'json') | Out-String) | ConvertFrom-Json
$readyPods = @($postgresPods.items | Where-Object {
  $_.status.phase -eq 'Running' -and
  @($_.status.conditions | Where-Object { $_.type -eq 'Ready' -and $_.status -eq 'True' }).Count -eq 1
})
if ($readyPods.Count -ne 1) { throw "Expected exactly one Ready Supabase PostgreSQL pod in $DataNamespace" }
$postgresPod = [string]$readyPods[0].metadata.name

function Invoke-OwnerSql([string]$Sql) {
  $command = 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -h 127.0.0.1 -U supabase_admin -d postgres -tA -v ON_ERROR_STOP=1'
  return @((Invoke-Kubectl @('-n', $DataNamespace, 'exec', '-i', $postgresPod, '--', 'sh', '-ec', $command) $Sql) |
    ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
}

function Invoke-OwnerMigrationSql([string]$Sql) {
  $command = 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction'
  Invoke-Kubectl @('-n', $DataNamespace, 'exec', '-i', $postgresPod, '--', 'sh', '-ec', $command) $Sql | Out-Null
}

$ledgerExists = Invoke-OwnerSql "SELECT CASE WHEN to_regclass('console_migration.applied_migration') IS NULL THEN 'absent' ELSE 'present' END;"
if ($ledgerExists.Count -ne 1 -or $ledgerExists[0] -notin @('absent', 'present')) {
  throw 'Unable to establish fresh migration ledger state'
}
$migrationStatus = 'existing'
if ($ledgerExists[0] -eq 'absent') {
  $migrationTool = Join-Path $PSScriptRoot 'console-migrations.mjs'
  $migrationSql = (& node $migrationTool render ([string]$migrationManifest.latestGlobalId) | Out-String)
  if ($LASTEXITCODE -ne 0 -or -not $migrationSql.Trim()) { throw 'Fresh migration renderer failed' }
  Invoke-OwnerMigrationSql $migrationSql
  $migrationSql = $null
  $migrationStatus = 'applied'
}

$expectedLedger = "$($migrationManifest.migrationCount)|$($migrationManifest.latestGlobalId)|$($migrationManifest.setDigest)"
$ledgerSql = @"
SELECT count(*)::text || '|' ||
       COALESCE((SELECT global_id FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1), '') || '|' ||
       COALESCE((SELECT migration_set_digest FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1), '')
FROM console_migration.applied_migration;
"@
$ledger = Invoke-OwnerSql $ledgerSql
if ($ledger.Count -ne 1 -or $ledger[0] -ne $expectedLedger) {
  throw 'Console API runtime provisioning requires the exact fresh migration prefix'
}
$authorityState = Invoke-OwnerSql "SELECT rolname||'|'||rolcanlogin::text||'|'||rolsuper::text||'|'||rolcreaterole::text||'|'||rolcreatedb::text||'|'||rolreplication::text||'|'||rolbypassrls::text FROM pg_roles WHERE rolname='$authorityRole';"
if ($authorityState.Count -ne 1 -or $authorityState[0] -ne "$authorityRole|false|false|false|false|false|false") {
  throw 'Fresh console_api authority role attributes differ from the closed baseline'
}

$roleState = Invoke-OwnerSql "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$roleName') THEN 'present' ELSE 'absent' END;"
if ($roleState.Count -ne 1 -or $roleState[0] -notin @('present', 'absent')) { throw 'Unable to establish runtime role state' }
$secretJson = (Invoke-Kubectl @('-n', $RuntimeNamespace, 'get', 'secret', $secretName, '--ignore-not-found', '-o', 'json') | Out-String).Trim()
$secretPresent = [bool]$secretJson

function Get-RuntimePasswordFromSecret([string]$Json) {
  $secret = $Json | ConvertFrom-Json
  $property = $secret.data.PSObject.Properties[$secretKey]
  if (-not $property) { throw "Runtime Secret is missing $secretKey" }
  $databaseUrl = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$property.Value))
  $uri = [Uri]$databaseUrl
  $expectedHost = "opensphere-supabase-postgres.$DataNamespace.svc.cluster.local"
  if ($uri.Scheme -notin @('postgres', 'postgresql') -or $uri.Host -ne $expectedHost -or
      $uri.AbsolutePath -ne '/postgres' -or $uri.Query -or $uri.Fragment) {
    throw 'Runtime Secret database URL is outside the fixed Supabase authority'
  }
  $userinfo = $uri.UserInfo.Split(':', 2)
  if ($userinfo.Count -ne 2 -or [Uri]::UnescapeDataString($userinfo[0]) -ne $roleName) {
    throw 'Runtime Secret database role differs from the fixed C_API login'
  }
  return [Uri]::UnescapeDataString($userinfo[1])
}

function Test-RuntimeLogin([string]$Password) {
  $command = 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -X -h 127.0.0.1 -U opensphere_console_api_runtime -d postgres -tA -v ON_ERROR_STOP=1 -c "SELECT current_user||''|''||pg_has_role(current_user,''console_api'',''member'')::text;"'
  $result = Invoke-Kubectl @('-n', $DataNamespace, 'exec', '-i', $postgresPod, '--', 'sh', '-ec', $command) ($Password + "`n")
  $line = @($result | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  if ($line.Count -ne 1 -or $line[0] -ne "$roleName|true") {
    throw 'Runtime login does not match the limited console_api membership contract'
  }
}

function Test-RuntimeRoleContract {
  $sql = @"
SELECT child.rolname||'|'||child.rolcanlogin::text||'|'||child.rolinherit::text||'|'||
       child.rolsuper::text||'|'||child.rolcreaterole::text||'|'||child.rolcreatedb::text||'|'||
       child.rolreplication::text||'|'||child.rolbypassrls::text||'|'||child.rolconnlimit::text||'|'||
       COALESCE((SELECT string_agg(parent.rolname, ',' ORDER BY parent.rolname COLLATE "C")
                 FROM pg_auth_members membership
                 JOIN pg_roles parent ON parent.oid=membership.roleid
                 WHERE membership.member=child.oid), '')
FROM pg_roles child WHERE child.rolname='$roleName';
"@
  $result = Invoke-OwnerSql $sql
  if ($result.Count -ne 1 -or $result[0] -ne "$roleName|true|true|false|false|false|false|false|20|$authorityRole") {
    throw 'Runtime role attributes or memberships differ from the closed C_API contract'
  }
}

if (($roleState[0] -eq 'present') -ne $secretPresent) {
  throw 'Console API runtime role and Secret are in a split provisioning state; no implicit repair or rotation was attempted'
}
$runtimeStatus = 'already-provisioned'
if ($secretPresent) {
  Test-RuntimeRoleContract
  Test-RuntimeLogin (Get-RuntimePasswordFromSecret $secretJson)
} else {

$passwordBuffer = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Fill($passwordBuffer)
$alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
$passwordChars = New-Object char[] $passwordBuffer.Length
for ($index = 0; $index -lt $passwordBuffer.Length; $index++) {
  $passwordChars[$index] = $alphabet[$passwordBuffer[$index] % $alphabet.Length]
}
$runtimePassword = -join $passwordChars
$escapedPassword = $runtimePassword.Replace("'", "''")

$createRoleSql = @"
BEGIN;
DO `$role`$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$roleName') THEN
    RAISE EXCEPTION 'runtime role appeared during provisioning';
  END IF;
END
`$role`$;
CREATE ROLE $roleName LOGIN PASSWORD '$escapedPassword'
  NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20;
GRANT $authorityRole TO $roleName;
ALTER ROLE $roleName SET search_path = pg_catalog;
ALTER ROLE $roleName SET statement_timeout = '15s';
ALTER ROLE $roleName SET lock_timeout = '3s';
COMMIT;
"@
Invoke-OwnerSql $createRoleSql | Out-Null

$encodedUser = [Uri]::EscapeDataString($roleName)
$encodedPassword = [Uri]::EscapeDataString($runtimePassword)
$databaseHost = "opensphere-supabase-postgres.$DataNamespace.svc.cluster.local"
$databaseUrl = "postgresql://${encodedUser}:${encodedPassword}@${databaseHost}:5432/postgres"
$secretManifest = @{
  apiVersion = 'v1'
  kind = 'Secret'
  metadata = @{
    name = $secretName
    namespace = $RuntimeNamespace
    labels = @{
      'app.kubernetes.io/part-of' = 'opensphere-console'
      'opensphere.io/secret-scope' = 'console-api-only'
    }
  }
  type = 'Opaque'
  stringData = @{ $secretKey = $databaseUrl }
} | ConvertTo-Json -Depth 8 -Compress

$secretCreated = $false
try {
  Invoke-Kubectl @('create', '-f', '-') $secretManifest | Out-Null
  $secretCreated = $true
  Test-RuntimeRoleContract
  Test-RuntimeLogin $runtimePassword
} catch {
  # The role has no object ownership and only one membership. If Secret creation
  # or verification fails, remove the just-created role so the next run starts
  # from the same closed absent/absent state.
  if ($secretCreated) {
    Invoke-Kubectl @('-n', $RuntimeNamespace, 'delete', 'secret', $secretName, '--wait=true') | Out-Null
  }
  Invoke-OwnerSql "DROP ROLE IF EXISTS $roleName;" | Out-Null
  throw
} finally {
  $runtimePassword = $null
  $escapedPassword = $null
  $encodedPassword = $null
  $databaseUrl = $null
  $secretManifest = $null
  [Array]::Clear($passwordBuffer, 0, $passwordBuffer.Length)
  [Array]::Clear($passwordChars, 0, $passwordChars.Length)
}
$runtimeStatus = 'provisioned'
}

$deploymentTemplate = Get-Content -Raw -LiteralPath $deploymentPath
if ([regex]::Matches($deploymentTemplate, [regex]::Escape('__OPENSPHERE_CONSOLE_API_IMAGE__')).Count -ne 1) {
  throw 'C_API deployment image placeholder contract is invalid'
}
$renderedDeployment = $deploymentTemplate.Replace('__OPENSPHERE_CONSOLE_API_IMAGE__', $ConsoleApiImage)
if ($renderedDeployment -match '__OPENSPHERE_[A-Z0-9_]+__') { throw 'C_API deployment has unresolved placeholders' }
Invoke-Kubectl @('apply', '-f', '-') $renderedDeployment | Out-Null
Invoke-Kubectl @('-n', $RuntimeNamespace, 'rollout', 'status', 'deployment/opensphere-console-api', '--timeout=5m') | Out-Null
$installedImage = ((Invoke-Kubectl @('-n', $RuntimeNamespace, 'get', 'deployment/opensphere-console-api', '-o', 'jsonpath={.spec.template.spec.containers[0].image}')) -join '').Trim()
if ($installedImage -ne $ConsoleApiImage) { throw 'Installed C_API image differs from the requested exact digest' }

Write-Output (@{
  status = 'passed'
  migration = $migrationStatus
  runtimeCredential = $runtimeStatus
  role = $roleName
  secret = "$RuntimeNamespace/$secretName"
  deployment = "$RuntimeNamespace/opensphere-console-api"
  image = $ConsoleApiImage
} | ConvertTo-Json -Compress)
