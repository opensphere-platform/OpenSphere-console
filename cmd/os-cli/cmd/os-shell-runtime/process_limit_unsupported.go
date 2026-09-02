//go:build !linux

package main

import "errors"

var errPTYProcessLimitsUnsupported = errors.New("PTY runtime process limits are unavailable on this operating system")

func isRootProcess() bool { return false }

func ptyProcessLimitsSupported() bool { return false }

func runtimeProcessProtectionsSupported() bool { return false }

func applyAgentProcessProtections() error { return errPTYProcessLimitsUnsupported }

func applyPTYProcessLimits() error { return errPTYProcessLimitsUnsupported }

func terminateProcessGroup(int) {}
