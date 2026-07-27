package collect

import (
	"context"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	"opensphere.io/rcc/node-agent/internal/snapshot"
)

// Fixed binary paths. The agent never resolves a package manager from PATH and
// never accepts a path from configuration or from the control center: a PATH
// lookup is an execution surface that whoever controls the environment gets to
// aim.
var (
	aptGetPaths = []string{"/usr/bin/apt-get"}
	dpkgPaths   = []string{"/usr/bin/dpkg-query"}
	unamePaths  = []string{"/usr/bin/uname", "/bin/uname"}
)

// Markers that identify a package manager this build does not drive. They are
// detected only so the console can say "unsupported" instead of "none found",
// which are very different statements to an operator.
var foreignManagers = []struct {
	manager string
	path    string
}{
	{snapshot.ManagerDNF, "/usr/bin/dnf"},
	{snapshot.ManagerDNF, "/usr/bin/yum"},
	{snapshot.ManagerZypper, "/usr/bin/zypper"},
	{snapshot.ManagerPacman, "/usr/bin/pacman"},
}

const (
	// A simulated upgrade resolves the dependency graph. On a large, long
	// neglected host that is slow, but it is bounded and it is read-only.
	packageProbeTimeout = 45 * time.Second
	kernelProbeTimeout  = 10 * time.Second
	packageProbeMaxRead = 512 * 1024
	kernelProbeMaxRead  = 64 * 1024
)

// aptSimulateArgv is compile-time fixed.
//
//   - `-s` simulates: nothing is downloaded, unpacked or configured.
//   - `Debug::NoLocking=true` means the probe never takes the dpkg lock, so a
//     read-only snapshot can never block a real administrator's apt run.
//   - `dist-upgrade` is used rather than `upgrade` because it reports the
//     packages a kernel update actually needs, which `upgrade` holds back.
//
// There is no mechanism anywhere to add, reorder or template these arguments.
var aptSimulateArgv = []string{
	"-s", "-q",
	"-o", "Debug::NoLocking=true",
	"-o", "APT::Get::Show-User-Simulation-Note=false",
	"dist-upgrade",
}

var packageProbeEnv = []string{
	"LC_ALL=C",
	"LANG=C",
	"DEBIAN_FRONTEND=noninteractive",
	"PATH=/usr/sbin:/usr/bin:/sbin:/bin",
}

func firstExisting(candidates []string) string {
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

// runBounded executes a fixed argv with no shell, no stdin and a hard output
// bound. It is the only way this package runs anything.
//
// The bound is applied as the child writes rather than to the buffer
// afterwards. Truncating at the end bounds what the collector reports but not
// what it cost to get there, and the agent runs under a memory limit that a
// pathological child would reach first.
func runBounded(ctx context.Context, timeout time.Duration, maxRead int, binary string, argv []string) ([]byte, error) {
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(probeCtx, binary, argv...)
	cmd.Env = packageProbeEnv
	cmd.Stdin = nil
	out := newBoundedBuffer(maxRead)
	cmd.Stdout = out
	cmd.Stderr = nil
	// A child that ignores cancellation must not hold the collector open.
	cmd.WaitDelay = 5 * time.Second

	runErr := cmd.Run()
	if probeCtx.Err() != nil {
		return nil, probeCtx.Err()
	}
	return out.Bytes(), runErr
}

// boundedBuffer keeps at most limit bytes and discards the rest, always
// reporting a full write so the child is drained rather than blocked on a pipe.
type boundedBuffer struct {
	limit  int
	buffer []byte
}

func newBoundedBuffer(limit int) *boundedBuffer {
	if limit <= 0 {
		limit = 64 * 1024
	}
	return &boundedBuffer{limit: limit, buffer: make([]byte, 0, min(limit, 32*1024))}
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if remaining := b.limit - len(b.buffer); remaining > 0 {
		if len(p) < remaining {
			remaining = len(p)
		}
		b.buffer = append(b.buffer, p[:remaining]...)
	}
	return len(p), nil
}

func (b *boundedBuffer) Bytes() []byte { return b.buffer }

func (b *boundedBuffer) Len() int { return len(b.buffer) }

// detectManager reports which package manager is present.
func detectManager() (manager string, supported bool, reason string) {
	if firstExisting(aptGetPaths) != "" {
		return snapshot.ManagerAPT, true, ""
	}
	for _, foreign := range foreignManagers {
		if firstExisting([]string{foreign.path}) != "" {
			return foreign.manager, false,
				"this agent build drives apt only; " + foreign.manager + " is detected but not operated"
		}
	}
	return snapshot.ManagerUnknown, false, "no package manager this agent recognises was found"
}

// probePackages collects update state without changing any of it.
func probePackages(ctx context.Context, now time.Time) (snapshot.Packages, error) {
	manager, supported, reason := detectManager()
	result := snapshot.Packages{
		Manager:            manager,
		Supported:          supported,
		UnsupportedReason:  reason,
		MetadataAgeSeconds: -1,
		Pending:            []snapshot.PendingPackage{},
		CollectedAt:        now.UTC().Format(time.RFC3339),
	}
	if !supported {
		return result, nil
	}

	result.MetadataAgeSeconds = aptMetadataAge(now)

	binary := firstExisting(aptGetPaths)
	if binary == "" {
		result.Supported = false
		result.UnsupportedReason = "apt-get disappeared between detection and use"
		return result, nil
	}
	raw, err := runBounded(ctx, packageProbeTimeout, packageProbeMaxRead, binary, aptSimulateArgv)
	if err != nil && len(raw) == 0 {
		// No output at all means the probe did not run. Reporting zero pending
		// updates here would be indistinguishable from a fully patched host.
		return result, err
	}
	pending, total, security := parseAptSimulation(raw)
	result.Pending = pending
	result.PendingTotal = total
	result.PendingSecurity = security
	return result, nil
}

// aptMetadataAge reports how long ago the package index was refreshed.
//
// A pending-update count derived from a stale index describes the world as it
// was, and the difference is exactly the security update nobody has seen yet.
func aptMetadataAge(now time.Time) int64 {
	candidates := []string{
		"/var/lib/apt/periodic/update-success-stamp",
		"/var/lib/apt/lists",
	}
	newest := time.Time{}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err != nil {
			continue
		}
		if info.ModTime().After(newest) {
			newest = info.ModTime()
		}
	}
	if newest.IsZero() {
		return -1
	}
	age := int64(now.Sub(newest).Seconds())
	if age < 0 {
		// A stamp in the future is a clock problem, not freshness.
		return -1
	}
	return age
}

// parseAptSimulation turns `apt-get -s dist-upgrade` output into pending
// packages. It is separate from the exec path so the parsing rules are testable
// without apt present.
//
// The lines of interest look like:
//
//	Inst linux-image-6.8.0-51-generic (6.8.0-51.52 Ubuntu:24.04/noble-security [amd64])
//	Inst curl [8.5.0-2ubuntu10.5] (8.5.0-2ubuntu10.6 Ubuntu:24.04/noble-updates [amd64])
func parseAptSimulation(raw []byte) ([]snapshot.PendingPackage, int, int) {
	pending := []snapshot.PendingPackage{}
	total := 0
	security := 0
	seen := map[string]bool{}

	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "Inst ") {
			continue
		}
		entry, ok := parseAptInstLine(line)
		if !ok || seen[entry.Name] {
			continue
		}
		seen[entry.Name] = true
		total++
		if entry.Security {
			security++
		}
		if len(pending) < snapshot.MaxPendingPackages {
			pending = append(pending, entry)
		}
	}
	// Security updates first, then alphabetical: a truncated list should show
	// the entries an operator most needs to see.
	sort.SliceStable(pending, func(i, j int) bool {
		if pending[i].Security != pending[j].Security {
			return pending[i].Security
		}
		return pending[i].Name < pending[j].Name
	})
	return pending, total, security
}

func parseAptInstLine(line string) (snapshot.PendingPackage, bool) {
	rest := strings.TrimSpace(strings.TrimPrefix(line, "Inst "))
	fields := strings.Fields(rest)
	if len(fields) == 0 {
		return snapshot.PendingPackage{}, false
	}
	entry := snapshot.PendingPackage{Name: bound(fields[0], 128)}
	if entry.Name == "" {
		return snapshot.PendingPackage{}, false
	}

	// `[current]` appears only when the package is already installed.
	if open := strings.Index(rest, "["); open != -1 && open < strings.Index(rest+"(", "(") {
		if close := strings.Index(rest[open:], "]"); close != -1 {
			entry.CurrentVersion = bound(strings.TrimSpace(rest[open+1:open+close]), 128)
		}
	}

	// `(candidate origin [arch])` carries the version being offered and where
	// it comes from.
	if open := strings.Index(rest, "("); open != -1 {
		if close := strings.LastIndex(rest, ")"); close > open {
			inner := rest[open+1 : close]
			parts := strings.Fields(inner)
			if len(parts) > 0 {
				entry.CandidateVersion = bound(parts[0], 128)
			}
			if len(parts) > 1 {
				origin := strings.Trim(strings.Join(parts[1:], " "), " ")
				origin = strings.TrimSuffix(origin, "[]")
				entry.Origin = bound(origin, 200)
			}
		}
	}
	entry.Security = snapshot.SecurityOrigin(entry.Origin)
	return entry, true
}

func bound(value string, max int) string {
	value = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, value)
	if len(value) > max {
		return value[:max]
	}
	return value
}

// probeKernel reports the running kernel against what is installed and offered.
//
// It never reboots and never installs. A kernel difference is evidence for a
// human to act on through the separately approved host.reboot operation.
func probeKernel(ctx context.Context, packages snapshot.Packages, now time.Time) (snapshot.Kernel, error) {
	result := snapshot.Kernel{
		RebootRequiredPackages: []string{},
		CollectedAt:            now.UTC().Format(time.RFC3339),
	}

	if binary := firstExisting(unamePaths); binary != "" {
		raw, err := runBounded(ctx, kernelProbeTimeout, kernelProbeMaxRead, binary, []string{"-r"})
		if err == nil {
			result.Running = bound(strings.TrimSpace(string(raw)), 128)
		}
	}

	// Debian and Ubuntu record this for exactly this purpose: the kernel (or
	// another package that needs a restart) has been updated on disk and the
	// running system has not picked it up.
	if _, err := os.Stat("/var/run/reboot-required"); err == nil {
		result.RebootRequired = true
	}
	if data, err := os.ReadFile("/var/run/reboot-required.pkgs"); err == nil {
		seen := map[string]bool{}
		for _, line := range strings.Split(string(data), "\n") {
			name := bound(strings.TrimSpace(line), 128)
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			if len(result.RebootRequiredPackages) < snapshot.MaxRebootRequiredPackages {
				result.RebootRequiredPackages = append(result.RebootRequiredPackages, name)
			}
		}
		sort.Strings(result.RebootRequiredPackages)
	}

	if packages.Supported {
		result.InstalledLatest = latestInstalledKernel(ctx)
		result.Candidate = candidateKernel(packages)
		result.UpdateAvailable = result.Candidate != ""
	}
	return result, nil
}

// dpkgKernelArgv is compile-time fixed: list installed linux-image packages and
// their versions, nothing else.
var dpkgKernelArgv = []string{
	"-W", "-f", "${Package} ${Version} ${Status}\n", "linux-image-*",
}

// latestInstalledKernel returns the newest installed kernel image version.
func latestInstalledKernel(ctx context.Context) string {
	binary := firstExisting(dpkgPaths)
	if binary == "" {
		return ""
	}
	raw, err := runBounded(ctx, kernelProbeTimeout, kernelProbeMaxRead, binary, dpkgKernelArgv)
	if err != nil && len(raw) == 0 {
		return ""
	}
	best := ""
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 4 {
			continue
		}
		// Only packages that are actually installed count.
		if fields[len(fields)-1] != "installed" {
			continue
		}
		name := fields[0]
		// Meta-packages such as linux-image-generic track a version but are not
		// a kernel; the concrete images carry the release in their name.
		if !strings.HasPrefix(name, "linux-image-") || !strings.ContainsAny(name, "0123456789") {
			continue
		}
		release := strings.TrimPrefix(name, "linux-image-")
		if release == "" || strings.HasPrefix(release, "unsigned") {
			continue
		}
		if compareKernelRelease(release, best) > 0 {
			best = release
		}
	}
	return bound(best, 128)
}

// candidateKernel reports the kernel image apt would install, if any.
func candidateKernel(packages snapshot.Packages) string {
	best := ""
	for _, entry := range packages.Pending {
		if !strings.HasPrefix(entry.Name, "linux-image-") {
			continue
		}
		release := strings.TrimPrefix(entry.Name, "linux-image-")
		if release == "" || !strings.ContainsAny(release, "0123456789") {
			continue
		}
		if compareKernelRelease(release, best) > 0 {
			best = release
		}
	}
	return bound(best, 128)
}

// compareKernelRelease orders two kernel release strings numerically where they
// are numeric and lexically where they are not, so 6.8.0-51 sorts after
// 6.8.0-9 rather than before it.
func compareKernelRelease(left, right string) int {
	if right == "" {
		if left == "" {
			return 0
		}
		return 1
	}
	if left == "" {
		return -1
	}
	leftParts := splitRelease(left)
	rightParts := splitRelease(right)
	for i := 0; i < len(leftParts) && i < len(rightParts); i++ {
		l, lNum := leftParts[i].value, leftParts[i].numeric
		r, rNum := rightParts[i].value, rightParts[i].numeric
		if lNum && rNum {
			if leftParts[i].number != rightParts[i].number {
				if leftParts[i].number > rightParts[i].number {
					return 1
				}
				return -1
			}
			continue
		}
		if l != r {
			if l > r {
				return 1
			}
			return -1
		}
	}
	switch {
	case len(leftParts) > len(rightParts):
		return 1
	case len(leftParts) < len(rightParts):
		return -1
	}
	return 0
}

type releasePart struct {
	value   string
	numeric bool
	number  int64
}

func splitRelease(release string) []releasePart {
	parts := []releasePart{}
	current := strings.Builder{}
	currentNumeric := false
	flush := func() {
		if current.Len() == 0 {
			return
		}
		text := current.String()
		part := releasePart{value: text, numeric: currentNumeric}
		if currentNumeric {
			var n int64
			for _, r := range text {
				n = n*10 + int64(r-'0')
				if n > 1<<40 {
					break
				}
			}
			part.number = n
		}
		parts = append(parts, part)
		current.Reset()
	}
	for _, r := range release {
		isDigit := r >= '0' && r <= '9'
		if current.Len() > 0 && isDigit != currentNumeric {
			flush()
		}
		currentNumeric = isDigit
		current.WriteRune(r)
	}
	flush()
	return parts
}
