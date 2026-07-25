# OpenSphere Console operating memory

## Edge channel: local development only

- \`edge\` is the local Docker Desktop development channel. Build only \`linux/amd64\` locally and deploy the resulting **immutable GHCR digest** to the local \`docker-desktop\` cluster.
- Do not use GitHub Actions as part of ordinary Edge development, validation, or deployment. In particular, a source push must not start an Edge image build.
- Before any Edge deployment, confirm the active Kubernetes context is \`docker-desktop\` and the target node architecture is \`amd64\`.
- Update \`deploy/opensphere-console.yaml\` with the deployed immutable image digest before applying it, so a later \`kubectl apply\` cannot roll the local cluster back.
- Candidate, stable, and GA releases have separate release policies. Do not infer their platform or automation rules from Edge.

## Required local Edge flow

1. Build the affected component locally with \`--platform linux/amd64\`.
2. Push its immutable digest to GHCR only when the local admission policy requires a pinned GHCR image.
3. Update the matching deployment manifest to that digest.
4. Apply to the \`docker-desktop\` context, wait for rollout, and check the target UI/API.
