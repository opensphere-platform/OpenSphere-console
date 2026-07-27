package plan

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Stage 4 plans are the first that carry the state they were reviewed against,
// and the first that can sever the path used to find out whether they worked.
// These assertions treat every field as hostile.

func stage4Base(operation string, now time.Time) Plan {
	return Plan{
		SchemaVersion:   SchemaVersion,
		OperationID:     "2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f",
		Attempt:         1,
		ControlCenterID: "cc2",
		HostID:          "node-a",
		Operation:       operation,
		ContentDigest:   "sha256:" + strings.Repeat("0", 64),
		IssuedAt:        now,
		NotBefore:       now,
		ExpiresAt:       now.Add(10 * time.Minute),
		LeaseExpiresAt:  now.Add(9 * time.Minute),
	}
}

func validNetworkArgs() *NetworkConfigureArgs {
	return &NetworkConfigureArgs{
		Adapter:         SupportedNetworkAdapter,
		Connection:      "lab-data",
		Interface:       "eth1",
		Method:          "manual",
		Addresses:       []string{"192.168.50.10/24"},
		DNS:             []string{"192.168.50.1"},
		SearchDomains:   []string{"lab.internal"},
		MTU:             9000,
		RollbackSeconds: 120,
		PreState:        &NetworkPreState{Method: "auto", DefaultRouteInterface: "eth0"},
	}
}

func TestNetworkArgsAccepted(t *testing.T) {
	if err := validNetworkArgs().validate(); err != nil {
		t.Fatalf("a well-formed network change must be accepted: %v", err)
	}
}

func TestNetworkRefusesEverythingAnInjectionNeeds(t *testing.T) {
	// None of these is a value a caller could talk the agent into executing:
	// they are refused by the grammar before any argv is built. The point of
	// the table is that the closed character classes stay closed.
	cases := map[string]func(*NetworkConfigureArgs){
		"a shell fragment in the profile name": func(a *NetworkConfigureArgs) { a.Connection = "lab; reboot" },
		"a command substitution":               func(a *NetworkConfigureArgs) { a.Connection = "lab$(id)" },
		"a newline in the profile name":        func(a *NetworkConfigureArgs) { a.Connection = "lab\ndata" },
		"a leading dash that reads as a flag":  func(a *NetworkConfigureArgs) { a.Connection = "-delete" },
		"a path in the interface name":         func(a *NetworkConfigureArgs) { a.Interface = "../../etc" },
		"an interface longer than IFNAMSIZ":    func(a *NetworkConfigureArgs) { a.Interface = strings.Repeat("e", 16) },
		"an address that is not an address":    func(a *NetworkConfigureArgs) { a.Addresses = []string{"10.0.0.1; rm -rf /"} },
		"an address without a prefix length":   func(a *NetworkConfigureArgs) { a.Addresses = []string{"10.0.0.1"} },
		"an out-of-range octet":                func(a *NetworkConfigureArgs) { a.Addresses = []string{"999.0.0.1/24"} },
		"an out-of-range prefix":               func(a *NetworkConfigureArgs) { a.Addresses = []string{"10.0.0.1/33"} },
		"a gateway that is a hostname":         func(a *NetworkConfigureArgs) { a.Gateway = "gateway.internal" },
		"a DNS entry with a port":              func(a *NetworkConfigureArgs) { a.DNS = []string{"10.0.0.1:53"} },
		"a search domain with a slash":         func(a *NetworkConfigureArgs) { a.SearchDomains = []string{"lab/internal"} },
		"an unsupported adapter":               func(a *NetworkConfigureArgs) { a.Adapter = "netplan" },
		"an empty adapter":                     func(a *NetworkConfigureArgs) { a.Adapter = "" },
	}
	for name, mutate := range cases {
		args := validNetworkArgs()
		mutate(args)
		if err := args.validate(); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
}

func TestNetworkRefusesTakingAnInterfaceOutOfService(t *testing.T) {
	// "disabled" and "link-local" would leave the host without the interface
	// somebody asked to configure. There is no supported way to request that.
	for _, method := range []string{"disabled", "link-local", "shared", "", "AUTO", "dhcp"} {
		args := validNetworkArgs()
		args.Method = method
		if err := args.validate(); err == nil {
			t.Errorf("method %q must be refused", method)
		}
	}
}

func TestNetworkRefusesTheManagementInterface(t *testing.T) {
	// The interface carrying the default route is how this control center
	// reaches the host. It is refused here, again by the backend, and again by
	// the executor against the live routing table.
	args := validNetworkArgs()
	args.Interface = "eth0"
	args.PreState.DefaultRouteInterface = "eth0"
	err := args.validate()
	if err == nil {
		t.Fatal("reconfiguring the interface carrying the default route must be refused")
	}
	if !strings.Contains(err.Error(), "default route") {
		t.Errorf("the refusal must name the reason, got %q", err)
	}
}

func TestNetworkRollbackIsNotOptional(t *testing.T) {
	// There is no "no rollback" value. A network change this platform cannot
	// undo is one it does not make.
	for _, seconds := range []int{0, -1, MinRollbackSeconds - 1, MaxRollbackSeconds + 1, 100000} {
		args := validNetworkArgs()
		args.RollbackSeconds = seconds
		if err := args.validate(); err == nil {
			t.Errorf("rollbackSeconds %d must be refused", seconds)
		}
	}
}

func TestNetworkMethodAndAddressesMustAgree(t *testing.T) {
	manualWithoutAddress := validNetworkArgs()
	manualWithoutAddress.Addresses = nil
	if err := manualWithoutAddress.validate(); err == nil {
		t.Error("a manual configuration without an address must be refused")
	}

	autoWithAddress := validNetworkArgs()
	autoWithAddress.Method = "auto"
	if err := autoWithAddress.validate(); err == nil {
		t.Error("an automatic configuration must not also carry static addresses")
	}

	autoWithGateway := validNetworkArgs()
	autoWithGateway.Method = "auto"
	autoWithGateway.Addresses = nil
	autoWithGateway.Gateway = "10.0.0.1"
	if err := autoWithGateway.validate(); err == nil {
		t.Error("an automatic configuration must not also carry a static gateway")
	}

	auto := validNetworkArgs()
	auto.Method = "auto"
	auto.Addresses = nil
	if err := auto.validate(); err != nil {
		t.Errorf("a plain automatic configuration must be accepted: %v", err)
	}
}

func TestNetworkBoundsAreEnforced(t *testing.T) {
	tooMany := validNetworkArgs()
	for i := 0; i <= MaxLinkAddresses; i++ {
		tooMany.Addresses = append(tooMany.Addresses, "10.0.0.1/24")
	}
	if err := tooMany.validate(); err == nil {
		t.Error("an unbounded address list must be refused")
	}

	duplicate := validNetworkArgs()
	duplicate.Addresses = []string{"10.0.0.1/24", "10.0.0.1/24"}
	if err := duplicate.validate(); err == nil {
		t.Error("a duplicated address must be refused")
	}

	for _, mtu := range []int{1, 68, MinMTU - 1, MaxMTU + 1, -1500} {
		args := validNetworkArgs()
		args.MTU = mtu
		if err := args.validate(); err == nil {
			t.Errorf("mtu %d must be refused", mtu)
		}
	}
	unchanged := validNetworkArgs()
	unchanged.MTU = 0
	if err := unchanged.validate(); err != nil {
		t.Errorf("mtu 0 means unchanged and must be accepted: %v", err)
	}
}

func TestNetworkRequiresTheStateItWasReviewedAgainst(t *testing.T) {
	args := validNetworkArgs()
	args.PreState = nil
	if err := args.validate(); err == nil {
		t.Error("a network change must carry the state it was reviewed against")
	}
}

func TestMountArgsAndItsRefusals(t *testing.T) {
	valid := func() *MountConfigureArgs {
		return &MountConfigureArgs{
			Adapter:        SupportedStorageAdapter,
			FilesystemUUID: "2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c",
			MountPoint:     "/srv/data",
			FSType:         "ext4",
			NoExec:         true,
			PreState:       &MountPreState{FSType: "ext4", SizeBytes: 100},
		}
	}
	if err := valid().validate(); err != nil {
		t.Fatalf("a well-formed mount must be accepted: %v", err)
	}

	cases := map[string]func(*MountConfigureArgs){
		"a device path instead of a uuid":        func(a *MountConfigureArgs) { a.FilesystemUUID = "/dev/sdb1" },
		"a malformed uuid":                       func(a *MountConfigureArgs) { a.FilesystemUUID = "not-a-uuid" },
		"a traversal in the mount point":         func(a *MountConfigureArgs) { a.MountPoint = "/srv/../etc" },
		"a relative mount point":                 func(a *MountConfigureArgs) { a.MountPoint = "srv/data" },
		"a shell fragment in the path":           func(a *MountConfigureArgs) { a.MountPoint = "/srv/data; reboot" },
		"a hidden directory segment":             func(a *MountConfigureArgs) { a.MountPoint = "/srv/.ssh" },
		"a filesystem this agent will not mount": func(a *MountConfigureArgs) { a.FSType = "btrfs" },
		"a filesystem type that is a flag":       func(a *MountConfigureArgs) { a.FSType = "--bind" },
		"an unsupported adapter":                 func(a *MountConfigureArgs) { a.Adapter = "fstab" },
		"a reviewed type that disagrees":         func(a *MountConfigureArgs) { a.PreState.FSType = "xfs" },
		"no reviewed state at all":               func(a *MountConfigureArgs) { a.PreState = nil },
	}
	for name, mutate := range cases {
		args := valid()
		mutate(args)
		if err := args.validate(); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
}

func TestGrowIsStructurallyGrowOnly(t *testing.T) {
	valid := func() *FilesystemGrowArgs {
		return &FilesystemGrowArgs{
			Adapter:    SupportedStorageAdapter,
			MountPoint: "/srv/data",
			PreState: &FilesystemGrowPreState{
				Device: "/dev/sdb1", FSType: "ext4",
				SizeBytes: 100, DeviceBytes: 200,
			},
		}
	}
	if err := valid().validate(); err != nil {
		t.Fatalf("a well-formed growth must be accepted: %v", err)
	}

	// There is no size field to shrink with, so the only way to express a
	// shrink would be a device smaller than the filesystem — which is refused
	// before anything is dispatched.
	shrink := valid()
	shrink.PreState.DeviceBytes = 50
	if err := shrink.validate(); err == nil {
		t.Error("a device smaller than the filesystem must be refused")
	}
	equal := valid()
	equal.PreState.DeviceBytes = 100
	if err := equal.validate(); err == nil {
		t.Error("no headroom means nothing to grow into and must be refused")
	}

	for _, fsType := range []string{"btrfs", "zfs", "vfat", "ext2", "", "ext4 --force"} {
		args := valid()
		args.PreState.FSType = fsType
		if err := args.validate(); err == nil {
			t.Errorf("growing %q must be refused", fsType)
		}
	}
	missing := valid()
	missing.PreState = nil
	if err := missing.validate(); err == nil {
		t.Error("growth must carry the sizes it was reviewed against")
	}
}

func TestImageArgsRequireADigest(t *testing.T) {
	valid := func() *OSImageArgs {
		return &OSImageArgs{
			Adapter:  AdapterBootc,
			Image:    "registry.example.com/polyon/os@sha256:" + strings.Repeat("b", 64),
			PreState: &OSImagePreState{Model: AdapterBootc, RollbackAvailable: true},
		}
	}
	if err := valid().validate(OpOSImageStage); err != nil {
		t.Fatalf("a digest-pinned image must be accepted: %v", err)
	}

	// A tag can be moved by whoever controls the registry, which makes it a
	// target nobody can review.
	cases := map[string]string{
		"a bare tag":                "registry.example.com/polyon/os:v1",
		"no reference at all":       "registry.example.com/polyon/os",
		"a short digest":            "registry.example.com/polyon/os@sha256:abc",
		"a non-sha256 digest":       "registry.example.com/polyon/os@md5:" + strings.Repeat("b", 32),
		"a uppercase digest":        "registry.example.com/polyon/os@sha256:" + strings.Repeat("B", 64),
		"a shell fragment":          "registry.example.com/os@sha256:" + strings.Repeat("b", 64) + "; reboot",
		"a file transport":          "oci-archive:/tmp/evil.tar",
		"a url":                     "https://registry.example.com/polyon/os",
		"an empty image on a stage": "",
	}
	for name, image := range cases {
		args := valid()
		args.Image = image
		if err := args.validate(OpOSImageStage); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}

	for _, adapter := range []string{"snapd", "snap", "apt", "ostree", ""} {
		args := valid()
		args.Adapter = adapter
		args.PreState.Model = adapter
		if err := args.validate(OpOSImageStage); err == nil {
			t.Errorf("adapter %q must be refused", adapter)
		}
	}
}

func TestImageOperationsNeverReboot(t *testing.T) {
	// The field exists on the wire so a later build cannot start honouring it
	// without this check being deliberately removed.
	for _, operation := range []string{OpOSImageStage, OpOSImageRollback} {
		args := &OSImageArgs{
			Adapter:     AdapterBootc,
			RebootAfter: true,
			PreState:    &OSImagePreState{Model: AdapterBootc, RollbackAvailable: true},
		}
		if operation == OpOSImageStage {
			args.Image = "registry.example.com/os@sha256:" + strings.Repeat("b", 64)
		}
		err := args.validate(operation)
		if err == nil {
			t.Fatalf("%s must refuse rebootAfter", operation)
		}
		if !strings.Contains(err.Error(), "never reboot") {
			t.Errorf("the refusal must say so plainly, got %q", err)
		}
	}
}

func TestRollbackNamesNoImageAndNeedsSomewhereToGo(t *testing.T) {
	named := &OSImageArgs{
		Adapter:  AdapterBootc,
		Image:    "registry.example.com/os@sha256:" + strings.Repeat("b", 64),
		PreState: &OSImagePreState{Model: AdapterBootc, RollbackAvailable: true},
	}
	if err := named.validate(OpOSImageRollback); err == nil {
		t.Error("a rollback that names an image is a different operation wearing this one's name")
	}

	nowhere := &OSImageArgs{
		Adapter:  AdapterBootc,
		PreState: &OSImagePreState{Model: AdapterBootc, RollbackAvailable: false},
	}
	if err := nowhere.validate(OpOSImageRollback); err == nil {
		t.Error("a rollback with no previous deployment must be refused")
	}
}

func TestPlanCarriesExactlyOneStage4Block(t *testing.T) {
	now := time.Now()
	p := stage4Base(OpNetworkConfigure, now)
	p.Network = validNetworkArgs()
	p.Mount = &MountConfigureArgs{}
	if err := p.Validate(Identity{ControlCenterID: "cc2", HostID: "node-a"}, now); err == nil {
		t.Error("two argument blocks must be refused")
	}

	none := stage4Base(OpNetworkConfigure, now)
	if err := none.Validate(Identity{ControlCenterID: "cc2", HostID: "node-a"}, now); err == nil {
		t.Error("no argument block must be refused")
	}
}

func TestStage4OperationRequiresItsOwnBlock(t *testing.T) {
	now := time.Now()
	self := Identity{ControlCenterID: "cc2", HostID: "node-a"}
	// An operation carrying somebody else's arguments must never be run by
	// analogy: mount.configure with a grow block is not a growth request.
	p := stage4Base(OpMountConfigure, now)
	p.FilesystemGrow = &FilesystemGrowArgs{
		Adapter: SupportedStorageAdapter, MountPoint: "/srv/data",
		PreState: &FilesystemGrowPreState{FSType: "ext4", SizeBytes: 1, DeviceBytes: 2},
	}
	if err := p.Validate(self, now); err == nil {
		t.Error("mount.configure carrying a grow block must be refused")
	}
}

func TestStage4ReceiptsAreAccepted(t *testing.T) {
	// An operation the receipt validator does not know would run and then be
	// unable to report its own result.
	for _, operation := range []string{
		OpNetworkConfigure, OpMountConfigure, OpFilesystemGrow, OpOSImageStage, OpOSImageRollback,
	} {
		receipt := Receipt{
			SchemaVersion:   ReceiptSchemaVersion,
			OperationID:     "2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f",
			Attempt:         1,
			ControlCenterID: "cc2",
			HostID:          "node-a",
			Operation:       operation,
			ContentDigest:   "sha256:" + strings.Repeat("0", 64),
			Outcome:         OutcomeSucceeded,
			StartedAt:       time.Now().Add(-time.Second),
			FinishedAt:      time.Now(),
			Evidence:        map[string]string{"rollbackState": "confirmed"},
		}
		if err := receipt.Validate(); err != nil {
			t.Errorf("%s receipt must validate: %v", operation, err)
		}
	}
}

func TestStage4DigestBindsThePreState(t *testing.T) {
	// The observed pre-state is part of what an approver binds. If it were
	// outside the digest, a control center could change the state a plan claims
	// to have been reviewed against without invalidating the approval.
	now := time.Now()
	build := func(mutate func(*Plan)) string {
		p := stage4Base(OpFilesystemGrow, now)
		p.FilesystemGrow = &FilesystemGrowArgs{
			Adapter: SupportedStorageAdapter, MountPoint: "/srv/data",
			PreState: &FilesystemGrowPreState{
				Device: "/dev/sdb1", FSType: "ext4", SizeBytes: 100, DeviceBytes: 200,
			},
		}
		if mutate != nil {
			mutate(&p)
		}
		digest, err := p.CanonicalContentDigest()
		if err != nil {
			t.Fatalf("digest: %v", err)
		}
		return digest
	}

	base := build(nil)
	for name, mutate := range map[string]func(*Plan){
		"a different reviewed size":   func(p *Plan) { p.FilesystemGrow.PreState.SizeBytes = 101 },
		"a different reviewed device": func(p *Plan) { p.FilesystemGrow.PreState.Device = "/dev/sdc1" },
		"a different mount point":     func(p *Plan) { p.FilesystemGrow.MountPoint = "/srv/other" },
		"no pre-state at all":         func(p *Plan) { p.FilesystemGrow.PreState = nil },
	} {
		if build(mutate) == base {
			t.Errorf("%s must change the content digest", name)
		}
	}
}

func TestNetworkDigestBindsTheRollbackWindow(t *testing.T) {
	// The rollback window is what an approver agrees the host may spend
	// unreachable. Changing it after approval must invalidate the approval.
	now := time.Now()
	build := func(seconds int) string {
		p := stage4Base(OpNetworkConfigure, now)
		p.Network = validNetworkArgs()
		p.Network.RollbackSeconds = seconds
		digest, err := p.CanonicalContentDigest()
		if err != nil {
			t.Fatalf("digest: %v", err)
		}
		return digest
	}
	if build(120) == build(600) {
		t.Error("the rollback window must be part of the approved content")
	}
}

func TestStage4PlanRejectsUnknownFields(t *testing.T) {
	// A field this build does not understand usually means a downgrade attempt
	// or a version skew, and dropping it silently would run an operation
	// missing something a human approved.
	now := time.Now()
	p := stage4Base(OpNetworkConfigure, now)
	p.Network = validNetworkArgs()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	tampered := strings.Replace(string(raw), `"network":{`, `"network":{"rawArgs":"--delete",`, 1)
	if _, err := Parse([]byte(tampered), Identity{ControlCenterID: "cc2", HostID: "node-a"}, now); err == nil {
		t.Fatal("an unknown field inside a Stage 4 block must be refused")
	}
}
