package collect

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"opensphere.io/rcc/node-agent/internal/snapshot"
)

func writeFixture(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", full, err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", full, err)
	}
}

func fixtureCollector(t *testing.T) *Collector {
	t.Helper()
	procRoot := t.TempDir()
	etcRoot := t.TempDir()

	writeFixture(t, procRoot, "uptime", "864000.42 1700000.10\n")
	writeFixture(t, procRoot, "loadavg", "0.52 0.31 0.24 3/512 99887\n")
	writeFixture(t, procRoot, "meminfo", "MemTotal: 16303456 kB\nMemFree: 2103456 kB\nMemAvailable: 9123456 kB\nSwapTotal: 4194304 kB\nSwapFree: 4194304 kB\n")
	writeFixture(t, procRoot, "cpuinfo", "processor\t: 0\nmodel name\t: x\n\nprocessor\t: 1\nmodel name\t: x\n")
	writeFixture(t, procRoot, "stat", "cpu 1 2 3\nctxt 998877\nprocs_running 4\nprocs_blocked 1\n")
	// PID 1's table is the host's own. This process's table is what systemd
	// hardening leaves the agent: the same filesystems, remounted read-only.
	// The pair reproduces the production condition exactly.
	writeFixture(t, procRoot, "1/mounts", "/dev/mapper/rl-root / xfs rw,relatime 0 0\nproc /proc proc rw 0 0\n/dev/sda1 /boot ext4 ro,relatime 0 0\n")
	writeFixture(t, procRoot, "self/mounts", "/dev/mapper/rl-root / xfs ro,relatime 0 0\nproc /proc proc rw 0 0\n/dev/sda1 /boot ext4 ro,relatime 0 0\n")
	writeFixture(t, procRoot, "net/dev", "Inter-|\n face |\n  eth0: 123456 789 1 2 0 0 0 0 654321 987 3 4 0 0 0 0\nveth00: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n")
	writeFixture(t, procRoot, "sys/kernel/osrelease", "5.14.0-503.el9.x86_64\n")
	writeFixture(t, procRoot, "sys/kernel/random/boot_id", "0f9c8b7a-6d5e-4c3b-2a19-8f7e6d5c4b3a\n")
	writeFixture(t, etcRoot, "os-release", "PRETTY_NAME=\"Rocky Linux 9.5 (Blue Onyx)\"\nID=\"rocky\"\nVERSION_ID=\"9.5\"\n")
	writeFixture(t, etcRoot, "machine-id", "2f6c1b0e4d5a4f0b9c8d7e6f5a4b3c2d\n")

	fixedNow := time.Date(2026, 3, 26, 4, 5, 6, 0, time.UTC)
	return &Collector{
		ProcRoot:        procRoot,
		EtcRoot:         etcRoot,
		ControlCenterID: "cc2",
		HostID:          "node-a",
		AgentVersion:    "0.1.0",
		Architecture:    "amd64",
		CollectSystemd:  true,
		Hostname:        func() (string, error) { return "node-a.cc2.opl.io.kr", nil },
		Statfs: func(path string) (FSUsage, error) {
			return FSUsage{TotalBytes: 100 << 30, UsedBytes: 40 << 30, AvailableBytes: 60 << 30, InodesTotal: 1000, InodesUsed: 250}, nil
		},
		Systemd: func(context.Context) (snapshot.Systemd, error) {
			return snapshot.Systemd{Available: true, FailedUnitCount: 1, FailedUnits: []string{"chronyd.service"}}, nil
		},
		Now: func() time.Time { return fixedNow },
	}
}

func TestCollectBuildsCompleteSnapshot(t *testing.T) {
	snap := fixtureCollector(t).Collect(context.Background())

	if snap.SchemaVersion != snapshot.SchemaVersion {
		t.Fatalf("schemaVersion = %q", snap.SchemaVersion)
	}
	if snap.ControlCenterID != "cc2" || snap.HostID != "node-a" {
		t.Fatalf("binding lost: %q/%q", snap.ControlCenterID, snap.HostID)
	}
	if snap.CollectedAt != "2026-03-26T04:05:06Z" {
		t.Fatalf("collectedAt = %q", snap.CollectedAt)
	}
	if snap.Identity.Hostname != "node-a.cc2.opl.io.kr" {
		t.Fatalf("hostname = %q", snap.Identity.Hostname)
	}
	if snap.Identity.OSName != "Rocky Linux 9.5 (Blue Onyx)" || snap.Identity.OSID != "rocky" || snap.Identity.OSVersionID != "9.5" {
		t.Fatalf("os identity = %#v", snap.Identity)
	}
	if snap.Identity.KernelVersion != "5.14.0-503.el9.x86_64" || snap.Identity.Architecture != "amd64" {
		t.Fatalf("kernel identity = %#v", snap.Identity)
	}
	if snap.Identity.UptimeSeconds != 864000 {
		t.Fatalf("uptime = %d", snap.Identity.UptimeSeconds)
	}
	if !strings.HasPrefix(snap.Identity.MachineIDHash, "sha256:") || !strings.HasPrefix(snap.Identity.BootIDHash, "sha256:") {
		t.Fatalf("identity hashes missing: %#v", snap.Identity)
	}
	if snap.Resources.CPUCount != 2 || snap.Resources.Load1 != 0.52 {
		t.Fatalf("resources = %#v", snap.Resources)
	}
	if snap.Resources.MemTotalBytes != 16303456*1024 || snap.Resources.MemAvailableBytes != 9123456*1024 {
		t.Fatalf("memory = %#v", snap.Resources)
	}
	if snap.Resources.ContextSwitchCount != 998877 || snap.Resources.BlockedOnIOCount != 1 {
		t.Fatalf("proc stat = %#v", snap.Resources)
	}
	if len(snap.Filesystems) != 2 || snap.Filesystems[0].MountPoint != "/" {
		t.Fatalf("filesystems = %#v", snap.Filesystems)
	}
	if snap.Filesystems[0].UsedBytes != 40<<30 || snap.Filesystems[0].InodesUsed != 250 {
		t.Fatalf("filesystem usage = %#v", snap.Filesystems[0])
	}
	// The production defect this pins: the agent's own namespace has the root
	// filesystem remounted read-only by ProtectSystem=strict, and reporting that
	// told operators a writable root was read-only.
	if snap.Filesystems[0].ReadOnly {
		t.Fatalf("root reported read-only from the agent's own mount namespace: %#v", snap.Filesystems[0])
	}
	if !snap.Filesystems[1].ReadOnly {
		t.Fatalf("a genuinely read-only mount must still be reported as one: %#v", snap.Filesystems[1])
	}
	if len(snap.Network) != 1 || snap.Network[0].Name != "eth0" {
		t.Fatalf("network = %#v", snap.Network)
	}
	if !snap.Systemd.Available || snap.Systemd.FailedUnitCount != 1 {
		t.Fatalf("systemd = %#v", snap.Systemd)
	}
	if len(snap.Degraded) != 0 {
		t.Fatalf("healthy host reported degraded collectors: %v", snap.Degraded)
	}
}

func TestCollectDegradesInsteadOfFailing(t *testing.T) {
	c := fixtureCollector(t)
	if err := os.Remove(filepath.Join(c.ProcRoot, "meminfo")); err != nil {
		t.Fatalf("remove meminfo: %v", err)
	}
	if err := os.Remove(filepath.Join(c.EtcRoot, "os-release")); err != nil {
		t.Fatalf("remove os-release: %v", err)
	}
	c.Systemd = func(context.Context) (snapshot.Systemd, error) {
		return snapshot.Systemd{}, errors.New("probe timeout")
	}
	c.Statfs = func(string) (FSUsage, error) { return FSUsage{}, errors.New("statfs failed") }

	snap := c.Collect(context.Background())
	want := map[string]bool{"meminfo": true, "osRelease": true, "systemd": true, "filesystemUsage": true}
	got := map[string]bool{}
	for _, key := range snap.Degraded {
		got[key] = true
	}
	for key := range want {
		if !got[key] {
			t.Fatalf("expected degraded key %q in %v", key, snap.Degraded)
		}
	}
	if snap.Identity.Hostname == "" {
		t.Fatal("unaffected collectors must still populate")
	}
	if snap.Systemd.Available {
		t.Fatal("systemd must fail closed to unavailable")
	}
	if snap.Filesystems[0].TotalBytes != 0 {
		t.Fatal("failed statfs must not fabricate usage")
	}
}

// Where the host's own table cannot be read, the local view is all there is.
// Reporting it is fine; reporting it without saying so is what produced the
// production defect, so the snapshot has to carry the qualification.
func TestCollectMarksDegradedWhenOnlyTheLocalMountViewIsAvailable(t *testing.T) {
	c := fixtureCollector(t)
	if err := os.Remove(filepath.Join(c.ProcRoot, "1/mounts")); err != nil {
		t.Fatalf("remove host mount table: %v", err)
	}
	snap := c.Collect(context.Background())
	if !hasDegradedKey(snap.Degraded, "mountNamespace") {
		t.Fatalf("falling back to this process's mount view must be reported: %v", snap.Degraded)
	}
	if len(snap.Filesystems) != 2 {
		t.Fatalf("the fallback must still report filesystems: %#v", snap.Filesystems)
	}
	if !snap.Filesystems[0].ReadOnly {
		t.Fatal("the fallback reports what it can actually see, qualified by the degraded key")
	}
}

// When both tables are unreadable there is nothing to report, and the snapshot
// must say that rather than publishing an empty list as "no filesystems".
func TestCollectMarksMountsDegradedWhenNoTableIsReadable(t *testing.T) {
	c := fixtureCollector(t)
	os.Remove(filepath.Join(c.ProcRoot, "1/mounts"))
	os.Remove(filepath.Join(c.ProcRoot, "self/mounts"))
	snap := c.Collect(context.Background())
	if !hasDegradedKey(snap.Degraded, "mounts") {
		t.Fatalf("an unreadable mount table must be reported: %v", snap.Degraded)
	}
	if len(snap.Filesystems) != 0 {
		t.Fatalf("no table means no filesystems, not fabricated ones: %#v", snap.Filesystems)
	}
}

// ProtectHome and PrivateTmp replace a mount point with an empty filesystem.
// The host's table still names the real one, but statfs runs in this process's
// namespace, so measuring it would publish the overlay's numbers under the real
// filesystem's name.
func TestCollectDoesNotMeasureAMountPointHardeningHasReplaced(t *testing.T) {
	c := fixtureCollector(t)
	writeFixture(t, c.ProcRoot, "1/mounts",
		"/dev/mapper/rl-root / xfs rw,relatime 0 0\n/dev/sdb1 /home ext4 rw,relatime 0 0\n")
	writeFixture(t, c.ProcRoot, "self/mounts",
		"/dev/mapper/rl-root / xfs ro,relatime 0 0\ntmpfs /home vfat ro,relatime 0 0\n")

	snap := c.Collect(context.Background())
	if len(snap.Filesystems) != 2 {
		t.Fatalf("both host mounts must be listed: %#v", snap.Filesystems)
	}
	home := snap.Filesystems[1]
	if home.MountPoint != "/home" || home.FSType != "ext4" {
		t.Fatalf("the host's own view of the mount must be reported: %#v", home)
	}
	if home.TotalBytes != 0 || home.UsedBytes != 0 {
		t.Fatalf("an over-mounted path must not carry another filesystem's usage: %#v", home)
	}
	if !hasDegradedKey(snap.Degraded, "filesystemUsage") {
		t.Fatalf("an unmeasurable filesystem must be reported: %v", snap.Degraded)
	}
	if snap.Filesystems[0].TotalBytes == 0 {
		t.Fatal("a mount that is still the same filesystem must still be measured")
	}
}

// The bound on the degraded list has to sit above the number of things that can
// degrade. It did not: the keys are sorted before the cut, so the worst host in
// the fleet lost the same two keys every time, silently.
func TestCollectDegradedKeysSurviveATotalCollectionFailure(t *testing.T) {
	c := fixtureCollector(t)
	for _, rel := range []string{
		"uptime", "loadavg", "meminfo", "cpuinfo", "stat", "1/mounts", "self/mounts",
		"net/dev", "sys/kernel/osrelease", "sys/kernel/random/boot_id",
	} {
		os.Remove(filepath.Join(c.ProcRoot, rel))
	}
	os.Remove(filepath.Join(c.EtcRoot, "os-release"))
	os.Remove(filepath.Join(c.EtcRoot, "machine-id"))
	c.Hostname = func() (string, error) { return "", errors.New("hostname unavailable") }
	c.Systemd = func(context.Context) (snapshot.Systemd, error) {
		return snapshot.Systemd{}, errors.New("probe timeout")
	}
	// The optional inventories are what push the key count past the old bound,
	// so a host that has them enabled is the one that loses keys.
	failed := errors.New("probe timeout")
	c.CollectPackages, c.CollectNetworkState, c.CollectStorage, c.CollectBoot = true, true, true, true
	c.Packages = func(context.Context, time.Time) (snapshot.Packages, error) {
		return snapshot.Packages{}, failed
	}
	c.Kernel = func(context.Context, snapshot.Packages, time.Time) (snapshot.Kernel, error) {
		return snapshot.Kernel{}, failed
	}
	c.Network = func(context.Context, time.Time) (snapshot.NetworkState, error) {
		return snapshot.NetworkState{}, failed
	}
	c.Storage = func(context.Context, []snapshot.Filesystem, time.Time) (snapshot.StorageState, error) {
		return snapshot.StorageState{}, failed
	}
	c.Boot = func(context.Context, string, time.Time) (snapshot.BootState, error) {
		return snapshot.BootState{}, failed
	}

	snap := c.Collect(context.Background())
	if len(snap.Degraded) < 18 {
		t.Fatalf("the worst case must exercise the bound, got %d keys: %v", len(snap.Degraded), snap.Degraded)
	}
	if len(snap.Degraded) >= snapshot.MaxDegradedKeys {
		t.Fatalf("the degraded list reached its bound and is dropping keys: %v", snap.Degraded)
	}
	// These two sort last and were the two the old bound always discarded.
	for _, key := range []string{"systemd", "uptime"} {
		if !hasDegradedKey(snap.Degraded, key) {
			t.Fatalf("degraded key %q was dropped: %v", key, snap.Degraded)
		}
	}
	// An unreadable kernel version and a failed kernel-update probe are
	// different failures and must not share one key.
	if !hasDegradedKey(snap.Degraded, "kernelVersion") {
		t.Fatalf("the kernel version read failure must be named: %v", snap.Degraded)
	}
}

func TestCollectMarksInterfaceListTruncation(t *testing.T) {
	c := fixtureCollector(t)
	var b strings.Builder
	b.WriteString("Inter-|\n face |\n")
	for i := 0; i < snapshot.MaxInterfaces+4; i++ {
		b.WriteString("  eth")
		b.WriteString(strconv.Itoa(i))
		b.WriteString(": 1 2 0 0 0 0 0 0 3 4 0 0 0 0 0 0\n")
	}
	writeFixture(t, c.ProcRoot, "net/dev", b.String())

	snap := c.Collect(context.Background())
	if len(snap.Network) != snapshot.MaxInterfaces {
		t.Fatalf("interface bound not applied: %d", len(snap.Network))
	}
	if !hasDegradedKey(snap.Degraded, "netDevTruncated") {
		t.Fatalf("a truncated interface list must not read as a complete one: %v", snap.Degraded)
	}
}

func hasDegradedKey(keys []string, want string) bool {
	for _, key := range keys {
		if key == want {
			return true
		}
	}
	return false
}

func TestCollectDegradedKeysAreDeterministic(t *testing.T) {
	c := fixtureCollector(t)
	os.Remove(filepath.Join(c.ProcRoot, "meminfo"))
	os.Remove(filepath.Join(c.ProcRoot, "loadavg"))
	first := c.Collect(context.Background()).Degraded
	second := c.Collect(context.Background()).Degraded
	if strings.Join(first, ",") != strings.Join(second, ",") {
		t.Fatalf("degraded key order unstable: %v vs %v", first, second)
	}
}

func TestSnapshotJSONHasStableShapeAndNoSecrets(t *testing.T) {
	snap := fixtureCollector(t).Collect(context.Background())
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	body := string(raw)
	for _, forbidden := range []string{
		"2f6c1b0e4d5a4f0b9c8d7e6f5a4b3c2d",     // raw machine-id
		"0f9c8b7a-6d5e-4c3b-2a19-8f7e6d5c4b3a", // raw boot_id
		"secret", "token", "password", "Authorization",
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("snapshot leaked %q", forbidden)
		}
	}
	for _, required := range []string{`"filesystems":[`, `"network":[`, `"degraded":[`, `"failedUnits":[`} {
		if !strings.Contains(body, required) {
			t.Fatalf("snapshot missing stable array %s: %s", required, body)
		}
	}
}

func TestSnapshotNormalizeEnforcesBounds(t *testing.T) {
	snap := snapshot.Snapshot{}
	for i := 0; i < snapshot.MaxFilesystems+5; i++ {
		snap.Filesystems = append(snap.Filesystems, snapshot.Filesystem{MountPoint: "/m"})
	}
	for i := 0; i < snapshot.MaxInterfaces+5; i++ {
		snap.Network = append(snap.Network, snapshot.NetworkInterface{Name: "eth"})
	}
	for i := 0; i < snapshot.MaxFailedUnits+5; i++ {
		snap.Systemd.FailedUnits = append(snap.Systemd.FailedUnits, "u.service")
	}
	snap.Normalize()
	if len(snap.Filesystems) != snapshot.MaxFilesystems || len(snap.Network) != snapshot.MaxInterfaces {
		t.Fatalf("bounds not enforced: %d %d", len(snap.Filesystems), len(snap.Network))
	}
	if len(snap.Systemd.FailedUnits) != snapshot.MaxFailedUnits || !snap.Systemd.Truncated {
		t.Fatalf("failed unit truncation not flagged: %#v", snap.Systemd)
	}
	if snap.SchemaVersion != snapshot.SchemaVersion {
		t.Fatalf("schema version not stamped: %q", snap.SchemaVersion)
	}
}

func TestSystemdProbeArgvIsFixedAndReadOnly(t *testing.T) {
	joined := strings.Join(failedUnitsArgv, " ")
	if joined != "--failed --plain --no-legend --no-pager --full" {
		t.Fatalf("systemd probe argv drifted: %q", joined)
	}
	for _, arg := range failedUnitsArgv {
		if !strings.HasPrefix(arg, "--") {
			t.Fatalf("probe argv must contain only fixed flags, found %q", arg)
		}
	}
	for _, p := range systemctlPaths {
		if !strings.HasPrefix(p, "/") {
			t.Fatalf("systemctl path must be absolute: %q", p)
		}
	}
}
