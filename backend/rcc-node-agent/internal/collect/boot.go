package collect

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"time"

	"opensphere.io/rcc/node-agent/internal/snapshot"
)

var (
	rpmOSTreePaths = []string{"/usr/bin/rpm-ostree"}
	bootcPaths     = []string{"/usr/bin/bootc", "/usr/lib/bootc/bootc"}
	snapPaths      = []string{"/usr/bin/snap"}
)

const (
	bootProbeTimeout = 30 * time.Second
	bootProbeMaxRead = 128 * 1024
)

// Compile-time argv for each adapter's status command. All three are read-only
// and none of them can be talked into staging anything.
var (
	rpmOSTreeStatusArgv = []string{"status", "--json"}
	bootcStatusArgv     = []string{"status", "--json"}
	helpArgv            = []string{"--help"}
)

// probeBoot decides how this host takes an operating system update.
//
// The order matters: bootc is checked before rpm-ostree because a bootc host
// usually has rpm-ostree installed underneath it, and reporting the lower layer
// would name an adapter that is not the one in charge.
func probeBoot(ctx context.Context, osID string, now time.Time) (snapshot.BootState, error) {
	state := snapshot.BootState{
		Model:       snapshot.BootModelMutable,
		Deployments: []snapshot.Deployment{},
		CollectedAt: now.UTC().Format(time.RFC3339),
	}

	if binary := firstExisting(bootcPaths); binary != "" && ostreeBooted() {
		return probeBootc(ctx, binary, state)
	}
	if binary := firstExisting(rpmOSTreePaths); binary != "" && ostreeBooted() {
		return probeRPMOSTree(ctx, binary, state)
	}
	if isUbuntuCore(osID) {
		state.Model = snapshot.BootModelSnap
		state.Adapter = "snapd"
		state.Supported = false
		// Honest rather than convenient. snapd owns its own refresh schedule and
		// its own rollback, and a second scheduler racing it would be worse than
		// no scheduler at all.
		state.UnsupportedReason = "Ubuntu Core updates and rollbacks are governed by snapd's own refresh model; " +
			"this agent reports the boot model and does not drive it"
		return state, nil
	}

	state.Model = snapshot.BootModelMutable
	state.Adapter = "none"
	state.Supported = false
	state.UnsupportedReason = "this host takes updates through its package manager, not as an image; " +
		"use package.update and kernel.update, which are reviewed the same way"
	return state, nil
}

// ostreeBooted reports whether the running system is actually an ostree
// deployment. The binary being installed is not enough: rpm-ostree on a
// package-managed host would otherwise be read as an image system.
func ostreeBooted() bool {
	if _, err := os.Stat("/run/ostree-booted"); err == nil {
		return true
	}
	_, err := os.Stat("/ostree")
	return err == nil
}

func isUbuntuCore(osID string) bool {
	return strings.EqualFold(strings.TrimSpace(osID), "ubuntu-core")
}

// adapterSupports probes what the installed adapter can actually do.
//
// A subcommand is never assumed from the model. An adapter that is present but
// too old to expose `rollback` is reported as unable to roll back, and the
// operation is refused rather than attempted and failed halfway.
func adapterSupports(ctx context.Context, binary string, subcommands ...string) map[string]bool {
	found := map[string]bool{}
	raw, err := runBounded(ctx, bootProbeTimeout, bootProbeMaxRead, binary, helpArgv)
	if err != nil && len(raw) == 0 {
		return found
	}
	help := string(raw)
	for _, sub := range subcommands {
		found[sub] = strings.Contains(help, sub)
	}
	return found
}

type rpmOSTreeStatus struct {
	Deployments []struct {
		ID                      string   `json:"id"`
		Origin                  string   `json:"origin"`
		Checksum                string   `json:"checksum"`
		BaseChecksum            string   `json:"base-checksum"`
		Version                 string   `json:"version"`
		Booted                  bool     `json:"booted"`
		Staged                  bool     `json:"staged"`
		Pinned                  bool     `json:"pinned"`
		ContainerImageReference string   `json:"container-image-reference"`
		Requested               []string `json:"requested-packages"`
	} `json:"deployments"`
}

func probeRPMOSTree(ctx context.Context, binary string, state snapshot.BootState) (snapshot.BootState, error) {
	state.Model = snapshot.BootModelRPMOSTree
	state.Adapter = "rpm-ostree"

	capabilities := adapterSupports(ctx, binary, "rebase", "rollback")
	state.CanStage = capabilities["rebase"]
	state.CanRollback = capabilities["rollback"]
	state.Supported = state.CanStage || state.CanRollback
	if !state.Supported {
		state.UnsupportedReason = "the installed rpm-ostree does not expose rebase or rollback"
	}

	raw, err := runBounded(ctx, bootProbeTimeout, bootProbeMaxRead, binary, rpmOSTreeStatusArgv)
	if err != nil && len(raw) == 0 {
		state.Supported = false
		state.UnsupportedReason = "rpm-ostree status could not be read: " + err.Error()
		return state, err
	}
	var parsed rpmOSTreeStatus
	if err := json.Unmarshal(raw, &parsed); err != nil {
		state.Supported = false
		state.UnsupportedReason = "rpm-ostree status returned output this agent could not parse"
		return state, nil
	}

	for i, entry := range parsed.Deployments {
		if len(state.Deployments) >= snapshot.MaxDeployments {
			break
		}
		checksum := entry.Checksum
		if checksum == "" {
			checksum = entry.BaseChecksum
		}
		deployment := snapshot.Deployment{
			ID:      bound(entry.ID, 128),
			Version: bound(entry.Version, 128),
			Digest:  bound(checksum, 96),
			Origin:  bound(pickOrigin(entry.ContainerImageReference, entry.Origin), 255),
			Booted:  entry.Booted,
			Staged:  entry.Staged,
			Pinned:  entry.Pinned,
		}
		// rpm-ostree lists the pending deployment first and the booted one after
		// it; whatever follows the booted deployment is what a rollback returns
		// to.
		deployment.Rollback = !entry.Booted && !entry.Staged && i > 0 && parsed.Deployments[i-1].Booted
		state.Deployments = append(state.Deployments, deployment)
	}
	state.Booted, state.Staged, state.RollbackAvailable = classifyDeployments(state.Deployments)
	if !state.CanRollback {
		state.RollbackAvailable = false
	}
	return state, nil
}

// bootcStatus mirrors only the fields consumed. bootc's document is a
// Kubernetes-style resource and gains fields between releases; decoding into a
// closed struct means a new one is discarded rather than forwarded.
type bootcStatus struct {
	Status struct {
		Staged   *bootcImage `json:"staged"`
		Booted   *bootcImage `json:"booted"`
		Rollback *bootcImage `json:"rollback"`
	} `json:"status"`
}

type bootcImage struct {
	Image struct {
		Image struct {
			Image     string `json:"image"`
			Transport string `json:"transport"`
		} `json:"image"`
		ImageDigest string `json:"imageDigest"`
		Version     string `json:"version"`
	} `json:"image"`
	Incompatible bool `json:"incompatible"`
	Pinned       bool `json:"pinned"`
}

func probeBootc(ctx context.Context, binary string, state snapshot.BootState) (snapshot.BootState, error) {
	state.Model = snapshot.BootModelBootc
	state.Adapter = "bootc"

	capabilities := adapterSupports(ctx, binary, "switch", "rollback")
	state.CanStage = capabilities["switch"]
	state.CanRollback = capabilities["rollback"]
	state.Supported = state.CanStage || state.CanRollback
	if !state.Supported {
		state.UnsupportedReason = "the installed bootc does not expose switch or rollback"
	}

	raw, err := runBounded(ctx, bootProbeTimeout, bootProbeMaxRead, binary, bootcStatusArgv)
	if err != nil && len(raw) == 0 {
		state.Supported = false
		state.UnsupportedReason = "bootc status could not be read: " + err.Error()
		return state, err
	}
	var parsed bootcStatus
	if err := json.Unmarshal(raw, &parsed); err != nil {
		state.Supported = false
		state.UnsupportedReason = "bootc status returned output this agent could not parse"
		return state, nil
	}

	add := func(entry *bootcImage, role string) {
		if entry == nil || len(state.Deployments) >= snapshot.MaxDeployments {
			return
		}
		state.Deployments = append(state.Deployments, snapshot.Deployment{
			ID:       bound(entry.Image.ImageDigest, 96),
			Version:  bound(entry.Image.Version, 128),
			Digest:   bound(entry.Image.ImageDigest, 96),
			Origin:   bound(entry.Image.Image.Image, 255),
			Booted:   role == "booted",
			Staged:   role == "staged",
			Rollback: role == "rollback",
			Pinned:   entry.Pinned,
		})
	}
	add(parsed.Status.Staged, "staged")
	add(parsed.Status.Booted, "booted")
	add(parsed.Status.Rollback, "rollback")

	state.Booted, state.Staged, state.RollbackAvailable = classifyDeployments(state.Deployments)
	if !state.CanRollback {
		state.RollbackAvailable = false
	}
	return state, nil
}

func pickOrigin(preferred, fallback string) string {
	if strings.TrimSpace(preferred) != "" {
		return preferred
	}
	return fallback
}

// classifyDeployments picks out the booted and staged entries and reports
// whether there is anything to roll back to.
func classifyDeployments(deployments []snapshot.Deployment) (*snapshot.Deployment, *snapshot.Deployment, bool) {
	var booted, staged *snapshot.Deployment
	rollback := false
	for i := range deployments {
		entry := deployments[i]
		switch {
		case entry.Booted:
			copied := entry
			booted = &copied
		case entry.Staged:
			copied := entry
			staged = &copied
		case entry.Rollback:
			rollback = true
		}
	}
	return booted, staged, rollback
}
