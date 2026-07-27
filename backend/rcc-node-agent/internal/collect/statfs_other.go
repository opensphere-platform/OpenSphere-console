//go:build !linux

package collect

import "errors"

// errUnsupportedPlatform keeps non-Linux builds compilable for development and
// CI while making the unsupported path explicit rather than silently empty.
var errUnsupportedPlatform = errors.New("filesystem usage collection requires linux")

func statfsUsage(string) (FSUsage, error) {
	return FSUsage{}, errUnsupportedPlatform
}
