# Console Web Shell edge MVP

## Decision

The Web Shell is a Console-owned system plugin. Its edge completion boundary is
the browser-to-Console-to-isolated-runtime path. Foundation owners, R2D2,
generic Platform Release orchestration, the complete PLAN-011 evidence matrix,
and GA promotion are separate follow-up milestones.

This decision keeps the security controls that protect an interactive shell,
while preventing unrelated platform automation from blocking the developer
edge milestone.

## Release scope

- **requestIntent**: ship and verify the Console-direct Web Shell edge MVP.
- **releaseScope**: component.
- **affectedImages**: console, backend, cliArtifacts, osShellControl,
  osShellRuntime.
- **reusedImages**: all Foundation, OSAA/R2D2, recovery, notification, Gitea,
  Supabase, and other unchanged Console component digests.
- **fullReleaseJustification**: null.
- GitHub Actions never builds or moves the edge channel.

Migrations 0059 and 0060 remain only as immutable predecessor history because
the existing edge database applied them before the Shell ledger migrations
0061 and 0062. Their presence does not make R2D2 an MVP dependency.

## Required security boundary

The MVP retains AAL2, same-origin admission, one-time tickets, per-session
Kubernetes Pods, hostUsers:false, exact runtime images, network deny rules,
process/core/swap limits, bounded reconnect, revocation, cleanup, and secret
scanning. These controls are not deferred.

## Ten completion gates

1. **EDGE-SHELL-01** — /shell loads as the Console-owned same-origin system
   plugin without a Foundation or R2D2 dependency.
2. **EDGE-SHELL-02** — AAL1 session creation is denied and a recent AAL2
   browser session can create exactly one Shell session.
3. **EDGE-SHELL-03** — the session reaches Ready on the exact runtime digest
   with hostUsers:false and a non-host UID/GID mapping.
4. **EDGE-SHELL-04** — the browser terminal runs os version, os whoami, and
   os help through the attached PTY.
5. **EDGE-SHELL-05** — TLS fingerprint pinning and one-time ticket admission
   reject replay, wrong origin, and cross-user use.
6. **EDGE-SHELL-06** — detach and same-session reconnect preserve the fencing
   generation and produce a usable PTY.
7. **EDGE-SHELL-07** — DNS and required Shell/Console control endpoints are
   reachable while Kubernetes API, Console Backend, private non-allowlisted,
   and public destinations are denied.
8. **EDGE-SHELL-08** — PTY and agent enforce the approved process, core-dump,
   proc, memory, and swap boundaries.
9. **EDGE-SHELL-09** — logout, permission-revision change, feature disable, or
   session termination revokes attach authority within five seconds.
10. **EDGE-SHELL-10** — session, Pod, ticket, browser ledger, logs, events,
    secrets, and core-file residue close to the reviewed zero-residue state.

Edge MVP completion requires all ten gates from the actual browser/AAL2 path.
Direct SQL fixtures or Pod port-forward can support diagnostics but cannot
replace browser-path evidence.

## Explicitly deferred

- Foundation PostgreSQL Owner publication and owner workload convergence.
- R2D2 operational runtime and multichannel automation.
- Generic Backend Bootstrap A/B release orchestration.
- Candidate, stable, and GA promotion.
- The remaining PLAN-011 limbs that do not gate this browser shell milestone.

Deferred work must not be reported as complete and must not block the ten edge
MVP gates.
