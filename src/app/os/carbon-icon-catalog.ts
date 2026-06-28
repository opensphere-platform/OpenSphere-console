// 큐레이션 Carbon 아이콘 카탈로그 — 1단 shell 아이콘 지정용(기본값 + 설치 시 사용자 선택).
//   token = @carbon/icons 경로명(예 'container-registry'). UIPluginPackage spec.nav.icon 에 이 token 저장.
//   셸/피커가 token → 디스크립터로 매핑. 목록은 검색 가능한 그리드로 노출.
import Kubernetes16 from '@carbon/icons/es/kubernetes/16';
import ContainerRegistry16 from '@carbon/icons/es/container-registry/16';
import Application16 from '@carbon/icons/es/application/16';
import Dashboard16 from '@carbon/icons/es/dashboard/16';
import Api16 from '@carbon/icons/es/api/16';
import Catalog16 from '@carbon/icons/es/catalog/16';
import Grid16 from '@carbon/icons/es/grid/16';
import Settings16 from '@carbon/icons/es/settings/16';
import Cloud16 from '@carbon/icons/es/cloud/16';
import BareMetalServer16 from '@carbon/icons/es/bare-metal-server/16';
import VirtualMachine16 from '@carbon/icons/es/virtual-machine/16';
import Network3_16 from '@carbon/icons/es/network--3/16';
import Network2_16 from '@carbon/icons/es/network--2/16';
import Gateway16 from '@carbon/icons/es/gateway/16';
import Router16 from '@carbon/icons/es/router/16';
import StorageRequest16 from '@carbon/icons/es/storage-request/16';
import ObjectStorage16 from '@carbon/icons/es/object-storage/16';
import Datastore16 from '@carbon/icons/es/datastore/16';
import Security16 from '@carbon/icons/es/security/16';
import Analytics16 from '@carbon/icons/es/analytics/16';
import ChartLine16 from '@carbon/icons/es/chart--line/16';
import Activity16 from '@carbon/icons/es/activity/16';
import Layers16 from '@carbon/icons/es/layers/16';
import Folder16 from '@carbon/icons/es/folder/16';
import Document16 from '@carbon/icons/es/document/16';
import Terminal16 from '@carbon/icons/es/terminal/16';
import Code16 from '@carbon/icons/es/code/16';
import EdgeNode16 from '@carbon/icons/es/edge-node/16';
import IbmCloudVpc16 from '@carbon/icons/es/ibm-cloud--vpc/16';
import Rocket16 from '@carbon/icons/es/rocket/16';
import Flash16 from '@carbon/icons/es/flash/16';
import Workspace16 from '@carbon/icons/es/workspace/16';
import Tools16 from '@carbon/icons/es/tools/16';
import Wikis16 from '@carbon/icons/es/wikis/16';
import Group16 from '@carbon/icons/es/group/16';
import UserMultiple16 from '@carbon/icons/es/user--multiple/16';
import DeploymentPattern16 from '@carbon/icons/es/deployment-pattern/16';

export interface IconChoice {
  token: string;
  label: string;
  icon: any;
}

/** 큐레이션 목록(피커 그리드 순서). token 은 @carbon/icons 경로명. */
export const ICON_CATALOG: IconChoice[] = [
  { token: 'kubernetes', label: 'Kubernetes', icon: Kubernetes16 },
  { token: 'virtual-machine', label: 'Virtual Machine', icon: VirtualMachine16 },
  { token: 'bare-metal-server', label: 'Bare Metal', icon: BareMetalServer16 },
  { token: 'container-registry', label: 'Container Registry', icon: ContainerRegistry16 },
  { token: 'datastore', label: 'Datastore', icon: Datastore16 },
  { token: 'object-storage', label: 'Object Storage', icon: ObjectStorage16 },
  { token: 'storage-request', label: 'Storage', icon: StorageRequest16 },
  { token: 'network--3', label: 'Network', icon: Network3_16 },
  { token: 'network--2', label: 'Network (alt)', icon: Network2_16 },
  { token: 'gateway', label: 'Gateway', icon: Gateway16 },
  { token: 'router', label: 'Router', icon: Router16 },
  { token: 'ibm-cloud--vpc', label: 'VPC', icon: IbmCloudVpc16 },
  { token: 'edge-node', label: 'Edge Node', icon: EdgeNode16 },
  { token: 'cloud', label: 'Cloud', icon: Cloud16 },
  { token: 'security', label: 'Security', icon: Security16 },
  { token: 'analytics', label: 'Analytics', icon: Analytics16 },
  { token: 'chart--line', label: 'Chart', icon: ChartLine16 },
  { token: 'activity', label: 'Activity', icon: Activity16 },
  { token: 'dashboard', label: 'Dashboard', icon: Dashboard16 },
  { token: 'api', label: 'API', icon: Api16 },
  { token: 'catalog', label: 'Catalog', icon: Catalog16 },
  { token: 'application', label: 'Application', icon: Application16 },
  { token: 'deployment-pattern', label: 'Deployment', icon: DeploymentPattern16 },
  { token: 'layers', label: 'Layers', icon: Layers16 },
  { token: 'grid', label: 'Grid', icon: Grid16 },
  { token: 'workspace', label: 'Workspace', icon: Workspace16 },
  { token: 'folder', label: 'Folder', icon: Folder16 },
  { token: 'document', label: 'Document', icon: Document16 },
  { token: 'code', label: 'Code', icon: Code16 },
  { token: 'terminal', label: 'Terminal', icon: Terminal16 },
  { token: 'tools', label: 'Tools', icon: Tools16 },
  { token: 'rocket', label: 'Rocket', icon: Rocket16 },
  { token: 'flash', label: 'Flash', icon: Flash16 },
  { token: 'wikis', label: 'Docs', icon: Wikis16 },
  { token: 'group', label: 'Group', icon: Group16 },
  { token: 'user--multiple', label: 'Users', icon: UserMultiple16 },
  { token: 'settings', label: 'Settings', icon: Settings16 },
];

const BY_TOKEN: Record<string, any> = ICON_CATALOG.reduce((m, c) => { m[c.token] = c.icon; return m; }, {} as Record<string, any>);

/** token → Carbon 디스크립터. 없으면 null(호출부가 폴백 처리). */
export function iconByToken(token: string | undefined | null): any | null {
  return token && BY_TOKEN[token] ? BY_TOKEN[token] : null;
}
