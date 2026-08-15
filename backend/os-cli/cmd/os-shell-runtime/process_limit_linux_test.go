//go:build linux

package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"testing"
)

func TestPTYProcessLimitContractIsExact(t *testing.T) {
	if fixedPTYMaxProcesses != 256 {
		t.Fatalf("release contract drifted: maxProcesses=%d", fixedPTYMaxProcesses)
	}
	if !ptyProcessLimitsSupported() {
		t.Fatal("Linux runtime must support enforceable process limits")
	}
}

func TestAgentCoreAndPtraceProtectionsInIsolatedProcess(t *testing.T) {
	if os.Getenv("OPENSPHERE_SHELL_AGENT_HARDENING_TEST") != "true" {
		command := exec.Command(os.Args[0], "-test.run=TestAgentCoreAndPtraceProtectionsInIsolatedProcess", "-test.count=1")
		command.Env = append(os.Environ(), "OPENSPHERE_SHELL_AGENT_HARDENING_TEST=true")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated agent hardening failed: %v\n%s", err, output)
		}
		return
	}
	if err := applyAgentProcessProtections(); err != nil {
		t.Fatal(err)
	}
	var core syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_CORE, &core); err != nil {
		t.Fatal(err)
	}
	if core.Cur != 0 || core.Max != 0 {
		t.Fatalf("agent core limit is open: soft=%d hard=%d", core.Cur, core.Max)
	}
	value, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, linuxPRGetDumpable, 0, 0, 0, 0, 0)
	if errno != 0 || value != 0 {
		t.Fatalf("agent remains ptrace/core dumpable: value=%d errno=%v", value, errno)
	}
}

// TestPTYProcessLimitForkStress runs in an isolated non-root build-stage user.
// The environment gate prevents an irreversible hard-limit change in the
// ordinary test process while keeping the production syscall path under test.
func TestPTYProcessLimitForkStress(t *testing.T) {
	if os.Getenv("OPENSPHERE_SHELL_PID_STRESS_TEST") != "true" {
		t.Skip("run by Dockerfile.runtime as an isolated non-root process")
	}
	if isRootProcess() {
		t.Fatal("RLIMIT_NPROC is not enforceable for root")
	}
	const isolatedLimit = uint64(64)
	if err := setPTYProcessLimits(isolatedLimit); err != nil {
		t.Fatal(err)
	}
	var observed syscall.Rlimit
	if err := syscall.Getrlimit(linuxRLIMITNPROC, &observed); err != nil {
		t.Fatal(err)
	}
	if observed.Cur != isolatedLimit || observed.Max != isolatedLimit {
		t.Fatalf("limit is not exact: soft=%d hard=%d", observed.Cur, observed.Max)
	}
	if err := syscall.Setrlimit(linuxRLIMITNPROC, &syscall.Rlimit{Cur: isolatedLimit + 1, Max: isolatedLimit + 1}); err == nil {
		t.Fatal("unprivileged shell process raised the hard process limit")
	}

	children := make([]*exec.Cmd, 0, isolatedLimit)
	defer func() {
		for _, child := range children {
			if child.Process != nil {
				_ = child.Process.Kill()
			}
			_ = child.Wait()
		}
	}()
	var bounded error
	for attempt := uint64(0); attempt < isolatedLimit*2; attempt++ {
		child := exec.Command("/bin/sleep", "30")
		if err := child.Start(); err != nil {
			bounded = err
			break
		}
		children = append(children, child)
	}
	if bounded == nil {
		t.Fatal("fork stress exceeded the inherited hard process bound")
	}
	if !errors.Is(bounded, syscall.EAGAIN) {
		t.Logf("process creation was bounded with platform error: %v", bounded)
	}
}
