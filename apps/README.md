# Console-native applications

This directory is the target home for independently runnable Console-native applications. `console-api/` implements governed operation intake and independent approval. `extension-controller/` is the first separate Owner process: it claims only typed exact-digest revocations with a leased fencing epoch and writes an execution receipt through restricted RPCs. Migration from `backend/` and `src/` continues capability by capability after the corresponding machine contract and acceptance fixture exists.

The authoritative boundary inventory is `component-boundaries.json`. Sharing this repository does not permit applications to share service identities, credentials, database-writer roles, or failure state.
