package collect

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"time"

	"opensphere.io/rcc/node-agent/internal/snapshot"
)

// systemctlPaths is a fixed allowlist. The agent never resolves the binary from
// PATH and never accepts a path from configuration or from the control center.
var systemctlPaths = []string{
	"/usr/bin/systemctl",
	"/bin/systemctl",
	"/usr/sbin/systemctl",
}

// failedUnitsArgv is compile-time fixed. Stage 1 has no mechanism to add,
// reorder or template these arguments, so this is a local read-only probe and
// not a remote execution surface.
var failedUnitsArgv = []string{"--failed", "--plain", "--no-legend", "--no-pager", "--full"}

const (
	systemdProbeTimeout = 5 * time.Second
	systemdProbeMaxRead = 64 * 1024
)

var errSystemdUnavailable = errors.New("systemd is not the active init system")

// probeSystemd reports init availability and the failed-unit summary.
func probeSystemd(ctx context.Context) (snapshot.Systemd, error) {
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return snapshot.Systemd{Available: false}, nil
	}
	binary := ""
	for _, candidate := range systemctlPaths {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			binary = candidate
			break
		}
	}
	if binary == "" {
		return snapshot.Systemd{Available: true}, errSystemdUnavailable
	}
	return runFailedUnitsProbe(ctx, binary)
}

func runFailedUnitsProbe(ctx context.Context, binary string) (snapshot.Systemd, error) {
	probeCtx, cancel := context.WithTimeout(ctx, systemdProbeTimeout)
	defer cancel()

	cmd := exec.CommandContext(probeCtx, binary, failedUnitsArgv...)
	cmd.Env = []string{"LC_ALL=C", "SYSTEMD_COLORS=0"}
	cmd.Stdin = nil
	// One byte past the reported bound, so summarizeFailedUnits can still tell
	// a full read from a truncated one without buffering whatever systemctl
	// decided to print.
	out := newBoundedBuffer(systemdProbeMaxRead + 1)
	cmd.Stdout = out
	cmd.Stderr = nil

	// `systemctl --failed` exits non-zero when units are failed, so output is
	// parsed regardless of exit status; only a timeout is treated as degraded.
	runErr := cmd.Run()
	if probeCtx.Err() != nil {
		return snapshot.Systemd{Available: true}, probeCtx.Err()
	}
	summary := summarizeFailedUnits(out.Bytes())
	if summary.FailedUnitCount == 0 && runErr != nil && out.Len() == 0 {
		return snapshot.Systemd{Available: true}, runErr
	}
	return summary, nil
}

// summarizeFailedUnits bounds the raw probe output and derives the reported
// counts. It is separate from the exec path so the bounding rules are testable
// without running systemctl.
func summarizeFailedUnits(raw []byte) snapshot.Systemd {
	data := raw
	streamTruncated := false
	if len(data) > systemdProbeMaxRead {
		data = data[:systemdProbeMaxRead]
		// Drop the severed trailing line so a partial unit name is neither
		// listed nor counted.
		if idx := bytes.LastIndexByte(data, '\n'); idx >= 0 {
			data = data[:idx]
		} else {
			data = nil
		}
		streamTruncated = true
	}
	units, total := parseFailedUnits(data)
	return snapshot.Systemd{
		Available:       true,
		FailedUnitCount: total,
		FailedUnits:     units,
		// True when the listed names are incomplete for either reason: more
		// failures than the list bound, or output cut at the read bound.
		Truncated: streamTruncated || total > len(units),
	}
}
