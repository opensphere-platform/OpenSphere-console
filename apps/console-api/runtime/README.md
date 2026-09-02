# Console API compatibility runtime

This directory preserves the verified HTTP behavior that was formerly stored at `backend/opensphere-console-backend`. It is owned by C_API and remains part of the migration evidence while `apps/console-api/src` becomes the single target policy boundary.

`deploy.yaml` and `Dockerfile` here are compatibility publication inputs. They are not the target C_API deployment contract. The target image and least-privilege deployment remain `apps/console-api/Dockerfile` and `apps/console-api/deploy.yaml`.

Do not add new browser capabilities here. New work belongs in the target owner source and must be added to `packages/contracts/browser-api-cutover.json` before the atomic browser proxy switch.
