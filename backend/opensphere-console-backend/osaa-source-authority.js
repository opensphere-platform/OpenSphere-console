'use strict';

const { createHash } = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const EXACT_REVISION_RE = /^[0-9a-f]{40}$/;
const TEXT_EXTENSIONS = Object.freeze(new Set([
  '', '.css', '.dockerfile', '.html', '.js', '.json', '.md', '.mjs', '.ps1',
  '.scss', '.sh', '.sql', '.ts', '.txt', '.yaml', '.yml',
]));

// Release-bound projection of repository-inventory.json. The canonical host
// and URLs follow CONSTITUTION-0006; this catalog deliberately starts with the
// repositories needed by the first OSAA repair slices. A missing repository is
// reported as a coverage gap instead of being guessed from Gitea or a workspace.
const SOURCE_REPOSITORIES = Object.freeze({
  'platform-v2': Object.freeze({
    id: 'platform-v2', owner: 'opensphere-platform', repository: 'OpenSphere-Platform-V2',
    canonicalUrl: 'https://github.com/opensphere-platform/OpenSphere-Platform-V2.git',
    defaultBranch: 'main', visibility: 'private', kind: 'governance',
    allowedReadPaths: Object.freeze(['_DOCS_/', 'repository-inventory.json']),
  }),
  console: Object.freeze({
    id: 'console', owner: 'opensphere-platform', repository: 'OpenSphere-console',
    canonicalUrl: 'https://github.com/opensphere-platform/OpenSphere-console.git',
    defaultBranch: 'main', visibility: 'public', kind: 'mainShell',
    allowedReadPaths: Object.freeze(['backend/', 'docs/', 'nginx/', 'scripts/', 'src/', 'angular.json', 'package.json']),
    engineering: Object.freeze({
      allowedPaths: Object.freeze(['backend/', 'src/', 'nginx/', 'docs/']),
      components: Object.freeze(['console', 'consoleBackend', 'osaaGateway']),
    }),
  }),
  'setup-cli': Object.freeze({
    id: 'setup-cli', owner: 'opensphere-platform', repository: 'OpenSphere-Setup-CLI',
    canonicalUrl: 'https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git',
    defaultBranch: 'main', visibility: 'private', kind: 'installer',
    allowedReadPaths: Object.freeze(['deploy/', 'docs/', 'src/', 'tests/']),
    engineering: Object.freeze({
      allowedPaths: Object.freeze(['src/', 'deploy/', 'tests/', 'docs/']),
      components: Object.freeze(['setup']),
    }),
  }),
  'shell-cluster-manager': Object.freeze({
    id: 'shell-cluster-manager', owner: 'opensphere-platform', repository: 'OpenSphere-shell-clusterManager',
    canonicalUrl: 'https://github.com/opensphere-platform/OpenSphere-shell-clusterManager.git',
    defaultBranch: 'main', visibility: 'public', kind: 'subShell',
    allowedReadPaths: Object.freeze(['backend/', 'docs/', 'src/', 'tests/']),
    engineering: Object.freeze({
      allowedPaths: Object.freeze(['src/', 'backend/', 'tests/']),
      components: Object.freeze(['clusterManager']),
    }),
  }),
  'shell-foundation': Object.freeze({
    id: 'shell-foundation', owner: 'opensphere-platform', repository: 'OpenSphere-shell-foundation',
    canonicalUrl: 'https://github.com/opensphere-platform/OpenSphere-shell-foundation.git',
    defaultBranch: 'main', visibility: 'public', kind: 'subShell',
    allowedReadPaths: Object.freeze(['backend/', 'docs/', 'src/', 'tests/']),
    engineering: Object.freeze({
      allowedPaths: Object.freeze(['src/', 'backend/', 'tests/']),
      components: Object.freeze(['foundation']),
    }),
  }),
});

function repositoryPolicy(repositoryId) {
  const repository = SOURCE_REPOSITORIES[String(repositoryId || '').trim()];
  if (!repository) throw { code: 400, msg: 'repositoryId is outside the release-bound source authority catalog' };
  return repository;
}

function exactRevision(value) {
  const revision = String(value || '').trim().toLowerCase();
  if (!EXACT_REVISION_RE.test(revision)) throw { code: 400, msg: 'revision must be an exact 40-character canonical GitHub commit SHA' };
  return revision;
}

function normalizedRelativePath(value, field = 'path') {
  const candidate = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!candidate || candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate) || candidate.includes('\0')) {
    throw { code: 400, msg: `${field} must be repository-relative` };
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === '..' || normalized.startsWith('../')) throw { code: 400, msg: `${field} escapes the repository` };
  return normalized;
}

function pathAllowed(repository, candidate) {
  return repository.allowedReadPaths.some((allowed) => candidate === allowed || candidate.startsWith(allowed.endsWith('/') ? allowed : `${allowed}/`));
}

function authorizedPath(repository, value, field = 'path') {
  const candidate = normalizedRelativePath(value, field);
  if (!pathAllowed(repository, candidate)) throw { code: 403, msg: `${field} is outside the repository source-evidence allowlist` };
  return candidate;
}

function closedObject(value, allowed, label) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const extra = Object.keys(row).filter((key) => !allowed.includes(key));
  if (extra.length) throw { code: 400, msg: `${label} contains unsupported fields: ${extra.join(', ')}` };
  return row;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function publicRepository(repository, tokenConfigured) {
  return {
    id: repository.id,
    canonicalUrl: repository.canonicalUrl,
    defaultBranch: repository.defaultBranch,
    visibility: repository.visibility,
    kind: repository.kind,
    allowedReadPaths: [...repository.allowedReadPaths],
    accessible: repository.visibility === 'public' || tokenConfigured,
    blocker: repository.visibility === 'private' && !tokenConfigured ? 'github_source_credential_unavailable' : null,
  };
}

function catalogProjection(tokenConfigured) {
  return {
    apiVersion: 'opensphere.io/osaa-source-authority/v1',
    authority: 'GitHub opensphere-platform',
    inventory: 'OpenSphere-Platform-V2/repository-inventory.json',
    inventoryMode: 'release-bound-curated-projection',
    coverage: 'partial',
    repositories: Object.values(SOURCE_REPOSITORIES).map((repository) => publicRepository(repository, tokenConfigured)),
  };
}

function runTar(args, maximumOutput = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = []; let stdoutBytes = 0; let stderrBytes = 0;
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maximumOutput) stdout.push(chunk);
      else child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 65536) stderr.push(chunk);
    });
    child.on('error', (error) => reject(Object.assign(error, { code: 'SourceArchiveExtractorUnavailable' })));
    child.on('close', (code) => {
      if (code === 0 && stdoutBytes <= maximumOutput) return resolve(Buffer.concat(stdout));
      reject(Object.assign(new Error(`canonical source archive extraction failed: ${Buffer.concat(stderr).toString('utf8').slice(0, 240)}`), {
        code: stdoutBytes > maximumOutput ? 'SourceArchiveListingTooLarge' : 'SourceArchiveExtractionFailed',
      }));
    });
  });
}

async function boundedDownload(response, maximumBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maximumBytes) throw { code: 413, msg: 'canonical source archive exceeds the configured size limit' };
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      await response.body?.cancel?.().catch(() => undefined);
      throw { code: 413, msg: 'canonical source archive exceeds the configured size limit' };
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function validatedArchiveListing(buffer) {
  const entries = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw { code: 502, msg: 'canonical source archive is empty' };
  let root = null;
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.includes('\0')) throw { code: 502, msg: 'canonical source archive contains an unsafe path' };
    const segments = normalized.split('/').filter(Boolean);
    if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) throw { code: 502, msg: 'canonical source archive contains an unsafe path' };
    if (root === null) root = segments[0];
    if (segments[0] !== root) throw { code: 502, msg: 'canonical source archive has more than one root' };
  }
  return { root, entries: entries.length };
}

async function defaultMaterializeRevision(repository, revision, options) {
  const cacheRoot = options.cacheRoot;
  const finalPath = path.join(cacheRoot, repository.id, revision);
  try {
    const marker = JSON.parse(await fsp.readFile(path.join(finalPath, '.opensphere-source-evidence.json'), 'utf8'));
    if (marker.revision === revision && marker.canonicalUrl === repository.canonicalUrl) return finalPath;
  } catch { /* cache miss */ }

  await fsp.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
  const temporary = await fsp.mkdtemp(path.join(path.dirname(finalPath), `.materialize-${revision.slice(0, 12)}-`));
  const archivePath = path.join(temporary, 'source.tar.gz');
  try {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'OpenSphere-OSAA-source-evidence' };
    if (options.githubToken) headers.authorization = `Bearer ${options.githubToken}`;
    const archiveUrl = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/tarball/${revision}`;
    const response = await options.fetchImpl(archiveUrl, { headers, redirect: 'follow', signal: AbortSignal.timeout(options.timeoutMs) });
    const finalUrl = new URL(response.url || archiveUrl);
    if (!['api.github.com', 'codeload.github.com', 'github.com'].includes(finalUrl.hostname)) throw { code: 502, msg: 'canonical source archive redirected outside GitHub' };
    if (!response.ok) throw { code: response.status, msg: `canonical GitHub source archive returned HTTP ${response.status}` };
    await fsp.writeFile(archivePath, await boundedDownload(response, options.maximumArchiveBytes), { mode: 0o600 });
    const listing = validatedArchiveListing(await runTar(['-tzf', archivePath], options.maximumListingBytes));
    const extracted = path.join(temporary, 'tree');
    await fsp.mkdir(extracted, { recursive: true, mode: 0o700 });
    await runTar(['-xzf', archivePath, '-C', extracted, '--strip-components=1', '--no-same-owner', '--no-same-permissions'], 1024);
    await fsp.writeFile(path.join(extracted, '.opensphere-source-evidence.json'), JSON.stringify({
      canonicalUrl: repository.canonicalUrl, revision, archiveRoot: listing.root, materializedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    await fsp.rm(archivePath, { force: true });
    await fsp.rename(extracted, finalPath).catch(async (error) => {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    });
    return finalPath;
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function walkTextFiles(root, relative, limits, output) {
  if (output.complete === false) return;
  const absolute = path.resolve(root, relative);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (absolute !== path.resolve(root) && !absolute.startsWith(rootPrefix)) throw { code: 500, msg: 'materialized source path escaped its cache root' };
  let stat;
  try { stat = await fsp.stat(absolute); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isFile()) {
    const extension = path.extname(relative).toLowerCase();
    const base = path.basename(relative).toLowerCase();
    if ((!TEXT_EXTENSIONS.has(extension) && base !== 'dockerfile') || stat.size > limits.maximumFileBytes) return;
    output.files.push({ relative, absolute, size: stat.size });
    output.totalBytes += stat.size;
    if (output.files.length >= limits.maximumFiles || output.totalBytes >= limits.maximumSearchBytes) output.complete = false;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of await fsp.readdir(absolute, { withFileTypes: true })) {
    if (output.complete === false) break;
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.opensphere-source-evidence.json') continue;
    await walkTextFiles(root, path.posix.join(relative.replace(/\\/g, '/'), entry.name), limits, output);
  }
}

function lineProjection(content, startLine, endLine) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(1, Number(startLine || 1));
  const requestedEnd = Number(endLine || Math.min(lines.length, start + 199));
  const end = Math.min(lines.length, requestedEnd, start + 399);
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || requestedEnd < start) throw { code: 400, msg: 'source line range is invalid' };
  return { startLine: start, endLine: end, totalLines: lines.length, text: lines.slice(start - 1, end).join('\n') };
}

function createCanonicalSourceEvidence(options = {}) {
  const githubToken = String(options.githubToken || '').trim();
  const cacheRoot = path.resolve(options.cacheRoot || path.join(os.tmpdir(), 'opensphere-osaa-source'));
  const materialize = options.materializeRevision || ((repository, revision) => defaultMaterializeRevision(repository, revision, {
    cacheRoot, githubToken, fetchImpl: options.fetchImpl || fetch,
    timeoutMs: options.timeoutMs || 30000,
    maximumArchiveBytes: options.maximumArchiveBytes || 64 * 1024 * 1024,
    maximumListingBytes: options.maximumListingBytes || 8 * 1024 * 1024,
  }));
  const limits = {
    maximumFileBytes: options.maximumFileBytes || 256 * 1024,
    maximumFiles: options.maximumFiles || 2000,
    maximumSearchBytes: options.maximumSearchBytes || 24 * 1024 * 1024,
  };
  const inFlight = new Map();
  const materialized = async (repository, revision) => {
    const key = `${repository.id}:${revision}`;
    if (!inFlight.has(key)) inFlight.set(key, Promise.resolve(materialize(repository, revision)).finally(() => inFlight.delete(key)));
    return inFlight.get(key);
  };

  async function resolveHead(input) {
    const body = closedObject(input, ['repositoryId'], 'source head request');
    const repository = repositoryPolicy(body.repositoryId);
    if (repository.visibility === 'private' && !githubToken) throw { code: 503, msg: 'canonical private source requires a GitHub source credential' };
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'OpenSphere-OSAA-source-evidence' };
    if (githubToken) headers.authorization = `Bearer ${githubToken}`;
    const response = await (options.fetchImpl || fetch)(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/commits/${encodeURIComponent(repository.defaultBranch)}`,
      { headers, signal: AbortSignal.timeout(options.timeoutMs || 15000) },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw { code: response.status, msg: `canonical GitHub branch resolution returned HTTP ${response.status}` };
    return { repository: publicRepository(repository, Boolean(githubToken)), revision: exactRevision(result.sha), resolvedFrom: repository.defaultBranch, observedAt: new Date().toISOString() };
  }

  async function readSource(input) {
    const body = closedObject(input, ['repositoryId', 'revision', 'path', 'startLine', 'endLine'], 'source read request');
    const repository = repositoryPolicy(body.repositoryId); const revision = exactRevision(body.revision);
    if (repository.visibility === 'private' && !githubToken) throw { code: 503, msg: 'canonical private source requires a GitHub source credential' };
    const relative = authorizedPath(repository, body.path);
    const root = await materialized(repository, revision); const absolute = path.resolve(root, relative);
    const rootPrefix = `${path.resolve(root)}${path.sep}`;
    if (!absolute.startsWith(rootPrefix)) throw { code: 500, msg: 'materialized source path escaped its cache root' };
    const stat = await fsp.stat(absolute).catch((error) => { if (error.code === 'ENOENT') throw { code: 404, msg: 'source path does not exist at the exact revision' }; throw error; });
    if (!stat.isFile() || stat.size > limits.maximumFileBytes) throw { code: 413, msg: 'source file is not a bounded regular text file' };
    const content = await fsp.readFile(absolute, 'utf8');
    if (content.includes('\0')) throw { code: 415, msg: 'binary source files are not exposed to OSAA' };
    return {
      apiVersion: 'opensphere.io/osaa-source-evidence/v1', repositoryId: repository.id,
      canonicalUrl: repository.canonicalUrl, revision, path: relative, digest: sha256(content),
      ...lineProjection(content, body.startLine, body.endLine),
    };
  }

  async function searchSource(input) {
    const body = closedObject(input, ['repositoryId', 'revision', 'query', 'pathPrefix', 'limit'], 'source search request');
    const repository = repositoryPolicy(body.repositoryId); const revision = exactRevision(body.revision);
    if (repository.visibility === 'private' && !githubToken) throw { code: 503, msg: 'canonical private source requires a GitHub source credential' };
    const query = String(body.query || '').trim();
    if (query.length < 2 || query.length > 200) throw { code: 400, msg: 'source search query must be 2 to 200 characters' };
    const limit = Number(body.limit || 12);
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw { code: 400, msg: 'source search limit must be 1 to 30' };
    const roots = body.pathPrefix
      ? [authorizedPath(repository, body.pathPrefix, 'pathPrefix')]
      : repository.allowedReadPaths;
    const root = await materialized(repository, revision);
    const candidates = { files: [], totalBytes: 0, complete: true };
    for (const relative of roots) {
      if (candidates.complete === false) break;
      await walkTextFiles(root, relative, limits, candidates);
    }
    const needle = query.toLocaleLowerCase('en-US'); const items = [];
    for (const file of candidates.files) {
      if (items.length >= limit) break;
      const content = await fsp.readFile(file.absolute, 'utf8');
      if (content.includes('\0')) continue;
      const lines = content.replace(/\r\n/g, '\n').split('\n');
      for (let index = 0; index < lines.length && items.length < limit; index += 1) {
        if (!lines[index].toLocaleLowerCase('en-US').includes(needle)) continue;
        items.push({
          path: file.relative.replace(/\\/g, '/'), line: index + 1,
          excerpt: lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join('\n').slice(0, 1200),
        });
      }
    }
    return {
      apiVersion: 'opensphere.io/osaa-source-search/v1', repositoryId: repository.id,
      canonicalUrl: repository.canonicalUrl, revision, query, pathPrefix: body.pathPrefix || null,
      items, scannedFiles: candidates.files.length, scannedBytes: candidates.totalBytes,
      complete: candidates.complete && items.length < limit,
    };
  }

  return {
    catalog: () => catalogProjection(Boolean(githubToken)),
    resolveHead, readSource, searchSource,
  };
}

function engineeringRepositoryPolicy() {
  return Object.freeze(Object.fromEntries(Object.values(SOURCE_REPOSITORIES)
    .filter((repository) => repository.engineering)
    .map((repository) => [repository.id, Object.freeze({
      url: repository.canonicalUrl,
      allowedPaths: repository.engineering.allowedPaths,
      components: repository.engineering.components,
    })])));
}

module.exports = {
  EXACT_REVISION_RE,
  SOURCE_REPOSITORIES,
  authorizedPath,
  catalogProjection,
  closedObject,
  createCanonicalSourceEvidence,
  engineeringRepositoryPolicy,
  exactRevision,
  normalizedRelativePath,
  pathAllowed,
  publicRepository,
  repositoryPolicy,
  validatedArchiveListing,
};
