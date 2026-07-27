package agent

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"opensphere.io/rcc/node-agent/internal/execute"
	"opensphere.io/rcc/node-agent/internal/plan"
	"opensphere.io/rcc/node-agent/internal/state"
)

// PlanSource fetches and reports operations over the signed outbound channel.
type PlanSource interface {
	// Poll returns the next plan, or nil when there is nothing to do.
	Poll(ctx context.Context) ([]byte, error)
	// Start tells the control center work has begun. It is the point of no
	// return: after Start the operation may not be handed to anyone else.
	Start(ctx context.Context, p *plan.Plan) error
	// Receipt submits the immutable result. It must be idempotent server-side.
	Receipt(ctx context.Context, operationID string, body []byte) error
}

// OperationRunner drives one operation at a time from claim to receipt.
type OperationRunner struct {
	Source   PlanSource
	Store    *state.Store
	Executor *execute.Executor
	// Packages is the Stage 3 adapter. It is nil on a host that has not been
	// given package operations, and a plan for one is then refused rather than
	// silently ignored.
	Packages *execute.PackageExecutor
	// Stage 4 adapters. Each is nil unless the host was explicitly given that
	// authority, and a plan naming a missing one is refused rather than
	// attempted through a neighbouring adapter.
	Network  *execute.NetworkExecutor
	Storage  *execute.StorageExecutor
	OSImage  *execute.OSImageExecutor
	SSHBan   *execute.SSHBanExecutor
	Identity plan.Identity
	Logger   *slog.Logger
	Now      func() time.Time
}

func (r *OperationRunner) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// RecoverPending closes out attempts that were interrupted by a crash.
//
// This runs before any new work is accepted. An interrupted attempt is never
// retried: the agent cannot know whether the side effect completed, and running
// a restart or reboot a second time is worse than reporting an inconclusive
// result. The single exception is host.reboot, where the recorded pre-reboot
// boot id is enough to determine what actually happened.
func (r *OperationRunner) RecoverPending(ctx context.Context) error {
	pending, err := r.Store.Recover()
	if err != nil {
		return err
	}
	for _, record := range pending {
		if record.Operation == plan.OpHostReboot {
			r.finishReboot(ctx, record)
			continue
		}
		// A network change that was interrupted between being applied and being
		// confirmed leaves the host on settings nobody ever proved work. The
		// rollback record was written durably before the change, so the previous
		// settings go back on now rather than waiting for somebody to notice.
		recovery := map[string]string{"recovered": "true"}
		message := "agent restarted while the operation was in flight; the result is unknown and it was not retried"
		if record.Operation == plan.OpNetworkConfigure {
			message = r.restoreInterruptedNetwork(ctx, record, recovery)
		}
		receipt := plan.Receipt{
			SchemaVersion:   plan.ReceiptSchemaVersion,
			OperationID:     record.OperationID,
			Attempt:         record.Attempt,
			ControlCenterID: r.Identity.ControlCenterID,
			HostID:          r.Identity.HostID,
			Operation:       record.Operation,
			ContentDigest:   record.ContentDigest,
			Outcome:         plan.OutcomeFailed,
			StartedAt:       record.ClaimedAt,
			FinishedAt:      r.now(),
			ExitCode:        -1,
			Message:         message,
			Evidence:        recovery,
		}
		r.submit(ctx, record.OperationID, &receipt)
	}
	if _, err := r.Store.Prune(); err != nil && r.Logger != nil {
		r.Logger.Warn("state prune failed", "error", err.Error())
	}
	return nil
}

// finishReboot decides a reboot's outcome after the agent comes back up.
func (r *OperationRunner) finishReboot(ctx context.Context, record *state.Record) {
	rebooted, detail, err := r.Executor.ConfirmReboot(record.Evidence)
	if err != nil {
		if r.Logger != nil {
			r.Logger.Warn("reboot confirmation failed", "operation", record.OperationID, "error", err.Error())
		}
		return
	}
	if !rebooted && detail == "host has not rebooted yet" {
		// Still waiting for the machine to go down. Leave the record pending so
		// the next reconcile re-checks; ConfirmReboot reports the deadline case
		// with a different detail, which falls through to a failure receipt.
		return
	}
	outcome := plan.OutcomeFailed
	exitCode := 1
	if rebooted {
		outcome = plan.OutcomeSucceeded
		exitCode = 0
	}
	// Raw boot identifiers stay in the agent's local durable state. The
	// control center needs proof of change, not the host identifier itself, so
	// the signed receipt carries the same bounded SHA-256 form as snapshots.
	evidence := map[string]string{
		"conclusion":       detail,
		"bootIdBeforeHash": rebootEvidenceHash(record.Evidence["bootIdBefore"]),
	}
	if deadline := record.Evidence["deadline"]; deadline != "" {
		evidence["deadline"] = deadline
	}
	if current, currentErr := r.Executor.BootID(); currentErr == nil && current != "" {
		evidence["bootIdAfterHash"] = rebootEvidenceHash(current)
	}
	receipt := plan.Receipt{
		SchemaVersion:   plan.ReceiptSchemaVersion,
		OperationID:     record.OperationID,
		Attempt:         record.Attempt,
		ControlCenterID: r.Identity.ControlCenterID,
		HostID:          r.Identity.HostID,
		Operation:       record.Operation,
		ContentDigest:   record.ContentDigest,
		Outcome:         outcome,
		StartedAt:       record.ClaimedAt,
		FinishedAt:      r.now(),
		ExitCode:        exitCode,
		Message:         detail,
		Evidence:        evidence,
	}
	r.submit(ctx, record.OperationID, &receipt)
}

func rebootEvidenceHash(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(value))
	return fmt.Sprintf("sha256:%x", sum[:8])
}

// ReconcilePending re-examines interrupted work on every poll.
//
// RecoverPending runs once at startup, which is not enough for a reboot: if the
// machine has not gone down yet, the record is deliberately left pending. Only
// re-checking on a schedule turns "still waiting" into a terminal failure once
// the deadline passes, so an operation can never sit unresolved forever.
func (r *OperationRunner) ReconcilePending(ctx context.Context) error {
	pending, err := r.Store.Recover()
	if err != nil {
		return err
	}
	for _, record := range pending {
		if record.Operation != plan.OpHostReboot {
			continue
		}
		r.finishReboot(ctx, record)
	}
	return nil
}

// PollOnce fetches at most one plan and runs it to completion.
//
// Returns true when work was performed, so the caller can poll again promptly
// instead of waiting a full interval.
func (r *OperationRunner) PollOnce(ctx context.Context) (bool, error) {
	// A reboot that never happened must eventually fail rather than linger.
	if err := r.ReconcilePending(ctx); err != nil && r.Logger != nil {
		r.Logger.Warn("pending reconciliation failed", "error", err.Error())
	}

	raw, err := r.Source.Poll(ctx)
	if err != nil {
		return false, err
	}
	if len(raw) == 0 {
		return false, nil
	}

	// The plan is hostile input until it validates against this agent's own
	// identity and clock.
	parsed, err := plan.Parse(raw, r.Identity, r.now())
	if err != nil {
		if r.Logger != nil {
			r.Logger.Warn("rejected plan", "error", err.Error())
		}
		return false, nil
	}

	record, fresh, err := r.Store.Claim(parsed.OperationID, parsed.Attempt, parsed.Operation, parsed.ContentDigest)
	if err != nil {
		return false, err
	}
	if !fresh {
		// A redelivery must be the SAME work, not merely the same id. If the
		// control center reuses an id with different content, replaying the
		// stored receipt would answer a question that was never asked.
		if err := sameWork(record, parsed); err != nil {
			if r.Logger != nil {
				r.Logger.Error("refusing a redelivery that does not match the stored claim",
					"operation", record.OperationID, "error", err.Error())
			}
			return false, nil
		}
		// Already known. Replaying the stored receipt is the idempotent answer;
		// re-executing would break exactly-once.
		if record.Status == state.StatusComplete && len(record.Receipt) > 0 {
			if err := r.Source.Receipt(ctx, record.OperationID, record.Receipt); err != nil && r.Logger != nil {
				r.Logger.Warn("receipt replay failed", "operation", record.OperationID, "error", err.Error())
			}
			return true, nil
		}
		if r.Logger != nil {
			r.Logger.Warn("ignoring re-delivered in-flight operation", "operation", record.OperationID)
		}
		return false, nil
	}

	// Intent is durable; only now may the side effect happen.
	//
	// Start is idempotent server-side for the same attempt, so a transport
	// failure is retried rather than treated as a refusal. Closing the claim
	// out on an ambiguous network error would report a failure for work the
	// control center may already consider running.
	if err := r.startWithRetry(ctx, parsed); err != nil {
		if isDefiniteRefusal(err) {
			// The control center gave a definite answer: this attempt may not
			// proceed. Close it out locally so a later delivery is not mistaken
			// for a crashed attempt.
			receipt := r.failure(parsed, record.ClaimedAt, "control center refused the start: "+err.Error())
			r.submit(ctx, parsed.OperationID, receipt)
			return true, nil
		}
		// Ambiguous: leave the claim in place and try again on a later poll.
		// The claim guarantees the work is never started twice.
		if r.Logger != nil {
			r.Logger.Warn("start was inconclusive; leaving the claim for a later poll",
				"operation", parsed.OperationID, "error", err.Error())
		}
		return false, nil
	}

	receipt := r.run(ctx, parsed, record)
	if receipt == nil {
		// A reboot was issued; the machine is going down. The receipt is
		// produced after the next boot from the persisted evidence.
		return true, nil
	}
	r.submit(ctx, parsed.OperationID, receipt)
	return true, nil
}

// startRetries bounds how long one poll will spend trying to confirm a start.
const startRetries = 3

// startWithRetry asks the control center to move the operation to running.
//
// Repeating the same (operationId, attempt) is safe: the backend accepts it
// only for the attempt it leased, and answering twice is idempotent.
func (r *OperationRunner) startWithRetry(ctx context.Context, p *plan.Plan) error {
	var lastErr error
	for i := 0; i < startRetries; i++ {
		lastErr = r.Source.Start(ctx, p)
		if lastErr == nil {
			return nil
		}
		if isDefiniteRefusal(lastErr) {
			return lastErr
		}
		if ctx.Err() != nil {
			return lastErr
		}
	}
	return lastErr
}

// isDefiniteRefusal distinguishes "the control center said no" from "we could
// not tell". Only the former may close an operation out locally.
func isDefiniteRefusal(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	for _, definite := range []string{
		"HTTP 400", "HTTP 401", "HTTP 403", "HTTP 404", "HTTP 409", "HTTP 410", "HTTP 422",
	} {
		if strings.Contains(message, definite) {
			return true
		}
	}
	return false
}

// sameWork rejects a redelivery whose content differs from what was claimed.
func sameWork(record *state.Record, p *plan.Plan) error {
	if record.Operation != "" && record.Operation != p.Operation {
		return fmt.Errorf("stored operation %q but the plan says %q", record.Operation, p.Operation)
	}
	if record.ContentDigest != "" && record.ContentDigest != p.ContentDigest {
		return fmt.Errorf("stored content digest %s but the plan says %s", record.ContentDigest, p.ContentDigest)
	}
	if record.Attempt != 0 && record.Attempt != p.Attempt {
		return fmt.Errorf("stored attempt %d but the plan says %d", record.Attempt, p.Attempt)
	}
	return nil
}

func (r *OperationRunner) failure(p *plan.Plan, startedAt time.Time, message string) *plan.Receipt {
	return &plan.Receipt{
		SchemaVersion:   plan.ReceiptSchemaVersion,
		OperationID:     p.OperationID,
		Attempt:         p.Attempt,
		ControlCenterID: p.ControlCenterID,
		HostID:          p.HostID,
		Operation:       p.Operation,
		ContentDigest:   p.ContentDigest,
		Outcome:         plan.OutcomeFailed,
		StartedAt:       startedAt,
		FinishedAt:      r.now(),
		ExitCode:        -1,
		Message:         message,
		Evidence:        map[string]string{},
	}
}

// run performs the typed work. A nil return means the host is rebooting.
func (r *OperationRunner) run(ctx context.Context, p *plan.Plan, record *state.Record) *plan.Receipt {
	startedAt := r.now()
	receipt := &plan.Receipt{
		SchemaVersion:   plan.ReceiptSchemaVersion,
		OperationID:     p.OperationID,
		Attempt:         p.Attempt,
		ControlCenterID: p.ControlCenterID,
		HostID:          p.HostID,
		Operation:       p.Operation,
		ContentDigest:   p.ContentDigest,
		StartedAt:       startedAt,
		Evidence:        map[string]string{},
	}

	switch p.Operation {
	case plan.OpJournalQuery:
		result, err := r.Executor.Journal(ctx, p.Journal)
		receipt.FinishedAt = r.now()
		receipt.ExitCode = result.ExitCode
		receipt.Output = result.Stdout
		receipt.Truncated = result.Truncated
		if err != nil {
			receipt.Outcome = plan.OutcomeFailed
			receipt.Message = err.Error()
			return receipt
		}
		receipt.Outcome = plan.OutcomeSucceeded
		receipt.Message = "journal query completed"
		return receipt

	case plan.OpServiceRestart:
		result, evidence, err := r.Executor.RestartService(ctx, p.Service.Unit)
		receipt.FinishedAt = r.now()
		receipt.ExitCode = result.ExitCode
		receipt.Output = result.Stdout
		receipt.Truncated = result.Truncated
		receipt.Evidence = evidence
		if err != nil {
			receipt.Outcome = plan.OutcomeFailed
			receipt.Message = err.Error()
			return receipt
		}
		if result.ExitCode != 0 {
			receipt.Outcome = plan.OutcomeFailed
			receipt.Message = fmt.Sprintf("systemctl restart exited %d", result.ExitCode)
			return receipt
		}
		receipt.Outcome = plan.OutcomeSucceeded
		receipt.Message = "unit restarted"
		return receipt

	case plan.OpHostReboot:
		evidence, err := r.Executor.PrepareReboot(p.Reboot.DeadlineSeconds)
		if err != nil {
			receipt.FinishedAt = r.now()
			receipt.Outcome = plan.OutcomeFailed
			receipt.ExitCode = -1
			receipt.Message = err.Error()
			return receipt
		}
		// The pre-reboot boot id must be durable before the machine goes down,
		// or the outcome becomes undecidable after restart.
		if err := r.Store.SetEvidence(p.OperationID, evidence); err != nil {
			receipt.FinishedAt = r.now()
			receipt.Outcome = plan.OutcomeFailed
			receipt.ExitCode = -1
			receipt.Message = "could not persist reboot evidence: " + err.Error()
			return receipt
		}
		if err := r.Executor.Reboot(ctx); err != nil {
			receipt.FinishedAt = r.now()
			receipt.Outcome = plan.OutcomeFailed
			receipt.ExitCode = -1
			receipt.Message = "reboot command failed: " + err.Error()
			receipt.Evidence = evidence
			return receipt
		}
		if r.Logger != nil {
			r.Logger.Info("reboot issued; receipt follows after restart", "operation", p.OperationID)
		}
		return nil

	case plan.OpPackageRefresh, plan.OpPackageUpdate, plan.OpKernelUpdate:
		return r.runPackageOperation(ctx, p, receipt)

	case plan.OpNetworkConfigure, plan.OpMountConfigure, plan.OpFilesystemGrow,
		plan.OpOSImageStage, plan.OpOSImageRollback:
		return r.runStage4Operation(ctx, p, receipt)
	case plan.OpSSHBan, plan.OpSSHUnban:
		return r.runSSHBanOperation(ctx, p, receipt)
	case plan.OpSSHProtectionEnable:
		return r.runSSHProtectionOperation(ctx, p, receipt)

	default:
		receipt.FinishedAt = r.now()
		receipt.Outcome = plan.OutcomeFailed
		receipt.ExitCode = -1
		receipt.Message = "unsupported operation " + p.Operation
		return receipt
	}
}

func (r *OperationRunner) runSSHProtectionOperation(
	ctx context.Context,
	p *plan.Plan,
	receipt *plan.Receipt,
) *plan.Receipt {
	receipt.FinishedAt = r.now()
	if r.SSHBan == nil {
		receipt.Outcome = plan.OutcomeFailed
		receipt.ExitCode = -1
		receipt.Message = "SSH protection operations are not configured on this host"
		return receipt
	}
	result, evidence, err := r.SSHBan.EnableProtection(ctx, p.SSHProtection)
	receipt.FinishedAt = r.now()
	receipt.ExitCode = result.ExitCode
	receipt.Output = result.Stdout
	receipt.Truncated = result.Truncated
	receipt.Evidence = evidence
	if err != nil {
		receipt.Outcome = plan.OutcomeFailed
		if receipt.ExitCode == 0 {
			receipt.ExitCode = -1
		}
		receipt.Message = err.Error()
		return receipt
	}
	receipt.Outcome = plan.OutcomeSucceeded
	receipt.Message = "SSH protection installed, activated and verified"
	return receipt
}

func (r *OperationRunner) runSSHBanOperation(ctx context.Context, p *plan.Plan, receipt *plan.Receipt) *plan.Receipt {
	receipt.FinishedAt = r.now()
	if r.SSHBan == nil {
		receipt.Outcome = plan.OutcomeFailed
		receipt.ExitCode = -1
		receipt.Message = "SSH ban operations are not configured on this host"
		return receipt
	}
	result, evidence, err := r.SSHBan.Apply(ctx, p.Operation, p.SSHBan)
	receipt.FinishedAt = r.now()
	receipt.ExitCode = result.ExitCode
	receipt.Output = result.Stdout
	receipt.Truncated = result.Truncated
	receipt.Evidence = evidence
	if err != nil {
		receipt.Outcome = plan.OutcomeFailed
		if receipt.ExitCode == 0 {
			receipt.ExitCode = -1
		}
		receipt.Message = err.Error()
		return receipt
	}
	receipt.Outcome = plan.OutcomeSucceeded
	if p.Operation == plan.OpSSHBan {
		receipt.Message = "address banned from SSH and verified"
	} else {
		receipt.Message = "address unbanned from SSH and verified"
	}
	return receipt
}

// submit stores the receipt durably, then reports it.
//
// Storing first means a network failure during reporting cannot cause a second
// execution: the next poll finds a complete record and replays the same bytes.
func (r *OperationRunner) submit(ctx context.Context, operationID string, receipt *plan.Receipt) {
	// Every command output is host-controlled, including error text and values
	// copied into evidence. Normalize it at the one boundary shared by all
	// operation types so a newly added executor cannot accidentally create a
	// receipt that validation refuses (or carry terminal control sequences into
	// the console).
	receipt.Message, _ = execute.Sanitize(receipt.Message, plan.MaxReceiptMessage)
	cleanedOutput, outputTruncated := execute.Sanitize(receipt.Output, plan.MaxReceiptOutput)
	receipt.Output = cleanedOutput
	receipt.Truncated = receipt.Truncated || outputTruncated
	for key, value := range receipt.Evidence {
		cleaned, _ := execute.Sanitize(value, plan.MaxEvidenceValueChars)
		receipt.Evidence[key] = cleaned
	}

	// Shrink first, then validate. Truncation and evidence are added after the
	// body is first assembled, so the only meaningful size check is on the
	// final bytes; validating before shrinking would reject a receipt that is
	// about to become acceptable.
	body, err := r.shrinkToFit(receipt)
	if err != nil {
		if r.Logger != nil {
			r.Logger.Error("cannot encode receipt", "operation", operationID, "error", err.Error())
		}
		return
	}
	if err := receipt.Validate(); err != nil {
		if r.Logger != nil {
			r.Logger.Error("refusing to submit malformed receipt", "operation", operationID, "error", err.Error())
		}
		return
	}
	if _, err := r.Store.Complete(operationID, body, receipt.Evidence); err != nil {
		if r.Logger != nil {
			r.Logger.Error("cannot persist receipt", "operation", operationID, "error", err.Error())
		}
		return
	}
	if err := r.Source.Receipt(ctx, operationID, body); err != nil {
		// The receipt is durable; a later poll replays it.
		if r.Logger != nil {
			r.Logger.Warn("receipt not delivered; will replay", "operation", operationID, "error", err.Error())
		}
	}
}

// shrinkToFit drops the least important content until the serialized receipt
// fits the signed-channel body limit.
//
// Order matters: the outcome and the evidence that explains it are worth more
// than the captured log tail, so output goes first and evidence only if that is
// still not enough.
func (r *OperationRunner) shrinkToFit(receipt *plan.Receipt) ([]byte, error) {
	body, err := json.Marshal(receipt)
	if err != nil {
		return nil, err
	}
	if len(body) <= plan.MaxReceiptBytes {
		return body, nil
	}

	// Halve the output until it fits, rather than discarding it outright: a
	// truncated tail is still useful to whoever is diagnosing the host.
	for len(receipt.Output) > 0 && len(body) > plan.MaxReceiptBytes {
		receipt.Output, _ = execute.Sanitize(receipt.Output, len(receipt.Output)/2)
		receipt.Truncated = true
		body, err = json.Marshal(receipt)
		if err != nil {
			return nil, err
		}
	}
	if len(body) <= plan.MaxReceiptBytes {
		return body, nil
	}

	receipt.Output = ""
	receipt.Truncated = true
	receipt.Evidence = map[string]string{"note": "evidence dropped: receipt exceeded the transport limit"}
	receipt.Message = boundedMessage(receipt.Message + " (content dropped: receipt too large)")
	body, err = json.Marshal(receipt)
	if err != nil {
		return nil, err
	}
	if len(body) > plan.MaxReceiptBytes {
		return nil, fmt.Errorf("receipt is %d bytes even after dropping content", len(body))
	}
	return body, nil
}

func boundedMessage(value string) string {
	bounded, _ := execute.Sanitize(value, plan.MaxReceiptMessage)
	return bounded
}

// ErrNoWork signals an empty poll to callers that prefer an error.
var ErrNoWork = errors.New("no operation available")

// runPackageOperation carries out the Stage 3 maintenance operations.
//
// None of them reboots. A kernel update leaves the new image on disk and the
// old one running, and reports that as evidence; changing the running kernel is
// host.reboot, which is approved separately and carries the Kubernetes drain
// gates this path deliberately does not have.
func (r *OperationRunner) runPackageOperation(ctx context.Context, p *plan.Plan, receipt *plan.Receipt) *plan.Receipt {
	fail := func(message string) *plan.Receipt {
		receipt.FinishedAt = r.now()
		receipt.Outcome = plan.OutcomeFailed
		receipt.ExitCode = -1
		receipt.Message = message
		return receipt
	}
	if r.Packages == nil {
		return fail("package operations are not configured on this host")
	}

	var (
		result   execute.Result
		evidence map[string]string
		err      error
	)
	switch p.Operation {
	case plan.OpPackageRefresh:
		result, evidence, err = r.Packages.Refresh(ctx, p.PackageRefresh)
	case plan.OpPackageUpdate:
		result, evidence, err = r.Packages.Update(ctx, p.PackageUpdate)
	case plan.OpKernelUpdate:
		result, evidence, err = r.Packages.KernelUpdate(ctx, p.KernelUpdate)
	default:
		return fail("unsupported operation " + p.Operation)
	}

	receipt.FinishedAt = r.now()
	receipt.ExitCode = result.ExitCode
	receipt.Output = result.Stdout
	receipt.Truncated = result.Truncated
	receipt.Evidence = evidence
	if err != nil {
		receipt.Outcome = plan.OutcomeFailed
		if receipt.ExitCode == 0 {
			// A refusal that never ran anything still failed the operation.
			receipt.ExitCode = -1
		}
		receipt.Message = err.Error()
		return receipt
	}
	receipt.Outcome = plan.OutcomeSucceeded
	switch p.Operation {
	case plan.OpPackageRefresh:
		receipt.Message = "package index refreshed"
	case plan.OpPackageUpdate:
		receipt.Message = "packages updated"
	case plan.OpKernelUpdate:
		if evidence["rebootRequired"] == "true" {
			receipt.Message = "kernel installed; a reboot is required and was not performed"
		} else {
			receipt.Message = "kernel already current"
		}
	}
	return receipt
}

// runStage4Operation carries out the network, storage and image operations.
//
// None of them reboots. A staged image and a grown filesystem are both changes
// the host reports and the operator acts on separately; changing the running
// system is host.reboot, which is approved on its own and carries the
// Kubernetes drain gates this path deliberately does not have.
func (r *OperationRunner) runStage4Operation(ctx context.Context, p *plan.Plan, receipt *plan.Receipt) *plan.Receipt {
	fail := func(message string) *plan.Receipt {
		receipt.FinishedAt = r.now()
		receipt.Outcome = plan.OutcomeFailed
		receipt.ExitCode = -1
		receipt.Message = message
		return receipt
	}

	var (
		result   execute.Result
		evidence map[string]string
		err      error
	)
	switch p.Operation {
	case plan.OpNetworkConfigure:
		if r.Network == nil {
			return fail("network operations are not configured on this host")
		}
		prepared, preflight, preErr := r.Network.Preflight(ctx, p.Network)
		if preErr != nil {
			receipt.Evidence = preflight
			return fail(preErr.Error())
		}
		// The undo record has to be durable before the change is made. An agent
		// killed between applying and confirming would otherwise leave the host
		// on settings nobody ever proved reachable, with nothing on disk saying
		// what they used to be.
		if armErr := r.Store.SetEvidence(p.OperationID, prepared.Rollback); armErr != nil {
			receipt.Evidence = preflight
			return fail("could not record how to undo this change, so it was not made: " + armErr.Error())
		}
		result, evidence, err = r.Network.Apply(ctx, prepared, p.Network)
	case plan.OpMountConfigure:
		if r.Storage == nil {
			return fail("storage operations are not configured on this host")
		}
		result, evidence, err = r.Storage.ConfigureMount(ctx, p.Mount)
	case plan.OpFilesystemGrow:
		if r.Storage == nil {
			return fail("storage operations are not configured on this host")
		}
		result, evidence, err = r.Storage.Grow(ctx, p.FilesystemGrow)
	case plan.OpOSImageStage:
		if r.OSImage == nil {
			return fail("operating system image operations are not configured on this host")
		}
		result, evidence, err = r.OSImage.Stage(ctx, p.OSImage)
	case plan.OpOSImageRollback:
		if r.OSImage == nil {
			return fail("operating system image operations are not configured on this host")
		}
		result, evidence, err = r.OSImage.Rollback(ctx, p.OSImage)
	default:
		return fail("unsupported operation " + p.Operation)
	}

	receipt.FinishedAt = r.now()
	receipt.ExitCode = result.ExitCode
	receipt.Output = result.Stdout
	receipt.Truncated = result.Truncated
	receipt.Evidence = evidence
	if receipt.Evidence == nil {
		receipt.Evidence = map[string]string{}
	}
	if err != nil {
		receipt.Outcome = plan.OutcomeFailed
		if receipt.ExitCode == 0 {
			// A refusal that never ran anything still failed the operation.
			receipt.ExitCode = -1
		}
		receipt.Message = err.Error()
		return receipt
	}
	receipt.Outcome = plan.OutcomeSucceeded
	switch p.Operation {
	case plan.OpNetworkConfigure:
		receipt.Message = "network settings applied and the control center is still reachable"
	case plan.OpMountConfigure:
		if receipt.Evidence["persistent"] == "true" {
			receipt.Message = "filesystem mounted and configured to mount at boot"
		} else {
			receipt.Message = "filesystem mounted"
		}
	case plan.OpFilesystemGrow:
		receipt.Message = "filesystem grown to fill its block device"
	case plan.OpOSImageStage:
		receipt.Message = "image staged; a reboot is required and was not performed"
	case plan.OpOSImageRollback:
		receipt.Message = "the previous deployment is selected for the next boot; a reboot is required and was not performed"
	}
	return receipt
}

// restoreInterruptedNetwork puts the previous settings back after a crash.
//
// The stored record names the connection; the executor reads the rest of the
// previous settings from the same record. Where no record exists there is
// nothing to restore, and saying so is more useful than pretending the host is
// fine.
func (r *OperationRunner) restoreInterruptedNetwork(ctx context.Context, record *state.Record, evidence map[string]string) string {
	base := "agent restarted while a network change was in flight"
	if r.Network == nil || record.Evidence["rollbackConnection"] == "" {
		evidence["rollbackState"] = "not-recorded"
		return base + "; no rollback record was written, so the host was left as it was found"
	}
	detail, err := r.Network.RestoreFromEvidence(ctx, record.Evidence)
	if err != nil {
		evidence["rollbackState"] = "rollback-failed"
		evidence["rollbackError"] = err.Error()
		if r.Logger != nil {
			r.Logger.Error("could not restore network settings after an interrupted change",
				"operation", record.OperationID, "error", err.Error())
		}
		return base + "; restoring the previous settings failed: " + err.Error()
	}
	evidence["rollbackState"] = "rolled-back"
	return base + "; " + detail
}
