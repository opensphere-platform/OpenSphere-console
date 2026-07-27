package collect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseFail2banStatusProjectsTheFixedSSHDJail(t *testing.T) {
	raw := `Status for the jail: sshd
|- Filter
|  |- Currently failed: 3
|  ` + "`" + `- Total failed: 41
` + "`" + `- Actions
   |- Currently banned: 3
   |- Total banned: 9
   ` + "`" + `- Banned IP list: 203.0.113.9 2001:db8::7 203.0.113.9
`
	state, ok := parseFail2banStatus([]byte(raw))
	if !ok {
		t.Fatal("status rejected")
	}
	if state.CurrentlyFailed != 3 || state.TotalFailed != 41 ||
		state.CurrentlyBanned != 3 || state.TotalBanned != 9 {
		t.Fatalf("counts were not projected: %#v", state)
	}
	if got := strings.Join(state.BannedAddresses, ","); got != "2001:db8::7,203.0.113.9" {
		t.Fatalf("addresses = %s", got)
	}
}

func TestParseFail2banStatusRejectsAnotherJailAndMalformedAddresses(t *testing.T) {
	if _, ok := parseFail2banStatus([]byte(
		"Status for the jail: nginx\nCurrently banned: 0\nBanned IP list:\n")); ok {
		t.Fatal("another jail was accepted")
	}
	state, ok := parseFail2banStatus([]byte(
		"Status for the jail: sshd\nCurrently banned: 1\nBanned IP list: not-an-ip\n"))
	if !ok || !state.Truncated || len(state.BannedAddresses) != 0 {
		t.Fatalf("malformed address was not omitted visibly: %#v ok=%t", state, ok)
	}
	if _, ok := parseFail2banStatus([]byte(
		"Status for the jail: sshd\nCurrently banned: 0\n")); ok {
		t.Fatal("status without an authoritative banned-address list was accepted")
	}
}

func TestFail2banCandidateAndRecentEventsAreBoundedProjections(t *testing.T) {
	candidate := parseFail2banCandidate([]byte(
		"fail2ban:\n  Installed: (none)\n  Candidate: 1.0.2-3ubuntu0.1\n"))
	if candidate != "1.0.2-3ubuntu0.1" {
		t.Fatalf("candidate = %q", candidate)
	}
	if value := parseFail2banCandidate([]byte("Candidate: (none)\n")); value != "" {
		t.Fatalf("missing candidate became %q", value)
	}

	path := filepath.Join(t.TempDir(), "fail2ban.log")
	raw := strings.Join([]string{
		"2026-08-01 11:57:00,001 fail2ban.filter [1]: INFO [sshd] Found 203.0.113.24",
		"2026-08-01 11:58:00,002 fail2ban.actions [1]: NOTICE [sshd] Ban 203.0.113.24",
		"2026-08-01 11:58:30,003 fail2ban.actions [1]: NOTICE [nginx] Ban 198.51.100.8",
		"2026-08-01 11:59:00,004 fail2ban.actions [1]: NOTICE [sshd] Unban not-an-ip",
	}, "\n")
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	events := readRecentFail2banEvents(path, time.UTC)
	if len(events) != 2 {
		t.Fatalf("events = %#v", events)
	}
	if events[0].Action != "ban" || events[0].Address != "203.0.113.24" ||
		events[0].OccurredAt != "2026-08-01T11:58:00Z" {
		t.Fatalf("latest event = %#v", events[0])
	}
	if events[1].Action != "found" {
		t.Fatalf("older event = %#v", events[1])
	}
}
