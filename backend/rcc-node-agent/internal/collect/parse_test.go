package collect

import (
	"fmt"
	"strings"
	"testing"

	"opensphere.io/rcc/node-agent/internal/snapshot"
)

func TestParseOSReleaseStripsQuotes(t *testing.T) {
	fields := parseOSRelease([]byte("# comment\nNAME=\"Rocky Linux\"\nID=rocky\nVERSION_ID=\"9.5\"\nbroken-line\n"))
	if fields["NAME"] != "Rocky Linux" {
		t.Fatalf("NAME = %q", fields["NAME"])
	}
	if fields["ID"] != "rocky" || fields["VERSION_ID"] != "9.5" {
		t.Fatalf("unexpected fields: %#v", fields)
	}
	if _, ok := fields["broken-line"]; ok {
		t.Fatal("lines without = must be skipped")
	}
}

func TestParseUptimeAndLoadAvg(t *testing.T) {
	if got := parseUptime([]byte("123456.78 987654.32\n")); got != 123456 {
		t.Fatalf("uptime = %d", got)
	}
	l1, l5, l15, running, total := parseLoadAvg([]byte("0.52 0.31 0.24 3/512 99887\n"))
	if l1 != 0.52 || l5 != 0.31 || l15 != 0.24 {
		t.Fatalf("load = %v %v %v", l1, l5, l15)
	}
	if running != 3 || total != 512 {
		t.Fatalf("procs = %d/%d", running, total)
	}
}

func TestParseMemInfoConvertsKilobytes(t *testing.T) {
	mem := parseMemInfo([]byte("MemTotal:       16303456 kB\nMemAvailable:    9123456 kB\nHugePages_Total:       0\n"))
	if mem["MemTotal"] != 16303456*1024 {
		t.Fatalf("MemTotal = %d", mem["MemTotal"])
	}
	if mem["HugePages_Total"] != 0 {
		t.Fatalf("unitless value mishandled: %d", mem["HugePages_Total"])
	}
}

func TestParseProcStat(t *testing.T) {
	ctxt, running, blocked := parseProcStat([]byte("cpu  1 2 3\nctxt 998877\nprocs_running 4\nprocs_blocked 1\n"))
	if ctxt != 998877 || running != 4 || blocked != 1 {
		t.Fatalf("stat = %d %d %d", ctxt, running, blocked)
	}
}

func TestParseMountsFiltersVirtualAndSensitiveMounts(t *testing.T) {
	data := []byte(strings.Join([]string{
		"/dev/mapper/rl-root / xfs rw,relatime 0 0",
		"proc /proc proc rw,nosuid 0 0",
		"tmpfs /run/secrets/kubernetes.io/serviceaccount tmpfs ro,relatime 0 0",
		"overlay /var/lib/containers/storage/overlay/abc/merged overlay rw 0 0",
		"/dev/sda1 /boot ext4 ro,relatime 0 0",
		"/dev/sdb1 /var/lib/kubelet/pods/uid/volumes/kubernetes.io~secret/token ext4 rw 0 0",
		"/dev/sdc1 /mnt/space\\040dir ext4 rw 0 0",
		"",
	}, "\n"))
	entries, truncated := parseMounts(data)
	if truncated {
		t.Fatal("a table that fits must not be reported as cut short")
	}
	if len(entries) != 4 {
		t.Fatalf("expected 4 allowlisted mounts, got %d: %#v", len(entries), entries)
	}
	if entries[0].mountPoint != "/" || entries[0].fsType != "xfs" || entries[0].readOnly {
		t.Fatalf("root mount mis-parsed: %#v", entries[0])
	}
	if !entries[1].readOnly {
		t.Fatalf("/boot should be read-only: %#v", entries[1])
	}
	if entries[3].mountPoint != "/mnt/space dir" {
		t.Fatalf("octal escape not decoded: %q", entries[3].mountPoint)
	}
	// The kubelet secret mount is ext4 and therefore allowlisted by fstype; it
	// is included but its path is bounded and carries no credential material.
	for _, e := range entries {
		if strings.Contains(e.mountPoint, "containers/storage") {
			t.Fatalf("overlay container mount must be excluded: %#v", e)
		}
	}
}

func TestParseMountsIsBounded(t *testing.T) {
	var b strings.Builder
	for i := 0; i < snapshot.MaxFilesystems*3; i++ {
		b.WriteString("/dev/sd")
		b.WriteString(string(rune('a' + i%26)))
		b.WriteString(" /mnt/d")
		b.WriteString(string(rune('a' + i%26)))
		b.WriteString(string(rune('a' + i/26)))
		b.WriteString(" ext4 rw 0 0\n")
	}
	entries, truncated := parseMounts([]byte(b.String()))
	if len(entries) > snapshot.MaxFilesystems {
		t.Fatalf("mounts exceeded bound: %d", len(entries))
	}
	// A list cut short that does not say so is read as a complete list. This is
	// the same rule the failed-unit parser already follows.
	if !truncated {
		t.Fatal("a mount table cut short must report that it was")
	}
}

// A directory mounted over twice resolves to the last mount, and the earlier
// one is unreachable. Reporting the first published a filesystem — its type,
// its device, its read-only flag — that nothing on the host can get to.
func TestParseMountsKeepsTheEffectiveOverMount(t *testing.T) {
	data := []byte(strings.Join([]string{
		"/dev/sda1 /srv/data ext4 ro,relatime 0 0",
		"/dev/mapper/rl-root / xfs rw,relatime 0 0",
		"/dev/sdb1 /srv/data xfs rw,relatime 0 0",
		"",
	}, "\n"))
	entries, truncated := parseMounts(data)
	if truncated {
		t.Fatal("an over-mount consumes no slot and cannot truncate the table")
	}
	if len(entries) != 2 {
		t.Fatalf("an over-mount must replace the entry, not add one: %#v", entries)
	}
	// First-appearance order is kept so the report is stable between collections.
	if entries[0].mountPoint != "/srv/data" || entries[1].mountPoint != "/" {
		t.Fatalf("entry order changed: %#v", entries)
	}
	got := entries[0]
	if got.device != "/dev/sdb1" || got.fsType != "xfs" || got.readOnly {
		t.Fatalf("the covered-up mount was reported instead of the effective one: %#v", got)
	}
}

// The last entry wins even when it appears after the bound has been reached,
// because a scan that stopped at the bound would pin the stale mount.
func TestParseMountsAppliesAnOverMountFoundBeyondTheBound(t *testing.T) {
	var b strings.Builder
	b.WriteString("/dev/sda1 /srv/data ext4 ro,relatime 0 0\n")
	for i := 0; i < snapshot.MaxFilesystems+8; i++ {
		b.WriteString("/dev/sdz /mnt/d")
		b.WriteString(string(rune('a' + i%26)))
		b.WriteString(string(rune('a' + i/26)))
		b.WriteString(" ext4 rw 0 0\n")
	}
	b.WriteString("/dev/sdb1 /srv/data xfs rw,relatime 0 0\n")

	entries, truncated := parseMounts([]byte(b.String()))
	if !truncated {
		t.Fatal("a table with more mount points than fit must say it was cut short")
	}
	if len(entries) != snapshot.MaxFilesystems {
		t.Fatalf("bound not held: %d", len(entries))
	}
	if entries[0].mountPoint != "/srv/data" || entries[0].device != "/dev/sdb1" || entries[0].fsType != "xfs" {
		t.Fatalf("an over-mount past the bound was dropped: %#v", entries[0])
	}
}

// A table holding exactly the bound is complete, and saying otherwise would
// have an operator hunting for filesystems that do not exist.
func TestParseMountsDoesNotFlagAnExactlyFullTable(t *testing.T) {
	var b strings.Builder
	for i := 0; i < snapshot.MaxFilesystems; i++ {
		b.WriteString("/dev/sda /mnt/d")
		b.WriteString(string(rune('a' + i%26)))
		b.WriteString(string(rune('a' + i/26)))
		b.WriteString(" ext4 rw 0 0\n")
	}
	entries, truncated := parseMounts([]byte(b.String()))
	if len(entries) != snapshot.MaxFilesystems || truncated {
		t.Fatalf("exactly-full table reported as truncated: %d %v", len(entries), truncated)
	}
}

func TestParseNetDevDropsPodVirtualInterfaces(t *testing.T) {
	data := []byte(`Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 123456 789 1 2 0 0 0 0 654321 987 3 4 0 0 0 0
veth9f2a1b: 5 5 0 0 0 0 0 0 5 5 0 0 0 0 0 0
cali12345678: 5 5 0 0 0 0 0 0 5 5 0 0 0 0 0 0
 bond0: 11 22 0 0 0 0 0 0 33 44 0 0 0 0 0 0
`)
	ifaces, truncated := parseNetDev(data)
	if truncated {
		t.Fatal("an interface list that fits must not be reported as cut short")
	}
	if len(ifaces) != 2 {
		t.Fatalf("expected eth0 and bond0 only, got %#v", ifaces)
	}
	if ifaces[0].Name != "eth0" || ifaces[0].RxBytes != 123456 || ifaces[0].TxBytes != 654321 {
		t.Fatalf("eth0 counters mis-parsed: %#v", ifaces[0])
	}
	if ifaces[0].RxErrors != 1 || ifaces[0].RxDropped != 2 || ifaces[0].TxErrors != 3 || ifaces[0].TxDropped != 4 {
		t.Fatalf("eth0 error counters mis-parsed: %#v", ifaces[0])
	}
}

func TestParseFailedUnitsBounded(t *testing.T) {
	const extra = 10
	var b strings.Builder
	for i := 0; i < snapshot.MaxFailedUnits+extra; i++ {
		b.WriteString("unit-")
		b.WriteString(string(rune('a' + i%26)))
		b.WriteString(".service loaded failed failed Some Description\n")
	}
	units, total := parseFailedUnits([]byte(b.String()))
	if len(units) != snapshot.MaxFailedUnits {
		t.Fatalf("failed units not bounded: %d", len(units))
	}
	// The listed names are capped, but the operator must still see how bad it is.
	if total != snapshot.MaxFailedUnits+extra {
		t.Fatalf("failed unit count truncated with the list: got %d want %d", total, snapshot.MaxFailedUnits+extra)
	}
	if !strings.HasSuffix(units[0], ".service") {
		t.Fatalf("unit name mis-parsed: %q", units[0])
	}
}

func TestParseFailedUnitsCountsExactlyWhenUnderBound(t *testing.T) {
	data := "a.service loaded failed failed A\nb.service loaded failed failed B\n"
	units, total := parseFailedUnits([]byte(data))
	if total != 2 || len(units) != 2 {
		t.Fatalf("small result mis-counted: units=%d total=%d", len(units), total)
	}
}

func TestParseFailedUnitsIgnoresNoiseInCount(t *testing.T) {
	// Legend bullets and blank lines must not inflate the reported count.
	data := "\n● something\n\na.service loaded failed failed A\n   \nnotaunit\n"
	units, total := parseFailedUnits([]byte(data))
	if total != 1 || len(units) != 1 || units[0] != "a.service" {
		t.Fatalf("noise counted as failures: units=%v total=%d", units, total)
	}
}

func TestIDHashIsNonReversibleAndStable(t *testing.T) {
	raw := "2f6c1b0e4d5a4f0b9c8d7e6f5a4b3c2d"
	got := idHash(raw)
	if got == "" || strings.Contains(got, raw) {
		t.Fatalf("machine id must not be transmitted verbatim: %q", got)
	}
	if !strings.HasPrefix(got, "sha256:") || len(got) != len("sha256:")+16 {
		t.Fatalf("unexpected hash shape: %q", got)
	}
	if idHash(raw) != got {
		t.Fatal("hash must be stable")
	}
	if idHash("  ") != "" {
		t.Fatal("blank id must hash to empty")
	}
}

func TestTruncateStripsControlCharacters(t *testing.T) {
	if got := truncate("ok\x00\x1bvalue\n", 64); got != "okvalue" {
		t.Fatalf("truncate = %q", got)
	}
	if got := truncate(strings.Repeat("x", 300), 10); len(got) != 10 {
		t.Fatalf("truncate length = %d", len(got))
	}
}

func TestSummarizeFailedUnitsReportsTruncationHonestly(t *testing.T) {
	t.Run("exact fit is not truncated", func(t *testing.T) {
		var b strings.Builder
		for i := 0; i < snapshot.MaxFailedUnits; i++ {
			fmt.Fprintf(&b, "unit-%02d.service loaded failed failed D\n", i)
		}
		got := summarizeFailedUnits([]byte(b.String()))
		if got.FailedUnitCount != snapshot.MaxFailedUnits || got.Truncated {
			t.Fatalf("exact fit mis-reported: count=%d truncated=%v", got.FailedUnitCount, got.Truncated)
		}
	})

	t.Run("over the list bound reports the real count and truncation", func(t *testing.T) {
		var b strings.Builder
		for i := 0; i < snapshot.MaxFailedUnits+7; i++ {
			fmt.Fprintf(&b, "unit-%02d.service loaded failed failed D\n", i)
		}
		got := summarizeFailedUnits([]byte(b.String()))
		if got.FailedUnitCount != snapshot.MaxFailedUnits+7 {
			t.Fatalf("count clamped to the list bound: %d", got.FailedUnitCount)
		}
		if len(got.FailedUnits) != snapshot.MaxFailedUnits || !got.Truncated {
			t.Fatalf("list/truncated wrong: len=%d truncated=%v", len(got.FailedUnits), got.Truncated)
		}
	})

	t.Run("output cut at the read bound is marked truncated", func(t *testing.T) {
		var b strings.Builder
		for b.Len() <= systemdProbeMaxRead+4096 {
			fmt.Fprintf(&b, "unit-%06d.service loaded failed failed A long enough description\n", b.Len())
		}
		got := summarizeFailedUnits([]byte(b.String()))
		if !got.Truncated {
			t.Fatal("byte-bounded output must report truncated")
		}
		// The severed final line must not be counted as a unit.
		for _, unit := range got.FailedUnits {
			if !strings.HasSuffix(unit, ".service") {
				t.Fatalf("partial unit name leaked into the list: %q", unit)
			}
		}
	})

	t.Run("no failures reports zero and no truncation", func(t *testing.T) {
		got := summarizeFailedUnits(nil)
		if got.FailedUnitCount != 0 || got.Truncated || len(got.FailedUnits) != 0 {
			t.Fatalf("empty probe mis-reported: %#v", got)
		}
	})
}
