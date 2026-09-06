# Common command control

CON-FR-007/018/020, C_SCTL, runtime CON-RT-13. GUI, 22 and OS CLI consume
`/api/os-shell/commands`; resource owners retain their original executors.

- `console.modules.*` is the native module installation capability available
  before another module is installed. It delegates to existing C_API/C_EXT.
- Activated owners publish `opensphere.owner-commands/v2` as the exact signed
  data asset `/contracts/owner-commands.json`. The Registry's current active
  revision, trusted P-256 signature, asset digest and namespace must all agree.
  `commandRegistryUrl` defaults to the internal Registry service on port 8080.
- The bounded argument schema is data, not executable code or an instruction
  source. No arbitrary target URL, process, permission override or schema ref
  is accepted. Adding a conforming owner does not require a Shell command list.
- Every call rechecks current user identity. Mutations require administrator
  authority and MFA except HTTPS localhost plus edge; AAL1 remains AAL1.
  Migration 0044 widens only the ledger's command syntax; it grants no authority.
- Claim actor/request ID/input-and-contract digest before dispatch. Replays
  return the recorded outcome. An uncertain dispatch without a receipt is not
  sent again. Observe the owner's status command before any recovery action.
- Owner responses bind owner, command, request ID and observation time in a
  closed transport envelope. Domain results remain in `data`. Accepted/Queued
  is not completion. A changed or unbound response is an unknown write outcome.

Crossplane is L4 Platform Support, not HISS. Cluster Manager publishes the
HISS contract for its existing managed modules. Its `hiss.stack.plan` composes
fresh per-module state; 22 executes each resulting action through this same
boundary and reads the plan again. It adds no separate queue or orchestrator.

Deployment requires the Registry/verified-provider egress policy and provider
Pod label as well as executable code. Local unit/HTTP/database verification
does not establish that the installed cluster or a real 22 conversation works.
