import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runner = readFileSync(new URL('./r2d2-local-edge-repair-runner.mjs', import.meta.url), 'utf8');
const wrapper = readFileSync(new URL('./Invoke-LocalEdgeR2D2RepairRunner.ps1', import.meta.url), 'utf8');

test('Repair Runner exposes no arbitrary command or shell surface', () => {
  assert.match(runner, /spawn\(program, args, \{[\s\S]*shell: false/u);
  assert.doesNotMatch(runner, /exec\(|execSync\(|shell:\s*true|Invoke-Expression|cmd\.exe/u);
  assert.match(runner, /validateLocalEdgeRepair/u);
});

test('Repair Runner reuses component-only publishers and the governed release entrypoint', () => {
  assert.match(runner, /Invoke-LocalEdgePlatformRelease\.ps1/u);
  assert.doesNotMatch(runner, /Publish-LocalEdge\.ps1['"]/u);
});

test('Repair Runner requires exact source, image, installation lock and authenticated browser evidence', () => {
  assert.match(runner, /force-with-lease=refs\/heads\/main:/u);
  assert.match(runner, /browser-verification/u);
  assert.match(runner, /observedSourceRevision === build\.sourceRevision/u);
  assert.match(runner, /opensphere-installation-lock/u);
  assert.match(runner, /rollbackImageDigests/u);
});

test('host wrapper binds runner code to deployed Backend authority on Windows Docker Desktop', () => {
  assert.match(wrapper, /Windows Docker Desktop host/u);
  assert.match(wrapper, /docker-desktop/u);
  assert.match(wrapper, /components\.backend\.sourceRevision/u);
  assert.match(wrapper, /git -C \$repoRoot diff --name-only \$backendRevision HEAD/u);
});

test('supervised Repair Runner survives transient API failures with bounded backoff', () => {
  assert.match(runner, /function retryDelayMs\(consecutiveFailures\)/u);
  assert.match(runner, /Math\.min\(30_000/u);
  assert.match(runner, /RepairRunnerRetry/u);
  assert.match(runner, /if \(once\) throw error/u);
});
