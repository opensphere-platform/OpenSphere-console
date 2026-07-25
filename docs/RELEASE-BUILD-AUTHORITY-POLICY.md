# Release build authority policy

Status: Accepted, edge admission enforced
Effective date: 2026-07-24  
Machine-readable authority: `backend/release/policies/build-authority-policy.json`

## Decision

OpenSphere release artifacts are divided into two release classes.

| Release class | Tags | Allowed builder | Official distribution | Required supply-chain evidence |
| --- | --- | --- | --- | --- |
| GA | `ga` | GitHub Actions only | Yes | Immutable digest, SLSA provenance, SPDX SBOM, Release BOM attestation |
| pre-GA | `edge`, `candidate`, `stable` | Localhost or GitHub Actions | No | Advisory |

This policy applies to Console, Setup CLI, OS CLI, every subShell and plugin runtime
image, and the Release BOM. A subShell does not become exempt merely because its
source repository or release cadence differs from the main Console.

## GA boundary

- A localhost build is valid for development, integration, and pre-GA installation.
- A localhost build is never an official GA artifact.
- A pre-GA artifact must not be retagged or promoted directly to `ga`.
- The same source revision may become GA only after the GA GitHub Actions workflow
  rebuilds it and emits all required evidence.
- `stable` remains a pre-GA validation tag. Only `ga` denotes an official
  distribution.

## Platform build policy

`edge` prioritizes development iteration speed. It contains only the current
development host's Kubernetes node platform:

- Windows Docker Desktop normally publishes `linux/amd64`.
- Apple Silicon Docker Desktop normally publishes `linux/arm64`.
- An `edge` release is installable only on nodes matching that single platform.

`candidate`, `stable`, and `ga` are distribution channels and must publish the
complete supported multi-platform set: `linux/amd64` and `linux/arm64`.
Multi-platform publication is intentionally not required for `edge`.

These rules make the trust statement precise: OpenSphere accepts local artifacts
outside GA, while OpenSphere's GA admission and release process recognizes only
the artifacts produced by the designated GitHub Actions workflow.

## Required artifact identity

Every participating artifact will carry these annotations when enforcement is
implemented:

- `opensphere.io/build-authority`: `localhost` or `github-actions`
- `opensphere.io/release-class`: `pre-ga` or `ga`
- `opensphere.io/ga-eligible`: `false` for local/pre-GA output, `true` only after
  the GA workflow completes

## Implemented edge admission boundary

The Console Extension Controller enforces this policy for local subShell and
plugin `edge` installs.

1. The image must resolve to one immutable digest and one runnable host-native
   platform (`linux/amd64` or `linux/arm64`).
2. Its signed module descriptor must pass the trusted P-256 verification and
   its source revision must be a full governed Git revision.
3. The image must carry `build-authority=localhost`, `release-class=pre-ga`,
   `ga-eligible=false`, and the `edge` channel annotation.
4. Revocation remains fail-closed. The local path records P-256 descriptor and
   local-edge build metadata evidence; it never mislabels that evidence as a
   GitHub SLSA provenance or SPDX SBOM attestation.
5. `candidate` and `stable` retain their complete amd64/arm64 requirement and
   the existing GitHub attestation verification path.

This narrow exception is deliberately unavailable to `ga`, to non-edge
channels, to multi-platform local images, and to images without the required
build annotations.
