# 2. K8s Cluster + Ceph

Kubernetes 제어면, 워커 노드, 워크로드와 영속 스토리지를 클러스터 실체 그대로 운영합니다.

## 이 Perspective가 답하는 질문

- API Server와 핵심 컨트롤러가 Ready인가?
- 워크로드가 어느 노드에서 어떤 이유로 실패했는가?
- StorageClass, PVC와 Ceph 계층이 요구한 내구성을 제공하는가?

## 주요 대상

- Cluster, Node, Namespace와 ResourceQuota
- Deployment, StatefulSet, DaemonSet, Job과 Pod
- Service, Endpoint, Ingress와 NetworkPolicy
- StorageClass, PVC, PV와 Ceph 상태

## 운영 시작

Cluster Manager를 통해 클러스터를 연결하고 읽기 권한을 검증합니다. 변경 작업은 preview와 승인 근거를 거쳐 적용하며, 모든 결과는 Console 감사 경로로 기록합니다.
