import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
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

test('released migration history is immutable and numeric prefixes are never reused', () => {
  const lock = JSON.parse(readFileSync(path.join(here, 'migration-history-lock.json'), 'utf8'));
  const migrationDir = path.join(here, 'migrations');
  const files = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
  const prefixes = new Map();

  for (const file of files) {
    const id = file.slice(0, -4);
    assert.match(id, /^\d{4}_[a-z0-9_]+$/, `invalid migration name: ${file}`);
    const prefix = id.slice(0, 4);
    assert.equal(prefixes.has(prefix), false,
      `migration number ${prefix} is reused by ${prefixes.get(prefix)} and ${file}`);
    prefixes.set(prefix, file);
  }

  const lockedEntries = Object.entries(lock.migrations);
  const highestLockedPrefix = Math.max(...lockedEntries.map(([id]) => Number(id.slice(0, 4))));
  for (const [id, expected] of lockedEntries) {
    const file = `${id}.sql`;
    assert.ok(files.includes(file), `released migration was removed or renamed: ${file}`);
    const canonical = readFileSync(path.join(migrationDir, file), 'utf8').replace(/\r\n/g, '\n');
    const actual = createHash('sha256').update(canonical, 'utf8').digest('hex');
    assert.equal(actual, expected, `released migration content changed: ${file}`);
  }

  for (const file of files) {
    const id = file.slice(0, -4);
    if (Number(id.slice(0, 4)) <= highestLockedPrefix) {
      assert.ok(Object.hasOwn(lock.migrations, id),
        `migration ${file} reuses released history; allocate a number after ${highestLockedPrefix}`);
    }
  }
});
