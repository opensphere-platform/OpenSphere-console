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

test('the database contract waits for the server that outlives its own bootstrap', () => {
  // The Supabase image runs a temporary server during initdb that listens on
  // the Unix socket only, and it has already created auth, extensions and
  // storage by the time it is stopped. So a readiness probe over the socket
  // answers "ready" from a server about to shut down — measured at t=2s here,
  // against t=3s for the one that survives. Losing that race aborts the
  // contract suite partway through with "the database system is shutting down".
  //
  // That is not merely flakiness. Every SQL mutation in the sweep is scored by
  // this suite failing, so a container that died on its own would have been
  // recorded as a guard being caught. The invariant is asserted from here, in a
  // test that needs no Docker, so it holds even where the contract suite skips.
  //
  // The distinguishing fact is the listener: only the final server opens TCP.
  const source = readFileSync(path.join(here, 'db-contract.test.mjs'), 'utf8');
  const probes = [...source.matchAll(/spawnSync\('docker', \[[^\]]*pg_namespace[^\]]*\]/g)].map((m) => m[0]);
  assert.equal(probes.length, 2,
    `both container bootstraps must wait for readiness, found ${probes.length} probes`);
  for (const probe of probes) {
    assert.match(probe, /'-h', '127\.0\.0\.1'/,
      'a probe over the Unix socket answers from the initdb server that is about to exit');
  }
  // Quoted, so this matches an invocation rather than the comment that explains
  // why pg_isready is not used — it answers from the bootstrap server as well.
  assert.doesNotMatch(source, /'pg_isready'/,
    'pg_isready answers from the bootstrap server too, so it is not a readiness signal');
});

test('Supabase installer delimits migration identifiers before punctuation', () => {
  const installer = readFileSync(path.join(here, 'install.ps1'), 'utf8');
  assert.match(installer, /Migration checksum drift for \$\{migrationId\}:/);
  assert.doesNotMatch(installer, /Migration checksum drift for \$migrationId:/);
});
