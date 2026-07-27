// Package plan defines the typed operation plan and receipt wire format.
//
// A plan is the only thing that can cause an agent to act. It is therefore
// treated as hostile input until every one of these holds:
//
//   - the schema version is exactly the one this build understands
//   - the operation type is one of the three declared types
//   - the control center and host match this agent's own identity
//   - the issue/expiry window contains the current time
//   - no unknown field is present anywhere in the document
//   - the whole document is smaller than MaxPlanBytes
//
// The transport already proves the *server* authenticated to us, but a valid
// signature on a plan for another host, or a stale plan replayed later, must
// still be refused. That is what Validate does.
package plan

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strings"
	"time"
)

const (
	// SchemaVersion is checked for exact equality. A newer control center must
	// not be able to talk an older agent into approximating an operation.
	SchemaVersion = "rcc.host.plan/v1"
	// ReceiptSchemaVersion is the matching result document version.
	ReceiptSchemaVersion = "rcc.host.receipt/v1"

	MaxPlanBytes = 32 * 1024
	// A receipt travels over the same signed channel as every other agent
	// request, so it must fit inside protocol.MaxBodyBytes (64 KiB). Journal
	// output is bounded below this to leave room for the receipt envelope.
	MaxReceiptBytes = 64 * 1024

	// A plan may never be valid for longer than this regardless of what the
	// control center asks for.
	//
	// This has to be at least as long as the longest lease any operation in the
	// catalog issues, because a lease may not outlive the plan that authorises
	// it. Pulling and unpacking an operating system image is the operation that
	// sets the floor: on a link a region control center actually has, it can
	// legitimately take the best part of an hour.
	//
	// Extending it does not widen the re-execution surface. A replayed plan
	// inside its lifetime meets the agent's claim store, which answers with the
	// receipt already recorded for that operation id and content digest rather
	// than running anything a second time.
	MaxPlanLifetime = 60 * time.Minute
	// Tolerance for clock disagreement between agent and control center.
	MaxClockSkew = 5 * time.Minute

	OpJournalQuery   = "journal.query"
	OpServiceRestart = "service.restart"
	OpHostReboot     = "host.reboot"
	// Stage 3. Package metadata refresh is read-only in effect: it updates the
	// local index and installs nothing.
	OpPackageRefresh = "package.refresh"
	OpPackageUpdate  = "package.update"
	OpKernelUpdate   = "kernel.update"
	// Stage 4. Conservative network and storage change, plus image-based OS
	// staging. None of these reboots; a reboot remains host.reboot.
	OpNetworkConfigure = "network.configure"
	OpMountConfigure   = "mount.configure"
	OpFilesystemGrow   = "filesystem.grow"
	OpOSImageStage     = "osimage.stage"
	OpOSImageRollback  = "osimage.rollback"
	// SSH ban management is deliberately fixed to Fail2ban's sshd jail. There
	// is no operation that can name another jail or pass a command fragment.
	OpSSHProtectionEnable = "ssh.protection.enable"
	OpSSHBan              = "ssh.ban"
	OpSSHUnban            = "ssh.unban"

	SSHProtectionProfile = "rcc-ssh-baseline-v1"
)

var (
	operationIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	dnsLabelRe    = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	digestRe      = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	// Conservative canonical grammar: must start with an alphanumeric, then
	// only [A-Za-z0-9_-] and dots, with one optional @instance segment.
	// Backslash, colon, whitespace, leading dash and path traversal are all
	// outside the character class, so they cannot appear at all.
	unitRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(\.[A-Za-z0-9][A-Za-z0-9_-]{0,63})*(@[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?\.(service|socket|timer|target|path|mount)$`)
	cursorRe = regexp.MustCompile(`^[A-Za-z0-9;=_:.\-]{0,512}$`)
	// Debian policy: a package name is at least two characters, starts with an
	// alphanumeric, and contains only lowercase alphanumerics plus + - . — the
	// architecture qualifier `:arch` is deliberately excluded, because a
	// qualified name is a different install target than the operator reviewed.
	//
	// Everything an injection needs is outside this class: no whitespace, no
	// shell metacharacters, no slash, no equals, no leading dash.
	packageNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]{1,127}$`)
	// A Debian version as dpkg accepts it: optional epoch, then upstream and
	// revision from a closed character set.
	packageVersionRe = regexp.MustCompile(`^([0-9]{1,4}:)?[0-9][A-Za-z0-9.+~-]{0,127}$`)
	// A kernel release as `uname -r` prints it.
	kernelReleaseRe = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?(-[a-z0-9]{1,32})*$`)
	// journalctl accepts absolute and a small set of relative forms. Anything
	// else is refused rather than passed through.
	timeSpecRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?|-?\d{1,4} (second|minute|hour|day)s? ago|now|today|yesterday)$`)

	// ── Stage 4 grammars ──────────────────────────────────────────────────────
	//
	// Every one of these is a closed character class. There is no field anywhere
	// in a Stage 4 plan that accepts a path, a flag, a URL, a command fragment
	// or a device node, so there is nothing for an operator or a compromised
	// control center to smuggle through.

	// A NetworkManager connection profile name. Spaces are permitted because the
	// default profiles genuinely contain them ("Wired connection 1"), but not at
	// either end, and no shell metacharacter is in the class at all.
	connectionNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$`)
	// A kernel interface name. IFNAMSIZ bounds this at 15 usable characters.
	interfaceNameRe = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,14}$`)
	ipv4Re          = regexp.MustCompile(`^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$`)
	ipv4CIDRRe      = regexp.MustCompile(`^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])/([0-9]|[12][0-9]|3[0-2])$`)
	searchDomainRe  = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)
	// An absolute path built only from safe segments. `..` cannot be expressed
	// because a dot may not lead a segment.
	mountPathRe = regexp.MustCompile(`^(/[A-Za-z0-9_][A-Za-z0-9._-]{0,62}){1,8}$`)
	// The UUID ext4 and xfs both write into their superblock. A device is named
	// by its filesystem UUID and never by a /dev path, because /dev names move
	// between boots and the operator approved a filesystem, not a slot.
	fsUUIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	// A digest-pinned container image reference. The `@sha256:` tail is not
	// optional: a tag can be moved under the platform's feet, a digest cannot,
	// so a tag-only reference is not a reviewable target.
	pinnedImageRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]{1,5})?(/[a-z0-9]([a-z0-9._-]*[a-z0-9])?){1,6}@sha256:[0-9a-f]{64}$`)
	// An ostree checksum or a bootc image digest, as the adapter reports it.
	deploymentIDRe = regexp.MustCompile(`^(sha256:)?[0-9a-f]{16,64}$`)
)

// ValidFilesystemUUID reports whether a string is a filesystem UUID.
//
// Exported so the executor can re-assert it at the point where a string is
// turned into a device path, rather than trusting that its caller validated.
func ValidFilesystemUUID(value string) bool { return fsUUIDRe.MatchString(value) }

// ValidPackageVersion lets the fixed-package SSH protection executor re-assert
// the same closed version grammar at the point where a value enters apt argv.
func ValidPackageVersion(value string) bool { return packageVersionRe.MatchString(value) }

// ErrUnknownField is returned when a plan carries a field this build does not
// understand, which usually means a downgrade attempt or a version skew.
var ErrUnknownField = errors.New("plan contains unknown fields")

// Plan is the complete instruction an agent may act on.
type Plan struct {
	SchemaVersion   string              `json:"schemaVersion"`
	OperationID     string              `json:"operationId"`
	Attempt         int                 `json:"attempt"`
	ControlCenterID string              `json:"controlCenterId"`
	HostID          string              `json:"hostId"`
	Operation       string              `json:"operation"`
	ContentDigest   string              `json:"contentDigest"`
	IssuedAt        time.Time           `json:"issuedAt"`
	NotBefore       time.Time           `json:"notBefore"`
	ExpiresAt       time.Time           `json:"expiresAt"`
	LeaseExpiresAt  time.Time           `json:"leaseExpiresAt"`
	Journal         *JournalArgs        `json:"journal,omitempty"`
	Service         *ServiceArgs        `json:"service,omitempty"`
	Reboot          *RebootArgs         `json:"reboot,omitempty"`
	PackageRefresh  *PackageRefreshArgs `json:"packageRefresh,omitempty"`
	PackageUpdate   *PackageUpdateArgs  `json:"packageUpdate,omitempty"`
	KernelUpdate    *KernelUpdateArgs   `json:"kernelUpdate,omitempty"`
	// Stage 4.
	Network        *NetworkConfigureArgs `json:"network,omitempty"`
	Mount          *MountConfigureArgs   `json:"mount,omitempty"`
	FilesystemGrow *FilesystemGrowArgs   `json:"filesystemGrow,omitempty"`
	OSImage        *OSImageArgs          `json:"osImage,omitempty"`
	SSHBan         *SSHBanArgs           `json:"sshBan,omitempty"`
	SSHProtection  *SSHProtectionArgs    `json:"sshProtection,omitempty"`
	// Policy is the maintenance-window decision the control center made when it
	// issued this plan. The agent re-checks the window itself: a plan that has
	// waited in a queue until the window closed must not still execute.
	Policy *PolicyBinding `json:"policy,omitempty"`
}

// PolicyBinding travels with every plan a policy governs.
//
// The version is what makes an approval stale: approving work under policy
// version 7 and executing it under version 8 means the thing that was reviewed
// is not the thing the rules now permit.
type PolicyBinding struct {
	PolicyID      string `json:"policyId"`
	PolicyVersion int    `json:"policyVersion"`
	WindowID      string `json:"windowId"`
	// The concrete window occurrence this plan belongs to, already resolved to
	// UTC by the control center. The agent compares wall-clock UTC against
	// these, so it never has to carry a timezone database or reason about DST.
	WindowStart time.Time `json:"windowStart"`
	WindowEnd   time.Time `json:"windowEnd"`
	Emergency   bool      `json:"emergency"`
}

// PackageRefreshArgs updates the local package index. It installs nothing.
type PackageRefreshArgs struct {
	Manager string `json:"manager"`
}

// PackageUpdateArgs upgrades a bounded, explicitly named set of packages.
//
// There is no "upgrade everything" form and no repository field. The set is
// always enumerated, because an operator approving "all pending updates" is
// approving whatever the mirror happens to contain at execution time, which is
// not a reviewable decision.
type PackageUpdateArgs struct {
	Manager  string          `json:"manager"`
	Packages []PackageTarget `json:"packages"`
	// SecurityOnly narrows what the agent will accept: a package whose
	// candidate does not come from a security origin is refused.
	SecurityOnly bool `json:"securityOnly"`
}

// PackageTarget names one package and, optionally, pins the exact version.
type PackageTarget struct {
	Name string `json:"name"`
	// Empty means "whatever the index currently offers". A pinned version is
	// verified before installation and the operation fails if it is gone.
	Version string `json:"version"`
}

// KernelUpdateArgs installs a kernel image. It never reboots.
type KernelUpdateArgs struct {
	Manager string `json:"manager"`
	// The release the operator reviewed. Empty means "whatever apt offers",
	// which is still bounded because the agent refuses anything that is not a
	// kernel image package.
	TargetRelease string `json:"targetRelease"`
	// Declared and always false on the wire. It exists so that a future field
	// with this name cannot be introduced silently: the agent refuses a plan
	// that sets it, rather than a later build quietly honouring it.
	RebootAfter bool `json:"rebootAfter"`
}

// ── Stage 4 argument blocks ─────────────────────────────────────────────────

// NetworkPreState is what the control center observed when the request was
// reviewed, and what the agent must still find on the host before it acts.
//
// This is the difference between "apply the reviewed change" and "apply a
// change to whatever this interface has become since". A host that was
// reconfigured by hand in between is not the host the approver looked at, and
// the operation is refused rather than layered on top of an unknown state.
type NetworkPreState struct {
	Method    string   `json:"method"`
	Addresses []string `json:"addresses"`
	Gateway   string   `json:"gateway"`
	MTU       int      `json:"mtu"`
	// DefaultRouteInterface is the link the host reaches this control center
	// through. The agent refuses if the plan targets it, and refuses again if it
	// has moved since the request was reviewed.
	DefaultRouteInterface string `json:"defaultRouteInterface"`
}

// NetworkConfigureArgs reconfigures exactly one NetworkManager profile.
//
// There is no field for a raw nmcli argument, a keyfile, a command, a device
// node or a script. The whole operation is: change these declared settings on
// this named profile, prove the host is still reachable, and undo it if not.
type NetworkConfigureArgs struct {
	Adapter    string `json:"adapter"`
	Connection string `json:"connection"`
	Interface  string `json:"interface"`
	// Method is "auto" (DHCP) or "manual". "disabled" is deliberately absent:
	// there is no supported way to ask this platform to take an interface down.
	Method        string   `json:"method"`
	Addresses     []string `json:"addresses"`
	Gateway       string   `json:"gateway"`
	DNS           []string `json:"dns"`
	SearchDomains []string `json:"searchDomains"`
	// MTU 0 means "leave it alone". It is not a way to request MTU zero.
	MTU int `json:"mtu"`
	// RollbackSeconds is how long the agent will wait for its own connectivity
	// proof before putting the previous settings back.
	RollbackSeconds int              `json:"rollbackSeconds"`
	PreState        *NetworkPreState `json:"preState"`
}

// MountPreState is the filesystem the approver reviewed.
type MountPreState struct {
	FSType     string `json:"fsType"`
	SizeBytes  int64  `json:"sizeBytes"`
	MountedAt  string `json:"mountedAt"`
	DeviceName string `json:"deviceName"`
}

// MountConfigureArgs makes an existing filesystem mount persistently.
//
// It never formats, never partitions and never writes to /etc/fstab. The unit
// it generates is assembled field by field from these validated values; there
// is no field carrying unit text, mount options as a string, or a device path.
type MountConfigureArgs struct {
	Adapter string `json:"adapter"`
	// The filesystem is named by its own UUID. A /dev path would name a slot,
	// and slots move between boots.
	FilesystemUUID string `json:"filesystemUuid"`
	MountPoint     string `json:"mountPoint"`
	FSType         string `json:"fsType"`
	// The only mount options that can be expressed. Every generated unit is
	// nofail, so a device that is absent at boot can never keep the host down.
	ReadOnly bool           `json:"readOnly"`
	NoExec   bool           `json:"noExec"`
	NoSuid   bool           `json:"noSuid"`
	NoDev    bool           `json:"noDev"`
	PreState *MountPreState `json:"preState"`
}

// FilesystemGrowPreState is the size the approver reviewed.
type FilesystemGrowPreState struct {
	Device      string `json:"device"`
	FSType      string `json:"fsType"`
	SizeBytes   int64  `json:"sizeBytes"`
	DeviceBytes int64  `json:"deviceBytes"`
}

// FilesystemGrowArgs grows a mounted filesystem to fill its block device.
//
// There is no target size. The filesystem is grown to the device it already
// sits on and no further, which is why this cannot shrink, cannot move data and
// cannot touch a partition table: none of those is expressible.
type FilesystemGrowArgs struct {
	Adapter    string                  `json:"adapter"`
	MountPoint string                  `json:"mountPoint"`
	PreState   *FilesystemGrowPreState `json:"preState"`
}

// OSImagePreState is the deployment the approver reviewed.
type OSImagePreState struct {
	Model             string `json:"model"`
	BootedDigest      string `json:"bootedDigest"`
	BootedVersion     string `json:"bootedVersion"`
	RollbackAvailable bool   `json:"rollbackAvailable"`
}

// OSImageArgs stages or rolls back an image-based operating system.
//
// Staging writes a new deployment and stops. The running system is unchanged
// until the machine restarts, and restarting it is host.reboot, which is
// approved separately and carries the Kubernetes drain gates this does not.
type OSImageArgs struct {
	Adapter string `json:"adapter"`
	// Image is a digest-pinned reference and must appear in both the policy
	// allowlist and the host's own. Empty on a rollback, which names no image:
	// it returns to the deployment already on the disk.
	Image string `json:"image"`
	// RebootAfter is declared and always false, exactly as it is for
	// kernel.update: the field exists so a later build cannot start honouring it
	// without this check being deliberately removed.
	RebootAfter bool             `json:"rebootAfter"`
	PreState    *OSImagePreState `json:"preState"`
}

// JournalArgs bounds a read-only journal query.
type JournalArgs struct {
	Units    []string `json:"units"`
	Priority string   `json:"priority"`
	Since    string   `json:"since"`
	Until    string   `json:"until"`
	Cursor   string   `json:"cursor"`
	Lines    int      `json:"lines"`
	MaxBytes int      `json:"maxBytes"`
	Grep     string   `json:"-"` // deliberately absent from the wire format
}

// ServiceArgs names exactly one unit to restart.
type ServiceArgs struct {
	Unit string `json:"unit"`
}

// RebootArgs carries the reboot deadline and the boot id observed before it.
type RebootArgs struct {
	DrainConfirmed  bool `json:"drainConfirmed"`
	DeadlineSeconds int  `json:"deadlineSeconds"`
}

// SSHBanArgs changes one exact address in Fail2ban's fixed sshd jail.
//
// ExpectedBanned binds the request to the state the administrator reviewed:
// ban expects false, unban expects true. The executor reads the live jail again
// and refuses when that state has changed.
type SSHBanArgs struct {
	Jail           string `json:"jail"`
	Address        string `json:"address"`
	ExpectedBanned bool   `json:"expectedBanned"`
}

// SSHProtectionArgs installs, configures and starts one fixed Fail2ban profile.
// Every value is either constant or derived from the host snapshot; the browser
// cannot provide a jail, a configuration fragment or a package name.
type SSHProtectionArgs struct {
	Provider              string   `json:"provider"`
	Jail                  string   `json:"jail"`
	Profile               string   `json:"profile"`
	PackageVersion        string   `json:"packageVersion"`
	ExpectedProfileDigest string   `json:"expectedProfileDigest"`
	ExpectedInstalled     bool     `json:"expectedInstalled"`
	ExpectedActive        bool     `json:"expectedActive"`
	ProtectedAddresses    []string `json:"protectedAddresses"`
}

// Bounds applied to journal queries. The control center may ask for less but
// never for more.
const (
	MaxJournalUnits     = 8
	MaxJournalLines     = 2000
	MaxJournalBytes     = 48 * 1024
	DefaultJournalLines = 200
	MinRebootDeadline   = 60
	MaxRebootDeadline   = 1800
	// A single approved operation may touch at most this many packages. The
	// bound is what makes the set reviewable: an operator can read 32 names.
	MaxUpdatePackages = 32
	// A maintenance window longer than this is not a window; it is a standing
	// permission with a start date, and it should be declared as one.
	MaxWindowDuration = 24 * time.Hour

	// Stage 4 bounds.
	MaxLinkAddresses = 4
	MaxLinkDNS       = 4
	MaxSearchDomains = 8
	// The kernel accepts smaller MTUs, but nothing below the IPv6 minimum is a
	// configuration anyone wants on a cluster node, and a very small MTU is a
	// good way to make a host unreachable in a way that looks like a network
	// fault rather than a change.
	MinMTU = 1280
	MaxMTU = 9216
	// How long the agent will wait for its own connectivity proof before
	// restoring the previous settings. The floor is long enough for DHCP and a
	// TLS handshake; the ceiling bounds how long a host can sit unreachable
	// before it repairs itself.
	MinRollbackSeconds = 30
	MaxRollbackSeconds = 600
)

// SupportedManager is the only package manager this build drives. A plan naming
// anything else is refused rather than attempted by analogy.
const SupportedManager = "apt"

// KernelImagePrefix is the only package family kernel.update will install.
const KernelImagePrefix = "linux-image-"

var validPriorities = map[string]bool{
	"": true, "emerg": true, "alert": true, "crit": true, "err": true,
	"warning": true, "notice": true, "info": true, "debug": true,
}

// Identity is what the agent knows about itself, used to reject plans meant for
// somebody else.
type Identity struct {
	ControlCenterID string
	HostID          string
}

// Parse decodes and fully validates a plan document.
//
// Decoding is strict: unknown fields are an error rather than being ignored,
// so a field the agent does not understand can never be silently dropped from
// an operation a human approved.
func Parse(raw []byte, self Identity, now time.Time) (*Plan, error) {
	if len(raw) == 0 {
		return nil, errors.New("empty plan")
	}
	if len(raw) > MaxPlanBytes {
		return nil, fmt.Errorf("plan exceeds %d bytes", MaxPlanBytes)
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var p Plan
	if err := decoder.Decode(&p); err != nil {
		if strings.Contains(err.Error(), "unknown field") {
			return nil, fmt.Errorf("%w: %v", ErrUnknownField, err)
		}
		return nil, fmt.Errorf("plan is not valid JSON: %w", err)
	}
	// Anything after the document is a second value smuggled into one body.
	// decoder.More() only reports elements of an enclosing array or object, so
	// it does not see a trailing top-level object, scalar or garbage. Requiring
	// the next Decode to return io.EOF does.
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("plan carries trailing content")
		}
		return nil, fmt.Errorf("plan carries trailing content: %w", err)
	}
	if err := p.Validate(self, now); err != nil {
		return nil, err
	}
	// The digest must match the parameters actually carried, not merely look
	// like a digest. This is what binds execution to what was approved.
	if err := p.VerifyContentDigest(); err != nil {
		return nil, err
	}
	return &p, nil
}

// Validate enforces every rule that does not depend on the host's own state.
func (p *Plan) Validate(self Identity, now time.Time) error {
	if p.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported plan schema %q", p.SchemaVersion)
	}
	if !operationIDRe.MatchString(p.OperationID) {
		return errors.New("operationId is not a uuid")
	}
	if p.Attempt < 1 || p.Attempt > 100 {
		return errors.New("attempt out of range")
	}
	if !dnsLabelRe.MatchString(p.ControlCenterID) || !dnsLabelRe.MatchString(p.HostID) {
		return errors.New("plan identity is malformed")
	}
	// A correctly signed plan for a different host must still be refused.
	if p.ControlCenterID != self.ControlCenterID || p.HostID != self.HostID {
		return fmt.Errorf("plan is bound to %s/%s, not this host",
			p.ControlCenterID, p.HostID)
	}
	if !digestRe.MatchString(p.ContentDigest) {
		return errors.New("contentDigest is malformed")
	}
	if p.IssuedAt.IsZero() || p.NotBefore.IsZero() || p.ExpiresAt.IsZero() || p.LeaseExpiresAt.IsZero() {
		return errors.New("plan is missing its validity window")
	}
	// Strict ordering: issued <= notBefore < expires, and the lease can never
	// outlive the plan that authorises it.
	if p.IssuedAt.After(p.NotBefore) {
		return errors.New("plan was issued after it becomes valid")
	}
	if !p.ExpiresAt.After(p.NotBefore) {
		return errors.New("plan expiry precedes its start")
	}
	if p.LeaseExpiresAt.After(p.ExpiresAt) {
		return errors.New("lease outlives the plan that authorises it")
	}
	if !p.LeaseExpiresAt.After(p.NotBefore) {
		return errors.New("lease expires before the plan becomes valid")
	}
	if p.ExpiresAt.Sub(p.NotBefore) > MaxPlanLifetime {
		return fmt.Errorf("plan lifetime exceeds %s", MaxPlanLifetime)
	}
	if p.IssuedAt.After(now.Add(MaxClockSkew)) {
		return errors.New("plan was issued in the future")
	}
	if now.Add(MaxClockSkew).Before(p.NotBefore) {
		return errors.New("plan is not valid yet")
	}
	if now.After(p.ExpiresAt.Add(MaxClockSkew)) {
		return errors.New("plan has expired")
	}
	if now.After(p.LeaseExpiresAt.Add(MaxClockSkew)) {
		return errors.New("plan lease has expired")
	}

	// Exactly one argument block, matching the declared operation.
	set := 0
	if p.Journal != nil {
		set++
	}
	if p.Service != nil {
		set++
	}
	if p.Reboot != nil {
		set++
	}
	if p.PackageRefresh != nil {
		set++
	}
	if p.PackageUpdate != nil {
		set++
	}
	if p.KernelUpdate != nil {
		set++
	}
	if p.Network != nil {
		set++
	}
	if p.Mount != nil {
		set++
	}
	if p.FilesystemGrow != nil {
		set++
	}
	if p.OSImage != nil {
		set++
	}
	if p.SSHBan != nil {
		set++
	}
	if p.SSHProtection != nil {
		set++
	}
	if set != 1 {
		return errors.New("plan must carry exactly one argument block")
	}

	if p.Policy != nil {
		if err := p.Policy.validate(now); err != nil {
			return err
		}
	}

	switch p.Operation {
	case OpJournalQuery:
		if p.Journal == nil {
			return errors.New("journal.query requires journal arguments")
		}
		return p.Journal.validate()
	case OpServiceRestart:
		if p.Service == nil {
			return errors.New("service.restart requires service arguments")
		}
		return p.Service.validate()
	case OpPackageRefresh:
		if p.PackageRefresh == nil {
			return errors.New("package.refresh requires packageRefresh arguments")
		}
		return p.PackageRefresh.validate()
	case OpPackageUpdate:
		if p.PackageUpdate == nil {
			return errors.New("package.update requires packageUpdate arguments")
		}
		return p.PackageUpdate.validate()
	case OpKernelUpdate:
		if p.KernelUpdate == nil {
			return errors.New("kernel.update requires kernelUpdate arguments")
		}
		return p.KernelUpdate.validate()
	case OpNetworkConfigure:
		if p.Network == nil {
			return errors.New("network.configure requires network arguments")
		}
		return p.Network.validate()
	case OpMountConfigure:
		if p.Mount == nil {
			return errors.New("mount.configure requires mount arguments")
		}
		return p.Mount.validate()
	case OpFilesystemGrow:
		if p.FilesystemGrow == nil {
			return errors.New("filesystem.grow requires filesystemGrow arguments")
		}
		return p.FilesystemGrow.validate()
	case OpOSImageStage, OpOSImageRollback:
		if p.OSImage == nil {
			return errors.New(p.Operation + " requires osImage arguments")
		}
		return p.OSImage.validate(p.Operation)
	case OpSSHBan, OpSSHUnban:
		if p.SSHBan == nil {
			return errors.New(p.Operation + " requires sshBan arguments")
		}
		return p.SSHBan.validate(p.Operation)
	case OpSSHProtectionEnable:
		if p.SSHProtection == nil {
			return errors.New("ssh.protection.enable requires sshProtection arguments")
		}
		return p.SSHProtection.validate()
	case OpHostReboot:
		if p.Reboot == nil {
			return errors.New("host.reboot requires reboot arguments")
		}
		return p.Reboot.validate()
	default:
		return fmt.Errorf("unknown operation %q", p.Operation)
	}
}

func (a *SSHProtectionArgs) validate() error {
	if a.Provider != "fail2ban" || a.Jail != "sshd" || a.Profile != SSHProtectionProfile {
		return errors.New("SSH protection is restricted to the fixed Fail2ban sshd baseline profile")
	}
	if !packageVersionRe.MatchString(a.PackageVersion) {
		return errors.New("ssh.protection.enable must pin the exact installed or candidate Fail2ban version")
	}
	if a.ExpectedProfileDigest != "" && !digestRe.MatchString(a.ExpectedProfileDigest) {
		return errors.New("ssh.protection.enable carries a malformed reviewed profile digest")
	}
	if len(a.ProtectedAddresses) == 0 || len(a.ProtectedAddresses) > 64 {
		return errors.New("ssh.protection.enable requires 1..64 protected management addresses")
	}
	previous := ""
	for _, address := range a.ProtectedAddresses {
		parsed := net.ParseIP(address)
		if parsed == nil || parsed.String() != address {
			return fmt.Errorf("protected address %q must be one canonical exact IP address",
				boundText(address, 64))
		}
		if previous != "" && address <= previous {
			return errors.New("protected management addresses must be sorted and unique")
		}
		previous = address
	}
	return nil
}

func (a *SSHBanArgs) validate(operation string) error {
	if a.Jail != "sshd" {
		return errors.New("SSH ban operations are restricted to the sshd jail")
	}
	parsed := net.ParseIP(a.Address)
	if parsed == nil || parsed.String() != a.Address {
		return fmt.Errorf("address %q must be one canonical exact IP address", boundText(a.Address, 64))
	}
	switch operation {
	case OpSSHBan:
		if a.ExpectedBanned {
			return errors.New("ssh.ban must expect the address to be unbanned")
		}
		if parsed.IsUnspecified() || parsed.IsLoopback() || parsed.IsMulticast() ||
			parsed.IsLinkLocalUnicast() || parsed.IsLinkLocalMulticast() {
			return errors.New("ssh.ban refuses unspecified, loopback, multicast and link-local addresses")
		}
	case OpSSHUnban:
		if !a.ExpectedBanned {
			return errors.New("ssh.unban must expect the address to be banned")
		}
	default:
		return fmt.Errorf("unknown SSH ban operation %q", boundText(operation, 64))
	}
	return nil
}

func (j *JournalArgs) validate() error {
	if len(j.Units) > MaxJournalUnits {
		return fmt.Errorf("at most %d units may be queried", MaxJournalUnits)
	}
	for _, unit := range j.Units {
		if !unitRe.MatchString(unit) {
			return fmt.Errorf("unit %q is not a valid systemd unit name", unit)
		}
	}
	if !validPriorities[j.Priority] {
		return fmt.Errorf("priority %q is not a journald priority", j.Priority)
	}
	for name, value := range map[string]string{"since": j.Since, "until": j.Until} {
		if value == "" {
			continue
		}
		if !timeSpecRe.MatchString(value) {
			return fmt.Errorf("%s %q is not an accepted time specification", name, value)
		}
	}
	if !cursorRe.MatchString(j.Cursor) {
		return errors.New("cursor is malformed")
	}
	if j.Lines < 0 || j.Lines > MaxJournalLines {
		return fmt.Errorf("lines must be 0..%d", MaxJournalLines)
	}
	if j.MaxBytes < 0 || j.MaxBytes > MaxJournalBytes {
		return fmt.Errorf("maxBytes must be 0..%d", MaxJournalBytes)
	}
	return nil
}

func (s *ServiceArgs) validate() error {
	if !unitRe.MatchString(s.Unit) {
		return fmt.Errorf("unit %q is not a valid systemd unit name", s.Unit)
	}
	// Only .service units can be restarted; the allowlist narrows this further.
	if !strings.HasSuffix(s.Unit, ".service") {
		return errors.New("only .service units may be restarted")
	}
	return nil
}

func (r *RebootArgs) validate() error {
	if !r.DrainConfirmed {
		return errors.New("reboot requires confirmed Kubernetes drain")
	}
	if r.DeadlineSeconds < MinRebootDeadline || r.DeadlineSeconds > MaxRebootDeadline {
		return fmt.Errorf("reboot deadline must be %d..%d seconds", MinRebootDeadline, MaxRebootDeadline)
	}
	return nil
}

// EffectiveLines and EffectiveMaxBytes apply defaults without ever exceeding
// the declared ceiling.
func (j *JournalArgs) EffectiveLines() int {
	if j.Lines <= 0 {
		return DefaultJournalLines
	}
	if j.Lines > MaxJournalLines {
		return MaxJournalLines
	}
	return j.Lines
}

func (j *JournalArgs) EffectiveMaxBytes() int {
	if j.MaxBytes <= 0 || j.MaxBytes > MaxJournalBytes {
		return MaxJournalBytes
	}
	return j.MaxBytes
}

// Receipt is the immutable result the agent returns.
type Receipt struct {
	SchemaVersion   string            `json:"schemaVersion"`
	OperationID     string            `json:"operationId"`
	Attempt         int               `json:"attempt"`
	ControlCenterID string            `json:"controlCenterId"`
	HostID          string            `json:"hostId"`
	Operation       string            `json:"operation"`
	ContentDigest   string            `json:"contentDigest"`
	Outcome         string            `json:"outcome"`
	StartedAt       time.Time         `json:"startedAt"`
	FinishedAt      time.Time         `json:"finishedAt"`
	ExitCode        int               `json:"exitCode"`
	Message         string            `json:"message"`
	Truncated       bool              `json:"truncated"`
	Output          string            `json:"output"`
	Evidence        map[string]string `json:"evidence"`
}

// Outcome values.
const (
	OutcomeSucceeded = "succeeded"
	OutcomeFailed    = "failed"
)

// Receipt bounds. Every field is capped so a hostile or buggy host cannot
// produce a document the control center must either truncate or refuse.
const (
	MaxReceiptMessage     = 1000
	MaxReceiptOutput      = 48 * 1024
	MaxEvidenceEntries    = 24
	MaxEvidenceKeyChars   = 64
	MaxEvidenceValueChars = 512
	MaxAttempt            = 100
)

// Validate keeps a malformed receipt from ever reaching the control center.
//
// This runs on the agent before sending and mirrors the backend's own
// validation, so a receipt that would be refused is never put on the wire.
func (r *Receipt) Validate() error {
	if r.SchemaVersion != ReceiptSchemaVersion {
		return fmt.Errorf("unsupported receipt schema %q", r.SchemaVersion)
	}
	if !operationIDRe.MatchString(r.OperationID) {
		return errors.New("receipt operationId is not a uuid")
	}
	if r.Attempt < 1 || r.Attempt > MaxAttempt {
		return fmt.Errorf("receipt attempt must be 1..%d", MaxAttempt)
	}
	if !dnsLabelRe.MatchString(r.ControlCenterID) || !dnsLabelRe.MatchString(r.HostID) {
		return errors.New("receipt identity is malformed")
	}
	switch r.Operation {
	case OpJournalQuery, OpServiceRestart, OpHostReboot,
		OpPackageRefresh, OpPackageUpdate, OpKernelUpdate,
		OpNetworkConfigure, OpMountConfigure, OpFilesystemGrow,
		OpOSImageStage, OpOSImageRollback, OpSSHProtectionEnable, OpSSHBan, OpSSHUnban:
	default:
		return fmt.Errorf("receipt names unknown operation %q", r.Operation)
	}
	if !digestRe.MatchString(r.ContentDigest) {
		return errors.New("receipt contentDigest is malformed")
	}
	if r.Outcome != OutcomeSucceeded && r.Outcome != OutcomeFailed {
		return fmt.Errorf("unknown outcome %q", r.Outcome)
	}

	// Timestamp ordering. A receipt that finished before it started, or that is
	// missing either bound, cannot be reasoned about afterwards.
	if r.StartedAt.IsZero() || r.FinishedAt.IsZero() {
		return errors.New("receipt is missing its start or finish time")
	}
	if r.FinishedAt.Before(r.StartedAt) {
		return errors.New("receipt finished before it started")
	}

	if len(r.Message) > MaxReceiptMessage {
		return fmt.Errorf("receipt message exceeds %d characters", MaxReceiptMessage)
	}
	if len(r.Output) > MaxReceiptOutput {
		return fmt.Errorf("receipt output exceeds %d bytes", MaxReceiptOutput)
	}
	if hasControlChars(r.Message) || hasControlChars(r.Output) {
		return errors.New("receipt text carries control characters")
	}
	if len(r.Evidence) > MaxEvidenceEntries {
		return fmt.Errorf("receipt carries more than %d evidence entries", MaxEvidenceEntries)
	}
	for key, value := range r.Evidence {
		if key == "" || len(key) > MaxEvidenceKeyChars {
			return fmt.Errorf("evidence key %q is out of bounds", truncateForError(key))
		}
		if len(value) > MaxEvidenceValueChars {
			return fmt.Errorf("evidence value for %q exceeds %d characters", truncateForError(key), MaxEvidenceValueChars)
		}
		if hasControlChars(key) || hasControlChars(value) {
			return errors.New("evidence carries control characters")
		}
	}

	// Final serialized size. Truncation and evidence are added after the body
	// is first assembled, so the only trustworthy check is on the real bytes.
	encoded, err := json.Marshal(r)
	if err != nil {
		return fmt.Errorf("receipt cannot be encoded: %w", err)
	}
	if len(encoded) > MaxReceiptBytes {
		return fmt.Errorf("serialized receipt is %d bytes, above the %d byte limit", len(encoded), MaxReceiptBytes)
	}
	return nil
}

// hasControlChars reports characters that would corrupt a log line, a database
// value or a browser rendering. Tab, newline and carriage return are allowed
// because they are legitimate inside captured output.
func hasControlChars(value string) bool {
	for _, r := range value {
		if r == '\t' || r == '\n' || r == '\r' {
			continue
		}
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func truncateForError(value string) string {
	if len(value) <= 32 {
		return value
	}
	return value[:32]
}

// Digest is the canonical digest of a receipt, computed over the marshalled
// document so the control center can pin exactly what it stored.
func Digest(value []byte) string {
	sum := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// ── Stage 3 argument validation ─────────────────────────────────────────────

func validateManager(manager string) error {
	if manager != SupportedManager {
		// Naming an unsupported manager is refused rather than ignored: a plan
		// built for dnf must not be carried out by apt because the field
		// happened to be unread.
		return fmt.Errorf("package manager %q is not supported by this agent", boundText(manager, 32))
	}
	return nil
}

func (a *PackageRefreshArgs) validate() error {
	return validateManager(a.Manager)
}

func (a *PackageUpdateArgs) validate() error {
	if err := validateManager(a.Manager); err != nil {
		return err
	}
	if len(a.Packages) == 0 {
		// There is deliberately no "everything" form. A set nobody enumerated
		// is a set nobody reviewed.
		return errors.New("package.update must name at least one package")
	}
	if len(a.Packages) > MaxUpdatePackages {
		return fmt.Errorf("package.update names %d packages, above the limit of %d",
			len(a.Packages), MaxUpdatePackages)
	}
	seen := make(map[string]bool, len(a.Packages))
	for _, target := range a.Packages {
		if !packageNameRe.MatchString(target.Name) {
			return fmt.Errorf("package name %q is not a valid Debian package name",
				boundText(target.Name, 64))
		}
		if strings.HasPrefix(target.Name, KernelImagePrefix) {
			// Kernels go through kernel.update, which carries its own review and
			// produces reboot-required evidence. Slipping one into a package
			// update would change the running kernel path without that.
			return fmt.Errorf("package %q is a kernel image; use kernel.update", target.Name)
		}
		if target.Version != "" && !packageVersionRe.MatchString(target.Version) {
			return fmt.Errorf("package version %q is malformed", boundText(target.Version, 64))
		}
		if seen[target.Name] {
			return fmt.Errorf("package %q is named twice", target.Name)
		}
		seen[target.Name] = true
	}
	return nil
}

func (a *KernelUpdateArgs) validate() error {
	if err := validateManager(a.Manager); err != nil {
		return err
	}
	if a.RebootAfter {
		// A kernel update never reboots. Refusing the field outright means a
		// control center cannot ask for it and a later build cannot start
		// honouring it without this check being deliberately removed.
		return errors.New("kernel.update never reboots; rebootAfter must not be set")
	}
	if a.TargetRelease != "" && !kernelReleaseRe.MatchString(a.TargetRelease) {
		return fmt.Errorf("kernel release %q is malformed", boundText(a.TargetRelease, 64))
	}
	return nil
}

// validate checks the window this plan claims to belong to.
//
// The control center already resolved the window to UTC instants. Re-checking
// them here is what stops a plan that sat in a queue, or was replayed later,
// from executing after the window it was approved for has closed.
func (b *PolicyBinding) validate(now time.Time) error {
	if !operationIDRe.MatchString(b.PolicyID) {
		return errors.New("policy id is malformed")
	}
	if b.PolicyVersion < 1 {
		return errors.New("policy version must be positive")
	}
	if b.WindowID != "" && !operationIDRe.MatchString(b.WindowID) {
		return errors.New("window id is malformed")
	}
	if b.Emergency {
		// An emergency plan carries no window because there is none to be in.
		if !b.WindowStart.IsZero() || !b.WindowEnd.IsZero() {
			return errors.New("an emergency plan must not also claim a maintenance window")
		}
		return nil
	}
	if b.WindowStart.IsZero() || b.WindowEnd.IsZero() {
		return errors.New("a governed plan must carry the window it belongs to")
	}
	if !b.WindowEnd.After(b.WindowStart) {
		return errors.New("the maintenance window ends before it begins")
	}
	if b.WindowEnd.Sub(b.WindowStart) > MaxWindowDuration {
		return fmt.Errorf("the maintenance window spans more than %s", MaxWindowDuration)
	}
	if now.Before(b.WindowStart.Add(-MaxClockSkew)) {
		return errors.New("the maintenance window has not opened yet")
	}
	if now.After(b.WindowEnd.Add(MaxClockSkew)) {
		return errors.New("the maintenance window has closed")
	}
	return nil
}

// ── Stage 4 argument validation ─────────────────────────────────────────────

// SupportedNetworkAdapter is the only network stack this build drives.
const SupportedNetworkAdapter = "NetworkManager"

// SupportedStorageAdapter names how storage changes are made: a generated
// systemd mount unit, never /etc/fstab. A bad fstab line keeps a host from
// booting; a bad mount unit does not, because nofail is not optional here and
// the root filesystem is not mounted from one.
const SupportedStorageAdapter = "systemd-mount"

// Supported image adapters. snapd is deliberately absent: Ubuntu Core governs
// its own refresh and rollback, and a second scheduler racing it would be worse
// than none.
const (
	AdapterRPMOSTree = "rpm-ostree"
	AdapterBootc     = "bootc"
)

func (a *NetworkConfigureArgs) validate() error {
	if a.Adapter != SupportedNetworkAdapter {
		return fmt.Errorf("network adapter %q is not supported by this agent", boundText(a.Adapter, 32))
	}
	if !connectionNameRe.MatchString(a.Connection) {
		return fmt.Errorf("connection %q is not a valid NetworkManager profile name", boundText(a.Connection, 64))
	}
	if !interfaceNameRe.MatchString(a.Interface) {
		return fmt.Errorf("interface %q is not a valid interface name", boundText(a.Interface, 32))
	}
	switch a.Method {
	case "auto", "manual":
	default:
		// "disabled" and "link-local" would take an interface out of service,
		// which is not a change this platform makes.
		return fmt.Errorf("ipv4 method %q is not one this agent applies", boundText(a.Method, 32))
	}

	if len(a.Addresses) > MaxLinkAddresses {
		return fmt.Errorf("at most %d addresses may be assigned", MaxLinkAddresses)
	}
	seen := map[string]bool{}
	for _, address := range a.Addresses {
		if !ipv4CIDRRe.MatchString(address) {
			return fmt.Errorf("address %q is not an IPv4 address with a prefix length", boundText(address, 64))
		}
		if seen[address] {
			return fmt.Errorf("address %q is listed twice", address)
		}
		seen[address] = true
	}
	if a.Method == "manual" && len(a.Addresses) == 0 {
		return errors.New("a manual configuration must carry at least one address")
	}
	if a.Method == "auto" && len(a.Addresses) > 0 {
		// Otherwise the stored parameters describe one thing and the host does
		// another, and the receipt could not be read against the request.
		return errors.New("an automatic configuration must not also carry static addresses")
	}
	if a.Gateway != "" && !ipv4Re.MatchString(a.Gateway) {
		return fmt.Errorf("gateway %q is not an IPv4 address", boundText(a.Gateway, 64))
	}
	if a.Method == "auto" && a.Gateway != "" {
		return errors.New("an automatic configuration must not also carry a static gateway")
	}

	if len(a.DNS) > MaxLinkDNS {
		return fmt.Errorf("at most %d DNS servers may be set", MaxLinkDNS)
	}
	for _, server := range a.DNS {
		if !ipv4Re.MatchString(server) {
			return fmt.Errorf("DNS server %q is not an IPv4 address", boundText(server, 64))
		}
	}
	if len(a.SearchDomains) > MaxSearchDomains {
		return fmt.Errorf("at most %d search domains may be set", MaxSearchDomains)
	}
	for _, domain := range a.SearchDomains {
		if !searchDomainRe.MatchString(domain) || len(domain) > 253 {
			return fmt.Errorf("search domain %q is malformed", boundText(domain, 64))
		}
	}

	if a.MTU != 0 && (a.MTU < MinMTU || a.MTU > MaxMTU) {
		return fmt.Errorf("mtu must be 0 (unchanged) or %d..%d", MinMTU, MaxMTU)
	}
	if a.RollbackSeconds < MinRollbackSeconds || a.RollbackSeconds > MaxRollbackSeconds {
		// There is no "no rollback" value. A network change this platform cannot
		// undo is one it does not make.
		return fmt.Errorf("rollbackSeconds must be %d..%d", MinRollbackSeconds, MaxRollbackSeconds)
	}

	if a.PreState == nil {
		return errors.New("network.configure must carry the state it was reviewed against")
	}
	if a.PreState.DefaultRouteInterface != "" && a.PreState.DefaultRouteInterface == a.Interface {
		// The interface carrying the default route is the one this control
		// center is reached through. Reconfiguring it is refused here, again in
		// the executor, and again against live state at execution time.
		return fmt.Errorf("interface %q carries the default route and is never reconfigured by this platform", a.Interface)
	}
	return a.PreState.validate()
}

func (s *NetworkPreState) validate() error {
	switch s.Method {
	case "auto", "manual", "disabled", "link-local", "shared", "":
	default:
		return fmt.Errorf("recorded ipv4 method %q is not a NetworkManager method", boundText(s.Method, 32))
	}
	if len(s.Addresses) > MaxLinkAddresses {
		return fmt.Errorf("the recorded state lists more than %d addresses", MaxLinkAddresses)
	}
	for _, address := range s.Addresses {
		if !ipv4CIDRRe.MatchString(address) {
			return fmt.Errorf("recorded address %q is malformed", boundText(address, 64))
		}
	}
	if s.Gateway != "" && !ipv4Re.MatchString(s.Gateway) {
		return fmt.Errorf("recorded gateway %q is malformed", boundText(s.Gateway, 64))
	}
	if s.MTU != 0 && (s.MTU < 68 || s.MTU > 65536) {
		return fmt.Errorf("recorded mtu %d is out of range", s.MTU)
	}
	if s.DefaultRouteInterface != "" && !interfaceNameRe.MatchString(s.DefaultRouteInterface) {
		return fmt.Errorf("recorded default route interface %q is malformed",
			boundText(s.DefaultRouteInterface, 32))
	}
	return nil
}

func (a *MountConfigureArgs) validate() error {
	if a.Adapter != SupportedStorageAdapter {
		return fmt.Errorf("storage adapter %q is not supported by this agent", boundText(a.Adapter, 32))
	}
	if !fsUUIDRe.MatchString(a.FilesystemUUID) {
		return fmt.Errorf("filesystem uuid %q is malformed", boundText(a.FilesystemUUID, 64))
	}
	if !mountPathRe.MatchString(a.MountPoint) {
		return fmt.Errorf("mount point %q is not an accepted absolute path", boundText(a.MountPoint, 96))
	}
	switch a.FSType {
	case "ext4", "xfs":
	default:
		return fmt.Errorf("filesystem type %q is not one this agent mounts", boundText(a.FSType, 32))
	}
	if a.PreState == nil {
		return errors.New("mount.configure must carry the state it was reviewed against")
	}
	if a.PreState.FSType != "" && a.PreState.FSType != a.FSType {
		return errors.New("the reviewed filesystem type does not match the requested one")
	}
	if a.PreState.MountedAt != "" && !mountPathRe.MatchString(a.PreState.MountedAt) {
		return fmt.Errorf("recorded mount point %q is malformed", boundText(a.PreState.MountedAt, 96))
	}
	if a.PreState.SizeBytes < 0 {
		return errors.New("recorded filesystem size is negative")
	}
	return nil
}

func (a *FilesystemGrowArgs) validate() error {
	if a.Adapter != SupportedStorageAdapter {
		return fmt.Errorf("storage adapter %q is not supported by this agent", boundText(a.Adapter, 32))
	}
	if !mountPathRe.MatchString(a.MountPoint) {
		return fmt.Errorf("mount point %q is not an accepted absolute path", boundText(a.MountPoint, 96))
	}
	if a.PreState == nil {
		return errors.New("filesystem.grow must carry the state it was reviewed against")
	}
	switch a.PreState.FSType {
	case "ext4", "xfs":
	default:
		return fmt.Errorf("filesystem type %q cannot be grown by this agent", boundText(a.PreState.FSType, 32))
	}
	if a.PreState.SizeBytes <= 0 || a.PreState.DeviceBytes <= 0 {
		return errors.New("the reviewed sizes are missing, so growth cannot be bounded")
	}
	if a.PreState.DeviceBytes <= a.PreState.SizeBytes {
		// Without headroom there is nothing to grow into. Refusing here means
		// the operation is never dispatched rather than failing on the host.
		return errors.New("the block device is not larger than the filesystem, so there is nothing to grow into")
	}
	return nil
}

func (a *OSImageArgs) validate(operation string) error {
	switch a.Adapter {
	case AdapterRPMOSTree, AdapterBootc:
	default:
		return fmt.Errorf("image adapter %q is not supported by this agent", boundText(a.Adapter, 32))
	}
	if a.RebootAfter {
		// Identical to kernel.update: staging an image never restarts the host.
		return errors.New("image operations never reboot; rebootAfter must not be set")
	}
	if a.PreState == nil {
		return errors.New("image operations must carry the state they were reviewed against")
	}
	if a.PreState.Model != a.Adapter {
		return errors.New("the reviewed boot model does not match the requested adapter")
	}
	if a.PreState.BootedDigest != "" && !deploymentIDRe.MatchString(a.PreState.BootedDigest) {
		return fmt.Errorf("recorded booted digest %q is malformed", boundText(a.PreState.BootedDigest, 96))
	}

	switch operation {
	case OpOSImageStage:
		if !pinnedImageRe.MatchString(a.Image) {
			return fmt.Errorf("image %q must be a digest-pinned reference", boundText(a.Image, 128))
		}
	case OpOSImageRollback:
		if a.Image != "" {
			// A rollback returns to the deployment already on the disk. Naming an
			// image would make it a different operation wearing this one's name.
			return errors.New("osimage.rollback names no image; it returns to the previous deployment")
		}
		if !a.PreState.RollbackAvailable {
			return errors.New("the reviewed state had no deployment to roll back to")
		}
	default:
		return fmt.Errorf("unknown image operation %q", boundText(operation, 64))
	}
	return nil
}

func boundText(value string, max int) string {
	cleaned := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, value)
	if len(cleaned) > max {
		return cleaned[:max]
	}
	return cleaned
}
