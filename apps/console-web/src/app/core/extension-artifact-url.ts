/** Resolve a signed owner asset through its exact immutable Console proxy revision. */
export function extensionArtifactUrl(path: string, artifactBase: string, manifestUrl: string, origin: string): URL {
  if (!/^\/api\/plugins\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(artifactBase)) throw new Error('Invalid artifact revision');
  // Canonical /app paths belong to the owner Service, not the Console website root.
  const url = path.startsWith('/app/') ? new URL(artifactBase + path, origin) : new URL(path, new URL(manifestUrl, origin));
  if (url.origin !== origin || !url.pathname.startsWith(artifactBase + '/') || url.search || url.hash) throw new Error('Asset escapes the verified release namespace');
  return url;
}
