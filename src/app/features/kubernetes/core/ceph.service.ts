import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, switchMap } from 'rxjs';

export type CephConnectionState = 'NotConfigured' | 'Ready' | 'Degraded' | 'Blocked';

export interface CephProviderGuide {
  schemaVersion: number;
  rookVersion: string;
  consumerNamespace: string;
  requiredInformation: Array<{ id: string; label: string; description: string; secret: boolean }>;
  requiredPreparation: Array<{ id: string; label: string; description: string }>;
  network: { monitorTcpPorts: number[]; cephDaemonTcpRange: string; sourceScope: string };
  export: { format: 'json'; commandTemplate: string; requiredFlags: string[] };
  unsupportedInputs: string[];
}

export const CEPH_PROVIDER_GUIDE: CephProviderGuide = {
  schemaVersion: 1,
  rookVersion: 'v1.20.2',
  consumerNamespace: 'rook-ceph',
  requiredInformation: [
    { id: 'fsid', label: 'Ceph FSID', description: '대상 Ceph 클러스터를 유일하게 식별하는 UUID', secret: false },
    { id: 'mon-endpoints', label: 'MON endpoint', description: '각 Monitor의 public-network 주소와 포트(msgr2 3300 권장, msgr1 6789 지원)', secret: false },
    { id: 'storage', label: 'RBD pool / CephFS', description: '사용할 RBD data pool 및/또는 CephFS filesystem·data pool 이름', secret: false },
    { id: 'cephx', label: '제한된 CephX 사용자', description: 'healthchecker와 선택한 CSI 유형의 node/provisioner 사용자 및 key', secret: true },
    { id: 'provider-export', label: 'Rook provider export JSON', description: '동일 Rook 버전의 공식 스크립트가 생성한 JSON resource 배열', secret: true },
  ],
  requiredPreparation: [
    { id: 'health', label: 'Ceph health', description: 'MON quorum과 OSD가 정상이며 연결 작업 시 HEALTH_OK 또는 승인된 경고 상태' },
    { id: 'storage', label: 'Storage 준비', description: 'RBD pool은 생성·초기화되어 있고, CephFS 사용 시 filesystem/MDS가 Active' },
    { id: 'network', label: 'Public network 경로', description: '모든 consumer node에서 MON과 OSD/MDS public 주소로 라우팅·방화벽 통신 가능' },
    { id: 'least-privilege', label: 'Consumer별 최소 권한', description: '--restricted-auth-permission과 고유 --k8s-cluster-name으로 전용 CSI 사용자를 생성' },
    { id: 'lifecycle', label: '운영 인계', description: 'export 생성 인자, Ceph/Rook 버전, key rotation·upgrade 절차와 담당자를 기록' },
  ],
  network: { monitorTcpPorts: [3300, 6789], cephDaemonTcpRange: '6800-7568', sourceScope: 'all-consumer-kubernetes-nodes' },
  export: {
    format: 'json',
    commandTemplate: 'python3 create-external-cluster-resources.py --namespace rook-ceph --format json --k8s-cluster-name <consumer-cluster-name> --restricted-auth-permission true --rbd-data-pool-name <rbd-pool> [--cephfs-filesystem-name <cephfs-name>] [--v2-port-enable]',
    requiredFlags: ['--namespace', '--format json', '--k8s-cluster-name', '--restricted-auth-permission true'],
  },
  unsupportedInputs: ['client.admin keyring', 'monitor keyring', 'RGW/object-store credentials', 'Ceph dashboard credentials'],
};

export interface CephStatus {
  state: CephConnectionState;
  reason: string;
  message: string;
  checkedAt: string;
  providerGuide?: CephProviderGuide;
  kubernetes: { ready: boolean; id?: string; version?: string; nodes?: number; readyNodes?: number };
  connection: null | {
    mode: 'RookExternal';
    fsidFingerprint: string;
    secretRefs: string[];
    connectedBy: string;
    connectedAt: string;
    chartVersion: string;
  };
  rook?: {
    operator: { installed: boolean | null; status: string; chart: string; revision: number; reason?: string };
    cluster: { installed: boolean | null; status: string; chart: string; revision: number; reason?: string };
    cephCluster: null | { state: string; health: string };
  };
  csi?: {
    drivers: string[];
    storageClasses: Array<{ name: string; provisioner: string; reclaimPolicy: string }>;
  };
  ownerPrerequisites?: {
    ready: boolean;
    blockers: string[];
    missingPermissions: string[];
    operatorReady: boolean;
    cephClusterCrdReady: boolean;
    snapshotApiReady: boolean;
    namespaces?: { runtime: boolean; imports: boolean };
    policy?: { operatorOwner: string; runtimeOwner: string; importTransport: string };
  };
}

export interface CephPlan {
  mode: 'RookExternal';
  namespace: string;
  parent: 'Kubernetes';
  fsidFingerprint: string;
  monitorCount: number;
  monitorProtocols?: string[];
  storage: Array<{ name: string; pool: string; filesystem: string }>;
  secretRefs: string[];
  charts: Array<{ release: string; chart: string; version: string; valuesProfile?: string }>;
  resources: Array<{ kind: string; namespace: string; name: string; secretRefOnly?: boolean; reclaimPolicy?: string; deletionPolicy?: string }>;
  ignoredProviderResources: string[];
  snapshotSupported: boolean;
  providerGuide?: CephProviderGuide;
  safety: {
    rawCredentialsPersistedByConsole: boolean;
    remotePoolsModified: boolean;
    remoteDataDeletedOnDisconnect: boolean;
    reclaimPolicy: string;
  };
}

export interface CephImport {
  importRef: string;
  fsidFingerprint: string;
  monitorCount: number;
  storageClasses: string[];
  expiresAt: string;
  secretValuesReturned: false;
}

@Injectable({ providedIn: 'root' })
export class CephService {
  private http = inject(HttpClient);

  private base(): string {
    const w = window as any;
    return String(w.__OSP_NG_BASES__?.['osp-k8s-console-ng'] ?? w.__OSP_NG_API_BASE__ ?? '').replace(/\/$/, '');
  }

  private url(path: string): string { return `${this.base()}/api/ceph/${path}`; }

  status(): Observable<CephStatus> { return this.http.get<CephStatus>(this.url('oaa/status')); }
  plan(providerExport: string): Observable<CephPlan> { return this.http.post<CephPlan>(this.url('plan'), { providerExport }); }
  stage(providerExport: string, reason: string): Observable<CephImport> {
    return this.http.post<CephImport>(this.url('imports'), { providerExport, reason, confirm: 'stage Ceph provider export' });
  }
  connect(providerExport: string, reason: string): Observable<{ ok: boolean; status: CephStatus }> {
    return this.stage(providerExport, reason).pipe(switchMap((staged) => this.connectImport(staged.importRef, reason)));
  }
  connectImport(importRef: string, reason: string): Observable<{ ok: boolean; status: CephStatus }> {
    const confirm = `connect Ceph external storage using ${importRef}`;
    return this.http.post<{ ok: boolean; status: CephStatus }>(this.url('oaa/connect'), { importRef, reason, confirm });
  }
  disconnect(reason: string): Observable<{ ok: boolean; retained: string[]; removed: string[] }> {
    const confirm = 'disconnect Ceph external storage';
    return this.http.post<{ ok: boolean; retained: string[]; removed: string[] }>(this.url('oaa/disconnect'), { reason, confirm });
  }
}
