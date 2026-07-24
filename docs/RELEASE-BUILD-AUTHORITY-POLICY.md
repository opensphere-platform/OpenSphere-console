# Release build authority policy

Status: Accepted, declaration-only  
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

## Implementation boundary

This decision is recorded before behavior is changed. The current installer,
controller admission logic, and publishing workflows remain unchanged in this
commit. The next implementation phase must:

1. emit and retain the required build annotations;
2. allow unsigned/local artifacts only for explicitly selected pre-GA operation;
3. keep fail-closed verification for `ga`;
4. add a dedicated GA rebuild and publication workflow; and
5. prevent tag mutation or digest reuse from pre-GA into GA.
6. enforce single host-native platform for `edge` and the complete supported
   platform set for `candidate`, `stable`, and `ga`.

Until that phase is complete, this document is the accepted target policy, not a
claim that channel-aware runtime enforcement has already shipped.
