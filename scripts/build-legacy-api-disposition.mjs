import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(repositoryRoot, 'packages', 'contracts', 'legacy-api-disposition.json');
const SOURCE_FILE_SHA256 = '91f9cacd1165bca2aa58b5a18433691752a1e39a1990aafe6cb29fd141d46b8e';

const BROWSER_FAMILIES = Object.freeze([
  ['/api/admin', 'C_API', 'admin'],
  ['/api/catalog', 'C_API', 'catalog'],
  ['/api/external-channels', 'C_BAK', 'external-channels'],
  ['/api/identity', 'C_API', 'identity'],
  ['/api/kubernetes', 'C_API', 'kubernetes'],
  ['/api/manual', 'C_AI', 'manual'],
  ['/api/monitoring', 'C_API', 'monitoring'],
  ['/api/notifications', 'C_NOTIFY', 'notifications'],
  ['/api/os-shell', 'C_SCTL', 'os-shell'],
  ['/api/osaa', 'C_AI', 'osaa'],
  ['/api/platform', 'C_API', 'platform'],
  ['/api/plugins', 'C_EXT', 'plugins'],
  ['/api/status', 'C_API', 'status'],
]);

const TEST_SOURCE = /(?:_test\.go|\.test\.(?:js|mjs)|\.spec\.ts)$/u;
const TEST_SENTINELS = new Set([
  '/api/cli/os-test',
  '/api/cli/os.exe',
  '/api/manifest',
  '/api/operations/op-1',
  '/api/other/os',
  '/api/redirect',
  '/api/should-not-follow',
  '/api/too-large',
]);

function pathMatches(path, prefix) {
  return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?');
}

function decision(path, sources) {
  const files = sources.map(({ file }) => file);
  if (TEST_SENTINELS.has(path) && files.every((file) => TEST_SOURCE.test(file))) {
    return {
      disposition: 'rejected',
      targetOwner: null,
      target: { kind: 'none' },
      rationale: 'Test-only transport sentinel; it is not a target Console runtime operation.',
    };
  }

  if (pathMatches(path, '/api/foundation')) {
    return {
      disposition: 'rejected',
      targetOwner: null,
      target: { kind: 'repository', repository: 'OpenSphere-Foundation' },
      rationale: 'Foundation lifecycle authority moved outside the Console repository boundary.',
    };
  }
  if (pathMatches(path, '/api/hiss')) {
    return {
      disposition: 'rejected',
      targetOwner: null,
      target: { kind: 'cooperating-system', system: 'HISS' },
      rationale: 'HISS lifecycle authority moved outside the Console runtime boundary.',
    };
  }
  if (pathMatches(path, '/api/ceph')) {
    return {
      disposition: 'reworked',
      targetOwner: 'C_AI',
      target: { kind: 'owner-capability', capability: 'governed-storage-tools' },
      rationale: 'The generic Ceph proxy is replaced by typed, governed AI owner tools.',
    };
  }

  if (pathMatches(path, '/api/cli')) {
    return {
      disposition: 'adopted',
      targetOwner: 'C_CLI',
      target: { kind: 'public-static-family', prefix: '/api/cli' },
      rationale: 'The signed CLI artifact family remains a public static Console capability.',
    };
  }
  if (pathMatches(path, '/api/v1/registry')) {
    return {
      disposition: 'adopted',
      targetOwner: 'C_REG',
      target: { kind: 'public-read-family', prefix: '/api/v1/registry' },
      rationale: 'The read-only Registry browse and resolve contract is retained under C_REG.',
    };
  }
  if (path === '/api/health' && files.every((file) => file.includes('backend/registry/'))) {
    return {
      disposition: 'adopted',
      targetOwner: 'C_REG',
      target: { kind: 'runtime-probe', path: '/api/health' },
      rationale: 'The Registry-owned health probe remains internal to the C_REG workload.',
    };
  }

  if (pathMatches(path, '/api/internal')) {
    if (path === '/api/internal/monitoring/beszel/events') {
      return {
        disposition: 'reworked',
        targetOwner: 'C_API',
        target: { kind: 'internal-contract', capability: 'governed-beszel-events' },
        rationale: 'Beszel ingestion is an internal C_API adapter contract, not a browser endpoint.',
      };
    }
    if (path === '/api/internal/notifications/events') {
      return {
        disposition: 'reworked',
        targetOwner: 'C_NOTIFY',
        target: { kind: 'internal-contract', capability: 'notification-event-ingress' },
        rationale: 'Notification event ingestion is owned by C_NOTIFY and remains non-browser.',
      };
    }
    return {
      disposition: 'reworked',
      targetOwner: 'C_API',
      target: { kind: 'internal-contract', path: '/api/internal/owner-authority' },
      rationale: 'Owner-specific proxy checks collapse into one fail-closed C_API owner-authority contract.',
    };
  }

  if (pathMatches(path, '/api/module-operations') || pathMatches(path, '/api/modules')) {
    return {
      disposition: 'reworked',
      targetOwner: 'C_EXT',
      target: { kind: 'owner-capability', capability: 'extension-lifecycle' },
      rationale: 'Legacy module mutation is replaced by the governed extension lifecycle owner.',
    };
  }
  if (path === '/api/proxy' || path === '/api/proxy/') {
    return {
      disposition: 'rejected',
      targetOwner: null,
      target: { kind: 'none' },
      rationale: 'The untyped generic proxy is removed; callers must use a typed owner contract.',
    };
  }
  if (path === '/api/osdst/v1/status') {
    return {
      disposition: 'reworked',
      targetOwner: 'C_AI',
      target: { kind: 'internal-contract', capability: 'dialogue-state-readiness' },
      rationale: 'OSDST readiness remains an internal C_AI cooperating-component contract.',
    };
  }

  if (path === '/api/admin/platform-readiness/status' || path === '/api/admin/platform-readiness/lifecycle') {
    return {
      disposition: 'reworked',
      targetOwner: 'C_API',
      target: {
        kind: 'browser-family',
        family: 'platform',
        prefix: '/api/platform',
        replacement: '/api/platform/releases/status',
      },
      rationale: 'The legacy HISS profile projection is replaced by a read-only Console Backbone view composed from target Supabase, Gitea, Release Lock, and Beszel authorities.',
    };
  }
  if (path === '/api/admin/platform-readiness/preflight' || path === '/api/admin/platform-readiness/verify') {
    return {
      disposition: 'rejected',
      targetOwner: null,
      target: { kind: 'none' },
      rationale: 'The target Console does not manufacture readiness by mutating a HISS profile; Setup and each backbone owner retain their own lifecycle authority.',
    };
  }
  if (path === '/api/admin/observability/status') {
    return {
      disposition: 'reworked',
      targetOwner: 'C_API',
      target: {
        kind: 'browser-family',
        family: 'monitoring',
        prefix: '/api/monitoring',
        replacement: '/api/monitoring/baseline/v1/data-health',
      },
      rationale: 'The legacy HISS/DUPA read is replaced by the authenticated, read-only Beszel baseline monitoring contract owned by C_API.',
    };
  }
  if (path === '/api/admin/observability/targets') {
    return {
      disposition: 'reworked',
      targetOwner: 'C_API',
      target: {
        kind: 'browser-family',
        family: 'monitoring',
        prefix: '/api/monitoring',
        replacement: '/api/monitoring/baseline/v1/nodes',
      },
      rationale: 'The legacy HISS/DUPA read is replaced by the authenticated, read-only Beszel baseline monitoring contract owned by C_API.',
    };
  }
  if (pathMatches(path, '/api/admin/observability/query')) {
    return {
      disposition: 'reworked',
      targetOwner: 'C_API',
      target: {
        kind: 'browser-family',
        family: 'monitoring',
        prefix: '/api/monitoring',
        replacement: '/api/monitoring/baseline/v1/nodes/:systemId/series',
      },
      rationale: 'The unrestricted PromQL surface is replaced by the bounded Beszel system-series contract; arbitrary expressions never reach an observability backend.',
    };
  }

  if (path.startsWith('/api/v1/')) return kubernetesOrCooperatingSystemDecision(path, files);

  const browserFamily = BROWSER_FAMILIES.find(([prefix]) => pathMatches(path, prefix));
  if (browserFamily) {
    const [prefix, targetOwner, family] = browserFamily;
    if (path === '/api/status/api/status') {
      return {
        disposition: 'rejected',
        targetOwner: null,
        target: { kind: 'none' },
        rationale: 'Malformed duplicate status prefix is removed in favor of the canonical status family.',
      };
    }
    return {
      disposition: 'reworked',
      targetOwner,
      target: { kind: 'browser-family', family, prefix },
      rationale: 'The capability is retained behind the target session or owner-admission boundary.',
    };
  }

  throw new Error(`No reviewed disposition rule for ${path}`);
}

function kubernetesOrCooperatingSystemDecision(path, files) {
  if (path.includes('/opensphere-foundation') || path.includes('foundation-control-plane')
      || files.some((file) => file.includes('foundation-bootstrap-bundle.js'))) {
    return {
      disposition: 'rejected',
      targetOwner: null,
      target: { kind: 'repository', repository: 'OpenSphere-Foundation' },
      rationale: 'Foundation Kubernetes lifecycle access moved to the Foundation repository owner.',
    };
  }
  if (path.startsWith('/api/v1/events?') && files.some((file) => file.includes('dupa-control'))) {
    return {
      disposition: 'reworked',
      targetOwner: 'C_EXT',
      target: { kind: 'adapter-capability', capability: 'extension-runtime-events' },
      rationale: 'Extension event observation remains isolated inside the C_EXT owner boundary.',
    };
  }
  if (path === '/api/v1/orgs') {
    return {
      disposition: 'reworked',
      targetOwner: 'C_API',
      target: { kind: 'cooperating-system', system: 'Gitea', capability: 'bootstrap-organization' },
      rationale: 'This is a governed Gitea bootstrap adapter call, not a Console public API.',
    };
  }
  if (path.includes('opensphere-shell-control-gates') || (path.endsWith('/services') && files.some((file) => file.includes('osaa-gateway')))) {
    return {
      disposition: 'reworked',
      targetOwner: 'C_SCTL',
      target: { kind: 'owner-capability', capability: 'shell-runtime-discovery' },
      rationale: 'Shell runtime discovery is isolated behind the C_SCTL owner contract.',
    };
  }
  if (path.includes('opensphere-platform-recovery-evidence')) {
    return {
      disposition: 'reworked',
      targetOwner: 'C_BAK',
      target: { kind: 'owner-capability', capability: 'recovery-evidence' },
      rationale: 'Recovery evidence access is owned by C_BAK rather than the legacy monolith.',
    };
  }
  if (path.includes('opensphere-installation-lock')) {
    return {
      disposition: 'reworked',
      targetOwner: 'C_API',
      target: { kind: 'internal-contract', capability: 'installation-lock-projection' },
      rationale: 'Installation lock data is projected through C_API and is not exposed as raw Kubernetes API.',
    };
  }
  if (files.some((file) => file.includes('osaa-gateway') || file.includes('dupa-control'))) {
    return {
      disposition: 'reworked',
      targetOwner: 'C_AI',
      target: { kind: 'owner-capability', capability: 'governed-kubernetes-tools' },
      rationale: 'Direct Kubernetes calls are replaced by typed, governed C_AI owner tools.',
    };
  }
  return {
    disposition: 'reworked',
    targetOwner: 'C_API',
    target: { kind: 'adapter-capability', capability: 'runtime-observation' },
    rationale: 'Raw Kubernetes observation is replaced by a fail-closed adapter and explicit authority state.',
  };
}

function pathSetDigest(paths) {
  return 'sha256:' + createHash('sha256').update(paths.map((path) => `${path}\n`).join('')).digest('hex');
}

async function main() {
  const evidencePath = process.argv[2];
  if (!evidencePath) throw new Error('usage: node scripts/build-legacy-api-disposition.mjs <source-evidence.json>');
  const evidenceBytes = await readFile(resolve(evidencePath));
  const evidenceFileSha256 = createHash('sha256').update(evidenceBytes).digest('hex');
  if (evidenceFileSha256 !== SOURCE_FILE_SHA256) {
    throw new Error(`Source evidence SHA-256 differs from the reviewed snapshot: ${evidenceFileSha256}`);
  }
  const evidence = JSON.parse(evidenceBytes.toString('utf8'));
  if (evidence.uniqueLiteralPaths !== 277 || evidence.paths.length !== 277) {
    throw new Error('The reviewed source evidence must contain exactly 277 literal paths');
  }
  const records = evidence.paths
    .map(({ path, sources }) => ({ path, sources, ...decision(path, sources) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const paths = records.map(({ path }) => path);
  if (new Set(paths).size !== 277) throw new Error('The reviewed source evidence contains duplicate paths');
  const ledger = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    schemaVersion: '1.0',
    status: 'reviewed',
    sourceEvidence: {
      snapshot: evidence.sourceSnapshot,
      fileSha256: SOURCE_FILE_SHA256,
      uniqueLiteralPaths: records.length,
      pathSetDigest: pathSetDigest(paths),
      scope: evidence.scope,
      scopeCaveat: 'The evidence includes test sources despite its scope claim; this ledger preserves and explicitly disposes every listed literal.',
    },
    dispositionSemantics: {
      adopted: 'The path and responsibility remain in the target Console contract.',
      reworked: 'The capability remains, but its path, owner, authority, or exposure boundary changes.',
      rejected: 'The literal is not a target Console operation because it moved, was unsafe, or was test-only.',
    },
    summary: {
      byDisposition: Object.fromEntries(['adopted', 'reworked', 'rejected'].map((value) => [
        value,
        records.filter(({ disposition }) => disposition === value).length,
      ])),
      byTargetOwner: Object.fromEntries([...new Set(records.map(({ targetOwner }) => targetOwner).filter(Boolean))]
        .sort().map((owner) => [owner, records.filter(({ targetOwner }) => targetOwner === owner).length])),
    },
    decisions: records,
  };
  await writeFile(outputPath, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  process.stdout.write(`${outputPath}\n${records.length} decisions\n${ledger.sourceEvidence.pathSetDigest}\n`);
}

main().catch((error) => {
  process.stderr.write(`Legacy API disposition build failed: ${error.message}\n`);
  process.exitCode = 1;
});
