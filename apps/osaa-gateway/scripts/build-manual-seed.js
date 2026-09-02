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
    sourceId: 'design/governance/foundational-invariant',
    title: 'OpenSphere Foundational Invariant',
    version: '2026-09-01',
    path: 'DESIGN/09-GOVERNANCE/GOVERNANCE-PLATFORM-FOUNDATIONAL-INVARIANT.md',
    documentType: 'policy', authorityTier: 0,
    component: ['governance', 'platform'],
    tags: ['active-design', 'constitution-inherited', 'invariant'],
  }),
  doc({
    sourceId: 'design/governance/constitution-inheritance',
    title: 'OpenSphere Constitution Inheritance',
    version: '2026-09-01',
    path: 'DESIGN/09-GOVERNANCE/GOVERNANCE-PLATFORM-CONSTITUTION-INHERITANCE.md',
    documentType: 'policy', authorityTier: 0,
    component: ['governance', 'policy-inheritance'],
    tags: ['active-design', 'constitution-inherited', 'authority'],
  }),
  doc({
    sourceId: 'design/governance/source-authority',
    title: 'OpenSphere Source Authority Policy',
    version: '2026-09-01',
    path: 'DESIGN/09-GOVERNANCE/GOVERNANCE-PLATFORM-SOURCE-AUTHORITY-POLICY.md',
    documentType: 'policy', authorityTier: 0,
    component: ['governance', 'source'],
    tags: ['active-design', 'source-authority', 'provenance'],
  }),
  doc({
    sourceId: 'design/console/index',
    title: 'OpenSphere Console Design Index',
    version: '2026-09-01',
    path: 'DESIGN/20-MODULE/OpenSphere-Console/CONSOLE-DESIGN-INDEX.md',
    documentType: 'architecture', authorityTier: 1,
    perspective: ['main-shell'],
    plane: ['p1-control', 'p6-experience'],
    component: ['console'],
    tags: ['active-design', 'console', 'design-index'],
  }),
  doc({
    sourceId: 'design/console/implementation-blueprint',
    title: 'OpenSphere Console Complete Implementation Blueprint',
    version: '2026-09-01',
    path: 'DESIGN/20-MODULE/OpenSphere-Console/00-OVERVIEW/CONSOLE-OVERVIEW-COMPLETE-IMPLEMENTATION-BLUEPRINT.md',
    documentType: 'architecture', authorityTier: 1,
    perspective: ['main-shell'],
    plane: ['p1-control', 'p6-experience'],
    component: ['console', 'supabase', 'gitea', 'beszel'],
    tags: ['active-design', 'console', 'implementation-blueprint'],
  }),
  doc({
    sourceId: 'design/console/backbone',
    title: 'Console Backbone Service Stack View',
    version: '2026-09-01',
    path: 'DESIGN/20-MODULE/OpenSphere-Console/02-ARCHITECTURE/CONSOLE-ARCHITECTURE-BACKBONE-SERVICE-STACK-VIEW.md',
    documentType: 'architecture', authorityTier: 1,
    perspective: ['main-shell', 'ai-level'],
    plane: ['p1-control', 'p2-foundation', 'p4-intelligence', 'p6-experience'],
    component: ['console', 'supabase', 'gitea', 'beszel'],
    tags: ['active-design', 'console-backbone', 'service-stack'],
  }),
  doc({
    sourceId: 'design/console/system-decomposition',
    title: 'Console System Decomposition C4 View',
    version: '2026-09-01',
    path: 'DESIGN/20-MODULE/OpenSphere-Console/02-ARCHITECTURE/CONSOLE-ARCHITECTURE-SYSTEM-DECOMPOSITION-C4-VIEW.md',
    documentType: 'architecture', authorityTier: 1,
    perspective: ['main-shell'],
    plane: ['p1-control', 'p6-experience'],
    component: ['console', 'component-boundary'],
    tags: ['active-design', 'c4', 'system-decomposition'],
  }),
  doc({
    sourceId: 'design/console/capability-requirements',
    title: 'Console Capability Requirement Catalog',
    version: '2026-09-01',
    path: 'DESIGN/20-MODULE/OpenSphere-Console/01-PRODUCT/CONSOLE-PRODUCT-CAPABILITY-REQUIREMENT-CATALOG.md',
    documentType: 'requirements', authorityTier: 1,
    perspective: ['main-shell'],
    plane: ['p1-control', 'p6-experience'],
    component: ['console'],
    tags: ['active-design', 'requirements', 'capability'],
  }),
  doc({
    sourceId: 'design/console/api-contracts',
    title: 'Console API Capability Catalog',
    version: '2026-09-01',
    path: 'DESIGN/20-MODULE/OpenSphere-Console/05-CONTRACT/CONSOLE-CONTRACT-API-CAPABILITY-CATALOG.md',
    documentType: 'contract', authorityTier: 1,
    perspective: ['main-shell', 'api-information-flow'],
    plane: ['p1-control'],
    component: ['console', 'api'],
    tags: ['active-design', 'contract', 'api'],
  }),
  doc({
    sourceId: 'design/console/security',
    title: 'Console Trust Boundary Specification',
    version: '2026-09-01',
    path: 'DESIGN/20-MODULE/OpenSphere-Console/06-SECURITY/CONSOLE-SECURITY-TRUST-BOUNDARY-SPECIFICATION.md',
    documentType: 'security', authorityTier: 1,
    perspective: ['main-shell', 'user-auth'],
    plane: ['p1-control', 'p6-experience'],
    component: ['console', 'identity', 'secrets'],
    tags: ['active-design', 'security', 'trust-boundary'],
  }),
  doc({
    sourceId: 'design/console/release-supply-chain',
    title: 'Console Build Release Supply Chain Specification',
    version: '2026-09-01',
    path: 'DESIGN/20-MODULE/OpenSphere-Console/07-OPERATIONS/CONSOLE-OPERATIONS-BUILD-RELEASE-SUPPLY-CHAIN-SPECIFICATION.md',
    documentType: 'operations', authorityTier: 1,
    perspective: ['main-shell', 'developer'],
    plane: ['p1-control', 'p5-catalog-store'],
    component: ['console', 'ghcr', 'release'],
    tags: ['active-design', 'release', 'supply-chain'],
  }),
  doc({
    sourceId: 'design/console/reproduction-acceptance',
    title: 'Console Reproduction Acceptance Specification',
    version: '2026-09-01',
    path: 'DESIGN/20-MODULE/OpenSphere-Console/08-QUALITY/CONSOLE-QUALITY-REPRODUCTION-ACCEPTANCE-SPECIFICATION.md',
    documentType: 'quality', authorityTier: 1,
    perspective: ['main-shell'],
    plane: ['p1-control', 'p6-experience'],
    component: ['console', 'acceptance'],
    tags: ['active-design', 'quality', 'reproduction'],
  }),
  doc({
    sourceId: 'design/console/registry-decision',
    title: 'Console Registry Native Boundary ADR',
    version: '2026-09-01',
    path: 'DESIGN/20-MODULE/OpenSphere-Console/09-DECISION/CONSOLE-DECISION-REGISTRY-NATIVE-BOUNDARY-ADR-0014.md',
    documentType: 'decision', authorityTier: 1,
    perspective: ['main-shell', 'developer'],
    plane: ['p1-control', 'p5-catalog-store'],
    component: ['console', 'registry'],
    tags: ['active-design', 'adr', 'registry'],
  }),
  doc({
    sourceId: 'design/platform/design-system',
    title: 'OpenSphere Design System Policy',
    version: '2026-09-01',
    path: 'DESIGN/03-EXPERIENCE/EXPERIENCE-PLATFORM-DESIGN-SYSTEM-POLICY.md',
    documentType: 'policy', authorityTier: 1,
    perspective: ['main-shell'],
    plane: ['p6-experience'],
    component: ['design-system', 'console'],
    tags: ['active-design', 'clarity', 'carbon', 'experience'],
  }),
  doc({
    sourceId: 'design/platform/application-layout',
    title: 'OpenSphere Application Layout Policy',
    version: '2026-09-01',
    path: 'DESIGN/03-EXPERIENCE/EXPERIENCE-PLATFORM-APPLICATION-LAYOUT-POLICY.md',
    documentType: 'policy', authorityTier: 1,
    perspective: ['main-shell'],
    plane: ['p6-experience'],
    component: ['layout', 'console'],
    tags: ['active-design', 'layout', 'experience'],
  }),  doc({
    sourceId: 'console-docs/manual-ownership',
    title: 'OpenSphere Manual Ownership',
    version: '2026-07-16',
    path: 'OpenSphere-console/docs/MANUAL-OWNERSHIP.md',
    documentType: 'policy',
    authorityTier: 1,
    perspective: ['main-shell'],
    plane: ['p6-experience'],
    component: ['console', 'manual', 'osaa-gateway'],
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
    perspective: ['ai-level'], plane: ['p4-intelligence'], component: ['ai', 'osaa'],
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
    aliases: ['OSAA perspective', 'AI layer'],
    summary: 'AI gateway, OSAA, model providers, manual knowledge, action bindings and automation model.',
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
  id: conceptId('service', 'osaa-gateway'),
  type: 'service-tier',
  name: 'OSAA Gateway',
  aliases: ['OpenSphere AI Agent Gateway', 'OSAA-Gateway'],
  summary: 'Console-native server workload that owns LLM key custody, model calls, Supabase-backed manual knowledge retrieval and governed OSAA tools.',
  definition: 'OSAA Gateway is a Main Shell capability that uses Supabase for its durable data boundary, Gitea-correlated change control, tool manifests and guarded action submission.',
  authorityTier: 3,
  status: 'active',
  sourceIds: ['console-docs/platform-control-plane-v2', 'console-docs/osaa-manual-knowledge-data-model'],
  tags: ['osaa', 'gateway', 'supabase', 'gitea'],
});

relations.push({
  id: 'relation:concept:opensphere:service:osaa-gateway:belongs-to:concept:opensphere:perspective:ai-level',
  fromId: conceptId('service', 'osaa-gateway'),
  relation: 'belongs-to',
  toId: conceptId('perspective', 'ai-level'),
  confidence: 'manual',
  authorityTier: 3,
  sourceId: 'console-docs/osaa-manual-knowledge-data-model',
});

const manifest = {
  schema: 'manual-seed.opensphere.io/v1alpha1',
  version: `sha256:${hash(documents.map((item) => `${item.sourceId}:${item.checksum}`).join('\n'))}`,
  source: {
    id: 'opensphere-core-manuals',
    type: 'repo',
    name: 'OpenSphere Core Manuals',
    basePath: 'DESIGN',
    authorityTier: 0,
    authorityModel: 'active-design-only',
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
