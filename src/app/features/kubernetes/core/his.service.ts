import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type HisState = 'Ready' | 'Blocked' | 'Degraded';
export type HisMode = 'DetectOnly' | 'HelmManaged';

export interface HisComponentDetail {
  name: string;
  kind: string;
  resourceName: string;
  namespace: string;
  state: 'Ready' | 'Pending' | 'Missing';
  desired: number;
  ready: number;
  image: string;
}

export interface HisOperation {
  id: string;
  itemId: string;
  displayName: string;
  action: 'install' | 'upgrade' | 'recover' | 'rollback' | 'uninstall' | 'configure' | 'validate';
  phase: 'Queued' | 'Recovering' | 'Installing' | 'Upgrading' | 'RollingBack' | 'Configuring' | 'Migrating' | 'Validating' | 'Uninstalling' | 'Ready' | 'Removed' | 'Failed' | 'RollbackStalled';
  progress: number;
  message: string;
  error: string;
  actor: string;
  worker: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string;
  releaseStatus?: string;
  targetRevision?: number;
}

export type HisEvidenceState = 'Passed' | 'Failed' | 'Info' | 'NotRun' | 'Unsupported';

export interface HisFact { label: string; value: string; state: HisEvidenceState; }
export interface HisCanary { name: string; state: HisEvidenceState; message: string; }
export interface HisEvidence { name: string; state: HisEvidenceState; message: string; }
export interface HisDiagnosticTable {
  title: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string>>;
}
export interface HisCompatibility { kubernetes: string; policy: string; }
export interface HisRemediation { summary: string; steps: string[]; verification: string; }

export interface HisCheck {
  state: HisState;
  reason: string;
  message: string;
  observedVersion: string;
  retryable: boolean;
  lastCheckedAt: string;
  details?: {
    components?: HisComponentDetail[];
    crds?: { ready: number; total: number; items: Array<{ name: string; ready: boolean }> };
    pvcs?: Array<{ name: string; phase: string; requested: string; capacity: string; storageClass: string }>;
    services?: Array<{ name: string; type: string; clusterIP: string; ports: string }>;
    facts?: HisFact[];
    tables?: HisDiagnosticTable[];
    warnings?: string[];
    security?: string[];
    canaries?: HisCanary[];
    evidence?: HisEvidence[];
    validationFingerprint?: string;
    compatibility?: HisCompatibility | null;
    remediation?: HisRemediation | null;
  };
}

export interface HisItem {
  id: string;
  displayName: string;
  description: string;
  mode: HisMode;
  required: boolean;
  profile?: string;
  profileSelected?: boolean;
  effectiveRequired?: boolean;
  domain?: string;
  compatibility?: HisCompatibility;
  remediation?: HisRemediation;
  chartName?: string;
  chartVersion?: string;
  appVersion?: string;
  source?: string;
  namespace?: string;
  release?: { managed: boolean; status: string; revision: number } | null;
  operation?: HisOperation | null;
  operationalProfile?: {
    components: string[];
    storage: string[];
    retention: string[];
    exposure: string;
  };
  ownership: 'ClusterManager' | 'External' | 'Unmanaged' | 'Unknown';
  retainedOnDelete?: string[];
  check: HisCheck;
}

export interface HisStatus {
  stack: 'HIS';
  state: HisState;
  checkedAt: string;
  items: HisItem[];
  profiles: HisProfileStatus[];
  summary: {
    coreReady: number;
    coreTotal: number;
    selectedProfilesReady: number;
    selectedProfilesTotal: number;
  };
}

export interface HisProfileStatus {
  name: string;
  selected: boolean;
  selectionSource: 'Explicit' | 'ManagedRelease' | 'None';
  state: HisState | 'NotSelected';
  ready: number;
  total: number;
  itemIds: string[];
}

export interface HisPlan {
  id: string;
  displayName: string;
  chart: string;
  chartVersion: string;
  namespace: string;
  release: string;
  clusterVariant: string;
  retainedOnDelete: string[];
  summary: {
    workloads: number;
    services: number;
    persistentVolumeClaims: number;
    customResourceDefinitions: number;
    byKind: Record<string, number>;
  };
  operationalProfile?: HisItem['operationalProfile'];
  resources: Array<{ apiVersion: string; kind: string; namespace: string; name: string }>;
  history: Array<{ revision: number; updated: string; status: string; chart: string; appVersion: string; description: string }>;
}

export type GrafanaExposureMode = 'ClusterInternal' | 'PrivateIngress' | 'PublicIngress';

export interface ObservabilityConfig {
  schemaVersion: 1;
  prometheus: {
    retention: string;
    storageClassName: string;
    storageSize: string;
    remoteWrite: { enabled: boolean; url: string; secretName: string; secretKey: string };
  };
  alertmanager: { retention: string; storageClassName: string; storageSize: string };
  grafana: {
    storageClassName: string;
    storageSize: string;
    exposureMode: GrafanaExposureMode;
    hostname: string;
    ingressClassName: string;
    ingressNamespace: string;
    tlsSecretName: string;
    oidcSecretName: string;
    allowedCidrs: string[];
  };
  telemetry: {
    enabled: boolean;
    retention: string;
    storageClassName: string;
    lokiStorageSize: string;
    tempoStorageSize: string;
  };
}

export interface StorageClassOption {
  name: string;
  provisioner: string;
  isDefault: boolean;
  allowVolumeExpansion: boolean;
  reclaimPolicy: string;
  volumeBindingMode: string;
}

export interface ObservabilityLiveState {
  installed: boolean;
  storageClasses: StorageClassOption[];
  ingressClasses: Array<{ name: string; controller: string }>;
  pvcs: Record<string, { name: string; phase: string; storageClassName: string; requested: string; capacity: string; volumeName: string; selectedNode: string }>;
  prometheus: { retention: string; remoteWrite: Array<{ name: string; url: string; secretName: string; secretKey: string }> } | null;
  alertmanager: { retention: string } | null;
  grafana: { serviceType: string; ingress: null | { name: string; hostname: string; ingressClassName: string; tlsSecretName: string; exposureMode: GrafanaExposureMode } };
  networkPolicies: string[];
  directExternalServices: string[];
  telemetry: { loki: boolean; tempo: boolean; otlp: boolean };
}

export interface ObservabilityConfigurationState {
  config: ObservabilityConfig;
  source: 'ManagedConfig' | 'InferredFromCluster' | 'Defaults';
  storageClasses: StorageClassOption[];
  ingressClasses: Array<{ name: string; controller: string }>;
  live: ObservabilityLiveState;
  policy: {
    prometheusExternalExposure: 'Prohibited';
    alertmanagerExternalExposure: 'Prohibited';
    grafanaModes: GrafanaExposureMode[];
    requiredOidcSecretKeys: string[];
    resetConfirmation: string;
    publicConfirmation: string;
  };
}

export interface ObservabilityConfigurationPlan {
  config: ObservabilityConfig;
  currentConfig: ObservabilityConfig;
  changes: Array<{ field: string; from: string; to: string; impact: 'Storage' | 'Access' | 'Runtime' }>;
  blockers: string[];
  warnings: string[];
  requiresDataReset: boolean;
  resetTargets: string[];
  resizeTargets: Array<{ component: string; pvcName: string; from: string; to: string }>;
  canApply: boolean;
  prerequisites: { tlsSecretReady: boolean; oidcSecretReady: boolean; ingressClassReady: boolean };
  live: ObservabilityLiveState;
  policy: { prometheusExternalExposure: 'Prohibited'; alertmanagerExternalExposure: 'Prohibited'; grafanaServiceType: 'ClusterIP'; publicConfirmation: string };
}

@Injectable({ providedIn: 'root' })
export class HisService {
  private http = inject(HttpClient);

  private base(): string {
    const w = window as any;
    return String(w.__OSP_NG_BASES__?.['osp-k8s-console-ng'] ?? w.__OSP_NG_API_BASE__ ?? '').replace(/\/$/, '');
  }

  private url(path: string): string { return `${this.base()}/api/his/${path}`; }

  status(): Observable<HisStatus> { return this.http.get<HisStatus>(this.url('status')); }
  setProfile(profile: string, selected: boolean, reason: string): Observable<HisStatus> {
    return this.http.post<HisStatus>(this.url('profiles'), { profile, selected, reason });
  }
  validate(id: 'cluster-network' | 'cluster-dns' | 'kube-prometheus-stack' | 'storage' | 'csi-snapshot', reason: string): Observable<{ ok: boolean; operation: HisOperation }> {
    return this.http.post<{ ok: boolean; operation: HisOperation }>(this.url('validate'), { id, reason });
  }
  plan(id: string): Observable<HisPlan> { return this.http.post<HisPlan>(this.url('plan'), { id }); }
  install(id: string, reason: string): Observable<{ ok: boolean; operation: HisOperation }> { return this.http.post<{ ok: boolean; operation: HisOperation }>(this.url('install'), { id, reason }); }
  upgrade(id: string, reason: string): Observable<{ ok: boolean; operation: HisOperation }> { return this.http.post<{ ok: boolean; operation: HisOperation }>(this.url('upgrade'), { id, reason }); }
  recover(id: string, reason: string): Observable<{ ok: boolean; operation: HisOperation }> { return this.http.post<{ ok: boolean; operation: HisOperation }>(this.url('recover'), { id, reason }); }
  rollback(id: string, revision: number, reason: string, confirm: string): Observable<{ ok: boolean; operation: HisOperation }> {
    return this.http.post<{ ok: boolean; operation: HisOperation }>(this.url('rollback'), { id, revision, reason, confirm });
  }
  uninstall(id: string, reason: string, confirm: string): Observable<{ ok: boolean; operation: HisOperation }> {
    return this.http.post<{ ok: boolean; operation: HisOperation }>(this.url('uninstall'), { id, reason, confirm });
  }
  observabilityConfig(): Observable<ObservabilityConfigurationState> {
    return this.http.get<ObservabilityConfigurationState>(this.url('observability/config'));
  }
  observabilityPlan(config: ObservabilityConfig): Observable<ObservabilityConfigurationPlan> {
    return this.http.post<ObservabilityConfigurationPlan>(this.url('observability/plan'), { id: 'kube-prometheus-stack', config });
  }
  configureObservability(
    config: ObservabilityConfig,
    reason: string,
    resetData: boolean,
    resetConfirmation: string,
    publicConfirmation: string,
  ): Observable<{ ok: boolean; operation: HisOperation }> {
    return this.http.post<{ ok: boolean; operation: HisOperation }>(this.url('observability/configure'), {
      id: 'kube-prometheus-stack', config, reason, resetData, resetConfirmation, publicConfirmation,
    });
  }
}
