# Beszel supplemental host diagnostics for CC2

This package deploys Beszel `0.18.7` as the **Linux-host time-series metrics
source for RCC**, with its upstream dashboard retained as a supplemental
diagnostic surface:

```text
CC2 host systemd agent -> outbound WSS -> Beszel Hub
RCC backend -> HTTPS + dedicated readonly user -> Beszel PocketBase API
RCC operator -> authenticated RCC plugin API -> projected charts and summaries
administrator -> HTTPS / Traefik -> Beszel upstream dashboard (supplemental)
```

Beszel is owned by HIS and remains outside RCC's authority boundary:

- it supplies historical CPU, memory, disk, network and load metrics to the RCC
  Linux host page through a dedicated `readonly` Beszel account;
- RCC does not iframe the upstream UI or expose a PocketBase token to the
  browser; its backend re-verifies the RCC reader assignment and projects a
  bounded `rcc.host.metrics/v1` response;
- it is not an RCC control API, operation audit trail or host authority;
- it shares no RCC session, database, RBAC or ServiceAccount, and an outage
  degrades only the Metrics tab;
- it is not the RCC readiness gate or the platform's general alerting,
  Kubernetes, logs or traces source;
- it does not replace Prometheus, logs, traces, alerting or Kubernetes
  observability;
- it does not monitor K3s containers. Beszel supports Docker/Podman, not
  containerd/CRI, so `BESZEL_AGENT_DOCKER_HOST` is deliberately empty;
- it observes the host and never changes it.

The old DaemonSet pattern is deliberately absent. The upstream Kubernetes agent
example predates outbound WebSocket mode, opens a host port and cannot provide
correct K3s containerd visibility. CC2 instead runs the static agent as a
non-root systemd service with its SSH server disabled.

## Pinned supply chain

Public release facts live in `release.env`:

- Hub image:
  `docker.io/henrygd/beszel@sha256:a849ad80814b6a1a3be665304dcace5d4854b3bed7bde4dd1227e8ce1b82d477`
- ARM64 agent archive SHA-256:
  `0134256068937cab74b7f26e37007a4b5bf3d52cd40496a8b8b0ebbbb1a6f02f`
- release: `0.18.7`

`latest` and in-process auto-update are not used. The installer downloads the
one release archive, verifies its SHA-256 before extraction, rejects unexpected
archive members and installs into a versioned directory.

## Prerequisite: DNS

Create this record before bootstrap:

```text
beszel.cc2.opl.io.kr. 300 IN A 158.180.78.77
```

`bootstrap.sh` refuses to create an Ingress or trigger ACME until this exact
record resolves. Beszel uses a separate origin rather than an RCC subpath. The
bootstrap host also needs a local `kubectl` client; it builds Secret manifests
locally from the protected files and streams them to the remote CC2 wrapper, so
the remote shell never receives a local secret path and secret values never
appear in command arguments.

## Secret preparation

Create a directory outside this repository with mode `0700`. Put three files in
it, without a trailing newline:

```text
pb-encryption-key  exactly 32 random characters
user-email         the initial regular administrator email
user-password      at least 16 characters
```

The PocketBase encryption key is permanent. Escrow it separately from the
volume and backup; losing it can make encrypted application settings
unrecoverable. The email and password are first-boot inputs only.

No secret is passed as a command-line argument or printed. `bootstrap.sh`
creates:

- permanent `beszel-hub-encryption`;
- temporary `beszel-hub-bootstrap`.

## Install

```sh
export BESZEL_SECRET_DIRECTORY=/absolute/secure/beszel-cc2
./deploy/his/beszel/bootstrap.sh
node ./deploy/his/beszel/enroll-agent.mjs "$BESZEL_SECRET_DIRECTORY"
```

Copy only the agent package and
`$BESZEL_SECRET_DIRECTORY/agent/{key,token}` to a root-readable temporary
directory on CC2, then run:

```sh
sudo BESZEL_AGENT_SECRET_DIRECTORY=/absolute/temporary/agent \
  ./deploy/his/beszel/agent/install.sh
```

After the Hub shows `CMARS-OCI-CC-02-4X24` connected:

```sh
export BESZEL_SECRET_DIRECTORY=/absolute/secure/beszel-cc2
./deploy/his/beszel/finalize-bootstrap.sh
./deploy/his/beszel/smoke.sh
```

Finalization refuses to proceed until that exact system is `up`. It then:

1. disables universal self-registration;
2. deletes the first-boot email/password Secret;
3. restarts the Hub with only the permanent encryption Secret;
4. rechecks health.

## Kubernetes security boundary

- namespace `beszel-system`, Pod Security `restricted`;
- one Hub replica, `Recreate`, ARM64 only;
- no Role, RoleBinding, ClusterRole or Kubernetes API token;
- numeric uid/gid/fsGroup 1000;
- read-only root filesystem, all capabilities dropped, RuntimeDefault seccomp;
- one 5 GiB RWO PVC using a dedicated `Retain` local-path StorageClass;
- ClusterIP only; Traefik is the only pod allowed to reach port 8090;
- default-deny ingress and egress;
- no DaemonSet, hostPath, host namespace, host port, privileged mode or runtime
  socket;
- WebSocket `/api/beszel/agent-connect` passes through the same TLS Ingress.

`AUTO_LOGIN` and `TRUSTED_AUTH_HEADER` are not configured. Beszel's own verified
regular user signs in at the dedicated origin.

## RCC metrics reader

RCC uses a separate verified Beszel user whose live role must be exactly
`readonly`. Beszel's collection rules permit that identity to list its shared
system and `system_stats`, but refuse system and settings mutations. The RCC
adapter repeats the role check on every authentication cycle and fails closed
if the identity is promoted to `user` or `admin`.

Provision or rotate the reader after the CC2 system is connected:

```sh
node ./deploy/his/beszel/provision-rcc-reader.mjs \
  /absolute/secure/beszel-cc2 \
  /absolute/secure/beszel-cc2/rcc-reader
```

The command writes `rcc-reader/config.json` with mode `0600` and does not print
its password or token. It contains only the reader credential and the explicit
binding:

```text
cc2/cmars-oci-cc-02-4x24 -> CMARS-OCI-CC-02-4X24
```

The CC2 RCC deployment requires that file through
`RCC_BESZEL_READER_CONFIG`. It streams it into the backend-only Kubernetes
Secret `polyon-rcc-beszel-reader`; web and maintenance workloads do not receive
or mount it. The backend calls the reviewed TLS origin
`https://beszel.cc2.opl.io.kr`, not an arbitrary URL or a browser-side API.

## Host agent boundary

The systemd agent:

- runs as static user/group `beszel`;
- reads key and token from root-owned `0440` files;
- sets `DISABLE_SSH=true` and listens on no port;
- opens only an outbound TLS WebSocket to the Hub;
- has no Docker/containerd socket and no Kubernetes credentials;
- has no Linux capability and a strict systemd sandbox;
- reports host CPU, memory, filesystems, the management NIC and selected
  systemd units.

The service intentionally does not use `ProcSubset=pid`, because full `/proc`
host counters are the purpose of this agent. It also avoids `PrivateDevices`,
which can interfere with the agent health path. This does not grant device
write authority.

## Backup and restore

`beszel-local-retain` protects against an accidental PVC deletion. It does
**not** protect against CC2 node loss.

Before production acceptance:

1. configure the PocketBase built-in backup to a dedicated off-node
   S3-compatible bucket;
2. run daily and retain at least 14 generations;
3. enable bucket encryption and versioning (Object Lock where available);
4. escrow the 32-character PocketBase encryption key outside both K3s and the
   backup bucket;
5. restore into an isolated namespace/PVC and record the drill result.

Until an off-node restore succeeds, Beszel history is best-effort only. The
single-node Hub also disappears during a CC2 outage, so important availability
alerts must remain external.

## Acceptance

The repository contract test:

```sh
node --test backend/dupa-control/beszel-deployment-contract.test.js
```

The live read-only checks:

```sh
./deploy/his/beszel/smoke.sh
```

Beszel itself is installed and upgraded only as an explicit HIS-owned
operation. RCC deployment consumes only the pre-provisioned readonly
`config.json`; it never installs or upgrades Beszel and never receives its
superuser or agent enrollment credentials.
