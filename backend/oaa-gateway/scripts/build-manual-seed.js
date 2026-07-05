const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const scriptDir = __dirname;
const gatewayRoot = path.resolve(scriptDir, '..');
const consoleRoot = path.resolve(gatewayRoot, '..', '..');
const platformRoot = path.resolve(consoleRoot, '..');
const outPath = path.join(gatewayRoot, 'manual-seeds', 'opensphere-core-manuals.json');

function readText(relPath) {
  const full = path.join(platformRoot, relPath);
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
    sourceId: 'opensphere-docs/p0-host-substrate',
    title: 'P0 Host Substrate',
    path: '_DOCS_/02-평면설계/P0-host-substrate.md',
    documentType: 'reference',
    authorityTier: 1,
    perspective: ['base-substrate'],
    plane: ['p0-host-substrate'],
    component: ['host', 'substrate'],
    tags: ['plane', 'p0'],
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
    component: ['foundation', 'backbone'],
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
    sourceId: 'console-docs/backbone-architecture',
    title: 'Backbone Architecture',
    path: 'OpenSphere-console/docs/BACKBONE-ARCHITECTURE.md',
    documentType: 'reference',
    authorityTier: 3,
    perspective: ['base-substrate', 'api-information-flow'],
    plane: ['p2-foundation', 'p6-experience'],
    component: ['backbone', 'postgresql', 'rustfs', 'gitea', 'oaa-gateway'],
    tags: ['backbone', 'pgvector', 'oaa'],
  }),
  doc({
    sourceId: 'console-docs/oaa-backbone-implementation-plan',
    title: 'OAA Backbone Implementation Plan',
    path: 'OpenSphere-console/docs/OAA-BACKBONE-IMPLEMENTATION-PLAN.md',
    documentType: 'reference',
    authorityTier: 3,
    perspective: ['ai-level', 'main-shell'],
    plane: ['p2-foundation', 'p4-intelligence', 'p6-experience'],
    component: ['oaa', 'oaa-gateway', 'agent-ui', 'pgvector'],
    tags: ['oaa', 'implementation-plan'],
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
    sourceId: 'help-center/docs-ts',
    title: 'OpenSphere Help Center Static Manual Source',
    path: 'OpenSphere-shell-menual/src/app/docs.ts',
    documentType: 'reference',
    authorityTier: 2,
    perspective: ['main-shell', 'ai-level'],
    plane: ['p6-experience'],
    component: ['help-center', 'manual'],
    tags: ['help-center', 'manual', 'perspectives'],
  }),
];

const perspectiveDefinitions = {
  'main-shell': {
    name: 'Main Shell',
    aliases: ['OpenSphere shell', 'console shell'],
    summary: 'User-facing OpenSphere operating frame and primary navigation context.',
  },
  'base-substrate': {
    name: 'Base Substrate',
    aliases: ['Backbone substrate', 'base platform'],
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
  summary: 'Backbone service tier that owns LLM key custody, model calls, manual knowledge retrieval and controlled OAA tools.',
  definition: 'OAA Gateway is the Backbone service tier used by OpenSphere AI Agent for LLM key management, RAG over Backbone PostgreSQL pgvector, tool manifests and guarded action execution.',
  authorityTier: 3,
  status: 'active',
  sourceIds: ['console-docs/backbone-architecture', 'console-docs/oaa-backbone-implementation-plan', 'console-docs/oaa-manual-knowledge-data-model'],
  tags: ['oaa', 'gateway', 'backbone'],
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
