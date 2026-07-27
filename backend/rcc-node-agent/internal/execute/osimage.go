package execute

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"opensphere.io/rcc/node-agent/internal/plan"
)

// Fixed binary allowlists for the image adapters.
var (
	rpmOSTreePaths = []string{"/usr/bin/rpm-ostree"}
	bootcPaths     = []string{"/usr/bin/bootc", "/usr/lib/bootc/bootc"}
)

const (
	// Pulling and unpacking an operating system image is slow on any link worth
	// having. The bound exists so a stalled pull becomes a failed operation
	// rather than a lease that never returns.
	imageStageTimeout    = 45 * time.Minute
	imageRollbackTimeout = 5 * time.Minute
	maxImageOutput       = 32 * 1024
)

var (
	// ErrOSImageNotEnabled is returned when the host was never given image
	// authority.
	ErrOSImageNotEnabled = errors.New("operating system image operations are not enabled on this host")
	// ErrImageNotAllowed is returned when a reference is outside the host
	// allowlist.
	ErrImageNotAllowed = errors.New("image is not in the agent image allowlist")
	// ErrImageAdapterUnavailable is returned when the named adapter is absent.
	ErrImageAdapterUnavailable = errors.New("the image adapter named by this plan is not installed on this host")
)

// OSImageExecutor stages and rolls back image-based operating systems.
//
// Both operations write a deployment and stop. Nothing here reboots, and there
// is no argument that could ask it to: the running system does not change until
// host.reboot is separately requested and approved, and that path carries the
// Kubernetes drain gates this one deliberately does not have.
//
// The command lines are the documented, stable subcommands of each adapter, and
// each is gated on a capability probe of the installed binary rather than on an
// assumption about the distribution.
type OSImageExecutor struct {
	Runner Runner
	// Enabled is the host's own switch.
	Enabled bool
	// Allowlist names the digest-pinned references this host permits. Empty
	// means this agent stages nothing.
	Allowlist []string
	Now       func() time.Time
	// Test seams for binary resolution. Production leaves these empty.
	RPMOSTreePath string
	BootcPath     string
}

func (e *OSImageExecutor) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *OSImageExecutor) adapterBinary(adapter string) (string, error) {
	switch adapter {
	case plan.AdapterRPMOSTree:
		if e.RPMOSTreePath != "" {
			return e.RPMOSTreePath, nil
		}
		return resolveImageBinary(rpmOSTreePaths, adapter)
	case plan.AdapterBootc:
		if e.BootcPath != "" {
			return e.BootcPath, nil
		}
		return resolveImageBinary(bootcPaths, adapter)
	default:
		return "", fmt.Errorf("image adapter %q is not supported by this agent", adapter)
	}
}

func resolveImageBinary(candidates []string, adapter string) (string, error) {
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%w: %s", ErrImageAdapterUnavailable, adapter)
}

// ImageAllowed reports whether this host will stage a reference.
//
// The comparison is exact and the reference is digest-pinned by the plan
// grammar, so "allowed" means one specific image and not a repository whose tag
// somebody else controls.
func (e *OSImageExecutor) ImageAllowed(image string) error {
	if !e.Enabled {
		return ErrOSImageNotEnabled
	}
	for _, allowed := range e.Allowlist {
		if allowed == image {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrImageNotAllowed, image)
}

// supportsSubcommand probes the installed adapter.
//
// A subcommand is never assumed from the adapter name. An adapter too old to
// expose `rollback` produces a refusal, not a half-completed attempt.
func (e *OSImageExecutor) supportsSubcommand(ctx context.Context, binary, subcommand string) bool {
	runCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	result, err := e.Runner.Run(runCtx, []string{binary, "--help"}, maxImageOutput)
	if err != nil {
		return false
	}
	return strings.Contains(result.Stdout, subcommand)
}

// stageArgv builds the staging command for an adapter.
//
// Both forms are compile-time fixed apart from the image reference, which has
// already been through the digest-pinned grammar and the two allowlists. There
// is deliberately no `--apply`, no `--reboot` and no `-r`: a build that started
// passing one would have to add it here on purpose.
func stageArgv(adapter, binary, image string) ([]string, error) {
	switch adapter {
	case plan.AdapterBootc:
		// `switch` writes a new deployment and leaves the booted one running.
		// `--retain` keeps the current deployment so a rollback has somewhere to
		// go once this one is booted.
		return []string{binary, "switch", "--retain", "--", image}, nil
	case plan.AdapterRPMOSTree:
		// `rebase` on a container reference stages the deployment. The transport
		// prefix is fixed by this agent, not taken from the plan, so a plan
		// cannot select an unverified or a local transport.
		return []string{binary, "rebase", "--bypass-driver", "ostree-unverified-registry:" + image}, nil
	default:
		return nil, fmt.Errorf("image adapter %q is not supported by this agent", adapter)
	}
}

func rollbackArgv(adapter, binary string) ([]string, error) {
	switch adapter {
	case plan.AdapterBootc, plan.AdapterRPMOSTree:
		return []string{binary, "rollback"}, nil
	default:
		return nil, fmt.Errorf("image adapter %q is not supported by this agent", adapter)
	}
}

// Stage writes a new deployment and stops.
func (e *OSImageExecutor) Stage(ctx context.Context, args *plan.OSImageArgs) (Result, map[string]string, error) {
	evidence := map[string]string{
		"adapter":  args.Adapter,
		"image":    args.Image,
		"rebooted": "false",
	}
	if args.RebootAfter {
		// Unreachable through a validated plan. Kept because this is the last
		// place the guarantee can be enforced.
		return Result{ExitCode: -1}, evidence, errors.New("image operations never reboot")
	}
	if err := e.ImageAllowed(args.Image); err != nil {
		return Result{ExitCode: -1}, evidence, err
	}
	binary, err := e.adapterBinary(args.Adapter)
	if err != nil {
		return Result{ExitCode: -1}, evidence, err
	}
	subcommand := "switch"
	if args.Adapter == plan.AdapterRPMOSTree {
		subcommand = "rebase"
	}
	if !e.supportsSubcommand(ctx, binary, subcommand) {
		return Result{ExitCode: -1}, evidence, fmt.Errorf(
			"the %s installed on this host does not expose %s, so an image cannot be staged",
			args.Adapter, subcommand)
	}

	argv, err := stageArgv(args.Adapter, binary, args.Image)
	if err != nil {
		return Result{ExitCode: -1}, evidence, err
	}
	runCtx, cancel := context.WithTimeout(ctx, imageStageTimeout)
	defer cancel()
	result, err := e.Runner.Run(runCtx, argv, maxImageOutput)
	cleaned, truncated := Sanitize(result.Stdout, maxImageOutput)
	result.Stdout = cleaned
	result.Truncated = result.Truncated || truncated
	if err != nil {
		return result, evidence, err
	}
	if result.ExitCode != 0 {
		return result, evidence, fmt.Errorf("%s exited %d while staging the image", args.Adapter, result.ExitCode)
	}
	evidence["staged"] = "true"
	evidence["stagedAt"] = e.now().UTC().Format(time.RFC3339)
	evidence["rebootRequired"] = "true"
	evidence["rebootRequiredNote"] = "the running system is unchanged until host.reboot is separately requested and approved"
	return result, evidence, nil
}

// Rollback returns the next boot to the previous deployment.
func (e *OSImageExecutor) Rollback(ctx context.Context, args *plan.OSImageArgs) (Result, map[string]string, error) {
	evidence := map[string]string{
		"adapter":  args.Adapter,
		"rebooted": "false",
	}
	if !e.Enabled {
		return Result{ExitCode: -1}, evidence, ErrOSImageNotEnabled
	}
	if args.Image != "" {
		return Result{ExitCode: -1}, evidence,
			errors.New("a rollback names no image; it returns to the deployment already on the disk")
	}
	binary, err := e.adapterBinary(args.Adapter)
	if err != nil {
		return Result{ExitCode: -1}, evidence, err
	}
	if !e.supportsSubcommand(ctx, binary, "rollback") {
		return Result{ExitCode: -1}, evidence, fmt.Errorf(
			"the %s installed on this host does not expose rollback", args.Adapter)
	}

	argv, err := rollbackArgv(args.Adapter, binary)
	if err != nil {
		return Result{ExitCode: -1}, evidence, err
	}
	runCtx, cancel := context.WithTimeout(ctx, imageRollbackTimeout)
	defer cancel()
	result, err := e.Runner.Run(runCtx, argv, maxImageOutput)
	cleaned, truncated := Sanitize(result.Stdout, maxImageOutput)
	result.Stdout = cleaned
	result.Truncated = result.Truncated || truncated
	if err != nil {
		return result, evidence, err
	}
	if result.ExitCode != 0 {
		return result, evidence, fmt.Errorf("%s exited %d while rolling back", args.Adapter, result.ExitCode)
	}
	evidence["rolledBack"] = "true"
	evidence["rolledBackAt"] = e.now().UTC().Format(time.RFC3339)
	evidence["rebootRequired"] = "true"
	evidence["rebootRequiredNote"] = "the previous deployment is selected for the next boot; the running system is unchanged"
	return result, evidence, nil
}
