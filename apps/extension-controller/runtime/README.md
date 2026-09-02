# Extension Controller compatibility runtime

This directory preserves the verified DUPA controller behavior that was formerly stored at `backend/dupa-control`. It is owned by C_EXT while the narrow target controller under `src/` replaces its responsibilities through explicit owner contracts.

The manifests and Dockerfile in this directory remain compatibility inputs. They do not replace `apps/extension-controller/deploy.yaml` or its least-privilege target image.

Do not add new capabilities here. A responsibility must first receive a target owner, contract, implementation, and cutover evidence.
