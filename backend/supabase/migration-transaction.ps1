param(
  [switch]$Emit,
  [string]$MigrationPath = '',
  [string]$MigrationId = '',
  [string]$Checksum = '',
  [string]$SourceRevision = ''
)

function New-SupabaseMigrationTransactionSql {
  param(
    [Parameter(Mandatory = $true)][string]$MigrationSql,
    [Parameter(Mandatory = $true)][string]$MigrationId,
    [Parameter(Mandatory = $true)][string]$Checksum,
    [Parameter(Mandatory = $true)][string]$SourceRevision
  )

  if ($MigrationId -notmatch '^\d{4}_[a-z0-9_]+$') { throw "Invalid migration id: $MigrationId" }
  if ($Checksum -notmatch '^[a-f0-9]{64}$') { throw "Invalid migration checksum for $MigrationId" }
  if ($SourceRevision -notmatch '^[a-f0-9]{40}$') { throw "Invalid source revision for $MigrationId" }
  if ($MigrationSql -match '(?im)^\s*(BEGIN|COMMIT)\s*;') {
    throw "Migration $MigrationId must not contain transaction control; the installer owns atomic attestation"
  }

  return @"
BEGIN;
$MigrationSql
INSERT INTO console.schema_migration(migration_id, sha256, source_revision, executor)
VALUES ('$MigrationId', '$Checksum', '$SourceRevision', current_user);
COMMIT;
"@
}

if ($Emit) {
  if (-not $MigrationPath -or -not (Test-Path -LiteralPath $MigrationPath)) {
    throw "MigrationPath is required when -Emit is used"
  }
  $sql = New-SupabaseMigrationTransactionSql `
    -MigrationSql (Get-Content -Raw -LiteralPath $MigrationPath) `
    -MigrationId $MigrationId `
    -Checksum $Checksum `
    -SourceRevision $SourceRevision
  [Console]::Out.Write($sql)
}
