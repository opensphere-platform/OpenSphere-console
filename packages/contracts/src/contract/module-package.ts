import type { Capability } from './capabilities.js';
import { isKnownCapability, isSystemOnlyCapability } from './capabilities.js';
import type { IntegrationContributions } from './manifest.js';

export const MODULE_DESCRIPTOR_LABEL = 'io.opensphere.module.descriptor' as const;
export const MODULE_SIGNATURE_LABEL = 'io.opensphere.module.descriptor.signature' as const;
export const MODULE_KEY_ID_LABEL = 'io.opensphere.module.descriptor.key-id' as const;
export const MODULE_PACKAGE_VERSION = 1 as const;
// Permission profiles are host-owned, fixed contracts.  A module descriptor may
// select one, but can never contribute arbitrary RBAC rules at install time.
export const MODULE_PERMISSION_PROFILES = [
  'none',
  'cluster-observer-v1',
  'cluster-his-manager-v1',
  'cluster-infrastructure-manager-v1',
  'ai-domain-operator-v1',
] as const;
export type ModulePermissionProfile = (typeof MODULE_PERMISSION_PROFILES)[number];

export interface ModuleRuntimeSecurity {
  automountServiceAccountToken?: boolean;
  runAsNonRoot?: boolean;
  runAsUser?: number;
  runAsGroup?: number;
  readOnlyRootFilesystem?: boolean;
  seccompProfile?: 'RuntimeDefault' | 'Localhost';
}

export interface ModuleRuntimeAvailability {
  replicas?: number;
  minAvailable?: number;
  topologySpread?: boolean;
  autoscaling?: {
    enabled: boolean;
    minReplicas?: number;
    maxReplicas?: number;
    targetCPUUtilization?: number;
  };
}

export interface ModuleRuntimeNetworkPolicy {
  enabled: boolean;
  allowMonitoring?: boolean;
}

export interface ModuleRuntimeObservability {
  metricsPath?: string;
  scrapeInterval?: string;
  logs?: {
    format: 'json';
    schema: 'opensphere.v1';
    stream: 'stdout' | 'stderr';
  };
  traces?: {
    propagation: 'w3c';
    responseHeaders?: boolean;
  };
}

export interface ModulePackageV1 {
  schemaVersion: typeof MODULE_PACKAGE_VERSION;
  id: string;
  kind: 'subShell' | 'plugin';
  displayName: string;
  version: string;
  owner: string;
  description: string;
  hostRef: string;
  hostApiVersion?: string;
  hostCompat: string;
  shellCompat: string;
  sdkVersion: string;
  nav?: { band: string; label: string };
  permissions: Capability[];
  permissionProfile: ModulePermissionProfile;
  runtime: {
    port: number;
    healthPath: string;
    serviceAccountName?: string;
    resources: { cpuRequest: string; memoryRequest: string; cpuLimit: string; memoryLimit: string };
    security?: ModuleRuntimeSecurity;
    availability?: ModuleRuntimeAvailability;
    networkPolicy?: ModuleRuntimeNetworkPolicy;
    observability?: ModuleRuntimeObservability;
  };
  manifest: { path: string; sha256: string; signaturePath: string };
  trust: { keyId: string };
  api?: { basePath: string };
  contributions: IntegrationContributions;
}

export interface ModuleValidationIssue { code: string; path: string; message: string }
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const QUANTITY = /^\d+(?:m|Mi|Gi)$/;

export function validateModulePackage(value: unknown): ModuleValidationIssue[] {
  const issues: ModuleValidationIssue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });
  if (!value || typeof value !== 'object' || Array.isArray(value)) { add('InvalidDescriptor', '$', 'descriptor must be an object'); return issues; }
  const m = value as Partial<ModulePackageV1>;
  if (m.schemaVersion !== 1) add('UnsupportedSchema', 'schemaVersion', 'schemaVersion must be 1');
  if (!DNS_LABEL.test(String(m.id || ''))) add('InvalidId', 'id', 'id must be an RFC1123 DNS label');
  if (!['subShell', 'plugin'].includes(String(m.kind || ''))) add('InvalidKind', 'kind', 'kind must be subShell or plugin');
  for (const key of ['displayName', 'owner', 'description', 'hostRef', 'hostCompat', 'shellCompat', 'sdkVersion'] as const) if (!String(m[key] || '').trim()) add('Required', key, `${key} is required`);
  if (!VERSION.test(String(m.version || ''))) add('InvalidVersion', 'version', 'version must be semantic version');
  if (!DNS_LABEL.test(String(m.hostRef || ''))) add('InvalidHostRef', 'hostRef', 'hostRef must be an RFC1123 DNS label');
  if (m.nav && (!String(m.nav.band || '').trim() || !String(m.nav.label || '').trim())) add('InvalidNavigation', 'nav', 'nav band and label are required when nav is declared');
  for (const permission of Array.isArray(m.permissions) ? m.permissions : []) {
    const code = String(permission);
    if (!isKnownCapability(code)) add('UnknownCapability', 'permissions', `unknown capability: ${permission}`);
    else if (isSystemOnlyCapability(code)) add('SystemCapabilityForbidden', 'permissions', `system-only capability cannot be requested by ModulePackage: ${permission}`);
  }
  if (!MODULE_PERMISSION_PROFILES.includes(m.permissionProfile as ModulePermissionProfile)) add('UnknownPermissionProfile', 'permissionProfile', 'permission profile is not approved by the host');
  const runtime = m.runtime;
  if (!runtime) add('Required', 'runtime', 'runtime is required'); else {
    if (!Number.isInteger(runtime.port) || runtime.port < 1024 || runtime.port > 65535) add('InvalidPort', 'runtime.port', 'port must be between 1024 and 65535');
    if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(String(runtime.healthPath || ''))) add('InvalidHealthPath', 'runtime.healthPath', 'healthPath must be absolute');
    if (runtime.serviceAccountName && !DNS_LABEL.test(runtime.serviceAccountName)) add('InvalidServiceAccount', 'runtime.serviceAccountName', 'service account must be an RFC1123 DNS label');
    for (const key of ['cpuRequest', 'memoryRequest', 'cpuLimit', 'memoryLimit'] as const) if (!QUANTITY.test(String(runtime.resources?.[key] || ''))) add('InvalidResource', `runtime.resources.${key}`, 'resource quantity is invalid');
    const security = runtime.security;
    if (security) {
      for (const key of ['automountServiceAccountToken', 'runAsNonRoot', 'readOnlyRootFilesystem'] as const) if (security[key] !== undefined && typeof security[key] !== 'boolean') add('InvalidSecurity', `runtime.security.${key}`, `${key} must be boolean`);
      for (const key of ['runAsUser', 'runAsGroup'] as const) if (security[key] !== undefined && (!Number.isInteger(security[key]) || Number(security[key]) < 1)) add('InvalidSecurity', `runtime.security.${key}`, `${key} must be a positive integer`);
      if (security.seccompProfile && !['RuntimeDefault', 'Localhost'].includes(security.seccompProfile)) add('InvalidSecurity', 'runtime.security.seccompProfile', 'seccompProfile must be RuntimeDefault or Localhost');
    }
    const availability = runtime.availability;
    if (availability) {
      const replicas = availability.replicas ?? 2;
      if (!Number.isInteger(replicas) || replicas < 1 || replicas > 20) add('InvalidAvailability', 'runtime.availability.replicas', 'replicas must be 1..20');
      if (availability.minAvailable !== undefined && (!Number.isInteger(availability.minAvailable) || availability.minAvailable < 0 || availability.minAvailable > replicas)) add('InvalidAvailability', 'runtime.availability.minAvailable', 'minAvailable must be 0..replicas');
      if (availability.topologySpread !== undefined && typeof availability.topologySpread !== 'boolean') add('InvalidAvailability', 'runtime.availability.topologySpread', 'topologySpread must be boolean');
      const autoscaling = availability.autoscaling;
      if (autoscaling) {
        if (typeof autoscaling.enabled !== 'boolean') add('InvalidAutoscaling', 'runtime.availability.autoscaling.enabled', 'enabled must be boolean');
        const min = autoscaling.minReplicas ?? replicas;
        const max = autoscaling.maxReplicas ?? min;
        if (!Number.isInteger(min) || min < 1 || min > 20) add('InvalidAutoscaling', 'runtime.availability.autoscaling.minReplicas', 'minReplicas must be 1..20');
        if (!Number.isInteger(max) || max < min || max > 50) add('InvalidAutoscaling', 'runtime.availability.autoscaling.maxReplicas', 'maxReplicas must be minReplicas..50');
        if (autoscaling.targetCPUUtilization !== undefined && (!Number.isInteger(autoscaling.targetCPUUtilization) || autoscaling.targetCPUUtilization < 1 || autoscaling.targetCPUUtilization > 100)) add('InvalidAutoscaling', 'runtime.availability.autoscaling.targetCPUUtilization', 'targetCPUUtilization must be 1..100');
      }
    }
    if (runtime.networkPolicy && typeof runtime.networkPolicy.enabled !== 'boolean') add('InvalidNetworkPolicy', 'runtime.networkPolicy.enabled', 'enabled must be boolean');
    if (runtime.networkPolicy?.allowMonitoring !== undefined && typeof runtime.networkPolicy.allowMonitoring !== 'boolean') add('InvalidNetworkPolicy', 'runtime.networkPolicy.allowMonitoring', 'allowMonitoring must be boolean');
    if (runtime.observability?.metricsPath && !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(runtime.observability.metricsPath)) add('InvalidObservability', 'runtime.observability.metricsPath', 'metricsPath must be absolute');
    if (runtime.observability?.scrapeInterval && !/^\d+(?:s|m|h)$/.test(runtime.observability.scrapeInterval)) add('InvalidObservability', 'runtime.observability.scrapeInterval', 'scrapeInterval must be a duration such as 30s');
    const logs = runtime.observability?.logs;
    if (logs) {
      if (logs.format !== 'json') add('InvalidObservability', 'runtime.observability.logs.format', 'structured logs must use json');
      if (logs.schema !== 'opensphere.v1') add('InvalidObservability', 'runtime.observability.logs.schema', 'log schema must be opensphere.v1');
      if (!['stdout', 'stderr'].includes(logs.stream)) add('InvalidObservability', 'runtime.observability.logs.stream', 'log stream must be stdout or stderr');
    }
    const traces = runtime.observability?.traces;
    if (traces) {
      if (traces.propagation !== 'w3c') add('InvalidObservability', 'runtime.observability.traces.propagation', 'trace propagation must be w3c');
      if (traces.responseHeaders !== undefined && typeof traces.responseHeaders !== 'boolean') add('InvalidObservability', 'runtime.observability.traces.responseHeaders', 'responseHeaders must be boolean');
    }
  }
  if (!m.manifest) add('Required', 'manifest', 'manifest is required'); else {
    if (!m.manifest.path?.startsWith('/plugins/')) add('InvalidManifestPath', 'manifest.path', 'manifest must be below /plugins/');
    if (!SHA256.test(String(m.manifest.sha256 || ''))) add('InvalidManifestDigest', 'manifest.sha256', 'sha256 must be lowercase hex');
    if (!m.manifest.signaturePath?.startsWith('/plugins/')) add('InvalidSignaturePath', 'manifest.signaturePath', 'signature must be below /plugins/');
  }
  if (!m.trust?.keyId?.trim()) add('Required', 'trust.keyId', 'trusted key id is required');
  if (m.api?.basePath && !/^\/api\/plugins\/[a-z0-9-]+$/.test(m.api.basePath)) add('InvalidApiBase', 'api.basePath', 'api base must be /api/plugins/<id>');
  const c = m.contributions as unknown as Record<string, { enabled?: boolean; reason?: string }> | undefined;
  for (const key of ['page', 'navigation', 'api', 'cli', 'manual', 'search', 'notification', 'observability']) {
    if (!c?.[key] || typeof c[key].enabled !== 'boolean') add('InvalidContribution', `contributions.${key}`, 'enabled must be declared');
    else if (!c[key].enabled && !String(c[key].reason || '').trim()) add('MissingReason', `contributions.${key}.reason`, 'disabled contribution requires a reason');
  }
  return issues;
}

export function isDigestImageReference(reference: string): boolean {
  return /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(reference);
}
