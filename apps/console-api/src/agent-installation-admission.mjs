// CON-FR-001/007/018: C_AI/GUI/CLI -> C_SCTL -> C_API installation owner.
// A marker selects the contract; Supabase signature, bound session and current
// permissions remain mandatory in identity-session-broker and the operation API.
export function agentInstallationRoute(method, path, marker) {
  if (marker !== 'os-shell-control-v1') return false;
  if (method === 'POST') return ['/api/admin/extensions/inspect', '/api/admin/extensions/install'].includes(path);
  return method === 'GET' && (path === '/api/admin/extensions/catalog'
    || /^\/api\/platform\/operations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(path));
}
