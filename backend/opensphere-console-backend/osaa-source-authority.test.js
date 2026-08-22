'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  SOURCE_REPOSITORIES,
  catalogProjection,
  createCanonicalSourceEvidence,
  engineeringRepositoryPolicy,
  exactRevision,
  validatedArchiveListing,
} = require('./osaa-source-authority');

const revision = 'a'.repeat(40);

test('source authority follows canonical GitHub inventory and never treats Gitea as implementation source', () => {
  const catalog = catalogProjection(false);
  assert.equal(catalog.authority, 'GitHub opensphere-platform');
  assert.equal(catalog.inventory, 'OpenSphere-Platform-V2/repository-inventory.json');
  assert.equal(SOURCE_REPOSITORIES.console.canonicalUrl, 'https://github.com/opensphere-platform/OpenSphere-console.git');
  assert.doesNotMatch(JSON.stringify(catalog), /gitea/i);
  assert.equal(catalog.repositories.find((item) => item.id === 'console').accessible, true);
  assert.equal(catalog.repositories.find((item) => item.id === 'platform-v2').accessible, false);
  assert.equal(catalog.repositories.find((item) => item.id === 'platform-v2').blocker, 'github_source_credential_unavailable');
  const engineering = engineeringRepositoryPolicy();
  assert.equal(engineering.console.url, SOURCE_REPOSITORIES.console.canonicalUrl);
  assert.equal(Object.hasOwn(engineering, 'platform-v2'), false);
});

test('exact source revision and archive paths fail closed', () => {
  assert.equal(exactRevision(revision), revision);
  assert.throws(() => exactRevision('main'), (error) => error?.code === 400);
  assert.deepEqual(validatedArchiveListing(Buffer.from('OpenSphere-console-a/src/a.ts\nOpenSphere-console-a/backend/b.js\n')), {
    root: 'OpenSphere-console-a', entries: 2,
  });
  assert.throws(() => validatedArchiveListing(Buffer.from('root/a\nother/b\n')), (error) => error?.code === 502);
  assert.throws(() => validatedArchiveListing(Buffer.from('root/../secret\n')), (error) => error?.code === 502);
});

test('OSAA reads and searches only bounded allowlisted text at one exact revision', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'osaa-source-authority-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'backend', 'opensphere-console-osaa-gateway'), { recursive: true });
  await fsp.mkdir(path.join(root, 'src', 'app'), { recursive: true });
  await fsp.writeFile(path.join(root, 'backend', 'opensphere-console-osaa-gateway', 'server.js'), [
    "const authority = 'runtime';",
    "const diagnosis = 'HOST_NAVIGATION_LAZY_UI_SEPARATION';",
    'module.exports = { authority, diagnosis };',
  ].join('\n'));
  await fsp.writeFile(path.join(root, 'src', 'app', 'index.ts'), "export const ready = true;\n");
  await fsp.writeFile(path.join(root, 'secret.env'), 'PASSWORD=must-not-read\n');

  const source = createCanonicalSourceEvidence({ materializeRevision: async (repository, requestedRevision) => {
    assert.equal(repository.id, 'console'); assert.equal(requestedRevision, revision); return root;
  } });
  const read = await source.readSource({
    repositoryId: 'console', revision, path: 'backend/opensphere-console-osaa-gateway/server.js', startLine: 2, endLine: 3,
  });
  assert.equal(read.revision, revision);
  assert.equal(read.startLine, 2);
  assert.match(read.text, /HOST_NAVIGATION_LAZY_UI_SEPARATION/);
  assert.match(read.digest, /^sha256:[0-9a-f]{64}$/);

  const search = await source.searchSource({ repositoryId: 'console', revision, query: 'runtime', pathPrefix: 'backend/', limit: 10 });
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].path, 'backend/opensphere-console-osaa-gateway/server.js');
  assert.equal(search.items[0].line, 1);
  assert.equal(search.complete, true);
  await assert.rejects(() => source.readSource({ repositoryId: 'console', revision, path: 'secret.env' }), (error) => error?.code === 403);
  await assert.rejects(() => source.searchSource({ repositoryId: 'console', revision, query: 'runtime', extra: true }), (error) => error?.code === 400);
});

test('branch resolution returns an exact revision and private authority stays unavailable without a credential', async () => {
  const source = createCanonicalSourceEvidence({ fetchImpl: async (url) => ({
    ok: true, status: 200, json: async () => ({ sha: revision }), url,
  }) });
  const head = await source.resolveHead({ repositoryId: 'console' });
  assert.equal(head.revision, revision);
  assert.equal(head.resolvedFrom, 'main');
  await assert.rejects(() => source.resolveHead({ repositoryId: 'platform-v2' }), (error) => error?.code === 503);
});
