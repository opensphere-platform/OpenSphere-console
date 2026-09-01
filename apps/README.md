# Console-native applications

This directory is the target home for independently runnable Console-native applications. `console-api/` implements governed operation intake and independent approval. `extension-controller/` is the first separate Owner process: it claims only typed exact-digest revocations with a leased fencing epoch and writes an execution receipt through restricted RPCs. The accepted C_REG implementation remains at `backend/registry`; it is already a separate Go process/image/service identity, so moving or duplicating it under `apps/` would add churn without changing the runtime boundary. Other migration from `backend/` and `src/` continues capability by capability after the corresponding machine contract and acceptance fixture exists.

The authoritative boundary inventory is `component-boundaries.json`. Sharing this repository does not permit applications to share service identities, credentials, database-writer roles, or failure state.
