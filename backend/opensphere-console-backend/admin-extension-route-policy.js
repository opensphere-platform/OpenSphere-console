'use strict';

const ADMIN_CONTROL_ROUTE_POLICIES = [
  { method: 'POST', match: /^\/api\/admin\/extensions\/inspect$/, permission: 'console.extension.security.read', risk: 'R0', readOnly: true },
  { method: 'GET', match: /^\/api\/admin\/extensions\/(?:registry-connections|registry-connections\/opensphere-ghcr|registry-credentials|revocations)$/, permission: 'console.extension.security.read', risk: 'R0', readOnly: true },
  { method: 'POST', match: /^\/api\/admin\/extensions\/registry-connections\/opensphere-ghcr\/verify$/, permission: 'console.extension.security.read', risk: 'R0', readOnly: true },
  { method: 'PUT', match: /^\/api\/admin\/extensions\/(?:registry-connections\/opensphere-ghcr|registry-credentials)$/, permission: 'console.extension.security.manage', risk: 'R2', requireAal2: true },
  // These operations are reversible or narrowly deny future admission. Until a
  // genuine two-operator approval contract exists they are R2, not a cosmetic
  // R3 label backed by only one actor.
  { method: 'DELETE', match: /^\/api\/admin\/extensions\/(?:registry-connections\/opensphere-ghcr|registry-credentials)$/, permission: 'console.extension.security.manage', risk: 'R2', requireAal2: true },
  { method: 'POST', match: /^\/api\/admin\/extensions\/revocations$/, permission: 'console.extension.security.manage', risk: 'R2', requireAal2: true },
  { method: 'POST', match: /^\/api\/admin\/extensions\/install$/, permission: 'console.extension.security.manage', risk: 'R2', lifecycleAction: 'install' },
  { method: 'POST', match: /^\/api\/admin\/plugins\/registrations\/[a-z0-9-]+\/(install|enable|disable|uninstall|rollback)$/, permission: 'console.extension.security.manage', risk: 'R2', lifecycleFromMatch: true },
];

function adminControlRoutePolicy(pathname, method) {
  for (const policy of ADMIN_CONTROL_ROUTE_POLICIES) {
    if (policy.method !== method) continue;
    const matched = pathname.match(policy.match);
    if (!matched) continue;
    return { ...policy, lifecycleAction: policy.lifecycleFromMatch ? matched[1] : policy.lifecycleAction || '' };
  }
  return {
    permission: 'console.admin', risk: ['GET', 'HEAD'].includes(method) ? 'R0' : 'R2',
    readOnly: ['GET', 'HEAD'].includes(method), requireAal2: !['GET', 'HEAD'].includes(method), lifecycleAction: '',
  };
}

function resolveAdminControlEnforcement(pathname, method, lifecycleRequiresRecentAal2 = () => true) {
  const policy = adminControlRoutePolicy(pathname, method);
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const lifecycleRequires = policy.lifecycleAction ? lifecycleRequiresRecentAal2(policy.lifecycleAction) : true;
  const developmentEdgeExemption = mutation && policy.lifecycleAction && !lifecycleRequires;
  return {
    ...policy,
    risk: developmentEdgeExemption && policy.risk === 'R2' ? 'R1' : policy.risk,
    requireAal2: policy.requireAal2 === true || (!policy.readOnly && mutation && lifecycleRequires),
  };
}

module.exports = { ADMIN_CONTROL_ROUTE_POLICIES, adminControlRoutePolicy, resolveAdminControlEnforcement };
