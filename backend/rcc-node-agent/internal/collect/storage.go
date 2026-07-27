package collect

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"opensphere.io/rcc/node-agent/internal/guard"
	"opensphere.io/rcc/node-agent/internal/snapshot"
)

var lsblkPaths = []string{"/usr/bin/lsblk", "/bin/lsblk"}

const (
	storageProbeTimeout = 20 * time.Second
	storageProbeMaxRead = 512 * 1024
)

// lsblkArgv is compile-time fixed. `--bytes` removes the human-readable
// suffixes, `--json` removes the column-alignment guesswork, and the column set
// is closed: nothing here asks for a label or a serial number.
var lsblkArgv = []string{
	"--json", "--bytes", "--paths",
	"-o", "NAME,KNAME,PKNAME,TYPE,SIZE,ROTA,RO,RM,FSTYPE,UUID,MOUNTPOINT,MODEL",
}

type lsblkDevice struct {
	Name       string        `json:"name"`
	KName      string        `json:"kname"`
	PKName     string        `json:"pkname"`
	Type       string        `json:"type"`
	Size       int64         `json:"size"`
	Rota       bool          `json:"rota"`
	RO         bool          `json:"ro"`
	RM         bool          `json:"rm"`
	FSType     string        `json:"fstype"`
	UUID       string        `json:"uuid"`
	MountPoint string        `json:"mountpoint"`
	Model      string        `json:"model"`
	Children   []lsblkDevice `json:"children"`
}

type lsblkOutput struct {
	BlockDevices []lsblkDevice `json:"blockdevices"`
}

// probeStorage collects the read-only block and filesystem inventory.
//
// Nothing here opens a device, reads a partition table, or runs a filesystem
// check. Every fact comes from lsblk's own enumeration and from statfs on paths
// that are already mounted.
func probeStorage(ctx context.Context, filesystems []snapshot.Filesystem, now time.Time) (snapshot.StorageState, error) {
	state := snapshot.StorageState{
		Devices:     []snapshot.BlockDevice{},
		Capacity:    []snapshot.FilesystemCapacity{},
		CollectedAt: now.UTC().Format(time.RFC3339),
	}

	binary := firstExisting(lsblkPaths)
	if binary == "" {
		state.UnsupportedReason = "lsblk is not present, so the block layer cannot be enumerated"
		return state, nil
	}
	raw, err := runBounded(ctx, storageProbeTimeout, storageProbeMaxRead, binary, lsblkArgv)
	if err != nil && len(raw) == 0 {
		// An empty device list would read as "this host has no disks".
		state.UnsupportedReason = "the block layer could not be enumerated: " + err.Error()
		return state, err
	}
	devices, ok := parseLsblk(raw)
	if !ok {
		state.UnsupportedReason = "lsblk returned output this agent could not parse"
		return state, nil
	}
	state.Supported = true
	state.Devices = devices
	state.Capacity = filesystemCapacity(filesystems, devices)
	return state, nil
}

// parseLsblk flattens the device tree into a bounded list.
func parseLsblk(raw []byte) ([]snapshot.BlockDevice, bool) {
	var parsed lsblkOutput
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, false
	}
	out := []snapshot.BlockDevice{}
	var walk func(entries []lsblkDevice, parent string, depth int)
	walk = func(entries []lsblkDevice, parent string, depth int) {
		// A device tree deeper than this is a loop device stack nobody is going
		// to act on, and recursion has to stop somewhere it can be reasoned about.
		if depth > 4 {
			return
		}
		for _, entry := range entries {
			if len(out) >= snapshot.MaxBlockDevices {
				return
			}
			name := bound(strings.TrimSpace(entry.Name), 128)
			if name == "" {
				name = bound(strings.TrimSpace(entry.KName), 128)
			}
			if name == "" {
				continue
			}
			// Loop and ram devices are neither operable nor interesting; they
			// would only push real disks past the bound.
			if entry.Type == "loop" || entry.Type == "rom" || strings.HasPrefix(name, "/dev/ram") {
				continue
			}
			device := snapshot.BlockDevice{
				Name:       name,
				Kind:       bound(entry.Type, 32),
				Parent:     bound(strings.TrimSpace(entry.PKName), 128),
				SizeBytes:  entry.Size,
				FSType:     bound(entry.FSType, 32),
				UUID:       bound(entry.UUID, 64),
				MountPoint: bound(entry.MountPoint, 255),
				ReadOnly:   entry.RO,
				Removable:  entry.RM,
				Rotational: entry.Rota,
				Model:      bound(strings.TrimSpace(entry.Model), 64),
			}
			if device.Parent == "" {
				device.Parent = parent
			}
			protectedDevice, _ := guard.ProtectedDevice(device.Name)
			protectedMount := false
			if device.MountPoint != "" {
				protectedMount, _ = guard.ProtectedMountPoint(device.MountPoint)
			}
			device.Protected = protectedDevice || protectedMount
			out = append(out, device)
			walk(entry.Children, device.Name, depth+1)
		}
	}
	walk(parsed.BlockDevices, "", 0)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, true
}

// filesystemCapacity reports, per mounted filesystem, whether it could be grown
// and by how much.
//
// The headroom is device size minus filesystem size. Where it is zero there is
// nothing to grow into, and the operation is refused before anything runs — the
// device has to have been enlarged underneath first, which is a deliberate act
// somebody else performs on the storage side.
func filesystemCapacity(filesystems []snapshot.Filesystem, devices []snapshot.BlockDevice) []snapshot.FilesystemCapacity {
	byName := map[string]snapshot.BlockDevice{}
	for _, device := range devices {
		byName[device.Name] = device
	}

	out := []snapshot.FilesystemCapacity{}
	for _, fs := range filesystems {
		if fs.MountPoint == "" || fs.Device == "" {
			continue
		}
		if !strings.HasPrefix(fs.Device, "/dev/") {
			// tmpfs, overlay, cgroup and friends have no block device to grow.
			continue
		}
		entry := snapshot.FilesystemCapacity{
			MountPoint: fs.MountPoint,
			Device:     fs.Device,
			FSType:     fs.FSType,
			SizeBytes:  fs.TotalBytes,
		}
		device, known := byName[fs.Device]
		if known {
			entry.DeviceBytes = device.SizeBytes
			if device.SizeBytes > fs.TotalBytes {
				entry.HeadroomBytes = device.SizeBytes - fs.TotalBytes
			}
		}

		protected, reason := guard.ProtectedMountPoint(fs.MountPoint)
		if !protected {
			protected, reason = guard.ProtectedDevice(fs.Device)
		}
		entry.Protected = protected

		switch {
		case protected:
			entry.Reason = "protected: " + reason
		case fs.ReadOnly:
			entry.Reason = "the filesystem is mounted read-only"
		case !guard.GrowableFSTypes[fs.FSType]:
			entry.Reason = "this agent grows ext4 and xfs only"
		case !known:
			entry.Reason = "the backing device was not found in the block inventory"
		case entry.HeadroomBytes <= 0:
			entry.Reason = "the block device is not larger than the filesystem, so there is nothing to grow into"
		default:
			entry.Growable = true
		}
		out = append(out, entry)
		if len(out) >= snapshot.MaxFilesystems {
			break
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].MountPoint < out[j].MountPoint })
	return out
}
