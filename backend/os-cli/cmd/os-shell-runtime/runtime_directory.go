package main

import (
	"errors"
	"fmt"
	"os"
)

// prepareRuntimeDirectory accepts a Kubernetes fsGroup-owned EmptyDir mount.
// Such a mount is deliberately owned by root and cannot be chmod'ed by the
// non-root runtime, but it is group-writable and inaccessible to other users.
func prepareRuntimeDirectory(directory string) error {
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return err
	}
	if err := os.Chmod(directory, 0o750); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrPermission) {
		return err
	}
	info, err := os.Stat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm()&0o007 != 0 || info.Mode().Perm()&0o070 == 0 {
		return fmt.Errorf("runtime directory has unsafe fsGroup permissions: %s", info.Mode().Perm())
	}
	return nil
}
