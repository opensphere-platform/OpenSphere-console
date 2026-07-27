// Package snapshot defines the bounded, typed host snapshot wire format.
package snapshot

import "strings"

// SchemaVersion is validated by the backend ingestion endpoint.
const SchemaVersion = "rcc.host.snapshot/v1"

// Bounds keep snapshot cardinality fixed regardless of host shape.
const (
	MaxFilesystems = 32
	MaxInterfaces  = 16
	MaxFailedUnits = 25
	// One entry per distinct thing the collector can fail to read. The keys are
	// sorted before the bound is applied, so a bound below that count does not
	// drop an arbitrary key: it always drops the same alphabetically-last ones
	// (systemd, uptime), and only on the host that is most broken. Must stay at
	// or above the number of mark() sites in internal/collect, and equal to
	// MAX_DEGRADED_KEYS in backend/opensphere-console-backend/host-api.js.
	MaxDegradedKeys = 32
	// Bounds the advisory allowlist the agent publishes.
	MaxRestartAllowlist = 64
	// A host with thousands of pending updates must not produce a snapshot
	// proportional to its neglect. The counts stay exact; the list is bounded.
	MaxPendingPackages        = 100
	MaxRebootRequiredPackages = 32
	MaxPackageAllowlist       = 128
	// Stage 4 inventory bounds.
	MaxLinks            = 32
	MaxLinkAddresses    = 8
	MaxDNSServers       = 8
	MaxSearchDomains    = 8
	MaxBlockDevices     = 64
	MaxDeployments      = 8
	MaxNetworkAllowlist = 32
	MaxStorageAllowlist = 32
	MaxImageAllowlist   = 32
	// An sshd jail can accumulate a large number of bans during an attack.
	// Counts remain exact, while the page receives only a bounded enumeration.
	MaxSSHBanAddresses = 128
	MaxSSHProtectedIPs = 64
	MaxSSHBanEvents    = 100
)

// Identity carries stable host identification. Raw machine and boot IDs are
// never transmitted; only salted-free SHA-256 prefixes used for change detection.
type Identity struct {
	Hostname      string `json:"hostname"`
	OSName        string `json:"osName"`
	OSID          string `json:"osId"`
	OSVersionID   string `json:"osVersionId"`
	KernelVersion string `json:"kernelVersion"`
	Architecture  string `json:"architecture"`
	MachineIDHash string `json:"machineIdHash"`
	BootIDHash    string `json:"bootIdHash"`
	UptimeSeconds int64  `json:"uptimeSeconds"`
}

// Resources carries CPU and memory totals.
type Resources struct {
	CPUCount           int     `json:"cpuCount"`
	Load1              float64 `json:"load1"`
	Load5              float64 `json:"load5"`
	Load15             float64 `json:"load15"`
	MemTotalBytes      int64   `json:"memTotalBytes"`
	MemAvailableBytes  int64   `json:"memAvailableBytes"`
	MemFreeBytes       int64   `json:"memFreeBytes"`
	SwapTotalBytes     int64   `json:"swapTotalBytes"`
	SwapFreeBytes      int64   `json:"swapFreeBytes"`
	ProcessCount       int     `json:"processCount"`
	RunningProcesses   int     `json:"runningProcesses"`
	BlockedOnIOCount   int     `json:"blockedOnIoCount"`
	ContextSwitchCount int64   `json:"contextSwitchCount"`
}

// Filesystem is one mounted, block-backed filesystem.
type Filesystem struct {
	Device         string `json:"device"`
	MountPoint     string `json:"mountPoint"`
	FSType         string `json:"fsType"`
	ReadOnly       bool   `json:"readOnly"`
	TotalBytes     int64  `json:"totalBytes"`
	UsedBytes      int64  `json:"usedBytes"`
	AvailableBytes int64  `json:"availableBytes"`
	InodesTotal    int64  `json:"inodesTotal"`
	InodesUsed     int64  `json:"inodesUsed"`
}

// NetworkInterface is one physical or bond/bridge interface counter set.
type NetworkInterface struct {
	Name      string `json:"name"`
	RxBytes   int64  `json:"rxBytes"`
	TxBytes   int64  `json:"txBytes"`
	RxPackets int64  `json:"rxPackets"`
	TxPackets int64  `json:"txPackets"`
	RxErrors  int64  `json:"rxErrors"`
	TxErrors  int64  `json:"txErrors"`
	RxDropped int64  `json:"rxDropped"`
	TxDropped int64  `json:"txDropped"`
}

// Systemd summarises init state without exposing per-unit detail beyond failures.
type Systemd struct {
	Available       bool     `json:"available"`
	FailedUnitCount int      `json:"failedUnitCount"`
	FailedUnits     []string `json:"failedUnits"`
	Truncated       bool     `json:"truncated"`
}

// PackageManager names the manager this agent found. Anything other than a
// manager this build can actually drive is reported unsupported with a reason,
// never guessed at: operating an unknown package manager by analogy is how a
// maintenance action becomes an outage.
const (
	ManagerAPT     = "apt"
	ManagerDNF     = "dnf"
	ManagerZypper  = "zypper"
	ManagerPacman  = "pacman"
	ManagerUnknown = "unknown"
)

// PendingPackage is one upgradable package as the manager reports it.
type PendingPackage struct {
	Name             string `json:"name"`
	CurrentVersion   string `json:"currentVersion"`
	CandidateVersion string `json:"candidateVersion"`
	Security         bool   `json:"security"`
	Origin           string `json:"origin"`
}

// SecurityOrigin reports whether an apt origin string names a security suite.
//
// It lives here rather than in either caller because the collector decides what
// to report as a security update and the executor decides what a security-only
// update is allowed to install. Those two answers being different would mean an
// operator approved one thing and the host did another.
func SecurityOrigin(origin string) bool {
	return strings.Contains(strings.ToLower(origin), "security")
}

// Packages summarises update state without running anything that changes it.
//
// Every field here comes from a simulation or a file read. Nothing in this
// collector takes a package lock, downloads an index, or installs anything.
type Packages struct {
	Manager           string `json:"manager"`
	Supported         bool   `json:"supported"`
	UnsupportedReason string `json:"unsupportedReason"`
	// Seconds since the package index was last refreshed. -1 when unknown.
	// A pending-update count computed from a month-old index is not evidence,
	// so the age travels with the counts rather than being inferred later.
	MetadataAgeSeconds int64            `json:"metadataAgeSeconds"`
	PendingTotal       int              `json:"pendingTotal"`
	PendingSecurity    int              `json:"pendingSecurity"`
	Pending            []PendingPackage `json:"pending"`
	Truncated          bool             `json:"truncated"`
	CollectedAt        string           `json:"collectedAt"`
}

// Kernel describes what is running versus what is installed and available.
//
// `Running` and `InstalledLatest` differing is the definition of "a reboot
// would change the kernel". That is reported; it is never acted on here.
type Kernel struct {
	Running                string   `json:"running"`
	InstalledLatest        string   `json:"installedLatest"`
	Candidate              string   `json:"candidate"`
	UpdateAvailable        bool     `json:"updateAvailable"`
	RebootRequired         bool     `json:"rebootRequired"`
	RebootRequiredPackages []string `json:"rebootRequiredPackages"`
	CollectedAt            string   `json:"collectedAt"`
}

// Network managers this build knows about. Only NetworkManager can be driven;
// the others are named so the console can say "unsupported" rather than
// "unknown", which are different statements to an operator.
const (
	NetManagerNM        = "NetworkManager"
	NetManagerNetworkd  = "systemd-networkd"
	NetManagerNetplan   = "netplan"
	NetManagerUnknown   = "unknown"
	SupportedNetManager = NetManagerNM
)

// NetworkLink is one link as the kernel and the network manager describe it.
//
// No MAC address and no wireless credential is collected. A link's identity for
// the purposes of this platform is its name and its manager profile; the
// hardware address adds nothing an operator needs and is one more identifier
// leaving the host.
type NetworkLink struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	State string `json:"state"`
	MTU   int    `json:"mtu"`
	// Driver is read from sysfs where the kernel exposes it. It is a diagnosis
	// aid, never an input to anything the agent executes.
	Driver    string   `json:"driver"`
	Addresses []string `json:"addresses"`
	// Managed and Connection describe NetworkManager's view. A link NM does not
	// manage cannot be reconfigured by this platform at all.
	Managed    bool   `json:"managed"`
	Connection string `json:"connection"`
	Method     string `json:"method"`
	// StaticAddresses and Gateway are the profile's own ipv4 settings, which is
	// a different thing from the addresses currently on the link: a DHCP lease
	// appears in Addresses and not here. The distinction matters because these
	// are exactly the values the executor compares before it changes anything,
	// so a pre-state built from the kernel's view would never match.
	StaticAddresses []string `json:"staticAddresses"`
	Gateway         string   `json:"gateway"`
	CarriesRCC      bool     `json:"carriesRcc"`
	Truncated       bool     `json:"truncated"`
}

// DefaultRoute is the route the host uses to reach anything it has no more
// specific route for, including this control center.
type DefaultRoute struct {
	Present   bool   `json:"present"`
	Interface string `json:"interface"`
	Gateway   string `json:"gateway"`
	Metric    int    `json:"metric"`
}

// DNSState is resolver configuration. It carries no credential: resolv.conf has
// none, and no other resolver file is read.
type DNSState struct {
	Source  string   `json:"source"`
	Servers []string `json:"servers"`
	Search  []string `json:"search"`
}

// NetworkState is the Stage 4 read-only network inventory.
type NetworkState struct {
	Manager           string        `json:"manager"`
	Supported         bool          `json:"supported"`
	UnsupportedReason string        `json:"unsupportedReason"`
	Links             []NetworkLink `json:"links"`
	DefaultRoute      DefaultRoute  `json:"defaultRoute"`
	DNS               DNSState      `json:"dns"`
	// ManagementLink is the link the default route leaves by. It is the one
	// interface this platform will never reconfigure, so it is reported
	// explicitly rather than left for the console to infer.
	ManagementLink string `json:"managementLink"`
	Truncated      bool   `json:"truncated"`
	CollectedAt    string `json:"collectedAt"`
}

// BlockDevice is one entry from the block layer.
type BlockDevice struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Parent     string `json:"parent"`
	SizeBytes  int64  `json:"sizeBytes"`
	FSType     string `json:"fsType"`
	UUID       string `json:"uuid"`
	MountPoint string `json:"mountPoint"`
	ReadOnly   bool   `json:"readOnly"`
	Removable  bool   `json:"removable"`
	Rotational bool   `json:"rotational"`
	Model      string `json:"model"`
	// Protected marks a device this platform will never write to, whatever a
	// policy or an operator asks for.
	Protected bool `json:"protected"`
}

// FilesystemCapacity reports whether a mounted filesystem can be grown, and by
// how much, without moving a single byte of anyone's data.
type FilesystemCapacity struct {
	MountPoint string `json:"mountPoint"`
	Device     string `json:"device"`
	FSType     string `json:"fsType"`
	// Growable is a property of the filesystem type: ext4 and xfs grow online
	// and neither can shrink online at all, which is what makes a grow-only
	// operation structurally safe rather than merely carefully written.
	Growable    bool  `json:"growable"`
	Protected   bool  `json:"protected"`
	SizeBytes   int64 `json:"sizeBytes"`
	DeviceBytes int64 `json:"deviceBytes"`
	// HeadroomBytes is device size minus filesystem size. Zero means there is
	// nothing to grow into and the operation is refused before it starts.
	HeadroomBytes int64  `json:"headroomBytes"`
	Reason        string `json:"reason"`
}

// StorageState is the Stage 4 read-only storage inventory.
type StorageState struct {
	Supported         bool                 `json:"supported"`
	UnsupportedReason string               `json:"unsupportedReason"`
	Devices           []BlockDevice        `json:"devices"`
	Capacity          []FilesystemCapacity `json:"capacity"`
	Truncated         bool                 `json:"truncated"`
	CollectedAt       string               `json:"collectedAt"`
}

// Boot/update models. Anything that is not positively identified as an
// image-based system is reported as mutable, which is the truthful answer for a
// package-managed distribution such as the Ubuntu CC2 runs.
const (
	BootModelMutable   = "mutable"
	BootModelRPMOSTree = "rpm-ostree"
	BootModelBootc     = "bootc"
	BootModelSnap      = "snap"
	BootModelUnknown   = "unknown"
)

// Deployment is one bootable image the local adapter knows about.
type Deployment struct {
	ID       string `json:"id"`
	Version  string `json:"version"`
	Digest   string `json:"digest"`
	Origin   string `json:"origin"`
	Booted   bool   `json:"booted"`
	Staged   bool   `json:"staged"`
	Rollback bool   `json:"rollback"`
	Pinned   bool   `json:"pinned"`
}

// BootState describes how this host takes an operating system update.
//
// `Supported` means this agent can stage or roll back an image here. A mutable
// distribution is fully supported for reporting and entirely unsupported for
// image operations, and saying so is the point: a platform that quietly treated
// apt as an image system would be lying about what a rollback means.
type BootState struct {
	Model             string `json:"model"`
	Adapter           string `json:"adapter"`
	Supported         bool   `json:"supported"`
	UnsupportedReason string `json:"unsupportedReason"`
	// CanStage and CanRollback are probed from the installed adapter, not
	// assumed from the model. An adapter that is present but too old to expose
	// the subcommand is reported as unable, not attempted.
	CanStage          bool         `json:"canStage"`
	CanRollback       bool         `json:"canRollback"`
	RollbackAvailable bool         `json:"rollbackAvailable"`
	Booted            *Deployment  `json:"booted"`
	Staged            *Deployment  `json:"staged"`
	Deployments       []Deployment `json:"deployments"`
	CollectedAt       string       `json:"collectedAt"`
}

// SSHBanState is the read-only Fail2ban view for the fixed sshd jail.
//
// The provider and jail are constants rather than operator input. This keeps
// the feature about SSH access protection and prevents a console field from
// becoming an arbitrary Fail2ban command or jail name.
type SSHBanEvent struct {
	OccurredAt string `json:"occurredAt"`
	Action     string `json:"action"`
	Address    string `json:"address"`
}

type SSHBanState struct {
	Provider          string        `json:"provider"`
	Jail              string        `json:"jail"`
	Installed         bool          `json:"installed"`
	PackageVersion    string        `json:"packageVersion"`
	CandidateVersion  string        `json:"candidateVersion"`
	ProtectionProfile string        `json:"protectionProfile"`
	ProfileDigest     string        `json:"profileDigest"`
	Active            bool          `json:"active"`
	Supported         bool          `json:"supported"`
	UnsupportedReason string        `json:"unsupportedReason"`
	CurrentlyFailed   int           `json:"currentlyFailed"`
	TotalFailed       int           `json:"totalFailed"`
	CurrentlyBanned   int           `json:"currentlyBanned"`
	TotalBanned       int           `json:"totalBanned"`
	BannedAddresses   []string      `json:"bannedAddresses"`
	RecentEvents      []SSHBanEvent `json:"recentEvents"`
	// -1 means permanent, 0 means the value could not be read.
	BanTimeSeconds  int64  `json:"banTimeSeconds"`
	FindTimeSeconds int64  `json:"findTimeSeconds"`
	MaxRetry        int    `json:"maxRetry"`
	Truncated       bool   `json:"truncated"`
	CollectedAt     string `json:"collectedAt"`
}

// Operations declares what typed work this agent will accept. It is advisory
// for the console UI; the agent enforces the same allowlist itself when a plan
// actually arrives, so a stale or edited snapshot cannot widen it.
type Operations struct {
	Enabled          bool     `json:"enabled"`
	RestartAllowlist []string `json:"restartAllowlist"`
	// Packages this agent will consider updating. Like RestartAllowlist this is
	// advisory for the console; the agent re-checks it when a plan arrives.
	PackageAllowlist []string `json:"packageAllowlist"`
	// Whether this agent will accept package and kernel maintenance at all.
	PackagesEnabled bool `json:"packagesEnabled"`

	// Stage 4 authorities. Each is a separate opt-in, because each needs a
	// different widening of the systemd sandbox and none of them implies
	// another: a host that may grow a filesystem has no business reconfiguring
	// its network.
	NetworkEnabled   bool     `json:"networkEnabled"`
	NetworkAllowlist []string `json:"networkAllowlist"`
	StorageEnabled   bool     `json:"storageEnabled"`
	MountRoots       []string `json:"mountRoots"`
	GrowAllowlist    []string `json:"growAllowlist"`
	OSImageEnabled   bool     `json:"osImageEnabled"`
	ImageAllowlist   []string `json:"imageAllowlist"`

	// SSH ban management is a separate opt-in. Protected addresses are exact
	// IPs the agent will never ban, even if a valid plan names one. They are
	// advisory here and re-checked against the root-owned configuration at
	// execution time.
	SSHBanEnabled         bool     `json:"sshBanEnabled"`
	SSHProtectedAddresses []string `json:"sshProtectedAddresses"`
}

// Snapshot is the complete agent payload. Stage 1 is read-only: it carries no
// command, no credential and no free-form operator input.
type Snapshot struct {
	SchemaVersion   string             `json:"schemaVersion"`
	ControlCenterID string             `json:"controlCenterId"`
	HostID          string             `json:"hostId"`
	AgentVersion    string             `json:"agentVersion"`
	CollectedAt     string             `json:"collectedAt"`
	Identity        Identity           `json:"identity"`
	Resources       Resources          `json:"resources"`
	Filesystems     []Filesystem       `json:"filesystems"`
	Network         []NetworkInterface `json:"network"`
	Systemd         Systemd            `json:"systemd"`
	Packages        Packages           `json:"packages"`
	Kernel          Kernel             `json:"kernel"`
	NetworkState    NetworkState       `json:"networkState"`
	Storage         StorageState       `json:"storage"`
	Boot            BootState          `json:"boot"`
	SSHBan          SSHBanState        `json:"sshBan"`
	Operations      Operations         `json:"operations"`
	Degraded        []string           `json:"degraded"`
}

// Normalize enforces every declared bound and guarantees non-nil slices so the
// JSON payload shape is identical whether or not a collector degraded.
func (s *Snapshot) Normalize() {
	s.SchemaVersion = SchemaVersion
	if s.Filesystems == nil {
		s.Filesystems = []Filesystem{}
	}
	if len(s.Filesystems) > MaxFilesystems {
		s.Filesystems = s.Filesystems[:MaxFilesystems]
	}
	if s.Network == nil {
		s.Network = []NetworkInterface{}
	}
	if len(s.Network) > MaxInterfaces {
		s.Network = s.Network[:MaxInterfaces]
	}
	if s.Systemd.FailedUnits == nil {
		s.Systemd.FailedUnits = []string{}
	}
	if len(s.Systemd.FailedUnits) > MaxFailedUnits {
		s.Systemd.FailedUnits = s.Systemd.FailedUnits[:MaxFailedUnits]
		s.Systemd.Truncated = true
	}
	if s.Operations.RestartAllowlist == nil {
		s.Operations.RestartAllowlist = []string{}
	}
	if len(s.Operations.RestartAllowlist) > MaxRestartAllowlist {
		s.Operations.RestartAllowlist = s.Operations.RestartAllowlist[:MaxRestartAllowlist]
	}
	if s.Operations.PackageAllowlist == nil {
		s.Operations.PackageAllowlist = []string{}
	}
	if len(s.Operations.PackageAllowlist) > MaxPackageAllowlist {
		s.Operations.PackageAllowlist = s.Operations.PackageAllowlist[:MaxPackageAllowlist]
	}
	if s.Packages.Manager == "" {
		s.Packages.Manager = ManagerUnknown
	}
	if s.Packages.Pending == nil {
		s.Packages.Pending = []PendingPackage{}
	}
	if len(s.Packages.Pending) > MaxPendingPackages {
		// The counts stay exact; only the enumeration is cut, and the cut is
		// declared so nobody reads a short list as a complete one.
		s.Packages.Pending = s.Packages.Pending[:MaxPendingPackages]
		s.Packages.Truncated = true
	}
	if s.Packages.MetadataAgeSeconds < 0 {
		s.Packages.MetadataAgeSeconds = -1
	}
	if s.Kernel.RebootRequiredPackages == nil {
		s.Kernel.RebootRequiredPackages = []string{}
	}
	if len(s.Kernel.RebootRequiredPackages) > MaxRebootRequiredPackages {
		s.Kernel.RebootRequiredPackages = s.Kernel.RebootRequiredPackages[:MaxRebootRequiredPackages]
	}
	// An unsupported manager must never look actionable, whatever else was
	// collected or claimed.
	if !s.Packages.Supported {
		s.Packages.Pending = []PendingPackage{}
		s.Packages.PendingTotal = 0
		s.Packages.PendingSecurity = 0
		s.Packages.Truncated = false
		s.Operations.PackagesEnabled = false
	}
	s.normalizeStage4()
	s.normalizeSSHBan()
	if s.Degraded == nil {
		s.Degraded = []string{}
	}
	if len(s.Degraded) > MaxDegradedKeys {
		s.Degraded = s.Degraded[:MaxDegradedKeys]
	}
}

// normalizeSSHBan keeps an unavailable provider from looking actionable and
// bounds both the observed bans and the addresses protected by configuration.
func (s *Snapshot) normalizeSSHBan() {
	if s.SSHBan.Provider == "" {
		s.SSHBan.Provider = "fail2ban"
	}
	if s.SSHBan.Jail == "" {
		s.SSHBan.Jail = "sshd"
	}
	if s.SSHBan.BannedAddresses == nil {
		s.SSHBan.BannedAddresses = []string{}
	}
	if s.SSHBan.RecentEvents == nil {
		s.SSHBan.RecentEvents = []SSHBanEvent{}
	}
	if len(s.SSHBan.BannedAddresses) > MaxSSHBanAddresses {
		s.SSHBan.BannedAddresses = s.SSHBan.BannedAddresses[:MaxSSHBanAddresses]
		s.SSHBan.Truncated = true
	}
	if s.SSHBan.CurrentlyBanned < len(s.SSHBan.BannedAddresses) {
		s.SSHBan.CurrentlyBanned = len(s.SSHBan.BannedAddresses)
	}
	if s.SSHBan.CurrentlyBanned > len(s.SSHBan.BannedAddresses) {
		s.SSHBan.Truncated = true
	}
	if len(s.SSHBan.RecentEvents) > MaxSSHBanEvents {
		s.SSHBan.RecentEvents = s.SSHBan.RecentEvents[:MaxSSHBanEvents]
	}
	if s.Operations.SSHProtectedAddresses == nil {
		s.Operations.SSHProtectedAddresses = []string{}
	}
	if len(s.Operations.SSHProtectedAddresses) > MaxSSHProtectedIPs {
		s.Operations.SSHProtectedAddresses =
			s.Operations.SSHProtectedAddresses[:MaxSSHProtectedIPs]
	}
}

// normalizeStage4 bounds the network, storage and boot inventories and — more
// importantly — makes an unsupported subsystem look unsupported.
//
// The rule is the same one Stage 3 applies to packages: a subsystem the agent
// cannot drive must never present a capability, whatever the rest of the
// document claims. An operator reading "0 growable filesystems" and an operator
// reading "we could not enumerate the block layer" must not be looking at the
// same screen.
func (s *Snapshot) normalizeStage4() {
	if s.NetworkState.Manager == "" {
		s.NetworkState.Manager = NetManagerUnknown
	}
	if s.NetworkState.Links == nil {
		s.NetworkState.Links = []NetworkLink{}
	}
	if len(s.NetworkState.Links) > MaxLinks {
		s.NetworkState.Links = s.NetworkState.Links[:MaxLinks]
		s.NetworkState.Truncated = true
	}
	for i := range s.NetworkState.Links {
		link := &s.NetworkState.Links[i]
		if link.Addresses == nil {
			link.Addresses = []string{}
		}
		if len(link.Addresses) > MaxLinkAddresses {
			link.Addresses = link.Addresses[:MaxLinkAddresses]
			link.Truncated = true
		}
		if link.StaticAddresses == nil {
			link.StaticAddresses = []string{}
		}
		if len(link.StaticAddresses) > MaxLinkAddresses {
			link.StaticAddresses = link.StaticAddresses[:MaxLinkAddresses]
			link.Truncated = true
		}
		// The link the default route leaves by is the management link by
		// definition. Deriving it here rather than trusting a collector means a
		// link cannot claim not to carry the control path.
		link.CarriesRCC = s.NetworkState.DefaultRoute.Present &&
			link.Name != "" && link.Name == s.NetworkState.DefaultRoute.Interface
	}
	if s.NetworkState.DNS.Servers == nil {
		s.NetworkState.DNS.Servers = []string{}
	}
	if len(s.NetworkState.DNS.Servers) > MaxDNSServers {
		s.NetworkState.DNS.Servers = s.NetworkState.DNS.Servers[:MaxDNSServers]
	}
	if s.NetworkState.DNS.Search == nil {
		s.NetworkState.DNS.Search = []string{}
	}
	if len(s.NetworkState.DNS.Search) > MaxSearchDomains {
		s.NetworkState.DNS.Search = s.NetworkState.DNS.Search[:MaxSearchDomains]
	}
	if s.NetworkState.DefaultRoute.Present {
		s.NetworkState.ManagementLink = s.NetworkState.DefaultRoute.Interface
	} else {
		s.NetworkState.ManagementLink = ""
	}
	if !s.NetworkState.Supported {
		s.Operations.NetworkEnabled = false
		s.Operations.NetworkAllowlist = []string{}
	}
	if s.Operations.NetworkAllowlist == nil {
		s.Operations.NetworkAllowlist = []string{}
	}
	if len(s.Operations.NetworkAllowlist) > MaxNetworkAllowlist {
		s.Operations.NetworkAllowlist = s.Operations.NetworkAllowlist[:MaxNetworkAllowlist]
	}

	if s.Storage.Devices == nil {
		s.Storage.Devices = []BlockDevice{}
	}
	if len(s.Storage.Devices) > MaxBlockDevices {
		s.Storage.Devices = s.Storage.Devices[:MaxBlockDevices]
		s.Storage.Truncated = true
	}
	if s.Storage.Capacity == nil {
		s.Storage.Capacity = []FilesystemCapacity{}
	}
	if len(s.Storage.Capacity) > MaxFilesystems {
		s.Storage.Capacity = s.Storage.Capacity[:MaxFilesystems]
		s.Storage.Truncated = true
	}
	for i := range s.Storage.Capacity {
		entry := &s.Storage.Capacity[i]
		if entry.HeadroomBytes < 0 {
			entry.HeadroomBytes = 0
		}
		// A protected filesystem is never growable, whatever its type. Leaving
		// `Growable` true and relying on a separate check would put a capability
		// on the screen that the agent would then refuse.
		if entry.Protected {
			entry.Growable = false
		}
	}
	if !s.Storage.Supported {
		s.Storage.Devices = []BlockDevice{}
		s.Storage.Capacity = []FilesystemCapacity{}
		s.Storage.Truncated = false
		s.Operations.StorageEnabled = false
		s.Operations.MountRoots = []string{}
		s.Operations.GrowAllowlist = []string{}
	}
	if s.Operations.MountRoots == nil {
		s.Operations.MountRoots = []string{}
	}
	if len(s.Operations.MountRoots) > MaxStorageAllowlist {
		s.Operations.MountRoots = s.Operations.MountRoots[:MaxStorageAllowlist]
	}
	if s.Operations.GrowAllowlist == nil {
		s.Operations.GrowAllowlist = []string{}
	}
	if len(s.Operations.GrowAllowlist) > MaxStorageAllowlist {
		s.Operations.GrowAllowlist = s.Operations.GrowAllowlist[:MaxStorageAllowlist]
	}

	if s.Boot.Model == "" {
		s.Boot.Model = BootModelUnknown
	}
	if s.Boot.Deployments == nil {
		s.Boot.Deployments = []Deployment{}
	}
	if len(s.Boot.Deployments) > MaxDeployments {
		s.Boot.Deployments = s.Boot.Deployments[:MaxDeployments]
	}
	if !s.Boot.Supported {
		// A mutable host has no staged deployment and nothing to roll back to.
		// Reporting either would invite an operator to ask for an image
		// operation this host cannot perform.
		s.Boot.CanStage = false
		s.Boot.CanRollback = false
		s.Boot.RollbackAvailable = false
		s.Boot.Staged = nil
		s.Boot.Deployments = []Deployment{}
		s.Operations.OSImageEnabled = false
		s.Operations.ImageAllowlist = []string{}
	}
	if !s.Boot.CanRollback {
		s.Boot.RollbackAvailable = false
	}
	if s.Operations.ImageAllowlist == nil {
		s.Operations.ImageAllowlist = []string{}
	}
	if len(s.Operations.ImageAllowlist) > MaxImageAllowlist {
		s.Operations.ImageAllowlist = s.Operations.ImageAllowlist[:MaxImageAllowlist]
	}

	// The three authorities also depend on the operation channel itself. A host
	// that is not executing operations at all cannot be executing these.
	if !s.Operations.Enabled {
		s.Operations.NetworkEnabled = false
		s.Operations.StorageEnabled = false
		s.Operations.OSImageEnabled = false
	}
}
