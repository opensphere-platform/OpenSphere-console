import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Supabase backbone manifest and migrations satisfy ADR-006 static boundary', () => {
  const result = spawnSync(process.execPath, [path.join(here, 'verify.mjs')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
});

test('Supabase installer delimits migration identifiers before punctuation', () => {
  const installer = readFileSync(path.join(here, 'install.ps1'), 'utf8');
  assert.match(installer, /Migration checksum drift for \$\{migrationId\}:/);
  assert.doesNotMatch(installer, /Migration checksum drift for \$migrationId:/);
});

test('Console release source contains every current Setup migration contract', () => {
  const cephRuntime = readFileSync(
    path.join(here, 'migrations', '0030_ceph_data_path_verification_runtime.sql'),
    'utf8'
  );
  const foundationBootstrap = readFileSync(
    path.join(here, 'migrations', '0031_foundation_bootstrap_consumer.sql'),
    'utf8'
  );

  assert.match(cephRuntime, /opensphere\.ceph\.rook-prerequisite\/v2/);
  assert.match(foundationBootstrap, /opensphere\.foundation\.bootstrap\/v1/);
  assert.match(foundationBootstrap, /browserWrite":false/);
});
