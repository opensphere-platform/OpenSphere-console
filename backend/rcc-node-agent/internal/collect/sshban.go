package collect

import (
	"context"
	"errors"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"opensphere.io/rcc/node-agent/internal/snapshot"
	"opensphere.io/rcc/node-agent/internal/sshprotection"
)

const (
	sshBanProvider     = "fail2ban"
	sshBanJail         = "sshd"
	sshBanProbeTimeout = 10 * time.Second
	sshBanProbeMaxRead = 64 * 1024
	fail2banLogPath    = "/var/log/fail2ban.log"
)

// Fixed paths and argv only. Neither configuration nor a control-center plan
// can choose a binary or jail.
var fail2banClientPaths = []string{
	"/usr/bin/fail2ban-client",
	"/usr/local/bin/fail2ban-client",
	"/bin/fail2ban-client",
}

var aptCachePaths = []string{"/usr/bin/apt-cache"}

var fail2banEventRe = regexp.MustCompile(
	`^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:,\d+)?\s+.*\[sshd\]\s+(Found|Ban|Unban)\s+(\S+)`,
)

// probeSSHBan reads Fail2ban's fixed sshd jail without modifying it.
func probeSSHBan(ctx context.Context, now time.Time) (snapshot.SSHBanState, error) {
	state := snapshot.SSHBanState{
		Provider:        sshBanProvider,
		Jail:            sshBanJail,
		BannedAddresses: []string{},
		RecentEvents:    []snapshot.SSHBanEvent{},
		CollectedAt:     now.UTC().Format(time.RFC3339),
	}
	state.PackageVersion, state.CandidateVersion = probeFail2banPackage(ctx)
	state.Installed = state.PackageVersion != ""
	state.RecentEvents = readRecentFail2banEvents(fail2banLogPath, time.Local)
	binary := firstExisting(fail2banClientPaths)
	if binary == "" {
		state.UnsupportedReason = "fail2ban-client is not installed on this host"
		return state, nil
	}
	state.Installed = true

	raw, err := runBounded(
		ctx,
		sshBanProbeTimeout,
		sshBanProbeMaxRead,
		binary,
		[]string{"status", sshBanJail},
	)
	if err != nil {
		state.UnsupportedReason = "the Fail2ban sshd jail is not active or its status cannot be read"
		return state, errors.New(state.UnsupportedReason)
	}

	parsed, ok := parseFail2banStatus(raw)
	if !ok {
		state.UnsupportedReason = "fail2ban-client returned an unrecognised sshd jail status"
		return state, errors.New(state.UnsupportedReason)
	}
	parsed.Provider = sshBanProvider
	parsed.Jail = sshBanJail
	parsed.Installed = true
	parsed.PackageVersion = state.PackageVersion
	parsed.CandidateVersion = state.CandidateVersion
	parsed.ProtectionProfile = state.ProtectionProfile
	parsed.RecentEvents = state.RecentEvents
	parsed.Active = true
	parsed.Supported = true
	parsed.CollectedAt = state.CollectedAt

	// These values live behind separate fixed commands. Failure to read one is
	// not confused with a dead jail: status and the ban list remain valid.
	parsed.BanTimeSeconds = probeFail2banInteger(ctx, binary, "bantime")
	parsed.FindTimeSeconds = probeFail2banInteger(ctx, binary, "findtime")
	if value := probeFail2banInteger(ctx, binary, "maxretry"); value > 0 {
		parsed.MaxRetry = int(value)
	}
	return parsed, nil
}

func probeFail2banPackage(ctx context.Context) (installed, candidate string) {
	if dpkg := firstExisting(dpkgPaths); dpkg != "" {
		raw, err := runBounded(
			ctx, sshBanProbeTimeout, 2048, dpkg,
			[]string{"-W", "-f=${db:Status-Abbrev}\t${Version}\n", "fail2ban"},
		)
		if err == nil {
			fields := strings.Fields(string(raw))
			if len(fields) >= 2 && strings.HasPrefix(fields[0], "ii") {
				installed = fields[1]
			}
		}
	}
	if aptCache := firstExisting(aptCachePaths); aptCache != "" {
		raw, err := runBounded(
			ctx, sshBanProbeTimeout, 4096, aptCache,
			[]string{"policy", "fail2ban"},
		)
		if err == nil {
			candidate = parseFail2banCandidate(raw)
		}
	}
	return installed, candidate
}

func parseFail2banCandidate(raw []byte) string {
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "Candidate:") {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(line, "Candidate:"))
		if value != "" && value != "(none)" {
			return value
		}
		break
	}
	return ""
}

func inspectSSHProtectionProfile(protected []string) (string, string, error) {
	addresses, err := sshprotection.CanonicalAddresses(protected)
	if err != nil {
		return "", "", err
	}
	state, err := sshprotection.Inspect(sshprotection.ConfigPath, addresses)
	return state.Kind, state.Digest, err
}

// readRecentFail2banEvents projects only time, action and exact address from a
// bounded tail of Fail2ban's log. Raw log messages, usernames and credentials
// never enter the host snapshot.
func readRecentFail2banEvents(path string, location *time.Location) []snapshot.SSHBanEvent {
	file, err := os.Open(path)
	if err != nil {
		return []snapshot.SSHBanEvent{}
	}
	defer file.Close()

	const maxRead = int64(128 * 1024)
	info, err := file.Stat()
	if err != nil {
		return []snapshot.SSHBanEvent{}
	}
	offset := info.Size() - maxRead
	if offset < 0 {
		offset = 0
	}
	if _, err := file.Seek(offset, 0); err != nil {
		return []snapshot.SSHBanEvent{}
	}
	buffer := make([]byte, maxRead)
	n, _ := file.Read(buffer)
	lines := strings.Split(string(buffer[:n]), "\n")
	events := make([]snapshot.SSHBanEvent, 0, min(snapshot.MaxSSHBanEvents, len(lines)))
	for index := len(lines) - 1; index >= 0 && len(events) < snapshot.MaxSSHBanEvents; index-- {
		match := fail2banEventRe.FindStringSubmatch(strings.TrimSpace(lines[index]))
		if match == nil {
			continue
		}
		parsed := net.ParseIP(strings.TrimSpace(match[3]))
		if parsed == nil {
			continue
		}
		occurred, err := time.ParseInLocation("2006-01-02 15:04:05", match[1], location)
		if err != nil {
			continue
		}
		events = append(events, snapshot.SSHBanEvent{
			OccurredAt: occurred.UTC().Format(time.RFC3339),
			Action:     strings.ToLower(match[2]),
			Address:    parsed.String(),
		})
	}
	return events
}

func probeFail2banInteger(ctx context.Context, binary, key string) int64 {
	raw, err := runBounded(
		ctx,
		sshBanProbeTimeout,
		1024,
		binary,
		[]string{"get", sshBanJail, key},
	)
	if err != nil {
		return 0
	}
	value, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return 0
	}
	return value
}

// parseFail2banStatus accepts the stable labels emitted by fail2ban-client and
// ignores the tree-drawing prefix, which differs between versions and locales
// configured with the C environment.
func parseFail2banStatus(raw []byte) (snapshot.SSHBanState, bool) {
	state := snapshot.SSHBanState{BannedAddresses: []string{}}
	seenStatus := false
	seenBannedList := false
	addresses := map[string]bool{}

	for _, rawLine := range strings.Split(string(raw), "\n") {
		line := strings.TrimSpace(rawLine)
		switch {
		case strings.Contains(line, "Status for the jail:"):
			seenStatus = strings.TrimSpace(strings.SplitN(line, ":", 2)[1]) == sshBanJail
		case strings.Contains(line, "Currently failed:"):
			state.CurrentlyFailed = trailingInt(line)
		case strings.Contains(line, "Total failed:"):
			state.TotalFailed = trailingInt(line)
		case strings.Contains(line, "Currently banned:"):
			state.CurrentlyBanned = trailingInt(line)
		case strings.Contains(line, "Total banned:"):
			state.TotalBanned = trailingInt(line)
		case strings.Contains(line, "Banned IP list:"):
			seenBannedList = true
			tail := strings.TrimSpace(strings.SplitN(line, ":", 2)[1])
			for _, candidate := range strings.Fields(tail) {
				ip := net.ParseIP(candidate)
				if ip == nil {
					state.Truncated = true
					continue
				}
				canonical := ip.String()
				if addresses[canonical] {
					continue
				}
				addresses[canonical] = true
				if len(state.BannedAddresses) < snapshot.MaxSSHBanAddresses {
					state.BannedAddresses = append(state.BannedAddresses, canonical)
				} else {
					state.Truncated = true
				}
			}
		}
	}

	sort.Strings(state.BannedAddresses)
	if state.CurrentlyBanned < len(state.BannedAddresses) {
		state.CurrentlyBanned = len(state.BannedAddresses)
	}
	if state.CurrentlyBanned > len(state.BannedAddresses) {
		state.Truncated = true
	}
	return state, seenStatus && seenBannedList
}

func trailingInt(line string) int {
	index := strings.LastIndex(line, ":")
	if index < 0 {
		return 0
	}
	value, err := strconv.Atoi(strings.TrimSpace(line[index+1:]))
	if err != nil || value < 0 {
		return 0
	}
	return value
}
