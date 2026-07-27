// Package collect turns Linux procfs/sysfs content into a bounded snapshot.
//
// Every parser here is pure: it takes bytes and returns typed values, so the
// collectors stay testable on any developer platform.
package collect

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	"opensphere.io/rcc/node-agent/internal/snapshot"
)

// fsTypeAllowlist bounds filesystem cardinality and keeps container/secret
// bind mounts (unbounded, sensitive paths) out of the snapshot entirely.
var fsTypeAllowlist = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true,
	"xfs": true, "btrfs": true, "zfs": true,
	"f2fs": true, "jfs": true, "reiserfs": true,
	"vfat": true, "exfat": true,
}

// ifacePrefixDenylist removes per-pod virtual interfaces whose names are
// unbounded on a Kubernetes node.
var ifacePrefixDenylist = []string{
	"veth", "cali", "cni", "docker", "flannel", "lxc", "tap", "tun",
	"nodelocaldns", "kube-ipvs", "dummy", "virbr", "vxlan", "wg",
}

// idHash returns a short, stable, non-reversible identifier fingerprint.
// Raw machine-id and boot_id are host secrets and never leave the node.
func idHash(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(trimmed))
	return "sha256:" + hex.EncodeToString(sum[:])[:16]
}

func parseInt(s string) int64 {
	v, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0
	}
	return v
}

func parseFloat(s string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return v
}

// parseOSRelease reads the freedesktop os-release key=value format.
func parseOSRelease(data []byte) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		out[strings.TrimSpace(key)] = truncate(value, 128)
	}
	return out
}

// parseUptime reads /proc/uptime and returns whole seconds since boot.
func parseUptime(data []byte) int64 {
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0
	}
	return int64(parseFloat(fields[0]))
}

// parseLoadAvg reads /proc/loadavg: load1 load5 load15 running/total lastpid.
func parseLoadAvg(data []byte) (load1, load5, load15 float64, running, total int) {
	fields := strings.Fields(string(data))
	if len(fields) >= 3 {
		load1 = parseFloat(fields[0])
		load5 = parseFloat(fields[1])
		load15 = parseFloat(fields[2])
	}
	if len(fields) >= 4 {
		if r, t, found := strings.Cut(fields[3], "/"); found {
			running = int(parseInt(r))
			total = int(parseInt(t))
		}
	}
	return
}

// parseMemInfo reads /proc/meminfo kB entries into bytes.
func parseMemInfo(data []byte) map[string]int64 {
	out := map[string]int64{}
	for _, line := range strings.Split(string(data), "\n") {
		key, rest, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		value := parseInt(fields[0])
		if len(fields) > 1 && strings.EqualFold(fields[1], "kB") {
			value *= 1024
		}
		out[strings.TrimSpace(key)] = value
	}
	return out
}

// parseCPUCount counts logical processors in /proc/cpuinfo.
func parseCPUCount(data []byte) int {
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "processor") && strings.Contains(line, ":") {
			count++
		}
	}
	return count
}

// parseProcStat extracts scheduler counters from /proc/stat.
func parseProcStat(data []byte) (contextSwitches int64, running int, blocked int) {
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "ctxt":
			contextSwitches = parseInt(fields[1])
		case "procs_running":
			running = int(parseInt(fields[1]))
		case "procs_blocked":
			blocked = int(parseInt(fields[1]))
		}
	}
	return
}

type mountEntry struct {
	device     string
	mountPoint string
	fsType     string
	readOnly   bool
}

// parseMounts reads a procfs mount table, keeping only allowlisted real
// filesystems.
//
// Where a mount point appears more than once the LAST entry wins, because that
// is the one the kernel resolves: a later mount over the same directory hides
// the earlier one entirely. Keeping the first meant reporting the filesystem
// that had been covered up — its type, its device and its read-only flag — for
// a path nothing can reach any more.
//
// The second return reports that the bound cut the list short, so a host with
// more filesystems than fit is not published as a complete list. Entries are
// held in first-appearance order so the report is stable across collections.
//
// The scan continues past the bound rather than stopping at it: an over-mount
// of a mount point already held can appear on any later line, and stopping
// early would silently pin the stale one. Only the slice and the index grow,
// and both stop growing at MaxFilesystems, so the work is bounded by the input
// the caller already read under its own 512 KiB cap.
func parseMounts(data []byte) ([]mountEntry, bool) {
	at := make(map[string]int, snapshot.MaxFilesystems)
	out := []mountEntry{}
	truncated := false
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		fsType := fields[2]
		if !fsTypeAllowlist[fsType] {
			continue
		}
		mountPoint := unescapeMount(fields[1])
		position, held := at[mountPoint]
		// Tested before a new entry is admitted, so a table holding exactly
		// MaxFilesystems mount points is a complete list rather than one
		// reported as cut short. An over-mount of a point already held costs
		// no slot and is applied whether or not the bound has been reached.
		if !held && len(out) >= snapshot.MaxFilesystems {
			truncated = true
			continue
		}
		readOnly := false
		for _, opt := range strings.Split(fields[3], ",") {
			if opt == "ro" {
				readOnly = true
				break
			}
		}
		entry := mountEntry{
			device:     truncate(unescapeMount(fields[0]), 128),
			mountPoint: truncate(mountPoint, 128),
			fsType:     truncate(fsType, 32),
			readOnly:   readOnly,
		}
		if held {
			out[position] = entry
			continue
		}
		at[mountPoint] = len(out)
		out = append(out, entry)
	}
	return out, truncated
}

// unescapeMount decodes the octal escapes procfs uses for spaces and tabs.
func unescapeMount(value string) string {
	if !strings.Contains(value, `\`) {
		return value
	}
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '\\' && i+3 < len(value) {
			if code, err := strconv.ParseUint(value[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(code))
				i += 3
				continue
			}
		}
		b.WriteByte(value[i])
	}
	return b.String()
}

// parseNetDev reads /proc/net/dev, dropping per-pod virtual interfaces. The
// second return reports that the bound cut the list short, so a host with more
// interfaces than fit is not published as a complete list.
func parseNetDev(data []byte) ([]snapshot.NetworkInterface, bool) {
	out := []snapshot.NetworkInterface{}
	truncated := false
	for _, line := range strings.Split(string(data), "\n") {
		name, rest, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "" || name == "lo" || isDeniedInterface(name) {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 16 {
			continue
		}
		// Tested before the append, so a host with exactly MaxInterfaces
		// interfaces is a complete list rather than one reported as cut short.
		if len(out) >= snapshot.MaxInterfaces {
			truncated = true
			break
		}
		out = append(out, snapshot.NetworkInterface{
			Name:      truncate(name, 32),
			RxBytes:   parseInt(fields[0]),
			RxPackets: parseInt(fields[1]),
			RxErrors:  parseInt(fields[2]),
			RxDropped: parseInt(fields[3]),
			TxBytes:   parseInt(fields[8]),
			TxPackets: parseInt(fields[9]),
			TxErrors:  parseInt(fields[10]),
			TxDropped: parseInt(fields[11]),
		})
	}
	return out, truncated
}

func isDeniedInterface(name string) bool {
	for _, prefix := range ifacePrefixDenylist {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// parseFailedUnits reads `systemctl --failed --plain --no-legend` output.
//
// It returns at most MaxFailedUnits names but counts every failed unit present
// in the supplied bytes. Stopping the scan at the list bound would report a
// badly degraded host as having exactly MaxFailedUnits failures.
func parseFailedUnits(data []byte) (units []string, total int) {
	units = []string{}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		unit := fields[0]
		if !strings.Contains(unit, ".") || strings.HasPrefix(unit, "●") {
			continue
		}
		total++
		if len(units) < snapshot.MaxFailedUnits {
			units = append(units, truncate(unit, 96))
		}
	}
	return units, total
}

func truncate(value string, max int) string {
	value = strings.TrimSpace(value)
	// Control characters would corrupt logs and the operator UI.
	value = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, value)
	if len(value) > max {
		return value[:max]
	}
	return value
}
