param(
  [string]$ConsoleUrl = "https://console.opensphere.local",
  [string]$Namespace = "opensphere-console-data",
  [string]$KubeContext = ""
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Join-Path $here "bootstrap\supabase.yaml"
$migrationDirectory = Join-Path $here "migrations"
$migrations = @(Get-ChildItem -LiteralPath $migrationDirectory -Filter '*.sql' -File | Sort-Object Name)
if ($migrations.Count -eq 0) { throw "No Supabase migrations found in $migrationDirectory" }
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
Invoke-Kubectl @("apply", "-f", "-") $renderedManifest

$secretExists = $true
& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets *> $null
if ($LASTEXITCODE -ne 0) { $secretExists = $false }

if (-not $secretExists) {
  $postgresPassword = New-RandomSafePassword 36
  $backendPassword = New-RandomSafePassword 36
  $oaaGatewayPassword = New-RandomSafePassword 36
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
      'jwt-secret' = $jwtSecret
      'anon-key' = $anonKey
      'service-role-key' = $serviceRoleKey
    }
  } | ConvertTo-Json -Depth 10 -Compress
  Invoke-Kubectl @('apply', '-f', '-') $secretManifest
} else {
  Write-Host "Reusing existing opensphere-supabase-secrets; credentials are not rotated implicitly."
}

# OAA receives its own constrained database credential.  It never receives the
# Supabase owner password, service-role JWT, or Console Backend credential.
$oaaGatewayPasswordB64 = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.oaa-gateway-password}")
if (-not $oaaGatewayPasswordB64) {
  $newOaaGatewayPassword = New-RandomSafePassword 36
  $oaaGatewayPasswordPatch = @{ stringData = @{ 'oaa-gateway-password' = $newOaaGatewayPassword } } | ConvertTo-Json -Compress
  Invoke-Kubectl @("-n", $Namespace, "patch", "secret", "opensphere-supabase-secrets", "--type=merge", "-p", $oaaGatewayPasswordPatch)
  $oaaGatewayPasswordB64 = (& kubectl @kubectlArgs -n $Namespace get secret opensphere-supabase-secrets -o "jsonpath={.data.oaa-gateway-password}")
}

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
$escapedBackendPassword = $backendPassword.Replace("'", "''")
$escapedOaaGatewayPassword = $oaaGatewayPassword.Replace("'", "''")

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
"@

Invoke-SupabasePsql $roleSql
foreach ($migration in $migrations) {
  Write-Host "Applying Supabase migration $($migration.Name)"
  Invoke-SupabasePsql (Get-Content -Raw -LiteralPath $migration.FullName)
}

# Reload the two schema-consuming APIs after Console migrations have completed.
foreach ($workload in @('opensphere-supabase-rest', 'opensphere-supabase-storage')) {
  Invoke-Kubectl @('-n', $Namespace, 'rollout', 'restart', "deployment/$workload")
  Invoke-Kubectl @('-n', $Namespace, 'rollout', 'status', "deployment/$workload", '--timeout=10m')
}

Write-Host "Supabase Data & Identity installed in namespace $Namespace."
Write-Host "Supabase is the Console identity authority. Retired Kanidm BFF workloads must not be re-applied."
