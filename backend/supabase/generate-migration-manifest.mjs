import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const directory = join(here, 'migrations');
const names = (await readdir(directory))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
  .sort();

if (names.length === 0 || new Set(names.map((name) => name.slice(0, 4))).size !== names.length) {
  throw new Error('migration IDs must be unique and non-empty');
}

const migrations = [];
for (const name of names) {
  const canonical = (await readFile(join(directory, name), 'utf8')).replace(/\r\n/gu, '\n');
  migrations.push({
    id: name.slice(0, 4),
    name,
    path: `backend/supabase/migrations/${name}`,
    sha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  });
}
const setMaterial = migrations.map(({ name, sha256 }) => `${name}\n${sha256}`).join('\n');
const manifest = {
  schemaVersion: 1,
  latestMigrationId: migrations.at(-1).id,
  migrationCount: migrations.length,
  setDigest: `sha256:${createHash('sha256').update(setMaterial, 'utf8').digest('hex')}`,
  migrations,
};
await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
