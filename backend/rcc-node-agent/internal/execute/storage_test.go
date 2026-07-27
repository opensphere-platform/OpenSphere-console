package execute

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"opensphere.io/rcc/node-agent/internal/plan"
)

const testUUID = "2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c"

// A bare number, optionally with a unit suffix, is how both resize2fs and
// xfs_growfs are told to use less than the whole device.
var sizeOperandRe = regexp.MustCompile(`^[0-9]+[sSkKmMgGtT]?$`)

// devRootWithUUID fakes /dev/disk/by-uuid so a mount can be exercised without
// creating a device node.
func devRootWithUUID(t *testing.T, uuid string) string {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "disk", "by-uuid")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if uuid != "" {
		if err := os.WriteFile(filepath.Join(dir, uuid), []byte(""), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	return root
}

// fsRootWithDirs fakes the host's directory tree so mount point resolution can
// be exercised without touching real system paths.
func fsRootWithDirs(t *testing.T, dirs ...string) string {
	t.Helper()
	// t.TempDir sits under /var on macOS, which is itself a symlink. Resolving
	// once here keeps the seam honest without every test having to know that.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolve temp root: %v", err)
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	return root
}

func newStorageExecutor(t *testing.T, runner Runner) *StorageExecutor {
	t.Helper()
	clock := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	return &StorageExecutor{
		Runner:        runner,
		Enabled:       true,
		MountRoots:    []string{"/srv", "/mnt"},
		GrowAllowlist: []string{"/srv/data"},
		UnitDir:       t.TempDir(),
		DevRoot:       devRootWithUUID(t, testUUID),
		FsRoot:        fsRootWithDirs(t, "srv/data", "mnt"),
		FindmntPath:   "/usr/bin/findmnt",
		SystemctlPath: "/usr/bin/systemctl",
		Resize2fsPath: "/usr/sbin/resize2fs",
		XFSGrowfsPath: "/usr/sbin/xfs_growfs",
		Now:           func() time.Time { return clock },
	}
}

func mountArgs() *plan.MountConfigureArgs {
	return &plan.MountConfigureArgs{
		Adapter:        plan.SupportedStorageAdapter,
		FilesystemUUID: testUUID,
		MountPoint:     "/srv/data",
		FSType:         "ext4",
		NoExec:         true,
		NoSuid:         true,
		NoDev:          true,
		PreState:       &plan.MountPreState{FSType: "ext4", SizeBytes: 100},
	}
}

func growArgs(fsType string) *plan.FilesystemGrowArgs {
	return &plan.FilesystemGrowArgs{
		Adapter:    plan.SupportedStorageAdapter,
		MountPoint: "/srv/data",
		PreState: &plan.FilesystemGrowPreState{
			Device: "/dev/sdb1", FSType: fsType, SizeBytes: 100, DeviceBytes: 200,
		},
	}
}

// ── protected resources ─────────────────────────────────────────────────────

func TestProtectedPathsAreNeverMountedOverOrGrown(t *testing.T) {
	executor := newStorageExecutor(t, &scriptedRunner{})
	// Configuration cannot re-enable these: the allowlist is checked after the
	// built-in protections, not instead of them.
	executor.MountRoots = append(executor.MountRoots, "/var", "/boot")
	executor.GrowAllowlist = append(executor.GrowAllowlist, "/", "/boot", "/var/lib/rancher")

	for _, path := range []string{"/", "/boot", "/var/lib/rancher/k3s/storage", "/etc", "/var/lib/etcd"} {
		if err := executor.MountPointAllowed(path); err == nil {
			t.Errorf("mounting over %s must be refused", path)
		}
		if err := executor.GrowAllowed(path); err == nil {
			t.Errorf("growing %s must be refused", path)
		}
	}
}

func TestAMountPointOutsideEveryDeclaredRootIsRefused(t *testing.T) {
	executor := newStorageExecutor(t, &scriptedRunner{})
	if err := executor.MountPointAllowed("/opt/elsewhere"); !errors.Is(err, ErrMountRootNotAllowed) {
		t.Fatalf("an undeclared root must be refused, got %v", err)
	}
	// The root itself is never a target: mounting onto /srv would hide what is
	// already there.
	if err := executor.MountPointAllowed("/srv"); err == nil {
		t.Error("a mount root is never itself a valid mount point")
	}
	if err := executor.MountPointAllowed("/srv/data"); err != nil {
		t.Errorf("a path beneath a declared root must be allowed: %v", err)
	}
}

func TestStorageAuthorityIsOffByDefault(t *testing.T) {
	executor := newStorageExecutor(t, &scriptedRunner{})
	executor.Enabled = false
	if err := executor.MountPointAllowed("/srv/data"); !errors.Is(err, ErrStorageNotEnabled) {
		t.Errorf("a host without storage authority must refuse a mount, got %v", err)
	}
	if err := executor.GrowAllowed("/srv/data"); !errors.Is(err, ErrStorageNotEnabled) {
		t.Errorf("a host without storage authority must refuse a growth, got %v", err)
	}
}

// ── generated mount unit ────────────────────────────────────────────────────

func TestTheGeneratedUnitIsAssembledFromValidatedFieldsOnly(t *testing.T) {
	unit := renderMountUnit(mountArgs())
	for _, want := range []string{
		"What=/dev/disk/by-uuid/" + testUUID,
		"Where=/srv/data",
		"Type=ext4",
		// nofail is not optional: a device that is absent at boot must never
		// keep the host down, which is the failure mode fstab has and this
		// deliberately does not.
		"Options=nofail,noexec,nosuid,nodev",
		"# Generated by rcc-node-agent.",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("the generated unit is missing %q:\n%s", want, unit)
		}
	}
	// Nothing that would let a unit do more than mount.
	for _, forbidden := range []string{"ExecStart", "ExecStartPre", "Exec", "/bin/sh", "${"} {
		if strings.Contains(unit, forbidden) {
			t.Errorf("the generated unit must not contain %q:\n%s", forbidden, unit)
		}
	}
	readOnly := mountArgs()
	readOnly.ReadOnly = true
	if !strings.Contains(renderMountUnit(readOnly), "Options=nofail,ro,noexec,nosuid,nodev") {
		t.Error("a read-only mount must carry ro")
	}
}

func TestMountUnitNameMatchesSystemdEscaping(t *testing.T) {
	cases := map[string]string{
		"/srv/data":     "srv-data.mount",
		"/mnt/a/b":      "mnt-a-b.mount",
		"/srv/data-one": "srv-data-one.mount",
	}
	for path, want := range cases {
		got, err := mountUnitName(path)
		if err != nil {
			t.Fatalf("mountUnitName(%q): %v", path, err)
		}
		if got != want {
			t.Errorf("mountUnitName(%q) = %q, want %q", path, got, want)
		}
	}
	// A character that would need \xNN escaping is refused rather than guessed
	// at; the plan grammar already excludes all of them.
	for _, path := range []string{"/", "", "/srv/a b", "/srv/a:b", "/srv/a\nb"} {
		if _, err := mountUnitName(path); err == nil {
			t.Errorf("mountUnitName(%q) must be refused", path)
		}
	}
}

// ── mount behaviour ─────────────────────────────────────────────────────────

func TestAMountIsStartedBeforeItIsEnabled(t *testing.T) {
	// A unit that will not mount now is a unit that would have failed at every
	// boot. Enabling first would persist exactly that.
	runner := &scriptedRunner{results: []Result{
		{ExitCode: 1},           // findmnt: device not mounted anywhere
		{ExitCode: 1},           // findmnt: nothing at the target
		{ExitCode: 0},           // daemon-reload
		{ExitCode: 0},           // start
		{Stdout: "/srv/data\n"}, // findmnt confirmation
		{ExitCode: 0},           // enable
	}}
	executor := newStorageExecutor(t, runner)
	_, evidence, err := executor.ConfigureMount(context.Background(), mountArgs())
	if err != nil {
		t.Fatalf("mount: %v", err)
	}
	if evidence["persistent"] != "true" {
		t.Errorf("a completed mount must be persistent, evidence: %v", evidence)
	}
	joined := runner.joined()
	startAt := strings.Index(joined, "start --")
	enableAt := strings.Index(joined, "enable --")
	if startAt == -1 || enableAt == -1 || startAt > enableAt {
		t.Errorf("start must precede enable: %s", joined)
	}
	// The unit really was written.
	if _, err := os.Stat(filepath.Join(executor.UnitDir, "srv-data.mount")); err != nil {
		t.Errorf("the mount unit was not written: %v", err)
	}
}

func TestAMountThatWillNotStartLeavesNoUnitBehind(t *testing.T) {
	runner := &scriptedRunner{results: []Result{
		{ExitCode: 1}, // findmnt: device not mounted
		{ExitCode: 1}, // findmnt: nothing at the target
		{ExitCode: 0}, // daemon-reload
		{ExitCode: 1}, // start fails
	}}
	executor := newStorageExecutor(t, runner)
	_, evidence, err := executor.ConfigureMount(context.Background(), mountArgs())
	if err == nil {
		t.Fatal("a mount that will not start must fail the operation")
	}
	if evidence["rolledBack"] != "true" {
		t.Errorf("the failed attempt must be undone, evidence: %v", evidence)
	}
	if _, statErr := os.Stat(filepath.Join(executor.UnitDir, "srv-data.mount")); !os.IsNotExist(statErr) {
		t.Error("a unit that would fail at every boot must not be left on disk")
	}
}

func TestAUnitStartingWithoutActuallyMountingIsUndone(t *testing.T) {
	// systemd reporting success is not proof the path is a mount point. Only
	// the path being a mount point is.
	runner := &scriptedRunner{results: []Result{
		{ExitCode: 1}, // findmnt: device not mounted
		{ExitCode: 1}, // findmnt: nothing at the target
		{ExitCode: 0}, // daemon-reload
		{ExitCode: 0}, // start "succeeds"
		{ExitCode: 1}, // findmnt: still nothing there
	}}
	executor := newStorageExecutor(t, runner)
	if _, _, err := executor.ConfigureMount(context.Background(), mountArgs()); err == nil {
		t.Fatal("a mount that did not happen must fail the operation")
	}
	if _, statErr := os.Stat(filepath.Join(executor.UnitDir, "srv-data.mount")); !os.IsNotExist(statErr) {
		t.Error("the unit must be removed when the mount did not happen")
	}
}

func TestAFilesystemMountedElsewhereIsNotMoved(t *testing.T) {
	runner := &scriptedRunner{results: []Result{{Stdout: "/mnt/other\n"}}}
	executor := newStorageExecutor(t, runner)
	_, _, err := executor.ConfigureMount(context.Background(), mountArgs())
	if err == nil {
		t.Fatal("a filesystem already mounted elsewhere must be refused")
	}
	if !strings.Contains(err.Error(), "already mounted") {
		t.Errorf("the refusal must say why, got %q", err)
	}
}

func TestAUnitThisAgentDidNotWriteIsLeftAlone(t *testing.T) {
	executor := newStorageExecutor(t, &scriptedRunner{results: []Result{{ExitCode: 1}, {ExitCode: 1}}})
	unitPath := filepath.Join(executor.UnitDir, "srv-data.mount")
	if err := os.WriteFile(unitPath, []byte("[Mount]\nWhat=/dev/sda9\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, _, err := executor.ConfigureMount(context.Background(), mountArgs())
	if err == nil {
		t.Fatal("somebody else's unit must not be overwritten")
	}
	body, _ := os.ReadFile(unitPath)
	if !strings.Contains(string(body), "/dev/sda9") {
		t.Error("the existing unit was modified")
	}
}

func TestAnUnknownFilesystemUUIDIsRefused(t *testing.T) {
	executor := newStorageExecutor(t, &scriptedRunner{})
	executor.DevRoot = devRootWithUUID(t, "")
	if _, _, err := executor.ConfigureMount(context.Background(), mountArgs()); err == nil {
		t.Fatal("a uuid that is not present on this host must be refused")
	}
}

// ── growth ──────────────────────────────────────────────────────────────────

func TestGrowPassesNoSizeArgumentAtAll(t *testing.T) {
	// This is what makes the operation grow-only by construction: there is no
	// invocation this agent can build that makes a mounted filesystem smaller.
	// The `--` is what keeps a mount point that began with a dash from being
	// read as a flag, and it is the last argv position that could be.
	for fsType, want := range map[string][]string{
		"ext4": {"/usr/sbin/resize2fs", "--", "/srv/data"},
		"xfs":  {"/usr/sbin/xfs_growfs", "-d", "--", "/srv/data"},
	} {
		runner := &scriptedRunner{results: []Result{{Stdout: "/srv/data\n"}, {ExitCode: 0}}}
		executor := newStorageExecutor(t, runner)
		if _, _, err := executor.Grow(context.Background(), growArgs(fsType)); err != nil {
			t.Fatalf("%s growth: %v", fsType, err)
		}
		argv := runner.lastArgv()
		if len(argv) != len(want) {
			t.Fatalf("%s argv = %v, want %v", fsType, argv, want)
		}
		for i := range want {
			if argv[i] != want[i] {
				t.Errorf("%s argv[%d] = %q, want %q", fsType, i, argv[i], want[i])
			}
		}
		// A size operand would turn "use the whole device" into something else
		// entirely. The operands are checked, not the binary path: resize2fs
		// has a digit in its own name.
		for _, arg := range argv[1:] {
			if sizeOperandRe.MatchString(arg) {
				t.Errorf("%s argv carries something that could be read as a size: %v", fsType, argv)
			}
		}
	}
}

func TestGrowingAFilesystemThatMovedIsRefused(t *testing.T) {
	runner := &scriptedRunner{results: []Result{{Stdout: "/mnt/elsewhere\n"}}}
	executor := newStorageExecutor(t, runner)
	if _, _, err := executor.Grow(context.Background(), growArgs("ext4")); err == nil {
		t.Fatal("a path that is no longer a mount point must be refused")
	}
	if len(runner.calls) != 1 {
		t.Errorf("nothing may run after the refusal, got %s", runner.joined())
	}
}

func TestGrowingAnUnsupportedFilesystemIsRefused(t *testing.T) {
	for _, fsType := range []string{"btrfs", "zfs", "vfat", "ext2", ""} {
		runner := &scriptedRunner{results: []Result{{Stdout: "/srv/data\n"}}}
		executor := newStorageExecutor(t, runner)
		args := growArgs(fsType)
		if _, _, err := executor.Grow(context.Background(), args); err == nil {
			t.Errorf("growing %q must be refused", fsType)
		}
		if len(runner.calls) != 0 {
			t.Errorf("%s: nothing may run before the refusal", fsType)
		}
	}
}

func TestGrowingOutsideTheAllowlistIsRefused(t *testing.T) {
	runner := &scriptedRunner{}
	executor := newStorageExecutor(t, runner)
	executor.GrowAllowlist = []string{"/srv/other"}
	if _, _, err := executor.Grow(context.Background(), growArgs("ext4")); !errors.Is(err, ErrGrowNotAllowed) {
		t.Fatalf("an unallowlisted filesystem must be refused, got %v", err)
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run before the refusal, got %s", runner.joined())
	}
}

func TestAFailedGrowIsReportedRatherThanSwallowed(t *testing.T) {
	runner := &scriptedRunner{results: []Result{{Stdout: "/srv/data\n"}, {ExitCode: 1, Stdout: "no space"}}}
	executor := newStorageExecutor(t, runner)
	_, _, err := executor.Grow(context.Background(), growArgs("ext4"))
	if err == nil {
		t.Fatal("a non-zero exit must fail the operation")
	}
	if !strings.Contains(err.Error(), "resize2fs") {
		t.Errorf("the failure must name the tool, got %q", err)
	}
}

func TestAtomicWriteLeavesNoPartialUnit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "unit.mount")
	if err := writeFileAtomic(path, []byte("body"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	body, err := os.ReadFile(path)
	if err != nil || string(body) != "body" {
		t.Fatalf("read back %q: %v", body, err)
	}
	// The temporary file must not survive, or a crash would leave systemd
	// parsing something half-written on the next reload.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("expected only the final file, got %d entries", len(entries))
	}
}

func TestAFailedStartIsCaughtBeforeAnythingIsPersisted(t *testing.T) {
	// The confirmation check would also catch this, so the assertion is on the
	// distinguishing evidence: after a failed start nothing further runs, and
	// in particular `enable` never does.
	runner := &scriptedRunner{results: []Result{
		{ExitCode: 1},           // findmnt: device not mounted
		{ExitCode: 1},           // findmnt: nothing at the target
		{ExitCode: 0},           // daemon-reload
		{ExitCode: 1},           // start fails
		{Stdout: "/srv/data\n"}, // a confirmation that would wrongly succeed
		{ExitCode: 0},           // an enable that must never be reached
	}}
	executor := newStorageExecutor(t, runner)
	if _, _, err := executor.ConfigureMount(context.Background(), mountArgs()); err == nil {
		t.Fatal("a start that failed must fail the operation")
	}
	joined := runner.joined()
	if strings.Contains(joined, "enable --") {
		t.Errorf("a unit that would not start must never be enabled for boot: %s", joined)
	}
	if !strings.Contains(joined, "would not mount") && !strings.Contains(joined, "start --") {
		t.Errorf("the start must have been attempted: %s", joined)
	}
}

// ── the path that was reviewed is the path that is used ─────────────────────

func TestAMountPointReachedThroughASymlinkIsRefused(t *testing.T) {
	// Every other storage gate compares strings, and a string is not a path.
	// mount(2) resolves the final component, so anyone who can create a name
	// under an allowed root could otherwise aim an approved mount at /etc while
	// every string-level guard still reads "/srv/data".
	runner := &scriptedRunner{}
	executor := newStorageExecutor(t, runner)
	executor.FsRoot = fsRootWithDirs(t, "srv", "etc")
	if err := os.Symlink(filepath.Join(executor.FsRoot, "etc"),
		filepath.Join(executor.FsRoot, "srv", "data")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	_, _, err := executor.ConfigureMount(context.Background(), mountArgs())
	if err == nil {
		t.Fatal("a mount point that is a symbolic link must be refused")
	}
	if !strings.Contains(err.Error(), "symbolic link") {
		t.Errorf("the refusal must say why, got %q", err)
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run before the path is trusted, got %v", runner.calls)
	}
}

func TestAMountPointUnderASymlinkedParentIsRefused(t *testing.T) {
	// The leaf may legitimately not exist yet, so the redirection can just as
	// easily be placed one level up.
	runner := &scriptedRunner{}
	executor := newStorageExecutor(t, runner)
	executor.FsRoot = fsRootWithDirs(t, "etc")
	if err := os.Symlink(filepath.Join(executor.FsRoot, "etc"),
		filepath.Join(executor.FsRoot, "srv")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	_, _, err := executor.ConfigureMount(context.Background(), mountArgs())
	if err == nil {
		t.Fatal("a mount point beneath a symbolic link must be refused")
	}
	// Asserting the reason, not merely that something failed. With the parent
	// check removed the leaf simply looks absent, the mount proceeds, and the
	// unscripted runner raises an unrelated error that a bare err != nil would
	// have accepted as proof of a guard that was no longer there.
	if !strings.Contains(err.Error(), "symbolic link") {
		t.Errorf("the refusal must name the redirection, got %q", err)
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run before the path is trusted, got %v", runner.calls)
	}
}

func TestAMalformedFilesystemUUIDIsRefusedBeforeItBecomesAPath(t *testing.T) {
	// resolveUUID is the function that turns a string into a device path, and
	// filepath.Join cleans as it goes: a uuid carrying a traversal would escape
	// by-uuid and name any file on the host. The plan grammar rejects this too,
	// but this function does not get to assume its caller checked.
	for _, uuid := range []string{
		"../../etc/passwd",
		"2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c/../../../etc/shadow",
		"not-a-uuid",
		"",
	} {
		runner := &scriptedRunner{}
		executor := newStorageExecutor(t, runner)
		args := mountArgs()
		args.FilesystemUUID = uuid

		_, _, err := executor.ConfigureMount(context.Background(), args)
		if err == nil {
			t.Fatalf("uuid %q must be refused", uuid)
		}
		// Without the grammar check the traversal still fails, but as "no
		// filesystem with that uuid is present" — a lookup miss rather than a
		// refusal, and one that would succeed the moment the escaped path did
		// exist. The distinction is the whole guard.
		if !strings.Contains(err.Error(), "is not a filesystem uuid") {
			t.Errorf("uuid %q must be refused as malformed, got %q", uuid, err)
		}
		if len(runner.calls) != 0 {
			t.Errorf("nothing may run for uuid %q, got %v", uuid, runner.calls)
		}
	}
}

func TestGrowingThroughASymlinkIsRefused(t *testing.T) {
	// A grow follows the same rule for a sharper reason: resize2fs resolves the
	// path too, so a redirected mount point grows somebody else's filesystem.
	runner := &scriptedRunner{}
	executor := newStorageExecutor(t, runner)
	executor.FsRoot = fsRootWithDirs(t, "srv", "etc")
	if err := os.Symlink(filepath.Join(executor.FsRoot, "etc"),
		filepath.Join(executor.FsRoot, "srv", "data")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if _, _, err := executor.Grow(context.Background(), growArgs("ext4")); err == nil {
		t.Fatal("growing through a symbolic link must be refused")
	}
	if len(runner.calls) != 0 {
		t.Errorf("nothing may run before the path is trusted, got %v", runner.calls)
	}
}

func TestARealDirectoryUnderAnAllowedRootIsStillAllowed(t *testing.T) {
	// The check must refuse redirection without refusing the ordinary case.
	executor := newStorageExecutor(t, &scriptedRunner{})
	if err := executor.MountPointAllowed("/srv/data"); err != nil {
		t.Fatalf("a real directory beneath a declared root must be allowed: %v", err)
	}
	if err := executor.MountPointAllowed("/srv/not-created-yet"); err != nil {
		t.Fatalf("a leaf that does not exist yet must still be allowed: %v", err)
	}
}

func TestResolveUUIDRefusesAnythingThatIsNotAUUID(t *testing.T) {
	// filepath.Join cleans its argument, so a traversal here would silently
	// escape by-uuid and name any file on the host. The plan grammar already
	// forbids it; this function does not get to assume its caller checked.
	executor := newStorageExecutor(t, &scriptedRunner{})
	for _, candidate := range []string{
		"../../../etc/passwd",
		"..",
		"2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c/../../../etc/shadow",
		"",
	} {
		if _, err := executor.resolveUUID(candidate); err == nil {
			t.Errorf("resolveUUID(%q) must be refused", candidate)
		}
	}
	if _, err := executor.resolveUUID(testUUID); err != nil {
		t.Errorf("a real uuid must still resolve: %v", err)
	}
}
