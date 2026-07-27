#!/usr/bin/env node
/**
 * Deterministic mutation sweep for the Stage 4 guards.
 *
 * A passing test suite proves the code does what the tests say. It does not
 * prove the tests would notice if a guard were removed. Each entry below
 * deletes or inverts exactly one guard, runs the tests that are supposed to
 * catch it, and requires them to fail. A mutation that survives is a guard
 * nothing is watching.
 *
 * Every edit is applied to a temporary copy of the file and reverted in a
 * finally block, so a crash mid-sweep cannot leave a weakened guard on disk.
 *
 * Usage: node scripts/stage4-mutation-sweep.mjs [--only <substring>]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournal } from './lib/sweep-journal.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = path.join(repoRoot, 'backend/rcc-node-agent');

const GO = (pkg) => ({ cmd: 'go', args: ['test', '-count=1', '-timeout', '120s', pkg], cwd: agentRoot });
const NODE = (...files) => ({ cmd: 'node', args: ['--test', ...files], cwd: repoRoot });
const DB = { cmd: 'npm', args: ['run', 'test:db'], cwd: repoRoot };

/**
 * Each mutation names the guard it removes, the file it lives in, an exact
 * string replacement, and the suite that must go red.
 */
const MUTATIONS = [
  // ── agent: plan grammar ───────────────────────────────────────────────────
  {
    name: 'plan: the management interface may be reconfigured',
    file: 'backend/rcc-node-agent/internal/plan/plan.go',
    from: `	if a.PreState.DefaultRouteInterface != "" && a.PreState.DefaultRouteInterface == a.Interface {`,
    to: `	if false {`,
    test: GO('./internal/plan/'),
  },
  {
    name: 'plan: an image operation may ask to reboot',
    file: 'backend/rcc-node-agent/internal/plan/plan.go',
    from: `	if a.RebootAfter {
		// Identical to kernel.update: staging an image never restarts the host.
		return errors.New("image operations never reboot; rebootAfter must not be set")
	}`,
    to: `	if false {
		return errors.New("image operations never reboot; rebootAfter must not be set")
	}`,
    test: GO('./internal/plan/'),
  },
  {
    name: 'plan: a network change may carry no rollback window',
    file: 'backend/rcc-node-agent/internal/plan/plan.go',
    from: `	if a.RollbackSeconds < MinRollbackSeconds || a.RollbackSeconds > MaxRollbackSeconds {`,
    to: `	if false {`,
    test: GO('./internal/plan/'),
  },
  {
    name: 'plan: a network change need not carry the state it was reviewed against',
    file: 'backend/rcc-node-agent/internal/plan/plan.go',
    from: `	if a.PreState == nil {
		return errors.New("network.configure must carry the state it was reviewed against")
	}`,
    to: `	if a.PreState == nil {
		return nil
	}`,
    test: GO('./internal/plan/'),
  },
  {
    name: 'plan: a filesystem may be grown with no headroom',
    file: 'backend/rcc-node-agent/internal/plan/plan.go',
    from: `	if a.PreState.DeviceBytes <= a.PreState.SizeBytes {`,
    to: `	if false {`,
    test: GO('./internal/plan/'),
  },
  {
    name: 'plan: a tag-only image reference is accepted',
    file: 'backend/rcc-node-agent/internal/plan/plan.go',
    from: `@sha256:[0-9a-f]{64}$\`)
	// An ostree checksum`,
    to: `(@sha256:[0-9a-f]{64})?$\`)
	// An ostree checksum`,
    test: GO('./internal/plan/'),
  },
  {
    name: 'plan: the pre-state is left out of the content digest',
    file: 'backend/rcc-node-agent/internal/plan/canonical.go',
    from: `			"preState":   canonicalGrowPreState(a.PreState),`,
    to: `			"preState":   nil,`,
    test: GO('./internal/plan/'),
  },
  {
    name: 'plan: the rollback window is left out of the content digest',
    file: 'backend/rcc-node-agent/internal/plan/canonical.go',
    from: `			"rollbackSeconds": a.RollbackSeconds,`,
    to: `			"rollbackSeconds": 0,`,
    test: GO('./internal/plan/'),
  },

  // ── agent: protections ────────────────────────────────────────────────────
  {
    name: 'guard: no mount point is protected',
    file: 'backend/rcc-node-agent/internal/guard/guard.go',
    from: `	for _, entry := range protectedPrefixes {
		if cleaned == entry.prefix {`,
    to: `	for _, entry := range protectedPrefixes[:0] {
		if cleaned == entry.prefix {`,
    test: GO('./internal/guard/'),
  },
  {
    name: 'guard: a protected path is still reported as growable',
    file: 'backend/rcc-node-agent/internal/snapshot/snapshot.go',
    from: `		if entry.Protected {
			entry.Growable = false
		}`,
    to: `		if false {
			entry.Growable = false
		}`,
    test: GO('./internal/collect/'),
  },
  {
    name: 'guard: an unsupported subsystem keeps its authority',
    file: 'backend/rcc-node-agent/internal/snapshot/snapshot.go',
    from: `	if !s.Boot.Supported {
		// A mutable host has no staged deployment and nothing to roll back to.`,
    to: `	if false {
		// A mutable host has no staged deployment and nothing to roll back to.`,
    test: GO('./internal/collect/'),
  },
  {
    name: 'guard: the management link is trusted rather than derived',
    file: 'backend/rcc-node-agent/internal/snapshot/snapshot.go',
    from: `		link.CarriesRCC = s.NetworkState.DefaultRoute.Present &&
			link.Name != "" && link.Name == s.NetworkState.DefaultRoute.Interface`,
    to: `		_ = link`,
    test: GO('./internal/collect/'),
  },

  // ── agent: executors ──────────────────────────────────────────────────────
  {
    name: 'network: the live routing table is not consulted',
    file: 'backend/rcc-node-agent/internal/execute/network.go',
    from: `	if management != "" && management == args.Interface {`,
    to: `	if false {`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'network: a route that moved since review is accepted',
    file: 'backend/rcc-node-agent/internal/execute/network.go',
    from: `	if args.PreState != nil && args.PreState.DefaultRouteInterface != "" &&
		management != "" && args.PreState.DefaultRouteInterface != management {`,
    to: `	if false {`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'network: the pre-state is not checked against the live host',
    file: 'backend/rcc-node-agent/internal/execute/network.go',
    from: `	if err := matchesPreState(before, args.PreState); err != nil {
		return nil, evidence, err
	}`,
    to: `	if err := matchesPreState(before, args.PreState); err != nil {
		_ = err
	}`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'network: an unconfirmed change is kept rather than rolled back',
    file: 'backend/rcc-node-agent/internal/execute/network.go',
    from: `	confirmErr := e.confirmUntil(ctx, deadline)
	if confirmErr != nil {`,
    to: `	confirmErr := e.confirmUntil(ctx, deadline)
	if false && confirmErr != nil {`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'network: a change is made with no way to verify it',
    file: 'backend/rcc-node-agent/internal/execute/network.go',
    from: `	if e.Confirm == nil {`,
    to: `	if false {`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'network: the allowlist is not consulted',
    file: 'backend/rcc-node-agent/internal/execute/network.go',
    from: `	if err := e.ConnectionAllowed(args.Connection); err != nil {
		return nil, evidence, err
	}`,
    to: `	if err := e.ConnectionAllowed(args.Connection); err != nil {
		_ = err
	}`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'network: a failed restore is reported as a successful rollback',
    file: 'backend/rcc-node-agent/internal/execute/network.go',
    from: `func rollbackOutcome(err error) string {
	if err == nil {
		return "rolled-back"
	}
	return "rollback-failed"
}`,
    to: `func rollbackOutcome(err error) string {
	_ = err
	return "rolled-back"
}`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'storage: a mount unit is enabled before it is known to work',
    file: 'backend/rcc-node-agent/internal/execute/storage.go',
    from: `	start, err := e.Runner.Run(runCtx, []string{systemctl, "start", "--", unitName}, maxStorageOutput)
	if err != nil || start.ExitCode != 0 {`,
    to: `	start, err := e.Runner.Run(runCtx, []string{systemctl, "start", "--", unitName}, maxStorageOutput)
	if false {`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'storage: the mount is not confirmed to have happened',
    file: 'backend/rcc-node-agent/internal/execute/storage.go',
    from: `	confirmed, err := e.mountedAt(ctx, args.MountPoint)
	if err != nil || guard.Normalize(confirmed) != guard.Normalize(args.MountPoint) {`,
    to: `	confirmed, err := e.mountedAt(ctx, args.MountPoint)
	if false {`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'storage: a filesystem mounted elsewhere is silently moved',
    file: 'backend/rcc-node-agent/internal/execute/storage.go',
    from: `	if existing != "" && guard.Normalize(existing) != guard.Normalize(args.MountPoint) {`,
    to: `	if false {`,
    test: GO('./internal/execute/'),
  },
  {
    name: "storage: somebody else's mount unit is overwritten",
    file: 'backend/rcc-node-agent/internal/execute/storage.go',
    from: `		if !strings.HasPrefix(string(existingText), "# Generated by rcc-node-agent.") {`,
    to: `		if false {`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'storage: a size operand reaches the resize tool',
    file: 'backend/rcc-node-agent/internal/execute/storage.go',
    from: `		argv = []string{binary, "--", args.MountPoint}`,
    to: `		argv = []string{binary, "--", args.MountPoint, "1024"}`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'storage: the grow allowlist is not consulted',
    file: 'backend/rcc-node-agent/internal/execute/storage.go',
    from: `	if err := e.GrowAllowed(args.MountPoint); err != nil {
		return Result{ExitCode: -1}, evidence, err
	}`,
    to: `	if err := e.GrowAllowed(args.MountPoint); err != nil {
		_ = err
	}`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'storage: a filesystem that moved since review is grown anyway',
    file: 'backend/rcc-node-agent/internal/execute/storage.go',
    from: `	if guard.Normalize(mounted) != guard.Normalize(args.MountPoint) {`,
    to: `	if false {`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'image: the allowlist is not consulted',
    file: 'backend/rcc-node-agent/internal/execute/osimage.go',
    from: `	if err := e.ImageAllowed(args.Image); err != nil {
		return Result{ExitCode: -1}, evidence, err
	}`,
    to: `	if err := e.ImageAllowed(args.Image); err != nil {
		_ = err
	}`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'image: an adapter that cannot stage is attempted anyway',
    file: 'backend/rcc-node-agent/internal/execute/osimage.go',
    from: `	if !e.supportsSubcommand(ctx, binary, subcommand) {`,
    to: `	if false {`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'image: staging carries an apply flag',
    file: 'backend/rcc-node-agent/internal/execute/osimage.go',
    from: `		return []string{binary, "switch", "--retain", "--", image}, nil`,
    to: `		return []string{binary, "switch", "--retain", "--apply", "--", image}, nil`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'image: a missing adapter falls through to whichever is installed',
    file: 'backend/rcc-node-agent/internal/execute/osimage.go',
    from: `	case plan.AdapterBootc:
		if e.BootcPath != "" {
			return e.BootcPath, nil
		}
		return resolveImageBinary(bootcPaths, adapter)`,
    to: `	case plan.AdapterBootc:
		if e.BootcPath != "" {
			return e.BootcPath, nil
		}
		if e.RPMOSTreePath != "" {
			return e.RPMOSTreePath, nil
		}
		return resolveImageBinary(bootcPaths, adapter)`,
    test: GO('./internal/execute/'),
  },

  // ── agent: runner and recovery ────────────────────────────────────────────
  {
    name: 'agent: the undo record is written after the change instead of before',
    file: 'backend/rcc-node-agent/internal/agent/operations.go',
    from: `		if armErr := r.Store.SetEvidence(p.OperationID, prepared.Rollback); armErr != nil {`,
    to: `		if armErr := error(nil); armErr != nil {`,
    test: GO('./internal/agent/'),
  },
  {
    name: 'agent: an interrupted network change is not restored',
    file: 'backend/rcc-node-agent/internal/agent/operations.go',
    from: `		if record.Operation == plan.OpNetworkConfigure {
			message = r.restoreInterruptedNetwork(ctx, record, recovery)
		}`,
    to: `		if false {
			message = r.restoreInterruptedNetwork(ctx, record, recovery)
		}`,
    test: GO('./internal/agent/'),
  },
  {
    name: 'agent: a missing adapter is treated as a no-op success',
    file: 'backend/rcc-node-agent/internal/agent/operations.go',
    from: `		if r.Network == nil {
			return fail("network operations are not configured on this host")
		}`,
    to: `		if r.Network == nil {
			return receipt
		}`,
    test: GO('./internal/agent/'),
  },

  // ── agent: configuration ──────────────────────────────────────────────────
  {
    name: 'config: an authority may be enabled without the operation channel',
    file: 'backend/rcc-node-agent/internal/config/config.go',
    from: `		if gate.enabled && !cfg.OperationsEnabled {`,
    to: `		if false {`,
    test: GO('./internal/config/'),
  },
  {
    name: 'config: a malformed allowlist entry is dropped rather than refused',
    file: 'backend/rcc-node-agent/internal/config/config.go',
    from: `			if err := check(value); err != nil {
				return nil, fmt.Errorf("%s entry %q %s", field, value, err.Error())
			}`,
    to: `			if err := check(value); err != nil {
				continue
			}`,
    test: GO('./internal/config/'),
  },
  {
    name: 'config: a protected path may be declared as a mount root',
    file: 'backend/rcc-node-agent/internal/config/config.go',
    from: `			if protected, reason := guard.ProtectedMountPoint(value); protected {
				return errors.New("is protected (" + reason + ") and can never be a mount root")
			}`,
    to: `			if protected, reason := guard.ProtectedMountPoint(value); protected {
				_ = reason
			}`,
    test: GO('./internal/config/'),
  },

  // ── backend: request validation and policy ────────────────────────────────
  {
    name: 'backend: the management interface may be requested',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  if (managementLink && managementLink === iface) {`,
    to: `  if (false) {`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'backend: a Stage 4 request may be built without a host report',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  if (!snapshot || typeof snapshot !== 'object') {`,
    to: `  if (false) {`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'backend: the pre-state is taken from the request instead of the host',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `    preState: {
      method: String(link.method || ''),`,
    to: `    preState: {
      method: String(input.preState?.method || link.method || ''),`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'backend: the policy governs the verb but not the target',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `      const target = policyPermitsTarget(verdict.policy, operation, parameters);
      if (!target.ok) throw { code: 409, msg: target.reason };`,
    to: `      const target = policyPermitsTarget(verdict.policy, operation, parameters);
      if (false) throw { code: 409, msg: target.reason };`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'backend: a revertable operation is dispatched without arming a rollback',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `    const rollback = ROLLBACK_OPERATIONS.has(row.operation)`,
    to: `    const rollback = false`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'backend: an agent that stopped at "armed" is recorded as fine',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  if (reported === 'armed') return 'not-recorded';`,
    to: `  if (false) return 'not-recorded';`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'backend: an agent may invent a rollback state',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  if (!ROLLBACK_STATES.has(reported)) return 'not-recorded';`,
    to: `  if (false) return 'not-recorded';`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'backend: an operation with no rollback may still write the column',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  if (row.host_operation_type?.requires_rollback !== true) return null;`,
    to: `  if (false) return null;`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'backend: an image operation may ask to reboot',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  if (input.rebootAfter !== undefined) {
    // Not a parameter. Image operations never reboot, and accepting the field
    // at all would suggest otherwise.`,
    to: `  if (false) {
    // Not a parameter. Image operations never reboot, and accepting the field
    // at all would suggest otherwise.`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },

  // ── backend: ingestion and capability projection ──────────────────────────
  {
    name: 'ingestion: the Stage 4 inventory is dropped again',
    file: 'backend/opensphere-console-backend/host-api.js',
    from: `    networkState: projectNetworkState(payload.networkState),`,
    to: `    networkState: undefined,`,
    test: NODE('backend/opensphere-console-backend/host-api.test.js'),
  },
  {
    name: 'ingestion: the package inventory is dropped again',
    file: 'backend/opensphere-console-backend/host-api.js',
    from: `    packages: projectPackages(payload.packages),`,
    to: `    packages: undefined,`,
    test: NODE('backend/opensphere-console-backend/host-api.test.js'),
  },
  {
    name: 'ingestion: a link may claim not to carry the control path',
    file: 'backend/opensphere-console-backend/host-api.js',
    from: `    carriesRcc: defaultRoute.present && boundedString(link?.name, 32) === defaultRoute.interface,`,
    to: `    carriesRcc: link?.carriesRcc === true,`,
    test: NODE('backend/opensphere-console-backend/host-api.test.js'),
  },
  {
    name: 'ingestion: an unsupported boot model keeps its capabilities',
    file: 'backend/opensphere-console-backend/host-api.js',
    from: `    canStage: supported && boot.canStage === true,`,
    to: `    canStage: boot.canStage === true,`,
    test: NODE('backend/opensphere-console-backend/host-api.test.js'),
  },
  {
    name: 'capability: a protected filesystem is offered as growable',
    file: 'backend/opensphere-console-backend/host-api.js',
    from: `          growable: entry?.growable === true && !isProtected,`,
    to: `          growable: entry?.growable === true,`,
    test: NODE('backend/opensphere-console-backend/host-api.test.js'),
  },
  {
    name: 'capability: an authority the agent never got is offered anyway',
    file: 'backend/opensphere-console-backend/host-api.js',
    from: `    } else if (!subsystem.agentEnabled) {`,
    to: `    } else if (false) {`,
    test: NODE('backend/opensphere-console-backend/host-api.test.js'),
  },
  {
    name: 'capability: a policy naming no target still permits the operation',
    file: 'backend/opensphere-console-backend/host-api.js',
    from: `    } else if (subsystem.policyTargets && subsystem.policyTargets(policy) === false) {`,
    to: `    } else if (false) {`,
    test: NODE('backend/opensphere-console-backend/host-api.test.js'),
  },

  // ── UI: the Updates page ──────────────────────────────────────────────────
  //
  // Every guard here decides either what a request is bound to, or whether one
  // may be made at all. The suite watching them is the DOM contract, which
  // drives the real module the way an operator drives the page.
  {
    // The original defect. An approval binds the exact parameters; a request
    // that names packages without versions is approved as "upgrade curl", and
    // the host installs whatever its mirror offers when it gets round to it.
    name: 'ui: a package update is requested without pinning a version',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `            packages: chosen.map((entry) => ({ name: entry.name, version: entry.candidateVersion })),`,
    to: `            packages: chosen.map((entry) => ({ name: entry.name, version: '' })),`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a security-only intent is never carried to the request',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `            securityOnly: chosen.every((entry) => entry.security) && this._updateSecurityOnly === true,`,
    to: `            securityOnly: false,`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    // The agent re-checks every package against its security origin and refuses
    // the whole request over it, so a claim the selection contradicts is a
    // request guaranteed to fail after somebody approved it.
    name: 'ui: security-only may be claimed for a set that is not all security',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      const allSecurity = selected.length > 0 && selected.every((entry) => entry.security);`,
    to: `      const allSecurity = selected.length > 0;`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: the console and the backend disagree on package order',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `function byName(left, right) {
  if (left.name < right.name) return -1;`,
    to: `function byName(left, right) {
  if (left.name < right.name) return 1;`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a package that stopped being offered stays in the request',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `        if (!current) {
          this._updateSelection.delete(name);
          dropped.push(name);
          continue;
        }`,
    to: `        if (!current) {
          continue;
        }`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a candidate version that moved is neither re-bound nor reported',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `        if (current.candidateVersion !== chosen.candidateVersion) {`,
    to: `        if (false) {`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    // Confirmation is a statement about a specific set at specific versions.
    // Carrying it across a change makes it a statement about something else.
    name: 'ui: a confirmation survives the set it was given for changing',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      if (dropped.length || moved.length) this._updateConfirmed = false;`,
    to: `      if (false) this._updateConfirmed = false;`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: an update may be requested from a stale package index',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      if (age >= STALE_INDEX_SECONDS) {`,
    to: `      if (false) {`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    // host-api projects -1 when the host never said. Reading that as fresh is
    // how a month-old candidate version gets approved as if it were today's.
    name: 'ui: an index of unknown age is treated as fresh',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      if (!Number.isFinite(age) || age < 0) {`,
    to: `      if (false) {`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a host that stopped reporting may still have versions bound to it',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      if (NON_REPORTING_STATES.has(host?.reportState)) {
        return 'This host has stopped reporting, so the versions above are not known to be what it '`,
    to: `      if (false) {
        return 'This host has stopped reporting, so the versions above are not known to be what it '`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    // Run the other way round, because the guard here is an omission: the
    // refresh card must never consult freshness. Withholding the remedy along
    // with the work leaves a stale host with no way back to being current.
    name: 'ui: the refresh that fixes staleness is itself withheld when stale',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      const blocked = this._packageContentionReason();`,
    to: `      const blocked = this._updateFreshnessProblem(host) || this._packageContentionReason();`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    // All three contend for the same dpkg lock. Two approved operations racing
    // for it is a state nobody reviewed.
    name: 'ui: a second package operation may be requested while one is in flight',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      return this._operations.find((entry) => PACKAGE_OPERATIONS.includes(entry?.operation)
        && !TERMINAL_OPERATION_STATES.has(entry?.status)) || null;`,
    to: `      return null;`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a double press submits the same work twice',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      if (this._operationBusy) return false;`,
    to: `      if (false) return false;`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: an accepted request stays loaded and can be sent again',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `            .then((accepted) => { if (accepted) this._clearUpdateRequest(); });`,
    to: `            .then(() => {});`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    // The other direction of the same guard: discarding a refused request makes
    // the operator rebuild the set by hand to retry something that never ran.
    name: 'ui: a refused request is discarded along with the reviewed selection',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `            .then((accepted) => { if (accepted) this._clearUpdateRequest(); });`,
    to: `            .then(() => { this._clearUpdateRequest(); });`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    // Without this the operator presses a button, nothing appears to happen,
    // and the server's reason is only readable on a different tab.
    name: 'ui: a refusal is invisible on the page the request was made from',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      // A refusal has to be readable where the request was made. Without this
      // the operator presses a button, nothing appears to happen, and the
      // server's reason is only visible on a different tab.
      if (this._operationError && this._operationError !== 'not-installed') {`,
    to: `      // A refusal has to be readable where the request was made. Without this
      // the operator presses a button, nothing appears to happen, and the
      // server's reason is only visible on a different tab.
      if (false) {`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: an unbounded reason is sent for the backend to refuse',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `          const problem = reasonProblem(this._updateReason);`,
    to: `          const problem = '';`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a reason carrying control characters is accepted',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `  if (hasControlCharacter(reason)) return 'The reason must not contain control characters.';`,
    to: `  if (false) return 'The reason must not contain control characters.';`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: an unconfirmed package update is submitted anyway',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `          if (this._updateConfirmed !== true) {`,
    to: `          if (false) {`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: an unconfirmed kernel update is submitted anyway',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `          if (this._kernelConfirmed !== true) {`,
    to: `          if (false) {`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a host-reported string may become a package name',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `        if (!PACKAGE_NAME_RE.test(name)) {`,
    to: `        if (false) {`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a kernel image may ride along in a package update',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `        } else if (name.startsWith(KERNEL_IMAGE_PREFIX)) {`,
    to: `        } else if (false) {`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a package the agent does not allowlist is offered for selection',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `        } else if (!allowlist.includes(name)) {`,
    to: `        } else if (false) {`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a package with no candidate version is offered for selection',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `        } else if (!PACKAGE_VERSION_RE.test(candidateVersion)) {`,
    to: `        } else if (false) {`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a set larger than the backend accepts is selected wholesale',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `        for (const entry of entries.slice(0, MAX_UPDATE_PACKAGES)) {`,
    to: `        for (const entry of entries) {`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: the request size bound does not hold against a hand-picked add',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `          if (adding && !this._updateSelection.has(entry.name)
            && this._updateSelection.size >= MAX_UPDATE_PACKAGES) {`,
    to: `          if (false) {`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: an unpinnable kernel release is still requestable',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      const bindable = KERNEL_RELEASE_RE.test(candidate);`,
    to: `      const bindable = candidate !== '';`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    // The backend refuses the field outright. Sending it at all would suggest a
    // kernel update has a reboot to decide about, which it does not.
    name: 'ui: a kernel update carries a reboot flag',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `            { manager: SUPPORTED_PACKAGE_MANAGER, targetRelease: candidate },`,
    to: `            { manager: SUPPORTED_PACKAGE_MANAGER, targetRelease: candidate, rebootAfter: false },`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    // The fail-open this unit closed. When the server does not say who is
    // reading, the console cannot tell whether they are the requester.
    name: 'ui: approval is offered when the reader is unknown',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      const selfApproval = operation.requiresSecondPerson === true
        && (!viewerKnown || operation.viewer.isRequester === true);`,
    to: `      const selfApproval = operation.requiresSecondPerson === true
        && viewerKnown && operation.viewer.isRequester === true;`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    // Learning it only from a row that says "awaiting approval" is how an
    // operator sits waiting for a button that will never enable for them.
    name: 'ui: the second person is not named before the request is made',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `        'This is high-risk work. A different administrator has to approve it before it runs: '`,
    to: `        'This is high-risk work. '`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: who a request is waiting on is reduced to its state',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      return entry.viewer?.isRequester === true
        ? 'waiting for a different administrator; you requested it'
        : 'waiting for a different administrator than the requester';`,
    to: `      return 'awaiting approval';`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: the update history shows every operation on the host',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      const history = this._operations
        .filter((entry) => PACKAGE_OPERATIONS.includes(entry?.operation));`,
    to: `      const history = this._operations;`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: an operation opened elsewhere is shown as an update request',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `        if (PACKAGE_OPERATIONS.includes(shown)) container.appendChild(this.renderOperationDetail());`,
    to: `        if (true) container.appendChild(this.renderOperationDetail());`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a reason field the operator may overrun without being told',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `        { placeholder: 'why this update is needed', maxlength: String(MAX_REASON) });`,
    to: `        { placeholder: 'why this update is needed' });`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a package refresh submitter is offered without the permission',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      if (!gate.allowed) {
        form.appendChild(el('p', 'os-host-empty',
          \`Refreshing the package index is unavailable on this host: \${gate.reason}\`));
        form.addEventListener('submit', (event) => event.preventDefault());
        return form;
      }`,
    to: `      if (false) {
        return form;
      }`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a package update submitter is offered without the permission',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      if (!gate.allowed) {
        form.appendChild(el('p', 'os-host-empty',
          \`Updating packages is unavailable on this host: \${gate.reason}\`));
        return form;
      }`,
    to: `      if (false) {
        return form;
      }`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: a kernel update submitter is offered without the permission',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      if (!gate.allowed) {
        form.appendChild(el('p', 'os-host-empty',
          \`Updating the kernel is unavailable on this host: \${gate.reason}\`));
        return form;
      }`,
    to: `      if (false) {
        return form;
      }`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },

  // ── UI: Stage 4 surfaces ──────────────────────────────────────────────────
  {
    name: 'ui: the management interface is offered as a target',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      const candidates = (state.links || []).filter((link) => link.managed && !link.carriesRcc
        && link.connection && granted.includes(link.connection));`,
    to: `      const candidates = (state.links || []).filter((link) => link.managed
        && link.connection);`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'ui: an unknown rollback outcome reads as reassurance',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `        'not-recorded': 'The agent did not report a rollback outcome. Treat this host as being in an '
          + 'unknown network state until it reports again.',`,
    to: `        'not-recorded': 'The change completed.',`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    // Drifting a form bound away from the range the backend accepts. In this
    // direction the operator fills in the whole form and is refused on submit;
    // in the other the console silently hides range the platform has.
    name: 'ui: a form offers a bound the backend refuses',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      const rollback = input('number', '120', { min: '30', max: '600', step: '10' });`,
    to: `      const rollback = input('number', '120', { min: '30', max: '900', step: '10' });`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    // The MTU domain has a hole at 1..1279 that min/max cannot express, so the
    // help text is the only thing telling the operator where the floor is. If
    // it may drift from the backend it is not documentation, it is a guess.
    name: 'ui: the stated MTU floor is not the real one',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `'0 leaves the MTU unchanged. Otherwise 1280 to 9216.'`,
    to: `'0 leaves the MTU unchanged. Otherwise 576 to 9216.'`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },

  // ── packaging ─────────────────────────────────────────────────────────────
  {
    name: 'packaging: the network authority ships enabled',
    file: 'backend/rcc-node-agent/packaging/agent.example.json',
    from: `  "networkEnabled": false,`,
    to: `  "networkEnabled": true,`,
    test: NODE('backend/dupa-control/agent-sandbox.test.js'),
  },
  {
    name: 'packaging: the base unit is widened for everyone',
    file: 'backend/rcc-node-agent/packaging/rcc-node-agent.service',
    from: `CapabilityBoundingSet=CAP_SYS_BOOT`,
    to: `CapabilityBoundingSet=CAP_SYS_BOOT CAP_NET_ADMIN CAP_SYS_ADMIN`,
    test: NODE('backend/dupa-control/agent-sandbox.test.js'),
  },
  {
    name: 'packaging: the network drop-in also grants mount',
    file: 'backend/rcc-node-agent/packaging/network-maintenance.conf',
    from: `CapabilityBoundingSet=CAP_SYS_BOOT CAP_NET_ADMIN`,
    to: `CapabilityBoundingSet=CAP_SYS_BOOT CAP_NET_ADMIN CAP_SYS_ADMIN`,
    test: NODE('backend/dupa-control/agent-sandbox.test.js'),
  },

  // ── cross-language contract ───────────────────────────────────────────────
  {
    name: 'contract: an operation exists in the catalog but not in the agent',
    file: 'backend/rcc-node-agent/internal/plan/plan.go',
    from: `	OpOSImageRollback  = "osimage.rollback"`,
    to: `	OpOSImageRollback  = "osimage.rollbackk"`,
    test: NODE('backend/dupa-control/host-operation-conformance.test.js'),
  },
  {
    name: 'contract: a lease may outlive the plan that authorises it',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  'osimage.stage': 3600,`,
    to: `  'osimage.stage': 7200,`,
    test: NODE('backend/dupa-control/host-operation-conformance.test.js'),
  },

  // ── database ──────────────────────────────────────────────────────────────
  {
    name: 'database: a tag-only image may be allowlisted by a policy',
    file: 'deploy/rcc/supabase-baseline.sql',
    from: `            WHERE image !~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]{1,5})?(/[a-z0-9]([a-z0-9._-]*[a-z0-9])?){1,6}@sha256:[0-9a-f]{64}$'`,
    to: `            WHERE image !~ '^.+$'`,
    test: DB,
  },
  {
    name: 'database: a revertable operation may be dispatched unarmed',
    file: 'deploy/rcc/supabase-baseline.sql',
    from: `  IF NEW.status IN ('leased', 'running') THEN
    IF NEW.rollback_deadline_at IS NULL THEN`,
    to: `  IF false THEN
    IF NEW.rollback_deadline_at IS NULL THEN`,
    test: DB,
  },
  {
    name: 'database: a protected path may be a policy mount root',
    file: 'deploy/rcc/supabase-baseline.sql',
    from: `               OR root ~ '^/(boot|usr|etc|var|proc|sys|dev|run)(/|$)'`,
    to: `               OR root ~ '^/nothing-at-all$'`,
    test: DB,
  },
  // ── Stage 5: guards added by the pre-deployment audit ─────────────────────
  //
  // Every one of these replaces a defect that was live in Stage 4. They are
  // here because a fix without a mutation is a fix that can be quietly undone.
  {
    name: 'collect: nmcli\'s unset sentinel reaches the snapshot',
    file: 'backend/rcc-node-agent/internal/collect/network.go',
    from: `	if field == "--" {
		return ""
	}`,
    to: `	if false {
		return ""
	}`,
    test: GO('./internal/collect/'),
  },
  {
    name: 'execute: a mount point may be reached through a symbolic link',
    file: 'backend/rcc-node-agent/internal/execute/storage.go',
    from: `	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf(
			"%s is a symbolic link; this agent acts on real directories only", cleaned)
	}`,
    to: `	if false {
		return fmt.Errorf("unreachable")
	}`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'execute: the resolved parent need not be the reviewed parent',
    file: 'backend/rcc-node-agent/internal/execute/storage.go',
    from: `	if parent != parentWanted {`,
    to: `	if false {`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'execute: resolveUUID trusts its caller',
    file: 'backend/rcc-node-agent/internal/execute/storage.go',
    from: `	if !plan.ValidFilesystemUUID(uuid) {`,
    to: `	if false {`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'execute: a grow may be read as a flag',
    file: 'backend/rcc-node-agent/internal/execute/storage.go',
    from: `		argv = []string{binary, "--", args.MountPoint}`,
    to: `		argv = []string{binary, args.MountPoint}`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'execute: security-only installs whatever apt offers',
    file: 'backend/rcc-node-agent/internal/execute/packages.go',
    from: `	if args.SecurityOnly {
		if err := checkSecurityOnly(verdict); err != nil {
			return simulation, evidence, err
		}
	}`,
    to: `	if false {
		return simulation, evidence, nil
	}`,
    test: GO('./internal/execute/'),
  },
  {
    name: 'collect: probe output is buffered without a bound',
    file: 'backend/rcc-node-agent/internal/collect/packages.go',
    from: `	if remaining := b.limit - len(b.buffer); remaining > 0 {
		if len(p) < remaining {
			remaining = len(p)
		}
		b.buffer = append(b.buffer, p[:remaining]...)
	}`,
    to: `	b.buffer = append(b.buffer, p...)`,
    test: GO('./internal/collect/'),
  },
  {
    name: 'api: the host agent allowlist is not consulted for a network change',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  refuseUnlessAgentAllows(
    agentAllowlist(snapshot, 'networkAllowlist').includes(connection),
    \`the connection "\${connection}"\`, 'reconfigure');`,
    to: '',
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'api: the host agent allowlist is not consulted for a mount',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  refuseUnlessAgentAllows(
    agentAllowlist(snapshot, 'mountRoots').some((root) => underRoot(mountPoint, root)),
    mountPoint, 'mount anything at');`,
    to: '',
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'api: the host agent allowlist is not consulted for a growth',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  refuseUnlessAgentAllows(
    agentAllowlist(snapshot, 'growAllowlist').some((allowed) => normalizePath(allowed) === normalizePath(mountPoint)),
    mountPoint, 'grow');`,
    to: '',
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'api: the host agent allowlist is not consulted for an image',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `    refuseUnlessAgentAllows(
      agentAllowlist(snapshot, 'imageAllowlist').includes(image),
      'that image', 'stage');`,
    to: '',
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'api: a mount root reaches above itself',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  return c.startsWith(\`\${r}/\`);`,
    to: `  return c.startsWith(r);`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'api: a truncated pre-state is sent instead of a refusal',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  if (reportedStatic.length > MAX_LINK_ADDRESSES) {`,
    to: `  if (false) {`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'api: a receipt need not say when it ran',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs)) {`,
    to: `  if (false) {`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'api: a receipt may finish before it started',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  if (finishedMs < startedMs) {`,
    to: `  if (false) {`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'api: the unit grammar drifts from the agent again',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `      if (!UNIT_RE.test(unit) || !unit.endsWith('.service')) {`,
    to: `      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.service$/.test(unit)) {`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'api: the Kubernetes node fallback loses the reported hostname',
    file: 'backend/opensphere-console-backend/operation-api.js',
    from: `  + 'host(host_id,display_name,agent_key_id,host_snapshot(payload)),'`,
    to: `  + 'host(host_id,display_name,agent_key_id),'`,
    test: NODE('backend/opensphere-console-backend/operation-api.test.js'),
  },
  {
    name: 'ui: the region is guessed instead of read',
    file: 'deploy/rcc/subshells/linux-host-manager/entry.js',
    from: `      return ctx.controlCenterId || '';`,
    to: `      return ctx.controlCenterId || 'cc2';`,
    test: NODE('backend/dupa-control/rcc-subshell-dom.test.js'),
  },
  {
    name: 'packaging: a drop-in relaxes the read-only filesystem',
    file: 'backend/rcc-node-agent/packaging/storage-maintenance.conf',
    from: `[Service]
# Where a generated mount unit lives`,
    to: `[Service]
ProtectSystem=full
# Where a generated mount unit lives`,
    test: NODE('backend/dupa-control/agent-sandbox.test.js'),
  },
  {
    name: 'packaging: a drop-in tries to widen the syscall filter with a deny list',
    file: 'backend/rcc-node-agent/packaging/package-maintenance.conf',
    from: `SystemCallFilter=@privileged @module`,
    to: `SystemCallFilter=~@mount @swap @obsolete`,
    test: NODE('backend/dupa-control/agent-sandbox.test.js'),
  },
  {
    name: 'sql: a held lease may be stolen',
    file: 'backend/supabase/migrations/0028_host_operation_governance.sql',
    from: `  IF OLD.status IN ('leased', 'running') AND NEW.status IN ('leased', 'running') THEN`,
    to: `  IF false THEN`,
    test: DB,
  },
  {
    name: 'sql: a stored receipt digest may be rewritten',
    file: 'backend/supabase/migrations/0028_host_operation_governance.sql',
    from: `  IF OLD.result_digest IS NOT NULL AND NEW.result_digest IS DISTINCT FROM OLD.result_digest THEN`,
    to: `  IF false THEN`,
    test: DB,
  },
  {
    name: 'sql: the backend may rewrite the operation catalogue',
    file: 'backend/supabase/migrations/0028_host_operation_governance.sql',
    from: `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON console.host_operation_type FROM opensphere_console_backend;`,
    to: '',
    test: DB,
  },
  {
    name: 'sql: an approval may be re-pointed at the policy that replaced it',
    file: 'backend/supabase/migrations/0029_host_maintenance_recovery.sql',
    from: `  IF OLD.policy_version IS NOT NULL AND NEW.policy_version IS DISTINCT FROM OLD.policy_version THEN`,
    to: `  IF false THEN`,
    test: DB,
  },
  {
    name: 'sql: the backend may edit a policy',
    file: 'backend/supabase/migrations/0030_host_maintenance_policy.sql',
    from: `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON console.host_policy FROM opensphere_console_backend;`,
    to: '',
    test: DB,
  },
  {
    name: 'sql: a policy edit leaves nothing behind',
    file: 'backend/supabase/migrations/0030_host_maintenance_policy.sql',
    from: `  IF NEW.version IS DISTINCT FROM OLD.version THEN
    INSERT INTO console.host_policy_change
      (policy_id, control_center_id, version, action, before, after)
    VALUES (NEW.id, NEW.control_center_id, NEW.version, 'updated',
            to_jsonb(OLD), to_jsonb(NEW));
  END IF;`,
    to: '',
    test: DB,
  },
  {
    // 0028 drops and recreates this trigger, so it is 0028's enablement that
    // decides how the trigger ends up and 0027's identical line is dead by the
    // time an upgrade finishes. Pointed at 0027 this mutation removed nothing
    // and survived for that reason rather than for want of a test.
    name: 'sql: a guard trigger may be switched off by a replication session',
    file: 'backend/supabase/migrations/0028_host_operation_governance.sql',
    from: `ALTER TABLE console.host_operation ENABLE ALWAYS TRIGGER host_operation_state_machine;`,
    to: '',
    test: DB,
  },
  {
    name: 'sql: policy reads are not scoped to the reader\'s own region',
    file: 'backend/supabase/migrations/0030_host_maintenance_policy.sql',
    from: `CREATE POLICY host_policy_read ON console.host_policy FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM console.operator_control_center a
    WHERE a.user_id = auth.uid()
      AND a.control_center_id = console.host_policy.control_center_id
      AND (a.expires_at IS NULL OR a.expires_at > now())
  ));`,
    to: `CREATE POLICY host_policy_read ON console.host_policy FOR SELECT TO authenticated USING (true);`,
    test: DB,
  },
  {
    // Aimed at the generated seed rather than at the builder that writes it.
    // The builder only runs under `npm run manual:seed`, and it writes to a
    // fixed path inside the repository, so no test can exercise its title
    // derivation without overwriting the committed artifact. Mutating the
    // builder therefore proved nothing: the seed on disk still held the right
    // title and every assertion passed. What has to be guarded is the title
    // operators are actually served, which is this.
    name: 'seed: the manual title stops following the document',
    file: 'backend/opensphere-console-oaa-gateway/manual-seeds/opensphere-core-manuals.json',
    from: `      "title": "RCC Linux Host Control (Stage 1-5 + 운영 기능 단위)",`,
    to: `      "title": "RCC Linux Host Control (Stage 1-4)",`,
    test: NODE('backend/opensphere-console-backend/manual-api.test.js'),
  },
  {
    // The regression this closes: the bundle version was the wall clock, so the
    // committed seed changed on every rebuild and a real edit could not be told
    // apart from an idle re-run. Aimed at the artifact rather than the builder
    // for the same reason as the title mutation above — the builder writes to a
    // fixed path inside the repository and no test can run it without
    // overwriting the committed seed.
    name: 'seed: the bundle version goes back to wall-clock time',
    file: 'backend/opensphere-console-oaa-gateway/manual-seeds/opensphere-core-manuals.json',
    // Anchored on the prefix, not the digest. The digest changes whenever any
    // document does, so an anchor carrying it would rot on the next manual edit
    // and be reported as ANCHOR NOT FOUND — the exact failure this sweep was
    // caught doing silently before anchors were checked separately.
    from: `  "version": "sha256:`,
    to: `  "version": "2026-07-25T23:48:10.051Z`,
    test: NODE('backend/dupa-control/manual-seed-freshness.test.js'),
  },
  {
    name: 'seed: the update date stops following the newest document',
    file: 'backend/opensphere-console-oaa-gateway/manual-seeds/opensphere-core-manuals.json',
    // Same reasoning: anchored on the century rather than on today's value.
    from: `  "updatedAt": "20`,
    to: `  "updatedAt": "19`,
    test: NODE('backend/dupa-control/manual-seed-freshness.test.js'),
  },
  {
    // The sweep mutating its own machinery is safe: this process already holds
    // the modules in memory, and the test spawns a fresh node that reads the
    // mutated file. The journal rules live in their own module partly for this
    // reason — an anchor in the sweep script would also match the mutation
    // table entry that names it, and resolve twice.
    name: 'harness: the crash journal does not record who owns it',
    file: 'scripts/lib/sweep-journal.mjs',
    from: `JSON.stringify({ pid: process.pid, target, original })`,
    to: `JSON.stringify({ target, original })`,
    test: NODE('backend/dupa-control/mutation-sweep-journal.test.js'),
  },
  {
    name: 'harness: a journal owned by another user is read as abandoned',
    file: 'scripts/lib/sweep-journal.mjs',
    from: `    return error?.code === 'EPERM';`,
    to: `    return false;`,
    test: NODE('backend/dupa-control/mutation-sweep-journal.test.js'),
  },
  {
    name: 'harness: a live owner is helped instead of refused',
    file: 'scripts/lib/sweep-journal.mjs',
    from: `      if (journalOwnerAlive(pid)) {`,
    to: `      if (false) {`,
    test: NODE('backend/dupa-control/mutation-sweep-journal.test.js'),
  },
  {
    name: 'harness: checking anchors restores a journal it does not own',
    file: 'scripts/lib/sweep-journal.mjs',
    from: `      if (readOnly) return null;`,
    to: `      if (false) return null;`,
    test: NODE('backend/dupa-control/mutation-sweep-journal.test.js'),
  },
  {
    name: 'seed: provenance records the machine the build ran on',
    file: 'backend/opensphere-console-oaa-gateway/manual-seeds/opensphere-core-manuals.json',
    from: `    "basePath": "opensphere-platform-root",`,
    to: `    "basePath": "/Users/someone/checkout",`,
    test: NODE('backend/dupa-control/manual-seed-freshness.test.js'),
  },
  {
    // Both bootstraps get their own mutation on purpose. The defect found in
    // this harness was that one wait was written correctly and the other was
    // not, so a check that only ever proved "some probe uses TCP" would have
    // passed while half the suite still raced the shutdown.
    name: 'harness: the contract database is waited for over the Unix socket',
    file: 'backend/supabase/db-contract.test.mjs',
    from: `'exec', CONTAINER, 'psql', '-h', '127.0.0.1', '-U', 'supabase_admin', '-d', 'postgres', '-tAc',`,
    to: `'exec', CONTAINER, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-tAc',`,
    test: NODE('backend/supabase/supabase-contract.test.mjs'),
  },
  {
    name: 'harness: the upgrade database is waited for over the Unix socket',
    file: 'backend/supabase/db-contract.test.mjs',
    from: `'exec', container, 'psql', '-h', '127.0.0.1', '-U', 'supabase_admin', '-d', 'postgres', '-tAc',`,
    to: `'exec', container, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-tAc',`,
    test: NODE('backend/supabase/supabase-contract.test.mjs'),
  },
  {
    // The half of the fix that lives in executable code: with the bundle
    // version now a digest, falling back to it hands every undated document a
    // hash where the console prints a date.
    name: 'api: an undated manual document is dated with the bundle digest',
    file: 'backend/opensphere-console-backend/manual-api.js',
    from: `    updatedAt: String(raw.updatedAt || defaults.updatedAt || ''),`,
    to: `    updatedAt: String(raw.updatedAt || defaults.version || ''),`,
    test: NODE('backend/dupa-control/manual-seed-freshness.test.js'),
  },
];

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;
const checkAnchorsOnly = process.argv.includes('--check-anchors');

// Deliberately async rather than spawnSync. A JS signal handler only runs when
// the event loop is free, and spawnSync blocks it for the whole test run, so
// with spawnSync a SIGTERM is not acted on until the child happens to exit —
// and never at all if the child hangs. Killing a sweep mid-run really did leave
// `IF false THEN` on disk in a migration once. Spawning asynchronously keeps the
// loop free so the handler below can restore the file immediately.
let activeChild = null;
function run({ cmd, args, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'ignore' });
    activeChild = child;
    child.on('error', () => { activeChild = null; resolve(false); });
    child.on('close', (code) => { activeChild = null; resolve(code === 0); });
  });
}

// The journal survives what a handler cannot: SIGKILL, a panic, or the machine
// losing power. Its rules live in their own module so they can be tested
// directly and mutated without the anchor also matching the mutation table.
//
// The path is overridable only so those rules can be exercised against a
// throwaway file. Planting a journal at the repository root to test them would
// leave residue when a test fails, and would be acted on by any sweep that
// happened to be running — which is the very accident these rules exist for.
const journal = createJournal(
  process.env.RCC_SWEEP_JOURNAL || path.join(repoRoot, '.stage4-sweep-restore.json'));
// Recovering another live sweep's journal puts the guard back underneath it
// while its test is still running, so that mutation gets scored against
// unmutated source and is reported as a survivor. This happened: a
// `--check-anchors` run alongside a sweep restored the file it was working on.
// Anchor checking no longer recovers at all, and a sweep that finds a living
// owner refuses rather than helping.
function recoverFromJournal() {
  let restored;
  try {
    restored = journal.recover({ readOnly: checkAnchorsOnly });
  } catch (error) {
    if (error?.code !== 'SWEEP_IN_PROGRESS') throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  if (restored) {
    process.stderr.write(
      `recovered ${path.relative(repoRoot, restored)} from an interrupted sweep\n`);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (activeChild) activeChild.kill('SIGKILL');
    journal.restore();
    process.stderr.write(`\nsweep interrupted by ${signal}; source restored\n`);
    process.exit(130);
  });
}
process.on('uncaughtException', (error) => {
  journal.restore();
  process.stderr.write(`\nsweep crashed: ${error?.stack || error}\n`);
  process.exit(1);
});

// `--check-anchors` reads; it never writes. Recovering from here would mean a
// read-only check silently rewrites a source file — and if a sweep is running,
// the file it rewrites is the one under test.
recoverFromJournal();

let killed = 0;
let survived = 0;
const survivors = [];

// Anchor validation is separated from mutation so a stale anchor is reported in
// a second rather than after a full sweep, and so it can never be mistaken for
// a killed mutation: an anchor that no longer matches tests nothing at all.
const anchorProblems = [];
for (const mutation of MUTATIONS) {
  const original = readFileSync(path.join(repoRoot, mutation.file), 'utf8');
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences === 0) {
    anchorProblems.push(`${mutation.name} — ANCHOR NOT FOUND in ${mutation.file}`);
  } else if (occurrences !== 1) {
    anchorProblems.push(`${mutation.name} — anchor appears ${occurrences}× in ${mutation.file}`);
  } else if (mutation.to !== '' && original.includes(mutation.to)) {
    // The mutated text is already on disk: either a previous sweep failed to
    // restore, or the mutation does not actually change anything. Deletions
    // (`to: ''`) are exempt because every string contains the empty string, and
    // a deletion that failed to restore shows up as a missing anchor instead.
    anchorProblems.push(`${mutation.name} — MUTATED TEXT ALREADY PRESENT in ${mutation.file}`);
  }
}

if (checkAnchorsOnly) {
  if (anchorProblems.length) {
    process.stdout.write('Anchor problems:\n');
    for (const problem of anchorProblems) process.stdout.write(`  - ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(`${MUTATIONS.length} anchors all resolve uniquely and none is already applied\n`);
  process.exit(0);
}

if (anchorProblems.length) {
  process.stdout.write('Refusing to sweep: anchors must all resolve first.\n');
  for (const problem of anchorProblems) process.stdout.write(`  - ${problem}\n`);
  process.exit(1);
}

for (const mutation of MUTATIONS) {
  if (only && !mutation.name.includes(only)) continue;
  const target = path.join(repoRoot, mutation.file);
  const original = readFileSync(target, 'utf8');

  try {
    journal.begin(target, original);
    writeFileSync(target, original.replace(mutation.from, mutation.to));
    const stillPasses = await run(mutation.test);
    if (stillPasses) {
      survived += 1;
      survivors.push(`${mutation.name} — SURVIVED (${mutation.file})`);
      process.stdout.write(`SURVIVED  ${mutation.name}\n`);
    } else {
      killed += 1;
      process.stdout.write(`killed    ${mutation.name}\n`);
    }
  } finally {
    // Always restore, even if the test runner threw: a weakened guard must
    // never be left on disk by a crashed sweep.
    journal.restore();
  }
}

process.stdout.write(`\n${killed} killed, ${survived} survived\n`);
if (survivors.length) {
  process.stdout.write('\nSurvivors (a guard nothing is watching):\n');
  for (const survivor of survivors) process.stdout.write(`  - ${survivor}\n`);
  process.exit(1);
}
