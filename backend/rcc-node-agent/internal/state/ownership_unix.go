//go:build unix

package state

import (
	"fmt"
	"os"
	"syscall"
)

// checkOwnership refuses a state file owned by another user.
//
// The agent runs as root; a record owned by anyone else means something other
// than this agent wrote it, and its contents cannot be trusted to decide
// whether an operation already ran.
func checkOwnership(info os.FileInfo, target string) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	if int(stat.Uid) != os.Getuid() && os.Getuid() != 0 {
		return fmt.Errorf("%s is owned by uid %d, not this agent", target, stat.Uid)
	}
	return nil
}
