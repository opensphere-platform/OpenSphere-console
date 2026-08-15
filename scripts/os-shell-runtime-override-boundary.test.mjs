import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertHeadPaths, assertRuntimeOverridePaths, deploymentToolingPaths,
} from './os-shell-runtime-override-boundary.mjs';

const validRuntime = [
  'backend/os-cli/cmd/os-shell-runtime/agent.go',
  'backend/os-cli/cmd/os-shell-runtime/runtime_directory.go',
  'backend/os-cli/Dockerfile.runtime',
];

test('runtime override is closed over runtime source and its dedicated build overlay only', () => {
  assert.doesNotThrow(() => assertRuntimeOverridePaths(validRuntime));
  for (const path of [
    'backend/supabase/migrate-only.ps1',
    'backend/os-shell-control/deploy.yaml',
    'backend/os-cli/cmd/os/operator.go',
    'backend/os-cli/cmd/os/web_shell_agent.go',
    'backend/os-cli/go.mod',
  ]) {
    assert.throws(() => assertRuntimeOverridePaths([...validRuntime, path]), /non-runtime authority/);
  }
  assert.throws(() => assertRuntimeOverridePaths([]), /no changed runtime input/);
});

test('deployment HEAD is limited to exact runtime evidence plus closed deployment tooling', () => {
  assert.doesNotThrow(() => assertHeadPaths([...validRuntime, ...deploymentToolingPaths], validRuntime));
  assert.throws(
    () => assertHeadPaths([...validRuntime, 'backend/supabase/migrate-only.ps1'], validRuntime),
    /unbound source/,
  );
  assert.throws(
    () => assertHeadPaths([...validRuntime, 'backend/os-cli/cmd/os/operator.go'], validRuntime),
    /unbound source/,
  );
});
