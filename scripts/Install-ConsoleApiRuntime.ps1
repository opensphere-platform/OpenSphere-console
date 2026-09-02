param(
  [Parameter(Mandatory = $true)]
  [string]$ConsoleApiImage,
  [Parameter(Mandatory = $true)]
  [string]$ExtensionControllerImage,
  [Parameter(Mandatory = $true)]
  [string]$SupabasePostgresImage,
  [Parameter(Mandatory = $true)]
  [string]$SupabaseAuthImage,
  [Parameter(Mandatory = $true)]
  [string]$SupabaseRestImage,
  [Parameter(Mandatory = $true)]
  [string]$SupabaseStorageImage,
  [Parameter(Mandatory = $true)]
  [string]$ConsoleUrl,
  [string]$StorageClass = '',
  [string]$KubeContext = '',
  [switch]$VerifiedMaterializedRelease,
  [string]$ExpectedMigrationManifestSha256 = '',
  [string]$ExpectedMigrationSetDigest = '',
  [string]$ExpectedMigrationLatestGlobalId = ''
)

$ErrorActionPreference = 'Stop'
$DataNamespace = 'opensphere-console-data'
$RuntimeNamespace = 'opensphere-console'
$roleName = 'opensphere_console_api_runtime'
$authorityRole = 'console_api'
$secretName = 'opensphere-console-api-runtime'
$secretKey = 'database-url'
$sessionEncryptionSecretKey = 'session-encryption-key'
$supabaseServiceRoleSecretKey = 'supabase-service-role-key'
$extensionRoleName = 'opensphere_console_extension_runtime'
$extensionAuthorityRole = 'console_extension_controller'
$extensionSecretName = 'opensphere-extension-controller-runtime'
$databaseHost = "opensphere-supabase-postgres.$DataNamespace.svc.cluster.local"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repositoryRoot 'migrations\manifest.json'
$deploymentPath = Join-Path $repositoryRoot 'apps\console-api\deploy.yaml'
$extensionDeploymentPath = Join-Path $repositoryRoot 'apps\extension-controller\deploy.yaml'
$dataDeploymentPath = Join-Path $repositoryRoot 'backend\supabase\target\deploy.yaml'

foreach ($imageInput in @(
  @{ Name = 'ConsoleApiImage'; Value = $ConsoleApiImage; Artifact = 'opensphere-console-api' },
  @{ Name = 'ExtensionControllerImage'; Value = $ExtensionControllerImage; Artifact = 'opensphere-extension-controller' },
  @{ Name = 'SupabasePostgresImage'; Value = $SupabasePostgresImage; Artifact = 'opensphere-console-supabase-postgres' },
  @{ Name = 'SupabaseAuthImage'; Value = $SupabaseAuthImage; Artifact = 'opensphere-console-supabase-auth' },
  @{ Name = 'SupabaseRestImage'; Value = $SupabaseRestImage; Artifact = 'opensphere-console-supabase-rest' },
  @{ Name = 'SupabaseStorageImage'; Value = $SupabaseStorageImage; Artifact = 'opensphere-console-supabase-storage' }
)) {
  $expectedImage = '^ghcr[.]io/opensphere-platform/' + [regex]::Escape($imageInput.Artifact) + '@sha256:[a-f0-9]{64}$'
  if ($imageInput.Value -notmatch $expectedImage) {
    throw "$($imageInput.Name) must be the exact official $($imageInput.Artifact) GHCR digest"
  }
}
$consoleUri = $null
if (-not [Uri]::TryCreate($ConsoleUrl, [UriKind]::Absolute, [ref]$consoleUri) -or
    $consoleUri.Scheme -ne 'https' -or $consoleUri.UserInfo -or $consoleUri.Query -or $consoleUri.Fragment -or
    $consoleUri.AbsolutePath -ne '/') {
  throw 'ConsoleUrl must be an HTTPS origin without credentials, path, query, or fragment'
}
$ConsoleUrl = $consoleUri.AbsoluteUri.TrimEnd('/')
if ($StorageClass -and $StorageClass -notmatch '^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$') {
  throw 'StorageClass is not a valid Kubernetes storage class name'
}
if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { throw 'kubectl is required' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node is required' }
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing fresh migration manifest: $manifestPath" }
if (-not (Test-Path -LiteralPath $deploymentPath)) { throw "Missing C_API deployment manifest: $deploymentPath" }
if (-not (Test-Path -LiteralPath $extensionDeploymentPath)) { throw "Missing C_EXT deployment manifest: $extensionDeploymentPath" }
if (-not (Test-Path -LiteralPath $dataDeploymentPath)) { throw "Missing target Supabase deployment manifest: $dataDeploymentPath" }

$migrationManifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($migrationManifest.schemaVersion -ne 1 -or
    [string]$migrationManifest.latestGlobalId -notmatch '^opensphere-console/[0-9]{8}/[0-9]{4}$' -or
    [string]$migrationManifest.setDigest -notmatch '^sha256:[a-f0-9]{64}$' -or
    [int]$migrationManifest.migrationCount -lt 1 -or
    @($migrationManifest.migrations).Count -ne [int]$migrationManifest.migrationCount) {
  throw 'Fresh migration manifest identity is invalid'
}

$expectedMaterializedEvidence = @(
  $ExpectedMigrationManifestSha256,
  $ExpectedMigrationSetDigest,
  $ExpectedMigrationLatestGlobalId
)
if ($VerifiedMaterializedRelease) {
  if ($ExpectedMigrationManifestSha256 -notmatch '^sha256:[a-f0-9]{64}$' -or
      $ExpectedMigrationSetDigest -notmatch '^sha256:[a-f0-9]{64}$' -or
      $ExpectedMigrationLatestGlobalId -notmatch '^opensphere-console/[0-9]{8}/[0-9]{4}$') {
    throw 'VerifiedMaterializedRelease requires the signed BOM migration manifest digest, set digest, and latest global ID'
  }
  $actualManifestSha256 = 'sha256:' + (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualManifestSha256 -ne $ExpectedMigrationManifestSha256 -or
      [string]$migrationManifest.setDigest -ne $ExpectedMigrationSetDigest -or
      [string]$migrationManifest.latestGlobalId -ne $ExpectedMigrationLatestGlobalId) {
    throw 'Materialized migration evidence differs from the verified signed Release BOM'
  }
} elseif (@($expectedMaterializedEvidence | Where-Object { $_ }).Count -gt 0) {
  throw 'Signed BOM migration evidence requires VerifiedMaterializedRelease'
}

$kubectlArgs = @()
if ($KubeContext) { $kubectlArgs += @('--context', $KubeContext) }

function Invoke-Kubectl([string[]]$Arguments, [string]$InputText = '') {
  if ($InputText) { $output = $InputText | & kubectl @kubectlArgs @Arguments }
  else { $output = & kubectl @kubectlArgs @Arguments }
  if ($LASTEXITCODE -ne 0) { throw "kubectl failed: $($Arguments -join ' ')" }
  return @($output)
}

function ConvertFrom-Base64Url([string]$Value) {
  $normalized = $Value.Replace('-', '+').Replace('_', '/')
  switch ($normalized.Length % 4) {
    0 { }
    2 { $normalized += '==' }
    3 { $normalized += '=' }
    default { throw 'Supabase service JWT contains invalid base64url' }
  }
  try { $bytes = [Convert]::FromBase64String($normalized) }
  catch { throw 'Supabase service JWT contains invalid base64url' }
  Write-Output -NoEnumerate $bytes
}

function Test-SupabaseServiceJwt([string]$Token, [string]$ExpectedRole, [byte[]]$SecretBytes) {
  $parts = $Token.Split('.')
  if ($parts.Count -ne 3) { throw "Supabase $ExpectedRole key is not a JWT" }
  $headerBytes = ConvertFrom-Base64Url $parts[0]
  $payloadBytes = ConvertFrom-Base64Url $parts[1]
  $signatureBytes = ConvertFrom-Base64Url $parts[2]
  try {
    $header = [Text.Encoding]::UTF8.GetString($headerBytes) | ConvertFrom-Json
    $payload = [Text.Encoding]::UTF8.GetString($payloadBytes) | ConvertFrom-Json
    if ($header.alg -ne 'HS256' -or $payload.role -ne $ExpectedRole -or $payload.iss -ne 'supabase' -or
        [long]$payload.exp -le [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) {
      throw "Supabase $ExpectedRole key claims are invalid"
    }
    $hmac = [Security.Cryptography.HMACSHA256]::new($SecretBytes)
    try { $expectedSignature = $hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes("$($parts[0]).$($parts[1])")) }
    finally { $hmac.Dispose() }
    if (-not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($expectedSignature, $signatureBytes)) {
      throw "Supabase $ExpectedRole key signature is invalid"
    }
  } finally {
    [Array]::Clear($headerBytes, 0, $headerBytes.Length)
    [Array]::Clear($payloadBytes, 0, $payloadBytes.Length)
    [Array]::Clear($signatureBytes, 0, $signatureBytes.Length)
    if ($expectedSignature) { [Array]::Clear($expectedSignature, 0, $expectedSignature.Length) }
  }
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
  @{ Namespace = $DataNamespace; Name = 'opensphere-ghcr-pull' },
  @{ Namespace = $RuntimeNamespace; Name = 'opensphere-ghcr-pull' }
)) {
  $secretObject = Invoke-Kubectl @('-n', $secretRef.Namespace, 'get', 'secret', $secretRef.Name, '-o', 'name')
  if (($secretObject -join '').Trim() -ne "secret/$($secretRef.Name)") {
    throw "Required install input Secret is unavailable: $($secretRef.Namespace)/$($secretRef.Name)"
  }
}

$serverSecret = ((Invoke-Kubectl @('-n', $DataNamespace, 'get', 'secret', 'opensphere-supabase-secrets', '-o', 'json')) | Out-String) | ConvertFrom-Json
$requiredServerSecretKeys = @(
  'anon-key',
  'jwt-secret',
  'postgres-password',
  's3-access-key-id',
  's3-access-key-secret',
  'service-role-key'
)
$actualServerSecretKeys = @($serverSecret.data.PSObject.Properties.Name | Sort-Object)
if ($serverSecret.type -ne 'Opaque' -or
    [string]$serverSecret.metadata.labels.'opensphere.io/secret-scope' -ne 'supabase-server-only' -or
    (Compare-Object $requiredServerSecretKeys $actualServerSecretKeys)) {
  throw 'opensphere-supabase-secrets must be the exact six-key fresh server Secret'
}
foreach ($secretKeyName in $requiredServerSecretKeys) {
  try { $secretBytes = [Convert]::FromBase64String([string]$serverSecret.data.$secretKeyName) }
  catch { throw "opensphere-supabase-secrets contains invalid base64: $secretKeyName" }
  if ($secretBytes.Length -eq 0) { throw "opensphere-supabase-secrets contains an empty value: $secretKeyName" }
  [Array]::Clear($secretBytes, 0, $secretBytes.Length)
}
$jwtSecretBytes = [Convert]::FromBase64String([string]$serverSecret.data.'jwt-secret')
$anonKeyBytes = [Convert]::FromBase64String([string]$serverSecret.data.'anon-key')
$serviceRoleKeyBytes = [Convert]::FromBase64String([string]$serverSecret.data.'service-role-key')
$serviceRoleCredential = [Text.Encoding]::UTF8.GetString($serviceRoleKeyBytes)
try {
  if ($jwtSecretBytes.Length -lt 32) { throw 'Supabase JWT secret must contain at least 32 bytes' }
  Test-SupabaseServiceJwt ([Text.Encoding]::UTF8.GetString($anonKeyBytes)) 'anon' $jwtSecretBytes
  Test-SupabaseServiceJwt ([Text.Encoding]::UTF8.GetString($serviceRoleKeyBytes)) 'service_role' $jwtSecretBytes
} finally {
  [Array]::Clear($jwtSecretBytes, 0, $jwtSecretBytes.Length)
  [Array]::Clear($anonKeyBytes, 0, $anonKeyBytes.Length)
  [Array]::Clear($serviceRoleKeyBytes, 0, $serviceRoleKeyBytes.Length)
}
$postgresPasswordBytes = [Convert]::FromBase64String([string]$serverSecret.data.'postgres-password')
$postgresPassword = [Text.Encoding]::UTF8.GetString($postgresPasswordBytes)
if ($postgresPassword.Length -lt 32) { throw 'Supabase PostgreSQL password must contain at least 32 characters' }
$secretJson = (Invoke-Kubectl @('-n', $RuntimeNamespace, 'get', 'secret', $secretName, '--ignore-not-found', '-o', 'json') | Out-String).Trim()
$secretPresent = [bool]$secretJson
$extensionSecretJson = (Invoke-Kubectl @('-n', $RuntimeNamespace, 'get', 'secret', $extensionSecretName, '--ignore-not-found', '-o', 'json') | Out-String).Trim()
$extensionSecretPresent = [bool]$extensionSecretJson

$dataResources = @(
  'serviceaccount/opensphere-supabase-postgres',
  'serviceaccount/opensphere-supabase-auth',
  'serviceaccount/opensphere-supabase-rest',
  'serviceaccount/opensphere-supabase-storage',
  'persistentvolumeclaim/opensphere-supabase-postgres-data',
  'persistentvolumeclaim/opensphere-supabase-storage-data',
  'statefulset/opensphere-supabase-postgres',
  'service/opensphere-supabase-postgres',
  'deployment/opensphere-supabase-auth',
  'service/opensphere-supabase-auth',
  'deployment/opensphere-supabase-rest',
  'service/opensphere-supabase-rest',
  'deployment/opensphere-supabase-storage',
  'service/opensphere-supabase-storage',
  'networkpolicy/opensphere-supabase-default-deny',
  'networkpolicy/opensphere-supabase-console-ingress',
  'networkpolicy/opensphere-supabase-postgres-ingress',
  'networkpolicy/opensphere-supabase-internal-egress'
)
$existingDataResources = @($dataResources | Where-Object {
  ((Invoke-Kubectl @('-n', $DataNamespace, 'get', $_, '--ignore-not-found', '-o', 'name')) -join '').Trim()
})
if ($existingDataResources.Count -notin @(0, $dataResources.Count)) {
  throw 'Target Supabase resources are in a partial state; no implicit repair was attempted'
}
if ($existingDataResources.Count -eq 0 -and ($secretPresent -or $extensionSecretPresent)) {
  throw 'Console runtime Secret exists without a target data stack; no implicit repair was attempted'
}
$dataStackStatus = if ($existingDataResources.Count -eq 0) { 'installed' } else { 'reconciled' }

$dataWorkloads = @(
  @{ Resource = 'statefulset/opensphere-supabase-postgres'; Artifact = 'opensphere-console-supabase-postgres'; Image = $SupabasePostgresImage },
  @{ Resource = 'deployment/opensphere-supabase-auth'; Artifact = 'opensphere-console-supabase-auth'; Image = $SupabaseAuthImage },
  @{ Resource = 'deployment/opensphere-supabase-rest'; Artifact = 'opensphere-console-supabase-rest'; Image = $SupabaseRestImage },
  @{ Resource = 'deployment/opensphere-supabase-storage'; Artifact = 'opensphere-console-supabase-storage'; Image = $SupabaseStorageImage }
)

$postgresPod = ''
function Set-ReadyPostgresPod {
  $postgresPods = (Invoke-Kubectl @('-n', $DataNamespace, 'get', 'pod', '-l', 'app=opensphere-supabase-postgres', '-o', 'json') | Out-String) | ConvertFrom-Json
  $readyPods = @($postgresPods.items | Where-Object {
    $_.status.phase -eq 'Running' -and
    @($_.status.conditions | Where-Object { $_.type -eq 'Ready' -and $_.status -eq 'True' }).Count -eq 1
  })
  if ($readyPods.Count -ne 1) { throw "Expected exactly one Ready Supabase PostgreSQL pod in $DataNamespace" }
  $script:postgresPod = [string]$readyPods[0].metadata.name
}

function Invoke-OwnerSql([string]$Sql) {
  $command = 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -h 127.0.0.1 -U supabase_admin -d postgres -tA -v ON_ERROR_STOP=1'
  $rows = @((Invoke-Kubectl @('-n', $DataNamespace, 'exec', '-i', $postgresPod, '--', 'sh', '-ec', $command) $Sql) |
    ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  Write-Output -NoEnumerate $rows
}

function Invoke-OwnerMigrationSql([string]$Sql) {
  $command = 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction'
  Invoke-Kubectl @('-n', $DataNamespace, 'exec', '-i', $postgresPod, '--', 'sh', '-ec', $command) $Sql | Out-Null
}

function Get-RuntimePasswordFromSecret([string]$Json) {
  $secret = $Json | ConvertFrom-Json
  $actualKeys = @($secret.data.PSObject.Properties.Name | Sort-Object)
  $expectedKeys = @($secretKey, $sessionEncryptionSecretKey, $supabaseServiceRoleSecretKey) | Sort-Object
  if ($secret.type -ne 'Opaque' -or (Compare-Object $expectedKeys $actualKeys)) {
    throw 'Runtime Secret must match the exact C_API credential contract'
  }
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
  try { $sessionKeyBytes = [Convert]::FromBase64String([string]$secret.data.$sessionEncryptionSecretKey) }
  catch { throw 'Runtime Secret session encryption key is not valid base64' }
  try {
    if ($sessionKeyBytes.Length -ne 32 -or [Convert]::ToBase64String($sessionKeyBytes) -ne [string]$secret.data.$sessionEncryptionSecretKey) {
      throw 'Runtime Secret session encryption key must be canonical base64 for exactly 32 bytes'
    }
  } finally {
    [Array]::Clear($sessionKeyBytes, 0, $sessionKeyBytes.Length)
  }
  $runtimeServiceRole = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String([string]$secret.data.$supabaseServiceRoleSecretKey)
  )
  if ($runtimeServiceRole -cne $serviceRoleCredential) {
    throw 'Runtime Secret Supabase Auth administrator credential differs from the fresh server authority'
  }
  $runtimeServiceRole = $null
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

function Get-ExtensionRuntimePasswordFromSecret([string]$Json) {
  $secret = $Json | ConvertFrom-Json
  $actualKeys = @($secret.data.PSObject.Properties.Name | Sort-Object)
  if ($secret.type -ne 'Opaque' -or $actualKeys.Count -ne 1 -or $actualKeys[0] -ne $secretKey) {
    throw 'Runtime Secret must match the exact C_EXT credential contract'
  }
  $databaseUrl = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$secret.data.$secretKey))
  $uri = [Uri]$databaseUrl
  $expectedHost = "opensphere-supabase-postgres.$DataNamespace.svc.cluster.local"
  if ($uri.Scheme -notin @('postgres', 'postgresql') -or $uri.Host -ne $expectedHost -or
      $uri.AbsolutePath -ne '/postgres' -or $uri.Query -or $uri.Fragment) {
    throw 'C_EXT Runtime Secret database URL is outside the fixed Supabase authority'
  }
  $userinfo = $uri.UserInfo.Split(':', 2)
  if ($userinfo.Count -ne 2 -or [Uri]::UnescapeDataString($userinfo[0]) -ne $extensionRoleName) {
    throw 'Runtime Secret database role differs from the fixed C_EXT login'
  }
  return [Uri]::UnescapeDataString($userinfo[1])
}

function Test-ExtensionRuntimeLogin([string]$Password) {
  $command = 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -X -h 127.0.0.1 -U opensphere_console_extension_runtime -d postgres -tA -v ON_ERROR_STOP=1 -c "SELECT current_user||''|''||pg_has_role(current_user,''console_extension_controller'',''member'')::text;"'
  $result = Invoke-Kubectl @('-n', $DataNamespace, 'exec', '-i', $postgresPod, '--', 'sh', '-ec', $command) ($Password + "`n")
  $line = @($result | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  if ($line.Count -ne 1 -or $line[0] -ne "$extensionRoleName|true") {
    throw 'Runtime login does not match the limited console_extension_controller membership contract'
  }
}

function Test-ExtensionRuntimeRoleContract {
  $sql = @"
SELECT child.rolname||'|'||child.rolcanlogin::text||'|'||child.rolinherit::text||'|'||
       child.rolsuper::text||'|'||child.rolcreaterole::text||'|'||child.rolcreatedb::text||'|'||
       child.rolreplication::text||'|'||child.rolbypassrls::text||'|'||child.rolconnlimit::text||'|'||
       COALESCE((SELECT string_agg(parent.rolname, ',' ORDER BY parent.rolname COLLATE "C")
                 FROM pg_auth_members membership
                 JOIN pg_roles parent ON parent.oid=membership.roleid
                 WHERE membership.member=child.oid), '')
FROM pg_roles child WHERE child.rolname='$extensionRoleName';
"@
  $result = Invoke-OwnerSql $sql
  if ($result.Count -ne 1 -or $result[0] -ne "$extensionRoleName|true|true|false|false|false|false|false|8|$extensionAuthorityRole") {
    throw 'Runtime role attributes or memberships differ from the closed C_EXT contract'
  }
}

$expectedLedger = "$($migrationManifest.migrationCount)|$($migrationManifest.latestGlobalId)|$($migrationManifest.setDigest)"
$ledgerSql = @"
SELECT count(*)::text || '|' ||
       COALESCE((SELECT global_id FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1), '') || '|' ||
       COALESCE((SELECT migration_set_digest FROM console_migration.applied_migration ORDER BY applied_sequence DESC LIMIT 1), '')
FROM console_migration.applied_migration;
"@

function Get-AppliedMigrationCount([string]$LedgerState) {
  $parts = @($LedgerState -split '[|]', 3)
  if ($parts.Count -ne 3 -or $parts[0] -notmatch '^[0-9]+$') {
    throw 'Fresh migration ledger state is malformed'
  }
  $count = [int]$parts[0]
  if ($count -lt 1 -or $count -gt [int]$migrationManifest.migrationCount) {
    throw 'Existing Supabase data stack does not have a supported fresh migration prefix'
  }
  $expected = @($migrationManifest.migrations) | Where-Object { [int]$_.setSize -eq $count }
  if ($expected.Count -ne 1 -or
      $parts[1] -ne [string]$expected[0].globalId -or
      $parts[2] -ne [string]$expected[0].setDigest) {
    throw 'Existing Supabase data stack does not have an exact manifest prefix'
  }
  return $count
}

if ($existingDataResources.Count -eq $dataResources.Count) {
  foreach ($workload in $dataWorkloads) {
    $image = ((Invoke-Kubectl @('-n', $DataNamespace, 'get', $workload.Resource, '-o', 'jsonpath={.spec.template.spec.containers[0].image}')) -join '').Trim()
    $officialImage = '^ghcr[.]io/opensphere-platform/' + [regex]::Escape($workload.Artifact) + '@sha256:[a-f0-9]{64}$'
    if ($image -notmatch $officialImage) {
      throw "Existing Supabase workload is not an exact official target image: $($workload.Resource)"
    }
  }
  Set-ReadyPostgresPod
  $legacyLedger = Invoke-OwnerSql "SELECT CASE WHEN to_regclass('console.schema_migration') IS NULL THEN 'absent' ELSE 'present' END;"
  if ($legacyLedger.Count -ne 1 -or $legacyLedger[0] -ne 'absent') {
    throw 'Legacy Supabase migration lineage cannot be reconciled as the fresh target data stack'
  }
  $existingFreshLedger = Invoke-OwnerSql "SELECT CASE WHEN to_regclass('console_migration.applied_migration') IS NULL THEN 'absent' ELSE 'present' END;"
  if ($existingFreshLedger.Count -ne 1 -or $existingFreshLedger[0] -notin @('absent', 'present')) {
    throw 'Unable to establish existing fresh migration ledger state'
  }
  if ($existingFreshLedger[0] -eq 'present') {
    $existingLedger = Invoke-OwnerSql $ledgerSql
    if ($existingLedger.Count -ne 1) { throw 'Unable to establish existing fresh migration ledger state' }
    Get-AppliedMigrationCount $existingLedger[0] | Out-Null
  }
  $preflightRoleState = Invoke-OwnerSql "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$roleName') THEN 'present' ELSE 'absent' END;"
  if ($preflightRoleState.Count -ne 1 -or $preflightRoleState[0] -notin @('present', 'absent')) {
    throw 'Unable to establish preflight C_API runtime role state'
  }
  if (($preflightRoleState[0] -eq 'present') -ne $secretPresent) {
    throw 'Console API runtime role and Secret are in a split provisioning state; no target mutation was attempted'
  }
  if ($secretPresent) {
    Test-RuntimeRoleContract
    Test-RuntimeLogin (Get-RuntimePasswordFromSecret $secretJson)
  }
  $extensionPreflightRoleState = Invoke-OwnerSql "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$extensionRoleName') THEN 'present' ELSE 'absent' END;"
  if ($extensionPreflightRoleState.Count -ne 1 -or $extensionPreflightRoleState[0] -notin @('present', 'absent')) {
    throw 'Unable to establish preflight C_EXT runtime role state'
  }
  if (($extensionPreflightRoleState[0] -eq 'present') -ne $extensionSecretPresent) {
    throw 'Extension Controller runtime role and Secret are in a split provisioning state; no target mutation was attempted'
  }
  if ($extensionSecretPresent) {
    Test-ExtensionRuntimeRoleContract
    Test-ExtensionRuntimeLogin (Get-ExtensionRuntimePasswordFromSecret $extensionSecretJson)
  }
}

$dataDeploymentTemplate = Get-Content -Raw -LiteralPath $dataDeploymentPath
$dataPlaceholders = [ordered]@{
  '__OPENSPHERE_SUPABASE_POSTGRES_IMAGE__' = @{ Count = 3; Value = $SupabasePostgresImage }
  '__OPENSPHERE_SUPABASE_AUTH_IMAGE__' = @{ Count = 1; Value = $SupabaseAuthImage }
  '__OPENSPHERE_SUPABASE_REST_IMAGE__' = @{ Count = 1; Value = $SupabaseRestImage }
  '__OPENSPHERE_SUPABASE_STORAGE_IMAGE__' = @{ Count = 1; Value = $SupabaseStorageImage }
  '__OPENSPHERE_CONSOLE_URL__' = @{ Count = 5; Value = $ConsoleUrl }
}
$renderedDataDeployment = $dataDeploymentTemplate
foreach ($placeholder in $dataPlaceholders.GetEnumerator()) {
  if ([regex]::Matches($renderedDataDeployment, [regex]::Escape($placeholder.Key)).Count -ne $placeholder.Value.Count) {
    throw "Target Supabase placeholder contract is invalid: $($placeholder.Key)"
  }
  $renderedDataDeployment = $renderedDataDeployment.Replace($placeholder.Key, [string]$placeholder.Value.Value)
}
if ([regex]::Matches($renderedDataDeployment, [regex]::Escape('__OPENSPHERE_STORAGE_CLASS__')).Count -ne 2) {
  throw 'Target Supabase storage class placeholder contract is invalid'
}
if ($StorageClass) {
  $renderedDataDeployment = $renderedDataDeployment.Replace('__OPENSPHERE_STORAGE_CLASS__', $StorageClass)
} else {
  $renderedDataDeployment = $renderedDataDeployment -replace '(?m)^\s*storageClassName:\s*__OPENSPHERE_STORAGE_CLASS__\r?\n', ''
}
if ($renderedDataDeployment -match '__OPENSPHERE_[A-Z0-9_]+__') { throw 'Target Supabase deployment has unresolved placeholders' }
Invoke-Kubectl @('apply', '-f', '-') $renderedDataDeployment | Out-Null
Invoke-Kubectl @('-n', $DataNamespace, 'rollout', 'status', 'statefulset/opensphere-supabase-postgres', '--timeout=10m') | Out-Null
Set-ReadyPostgresPod

foreach ($workload in $dataWorkloads) {
  $installedImage = ((Invoke-Kubectl @('-n', $DataNamespace, 'get', $workload.Resource, '-o', 'jsonpath={.spec.template.spec.containers[0].image}')) -join '').Trim()
  if ($installedImage -ne $workload.Image) {
    throw "Installed Supabase image differs from the requested exact digest: $($workload.Resource)"
  }
}

$escapedPostgresPassword = $postgresPassword.Replace("'", "''")
$serviceRoleSql = @"
DO `$roles`$
BEGIN
  IF EXISTS (
    SELECT required.role_name
    FROM (VALUES ('authenticator'), ('supabase_auth_admin'), ('supabase_storage_admin')) AS required(role_name)
    LEFT JOIN pg_roles current_role ON current_role.rolname = required.role_name
    WHERE current_role.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'required Supabase service role is absent';
  END IF;
END
`$roles`$;
ALTER ROLE authenticator LOGIN PASSWORD '$escapedPostgresPassword';
ALTER ROLE supabase_auth_admin LOGIN PASSWORD '$escapedPostgresPassword';
ALTER ROLE supabase_storage_admin LOGIN PASSWORD '$escapedPostgresPassword';
"@
Invoke-OwnerMigrationSql $serviceRoleSql
$serviceRoleSql = $null
$escapedPostgresPassword = $null
$postgresPassword = $null
[Array]::Clear($postgresPasswordBytes, 0, $postgresPasswordBytes.Length)
Invoke-Kubectl @('-n', $DataNamespace, 'rollout', 'status', 'deployment/opensphere-supabase-auth', '--timeout=10m') | Out-Null
Invoke-Kubectl @('-n', $DataNamespace, 'wait', '--for=jsonpath={.status.phase}=Running', 'pod', '-l', 'app=opensphere-supabase-storage', '--timeout=10m') | Out-Null
$storagePods = (Invoke-Kubectl @('-n', $DataNamespace, 'get', 'pod', '-l', 'app=opensphere-supabase-storage', '-o', 'json') | Out-String) | ConvertFrom-Json
$runningStoragePods = @($storagePods.items | Where-Object { $_.status.phase -eq 'Running' })
if ($runningStoragePods.Count -ne 1) { throw "Expected exactly one Running Supabase Storage pod in $DataNamespace" }
Invoke-Kubectl @('-n', $DataNamespace, 'exec', [string]$runningStoragePods[0].metadata.name, '--', 'node', '/app/dist/scripts/migrate-call.js') | Out-Null

$ledgerExists = Invoke-OwnerSql "SELECT CASE WHEN to_regclass('console_migration.applied_migration') IS NULL THEN 'absent' ELSE 'present' END;"
if ($ledgerExists.Count -ne 1 -or $ledgerExists[0] -notin @('absent', 'present')) {
  throw 'Unable to establish fresh migration ledger state'
}
$migrationStatus = 'existing'
$appliedMigrationCount = 0
if ($ledgerExists[0] -eq 'present') {
  $currentLedger = Invoke-OwnerSql $ledgerSql
  if ($currentLedger.Count -ne 1) { throw 'Unable to establish fresh migration ledger state' }
  $appliedMigrationCount = Get-AppliedMigrationCount $currentLedger[0]
}

$migrationTool = Join-Path $PSScriptRoot 'console-migrations.mjs'
for ($migrationIndex = $appliedMigrationCount; $migrationIndex -lt [int]$migrationManifest.migrationCount; $migrationIndex++) {
  $migration = @($migrationManifest.migrations)[$migrationIndex]
  $migrationRenderArguments = @('render', [string]$migration.globalId)
  if ($VerifiedMaterializedRelease) { $migrationRenderArguments += '--verified-materialized-release' }
  $migrationSql = (& node $migrationTool @migrationRenderArguments | Out-String)
  if ($LASTEXITCODE -ne 0 -or -not $migrationSql.Trim()) { throw "Fresh migration renderer failed: $($migration.globalId)" }
  Invoke-OwnerMigrationSql $migrationSql
  $migrationSql = $null
  $migrationStatus = 'applied'
}

$ledger = Invoke-OwnerSql $ledgerSql
if ($ledger.Count -ne 1 -or $ledger[0] -ne $expectedLedger) {
  throw 'Console API runtime provisioning requires the exact fresh migration prefix'
}
Invoke-Kubectl @('-n', $DataNamespace, 'rollout', 'status', 'deployment/opensphere-supabase-rest', '--timeout=10m') | Out-Null
Invoke-Kubectl @('-n', $DataNamespace, 'rollout', 'status', 'deployment/opensphere-supabase-storage', '--timeout=10m') | Out-Null
$authorityState = Invoke-OwnerSql "SELECT rolname||'|'||rolcanlogin::text||'|'||rolsuper::text||'|'||rolcreaterole::text||'|'||rolcreatedb::text||'|'||rolreplication::text||'|'||rolbypassrls::text FROM pg_roles WHERE rolname='$authorityRole';"
if ($authorityState.Count -ne 1 -or $authorityState[0] -ne "$authorityRole|false|false|false|false|false|false") {
  throw 'Fresh console_api authority role attributes differ from the closed baseline'
}
$extensionAuthorityState = Invoke-OwnerSql "SELECT rolname||'|'||rolcanlogin::text||'|'||rolsuper::text||'|'||rolcreaterole::text||'|'||rolcreatedb::text||'|'||rolreplication::text||'|'||rolbypassrls::text FROM pg_roles WHERE rolname='$extensionAuthorityRole';"
if ($extensionAuthorityState.Count -ne 1 -or $extensionAuthorityState[0] -ne "$extensionAuthorityRole|false|false|false|false|false|false") {
  throw 'Fresh console_extension_controller authority role attributes differ from the closed baseline'
}

$roleState = Invoke-OwnerSql "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$roleName') THEN 'present' ELSE 'absent' END;"
if ($roleState.Count -ne 1 -or $roleState[0] -notin @('present', 'absent')) { throw 'Unable to establish runtime role state' }
$secretJson = (Invoke-Kubectl @('-n', $RuntimeNamespace, 'get', 'secret', $secretName, '--ignore-not-found', '-o', 'json') | Out-String).Trim()
$secretPresent = [bool]$secretJson

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
$sessionKeyBuffer = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($sessionKeyBuffer)
$sessionEncryptionKey = [Convert]::ToBase64String($sessionKeyBuffer)
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
  stringData = @{
    $secretKey = $databaseUrl
    $sessionEncryptionSecretKey = $sessionEncryptionKey
    $supabaseServiceRoleSecretKey = $serviceRoleCredential
  }
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
  $sessionEncryptionKey = $null
  $serviceRoleCredential = $null
  $secretManifest = $null
  [Array]::Clear($passwordBuffer, 0, $passwordBuffer.Length)
  [Array]::Clear($sessionKeyBuffer, 0, $sessionKeyBuffer.Length)
  [Array]::Clear($passwordChars, 0, $passwordChars.Length)
}
$runtimeStatus = 'provisioned'
}

$extensionRoleState = Invoke-OwnerSql "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$extensionRoleName') THEN 'present' ELSE 'absent' END;"
if ($extensionRoleState.Count -ne 1 -or $extensionRoleState[0] -notin @('present', 'absent')) { throw 'Unable to establish C_EXT runtime role state' }
$extensionSecretJson = (Invoke-Kubectl @('-n', $RuntimeNamespace, 'get', 'secret', $extensionSecretName, '--ignore-not-found', '-o', 'json') | Out-String).Trim()
$extensionSecretPresent = [bool]$extensionSecretJson
if (($extensionRoleState[0] -eq 'present') -ne $extensionSecretPresent) {
  throw 'Extension Controller runtime role and Secret are in a split provisioning state; no implicit repair or rotation was attempted'
}
$extensionRuntimeStatus = 'already-provisioned'
if ($extensionSecretPresent) {
  Test-ExtensionRuntimeRoleContract
  Test-ExtensionRuntimeLogin (Get-ExtensionRuntimePasswordFromSecret $extensionSecretJson)
} else {
  $extensionPasswordBuffer = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Fill($extensionPasswordBuffer)
  $extensionPasswordChars = New-Object char[] $extensionPasswordBuffer.Length
  $extensionAlphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  for ($index = 0; $index -lt $extensionPasswordBuffer.Length; $index++) {
    $extensionPasswordChars[$index] = $extensionAlphabet[$extensionPasswordBuffer[$index] % $extensionAlphabet.Length]
  }
  $extensionRuntimePassword = -join $extensionPasswordChars
  $extensionEscapedPassword = $extensionRuntimePassword.Replace("'", "''")
  $createExtensionRoleSql = @"
BEGIN;
DO `$role`$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$extensionRoleName') THEN
    RAISE EXCEPTION 'C_EXT runtime role appeared during provisioning';
  END IF;
END
`$role`$;
CREATE ROLE $extensionRoleName LOGIN PASSWORD '$extensionEscapedPassword'
  NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;
GRANT $extensionAuthorityRole TO $extensionRoleName;
ALTER ROLE $extensionRoleName SET search_path = pg_catalog;
ALTER ROLE $extensionRoleName SET statement_timeout = '15s';
ALTER ROLE $extensionRoleName SET lock_timeout = '3s';
COMMIT;
"@
  Invoke-OwnerSql $createExtensionRoleSql | Out-Null

  $encodedExtensionUser = [Uri]::EscapeDataString($extensionRoleName)
  $encodedExtensionPassword = [Uri]::EscapeDataString($extensionRuntimePassword)
  $extensionDatabaseUrl = "postgresql://${encodedExtensionUser}:${encodedExtensionPassword}@${databaseHost}:5432/postgres"
  $extensionSecretManifest = @{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = @{
      name = $extensionSecretName
      namespace = $RuntimeNamespace
      labels = @{
        'app.kubernetes.io/part-of' = 'opensphere-console'
        'opensphere.io/secret-scope' = 'extension-controller-only'
      }
    }
    type = 'Opaque'
    stringData = @{ $secretKey = $extensionDatabaseUrl }
  } | ConvertTo-Json -Depth 8 -Compress

  $extensionSecretCreated = $false
  try {
    Invoke-Kubectl @('create', '-f', '-') $extensionSecretManifest | Out-Null
    $extensionSecretCreated = $true
    Test-ExtensionRuntimeRoleContract
    Test-ExtensionRuntimeLogin $extensionRuntimePassword
  } catch {
    if ($extensionSecretCreated) {
      Invoke-Kubectl @('-n', $RuntimeNamespace, 'delete', 'secret', $extensionSecretName, '--wait=true') | Out-Null
    }
    Invoke-OwnerSql "DROP ROLE IF EXISTS $extensionRoleName;" | Out-Null
    throw
  } finally {
    $extensionRuntimePassword = $null
    $extensionEscapedPassword = $null
    $encodedExtensionPassword = $null
    $extensionDatabaseUrl = $null
    $extensionSecretManifest = $null
    [Array]::Clear($extensionPasswordBuffer, 0, $extensionPasswordBuffer.Length)
    [Array]::Clear($extensionPasswordChars, 0, $extensionPasswordChars.Length)
  }
  $extensionRuntimeStatus = 'provisioned'
}

$deploymentTemplate = Get-Content -Raw -LiteralPath $deploymentPath
if ([regex]::Matches($deploymentTemplate, [regex]::Escape('__OPENSPHERE_CONSOLE_API_IMAGE__')).Count -ne 1 -or
    [regex]::Matches($deploymentTemplate, [regex]::Escape('__OPENSPHERE_CONSOLE_URL__')).Count -ne 1) {
  throw 'C_API deployment image or public-origin placeholder contract is invalid'
}
$renderedDeployment = $deploymentTemplate.Replace('__OPENSPHERE_CONSOLE_API_IMAGE__', $ConsoleApiImage).Replace('__OPENSPHERE_CONSOLE_URL__', $ConsoleUrl)
if ($renderedDeployment -match '__OPENSPHERE_[A-Z0-9_]+__') { throw 'C_API deployment has unresolved placeholders' }
Invoke-Kubectl @('apply', '-f', '-') $renderedDeployment | Out-Null
Invoke-Kubectl @('-n', $RuntimeNamespace, 'rollout', 'status', 'deployment/opensphere-console-api', '--timeout=5m') | Out-Null
$installedImage = ((Invoke-Kubectl @('-n', $RuntimeNamespace, 'get', 'deployment/opensphere-console-api', '-o', 'jsonpath={.spec.template.spec.containers[0].image}')) -join '').Trim()
if ($installedImage -ne $ConsoleApiImage) { throw 'Installed C_API image differs from the requested exact digest' }

$extensionDeploymentTemplate = Get-Content -Raw -LiteralPath $extensionDeploymentPath
if ([regex]::Matches($extensionDeploymentTemplate, [regex]::Escape('__OPENSPHERE_EXTENSION_CONTROLLER_IMAGE__')).Count -ne 1) {
  throw 'C_EXT deployment image placeholder contract is invalid'
}
$renderedExtensionDeployment = $extensionDeploymentTemplate.Replace('__OPENSPHERE_EXTENSION_CONTROLLER_IMAGE__', $ExtensionControllerImage)
if ($renderedExtensionDeployment -match '__OPENSPHERE_[A-Z0-9_]+__') { throw 'C_EXT deployment has unresolved placeholders' }
Invoke-Kubectl @('apply', '-f', '-') $renderedExtensionDeployment | Out-Null
Invoke-Kubectl @('-n', $RuntimeNamespace, 'rollout', 'status', 'deployment/opensphere-extension-controller', '--timeout=5m') | Out-Null
$installedExtensionImage = ((Invoke-Kubectl @('-n', $RuntimeNamespace, 'get', 'deployment/opensphere-extension-controller', '-o', 'jsonpath={.spec.template.spec.containers[0].image}')) -join '').Trim()
if ($installedExtensionImage -ne $ExtensionControllerImage) { throw 'Installed C_EXT image differs from the requested exact digest' }

Write-Output (@{
  status = 'passed'
  dataStack = $dataStackStatus
  migration = $migrationStatus
  runtimeCredential = $runtimeStatus
  role = $roleName
  secret = "$RuntimeNamespace/$secretName"
  deployment = "$RuntimeNamespace/opensphere-console-api"
  image = $ConsoleApiImage
  extensionController = @{
    runtimeCredential = $extensionRuntimeStatus
    role = $extensionRoleName
    secret = "$RuntimeNamespace/$extensionSecretName"
    deployment = "$RuntimeNamespace/opensphere-extension-controller"
    image = $ExtensionControllerImage
  }
} | ConvertTo-Json -Compress)
