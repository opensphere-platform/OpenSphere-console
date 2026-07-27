package collect

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"opensphere.io/rcc/node-agent/internal/snapshot"
)

// readSource lets a test assert on the shape of the implementation itself,
// which is how the "no shell, no PATH" rules stay true as the file changes.
func readSource(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

const aptSample = `NOTE: This is only a simulation!
Reading package lists...
Building dependency tree...
Calculating upgrade...
Inst curl [8.5.0-2ubuntu10.5] (8.5.0-2ubuntu10.6 Ubuntu:24.04/noble-updates [amd64])
Inst libssl3t64 [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-security [amd64])
Inst linux-image-6.8.0-51-generic (6.8.0-51.52 Ubuntu:24.04/noble-security [amd64])
Conf curl (8.5.0-2ubuntu10.6 Ubuntu:24.04/noble-updates [amd64])
Remove obsolete-package [1.0]
`

func TestAptSimulationIsParsedIntoPendingUpdates(t *testing.T) {
	pending, total, security := parseAptSimulation([]byte(aptSample))
	if total != 3 {
		t.Fatalf("expected 3 pending packages, got %d", total)
	}
	if security != 2 {
		t.Fatalf("expected 2 security updates, got %d", security)
	}
	// Security first, then alphabetical: a truncated list must show what matters.
	if pending[0].Name != "libssl3t64" || !pending[0].Security {
		t.Fatalf("security updates must sort first, got %+v", pending[0])
	}
	var curl snapshot.PendingPackage
	for _, entry := range pending {
		if entry.Name == "curl" {
			curl = entry
		}
	}
	if curl.CurrentVersion != "8.5.0-2ubuntu10.5" {
		t.Fatalf("current version not parsed: %+v", curl)
	}
	if curl.CandidateVersion != "8.5.0-2ubuntu10.6" {
		t.Fatalf("candidate version not parsed: %+v", curl)
	}
	if curl.Security {
		t.Fatal("noble-updates is not a security origin")
	}
}

func TestOnlyInstLinesCount(t *testing.T) {
	// `Conf` and `Remove` describe the same transaction; counting them would
	// inflate the number an operator sees and reads as "packages to update".
	_, total, _ := parseAptSimulation([]byte(aptSample))
	if total != 3 {
		t.Fatalf("Conf/Remove lines must not be counted, got %d", total)
	}
}

func TestPendingListIsBoundedButCountsStayExact(t *testing.T) {
	var builder strings.Builder
	for i := 0; i < snapshot.MaxPendingPackages+50; i++ {
		builder.WriteString("Inst pkg")
		builder.WriteString(string(rune('a' + i%26)))
		builder.WriteString(string(rune('a' + (i/26)%26)))
		builder.WriteString(" [1.0] (1.1 Ubuntu:24.04/noble-updates [amd64])\n")
	}
	pending, total, _ := parseAptSimulation([]byte(builder.String()))
	if len(pending) > snapshot.MaxPendingPackages {
		t.Fatalf("pending list must be bounded, got %d", len(pending))
	}
	if total <= snapshot.MaxPendingPackages {
		t.Fatalf("the count must remain exact even when the list is cut, got %d", total)
	}
}

func TestHostileAptOutputCannotInjectControlCharacters(t *testing.T) {
	hostile := "Inst evil\x00pkg [1.0\x1b[31m] (2.0\nInst \x07bell [1.0] (2.0 origin [amd64])\n"
	pending, _, _ := parseAptSimulation([]byte(hostile))
	for _, entry := range pending {
		for _, field := range []string{entry.Name, entry.CurrentVersion, entry.CandidateVersion, entry.Origin} {
			for _, r := range field {
				if r < 0x20 || r == 0x7f {
					t.Fatalf("control character survived in %q", field)
				}
			}
		}
	}
}

func TestDuplicatePackagesAreCountedOnce(t *testing.T) {
	repeated := strings.Repeat("Inst curl [1.0] (1.1 Ubuntu:24.04/noble-updates [amd64])\n", 5)
	pending, total, _ := parseAptSimulation([]byte(repeated))
	if total != 1 || len(pending) != 1 {
		t.Fatalf("a package listed repeatedly is still one pending update, got total=%d list=%d", total, len(pending))
	}
}

func TestKernelReleaseOrderingIsNumeric(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		{"6.8.0-51-generic", "6.8.0-9-generic", 1},
		{"6.8.0-9-generic", "6.8.0-51-generic", -1},
		{"6.8.0-51-generic", "6.8.0-51-generic", 0},
		{"6.11.0-1-generic", "6.8.0-99-generic", 1},
		{"6.8.0-51-generic", "", 1},
		{"", "6.8.0-51-generic", -1},
	}
	for _, tc := range cases {
		if got := compareKernelRelease(tc.left, tc.right); got != tc.want {
			t.Fatalf("compare(%q,%q) = %d, want %d", tc.left, tc.right, got, tc.want)
		}
	}
}

func TestCandidateKernelIsTheHighestOfferedImage(t *testing.T) {
	packages := snapshot.Packages{Supported: true, Pending: []snapshot.PendingPackage{
		{Name: "curl"},
		{Name: "linux-image-6.8.0-9-generic"},
		{Name: "linux-image-6.8.0-51-generic"},
		{Name: "linux-image-generic"},
	}}
	if got := candidateKernel(packages); got != "6.8.0-51-generic" {
		t.Fatalf("candidate kernel = %q", got)
	}
}

func TestNoKernelOfferedMeansNoCandidate(t *testing.T) {
	packages := snapshot.Packages{Supported: true, Pending: []snapshot.PendingPackage{{Name: "curl"}}}
	if got := candidateKernel(packages); got != "" {
		t.Fatalf("expected no candidate, got %q", got)
	}
}

// ── the collector's own contract ────────────────────────────────────────────

func collectorWith(packages func(context.Context, time.Time) (snapshot.Packages, error),
	kernel func(context.Context, snapshot.Packages, time.Time) (snapshot.Kernel, error)) *Collector {
	c := New("cc2", "node-a", "0.3.0", false)
	c.ProcRoot = "testdata/proc"
	c.EtcRoot = "testdata/etc"
	c.Hostname = func() (string, error) { return "node-a", nil }
	c.Statfs = func(string) (FSUsage, error) { return FSUsage{}, errors.New("not needed") }
	c.Packages = packages
	c.Kernel = kernel
	c.Now = func() time.Time { return time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC) }
	return c
}

func TestAFailedPackageProbeIsDegradedNotEmpty(t *testing.T) {
	// "No pending updates" and "we could not find out" are the same number and
	// very different facts. The snapshot must not conflate them.
	c := collectorWith(
		func(context.Context, time.Time) (snapshot.Packages, error) {
			return snapshot.Packages{Manager: snapshot.ManagerAPT, Supported: true}, errors.New("apt timed out")
		},
		func(context.Context, snapshot.Packages, time.Time) (snapshot.Kernel, error) {
			return snapshot.Kernel{}, nil
		})
	snap := c.Collect(context.Background())

	if snap.Packages.Supported {
		t.Fatal("a probe that failed must not report a supported, actionable manager")
	}
	if !strings.Contains(snap.Packages.UnsupportedReason, "apt timed out") {
		t.Fatalf("the reason must survive: %q", snap.Packages.UnsupportedReason)
	}
	found := false
	for _, key := range snap.Degraded {
		if key == "packages" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the failure must be declared degraded, got %v", snap.Degraded)
	}
}

func TestAnUnsupportedManagerReportsNothingActionable(t *testing.T) {
	c := collectorWith(
		func(context.Context, time.Time) (snapshot.Packages, error) {
			// A hostile or buggy probe claiming pending work on a manager this
			// build cannot drive must not produce an actionable inventory.
			return snapshot.Packages{
				Manager:           snapshot.ManagerDNF,
				Supported:         false,
				UnsupportedReason: "dnf is detected but not operated",
				PendingTotal:      42,
				PendingSecurity:   7,
				Pending:           []snapshot.PendingPackage{{Name: "kernel"}},
			}, nil
		},
		func(context.Context, snapshot.Packages, time.Time) (snapshot.Kernel, error) {
			return snapshot.Kernel{}, nil
		})
	c.PackagesEnabled = true
	snap := c.Collect(context.Background())

	if snap.Packages.PendingTotal != 0 || snap.Packages.PendingSecurity != 0 || len(snap.Packages.Pending) != 0 {
		t.Fatalf("an unsupported manager must expose no pending work: %+v", snap.Packages)
	}
	if snap.Operations.PackagesEnabled {
		t.Fatal("package operations must be off when the manager is unsupported")
	}
	if snap.Packages.UnsupportedReason == "" {
		t.Fatal("the console must be told why")
	}
}

func TestDisabledPackageCollectionSaysSoRatherThanLookingClean(t *testing.T) {
	c := collectorWith(nil, nil)
	c.CollectPackages = false
	snap := c.Collect(context.Background())
	if snap.Packages.Supported {
		t.Fatal("a disabled collector is not a supported one")
	}
	if !strings.Contains(snap.Packages.UnsupportedReason, "disabled") {
		t.Fatalf("the reason must say it is disabled: %q", snap.Packages.UnsupportedReason)
	}
	if snap.Packages.MetadataAgeSeconds != -1 {
		t.Fatalf("unknown freshness must be -1, got %d", snap.Packages.MetadataAgeSeconds)
	}
}

func TestEvidenceFreshnessTravelsWithTheCounts(t *testing.T) {
	c := collectorWith(
		func(_ context.Context, now time.Time) (snapshot.Packages, error) {
			return snapshot.Packages{
				Manager: snapshot.ManagerAPT, Supported: true,
				MetadataAgeSeconds: 9 * 24 * 60 * 60,
				PendingTotal:       3, PendingSecurity: 1,
				CollectedAt: now.UTC().Format(time.RFC3339),
			}, nil
		},
		func(_ context.Context, _ snapshot.Packages, now time.Time) (snapshot.Kernel, error) {
			return snapshot.Kernel{Running: "6.8.0-45-generic", CollectedAt: now.UTC().Format(time.RFC3339)}, nil
		})
	snap := c.Collect(context.Background())
	if snap.Packages.MetadataAgeSeconds != 9*24*60*60 {
		t.Fatalf("index age must be reported, got %d", snap.Packages.MetadataAgeSeconds)
	}
	if snap.Packages.CollectedAt == "" || snap.Kernel.CollectedAt == "" {
		t.Fatal("both collectors must timestamp their own evidence")
	}
}

func TestKernelInventoryNeverRebootsAnything(t *testing.T) {
	// The collector's whole job here is to report a difference. Acting on it is
	// the separately approved host.reboot operation.
	source := readSource(t, "packages.go")
	for _, forbidden := range []string{"reboot", "shutdown", "poweroff", "halt", "kexec"} {
		for _, line := range strings.Split(source, "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "*") {
				continue
			}
			// `reboot-required` is a file this collector reads, not an action.
			cleaned := strings.ReplaceAll(line, "reboot-required", "")
			cleaned = strings.ReplaceAll(cleaned, "RebootRequired", "")
			if strings.Contains(strings.ToLower(cleaned), forbidden) {
				t.Fatalf("the inventory collector must not mention %q as an action: %s", forbidden, line)
			}
		}
	}
}

func TestTheCollectorRunsNothingItWasNotCompiledWith(t *testing.T) {
	source := readSource(t, "packages.go")
	// Every exec in this file must go through runBounded with a fixed argv.
	if strings.Count(source, "exec.CommandContext") != 1 {
		t.Fatal("there must be exactly one exec site, inside runBounded")
	}
	for _, forbidden := range []string{"exec.Command(", "sh -c", "/bin/sh", "os/exec\".LookPath", "exec.LookPath"} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("%q must not appear: no shell, no PATH resolution", forbidden)
		}
	}
	if !strings.Contains(source, "cmd.Stdin = nil") {
		t.Fatal("probes must never be given stdin")
	}
}
