# Extension Controller

`C_EXT` is the Console-native owner for Extension operations, governed plugin serving, and target workload lifecycle. It remains a separate process and service identity at `opensphere-extension-controller`.

The operation controller claims only `console.extension.install@1.0`, `console.extension.remove@1.0`, and `console.extension.revocation.create@1.0` through fenced PostgreSQL RPCs. Install re-resolves the catalog revision through C_REG, compares the immutable image and `UIPluginPackage` generation/resourceVersion, rechecks revocation, and creates one idempotent `UIPluginRegistration`. Removal rejects shell-pinned core packages and applies `desiredState=Uninstalled` with a resourceVersion fence. Observation records readiness or absence only for the same Package coordinates and Registration UID.

The target lifecycle implementation is in `src/kubernetes-extension-lifecycle.mjs` and `src/extension-release.mjs`. It processes at most 256 Registrations with bounded round-robin selection. A Package is materialized only from its exact GHCR digest and full release provenance. Generated ServiceAccount, Deployment, revision Service, PodDisruptionBudget, and active Service are namespaced, carry `opensphere-extension-controller` management labels, and have a `UIPluginPackage` ownerRef. Existing objects must also have the expected UID, resourceVersion, immutable annotations, labels, ownerRef, kind, name, and namespace before patch or removal.

Activation waits for the exact Deployment rollout, loads `opensphere-extension-trusted-keys`, hashes the raw manifest bytes, verifies the P-256 signature, hashes the served entry and auxiliary assets, and rejects artifacts with external module dependencies. Only then may the stable Service move to the verified revision. A changed verified release moves the former `status.current*` coordinates to `status.previous*` in the same status patch; the same digest leaves previous rollback evidence unchanged.

The target-owned Kubernetes schemas are `crds/ui-plugin-crds.yaml`. The reviewed public SPKI set is projected without keyId or byte changes in `config/trusted-keys.yaml`. Kubernetes TLS uses the mounted service-account CA through `NODE_EXTRA_CA_CERTS`.

## Activation state and RBAC boundary

`deploy.yaml` currently sets `CONSOLE_EXTENSION_LIFECYCLE_ENABLED=false`. This is intentional: the current namespaced Role can create and patch Registrations but cannot yet create, patch, or delete the generated workloads, patch the Registration status subresource, or read the exact trust ConfigMap. Enabling the loop before those permissions are approved would make readiness fail closed and leave every lifecycle operation pending.

Activation must be atomic with a reviewed `opensphere-console` namespace Role update. The minimum authority is Package and Registration reads, Registration status patch, exact trust ConfigMap get, and get/create/patch for ServiceAccounts, Deployments, Services, and PodDisruptionBudgets. Uninstall and inactive-revision garbage collection additionally require delete. The pure cleanup planner validates every candidate's ownerRef, management labels, release annotations, generated name, UID, and resourceVersion, but runtime deletion is not wired until that destructive authority is explicitly approved.

The target does not request cluster-wide workload authority, Secret reads, arbitrary resource deletion, or Package mutation. The installer must render `__OPENSPHERE_EXTENSION_CONTROLLER_IMAGE__` to the exact signed BOM digest and provision the database URL separately.

## HTTP surface

C_API reaches the target through `/api/plugins/:extensionId/**`. C_EXT independently revalidates the exchanged Bearer credential with marker `extension-controller-v1`, rejects browser Cookie and raw CSRF headers, requires C_API's verified mutation assertion, resolves only an activated exact serving Registration, and removes owner credentials before proxying.

Catalog, binding, event, navigation, icon, enable/disable, uninstall, and rollback management endpoints are not implemented in this slice. They must remain cut over as inactive until backed by real resourceVersion-fenced Kubernetes methods and durable audit authority.
