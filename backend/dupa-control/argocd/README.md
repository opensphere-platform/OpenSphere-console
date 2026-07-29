# OpenSphere Platform Delivery — Argo CD

This directory establishes the runtime proof required by the Console
`Delivery` capability.  The proof is deliberately narrow:

1. the Argo CD Application and AppProject APIs exist;
2. application-controller, repo-server, server, and applicationset-controller
   are rollout-converged;
3. `opensphere-platform-delivery-verify` is `Synced` and `Healthy` from the
   private, governed Gitea declarations repository; and
4. Argo CD reports the resolved Git commit SHA.

`kustomization.yaml` pins the Argo CD 3.4.2 upstream source and all of its
runtime images by digest.  It intentionally does not contain Gitea credentials.
Those credentials are generated per cluster and must stay in the `argocd`
namespace as a labelled `repo-creds` Secret.

The source files for the first verification Application are in `seed/`.  They
must enter `opensphere/platform-declarations` through the established signed
pull-request and independent-approval workflow; never disable branch
protection or push directly to `main` merely to make this condition green.
