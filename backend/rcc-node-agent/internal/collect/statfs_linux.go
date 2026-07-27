//go:build linux

package collect

import "syscall"

func statfsUsage(path string) (FSUsage, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return FSUsage{}, err
	}
	blockSize := int64(st.Bsize)
	total := int64(st.Blocks) * blockSize
	free := int64(st.Bfree) * blockSize
	avail := int64(st.Bavail) * blockSize
	return FSUsage{
		TotalBytes:     total,
		UsedBytes:      total - free,
		AvailableBytes: avail,
		InodesTotal:    int64(st.Files),
		InodesUsed:     int64(st.Files) - int64(st.Ffree),
	}, nil
}
