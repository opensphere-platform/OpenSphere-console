package guard

import "testing"

// The protections here are the single answer to "may this platform touch that".
// The collector uses them to report and the executor uses them to refuse, so a
// gap in either direction is a control the console offers and the agent denies —
// or, far worse, something presented as protected that is quietly writable.

func TestRootAndSystemPathsAreProtected(t *testing.T) {
	for _, path := range []string{
		"/", "/boot", "/boot/efi", "/usr", "/usr/local", "/etc", "/etc/systemd",
		"/var", "/var/log", "/proc", "/sys", "/dev", "/run",
	} {
		if protected, reason := ProtectedMountPoint(path); !protected {
			t.Errorf("%s must be protected", path)
		} else if reason == "" {
			t.Errorf("%s is protected but gives no reason; a refusal without one tells nobody anything", path)
		}
	}
}

func TestClusterAndPlatformDataIsProtected(t *testing.T) {
	// Growing or mounting over any of these turns a storage change into an
	// outage or a data loss, so none of them is reachable by configuration.
	for _, path := range []string{
		"/var/lib/rancher", "/var/lib/rancher/k3s/storage/pvc-1234",
		"/var/lib/kubelet", "/var/lib/kubelet/pods/abc/volumes/x",
		"/var/lib/containerd", "/var/lib/docker", "/var/lib/etcd",
		"/var/lib/rcc-node-agent", "/var/lib/postgresql/data",
		"/var/lib/gitea", "/srv/gitea", "/var/lib/longhorn", "/opt/local-path-provisioner/pvc-9",
	} {
		if protected, _ := ProtectedMountPoint(path); !protected {
			t.Errorf("%s holds cluster or platform data and must be protected", path)
		}
	}
}

func TestOrdinaryDataPathsAreNotProtected(t *testing.T) {
	// The protections must not be so broad that nothing is operable; a rule
	// that refuses everything is indistinguishable from a feature nobody built.
	for _, path := range []string{"/srv/data", "/mnt/archive", "/data/scratch", "/srv/exports/one"} {
		if protected, reason := ProtectedMountPoint(path); protected {
			t.Errorf("%s should be operable, refused as %q", path, reason)
		}
	}
}

func TestTraversalAndRelativePathsAreRefused(t *testing.T) {
	for _, path := range []string{
		"", "srv/data", "./srv", "../etc", "/srv/../etc", "/srv/data/../../etc/shadow",
	} {
		if protected, _ := ProtectedMountPoint(path); !protected {
			t.Errorf("%q must be refused", path)
		}
	}
}

func TestPrefixMatchDoesNotCatchNeighbours(t *testing.T) {
	// /vary is not beneath /var, and refusing it would be a bug that reads as
	// caution. The check is on path segments, not on string prefixes.
	for _, path := range []string{"/vary", "/etcher", "/usrlocal", "/bootstrap", "/srv-backup/data"} {
		if protected, reason := ProtectedMountPoint(path); protected {
			t.Errorf("%s is not beneath a protected path, refused as %q", path, reason)
		}
	}
}

func TestProtectedDevices(t *testing.T) {
	for _, device := range []string{
		"/dev/mapper/crypt-root", "/dev/rbd0", "/dev/drbd1", "/dev/longhorn/pvc-1", "/dev/zd0", "",
	} {
		if protected, _ := ProtectedDevice(device); !protected {
			t.Errorf("%q must be protected", device)
		}
	}
	for _, device := range []string{"/dev/sdb1", "/dev/nvme0n1p2", "/dev/mapper/vg-data"} {
		if protected, reason := ProtectedDevice(device); protected {
			t.Errorf("%s should be operable, refused as %q", device, reason)
		}
	}
}

func TestUnderRootRefusesTheRootItself(t *testing.T) {
	// Mounting directly onto /srv would hide whatever is already there, which
	// is the kind of surprise a mount operation must never produce.
	if UnderRoot("/srv", "/srv") {
		t.Error("a root is never a valid target beneath itself")
	}
	if UnderRoot("/srv/", "/srv") {
		t.Error("a trailing slash must not turn a root into a valid target")
	}
	if !UnderRoot("/srv/data", "/srv") {
		t.Error("/srv/data is beneath /srv")
	}
	if !UnderRoot("/srv/a/b/c", "/srv") {
		t.Error("nesting is still beneath the root")
	}
	if UnderRoot("/srv-other/data", "/srv") {
		t.Error("/srv-other is not beneath /srv")
	}
	if UnderRoot("/data", "") || UnderRoot("", "/srv") {
		t.Error("an empty side is never a match")
	}
}

func TestGrowableTypesAreOnlyThoseThatCannotShrinkOnline(t *testing.T) {
	// This is the property the whole grow-only design rests on. Adding a
	// filesystem here that can shrink online would silently make the operation
	// destructive without any other line of code changing.
	for _, fsType := range []string{"ext4", "xfs"} {
		if !GrowableFSTypes[fsType] {
			t.Errorf("%s must be growable", fsType)
		}
	}
	for _, fsType := range []string{"btrfs", "ext2", "ext3", "zfs", "ntfs", "vfat", "tmpfs", ""} {
		if GrowableFSTypes[fsType] {
			t.Errorf("%s must not be growable by this agent", fsType)
		}
	}
}

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		"/srv/data/":    "/srv/data",
		"/srv//data":    "/srv/data",
		"  /srv/data  ": "/srv/data",
		"/":             "/",
		"":              "",
	}
	for input, want := range cases {
		if got := Normalize(input); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", input, got, want)
		}
	}
}
