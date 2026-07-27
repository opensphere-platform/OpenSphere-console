package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

const opA = "2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f"
const opB = "9c4e1a2b-3d5f-4a6b-8c7d-0e1f2a3b4c5d"

func newStore(t *testing.T) (*Store, string, *time.Time) {
	t.Helper()
	dir := t.TempDir()
	clock := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	store, err := Open(dir, func() time.Time { return clock })
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return store, dir, &clock
}

func TestClaimIsExactlyOnce(t *testing.T) {
	store, _, _ := newStore(t)

	record, fresh, err := store.Claim(opA, 1, "service.restart", "sha256:aa")
	if err != nil || !fresh || record.Status != StatusClaimed {
		t.Fatalf("first claim should be fresh: %v %v %#v", err, fresh, record)
	}
	// A re-delivery of the same operation must not look claimable again.
	_, fresh, err = store.Claim(opA, 1, "service.restart", "sha256:aa")
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if fresh {
		t.Fatal("a re-delivered operation must never be claimed twice")
	}
}

func TestCompleteIsIdempotentAndFirstReceiptWins(t *testing.T) {
	store, _, _ := newStore(t)
	if _, _, err := store.Claim(opA, 1, "journal.query", "sha256:aa"); err != nil {
		t.Fatal(err)
	}
	first := json.RawMessage(`{"outcome":"succeeded"}`)
	if _, err := store.Complete(opA, first, map[string]string{"k": "v"}); err != nil {
		t.Fatal(err)
	}
	// A second, contradicting result must not overwrite what the control center
	// may already hold.
	second := json.RawMessage(`{"outcome":"failed"}`)
	record, err := store.Complete(opA, second, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(record.Receipt) != string(first) {
		t.Fatalf("first receipt must win, got %s", record.Receipt)
	}
	if record.Status != StatusComplete {
		t.Fatalf("status = %s", record.Status)
	}
}

func TestRecoverReturnsOnlyInterruptedWork(t *testing.T) {
	store, _, _ := newStore(t)
	if _, _, err := store.Claim(opA, 1, "service.restart", "sha256:aa"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Claim(opB, 1, "journal.query", "sha256:bb"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Complete(opB, json.RawMessage(`{}`), nil); err != nil {
		t.Fatal(err)
	}
	pending, err := store.Recover()
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].OperationID != opA {
		t.Fatalf("expected only the interrupted operation, got %#v", pending)
	}
}

func TestStateSurvivesReopen(t *testing.T) {
	store, dir, clock := newStore(t)
	if _, _, err := store.Claim(opA, 2, "host.reboot", "sha256:aa"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEvidence(opA, map[string]string{"bootIdBefore": "abc123"}); err != nil {
		t.Fatal(err)
	}

	// Simulate a process restart: a brand new Store over the same directory.
	reopened, err := Open(dir, func() time.Time { return *clock })
	if err != nil {
		t.Fatal(err)
	}
	record, err := reopened.Load(opA)
	if err != nil || record == nil {
		t.Fatalf("record lost across restart: %v %#v", err, record)
	}
	if record.Evidence["bootIdBefore"] != "abc123" {
		t.Fatalf("evidence lost: %#v", record.Evidence)
	}
	if record.Attempt != 2 || record.Operation != "host.reboot" {
		t.Fatalf("record corrupted: %#v", record)
	}
}

func TestTornWriteIsTreatedAsInterrupted(t *testing.T) {
	store, dir, _ := newStore(t)
	if _, _, err := store.Claim(opA, 1, "journal.query", "sha256:aa"); err != nil {
		t.Fatal(err)
	}
	// A crash mid-write leaves invalid JSON. It must never be read as complete.
	if err := os.WriteFile(filepath.Join(dir, opA+".json"), []byte(`{"operationId":"2b0`), 0o600); err != nil {
		t.Fatal(err)
	}
	record, err := store.Load(opA)
	if err != nil {
		t.Fatal(err)
	}
	if record == nil || record.Status == StatusComplete {
		t.Fatalf("a torn record must not be complete: %#v", record)
	}
	pending, err := store.Recover()
	if err != nil || len(pending) != 1 {
		t.Fatalf("torn record must appear as interrupted: %v %#v", err, pending)
	}
}

func TestFilePermissionsAreRestrictive(t *testing.T) {
	store, dir, _ := newStore(t)
	if _, _, err := store.Claim(opA, 1, "journal.query", "sha256:aa"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, opA+".json"))
	if err != nil {
		t.Fatal(err)
	}
	// Journal output and unit names must not be readable by other local users.
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("record mode %v is too permissive", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm()&0o077 != 0 {
		t.Fatalf("state directory mode %v is too permissive", dirInfo.Mode().Perm())
	}
}

func TestOperationIDIsNeverUsedAsAPath(t *testing.T) {
	store, _, _ := newStore(t)
	for _, hostile := range []string{
		"../../etc/passwd",
		"..",
		"a/b",
		"",
		"2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f/../../x",
	} {
		if _, _, err := store.Claim(hostile, 1, "journal.query", "sha256:aa"); err == nil {
			t.Fatalf("%q must be refused as a state file name", hostile)
		}
	}
}

func TestPruneBoundsRetention(t *testing.T) {
	dir := t.TempDir()
	clock := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	store, err := Open(dir, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	// More completed records than the retention bound.
	for i := 0; i < MaxRecords+25; i++ {
		id := uuidLike(i)
		if _, _, err := store.Claim(id, 1, "journal.query", "sha256:aa"); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Complete(id, json.RawMessage(`{}`), nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Prune(); err != nil {
		t.Fatal(err)
	}
	all, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) > MaxRecords {
		t.Fatalf("retention not bounded: %d records", len(all))
	}
}

func TestPruneKeepsInterruptedWork(t *testing.T) {
	dir := t.TempDir()
	clock := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	store, err := Open(dir, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	// An interrupted record must survive pruning: it still needs recovery.
	if _, _, err := store.Claim(opA, 1, "host.reboot", "sha256:aa"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < MaxRecords+10; i++ {
		id := uuidLike(i)
		if _, _, err := store.Claim(id, 1, "journal.query", "sha256:aa"); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Complete(id, json.RawMessage(`{}`), nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Prune(); err != nil {
		t.Fatal(err)
	}
	if record, err := store.Load(opA); err != nil || record == nil {
		t.Fatalf("interrupted record was pruned: %v %#v", err, record)
	}
}

func uuidLike(i int) string {
	const hex = "0123456789abcdef"
	base := []byte("00000000-0000-4000-8000-000000000000")
	base[len(base)-1] = hex[i%16]
	base[len(base)-2] = hex[(i/16)%16]
	base[len(base)-3] = hex[(i/256)%16]
	return string(base)
}

// The exactly-once gate under real concurrency.
func TestConcurrentClaimHasExactlyOneWinner(t *testing.T) {
	store, _, _ := newStore(t)
	const goroutines = 100

	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		fresh    int
		existing int
		errs     []error
	)
	start := make(chan struct{})
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start // maximise the overlap
			_, isFresh, err := store.Claim(opA, 1, "service.restart", "sha256:aa")
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs = append(errs, err)
				return
			}
			if isFresh {
				fresh++
			} else {
				existing++
			}
		}()
	}
	close(start)
	wg.Wait()

	if len(errs) != 0 {
		t.Fatalf("claims errored: %v", errs[0])
	}
	if fresh != 1 {
		t.Fatalf("exactly one goroutine may win the claim, got %d", fresh)
	}
	if existing != goroutines-1 {
		t.Fatalf("every loser must see an existing claim, got %d", existing)
	}
}

// Two independent Stores model two processes sharing the directory.
func TestTwoStoresCannotBothClaim(t *testing.T) {
	dir := t.TempDir()
	clock := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	first, err := Open(dir, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	second, err := Open(dir, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	results := make([]bool, 2)
	for i, store := range []*Store{first, second} {
		wg.Add(1)
		go func(idx int, s *Store) {
			defer wg.Done()
			_, isFresh, err := s.Claim(opA, 1, "host.reboot", "sha256:aa")
			if err != nil {
				t.Errorf("store %d: %v", idx, err)
				return
			}
			results[idx] = isFresh
		}(i, store)
	}
	wg.Wait()

	winners := 0
	for _, won := range results {
		if won {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("exactly one store may claim, got %d", winners)
	}
}

func TestClaimLeavesNoRecordWhenItFails(t *testing.T) {
	store, dir, _ := newStore(t)
	// Make the directory read-only so the create fails.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Skipf("cannot make directory read-only: %v", err)
	}
	defer os.Chmod(dir, 0o700)

	if _, fresh, err := store.Claim(opA, 1, "journal.query", "sha256:aa"); err == nil && fresh {
		t.Fatal("a failed claim must not report success")
	}
}

func TestNonRegularAndUnsafeRecordsAreRefused(t *testing.T) {
	store, dir, _ := newStore(t)

	// A symlink pointing anywhere must never be followed.
	link := filepath.Join(dir, opA+".json")
	target := filepath.Join(dir, "elsewhere.json")
	if err := os.WriteFile(target, []byte(`{"status":"complete"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	record, err := store.Load(opA)
	if err != nil {
		t.Fatal(err)
	}
	// A refused record must read as interrupted, never as complete, or the
	// operation could run a second time.
	if record == nil || record.Status == StatusComplete {
		t.Fatalf("a symlinked record must not be trusted: %#v", record)
	}
	_ = os.Remove(link)

	// A group-readable record leaks journal output and is refused.
	loose := filepath.Join(dir, opB+".json")
	if err := os.WriteFile(loose, []byte(`{"status":"complete"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// Set the mode explicitly: umask would otherwise mask the bits away and the
	// test would silently assert nothing.
	if err := os.Chmod(loose, 0o644); err != nil {
		t.Fatal(err)
	}
	if r, _ := store.Load(opB); r == nil || r.Status == StatusComplete {
		t.Fatalf("a world-readable record must not be trusted: %#v", r)
	}
}

func TestOversizedRecordIsRefused(t *testing.T) {
	store, dir, _ := newStore(t)
	huge := make([]byte, MaxRecordBytes+1024)
	for i := range huge {
		huge[i] = 'x'
	}
	if err := os.WriteFile(filepath.Join(dir, opA+".json"), huge, 0o600); err != nil {
		t.Fatal(err)
	}
	record, err := store.Load(opA)
	if err != nil {
		t.Fatal(err)
	}
	if record == nil || record.Status == StatusComplete {
		t.Fatalf("an oversized record must not be trusted: %#v", record)
	}
}

func TestDirectorySyncFailureIsFatal(t *testing.T) {
	// A store pointed at a directory that has been removed cannot make its
	// writes durable, and must say so rather than silently continuing.
	dir := t.TempDir()
	clock := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	store, err := Open(dir, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Claim(opA, 1, "journal.query", "sha256:aa"); err == nil {
		t.Fatal("a claim that cannot be made durable must fail closed")
	}
}

func TestUnsupportedSyncErrnoIsTolerated(t *testing.T) {
	// Only errno values meaning "this filesystem cannot fsync a directory" are
	// tolerated; a genuine IO error must not be.
	for _, tolerated := range []syscall.Errno{syscall.EINVAL, syscall.ENOTSUP, syscall.EBADF} {
		if !isUnsupportedSync(tolerated) {
			t.Errorf("%v should be treated as unsupported", tolerated)
		}
	}
	for _, fatal := range []syscall.Errno{syscall.EIO, syscall.ENOSPC, syscall.EACCES} {
		if isUnsupportedSync(fatal) {
			t.Errorf("%v is a real failure and must not be tolerated", fatal)
		}
	}
}
