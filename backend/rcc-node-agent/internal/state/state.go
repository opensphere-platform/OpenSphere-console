// Package state gives the agent durable, crash-safe, exactly-once operation
// state on local disk.
//
// The property that matters: an operation must never execute twice. Network
// loss, a lease timeout, SIGKILL mid-execution, or a reboot in the middle of a
// reboot operation must all resolve to "already done" rather than "try again".
//
// That is achieved by recording intent *before* acting:
//
//	claim(op)   -> intent file written and fsynced        -> only now may we act
//	complete(op)-> receipt file written and fsynced       -> replayed on demand
//
// On restart, any intent without a receipt is a crashed attempt. It is closed
// out as failed rather than retried, because the agent cannot know how far the
// side effect got. The one exception is host.reboot, which carries enough
// evidence (the pre-reboot boot id) to decide the outcome after the fact.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	// DefaultDir is root-owned and must not be world readable: journal output
	// and unit names are operational detail.
	DefaultDir = "/var/lib/rcc-node-agent"

	dirMode  os.FileMode = 0o700
	fileMode os.FileMode = 0o600

	// MaxRecords bounds retention so a long-lived host cannot fill its disk.
	MaxRecords = 200
	// MaxRecordAge discards receipts the control center has long since stored.
	MaxRecordAge = 30 * 24 * time.Hour

	// StatusClaimed means we recorded intent but have no receipt: either work is
	// in flight, or we crashed while doing it.
	StatusClaimed = "claimed"
	// StatusComplete means a receipt exists and may be replayed forever.
	StatusComplete = "complete"
)

var operationIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Record is one operation's durable footprint.
type Record struct {
	OperationID   string            `json:"operationId"`
	Attempt       int               `json:"attempt"`
	Operation     string            `json:"operation"`
	ContentDigest string            `json:"contentDigest"`
	Status        string            `json:"status"`
	ClaimedAt     time.Time         `json:"claimedAt"`
	CompletedAt   time.Time         `json:"completedAt,omitempty"`
	Receipt       json.RawMessage   `json:"receipt,omitempty"`
	Evidence      map[string]string `json:"evidence,omitempty"`
}

// Store is a directory of one JSON file per operation.
//
// One file per operation keeps recovery trivially correct: there is no shared
// index to become inconsistent with the files, and a torn write affects exactly
// one operation, which is then treated as crashed.
type Store struct {
	dir string
	now func() time.Time
}

// Open creates the state directory if needed and verifies its permissions.
func Open(dir string, now func() time.Time) (*Store, error) {
	if dir == "" {
		dir = DefaultDir
	}
	if now == nil {
		now = time.Now
	}
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return nil, fmt.Errorf("cannot create state directory: %w", err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("cannot stat state directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	// A group- or world-accessible state directory would leak journal output.
	if info.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(dir, dirMode); err != nil {
			return nil, fmt.Errorf("state directory %s is too permissive and cannot be fixed: %w", dir, err)
		}
	}
	return &Store{dir: dir, now: now}, nil
}

// Dir exposes the resolved directory for diagnostics.
func (s *Store) Dir() string { return s.dir }

func (s *Store) path(operationID string) (string, error) {
	if !operationIDRe.MatchString(operationID) {
		return "", fmt.Errorf("refusing to use %q as a state file name", operationID)
	}
	return filepath.Join(s.dir, operationID+".json"), nil
}

// MaxRecordBytes bounds a single record so a corrupted or hostile file cannot
// exhaust memory during recovery.
const MaxRecordBytes = 512 * 1024

// readRecordFile reads one record with the file's own integrity checked first.
//
// A symlink, a device node, a file owned by someone else, or a file another
// local user can write would all mean the agent is trusting state it does not
// control. Each is refused rather than parsed.
func (s *Store) readRecordFile(target string) ([]byte, error) {
	file, err := os.OpenFile(target, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", target)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s is group or world accessible (mode %v)", target, info.Mode().Perm())
	}
	if err := checkOwnership(info, target); err != nil {
		return nil, err
	}
	if info.Size() > MaxRecordBytes {
		return nil, fmt.Errorf("%s is %d bytes, above the %d byte record limit", target, info.Size(), MaxRecordBytes)
	}
	return io.ReadAll(io.LimitReader(file, MaxRecordBytes+1))
}

// Load returns the record for an operation, or nil when none exists.
func (s *Store) Load(operationID string) (*Record, error) {
	target, err := s.path(operationID)
	if err != nil {
		return nil, err
	}
	raw, err := s.readRecordFile(target)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		// An unreadable or untrustworthy record must never be treated as
		// absent: that would let the operation run a second time. Report it as
		// an interrupted attempt so recovery closes it out.
		return &Record{OperationID: operationID, Status: StatusClaimed, ClaimedAt: s.now()}, nil
	}
	var record Record
	if err := json.Unmarshal(raw, &record); err != nil {
		// A truncated file is a crash during write. Treat it as a claimed
		// attempt with no receipt so recovery closes it out rather than
		// re-running the side effect.
		return &Record{OperationID: operationID, Status: StatusClaimed, ClaimedAt: s.now()}, nil
	}
	return &record, nil
}

// Claim records the intent to run an operation.
//
// It returns the existing record when one is already present, so a caller can
// distinguish "mine to run" from "already claimed" and from "already complete"
// without a second read. This is the exactly-once gate: nothing may execute
// before Claim has returned successfully, which means the intent is on disk.
func (s *Store) Claim(operationID string, attempt int, operation, contentDigest string) (*Record, bool, error) {
	target, err := s.path(operationID)
	if err != nil {
		return nil, false, err
	}
	record := &Record{
		OperationID:   operationID,
		Attempt:       attempt,
		Operation:     operation,
		ContentDigest: contentDigest,
		Status:        StatusClaimed,
		ClaimedAt:     s.now(),
	}
	payload, err := json.Marshal(record)
	if err != nil {
		return nil, false, err
	}

	// The claim is the exactly-once gate, so it must be atomic against both
	// concurrent goroutines and a second process sharing the directory. A
	// Load-then-write sequence has a window in which two callers both see "no
	// record" and both proceed to execute. O_CREATE|O_EXCL closes that window
	// in the kernel: exactly one caller creates the file, everyone else gets
	// EEXIST and is told the operation is already claimed.
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, fileMode)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			existing, loadErr := s.Load(operationID)
			if loadErr != nil {
				return nil, false, loadErr
			}
			if existing == nil {
				// Removed between EEXIST and the read; treat as claimed by
				// somebody else rather than racing again.
				return &Record{OperationID: operationID, Status: StatusClaimed, ClaimedAt: s.now()}, false, nil
			}
			return existing, false, nil
		}
		return nil, false, err
	}

	// From here the file exists; a failure must not leave an empty record that
	// would be read as an interrupted attempt for an operation never started.
	if _, err := file.Write(payload); err != nil {
		file.Close()
		_ = os.Remove(target)
		return nil, false, err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		_ = os.Remove(target)
		return nil, false, err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(target)
		return nil, false, err
	}
	if err := s.syncDir(); err != nil {
		return nil, false, err
	}
	return record, true, nil
}

// Complete stores the receipt. Calling it twice is harmless; the first receipt
// wins, because a second result for the same operation would contradict the
// one the control center may already have stored.
func (s *Store) Complete(operationID string, receipt json.RawMessage, evidence map[string]string) (*Record, error) {
	record, err := s.Load(operationID)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return nil, fmt.Errorf("cannot complete unclaimed operation %s", operationID)
	}
	if record.Status == StatusComplete {
		return record, nil
	}
	record.Status = StatusComplete
	record.CompletedAt = s.now()
	record.Receipt = receipt
	if len(evidence) > 0 {
		if record.Evidence == nil {
			record.Evidence = map[string]string{}
		}
		for k, v := range evidence {
			record.Evidence[k] = v
		}
	}
	if err := s.write(record); err != nil {
		return nil, err
	}
	return record, nil
}

// SetEvidence persists intermediate facts that must survive a reboot, such as
// the boot id observed immediately before invoking systemctl reboot.
func (s *Store) SetEvidence(operationID string, evidence map[string]string) error {
	record, err := s.Load(operationID)
	if err != nil {
		return err
	}
	if record == nil {
		return fmt.Errorf("cannot annotate unclaimed operation %s", operationID)
	}
	if record.Evidence == nil {
		record.Evidence = map[string]string{}
	}
	for k, v := range evidence {
		record.Evidence[k] = v
	}
	return s.write(record)
}

// write replaces the record atomically and durably.
//
// Write to a temporary file, fsync it, rename over the target, then fsync the
// directory. Without the directory fsync the rename itself can be lost, which
// would resurrect a stale record after a power failure.
func (s *Store) write(record *Record) error {
	target, err := s.path(record.OperationID)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(record)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(s.dir, ".tmp-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)

	if err := temp.Chmod(fileMode); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(payload); err != nil {
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
	if err := os.Rename(tempName, target); err != nil {
		return err
	}
	return s.syncDir()
}

// syncDir makes a rename or create durable.
//
// Without it the directory entry can be lost on power failure even though the
// file contents were synced, which would resurrect a stale record or lose a
// claim. Only errno values that mean "this filesystem does not support
// directory fsync" are tolerated; anything else is a real durability failure
// and must fail closed rather than be silently ignored.
func (s *Store) syncDir() error {
	dir, err := os.Open(s.dir)
	if err != nil {
		return fmt.Errorf("cannot open state directory for sync: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		if isUnsupportedSync(err) {
			return nil
		}
		return fmt.Errorf("state directory sync failed: %w", err)
	}
	return nil
}

// isUnsupportedSync reports the narrow set of errors that mean the filesystem
// cannot fsync a directory at all, rather than that the sync failed.
func isUnsupportedSync(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	switch errno {
	case syscall.EINVAL, syscall.ENOTSUP, syscall.EBADF:
		return true
	default:
		return false
	}
}

// List returns every record, newest first.
func (s *Store) List() ([]*Record, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	records := make([]*Record, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		record, err := s.Load(id)
		if err != nil || record == nil {
			continue
		}
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].ClaimedAt.After(records[j].ClaimedAt) })
	return records, nil
}

// Recover returns operations that were claimed but never completed.
//
// These are crashed attempts. The caller must close them out as failed rather
// than re-running them, because the side effect may or may not have happened.
func (s *Store) Recover() ([]*Record, error) {
	all, err := s.List()
	if err != nil {
		return nil, err
	}
	pending := make([]*Record, 0, 4)
	for _, record := range all {
		if record.Status != StatusComplete {
			pending = append(pending, record)
		}
	}
	return pending, nil
}

// Prune bounds retention by age and count. Completed records are dropped first;
// a claimed record is never pruned while it could still need recovery.
func (s *Store) Prune() (int, error) {
	all, err := s.List()
	if err != nil {
		return 0, err
	}
	cutoff := s.now().Add(-MaxRecordAge)
	removed := 0
	kept := 0
	for _, record := range all {
		if record.Status != StatusComplete {
			continue
		}
		stale := record.CompletedAt.Before(cutoff)
		overCount := kept >= MaxRecords
		if !stale && !overCount {
			kept++
			continue
		}
		target, err := s.path(record.OperationID)
		if err != nil {
			continue
		}
		if os.Remove(target) == nil {
			removed++
		}
	}
	if removed > 0 {
		// The removals must be durable too, or a pruned record can reappear.
		if err := s.syncDir(); err != nil {
			return removed, err
		}
	}
	return removed, nil
}
