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

# Execute the production Beszel consumer refresh branch without a cluster.
$beszelSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../deploy/baseline-monitoring/install.ps1'))
$begin = $beszelSource.IndexOf('# Fresh bootstrap creates the reader Secret')
$end = $beszelSource.IndexOf("Write-Host 'Console baseline host observation", $begin)
if ($begin -lt 0 -or $end -le $begin) { throw 'Missing Beszel consumer refresh branch' }
$refreshConsumer = [scriptblock]::Create($beszelSource.Substring($begin, $end - $begin))
$calls = [Collections.Generic.List[object]]::new()
# Keep the production lookup helper: a successful native command with no stdout
# passes through PowerShell as null, unlike the old mock's empty string.
$beszelTokens = $null; $beszelParseErrors = $null
$beszelAst = [Management.Automation.Language.Parser]::ParseInput($beszelSource, [ref]$beszelTokens, [ref]$beszelParseErrors)
if ($beszelParseErrors.Count) { throw 'Beszel installer parse failed' }
$lookupDefinition = $beszelAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-KubectlValue' }, $true)
if (-not $lookupDefinition) { throw 'Missing production Beszel lookup helper' }
. ([scriptblock]::Create($lookupDefinition.Extent.Text))
$KubectlContext = 'fixture-no-cluster'
$nativeLookupFixture = "const mode = process.argv[1]; if (mode === 'forbidden') process.exit(7); if (mode === 'present') process.stdout.write('deployment.apps/opensphere-console-api\n'); if (mode === 'wrong-identity') process.stdout.write('deployment.apps/unrelated\n');"
function kubectl {
  if ($args -notcontains '--ignore-not-found' -or $args -notcontains 'opensphere-console-api' -or
      $args -notcontains 'fixture-no-cluster') {
    throw 'Consumer lookup must distinguish absence from read failure'
  }
  & $nodeExecutable -e $nativeLookupFixture -- $scenario
}
function Invoke-Kubectl([string[]]$Arguments) { $calls.Add($Arguments) }
foreach ($scenario in @('absent', 'present', 'forbidden', 'wrong-identity')) {
  $calls.Clear()
  $failed = $false
  try { . $refreshConsumer } catch { $failed = $true }
  if ($scenario -eq 'absent' -and $null -ne $consoleApi) {
    throw 'Fresh absence fixture must reproduce native no-output as null'
  }
  if ($scenario -eq 'absent' -and ($failed -or $calls.Count -ne 0)) {
    throw 'Fresh Beszel install tried to restart an absent API'
  }
  if ($scenario -eq 'present' -and ($failed -or $calls.Count -ne 2 -or
      $calls[0] -notcontains 'restart' -or $calls[1] -notcontains 'status')) {
    throw 'Existing API did not reload the reader projection with readiness verification'
  }
  if ($scenario -in @('forbidden', 'wrong-identity') -and (-not $failed -or $calls.Count -ne 0)) {
    throw 'API lookup failure or wrong identity was treated as harmless absence'
  }
}
Write-Output '{"beszelFreshConsumerAbsence":true,"actualBeszelLookupHelper":true,"nativeNoOutputIsNull":true,"existingConsumerRefresh":true,"lookupErrorsFailClosed":true,"clusterAccess":false}'