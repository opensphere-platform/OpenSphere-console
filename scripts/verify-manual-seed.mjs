import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve, posix} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const seedPath = 'apps/osaa-gateway/manual-seeds/opensphere-core-manuals.json';
const canonical = value => value.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
const sha = value => createHash('sha256').update(value).digest('hex');
function requireValue(value, message) { if (!value) throw new Error('Manual seed: ' + message); }
function unique(items, key, label) {
  requireValue(Array.isArray(items) && items.length > 0, label + ' must not be empty');
  const ids = new Set();
  for (const item of items) {
    requireValue(typeof item[key] === 'string' && item[key] && !ids.has(item[key]), label + ' identifier is invalid or duplicated');
    ids.add(item[key]);
  }
  return ids;
}

export function verifyManualSeed(seed, {root = defaultRoot} = {}) {
  requireValue(seed.schema === 'manual-seed.opensphere.io/v1alpha1', 'schema mismatch');
  requireValue(seed.source?.id === 'opensphere-core-manuals' && seed.source.refreshMode === 'release-bound'
    && seed.source.authorityModel === 'active-design-only', 'source authority mismatch');
  const documents = unique(seed.documents, 'sourceId', 'document');
  const concepts = unique(seed.concepts, 'id', 'concept');
  unique(seed.relations, 'id', 'relation');
  for (const document of seed.documents) {
    requireValue(typeof document.content === 'string' && canonical(document.content) === document.content, 'noncanonical document content');
    requireValue(document.checksum === sha(document.content), 'document checksum mismatch: ' + document.sourceId);
    const source = document.sourcePath;
    requireValue(typeof source === 'string' && posix.normalize(source) === source && !source.includes('..')
      && !source.includes('\\') && /^(DESIGN|OpenSphere-console)\//u.test(source), 'source path outside closed document roots');
    // DESIGN documents are committed release-bound snapshots. CI must not read an
    // unrelated sibling checkout or mistake its absence for current source evidence.
    if (source.startsWith('OpenSphere-console/')) {
      const actual = canonical(readFileSync(resolve(root, source.slice('OpenSphere-console/'.length)), 'utf8'));
      requireValue(sha(actual) === document.checksum, 'repository document drift: ' + source);
    }
  }
  requireValue(seed.version === 'sha256:' + sha(seed.documents.map(d => d.sourceId + ':' + d.checksum).join('\n')), 'version checksum mismatch');
  for (const concept of seed.concepts) {
    requireValue(Array.isArray(concept.sourceIds)
      && concept.sourceIds.every(id => documents.has(id)), 'concept source is missing: ' + concept.id);
  }
  const endpoint = id => concepts.has(id) || (typeof id === 'string' && id.startsWith('manual:') && documents.has(id.slice(7)));
  for (const relation of seed.relations) {
    requireValue(documents.has(relation.sourceId) && endpoint(relation.fromId) && endpoint(relation.toId), 'relation source or endpoint is missing: ' + relation.id);
  }
  return {status:'passed', documents:documents.size, concepts:concepts.size, relations:seed.relations.length,
    designAuthority:'committed release-bound snapshot; external current DESIGN is not asserted'};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const raw = readFileSync(resolve(defaultRoot, seedPath), 'utf8').replace(/\r\n/g, '\n');
  const seed = JSON.parse(raw);
  requireValue(raw === JSON.stringify(seed, null, 2) + '\n', 'serialization is not deterministic');
  console.log(JSON.stringify(verifyManualSeed(seed)));
}
