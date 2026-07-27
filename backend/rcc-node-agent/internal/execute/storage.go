package execute

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"opensphere.io/rcc/node-agent/internal/guard"
	"opensphere.io/rcc/node-agent/internal/plan"
)

// Fixed binary allowlists. None of these is resolved from PATH.
var (
	resize2fsPaths = []string{"/usr/sbin/resize2fs", "/sbin/resize2fs"}
	xfsGrowfsPaths = []string{"/usr/sbin/xfs_growfs", "/sbin/xfs_growfs"}
	findmntPaths   = []string{"/usr/bin/findmnt", "/bin/findmnt"}
)

const (
	storageReadTimeout = 30 * time.Second
	growTimeout        = 10 * time.Minute
	mountTimeout       = 2 * time.Minute
	maxStorageOutput   = 16 * 1024
	// The generated unit is small and fully templated. The bound exists so a
	// mistake in generation cannot write an arbitrarily large file.
	maxUnitBytes = 4 * 1024
)

var (
	// ErrStorageNotEnabled is returned when the host was never given storage
	// authority.
	ErrStorageNotEnabled = errors.New("storage operations are not enabled on this host")
	// ErrMountRootNotAllowed is returned when a mount point is outside every
	// allowed root.
	ErrMountRootNotAllowed = errors.New("mount point is not beneath an allowed root on this host")
	// ErrGrowNotAllowed is returned when a filesystem is outside the host
	// allowlist.
	ErrGrowNotAllowed = errors.New("filesystem is not in the agent grow allowlist")
)

// StorageExecutor performs the two non-destructive storage changes.
//
// What it cannot do is as important as what it can. There is no code path here
// that formats a filesystem, writes a partition table, shrinks anything,
// changes /etc/fstab, or accepts a device path, a mount option string or a tool
// argument from a plan. A request for any of those is not refused at runtime —
// it cannot be expressed.
type StorageExecutor struct {
	Runner Runner
	// Enabled is the host's own switch.
	Enabled bool
	// MountRoots are the directories beneath which a mount point may be created.
	MountRoots []string
	// GrowAllowlist names the mount points this host permits growing.
	GrowAllowlist []string
	Now           func() time.Time
	// UnitDir is where generated mount units are written. A test seam;
	// production leaves it empty and /etc/systemd/system is used.
	UnitDir string
	// Test seams for binary resolution.
	Resize2fsPath string
	XFSGrowfsPath string
	FindmntPath   string
	SystemctlPath string
	// DevRoot is a test seam for resolving /dev/disk/by-uuid.
	DevRoot string
	// FsRoot is a test seam for inspecting mount point paths on disk.
	// Production leaves it empty and paths are resolved as given.
	FsRoot string
}

func (e *StorageExecutor) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *StorageExecutor) unitDir() string {
	if e.UnitDir != "" {
		return e.UnitDir
	}
	return "/etc/systemd/system"
}

func (e *StorageExecutor) devRoot() string {
	if e.DevRoot != "" {
		return e.DevRoot
	}
	return "/dev"
}

func (e *StorageExecutor) fsRoot() string {
	if e.FsRoot != "" {
		return e.FsRoot
	}
	return "/"
}

// checkTargetPath re-checks a mount point against the filesystem itself.
//
// Every other gate here compares strings, and a string is not a path: if
// /srv/data is a symbolic link to /etc then the path that was reviewed and the
// directory the kernel would actually act on are two different things, because
// mount(2), resize2fs and xfs_growfs all resolve the final component. Anyone
// who can create a name under an allowed mount root could otherwise redirect an
// approved operation onto a protected directory, and no string-level guard
// would see it.
func (e *StorageExecutor) checkTargetPath(mountPoint string) error {
	cleaned := guard.Normalize(mountPoint)
	root, err := filepath.EvalSymlinks(e.fsRoot())
	if err != nil {
		return fmt.Errorf("the filesystem root cannot be resolved: %w", err)
	}
	want := filepath.Join(root, cleaned)
	parentWanted := filepath.Dir(want)
	parent, err := filepath.EvalSymlinks(parentWanted)
	if err != nil {
		return fmt.Errorf("%s cannot be resolved on this host: %w", filepath.Dir(cleaned), err)
	}
	if parent != parentWanted {
		return fmt.Errorf(
			"%s is reached through a symbolic link and resolves to %s; that is not the path that was reviewed",
			filepath.Dir(cleaned), display(root, parent))
	}
	// The leaf itself may legitimately not exist yet, but if it does exist it
	// must be a real directory entry rather than a link to somewhere else.
	info, err := os.Lstat(want)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("%s cannot be inspected on this host: %w", cleaned, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf(
			"%s is a symbolic link; this agent acts on real directories only", cleaned)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", cleaned)
	}
	return nil
}

// display renders a resolved path back in the host's own terms.
func display(root, path string) string {
	if root == "/" {
		return path
	}
	trimmed := strings.TrimPrefix(path, root)
	if trimmed == "" {
		return "/"
	}
	return trimmed
}

func (e *StorageExecutor) systemctl() (string, error) {
	if e.SystemctlPath != "" {
		return e.SystemctlPath, nil
	}
	return resolveBinary(systemctlPaths)
}

func (e *StorageExecutor) findmnt() (string, error) {
	if e.FindmntPath != "" {
		return e.FindmntPath, nil
	}
	return resolveBinary(findmntPaths)
}

// MountPointAllowed reports whether a new mount point may be created here.
//
// Three gates, all of which must pass: the built-in protected list, which no
// configuration can override; the host's own declared roots; and the rule that
// a root itself is never a target, because mounting onto /srv would hide
// whatever is already there.
func (e *StorageExecutor) MountPointAllowed(mountPoint string) error {
	if !e.Enabled {
		return ErrStorageNotEnabled
	}
	if protected, reason := guard.ProtectedMountPoint(mountPoint); protected {
		return fmt.Errorf("%s is protected (%s) and is never mounted over by this agent", mountPoint, reason)
	}
	under := false
	for _, root := range e.MountRoots {
		if guard.UnderRoot(mountPoint, root) {
			under = true
			break
		}
	}
	if !under {
		return fmt.Errorf("%w: %s", ErrMountRootNotAllowed, mountPoint)
	}
	return e.checkTargetPath(mountPoint)
}

// GrowAllowed reports whether a filesystem may be grown on this host.
func (e *StorageExecutor) GrowAllowed(mountPoint string) error {
	if !e.Enabled {
		return ErrStorageNotEnabled
	}
	if protected, reason := guard.ProtectedMountPoint(mountPoint); protected {
		return fmt.Errorf("%s is protected (%s) and is never grown by this agent", mountPoint, reason)
	}
	normalized := guard.Normalize(mountPoint)
	for _, allowed := range e.GrowAllowlist {
		if guard.Normalize(allowed) == normalized {
			return e.checkTargetPath(mountPoint)
		}
	}
	return fmt.Errorf("%w: %s", ErrGrowNotAllowed, mountPoint)
}

// mountUnitName renders the systemd unit name for a path.
//
// systemd's escaping rule for a mount unit is: strip the leading slash, replace
// the remaining slashes with dashes, and escape anything outside [A-Za-z0-9:_.]
// as \xNN. The path grammar in the plan package already excludes every
// character that would need escaping, so this stays a total function over the
// inputs that can actually reach it, and refuses anything else.
func mountUnitName(mountPoint string) (string, error) {
	cleaned := guard.Normalize(mountPoint)
	if cleaned == "" || cleaned == "/" || !strings.HasPrefix(cleaned, "/") {
		return "", fmt.Errorf("%q is not a mountable path", mountPoint)
	}
	trimmed := strings.TrimPrefix(cleaned, "/")
	for _, r := range trimmed {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.', r == '_', r == '-', r == '/':
		default:
			return "", fmt.Errorf("%q contains a character this agent will not escape into a unit name", mountPoint)
		}
	}
	return strings.ReplaceAll(trimmed, "/", "-") + ".mount", nil
}

// renderMountUnit builds the unit text from validated fields only.
//
// Every byte is either a literal in this function or a value that has already
// been through a closed grammar. There is no field anywhere that carries unit
// text, an option string or a device path, so there is nothing to inject into.
func renderMountUnit(args *plan.MountConfigureArgs) string {
	options := []string{"nofail"}
	if args.ReadOnly {
		options = append(options, "ro")
	}
	if args.NoExec {
		options = append(options, "noexec")
	}
	if args.NoSuid {
		options = append(options, "nosuid")
	}
	if args.NoDev {
		options = append(options, "nodev")
	}

	var builder strings.Builder
	builder.WriteString("# Generated by rcc-node-agent. Do not edit.\n")
	builder.WriteString("# Every field below comes from an approved, typed operation.\n")
	builder.WriteString("[Unit]\n")
	builder.WriteString("Description=RCC managed mount " + args.MountPoint + "\n")
	builder.WriteString("DefaultDependencies=no\n")
	builder.WriteString("Conflicts=umount.target\n")
	builder.WriteString("Before=umount.target\n")
	builder.WriteString("\n[Mount]\n")
	builder.WriteString("What=/dev/disk/by-uuid/" + args.FilesystemUUID + "\n")
	builder.WriteString("Where=" + args.MountPoint + "\n")
	builder.WriteString("Type=" + args.FSType + "\n")
	builder.WriteString("Options=" + strings.Join(options, ",") + "\n")
	// A device that is slow to appear must not hold boot open indefinitely.
	builder.WriteString("TimeoutSec=30\n")
	builder.WriteString("\n[Install]\n")
	builder.WriteString("WantedBy=multi-user.target\n")
	return builder.String()
}

// resolveUUID checks that a filesystem UUID actually exists on this host and
// reports the device it names.
func (e *StorageExecutor) resolveUUID(uuid string) (string, error) {
	// filepath.Join cleans its result, so a uuid containing a traversal would
	// silently escape by-uuid and name any file on the host. The plan grammar
	// already forbids that, but this function is the thing that turns a string
	// into a device path and it does not get to assume its caller checked.
	if !plan.ValidFilesystemUUID(uuid) {
		return "", fmt.Errorf("%q is not a filesystem uuid", uuid)
	}
	link := filepath.Join(e.devRoot(), "disk", "by-uuid", uuid)
	target, err := os.Readlink(link)
	if err != nil {
		// A regular file is accepted too so the path can be faked in a test
		// without creating device nodes.
		if info, statErr := os.Stat(link); statErr == nil && !info.IsDir() {
			return link, nil
		}
		return "", fmt.Errorf("no filesystem with uuid %s is present on this host", uuid)
	}
	if filepath.IsAbs(target) {
		return target, nil
	}
	return filepath.Clean(filepath.Join(filepath.Dir(link), target)), nil
}

// mountedAt reports where a device or path is currently mounted, if anywhere.
func (e *StorageExecutor) mountedAt(ctx context.Context, target string) (string, error) {
	binary, err := e.findmnt()
	if err != nil {
		return "", fmt.Errorf("findmnt is unavailable: %w", err)
	}
	runCtx, cancel := context.WithTimeout(ctx, storageReadTimeout)
	defer cancel()
	result, err := e.Runner.Run(runCtx,
		[]string{binary, "--noheadings", "--output", "TARGET", "--first-only", "--", target},
		maxStorageOutput)
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 {
		// findmnt exits non-zero when nothing matches, which is the common and
		// entirely expected answer here.
		return "", nil
	}
	cleaned, _ := Sanitize(result.Stdout, 512)
	return strings.TrimSpace(cleaned), nil
}

// ConfigureMount makes an existing filesystem mount persistently.
func (e *StorageExecutor) ConfigureMount(ctx context.Context, args *plan.MountConfigureArgs) (Result, map[string]string, error) {
	evidence := map[string]string{
		"adapter":        plan.SupportedStorageAdapter,
		"mountPoint":     args.MountPoint,
		"filesystemUuid": args.FilesystemUUID,
		"fsType":         args.FSType,
	}
	if err := e.MountPointAllowed(args.MountPoint); err != nil {
		return Result{ExitCode: -1}, evidence, err
	}
	device, err := e.resolveUUID(args.FilesystemUUID)
	if err != nil {
		return Result{ExitCode: -1}, evidence, err
	}
	evidence["device"] = device
	if protected, reason := guard.ProtectedDevice(device); protected {
		return Result{ExitCode: -1}, evidence,
			fmt.Errorf("%s is protected (%s) and is never mounted by this agent", device, reason)
	}

	// A filesystem that is already mounted somewhere else is in use, and moving
	// it is not this operation.
	existing, err := e.mountedAt(ctx, device)
	if err != nil {
		return Result{ExitCode: -1}, evidence, err
	}
	if existing != "" && guard.Normalize(existing) != guard.Normalize(args.MountPoint) {
		return Result{ExitCode: -1}, evidence, fmt.Errorf(
			"that filesystem is already mounted at %s; this operation does not move a mounted filesystem", existing)
	}
	if args.PreState != nil && args.PreState.MountedAt != "" &&
		guard.Normalize(args.PreState.MountedAt) != guard.Normalize(existing) {
		return Result{ExitCode: -1}, evidence, fmt.Errorf(
			"this filesystem was mounted at %s when the request was reviewed and is now at %s",
			args.PreState.MountedAt, orUnknown(existing))
	}
	// Something already at the target path would be hidden by the new mount.
	occupant, err := e.mountedAt(ctx, args.MountPoint)
	if err != nil {
		return Result{ExitCode: -1}, evidence, err
	}
	if occupant != "" && guard.Normalize(occupant) == guard.Normalize(args.MountPoint) && existing == "" {
		return Result{ExitCode: -1}, evidence, fmt.Errorf(
			"%s is already a mount point; mounting over it would hide what is there", args.MountPoint)
	}

	systemctl, err := e.systemctl()
	if err != nil {
		return Result{ExitCode: -1}, evidence, fmt.Errorf("systemctl unavailable: %w", err)
	}
	unitName, err := mountUnitName(args.MountPoint)
	if err != nil {
		return Result{ExitCode: -1}, evidence, err
	}
	evidence["unit"] = unitName

	unitText := renderMountUnit(args)
	if len(unitText) > maxUnitBytes {
		return Result{ExitCode: -1}, evidence, errors.New("the generated mount unit is implausibly large; refusing to write it")
	}
	unitPath := filepath.Join(e.unitDir(), unitName)
	// A pre-existing unit that this agent did not write is somebody else's
	// configuration, and overwriting it would be a change nobody reviewed.
	if existingText, readErr := os.ReadFile(unitPath); readErr == nil {
		if !strings.HasPrefix(string(existingText), "# Generated by rcc-node-agent.") {
			return Result{ExitCode: -1}, evidence, fmt.Errorf(
				"%s already exists and was not written by this agent; it is left alone", unitPath)
		}
	}
	if err := writeFileAtomic(unitPath, []byte(unitText), 0o644); err != nil {
		return Result{ExitCode: -1}, evidence, fmt.Errorf("could not write the mount unit: %w", err)
	}

	runCtx, cancel := context.WithTimeout(ctx, mountTimeout)
	defer cancel()

	reload, err := e.Runner.Run(runCtx, []string{systemctl, "daemon-reload"}, maxStorageOutput)
	if err != nil || reload.ExitCode != 0 {
		e.removeUnit(unitPath, systemctl, runCtx)
		if err == nil {
			err = fmt.Errorf("systemctl daemon-reload exited %d", reload.ExitCode)
		}
		return reload, evidence, err
	}

	// Start before enable. A unit that will not mount now is a unit that would
	// have failed at every boot, and it is removed rather than persisted.
	start, err := e.Runner.Run(runCtx, []string{systemctl, "start", "--", unitName}, maxStorageOutput)
	if err != nil || start.ExitCode != 0 {
		e.removeUnit(unitPath, systemctl, runCtx)
		evidence["rolledBack"] = "true"
		if err == nil {
			err = fmt.Errorf("the filesystem would not mount at %s (systemctl start exited %d)",
				args.MountPoint, start.ExitCode)
		}
		return start, evidence, err
	}

	// Positive confirmation: the path is a mount point now, not merely a unit
	// that systemd reported as started.
	confirmed, err := e.mountedAt(ctx, args.MountPoint)
	if err != nil || guard.Normalize(confirmed) != guard.Normalize(args.MountPoint) {
		e.removeUnit(unitPath, systemctl, runCtx)
		evidence["rolledBack"] = "true"
		return start, evidence, fmt.Errorf("%s is not mounted after the unit started; the unit was removed", args.MountPoint)
	}
	evidence["mountedAt"] = confirmed

	enable, err := e.Runner.Run(runCtx, []string{systemctl, "enable", "--", unitName}, maxStorageOutput)
	if err != nil || enable.ExitCode != 0 {
		// The mount is up and correct; only persistence failed. Leaving it
		// mounted is the safe half-state, and it is reported as such.
		evidence["persistent"] = "false"
		if err == nil {
			err = fmt.Errorf("the filesystem is mounted but the unit could not be enabled for boot (exit code %d)",
				enable.ExitCode)
		}
		return enable, evidence, err
	}
	evidence["persistent"] = "true"
	evidence["completedAt"] = e.now().UTC().Format(time.RFC3339)
	return enable, evidence, nil
}

// removeUnit undoes a failed mount attempt.
func (e *StorageExecutor) removeUnit(unitPath, systemctl string, ctx context.Context) {
	_ = os.Remove(unitPath)
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), storageReadTimeout)
	defer cancel()
	_, _ = e.Runner.Run(cleanupCtx, []string{systemctl, "daemon-reload"}, maxStorageOutput)
}

// Grow expands a mounted filesystem to fill the device it already sits on.
//
// There is no size argument anywhere in this path. resize2fs and xfs_growfs are
// both invoked with the mount point alone, which means "use all of the device",
// and neither can shrink a mounted filesystem at all. That is what makes this
// grow-only by construction rather than by care.
func (e *StorageExecutor) Grow(ctx context.Context, args *plan.FilesystemGrowArgs) (Result, map[string]string, error) {
	evidence := map[string]string{
		"adapter":    plan.SupportedStorageAdapter,
		"mountPoint": args.MountPoint,
	}
	if err := e.GrowAllowed(args.MountPoint); err != nil {
		return Result{ExitCode: -1}, evidence, err
	}
	if args.PreState == nil {
		return Result{ExitCode: -1}, evidence, errors.New("the plan carries no reviewed state to check against")
	}
	evidence["fsType"] = args.PreState.FSType
	evidence["sizeBefore"] = strconv.FormatInt(args.PreState.SizeBytes, 10)
	evidence["deviceBytes"] = strconv.FormatInt(args.PreState.DeviceBytes, 10)

	if !guard.GrowableFSTypes[args.PreState.FSType] {
		return Result{ExitCode: -1}, evidence,
			fmt.Errorf("this agent grows ext4 and xfs only, not %s", args.PreState.FSType)
	}

	// The filesystem must still be mounted where it was reviewed.
	mounted, err := e.mountedAt(ctx, args.MountPoint)
	if err != nil {
		return Result{ExitCode: -1}, evidence, err
	}
	if guard.Normalize(mounted) != guard.Normalize(args.MountPoint) {
		return Result{ExitCode: -1}, evidence,
			fmt.Errorf("%s is not a mount point on this host any more", args.MountPoint)
	}

	binary := ""
	var argv []string
	switch args.PreState.FSType {
	case "ext4":
		binary, err = e.resize2fs()
		if err != nil {
			return Result{ExitCode: -1}, evidence, err
		}
		// No size operand: resize2fs without one grows to the full device.
		argv = []string{binary, "--", args.MountPoint}
	case "xfs":
		binary, err = e.xfsGrowfs()
		if err != nil {
			return Result{ExitCode: -1}, evidence, err
		}
		// -d means "grow the data section to the maximum". xfs cannot shrink.
		argv = []string{binary, "-d", "--", args.MountPoint}
	}
	evidence["tool"] = filepath.Base(binary)

	runCtx, cancel := context.WithTimeout(ctx, growTimeout)
	defer cancel()
	result, err := e.Runner.Run(runCtx, argv, maxStorageOutput)
	cleaned, truncated := Sanitize(result.Stdout, maxStorageOutput)
	result.Stdout = cleaned
	result.Truncated = result.Truncated || truncated
	if err != nil {
		return result, evidence, err
	}
	if result.ExitCode != 0 {
		return result, evidence, fmt.Errorf("%s exited %d", filepath.Base(binary), result.ExitCode)
	}
	evidence["completedAt"] = e.now().UTC().Format(time.RFC3339)
	return result, evidence, nil
}

func (e *StorageExecutor) resize2fs() (string, error) {
	if e.Resize2fsPath != "" {
		return e.Resize2fsPath, nil
	}
	binary, err := resolveBinary(resize2fsPaths)
	if err != nil {
		return "", fmt.Errorf("resize2fs is not installed, so an ext4 filesystem cannot be grown: %w", err)
	}
	return binary, nil
}

func (e *StorageExecutor) xfsGrowfs() (string, error) {
	if e.XFSGrowfsPath != "" {
		return e.XFSGrowfsPath, nil
	}
	binary, err := resolveBinary(xfsGrowfsPaths)
	if err != nil {
		return "", fmt.Errorf("xfs_growfs is not installed, so an xfs filesystem cannot be grown: %w", err)
	}
	return binary, nil
}

// writeFileAtomic writes through a temporary file and a rename, so a crash
// never leaves a half-written unit that systemd would later try to parse.
func writeFileAtomic(path string, content []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, ".rcc-mount-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)

	if _, err := temp.Write(content); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempName, path); err != nil {
		return err
	}
	handle, err := os.Open(dir)
	if err != nil {
		return nil
	}
	defer handle.Close()
	return handle.Sync()
}
