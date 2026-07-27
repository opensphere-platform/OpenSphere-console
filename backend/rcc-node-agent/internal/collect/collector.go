package collect

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"time"

	"opensphere.io/rcc/node-agent/internal/snapshot"
)

// FSUsage is the subset of statfs the snapshot needs.
type FSUsage struct {
	TotalBytes     int64
	UsedBytes      int64
	AvailableBytes int64
	InodesTotal    int64
	InodesUsed     int64
}

// Collector reads a bounded host snapshot. All external dependencies are
// injectable so the whole collection path is unit-testable off-Linux.
type Collector struct {
	ProcRoot        string
	EtcRoot         string
	ControlCenterID string
	HostID          string
	AgentVersion    string
	Architecture    string
	CollectSystemd  bool
	// Advisory: what this agent will accept, published for the console UI.
	OperationsEnabled bool
	RestartAllowlist  []string
	PackagesEnabled   bool
	PackageAllowlist  []string
	// Package and kernel inventory is the slowest collector, so it is separable
	// from the rest and can be turned off on a host where it is not wanted.
	CollectPackages bool

	// Stage 4 authorities, published for the console and re-checked by the
	// agent when a plan actually arrives.
	NetworkEnabled   bool
	NetworkAllowlist []string
	StorageEnabled   bool
	MountRoots       []string
	GrowAllowlist    []string
	OSImageEnabled   bool
	ImageAllowlist   []string
	SSHBanEnabled    bool
	SSHProtectedIPs  []string
	// Each Stage 4 inventory is separable for the same reason package inventory
	// is: reporting costs something on a busy host, and a host may legitimately
	// want to report one subsystem and not another.
	CollectNetworkState bool
	CollectStorage      bool
	CollectBoot         bool
	CollectSSHBan       bool

	Hostname func() (string, error)
	Statfs   func(path string) (FSUsage, error)
	Systemd  func(ctx context.Context) (snapshot.Systemd, error)
	Packages func(ctx context.Context, now time.Time) (snapshot.Packages, error)
	Kernel   func(ctx context.Context, packages snapshot.Packages, now time.Time) (snapshot.Kernel, error)
	Network  func(ctx context.Context, now time.Time) (snapshot.NetworkState, error)
	Storage  func(ctx context.Context, filesystems []snapshot.Filesystem, now time.Time) (snapshot.StorageState, error)
	Boot     func(ctx context.Context, osID string, now time.Time) (snapshot.BootState, error)
	SSHBan   func(ctx context.Context, now time.Time) (snapshot.SSHBanState, error)
	// SSHProtection inspects only the fixed RCC-owned Fail2ban profile. Keeping
	// it separate from the client probe lets tests exercise collection without
	// touching the host's /etc.
	SSHProtection func(protected []string) (profile, digest string, err error)
	Now           func() time.Time
}

// New returns a collector wired to the live host with platform defaults.
func New(controlCenterID, hostID, agentVersion string, collectSystemd bool) *Collector {
	return &Collector{
		ProcRoot:            "/proc",
		EtcRoot:             "/etc",
		ControlCenterID:     controlCenterID,
		HostID:              hostID,
		AgentVersion:        agentVersion,
		Architecture:        runtime.GOARCH,
		CollectSystemd:      collectSystemd,
		CollectPackages:     true,
		CollectNetworkState: true,
		CollectStorage:      true,
		CollectBoot:         true,
		CollectSSHBan:       true,
		Hostname:            os.Hostname,
		Statfs:              statfsUsage,
		Systemd:             probeSystemd,
		Packages:            probePackages,
		Kernel:              probeKernel,
		Network:             probeNetwork,
		Storage:             probeStorage,
		Boot:                probeBoot,
		SSHBan:              probeSSHBan,
		SSHProtection:       inspectSSHProtectionProfile,
		Now:                 time.Now,
	}
}

func (c *Collector) readFile(root, rel string) ([]byte, error) {
	// Bounded read: no procfs file the agent consumes is large, and an
	// unexpectedly huge file must not become an unbounded allocation.
	f, err := os.Open(filepath.Join(root, filepath.Clean("/"+rel)))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, 512*1024)
	n, err := f.Read(buf)
	if n > 0 {
		return buf[:n], nil
	}
	if err != nil {
		return nil, err
	}
	return buf[:0], nil
}

// Collect builds one snapshot. Individual collector failures degrade the
// snapshot instead of aborting it, so a partially broken host still reports.
func (c *Collector) Collect(ctx context.Context) snapshot.Snapshot {
	degraded := map[string]bool{}
	mark := func(key string) { degraded[key] = true }

	snap := snapshot.Snapshot{
		SchemaVersion:   snapshot.SchemaVersion,
		ControlCenterID: c.ControlCenterID,
		HostID:          c.HostID,
		AgentVersion:    c.AgentVersion,
		CollectedAt:     c.now().UTC().Format(time.RFC3339),
	}

	snap.Identity = c.identity(mark)
	snap.Resources = c.resources(mark)
	snap.Filesystems = c.filesystems(mark)
	snap.Network = c.network(mark)
	snap.Systemd = c.systemd(ctx, mark)
	snap.Packages, snap.Kernel = c.packagesAndKernel(ctx, mark)
	snap.NetworkState = c.networkState(ctx, mark)
	snap.Storage = c.storageState(ctx, snap.Filesystems, mark)
	snap.Boot = c.bootState(ctx, snap.Identity.OSID, mark)
	snap.SSHBan = c.sshBanState(ctx, mark)

	keys := make([]string, 0, len(degraded))
	for k := range degraded {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	snap.Operations = snapshot.Operations{
		Enabled:               c.OperationsEnabled,
		RestartAllowlist:      c.RestartAllowlist,
		PackagesEnabled:       c.PackagesEnabled,
		PackageAllowlist:      c.PackageAllowlist,
		NetworkEnabled:        c.NetworkEnabled,
		NetworkAllowlist:      c.NetworkAllowlist,
		StorageEnabled:        c.StorageEnabled,
		MountRoots:            c.MountRoots,
		GrowAllowlist:         c.GrowAllowlist,
		OSImageEnabled:        c.OSImageEnabled,
		ImageAllowlist:        c.ImageAllowlist,
		SSHBanEnabled:         c.SSHBanEnabled,
		SSHProtectedAddresses: c.SSHProtectedIPs,
	}
	snap.Degraded = keys
	snap.Normalize()
	return snap
}

// sshBanState reads the fixed Fail2ban sshd jail. A host without Fail2ban is
// simply unsupported; a host that has the client but whose jail cannot be read
// is degraded, because "no bans" and "we could not ask" are different facts.
func (c *Collector) sshBanState(ctx context.Context, mark func(string)) snapshot.SSHBanState {
	now := c.now()
	if !c.CollectSSHBan || c.SSHBan == nil {
		return snapshot.SSHBanState{
			Provider:          "fail2ban",
			Jail:              "sshd",
			UnsupportedReason: "SSH ban collection is disabled on this host",
			BannedAddresses:   []string{},
			CollectedAt:       now.UTC().Format(time.RFC3339),
		}
	}
	state, err := c.SSHBan(ctx, now)
	if err != nil {
		mark("sshBan")
	}
	if c.SSHProtection != nil {
		profile, digest, profileErr := c.SSHProtection(c.SSHProtectedIPs)
		state.ProtectionProfile = profile
		state.ProfileDigest = digest
		if profileErr != nil {
			mark("sshBan")
			if state.UnsupportedReason == "" {
				state.UnsupportedReason = profileErr.Error()
			}
		}
	}
	return state
}

// packagesAndKernel collects update and kernel state.
//
// A degraded probe reports the failure rather than an empty result: "no pending
// updates" and "we could not find out" look identical in a count, and only one
// of them means the host is patched.
func (c *Collector) packagesAndKernel(ctx context.Context, mark func(string)) (snapshot.Packages, snapshot.Kernel) {
	now := c.now()
	packages := snapshot.Packages{
		Manager:            snapshot.ManagerUnknown,
		MetadataAgeSeconds: -1,
		CollectedAt:        now.UTC().Format(time.RFC3339),
	}
	kernel := snapshot.Kernel{CollectedAt: now.UTC().Format(time.RFC3339)}

	if !c.CollectPackages {
		packages.UnsupportedReason = "package inventory is disabled on this agent"
		return packages, kernel
	}
	if c.Packages != nil {
		collected, err := c.Packages(ctx, now)
		if err != nil {
			mark("packages")
			collected.Supported = false
			if collected.UnsupportedReason == "" {
				collected.UnsupportedReason = "the package probe did not complete: " + err.Error()
			}
		}
		packages = collected
	}
	if c.Kernel != nil {
		collected, err := c.Kernel(ctx, packages, now)
		if err != nil {
			mark("kernel")
		}
		kernel = collected
	}
	return packages, kernel
}

// networkState collects the Stage 4 network inventory.
//
// A failed probe is marked degraded and reported unsupported. The alternative —
// an empty link list — reads as "this host has no interfaces", which is a claim
// no collector should ever make by accident.
func (c *Collector) networkState(ctx context.Context, mark func(string)) snapshot.NetworkState {
	now := c.now()
	state := snapshot.NetworkState{
		Manager:     snapshot.NetManagerUnknown,
		CollectedAt: now.UTC().Format(time.RFC3339),
	}
	if !c.CollectNetworkState || c.Network == nil {
		state.UnsupportedReason = "network inventory is disabled on this agent"
		return state
	}
	collected, err := c.Network(ctx, now)
	if err != nil {
		mark("network")
		collected.Supported = false
		if collected.UnsupportedReason == "" {
			collected.UnsupportedReason = "the network probe did not complete: " + err.Error()
		}
	}
	if collected.CollectedAt == "" {
		collected.CollectedAt = state.CollectedAt
	}
	return collected
}

func (c *Collector) storageState(ctx context.Context, filesystems []snapshot.Filesystem, mark func(string)) snapshot.StorageState {
	now := c.now()
	state := snapshot.StorageState{CollectedAt: now.UTC().Format(time.RFC3339)}
	if !c.CollectStorage || c.Storage == nil {
		state.UnsupportedReason = "storage inventory is disabled on this agent"
		return state
	}
	collected, err := c.Storage(ctx, filesystems, now)
	if err != nil {
		mark("storage")
		collected.Supported = false
		if collected.UnsupportedReason == "" {
			collected.UnsupportedReason = "the storage probe did not complete: " + err.Error()
		}
	}
	if collected.CollectedAt == "" {
		collected.CollectedAt = state.CollectedAt
	}
	return collected
}

func (c *Collector) bootState(ctx context.Context, osID string, mark func(string)) snapshot.BootState {
	now := c.now()
	state := snapshot.BootState{
		Model:       snapshot.BootModelUnknown,
		CollectedAt: now.UTC().Format(time.RFC3339),
	}
	if !c.CollectBoot || c.Boot == nil {
		state.UnsupportedReason = "boot model inventory is disabled on this agent"
		return state
	}
	collected, err := c.Boot(ctx, osID, now)
	if err != nil {
		mark("boot")
		collected.Supported = false
		if collected.UnsupportedReason == "" {
			collected.UnsupportedReason = "the boot model probe did not complete: " + err.Error()
		}
	}
	if collected.CollectedAt == "" {
		collected.CollectedAt = state.CollectedAt
	}
	return collected
}

func (c *Collector) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Collector) identity(mark func(string)) snapshot.Identity {
	id := snapshot.Identity{Architecture: c.Architecture}
	if c.Architecture == "" {
		id.Architecture = runtime.GOARCH
	}

	if c.Hostname != nil {
		if name, err := c.Hostname(); err == nil {
			id.Hostname = truncate(name, 253)
		} else {
			mark("hostname")
		}
	}
	if data, err := c.readFile(c.EtcRoot, "os-release"); err == nil {
		fields := parseOSRelease(data)
		id.OSName = fields["PRETTY_NAME"]
		id.OSID = fields["ID"]
		id.OSVersionID = fields["VERSION_ID"]
	} else {
		mark("osRelease")
	}
	if data, err := c.readFile(c.ProcRoot, "sys/kernel/osrelease"); err == nil {
		id.KernelVersion = truncate(string(data), 128)
	} else {
		// Not "kernel": that key is the kernel-update probe. Collapsing the two
		// leaves an operator unable to tell an unreadable version string from a
		// failed update check.
		mark("kernelVersion")
	}
	if data, err := c.readFile(c.EtcRoot, "machine-id"); err == nil {
		id.MachineIDHash = idHash(string(data))
	} else {
		mark("machineId")
	}
	if data, err := c.readFile(c.ProcRoot, "sys/kernel/random/boot_id"); err == nil {
		id.BootIDHash = idHash(string(data))
	} else {
		mark("bootId")
	}
	if data, err := c.readFile(c.ProcRoot, "uptime"); err == nil {
		id.UptimeSeconds = parseUptime(data)
	} else {
		mark("uptime")
	}
	return id
}

func (c *Collector) resources(mark func(string)) snapshot.Resources {
	res := snapshot.Resources{}
	if data, err := c.readFile(c.ProcRoot, "cpuinfo"); err == nil {
		res.CPUCount = parseCPUCount(data)
	} else {
		mark("cpuinfo")
	}
	if res.CPUCount == 0 {
		res.CPUCount = runtime.NumCPU()
	}
	if data, err := c.readFile(c.ProcRoot, "loadavg"); err == nil {
		load1, load5, load15, running, total := parseLoadAvg(data)
		res.Load1, res.Load5, res.Load15 = load1, load5, load15
		res.RunningProcesses, res.ProcessCount = running, total
	} else {
		mark("loadavg")
	}
	if data, err := c.readFile(c.ProcRoot, "meminfo"); err == nil {
		mem := parseMemInfo(data)
		res.MemTotalBytes = mem["MemTotal"]
		res.MemAvailableBytes = mem["MemAvailable"]
		res.MemFreeBytes = mem["MemFree"]
		res.SwapTotalBytes = mem["SwapTotal"]
		res.SwapFreeBytes = mem["SwapFree"]
	} else {
		mark("meminfo")
	}
	if data, err := c.readFile(c.ProcRoot, "stat"); err == nil {
		ctxt, running, blocked := parseProcStat(data)
		res.ContextSwitchCount = ctxt
		res.BlockedOnIOCount = blocked
		if res.RunningProcesses == 0 {
			res.RunningProcesses = running
		}
	} else {
		mark("procStat")
	}
	return res
}

// filesystems reports the host's mount table, not this process's own.
//
// The agent unit runs with ProtectSystem=strict, ProtectHome and PrivateTmp, so
// its private mount namespace shows the whole hierarchy remounted read-only and
// some mount points replaced. Reading /proc/self/mounts published that view as
// the host's: production reported a perfectly writable root filesystem as
// read-only. PID 1's table is the host's own, and is what an operator is asking
// about. Where it cannot be read, the local view is still reported — it is the
// only thing available — but the snapshot says so rather than passing it off.
func (c *Collector) filesystems(mark func(string)) []snapshot.Filesystem {
	data, err := c.readFile(c.ProcRoot, "1/mounts")
	if err != nil {
		data, err = c.readFile(c.ProcRoot, "self/mounts")
		if err != nil {
			mark("mounts")
			return nil
		}
		mark("mountNamespace")
	}
	entries, truncated := parseMounts(data)
	if truncated {
		mark("mountsTruncated")
	}
	// Usage is measured through this process's own view of the path, so it is
	// only trustworthy where that view still holds the same filesystem. Where
	// hardening has put something else there, the mount is reported without
	// usage rather than with another filesystem's numbers.
	local, localKnown := c.localMountTypes()
	out := make([]snapshot.Filesystem, 0, len(entries))
	for _, entry := range entries {
		fs := snapshot.Filesystem{
			Device:     entry.device,
			MountPoint: entry.mountPoint,
			FSType:     entry.fsType,
			ReadOnly:   entry.readOnly,
		}
		if c.Statfs != nil {
			if localKnown && local[entry.mountPoint] != entry.fsType {
				mark("filesystemUsage")
			} else if usage, statErr := c.Statfs(entry.mountPoint); statErr != nil {
				mark("filesystemUsage")
			} else {
				fs.TotalBytes = usage.TotalBytes
				fs.UsedBytes = usage.UsedBytes
				fs.AvailableBytes = usage.AvailableBytes
				fs.InodesTotal = usage.InodesTotal
				fs.InodesUsed = usage.InodesUsed
			}
		}
		out = append(out, fs)
	}
	return out
}

// localMountTypes maps mount point to filesystem type as this process sees it.
// The second return is false when that table could not be read at all, in which
// case usage is measured unconditionally rather than not at all.
func (c *Collector) localMountTypes() (map[string]string, bool) {
	data, err := c.readFile(c.ProcRoot, "self/mounts")
	if err != nil {
		return nil, false
	}
	entries, _ := parseMounts(data)
	types := make(map[string]string, len(entries))
	for _, entry := range entries {
		types[entry.mountPoint] = entry.fsType
	}
	return types, true
}

func (c *Collector) network(mark func(string)) []snapshot.NetworkInterface {
	data, err := c.readFile(c.ProcRoot, "net/dev")
	if err != nil {
		mark("netDev")
		return nil
	}
	interfaces, truncated := parseNetDev(data)
	if truncated {
		mark("netDevTruncated")
	}
	return interfaces
}

func (c *Collector) systemd(ctx context.Context, mark func(string)) snapshot.Systemd {
	if !c.CollectSystemd || c.Systemd == nil {
		return snapshot.Systemd{Available: false}
	}
	result, err := c.Systemd(ctx)
	if err != nil {
		mark("systemd")
		return snapshot.Systemd{Available: false}
	}
	return result
}
