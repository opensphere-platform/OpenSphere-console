import { Type } from '@angular/core';
// ── 코어 K8s 리소스(항상 존재) ──
import { NodesComponent } from './resources/nodes.component';
import { NodeWorkloadsComponent } from './resources/node-workloads.component';
import { PodComponent } from './resources/pods.component';
import { DeploymentComponent } from './resources/deployments.component';
import { ReplicaSetComponent } from './resources/replicasets.component';
import { StatefulSetComponent } from './resources/statefulsets.component';
import { DaemonSetComponent } from './resources/daemonsets.component';
import { JobComponent } from './resources/jobs.component';
import { CronJobComponent } from './resources/cronjobs.component';
import { JobSetComponent } from './resources/jobsets.component';
import { HorizontalPodAutoscalerComponent } from './resources/hpas.component';
import { VerticalPodAutoscalerComponent } from './resources/vpas.component';
import { PodDisruptionBudgetComponent } from './resources/pdbs.component';
import { ServiceComponent } from './resources/services.component';
import { IngressComponent } from './resources/ingresses.component';
import { EndpointsComponent } from './resources/endpoints.component';
import { EndpointSliceComponent } from './resources/endpointslices.component';
import { NetworkPolicyComponent } from './resources/networkpolicies.component';
import { ConfigMapComponent } from './resources/configmaps.component';
import { ResourceQuotaComponent } from './resources/resourcequotas.component';
import { LimitRangeComponent } from './resources/limitranges.component';
import { NamespaceComponent } from './resources/namespaces.component';
import { PriorityClassComponent } from './resources/priorityclasses.component';
import { RuntimeClassComponent } from './resources/runtimeclasses.component';
import { LeaseComponent } from './resources/leases.component';
import { CustomResourceDefinitionComponent } from './resources/crds.component';
import { RoleComponent } from './resources/roles.component';
import { ServiceAccountComponent } from './resources/serviceaccounts.component';
import { IngressClassComponent } from './resources/ingressclasses.component';
import { PersistentVolumeClaimComponent } from './resources/persistentvolumeclaims.component';
import { PersistentVolumeComponent } from './resources/persistentvolumes.component';
import { StorageClassComponent } from './resources/storageclasses.component';
import { EventComponent } from './resources/events.component';
import { RoleBindingComponent } from './resources/rolebindings.component';
import { ClusterRoleComponent } from './resources/clusterroles.component';
import { ClusterRoleBindingComponent } from './resources/clusterrolebindings.component';
/** RCC의 첫 단계는 Kubernetes 읽기 전용 관리 관점만 노출한다. */
export type ManagementView = 'k8s';
/** 앱 내부 사이드바 네비. requires=이 항목이 요구하는 apiGroup — 클러스터에 실재할 때만 노출(capability-gate, §3.3 실구현만). */
export interface NavItem { id: string; label: string; component: Type<any>; requires?: string; }
/** view: 상단 관리 관점 선택기에 연결되는 전문 화면 영역. 기본값은 k8s. */
export interface NavGroup { group: string; items: NavItem[]; view?: ManagementView; }

export const NAV: NavGroup[] = [
  {
    group: 'Workloads',
    items: [
      { id: 'pods', label: 'Pods', component: PodComponent },
      { id: 'deployments', label: 'Deployments', component: DeploymentComponent },
      { id: 'replicasets', label: 'ReplicaSets', component: ReplicaSetComponent },
      { id: 'statefulsets', label: 'StatefulSets', component: StatefulSetComponent },
      { id: 'daemonsets', label: 'DaemonSets', component: DaemonSetComponent },
      { id: 'jobs', label: 'Jobs', component: JobComponent },
      { id: 'cronjobs', label: 'CronJobs', component: CronJobComponent },
      { id: 'jobsets', label: 'Job Sets', component: JobSetComponent, requires: 'jobset.x-k8s.io' },
      { id: 'hpas', label: 'Horizontal Pod Autoscalers', component: HorizontalPodAutoscalerComponent },
      { id: 'vpas', label: 'Vertical Pod Autoscalers', component: VerticalPodAutoscalerComponent, requires: 'autoscaling.k8s.io' },
      { id: 'pdbs', label: 'Pod Disruption Budgets', component: PodDisruptionBudgetComponent },
    ],
  },
  {
    group: 'Network',
    items: [
      { id: 'services', label: 'Services', component: ServiceComponent },
      { id: 'ingresses', label: 'Ingresses', component: IngressComponent },
      { id: 'endpoints', label: 'Endpoints', component: EndpointsComponent },
      { id: 'endpointslices', label: 'Endpoint Slices', component: EndpointSliceComponent },
      { id: 'ingressclasses', label: 'Ingress Classes', component: IngressClassComponent },
      { id: 'networkpolicies', label: 'Network Policies', component: NetworkPolicyComponent },
    ],
  },
  {
    group: 'Config & Storage',
    items: [
      { id: 'configmaps', label: 'ConfigMaps', component: ConfigMapComponent },
      { id: 'resourcequotas', label: 'Resource Quotas', component: ResourceQuotaComponent },
      { id: 'limitranges', label: 'Limit Ranges', component: LimitRangeComponent },
      { id: 'pvcs', label: 'Persistent Volume Claims', component: PersistentVolumeClaimComponent },
      { id: 'pvs', label: 'Persistent Volumes', component: PersistentVolumeComponent },
      { id: 'storageclasses', label: 'Storage Classes', component: StorageClassComponent },
    ],
  },
  {
    group: 'Cluster',
    items: [
      { id: 'nodes', label: 'Nodes', component: NodesComponent },
      { id: 'node-workloads', label: 'Node Workloads', component: NodeWorkloadsComponent },
      { id: 'namespaces', label: 'Namespaces', component: NamespaceComponent },
      { id: 'events', label: 'Events', component: EventComponent },
      { id: 'priorityclasses', label: 'Priority Classes', component: PriorityClassComponent },
      { id: 'runtimeclasses', label: 'Runtime Classes', component: RuntimeClassComponent },
      { id: 'leases', label: 'Leases', component: LeaseComponent },
      { id: 'crds', label: 'Custom Resource Definitions', component: CustomResourceDefinitionComponent },
    ],
  },
  {
    group: 'Access',
    items: [
      { id: 'roles', label: 'Roles', component: RoleComponent },
      { id: 'rolebindings', label: 'Role Bindings', component: RoleBindingComponent },
      { id: 'clusterroles', label: 'Cluster Roles', component: ClusterRoleComponent },
      { id: 'clusterrolebindings', label: 'Cluster Role Bindings', component: ClusterRoleBindingComponent },
      { id: 'serviceaccounts', label: 'Service Accounts', component: ServiceAccountComponent },
    ],
  },
];
