$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $parseErrors = $null
$sourcePath = Join-Path $PSScriptRoot 'Install-ConsoleApiRuntime.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Installer parse failed' }
foreach ($name in @('Write-InstallProgress','Start-InstallStage','Complete-InstallStage','Invoke-KubectlWait','Get-RuntimePasswordFromSecret')) {
  $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $definition) { throw "Missing production function: $name" }
  . ([scriptblock]::Create($definition.Extent.Text))
}
$secretKey = 'database-url'; $sessionEncryptionSecretKey = 'session-encryption-key'
$supabaseServiceRoleSecretKey = 'supabase-service-role-key'
$DataNamespace = 'opensphere-console-data'; $roleName = 'opensphere_console_api_runtime'
$serviceRoleCredential = [Guid]::NewGuid().ToString()
$password = [Guid]::NewGuid().ToString()
$databaseUrl = "postgresql://${roleName}:${password}@opensphere-supabase-postgres.${DataNamespace}.svc.cluster.local/postgres"
function Encode([string]$Value) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value)) }
function Fixture([string]$KeyText) {
  @{ type = 'Opaque'; data = @{
    'database-url' = (Encode $databaseUrl)
    'session-encryption-key' = (Encode $KeyText)
    'supabase-service-role-key' = (Encode $serviceRoleCredential)
  } } | ConvertTo-Json -Depth 5 -Compress
}
$bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
try {
  $key = [Convert]::ToBase64String($bytes)
  $valid = Fixture $key
  if ((Get-RuntimePasswordFromSecret $valid) -cne $password) { throw 'Existing credential not preserved' }
  if ((Get-RuntimePasswordFromSecret $valid) -cne $password) { throw 'Repeated Secret read failed' }
  foreach ($bad in @('not-base64', [Convert]::ToBase64String([byte[]]::new(31)), [Convert]::ToBase64String([byte[]]::new(33)), ($key + ' '))) {
    $rejected = $false
    try { Get-RuntimePasswordFromSecret (Fixture $bad) | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid session key was accepted' }
  }
  $malformed = $valid | ConvertFrom-Json
  $malformed.data.'session-encryption-key' = $key
  $rejected = $false
  try { Get-RuntimePasswordFromSecret ($malformed | ConvertTo-Json -Depth 5 -Compress) | Out-Null } catch { $rejected = $true }
  if (-not $rejected) { throw 'Raw bytes were accepted where base64 text is required' }
} finally {
  [Array]::Clear($bytes, 0, $bytes.Length)
  $key = $null; $password = $null; $serviceRoleCredential = $null; $valid = $null
}
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
# Replace only command discovery in this isolated test process. No kubectl
# or cluster access occurs: the existing readiness runner invokes a Node fixture.
function Get-Command([string]$Name) {
  if ($Name -ne 'kubectl') { throw 'Unexpected test command discovery' }
  [pscustomobject]@{ Source = $nodeExecutable }
}
$fixturePath = Join-Path ([IO.Path]::GetTempPath()) ('opensphere-progress-test-' + [Guid]::NewGuid().ToString('N') + '.cjs')
$fixtureCode = @'
const mode = process.argv[2];
process.stdout.write('Waiting for deployment "fixture" rollout to finish: 0 of 1 updated replicas are available...\n');
setTimeout(() => {
  if (mode === 'fail') {
    process.stderr.write('private-provider-sentinel\nerror: timed out waiting for the condition\n');
    process.exit(1);
  }
  process.stdout.write('deployment "fixture" successfully rolled out\n');
}, 350);
'@
$originalError = [Console]::Error
$progress = [IO.StringWriter]::new()
try {
  [IO.File]::WriteAllText($fixturePath, $fixtureCode)
  [Console]::SetError($progress)
  $kubectlArgs = @($fixturePath, 'success')
  Start-InstallStage 7 'Supabase REST'
  $output = @(Invoke-KubectlWait @('rollout', 'status') -HeartbeatSeconds 0.05)
  Complete-InstallStage
  if ($output.Count -ne 2 -or $output[1] -notmatch 'successfully rolled out') { throw 'Readiness stdout contract changed' }
  if ([regex]::Matches($progress.ToString(), '\[대기 07/12\]').Count -lt 2) { throw 'Missing live readiness heartbeat' }
  if ($progress.ToString() -notmatch '\[완료 07/12\].*\([0-9]+\.[0-9]s\)') { throw 'Missing elapsed completion' }
  $progress.GetStringBuilder().Clear() | Out-Null
  $kubectlArgs = @($fixturePath, 'fail')
  Start-InstallStage 7 'Supabase REST'
  $rejected = $false
  try { Invoke-KubectlWait @('rollout', 'status') -HeartbeatSeconds 0.05 | Out-Null } catch { $rejected = $true }
  if (-not $rejected -or $progress.ToString() -notmatch '\[실패 07/12\]') { throw 'Failed readiness was not reported' }
  if ($progress.ToString() -match 'private-provider-sentinel|\[완료') { throw 'Sensitive stderr or false completion leaked' }
} finally {
  [Console]::SetError($originalError)
  $progress.Dispose()
  if ([IO.File]::Exists($fixturePath)) { [IO.File]::Delete($fixturePath) }
}
Write-Output '{"status":"passed","actualInstallerFunctions":true,"existingSecretReuse":true,"invalidSessionKeysRejected":5,"liveProgressHeartbeat":true,"stdoutPreserved":true,"failureAndStderrSafety":true,"clusterAccess":false}'
