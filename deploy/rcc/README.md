# PolyON Region Control Center — CC2

This directory contains the first CC2 deployment baseline for the PolyON
Region Control Center.

## Public endpoint

- URL: `https://rcc.cc2.opl.io.kr`
- Required DNS record: `rcc.cc2.opl.io.kr. 300 IN A 158.180.78.77`
- Ingress: Traefik `websecure`
- Certificate resolver: `letsencrypt`

DNS must resolve publicly before Traefik can complete the ACME HTTP challenge.

## Runtime boundaries

- `polyon-rcc`: Web, backend API, read-only Kubernetes proxy
- `polyon-rcc-data`: Supabase identity, PostgreSQL, PostgREST, Storage
- `polyon-rcc-change`: private Gitea change authority and PostgreSQL

The existing `headlamp` namespace is not modified or removed.

The RCC backend ServiceAccount may read the allowlisted Kubernetes resources.
It cannot read Secrets or create, update, patch, or delete Kubernetes objects.
Browser requests require a Supabase administrator session and an explicit
`operator_control_center` assignment for `cc2`.

## Deployment

Run from the repository root:

```sh
./deploy/rcc/deploy-cc2.sh
```

The script builds arm64 images locally, imports them into CC2 K3s, installs the
isolated Supabase and Gitea authorities when absent, and applies the RCC
workloads. It does not configure public DNS and does not remove the existing
Headlamp deployment.

## Linux host control

The normative documentation is `docs/manual/OS-LEVEL-LINUX-HOST-CONTROL.md`,
published at `https://rcc.cc2.opl.io.kr/manual`. This section only lists the
deployment-side artifacts.

| Artifact | Purpose |
|---|---|
| `backend/supabase/migrations/0027_linux_host_authority.sql` through `0033_host_ssh_protection.sql` | Host inventory, governed operation and SSH-protection authority |
| `supabase-baseline.sql` | CC2 baseline rows for the same authority |
| `subshells/linux-host-manager/` | The registered subShell package: entry bundle, manifest, descriptor |
| `backend/rcc-node-agent/packaging/` | systemd unit, example config, install and uninstall scripts |

### Beszel metrics reader

The Linux host Metrics tab reads the HIS-owned Beszel time-series through the
Console backend. Beszel remains an observation source: RCC neither installs it
nor uses it for readiness, authorization, operations or audit authority.

Provision the dedicated verified `readonly` account and server-only config:

```sh
node ./deploy/his/beszel/provision-rcc-reader.mjs \
  /absolute/secure/beszel-cc2 \
  /absolute/secure/beszel-cc2/rcc-reader
```

Then export the resulting absolute path before deployment:

```sh
export RCC_BESZEL_READER_CONFIG=/absolute/secure/beszel-cc2/rcc-reader/config.json
```

`deploy-cc2.sh` validates the exact
`cc2/cmars-oci-cc-02-4x24 -> CMARS-OCI-CC-02-4X24` binding before its first
mutation and streams the file into Secret `polyon-rcc-beszel-reader`. Only the
backend mounts it at `/etc/rcc/beszel/config.json`; the web, maintenance
workload and browser never receive the credential or PocketBase token. If the
reader is missing, promoted beyond `readonly`, or Beszel is unavailable, only
the Metrics endpoint degrades.

### Agent key document

The backend reads the agent key document from `RCC_AGENT_KEYS_FILE`
(`/etc/rcc/agent-keys/agent-keys.json`), mounted read-only from the optional
Secret `polyon-rcc-agent-keys`.

```sh
kubectl -n polyon-rcc create secret generic polyon-rcc-agent-keys \
  --from-file=agent-keys.json=<path-to-key-document>
```

The Secret is optional so the control center starts before any host is
enrolled. When it is absent or malformed the backend refuses the heartbeat
route with `503` — it never falls back to accepting unsigned or unknown-key
reports. Rotate by adding a new key id and retiring the previous entry; an
unknown key id is never silently accepted. Do not place key material in this
repository, in `rcc.yaml`, or in any generated manual JSON.

### Maintenance service internal key

Cordon and drain need Kubernetes write verbs. The Console backend does not hold
them: a separate workload, `polyon-rcc-maintenance`, holds the write-capable
ServiceAccount and exposes four internal endpoints that only the backend pod can
reach. The two processes authenticate to each other with a shared HMAC key.

```sh
kubectl -n polyon-rcc create secret generic polyon-rcc-maintenance-key \
  --from-literal=internal-key="$(head -c 48 /dev/urandom | base64)"
```

At least 32 bytes. Both Deployments mount the same Secret read-only at
`/etc/rcc/maintenance/internal-key`.

This Secret is **required** for `host.reboot`. Without it:

- `polyon-rcc-maintenance` refuses to start and enters CrashLoopBackOff. That is
  deliberate — an unauthenticated maintenance API would be strictly worse than
  the arrangement it replaces, so the service will not come up without a key.
- The backend starts normally and every reboot request fails with
  "maintenance coordinator is not configured". Read-only reporting,
  `journal.query` and `service.restart` are unaffected.

Rotate by replacing the Secret and restarting both Deployments together. The two
sides must hold the same key at the same time; there is no rotation window,
because a maintenance call that cannot be authenticated must fail rather than
fall back.

### Kubernetes and drain policy

The maintenance Deployment carries the decisions this control center has made
about its own cluster. Each one refuses by default, because the safe answer to
"can this node be drained?" is no until someone has said otherwise.

| Variable | Meaning | Shipped value |
|---|---|---|
| `RCC_ETCD_TOPOLOGY` | `stacked` or `external`. Where etcd actually runs. | *(unset — a control-plane reboot is refused until declared)* |
| `RCC_DRAIN_DAEMONSET_PODS` | `leave-in-place` to accept that DaemonSet pods restart with the node | `leave-in-place` |
| `RCC_DRAIN_STATIC_PODS` | `leave-in-place` to accept that static pods restart with the node | `leave-in-place` |
| `RCC_DRAIN_EMPTYDIR_DATA` | `accept-data-loss` to permit draining pods whose emptyDir data is lost | `refuse` |
| `RCC_DRAIN_TIMEOUT_MS` | How long to wait for pods to leave and replacements to become Ready | `120000` |

`RCC_ETCD_TOPOLOGY` is deliberately left unset: it cannot be discovered
reliably, and a wrong guess is how a cluster loses quorum. Declare it per
cluster after confirming where etcd runs.

CC2 is a single-node cluster, so `host.reboot` is refused there regardless of
any of the above. There is no setting that lifts that refusal.

### subShell package and registry

RCC does not run the DUPA control plane, so the Registry v3 document and the
signed plugin assets are produced at image build time and served statically.
Nothing about verification is skipped: the Main Shell still checks the registry
digest pin, the detached ECDSA P-256 signature, `shellCompat`, the capability
allowlist and the entry-bundle digest before it executes a single byte.

1. Repin the package digests to the files on disk:

   ```sh
   node scripts/build-subshell-manifest.mjs --check   # verify
   node scripts/build-subshell-manifest.mjs           # repin
   ```

2. Build the image with the signing key supplied out of band, pinned by its
   expected public-key fingerprint:

   ```sh
   # Derive the expected fingerprint once, from the intended key:
   openssl pkey -in /secure/path/rcc-plugins-p256.pem -pubout -outform DER \
     | openssl dgst -sha256

   RCC_PLUGIN_SIGNING_KEY=/secure/path/rcc-plugins-p256.pem \
   RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256=<that fingerprint> \
   ./deploy/rcc/deploy-cc2.sh
   ```

   The key is passed as a BuildKit secret. It never enters the repository, the
   image or a layer.

   **Both variables are required.** `trust.keyId` in the descriptor is only a
   *label* — any P-256 key can be presented under any label, so matching it
   proves nothing about which private key was supplied. The fingerprint is the
   only check that identifies the key, and it must come from outside the key
   file. There is no bypass; tests supply the fingerprint the same way an
   operator does.

**Without the key the image ships no registry at all.** `/api/v1/registry` then
returns 404, the shell starts with zero plugins, and `/cc/:ccId/hosts` reports
the feature as not registered. That is the intended fail-closed outcome — there
is no unsigned load path.

To deploy deliberately without this feature, set
`RCC_DISABLE_LINUX_HOST_MANAGER=1`. That flag does **not** relax any signature
check — nothing unsigned is ever loaded — it simply omits the feature. It is off
by default and is not the normal CC2 path.

Routes added for this feature:

| Route | Served by | Purpose |
|---|---|---|
| `/api/v1/registry` | web (static) | Registry v3 document: digest pins and trusted public keys |
| `/plugins/<id>/…` | web (static) | Signed manifest, detached signature, entry bundle |
| `/api/plugins/linux-host-manager/…` | backend | The subShell's canonical API namespace |

Hosts need no inbound port. The agent makes outbound HTTPS connections only.

### Trust boundary of the static registry

This packaging is a **release-pinned static registry**, not the DUPA control
plane. Being precise about which half is which matters, because the two are
easy to conflate.

**What is preserved** — every check the Main Shell performs at load time runs
unchanged, against artifacts baked into an immutable image:

| Check | Where |
|---|---|
| Descriptor satisfies the module contract | `moduleDescriptorIssues()`, at build time |
| Manifest bytes match the registry digest pin | shell, `loadOne()` step ① |
| Detached ECDSA P-256 signature over the manifest | shell, step ② |
| `shellCompat` semver | shell, step ③ |
| Permissions ⊆ closed capability set | shell, step ④ |
| Entry-bundle sha256 matches `entrySha256` | shell, step ⑤ |
| Verified bytes only, via Blob import | shell, step ⑥ |
| Least-privilege plugin context | shell, step ⑦ |
| Manifest ↔ descriptor drift (id, kind, hostRef, compat, apiBase, contributions) | build time |

**What is not present** — everything the DUPA controller would add:

- No OCI delivery. The package is baked into the web image rather than resolved
  from a registry by digest, so there is no `UIPluginPackage`/`UIPluginRegistration`
  reconcile loop and no runtime install/uninstall.
- No supply-chain provenance: no cosign attestation verification, no
  SLSA provenance check, no governed-source-repository binding.
- No admission control: no permission-profile admission, no ServiceAccount or
  NetworkPolicy materialisation, no health/readiness gating of a plugin workload.
- No key management plane. Trust is one build-time key id published in the
  registry document; there is no rotation, revocation or distribution mechanism.
  Revoking a key means rebuilding and redeploying the image.
- No runtime registry mutation. The plugin set is fixed for the life of the
  image; the shell's 30-second registry poll will never observe a change.

**What this means in practice — stated precisely.**

The public key and the signed bundle ship together in the same image. The
runtime therefore verifies **internal consistency and integrity relative to the
trust document embedded in that image**: that the manifest matches its digest
pin, that the signature verifies under the published key, and that the entry
bundle matches the manifest. This detects corruption, truncation, accidental
drift and post-build tampering with a *single* artifact.

It does **not** independently establish authenticity or source provenance.
Anyone able to produce the image can publish a different key alongside a bundle
signed by it, and the runtime checks would pass. Authenticity therefore rests
on:

1. **Immutable image provenance** — which image digest is deployed, and how that
   digest is authorised.
2. **Build controls** — that the image was produced by a governed build from
   reviewed source.
3. **Signing-key custody** — that the private key, and the expected fingerprint
   pinned at build time, are held and rotated under control.

The web image is the trust anchor. The signature narrows what can change inside
a given image; it does not attest where that image came from.

**Roadmap.** Stage 2 is safe typed host operations — a declared operation
catalog executed through `console.host_operation`. Promoting this package to
OCI delivery with cosign/SLSA attestation is **not** Stage 2; it is an optional
future governance enhancement, worth doing when RCC needs provenance guarantees
independent of image custody.
