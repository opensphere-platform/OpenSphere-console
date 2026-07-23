param(
  [string]$ConsoleUrl = "https://console.opensphere.local",
  [string]$Namespace = "opensphere-console-data",
  [string]$StorageClass = "",
  [string]$KubeContext = "",
  # Every release installer is invoked from an immutable Setup CLI lock.  The
  # source revision is persisted with each migration so a live database can be
  # tied back to the reviewed source, not just to a filename on an operator PC.
  [string]$SourceRevision = ""
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Join-Path $here "bootstrap\supabase.yaml"
$migrationDirectory = Join-Path $here "migrations"
$migrations = @(Get-ChildItem -LiteralPath $migrationDirectory -Filter '*.sql' -File | Sort-Object Name)
if ($migrations.Count -eq 0) { throw "No Supabase migrations found in $migrationDirectory" }
if (-not $SourceRevision) { $SourceRevision = [string]$env:OPENSPHERE_SOURCE_REVISION }
if ($SourceRevision -notmatch '^[a-f0-9]{40}$') {
  throw "SourceRevision must be the immutable 40-character release commit SHA"
}
$kubectlArgs = @()
if ($KubeContext) { $kubectlArgs += @("--context", $KubeContext) }

function Invoke-Kubectl([string[]]$Arguments, [string]$InputText = "") {
  if ($InputText) {
    $InputText | & kubectl @kubectlArgs @Arguments
  } else {
    & kubectl @kubectlArgs @Arguments
  }
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
}

function New-RandomBase64([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToBase64String($buffer)
}

function New-RandomSafePassword([int]$Length) {
  $alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  $alphabetLength = $alphabet.Length
  $buffer = New-Object byte[] $Length
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)

  $chars = New-Object char[] $Length
  for ($i = 0; $i -lt $Length; $i++) {
    $idx = $buffer[$i] % $alphabetLength
    $chars[$i] = $alphabet[$idx]
  }
  return -join $chars
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-ServiceJwt([string]$Secret, [string]$Role) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $header = '{"alg":"HS256","typ":"JWT"}'
  $payload = @{ role = $Role; iss = "supabase"; iat = $now; exp = $now + 315360000 } | ConvertTo-Json -Compress
  $encodedHeader = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($header))
  $encodedPayload = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($payload))
  $unsigned = "$encodedHeader.$encodedPayload"
  $hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Secret))
  try { $signature = ConvertTo-Base64Url ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($unsigned))) }
  finally { $hmac.Dispose() }
  return "$unsigned.$signature"
}

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { throw "kubectl is required" }
if (-not (Test-Path -LiteralPath $manifest)) { throw "Missing manifest: $manifest" }

# The bootstrap source stays readable during the transition, but the rendered
# deployment must be able to target the final Console data namespace.  This is
# intentionally a literal namespace substitution: it cannot alter URLs or
# user data and makes fresh installs/parallel migrations deterministic.
$renderedManifest = (Get-Content -Raw -LiteralPath $manifest).Replace("__OPENSPHERE_SUPABASE_NAMESPACE__", $Namespace).Replace("__OPENSPHERE_CONSOLE_URL__", $ConsoleUrl.TrimEnd('/'))
if ($StorageClass) {
  $renderedManifest = $renderedManifest.Replace("__OPENSPHERE_STORAGE_CLASS__", $StorageClass)
} else {
  # Direct development installs preserve Kubernetes' default StorageClass.
  # Setup always supplies an explicit, preflight-validated class.
  $renderedManifest = $renderedManifest -replace "(?m)^\s*storageClassName:\s*__OPENSPHERE_STORAGE_CLASS__\r?\n", ""
}
Invoke-Kubectl @("apply", "-f", "-") $renderedManifest

$secretExists = $true
& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets *> $null
if ($LASTEXITCODE -ne 0) { $secretExists = $false }

if (-not $secretExists) {
  $postgresPassword = New-RandomSafePassword 36
  $backendPassword = New-RandomSafePassword 36
  $oaaGatewayPassword = New-RandomSafePassword 36
  $aiRuntimePassword = New-RandomSafePassword 36
  $aiPipelinePassword = New-RandomSafePassword 36
  $jwtSecret = New-RandomBase64 48
  $anonKey = New-ServiceJwt $jwtSecret "anon"
  $serviceRoleKey = New-ServiceJwt $jwtSecret "service_role"
  # Credentials are sent to kubectl on stdin. They never appear in argv,
  # process listings, shell history, or installer logs.
  $secretManifest = @{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = @{
      name = 'opensphere-supabase-secrets'
      namespace = $Namespace
      labels = @{ 'opensphere.io/secret-scope' = 'supabase-server-only' }
    }
    type = 'Opaque'
    stringData = @{
      'postgres-password' = $postgresPassword
      'backend-password' = $backendPassword
      'oaa-gateway-password' = $oaaGatewayPassword
      'ai-runtime-password' = $aiRuntimePassword
      'ai-pipeline-password' = $aiPipelinePassword
      'jwt-secret' = $jwtSecret
      'anon-key' = $anonKey
      'service-role-key' = $serviceRoleKey
      's3-access-key-id' = (New-RandomSafePassword 32)
      's3-access-key-secret' = (New-RandomSafePassword 64)
    }
  } | ConvertTo-Json -Depth 10 -Compress
  Invoke-Kubectl @('apply', '-f', '-') $secretManifest
} else {
  Write-Host "Reusing existing opensphere-supabase-secrets; credentials are not rotated implicitly."
}

# Existing installations gain only the missing scoped credentials. Existing
# values are never rotated implicitly.
$requiredScopedSecrets = @{
  'oaa-gateway-password' = 36
  'ai-runtime-password' = 36
  'ai-pipeline-password' = 36
  's3-access-key-id' = 32
  's3-access-key-secret' = 64
}
foreach ($entry in $requiredScopedSecrets.GetEnumerator()) {
  $encoded = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.$($entry.Key)}")
  if (-not $encoded) {
    $patch = @{ stringData = @{ $entry.Key = (New-RandomSafePassword $entry.Value) } } | ConvertTo-Json -Compress
    Invoke-Kubectl @("-n", $Namespace, "patch", "secret", "opensphere-supabase-secrets", "--type=merge", "-p", $patch)
  }
}
$oaaGatewayPasswordB64 = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.oaa-gateway-password}")

# Kubernetes Secrets are namespace-scoped. Mirror only the two server-side
# values required by Console Backend; never copy the Postgres owner password.
$jwtSecretB64 = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.jwt-secret}")
$serviceRoleKeyB64 = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.service-role-key}")
$runtimeSecret = @"
apiVersion: v1
kind: Secret
metadata:
  name: opensphere-supabase-runtime
  namespace: opensphere-console
  labels:
    opensphere.io/secret-scope: console-backend-only
type: Opaque
data:
  jwt-secret: $jwtSecretB64
  service-role-key: $serviceRoleKeyB64
"@
Invoke-Kubectl @("apply", "-f", "-") $runtimeSecret

$oaaRuntimeSecret = @"
apiVersion: v1
kind: Secret
metadata:
  name: opensphere-oaa-runtime
  namespace: opensphere-console
  labels:
    opensphere.io/secret-scope: oaa-gateway-only
type: Opaque
data:
  pg-password: $oaaGatewayPasswordB64
"@
Invoke-Kubectl @("apply", "-f", "-") $oaaRuntimeSecret

# AI receives two constrained PostgreSQL logins and an RLS-scoped Storage S3
# session. It never receives the owner password, service-role key, JWT signing
# secret, or the global S3 protocol access key.
$aiRuntimePasswordB64 = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.ai-runtime-password}")
$aiPipelinePasswordB64 = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.ai-pipeline-password}")
$anonKeyB64 = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.anon-key}")
$jwtSecret = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($jwtSecretB64))
$aiStorageSession = New-ServiceJwt $jwtSecret "opensphere_ai_runtime"
$aiStorageSessionB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($aiStorageSession))
$storageEndpoint = "http://opensphere-supabase-storage.$Namespace.svc.cluster.local:5000/storage/v1/s3"
$aiRuntimeSecret = @"
apiVersion: v1
kind: Secret
metadata:
  name: opensphere-supabase-ai-runtime
  namespace: opensphere-system
  labels:
    opensphere.io/secret-scope: ai-runtime-only
    opensphere.io/authority: supabase
type: Opaque
data:
  password: $aiRuntimePasswordB64
  secret_key: $anonKeyB64
  session_token: $aiStorageSessionB64
stringData:
  provider: postgres
  host: opensphere-supabase-postgres.$Namespace.svc.cluster.local
  port: "5432"
  database: postgres
  username: opensphere_ai_runtime
  sslmode: prefer
  endpoint: $storageEndpoint
  bucket: ai-artifacts
  region: local
  access_key: opensphere-console
"@
Invoke-Kubectl @("apply", "-f", "-") $aiRuntimeSecret

$aiPipelineSecret = @"
apiVersion: v1
kind: Secret
metadata:
  name: opensphere-supabase-ai-pipeline
  namespace: opensphere-system
  labels:
    opensphere.io/secret-scope: ai-pipeline-only
    opensphere.io/authority: supabase
type: Opaque
data:
  password: $aiPipelinePasswordB64
stringData:
  provider: postgres
  host: opensphere-supabase-postgres.$Namespace.svc.cluster.local
  port: "5432"
  database: oah_dspa
  username: opensphere_ai_pipeline
  sslmode: prefer
"@
Invoke-Kubectl @("apply", "-f", "-") $aiPipelineSecret

# The first apply may leave Pods pending until the Secret exists.  Re-apply,
# then bring PostgreSQL up before starting the API workloads.  The official
# Supabase PostgreSQL image creates these service roles without assigning their
# passwords.  Auth, REST, and Storage all deliberately use the owner password
# from the namespace secret, so assigning it here is a mandatory bootstrap
# step, not a best-effort repair after those workloads have started.
Invoke-Kubectl @("apply", "-f", "-") $renderedManifest
Invoke-Kubectl @("-n", $Namespace, "rollout", "status", "statefulset/opensphere-supabase-postgres", "--timeout=10m")

$postgresPasswordB64 = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.postgres-password}")
$postgresPassword = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($postgresPasswordB64))
$escapedPostgresPassword = $postgresPassword.Replace("'", "''")

$pod = (& kubectl @kubectlArgs -n $Namespace get pod -l app=opensphere-supabase-postgres -o "jsonpath={.items[0].metadata.name}")
if (-not $pod) { throw "Supabase PostgreSQL pod not found" }

function Invoke-SupabasePsql([string]$Sql) {
  # Supabase owns the database with POSTGRES_USER, not an assumed `postgres`
  # login. This makes fresh installs and later migrations use the same owner.
  Invoke-Kubectl @("-n", $Namespace, "exec", "-i", $pod, "--", "sh", "-ec", 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1') $Sql
}

function Invoke-SupabaseMigrationPsql([string]$Sql) {
  # Console migrations also create narrowly-scoped policies on Supabase-owned
  # storage.objects. The regular POSTGRES_USER is intentionally not that
  # table's owner, so trusted, release-pinned migrations execute through the
  # image-provided migration administrator. Runtime services never receive
  # this credential or role.
  Invoke-Kubectl @("-n", $Namespace, "exec", "-i", $pod, "--", "sh", "-ec", 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1') $Sql
}

function Get-SupabaseMigrationChecksum([string]$MigrationId) {
  if ($MigrationId -notmatch '^[0-9]{4}_[a-z0-9_]+$') { throw "Invalid migration id $MigrationId" }
  $sql = "SELECT COALESCE((SELECT sha256 FROM console.schema_migration WHERE migration_id = '$MigrationId'), '');"
  $output = @(Invoke-Kubectl @("-n", $Namespace, "exec", "-i", $pod, "--", "sh", "-ec", 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -U supabase_admin -d postgres -tA -v ON_ERROR_STOP=1') $sql)
  return (($output | ForEach-Object { $_.Trim() } | Where-Object { $_ }) | Select-Object -Last 1)
}

# Do not create these roles ourselves: their membership and grants are owned by
# the Supabase PostgreSQL image.  A missing role means the image contract has
# changed, and the installer must fail closed rather than invent a weaker role.
$supabaseServiceRoleSql = @"
ALTER ROLE authenticator LOGIN PASSWORD '$escapedPostgresPassword';
ALTER ROLE supabase_auth_admin LOGIN PASSWORD '$escapedPostgresPassword';
ALTER ROLE supabase_storage_admin LOGIN PASSWORD '$escapedPostgresPassword';
"@
Invoke-SupabasePsql $supabaseServiceRoleSql

# The initial manifest is intentionally applied before its Secret can exist.
# Restart Auth and Storage now that their role passwords are valid; a pod that
# failed its first database connection will otherwise remain in a long
# CrashLoopBackOff window on an existing namespace. PostgREST is deliberately
# deferred until the Console migrations create every schema named by
# PGRST_DB_SCHEMAS. Waiting for it here deadlocks a fresh install because its
# readiness endpoint remains 503 while `console` and `audit` do not yet exist.
foreach ($workload in @('opensphere-supabase-auth', 'opensphere-supabase-storage')) {
  Invoke-Kubectl @('-n', $Namespace, 'rollout', 'restart', "deployment/$workload")
  Invoke-Kubectl @('-n', $Namespace, 'rollout', 'status', "deployment/$workload", '--timeout=10m')
}

# Storage API ships and maintains its own schema migrations.  Execute the
# version-matched migration runner from the running Storage image rather than
# copying a private snapshot of Supabase-owned SQL into Console migrations.
$storagePod = (& kubectl @kubectlArgs -n $Namespace get pod -l app=opensphere-supabase-storage -o "jsonpath={.items[0].metadata.name}")
if (-not $storagePod) { throw "Supabase Storage pod not found" }
Invoke-Kubectl @('-n', $Namespace, 'exec', $storagePod, '--', 'node', '/app/dist/scripts/migrate-call.js')

$backendPassword = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.backend-password}")
$backendPassword = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($backendPassword))
$oaaGatewayPassword = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($oaaGatewayPasswordB64))
$aiRuntimePassword = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($aiRuntimePasswordB64))
$aiPipelinePassword = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($aiPipelinePasswordB64))
$escapedBackendPassword = $backendPassword.Replace("'", "''")
$escapedOaaGatewayPassword = $oaaGatewayPassword.Replace("'", "''")
$escapedAiRuntimePassword = $aiRuntimePassword.Replace("'", "''")
$escapedAiPipelinePassword = $aiPipelinePassword.Replace("'", "''")

# Create the constrained runtime role without placing its password in argv or logs.
$roleSql = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_console_backend') THEN
    CREATE ROLE opensphere_console_backend LOGIN PASSWORD '$escapedBackendPassword'
      NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE opensphere_console_backend LOGIN PASSWORD '$escapedBackendPassword'
      NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
`$`$;
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_oaa_gateway') THEN
    CREATE ROLE opensphere_oaa_gateway LOGIN PASSWORD '$escapedOaaGatewayPassword'
      NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE opensphere_oaa_gateway LOGIN PASSWORD '$escapedOaaGatewayPassword'
      NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
`$`$;
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_ai_runtime') THEN
    CREATE ROLE opensphere_ai_runtime LOGIN PASSWORD '$escapedAiRuntimePassword'
      NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE opensphere_ai_runtime LOGIN PASSWORD '$escapedAiRuntimePassword'
      NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
`$`$;
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_ai_pipeline') THEN
    CREATE ROLE opensphere_ai_pipeline LOGIN PASSWORD '$escapedAiPipelinePassword'
      NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE opensphere_ai_pipeline LOGIN PASSWORD '$escapedAiPipelinePassword'
      NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
`$`$;
SELECT format('CREATE DATABASE %I OWNER %I', 'oah_dspa', 'opensphere_ai_pipeline')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'oah_dspa')\gexec
"@

Invoke-SupabasePsql $roleSql

# The migration ledger is created before the release migrations themselves so
# it can attest the full ordered set including 0001.  It intentionally has no
# runtime write grant: only this release-pinned migration path can append a
# record, and UPDATE/DELETE are rejected even for the table owner.
$migrationLedgerBootstrap = @"
CREATE SCHEMA IF NOT EXISTS console AUTHORIZATION supabase_admin;
CREATE TABLE IF NOT EXISTS console.schema_migration (
  migration_id text PRIMARY KEY CHECK (migration_id ~ '^[0-9]{4}_[a-z0-9_]+$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  executor text NOT NULL DEFAULT current_user,
  result text NOT NULL DEFAULT 'applied' CHECK (result = 'applied')
);
CREATE OR REPLACE FUNCTION console.reject_schema_migration_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, console AS `$`$
BEGIN
  RAISE EXCEPTION 'console.schema_migration is append-only';
END;
`$`$;
DROP TRIGGER IF EXISTS schema_migration_append_only ON console.schema_migration;
CREATE TRIGGER schema_migration_append_only
  BEFORE UPDATE OR DELETE ON console.schema_migration
  FOR EACH ROW EXECUTE FUNCTION console.reject_schema_migration_mutation();
ALTER TABLE console.schema_migration ENABLE ALWAYS TRIGGER schema_migration_append_only;
REVOKE ALL ON TABLE console.schema_migration FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT SELECT ON TABLE console.schema_migration TO opensphere_console_backend;
"@
Invoke-SupabaseMigrationPsql $migrationLedgerBootstrap
foreach ($migration in $migrations) {
  $migrationId = [IO.Path]::GetFileNameWithoutExtension($migration.Name)
  $checksum = (Get-FileHash -LiteralPath $migration.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $recordedChecksum = Get-SupabaseMigrationChecksum $migrationId
  if ($recordedChecksum -and $recordedChecksum -ne $checksum) {
    throw "Migration checksum drift for $migrationId: live=$recordedChecksum release=$checksum"
  }
  if ($recordedChecksum -eq $checksum) {
    Write-Host "Supabase migration $migrationId already attested"
    continue
  }
  Write-Host "Applying Supabase migration $($migration.Name) sha256=$checksum"
  Invoke-SupabaseMigrationPsql (Get-Content -Raw -LiteralPath $migration.FullName)
  $ledgerSql = @"
INSERT INTO console.schema_migration(migration_id, sha256, source_revision, executor)
VALUES ('$migrationId', '$checksum', '$SourceRevision', current_user)
ON CONFLICT (migration_id) DO NOTHING;
"@
  Invoke-SupabaseMigrationPsql $ledgerSql
  $attestedChecksum = Get-SupabaseMigrationChecksum $migrationId
  if ($attestedChecksum -ne $checksum) { throw "Migration ledger did not attest $migrationId" }
}

# Reload the two schema-consuming APIs after Console migrations have completed.
foreach ($workload in @('opensphere-supabase-rest', 'opensphere-supabase-storage')) {
  Invoke-Kubectl @('-n', $Namespace, 'rollout', 'restart', "deployment/$workload")
  Invoke-Kubectl @('-n', $Namespace, 'rollout', 'status', "deployment/$workload", '--timeout=10m')
}

Write-Host "Supabase Data & Identity installed in namespace $Namespace."
Write-Host "Supabase is the Console identity authority. Retired Kanidm BFF workloads must not be re-applied."
