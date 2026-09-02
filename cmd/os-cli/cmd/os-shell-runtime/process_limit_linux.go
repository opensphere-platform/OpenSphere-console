//go:build linux

package main

import (
	"fmt"
	"os"
	"syscall"
	"time"
)

// RLIMIT_NPROC is Linux resource number 6 on every supported architecture.
// The frozen numeric value avoids adding a second syscall abstraction solely
// for a constant removed from Go's frozen syscall package.
const linuxRLIMITNPROC = 6

const (
	linuxPRGetDumpable = 3
	linuxPRSetDumpable = 4
)

func isRootProcess() bool { return os.Geteuid() == 0 }

func ptyProcessLimitsSupported() bool { return true }

func runtimeProcessProtectionsSupported() bool { return true }

func applyAgentProcessProtections() error {
	if err := disableCoreDumps(); err != nil {
		return err
	}
	return disableProcessDumpability()
}

func applyPTYProcessLimits() error {
	if err := setPTYProcessLimits(fixedPTYMaxProcesses); err != nil {
		return err
	}
	var observed syscall.Rlimit
	if err := syscall.Getrlimit(linuxRLIMITNPROC, &observed); err != nil {
		return fmt.Errorf("read RLIMIT_NPROC: %w", err)
	}
	if observed.Cur != fixedPTYMaxProcesses || observed.Max != fixedPTYMaxProcesses {
		return fmt.Errorf("RLIMIT_NPROC mismatch: soft=%d hard=%d", observed.Cur, observed.Max)
	}
	return nil
}

func setPTYProcessLimits(maxProcesses uint64) error {
	if maxProcesses < 2 {
		return fmt.Errorf("RLIMIT_NPROC must permit the fixed shell")
	}
	if err := disableCoreDumps(); err != nil {
		return err
	}
	if err := disableProcessDumpability(); err != nil {
		return err
	}
	if err := syscall.Setrlimit(linuxRLIMITNPROC, &syscall.Rlimit{Cur: maxProcesses, Max: maxProcesses}); err != nil {
		return fmt.Errorf("set RLIMIT_NPROC: %w", err)
	}
	return nil
}

func disableCoreDumps() error {
	if err := syscall.Setrlimit(syscall.RLIMIT_CORE, &syscall.Rlimit{Cur: 0, Max: 0}); err != nil {
		return fmt.Errorf("disable core dumps: %w", err)
	}
	var observed syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_CORE, &observed); err != nil {
		return fmt.Errorf("read RLIMIT_CORE: %w", err)
	}
	if observed.Cur != 0 || observed.Max != 0 {
		return fmt.Errorf("RLIMIT_CORE mismatch: soft=%d hard=%d", observed.Cur, observed.Max)
	}
	return nil
}

func disableProcessDumpability() error {
	if _, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, linuxPRSetDumpable, 0, 0, 0, 0, 0); errno != 0 {
		return fmt.Errorf("PR_SET_DUMPABLE: %w", errno)
	}
	value, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, linuxPRGetDumpable, 0, 0, 0, 0, 0)
	if errno != 0 {
		return fmt.Errorf("PR_GET_DUMPABLE: %w", errno)
	}
	if value != 0 {
		return fmt.Errorf("process remains dumpable: %d", value)
	}
	return nil
}

func terminateProcessGroup(processID int) {
	if processID < 2 {
		return
	}
	if err := syscall.Kill(-processID, syscall.SIGTERM); err != nil {
		return
	}
	timer := time.NewTimer(250 * time.Millisecond)
	defer timer.Stop()
	<-timer.C
	_ = syscall.Kill(-processID, syscall.SIGKILL)
}
