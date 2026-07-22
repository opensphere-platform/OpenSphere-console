const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const scriptDir = __dirname;
const gatewayRoot = path.resolve(scriptDir, '..');
const consoleRoot = path.resolve(gatewayRoot, '..', '..');
const platformRoot = path.resolve(consoleRoot, '..');
const outPath = path.join(gatewayRoot, 'manual-seeds', 'opensphere-core-manuals.json');

function resolveSourcePath(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  // The release repository is commonly checked out as `OpenSphere-console`,
  // while local worktrees have a generated directory name. Resolve Console
  // docs from the actual current checkout in both cases.
  if (normalized.startsWith('OpenSphere-console/')) {
    return path.join(consoleRoot, normalized.slice('OpenSphere-console/'.length));
  }
  return path.join(platformRoot, normalized);
}

function readText(relPath) {
  const full = resolveSourcePath(relPath);
  const content = fs.readFileSync(full, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
  return { full, content };
}

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function doc(input) {
  const { content } = readText(input.path);
  return {
    sourceId: input.sourceId,
    title: input.title,
    version: input.version || '2026-07-04',
    sourcePath: input.path.replace(/\\/g, '/'),
    documentType: input.documentType || 'reference',
    authorityTier: input.authorityTier,
    language: input.language || 'mixed',
    perspective: input.perspective || [],
    plane: input.plane || [],
    component: input.component || [],
    audience: input.audience || ['admin', 'operator', 'architect'],
    tags: input.tags || [],
    checksum: hash(content),
    content,
  };
}

const documents = [
  doc({
    sourceId: 'opensphere-docs/constitution-0000',
    title: 'CONSTITUTION-0000 OpenSphere Constitution',
    path: '_DOCS_/01-CONSTITUTION/CONSTITUTION-0000-OPENSPHERE-CONSTITUTION.md',
    documentType: 'policy',
    authorityTier: 0,
    perspective: ['main-shell'],
    plane: ['p1-control', 'p6-experience'],
    component: ['constitution', 'governance'],
    tags: ['constitution', 'authority', 'invariant'],
  }),
  doc({
    sourceId: 'opensphere-docs/authority-index',
    title: 'OpenSphere Docs Authority Index',
    path: '_DOCS_/README.md',
    documentType: 'reference',
    authorityTier: 1,
    plane: ['p1-control'],
    component: ['docs', 'governance'],
    tags: ['docs', 'authority-map'],
  }),
  doc({
    sourceId: 'opensphere-docs/whole-picture',
    title: 'OpenSphere Whole Picture',
    path: '_DOCS_/00-전체그림.md',
    documentType: 'concept',
    authorityTier: 1,
    perspective: ['main-shell'],
    plane: ['p0-host-substrate', 'p1-control', 'p2-foundation', 'p3-service', 'p4-intelligence', 'p5-catalog-store', 'p6-experience', 'p7-access-edge'],
    component: ['architecture'],
    tags: ['architecture', 'whole-picture'],
  }),
  doc({
    sourceId: 'opensphere-docs/platform-bootstrap-lifecycle',
    title: 'Three Service Stacks, Platform Bootstrap & PFS Lifecycle',
    version: '1.1.0',
    path: '_DOCS_/01-CONSTITUTION/CONSTITUTION-0004-PLATFORM-BOOTSTRAP-SUPPORT-FOUNDATION-LIFECYCLE.md',
    documentType: 'policy',
    authorityTier: 0,
    perspective: ['main-shell', 'base-substrate', 'cluster-manager', 'foundation'],
    plane: ['p0-host-substrate', 'p1-control', 'p2-foundation', 'p6-experience'],
    component: ['his', 'cbs', 'console', 'cluster-manager', 'support-profile', 'pfs'],
    tags: ['constitution', 'three-service-stacks', 'his', 'cbs', 'pfs', 'bootstrap', 'support-profile'],
  }),
  doc({
    sourceId: 'opensphere-docs/p1-control',
    title: 'P1 Control',
    path: '_DOCS_/02-평면설계/P1-control.md',
    documentType: 'reference',
    authorityTier: 1,
    perspective: ['main-shell'],
    plane: ['p1-control'],
    component: ['control', 'operator', 'release'],
    tags: ['plane', 'p1'],
  }),
  doc({
    sourceId: 'opensphere-docs/p2-foundation',
    title: 'P2 Foundation',
    path: '_DOCS_/02-평면설계/P2-foundation.md',
    documentType: 'reference',
    authorityTier: 1,
    perspective: ['base-substrate', 'api-information-flow'],
    plane: ['p2-foundation'],
    component: ['foundation', 'data-identity', 'change-control'],
    tags: ['plane', 'p2'],
  }),
  doc({
    sourceId: 'opensphere-docs/p3-service',
    title: 'P3 Service',
    path: '_DOCS_/02-평면설계/P3-service.md',
    documentType: 'reference',
    authorityTier: 1,
    perspective: ['workspace-internal', 'customer'],
    plane: ['p3-service'],
    component: ['service'],
    tags: ['plane', 'p3'],
  }),
  doc({
    sourceId: 'opensphere-docs/p4-intelligence',
    title: 'P4 Intelligence',
    path: '_DOCS_/02-평면설계/P4-intelligence.md',
    documentType: 'reference',
    authorityTier: 1,
    perspective: ['ai-level'],
    plane: ['p4-intelligence'],
    component: ['ai', 'oaa', 'governance'],
    tags: ['plane', 'p4', 'ai'],
  }),
  doc({
    sourceId: 'opensphere-docs/p5-catalog-store',
    title: 'P5 Catalog Store',
    path: '_DOCS_/02-평면설계/P5-catalog-store.md',
    documentType: 'reference',
    authorityTier: 1,
    perspective: ['developer'],
    plane: ['p5-catalog-store'],
    component: ['catalog', 'registry'],
    tags: ['plane', 'p5'],
  }),
  doc({
    sourceId: 'opensphere-docs/p6-experience',
    title: 'P6 Experience',
    path: '_DOCS_/02-평면설계/P6-experience.md',
    documentType: 'reference',
    authorityTier: 1,
    perspective: ['main-shell', 'developer', 'workspace-internal'],
    plane: ['p6-experience'],
    component: ['console', 'shell', 'dupa'],
    tags: ['plane', 'p6'],
  }),
  doc({
    sourceId: 'opensphere-docs/p7-access-edge',
    title: 'P7 Access Edge',
    path: '_DOCS_/02-평면설계/P7-access-edge.md',
    documentType: 'reference',
    authorityTier: 1,
    perspective: ['external-edge-service', 'website', 'customer'],
    plane: ['p7-access-edge'],
    component: ['edge', 'ingress', 'tls'],
    tags: ['plane', 'p7'],
  }),
  doc({
    sourceId: 'console-docs/platform-control-plane-v2',
    title: 'OpenSphere Console Platform Control Plane V2',
    version: '2026-07-22',
    path: 'OpenSphere-console/docs/PLAN-CONSOLE-PLATFORM-CONTROL-PLANE-V2-2026-07-22.md',
    documentType: 'architecture',
    authorityTier: 1,
    perspective: ['main-shell', 'ai-level'],
    plane: ['p1-control', 'p4-intelligence', 'p6-experience'],
    component: ['supabase', 'gitea', 'observability-binding', 'oaa-gateway'],
    tags: ['platform-control-plane', 'supabase', 'gitea', 'his-binding', 'oaa'],
  }),
  doc({
    sourceId: 'console-docs/oaa-manual-knowledge-data-model',
    title: 'OAA Manual Knowledge Data Model',
    path: 'OpenSphere-console/docs/OAA-MANUAL-KNOWLEDGE-DATA-MODEL.md',
    documentType: 'reference',
    authorityTier: 3,
    perspective: ['ai-level'],
    plane: ['p4-intelligence', 'p6-experience'],
    component: ['oaa', 'manual', 'knowledge'],
    tags: ['oaa', 'manual', 'knowledge-model'],
  }),
  doc({
    sourceId: 'console-docs/manual-ownership',
    title: 'OpenSphere Manual Ownership',
    version: '2026-07-16',
    path: 'OpenSphere-console/docs/MANUAL-OWNERSHIP.md',
    documentType: 'policy',
    authorityTier: 1,
    perspective: ['main-shell'],
    plane: ['p6-experience'],
    component: ['console', 'manual', 'oaa-gateway'],
    tags: ['manual', 'ownership', 'main-shell', 'console-native'],
  }),
  doc({
    sourceId: 'help-center/perspective-overview',
    title: 'OpenSphere 10 Perspectives',
    path: 'OpenSphere-console/docs/manual/00-10-PERSPECTIVES.md',
    documentType: 'concept',
    authorityTier: 1,
    perspective: ['main-shell', 'os-level', 'k8s-cluster-ceph', 'user-auth', 'developer', 'ai-level', 'api-information-flow', 'workspace-internal', 'customer', 'external-edge-service', 'website'],
    plane: ['p6-experience'],
    component: ['help-center', 'manual'],
    tags: ['help-center', 'manual', 'perspectives', 'perspective-overview'],
  }),
  doc({
    sourceId: 'help-center/perspective-01-os-level',
    title: '1. OS Level',
    path: 'OpenSphere-console/docs/manual/01-OS-LEVEL.md',
    documentType: 'guide', authorityTier: 2,
    perspective: ['os-level'], plane: ['p0-host-substrate'], component: ['host', 'operating-system'],
    tags: ['help-center', 'perspective-home', 'manual-band-operate', 'order-01'],
  }),
  doc({
    sourceId: 'help-center/perspective-02-k8s-cluster-ceph',
    title: '2. K8s Cluster + Ceph',
    path: 'OpenSphere-console/docs/manual/02-K8S-CLUSTER-CEPH.md',
    documentType: 'guide', authorityTier: 2,
    perspective: ['k8s-cluster-ceph'], plane: ['p0-host-substrate', 'p2-foundation'], component: ['kubernetes', 'ceph'],
    tags: ['help-center', 'perspective-home', 'manual-band-operate', 'order-02'],
  }),
  doc({
    sourceId: 'help-center/perspective-03-user-auth',
    title: '3. User & Auth',
    path: 'OpenSphere-console/docs/manual/03-USER-AUTH.md',
    documentType: 'guide', authorityTier: 2,
    perspective: ['user-auth'], plane: ['p1-control'], component: ['identity', 'supabase-auth'],
    tags: ['help-center', 'perspective-home', 'manual-band-operate', 'order-03'],
  }),
  doc({
    sourceId: 'help-center/perspective-04-developer',
    title: '4. Developer',
    path: 'OpenSphere-console/docs/manual/04-DEVELOPER.md',
    documentType: 'guide', authorityTier: 2,
    perspective: ['developer'], plane: ['p5-catalog-store', 'p6-experience'], component: ['developer', 'sdk'],
    tags: ['help-center', 'perspective-home', 'manual-band-build', 'order-04'],
  }),
  doc({
    sourceId: 'help-center/perspective-05-ai-level',
    title: '5. AI Level',
    path: 'OpenSphere-console/docs/manual/05-AI-LEVEL.md',
    documentType: 'guide', authorityTier: 2,
    perspective: ['ai-level'], plane: ['p4-intelligence'], component: ['ai', 'oaa'],
    tags: ['help-center', 'perspective-home', 'manual-band-build', 'order-05'],
  }),
  doc({
    sourceId: 'help-center/perspective-06-api',
    title: '6. API',
    path: 'OpenSphere-console/docs/manual/06-API.md',
    documentType: 'guide', authorityTier: 2,
    perspective: ['api-information-flow'], plane: ['p1-control', 'p7-access-edge'], component: ['api', 'information-flow'],
    tags: ['help-center', 'perspective-home', 'manual-band-build', 'order-06'],
  }),
  doc({
    sourceId: 'help-center/perspective-07-workspace',
    title: '7. Workspace',
    path: 'OpenSphere-console/docs/manual/07-WORKSPACE.md',
    documentType: 'guide', authorityTier: 2,
    perspective: ['workspace-internal'], plane: ['p3-service', 'p6-experience'], component: ['workspace'],
    tags: ['help-center', 'perspective-home', 'manual-band-deliver', 'order-07'],
  }),
  doc({
    sourceId: 'help-center/perspective-08-customer',
    title: '8. Customer',
    path: 'OpenSphere-console/docs/manual/08-CUSTOMER.md',
    documentType: 'guide', authorityTier: 2,
    perspective: ['customer'], plane: ['p3-service', 'p6-experience'], component: ['customer', 'ciam'],
    tags: ['help-center', 'perspective-home', 'manual-band-deliver', 'order-08'],
  }),
  doc({
    sourceId: 'help-center/perspective-09-edge',
    title: '9. Edge',
    path: 'OpenSphere-console/docs/manual/09-EDGE.md',
    documentType: 'guide', authorityTier: 2,
    perspective: ['external-edge-service'], plane: ['p7-access-edge'], component: ['edge', 'ingress'],
    tags: ['help-center', 'perspective-home', 'manual-band-deliver', 'order-09'],
  }),
  doc({
    sourceId: 'help-center/perspective-10-website',
    title: '10. WebSite',
    path: 'OpenSphere-console/docs/manual/10-WEBSITE.md',
    documentType: 'guide', authorityTier: 2,
    perspective: ['website'], plane: ['p6-experience', 'p7-access-edge'], component: ['website', 'content'],
    tags: ['help-center', 'perspective-home', 'manual-band-deliver', 'order-10'],
  }),
];

const perspectiveDefinitions = {
  'os-level': {
    name: 'OS Level',
    aliases: ['host operating system', 'host level'],
    summary: 'Host operating system, network, storage and runtime prerequisite perspective.',
  },
  'main-shell': {
    name: 'Main Shell',
    aliases: ['OpenSphere shell', 'console shell'],
    summary: 'User-facing OpenSphere operating frame and primary navigation context.',
  },
  'base-substrate': {
    name: 'Base Substrate',
    aliases: ['base platform'],
    summary: 'Base platform services, storage, control data tier and shared runtime substrate.',
  },
  'k8s-cluster-ceph': {
    name: 'Kubernetes Cluster and Ceph',
    aliases: ['cluster substrate', 'ceph storage'],
    summary: 'Cluster and distributed storage substrate used by OpenSphere workloads.',
  },
  'user-auth': {
    name: 'User Auth',
    aliases: ['identity', 'access model'],
    summary: 'Identity, authentication, authorization, user and tenant access model.',
  },
  developer: {
    name: 'Developer',
    aliases: ['developer workflow', 'build and deploy'],
    summary: 'Developer workflow, catalog, repository, build, deploy and extension model.',
  },
  'ai-level': {
    name: 'AI Level',
    aliases: ['OAA perspective', 'AI layer'],
    summary: 'AI gateway, OAA, model providers, manual knowledge, action bindings and automation model.',
  },
  'api-information-flow': {
    name: 'API Information Flow',
    aliases: ['information flow', 'API flow'],
    summary: 'API, event, data, integration and information flow across OpenSphere.',
  },
  'workspace-internal': {
    name: 'Workspace Internal',
    aliases: ['internal workspace', 'workspace operations'],
    summary: 'Internal workspace context, operations and service execution environment.',
  },
  customer: {
    name: 'Customer',
    aliases: ['customer perspective', 'user outcome'],
    summary: 'Customer-facing usage, support, service outcome and product value context.',
  },
  'external-edge-service': {
    name: 'External Edge Service',
    aliases: ['edge boundary', 'external services'],
    summary: 'External service, edge access, ingress, TLS and integration boundary.',
  },
  website: {
    name: 'Website',
    aliases: ['public website', 'public surface'],
    summary: 'Website and public OpenSphere surface. Keep this aligned with the authoritative 10 Perspective source.',
  },
};

function conceptId(kind, id) {
  return `concept:opensphere:${kind}:${id}`;
}

function docsWithPerspective(id) {
  return documents.filter((d) => Array.isArray(d.perspective) && d.perspective.includes(id));
}

const concepts = Object.entries(perspectiveDefinitions).map(([id, def]) => {
  const sourceDocs = docsWithPerspective(id);
  const tier = sourceDocs.reduce((min, d) => Math.min(min, Number(d.authorityTier || 4)), 4);
  return {
    id: conceptId('perspective', id),
    type: 'perspective',
    name: def.name,
    aliases: def.aliases,
    summary: def.summary,
    definition: `${def.summary} This concept is part of the OpenSphere Perspective model and must be answered from OpenSphere manuals, not generic model memory.`,
    authorityTier: tier === 4 ? 1 : tier,
    status: 'active',
    sourceIds: sourceDocs.map((d) => d.sourceId),
    tags: ['opensphere-perspective', id],
  };
});

const relations = [];
for (const concept of concepts) {
  for (const sourceId of concept.sourceIds) {
    relations.push({
      id: `relation:${concept.id}:documented-in:manual:${sourceId}`,
      fromId: concept.id,
      relation: 'documented-in',
      toId: `manual:${sourceId}`,
      confidence: 'manual',
      authorityTier: concept.authorityTier,
      sourceId,
    });
  }
}

concepts.push({
  id: conceptId('service', 'oaa-gateway'),
  type: 'service-tier',
  name: 'OAA Gateway',
  aliases: ['OpenSphere AI Agent Gateway', 'OAA-Gateway'],
  summary: 'Console-native server workload that owns LLM key custody, model calls, Supabase-backed manual knowledge retrieval and governed OAA tools.',
  definition: 'OAA Gateway is a Main Shell capability that uses Supabase for its durable data boundary, Gitea-correlated change control, tool manifests and guarded action submission.',
  authorityTier: 3,
  status: 'active',
  sourceIds: ['console-docs/platform-control-plane-v2', 'console-docs/oaa-manual-knowledge-data-model'],
  tags: ['oaa', 'gateway', 'supabase', 'gitea'],
});

relations.push({
  id: 'relation:concept:opensphere:service:oaa-gateway:belongs-to:concept:opensphere:perspective:ai-level',
  fromId: conceptId('service', 'oaa-gateway'),
  relation: 'belongs-to',
  toId: conceptId('perspective', 'ai-level'),
  confidence: 'manual',
  authorityTier: 3,
  sourceId: 'console-docs/oaa-manual-knowledge-data-model',
});

const manifest = {
  schema: 'manual-seed.opensphere.io/v1alpha1',
  version: new Date().toISOString(),
  source: {
    id: 'opensphere-core-manuals',
    type: 'repo',
    name: 'OpenSphere Core Manuals',
    basePath: platformRoot,
    authorityTier: 1,
    defaultNamespace: 'opensphere',
    defaultLanguage: 'mixed',
    refreshMode: 'release-bound',
  },
  documents,
  concepts,
  relations,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`Wrote ${documents.length} manual documents, ${concepts.length} concepts, ${relations.length} relations to ${outPath}`);
