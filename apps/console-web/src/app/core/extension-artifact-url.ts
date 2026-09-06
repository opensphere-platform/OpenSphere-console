/** Resolve a signed owner asset through its exact immutable Console proxy revision. */
export function extensionArtifactUrl(path: string, artifactBase: string, manifestUrl: string, origin: string): URL {
  if (!/^\/api\/plugins\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(artifactBase)) throw new Error('Invalid artifact revision');
  // Signed UI assets and the one data-only owner contract belong to the
  // immutable owner revision, never to the Console website root.
  const ownerPath = path.startsWith('/app/') || path === '/contracts/owner-commands.json';
  const url = ownerPath ? new URL(artifactBase + path, origin) : new URL(path, new URL(manifestUrl, origin));
  if (url.origin !== origin || !url.pathname.startsWith(artifactBase + '/') || url.search || url.hash) throw new Error('Asset escapes the verified release namespace');
  return url;
}
