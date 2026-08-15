//go:build !linux

package main

import "testing"

func TestPTYProcessLimitsFailClosedOffLinux(t *testing.T) {
	if ptyProcessLimitsSupported() {
		t.Fatal("non-Linux runtime unexpectedly claims enforceable process limits")
	}
	if err := applyPTYProcessLimits(); err == nil {
		t.Fatal("non-Linux runtime must fail closed")
	}
	if runtimeProcessProtectionsSupported() || applyAgentProcessProtections() == nil {
		t.Fatal("non-Linux credential agent protections must fail closed")
	}
}
