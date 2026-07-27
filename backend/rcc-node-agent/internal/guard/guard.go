// Package guard holds the resource protections that both the read-only
// collectors and the executing adapters must agree on.
//
// It exists so there is exactly one answer to "may this platform touch that".
// If the collector's idea of a protected path and the executor's idea could
// drift, the console would eventually offer a control the agent refuses — or,
// far worse, present something as protected while the executor happily wrote to
// it. Everything here is a pure function over a path or a name, so it is
// testable without a host.
package guard

import (
	"path"
	"strings"
)

// protectedPrefixes are mount points this platform will never reconfigure,
// grow, unmount or mount over.
//
// The list is a union of four different reasons, kept together because the
// answer is the same for all of them:
//
//   - the system itself: losing / or /boot loses the machine
//   - the container runtime and the cluster: k3s, containerd, kubelet, etcd
//   - persistent data the platform is responsible for: RCC, Supabase, Gitea,
//     and anything a PersistentVolume is bound to
//   - the agent's own state, which is what makes exactly-once work
//
// A prefix match is used deliberately: /var/lib/rancher/k3s/storage holds PVC
// data, and enumerating every directory beneath it would be a list nobody could
// keep current.
var protectedPrefixes = []struct {
	prefix string
	reason string
}{
	{"/", "the root filesystem"},
	{"/boot", "the boot filesystem"},
	{"/usr", "the system filesystem"},
	{"/etc", "system configuration"},
	{"/var", "system state"},
	{"/var/lib/rancher", "k3s and its embedded storage"},
	{"/var/lib/kubelet", "kubelet state, including mounted volumes"},
	{"/var/lib/containerd", "the container runtime"},
	{"/var/lib/docker", "the container runtime"},
	{"/var/lib/etcd", "the cluster datastore"},
	{"/var/lib/rcc-node-agent", "this agent's own operation state"},
	{"/var/lib/postgresql", "the Supabase datastore"},
	{"/var/lib/gitea", "the Gitea datastore"},
	{"/var/lib/longhorn", "persistent volume data"},
	{"/var/lib/openebs", "persistent volume data"},
	{"/srv/gitea", "the Gitea datastore"},
	{"/opt/local-path-provisioner", "persistent volume data"},
	{"/proc", "a kernel filesystem"},
	{"/sys", "a kernel filesystem"},
	{"/dev", "a kernel filesystem"},
	{"/run", "volatile runtime state"},
}

// protectedDeviceMarkers are substrings in a device path that mean the device is
// backing something this platform must not touch, independently of where it
// happens to be mounted right now.
var protectedDeviceMarkers = []struct {
	marker string
	reason string
}{
	{"/dev/mapper/crypt", "an encrypted volume"},
	{"/dev/rbd", "a Ceph RADOS block device"},
	{"/dev/drbd", "a replicated block device"},
	{"/dev/longhorn", "a Longhorn volume"},
	{"/dev/zd", "a ZFS volume"},
}

// GrowableFSTypes are the filesystems this platform will grow.
//
// Both grow online and — the property that actually matters — neither can
// shrink online at all. That is what makes a grow-only operation structurally
// safe rather than merely carefully written: there is no argument to resize2fs
// or xfs_growfs that this agent could pass, correctly or by mistake, that makes
// a mounted filesystem smaller.
var GrowableFSTypes = map[string]bool{
	"ext4": true,
	"xfs":  true,
}

// MountableFSTypes are the filesystems a generated mount unit may declare.
var MountableFSTypes = map[string]bool{
	"ext4": true,
	"xfs":  true,
}

// Normalize cleans a path for comparison. A path that is not absolute after
// cleaning is rejected by the callers rather than repaired here.
func Normalize(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	cleaned := path.Clean(value)
	if cleaned != "/" {
		cleaned = strings.TrimRight(cleaned, "/")
	}
	return cleaned
}

// ProtectedMountPoint reports whether a mount point is off limits, and why.
//
// The reason is returned so a refusal can name the resource it protected rather
// than saying "denied", which tells an operator nothing about whether they made
// a mistake or hit a rule.
func ProtectedMountPoint(mountPoint string) (bool, string) {
	cleaned := Normalize(mountPoint)
	if cleaned == "" || !strings.HasPrefix(cleaned, "/") {
		return true, "the path is not absolute"
	}
	// Traversal cannot survive Clean, but a caller that skipped Normalize would
	// still be refused here rather than silently accepted.
	if strings.Contains(mountPoint, "..") {
		return true, "the path contains a traversal segment"
	}
	for _, entry := range protectedPrefixes {
		if cleaned == entry.prefix {
			return true, entry.reason
		}
		if entry.prefix != "/" && strings.HasPrefix(cleaned, entry.prefix+"/") {
			return true, entry.reason
		}
	}
	return false, ""
}

// ProtectedDevice reports whether a block device is off limits, and why.
func ProtectedDevice(device string) (bool, string) {
	cleaned := strings.TrimSpace(device)
	if cleaned == "" {
		return true, "the device is unnamed"
	}
	for _, entry := range protectedDeviceMarkers {
		if strings.HasPrefix(cleaned, entry.marker) {
			return true, entry.reason
		}
	}
	return false, ""
}

// UnderRoot reports whether a candidate path sits beneath an allowed root.
//
// The root itself is deliberately not a valid target: mounting directly onto
// /srv would hide whatever is already there, which is the kind of surprise a
// mount operation should never produce.
func UnderRoot(candidate, root string) bool {
	c := Normalize(candidate)
	r := Normalize(root)
	if c == "" || r == "" || c == r {
		return false
	}
	return strings.HasPrefix(c, r+"/")
}
