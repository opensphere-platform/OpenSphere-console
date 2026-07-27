package collect

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"opensphere.io/rcc/node-agent/internal/snapshot"
)

// ── network parsing ─────────────────────────────────────────────────────────

const ipAddrJSON = `[
 {"ifindex":1,"ifname":"lo","mtu":65536,"operstate":"UNKNOWN","link_type":"loopback",
  "addr_info":[{"family":"inet","local":"127.0.0.1","prefixlen":8,"scope":"host"}]},
 {"ifindex":2,"ifname":"eth0","mtu":1500,"operstate":"UP","link_type":"ether",
  "addr_info":[
    {"family":"inet","local":"10.0.0.5","prefixlen":24,"scope":"global"},
    {"family":"inet6","local":"fe80::1","prefixlen":64,"scope":"link"}]},
 {"ifindex":3,"ifname":"br0","mtu":9000,"operstate":"DOWN","link_type":"ether",
  "linkinfo":{"info_kind":"bridge"},"addr_info":[]}
]`

func TestParseIPAddrKeepsWhatMattersAndDropsWhatDoesNot(t *testing.T) {
	links := parseIPAddr([]byte(ipAddrJSON))
	if len(links) != 3 {
		t.Fatalf("expected three links, got %d", len(links))
	}
	byName := map[string]snapshot.NetworkLink{}
	for _, link := range links {
		byName[link.Name] = link
	}

	eth0 := byName["eth0"]
	if eth0.State != "up" || eth0.MTU != 1500 {
		t.Errorf("eth0 = %+v", eth0)
	}
	if len(eth0.Addresses) != 1 || eth0.Addresses[0] != "10.0.0.5/24" {
		// A link-local address is noise for an operator deciding what to change
		// and there can be many of them.
		t.Errorf("eth0 addresses = %v, want only the global one", eth0.Addresses)
	}
	if byName["br0"].Type != "bridge" {
		t.Errorf("br0 type = %q, want the linkinfo kind rather than the link type", byName["br0"].Type)
	}
	if byName["lo"].State != "unknown" {
		t.Errorf("lo state = %q", byName["lo"].State)
	}
}

func TestParseIPAddrSurvivesGarbage(t *testing.T) {
	for _, raw := range []string{"", "not json", "{}", "[null]", `[{"ifname":""}]`} {
		if links := parseIPAddr([]byte(raw)); links == nil {
			t.Errorf("%q produced a nil slice; the shape must be stable", raw)
		}
	}
}

func TestDefaultRoutePicksTheLowestMetric(t *testing.T) {
	raw := `[
	 {"dst":"default","gateway":"10.0.0.1","dev":"eth0","metric":100},
	 {"dst":"default","gateway":"10.9.0.1","dev":"eth9","metric":600},
	 {"dst":"10.2.0.0/16","gateway":"10.0.0.2","dev":"eth1","metric":1}
	]`
	route := parseIPDefaultRoute([]byte(raw))
	if !route.Present || route.Interface != "eth0" || route.Gateway != "10.0.0.1" {
		t.Fatalf("route = %+v, want the lowest-metric default", route)
	}
	if empty := parseIPDefaultRoute([]byte(`[]`)); empty.Present {
		t.Error("no default route must be reported as absent, not invented")
	}
	if broken := parseIPDefaultRoute([]byte(`nonsense`)); broken.Present {
		t.Error("unparseable output must not produce a route")
	}
}

func TestNmcliTerseSplitRespectsEscapedColons(t *testing.T) {
	// A naive Split would shift every field after a profile name containing a
	// colon, silently attributing one link's settings to another.
	rows := parseNmcliTerse([]byte("eth0:ethernet:connected:Wired\\: office\n"+
		"eth1:ethernet:unmanaged:\n"), 4)
	if len(rows) != 2 {
		t.Fatalf("expected two rows, got %d: %v", len(rows), rows)
	}
	if rows[0][3] != "Wired: office" {
		t.Errorf("connection = %q, want the unescaped name", rows[0][3])
	}
	if rows[1][2] != "unmanaged" || rows[1][3] != "" {
		t.Errorf("row = %v", rows[1])
	}
}

func TestBoundListAppliesBothBounds(t *testing.T) {
	list := boundList("10.0.0.1/24, 10.0.0.2/24 ,--, ,10.0.0.3/24,10.0.0.4/24,10.0.0.5/24", 3, 64)
	if len(list) != 3 {
		t.Fatalf("expected the entry bound to apply, got %v", list)
	}
	for _, entry := range list {
		if strings.TrimSpace(entry) != entry || entry == "--" {
			t.Errorf("entry %q was not cleaned", entry)
		}
	}
}

// ── storage parsing ─────────────────────────────────────────────────────────

const lsblkJSON = `{"blockdevices":[
 {"name":"/dev/sda","kname":"/dev/sda","type":"disk","size":500107862016,"rota":false,"ro":false,"rm":false,
  "model":"Samsung SSD","children":[
    {"name":"/dev/sda1","pkname":"/dev/sda","type":"part","size":1073741824,"fstype":"ext4",
     "uuid":"11111111-1111-1111-1111-111111111111","mountpoint":"/boot"},
    {"name":"/dev/sda2","pkname":"/dev/sda","type":"part","size":498960000000,"fstype":"ext4",
     "uuid":"22222222-2222-2222-2222-222222222222","mountpoint":"/"}]},
 {"name":"/dev/sdb","kname":"/dev/sdb","type":"disk","size":1099511627776,"rota":true,"children":[
    {"name":"/dev/sdb1","pkname":"/dev/sdb","type":"part","size":1099511000000,"fstype":"ext4",
     "uuid":"33333333-3333-3333-3333-333333333333","mountpoint":"/srv/data"}]},
 {"name":"/dev/loop0","type":"loop","size":100}
]}`

func TestParseLsblkFlattensAndMarksProtection(t *testing.T) {
	devices, ok := parseLsblk([]byte(lsblkJSON))
	if !ok {
		t.Fatal("well-formed lsblk output must parse")
	}
	byName := map[string]snapshot.BlockDevice{}
	for _, device := range devices {
		byName[device.Name] = device
	}
	if _, present := byName["/dev/loop0"]; present {
		t.Error("loop devices are neither operable nor interesting and must not consume the bound")
	}
	if !byName["/dev/sda1"].Protected || !byName["/dev/sda2"].Protected {
		t.Error("/boot and / must be marked protected")
	}
	if byName["/dev/sdb1"].Protected {
		t.Error("/srv/data is an ordinary data mount and must be operable")
	}
	if byName["/dev/sdb1"].Parent != "/dev/sdb" {
		t.Errorf("parent = %q", byName["/dev/sdb1"].Parent)
	}
	if !byName["/dev/sdb"].Rotational || byName["/dev/sda"].Rotational {
		t.Error("rotational media must be reported as found")
	}
}

func TestParseLsblkRefusesGarbageRatherThanReportingAnEmptyDisk(t *testing.T) {
	for _, raw := range []string{"", "not json", "[]"} {
		if _, ok := parseLsblk([]byte(raw)); ok {
			t.Errorf("%q must not parse as a valid device tree", raw)
		}
	}
}

func TestFilesystemCapacityExplainsWhyItCannotGrow(t *testing.T) {
	devices := []snapshot.BlockDevice{
		{Name: "/dev/sdb1", SizeBytes: 200},
		{Name: "/dev/sdc1", SizeBytes: 100},
		{Name: "/dev/sda2", SizeBytes: 500},
	}
	filesystems := []snapshot.Filesystem{
		{Device: "/dev/sdb1", MountPoint: "/srv/data", FSType: "ext4", TotalBytes: 100},
		{Device: "/dev/sdc1", MountPoint: "/srv/full", FSType: "ext4", TotalBytes: 100},
		{Device: "/dev/sda2", MountPoint: "/", FSType: "ext4", TotalBytes: 100},
		{Device: "/dev/sdd1", MountPoint: "/srv/btrfs", FSType: "btrfs", TotalBytes: 100},
		{Device: "/dev/sde1", MountPoint: "/srv/ro", FSType: "ext4", TotalBytes: 100, ReadOnly: true},
		{Device: "tmpfs", MountPoint: "/run/user/1000", FSType: "tmpfs", TotalBytes: 100},
	}
	capacity := filesystemCapacity(filesystems, devices)

	byMount := map[string]snapshot.FilesystemCapacity{}
	for _, entry := range capacity {
		byMount[entry.MountPoint] = entry
	}
	if _, present := byMount["/run/user/1000"]; present {
		t.Error("a filesystem with no block device behind it has nothing to grow into")
	}
	if !byMount["/srv/data"].Growable || byMount["/srv/data"].HeadroomBytes != 100 {
		t.Errorf("/srv/data = %+v, want growable with 100 bytes of headroom", byMount["/srv/data"])
	}
	// Each refusal must carry its own reason: "cannot grow" has several very
	// different causes and only one of them is a mistake.
	for mount, want := range map[string]string{
		"/srv/full":  "nothing to grow into",
		"/":          "protected",
		"/srv/btrfs": "ext4 and xfs only",
		"/srv/ro":    "read-only",
	} {
		entry := byMount[mount]
		if entry.Growable {
			t.Errorf("%s must not be growable", mount)
		}
		if !strings.Contains(entry.Reason, want) {
			t.Errorf("%s reason = %q, want it to mention %q", mount, entry.Reason, want)
		}
	}
}

// ── boot model ──────────────────────────────────────────────────────────────

func TestUbuntuCoreIsDetectedAndExplicitlyNotDriven(t *testing.T) {
	state, err := probeBoot(context.Background(), "ubuntu-core", time.Now())
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if state.Model != snapshot.BootModelSnap {
		t.Fatalf("model = %q, want snap", state.Model)
	}
	if state.Supported {
		t.Error("snapd governs its own refresh; this agent must not claim to drive it")
	}
	if !strings.Contains(state.UnsupportedReason, "snapd") {
		t.Errorf("the reason must name snapd, got %q", state.UnsupportedReason)
	}
}

func TestAPackageManagedHostReportsMutableAndPointsAtTheRightOperations(t *testing.T) {
	// This is CC2. Reporting it as anything else would offer image operations
	// the host cannot perform.
	state, err := probeBoot(context.Background(), "ubuntu", time.Now())
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if state.Model != snapshot.BootModelMutable || state.Supported {
		t.Fatalf("state = %+v, want an unsupported mutable host", state)
	}
	if !strings.Contains(state.UnsupportedReason, "package.update") {
		t.Errorf("the reason must point at the operations that do work, got %q", state.UnsupportedReason)
	}
}

// ── collector wiring ────────────────────────────────────────────────────────

func stage4Collector(t *testing.T) *Collector {
	t.Helper()
	now := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	return &Collector{
		ProcRoot:            t.TempDir(),
		EtcRoot:             t.TempDir(),
		ControlCenterID:     "cc2",
		HostID:              "node-a",
		AgentVersion:        "test",
		CollectNetworkState: true,
		CollectStorage:      true,
		CollectBoot:         true,
		Now:                 func() time.Time { return now },
	}
}

func TestAFailedStage4ProbeDegradesRatherThanReportingNothing(t *testing.T) {
	// "We could not read it" and "there is nothing there" are the same empty
	// list and completely different facts.
	collector := stage4Collector(t)
	collector.Network = func(context.Context, time.Time) (snapshot.NetworkState, error) {
		return snapshot.NetworkState{}, errors.New("ip is missing")
	}
	collector.Storage = func(context.Context, []snapshot.Filesystem, time.Time) (snapshot.StorageState, error) {
		return snapshot.StorageState{}, errors.New("lsblk is missing")
	}
	collector.Boot = func(context.Context, string, time.Time) (snapshot.BootState, error) {
		return snapshot.BootState{}, errors.New("probe failed")
	}

	snap := collector.Collect(context.Background())
	degraded := strings.Join(snap.Degraded, ",")
	for _, key := range []string{"network", "storage", "boot"} {
		if !strings.Contains(degraded, key) {
			t.Errorf("a failed %s probe must be reported as degraded, got %v", key, snap.Degraded)
		}
	}
	if snap.NetworkState.Supported || snap.Storage.Supported || snap.Boot.Supported {
		t.Error("a failed probe must never look supported")
	}
	for _, reason := range []string{
		snap.NetworkState.UnsupportedReason,
		snap.Storage.UnsupportedReason,
		snap.Boot.UnsupportedReason,
	} {
		if reason == "" {
			t.Error("a failed probe must carry a reason")
		}
	}
}

func TestDisabledStage4InventorySaysSoRatherThanLookingEmpty(t *testing.T) {
	collector := stage4Collector(t)
	collector.CollectNetworkState = false
	collector.CollectStorage = false
	collector.CollectBoot = false

	snap := collector.Collect(context.Background())
	for name, reason := range map[string]string{
		"network": snap.NetworkState.UnsupportedReason,
		"storage": snap.Storage.UnsupportedReason,
		"boot":    snap.Boot.UnsupportedReason,
	} {
		if !strings.Contains(reason, "disabled") {
			t.Errorf("%s inventory that is switched off must say so, got %q", name, reason)
		}
	}
}

func TestUnsupportedSubsystemsAreNeverActionable(t *testing.T) {
	// Normalisation is the last line: whatever a collector or a hostile agent
	// claims, an unsupported subsystem presents no capability.
	snap := snapshot.Snapshot{
		Operations: snapshot.Operations{
			Enabled: true, NetworkEnabled: true, StorageEnabled: true, OSImageEnabled: true,
			NetworkAllowlist: []string{"lab"}, GrowAllowlist: []string{"/srv/data"},
			ImageAllowlist: []string{"registry/os@sha256:abc"},
		},
		NetworkState: snapshot.NetworkState{
			Supported: false,
			Links:     []snapshot.NetworkLink{{Name: "eth0"}},
		},
		Storage: snapshot.StorageState{
			Supported: false,
			Devices:   []snapshot.BlockDevice{{Name: "/dev/sdb1"}},
			Capacity:  []snapshot.FilesystemCapacity{{MountPoint: "/srv/data", Growable: true}},
		},
		Boot: snapshot.BootState{
			Supported: false, CanStage: true, CanRollback: true, RollbackAvailable: true,
			Staged:      &snapshot.Deployment{ID: "x"},
			Deployments: []snapshot.Deployment{{ID: "x"}},
		},
	}
	snap.Normalize()

	// Links stay: a systemd-networkd host is perfectly readable and simply not
	// changeable, and discarding its links would hide true information. What
	// must go is the authority.
	if snap.Operations.NetworkEnabled || len(snap.Operations.NetworkAllowlist) != 0 {
		t.Error("an unsupported network stack must present no authority")
	}
	if len(snap.NetworkState.Links) == 0 {
		t.Error("read-only link state must survive an unsupported network manager")
	}
	if snap.Operations.StorageEnabled || len(snap.Storage.Devices) != 0 || len(snap.Storage.Capacity) != 0 {
		t.Error("an unsupported block layer must present nothing")
	}
	if snap.Operations.OSImageEnabled || snap.Boot.CanStage || snap.Boot.CanRollback ||
		snap.Boot.RollbackAvailable || snap.Boot.Staged != nil || len(snap.Boot.Deployments) != 0 {
		t.Error("an unsupported boot model must present no image capability")
	}
}

func TestAProtectedFilesystemIsNeverPresentedAsGrowable(t *testing.T) {
	snap := snapshot.Snapshot{
		Storage: snapshot.StorageState{
			Supported: true,
			Capacity: []snapshot.FilesystemCapacity{
				{MountPoint: "/", Growable: true, Protected: true},
				{MountPoint: "/srv/data", Growable: true},
			},
		},
	}
	snap.Normalize()
	if snap.Storage.Capacity[0].Growable {
		t.Error("a protected filesystem must not be presented as growable")
	}
	if !snap.Storage.Capacity[1].Growable {
		t.Error("an ordinary filesystem must stay growable")
	}
}

func TestTheManagementLinkIsDerivedNotTrusted(t *testing.T) {
	// A link cannot claim not to carry the control path in order to become
	// reconfigurable.
	snap := snapshot.Snapshot{
		NetworkState: snapshot.NetworkState{
			Supported:    true,
			DefaultRoute: snapshot.DefaultRoute{Present: true, Interface: "eth0"},
			Links: []snapshot.NetworkLink{
				{Name: "eth0", CarriesRCC: false},
				{Name: "eth1", CarriesRCC: true},
			},
		},
	}
	snap.Normalize()
	if !snap.NetworkState.Links[0].CarriesRCC {
		t.Error("the link carrying the default route must be marked, whatever it claimed")
	}
	if snap.NetworkState.Links[1].CarriesRCC {
		t.Error("a link that does not carry the default route must not be marked")
	}
	if snap.NetworkState.ManagementLink != "eth0" {
		t.Errorf("managementLink = %q", snap.NetworkState.ManagementLink)
	}
}

func TestStage4AuthoritiesFollowTheOperationChannel(t *testing.T) {
	snap := snapshot.Snapshot{
		Operations: snapshot.Operations{
			Enabled: false, NetworkEnabled: true, StorageEnabled: true, OSImageEnabled: true,
		},
		NetworkState: snapshot.NetworkState{Supported: true},
		Storage:      snapshot.StorageState{Supported: true},
		Boot:         snapshot.BootState{Supported: true},
	}
	snap.Normalize()
	if snap.Operations.NetworkEnabled || snap.Operations.StorageEnabled || snap.Operations.OSImageEnabled {
		t.Error("a host not executing operations at all cannot be executing these")
	}
}

// ── nmcli's unset sentinel ──────────────────────────────────────────────────

func TestTheUnsetSentinelNeverReachesTheSnapshot(t *testing.T) {
	// nmcli prints `--` for a property that has no value. It is a display
	// convention, not a value, and it is the single most likely thing to appear
	// in a field the executor later compares against a real setting: a link with
	// no gateway is exactly the kind of link this platform is allowed to touch.
	// If `--` survives collection it becomes part of the pre-state bound into the
	// approved plan, and every execution of that plan is then refused for a
	// reason no operator can act on.
	rows := parseNmcliTerse([]byte("eth1:ethernet:connected:--\n"), 4)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if rows[0][3] != "" {
		t.Errorf("an unset connection = %q, want empty", rows[0][3])
	}

	detail := parseNmcliTerse([]byte("ipv4.gateway:--\nipv4.method:manual\n"), 2)
	if len(detail) != 2 {
		t.Fatalf("detail rows = %d, want 2", len(detail))
	}
	if detail[0][1] != "" {
		t.Errorf("an unset gateway = %q, want empty", detail[0][1])
	}
	if detail[1][1] != "manual" {
		t.Errorf("a set value must survive intact, got %q", detail[1][1])
	}
}

func TestASentinelInTheLastFieldIsStrippedToo(t *testing.T) {
	// The last requested field absorbs any remainder, which is a separate code
	// path from the fixed-position fields and would otherwise keep the sentinel.
	rows := parseNmcliTerse([]byte("a:b:c:--\n"), 2)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if rows[0][1] != "b:c:--" {
		t.Fatalf("remainder = %q, want the joined tail", rows[0][1])
	}
	bare := parseNmcliTerse([]byte("ipv4.gateway:--\n"), 2)
	if bare[0][1] != "" {
		t.Errorf("a sentinel that is the whole remainder = %q, want empty", bare[0][1])
	}
}

// ── probe output bounds ─────────────────────────────────────────────────────

func TestProbeOutputIsBoundedAsItArrivesNotAfterwards(t *testing.T) {
	// A buffer that is truncated after the child exits bounds what the collector
	// reports but not what it cost to hold, and the agent runs under a memory
	// limit a pathological child would reach first.
	buffer := newBoundedBuffer(16)
	chunk := make([]byte, 1024)
	for i := 0; i < 64; i++ {
		n, err := buffer.Write(chunk)
		if err != nil || n != len(chunk) {
			t.Fatalf("write must always report success so the child is drained: %d, %v", n, err)
		}
	}
	if buffer.Len() != 16 {
		t.Errorf("retained %d bytes, want the 16 byte bound", buffer.Len())
	}
	if cap(buffer.Bytes()) > 1024 {
		t.Errorf("capacity grew to %d; the bound must cap the allocation too", cap(buffer.Bytes()))
	}
}
