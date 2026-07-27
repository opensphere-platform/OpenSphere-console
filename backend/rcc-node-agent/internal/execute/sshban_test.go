package execute

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"opensphere.io/rcc/node-agent/internal/plan"
	"opensphere.io/rcc/node-agent/internal/sshprotection"
)

func sshBanStatus(addresses ...string) Result {
	return Result{ExitCode: 0, Stdout: "Status for the jail: sshd\n" +
		"Currently banned: 0\nBanned IP list: " + strings.Join(addresses, " ") + "\n"}
}

func TestSSHBanUsesOnlyTheFixedJailAndExactAddress(t *testing.T) {
	runner := &scriptedRunner{results: []Result{
		sshBanStatus(),
		{ExitCode: 0, Stdout: "1\n"},
		sshBanStatus("203.0.113.24"),
	}}
	executor := &SSHBanExecutor{
		Runner: runner, Enabled: true, ProtectedAddresses: []string{"198.51.100.10"},
		Fail2banClientPath: "/fake/fail2ban-client",
		Now:                func() time.Time { return time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC) },
	}
	result, evidence, err := executor.Apply(context.Background(), plan.OpSSHBan, &plan.SSHBanArgs{
		Jail: "sshd", Address: "203.0.113.24", ExpectedBanned: false,
	})
	if err != nil {
		t.Fatalf("ban failed: %v (%s)", err, result.Stdout)
	}
	want := []string{"/fake/fail2ban-client", "set", "sshd", "banip", "203.0.113.24"}
	if got := strings.Join(runner.calls[1], " "); got != strings.Join(want, " ") {
		t.Fatalf("argv = %q", got)
	}
	if evidence["beforeBanned"] != "false" || evidence["afterBanned"] != "true" {
		t.Fatalf("verification evidence = %#v", evidence)
	}
}

func TestSSHBanRefusesProtectedAndStaleTargetsBeforeMutation(t *testing.T) {
	protectedRunner := &scriptedRunner{}
	protected := &SSHBanExecutor{
		Runner: protectedRunner, Enabled: true,
		ProtectedAddresses: []string{"203.0.113.24"},
		Fail2banClientPath: "/fake/fail2ban-client",
	}
	if _, _, err := protected.Apply(context.Background(), plan.OpSSHBan, &plan.SSHBanArgs{
		Jail: "sshd", Address: "203.0.113.24",
	}); err == nil {
		t.Fatal("protected address was accepted")
	}
	if len(protectedRunner.calls) != 0 {
		t.Fatal("protected address reached fail2ban")
	}

	staleRunner := &scriptedRunner{results: []Result{sshBanStatus("198.51.100.9")}}
	stale := &SSHBanExecutor{Runner: staleRunner, Enabled: true, Fail2banClientPath: "/fake/fail2ban-client"}
	if _, _, err := stale.Apply(context.Background(), plan.OpSSHBan, &plan.SSHBanArgs{
		Jail: "sshd", Address: "198.51.100.9", ExpectedBanned: false,
	}); err == nil || !strings.Contains(err.Error(), "changed after review") {
		t.Fatalf("stale state was not refused: %v", err)
	}
	if len(staleRunner.calls) != 1 {
		t.Fatalf("stale state ran a mutation: %#v", staleRunner.calls)
	}
}

func TestSSHBanRefusesMalformedStatusAndInvalidReviewState(t *testing.T) {
	malformedRunner := &scriptedRunner{results: []Result{{
		ExitCode: 0, Stdout: "Status for the jail: sshd\nCurrently banned: 0\n",
	}}}
	malformed := &SSHBanExecutor{
		Runner: malformedRunner, Enabled: true, Fail2banClientPath: "/fake/fail2ban-client",
	}
	if _, _, err := malformed.Apply(context.Background(), plan.OpSSHBan, &plan.SSHBanArgs{
		Jail: "sshd", Address: "203.0.113.24", ExpectedBanned: false,
	}); err == nil || !strings.Contains(err.Error(), "unrecognised") {
		t.Fatalf("malformed live status was accepted: %v", err)
	}
	if len(malformedRunner.calls) != 1 {
		t.Fatalf("malformed status ran a mutation: %#v", malformedRunner.calls)
	}

	truncatedRunner := &scriptedRunner{results: []Result{{
		ExitCode: 0, Stdout: sshBanStatus().Stdout, Truncated: true,
	}}}
	truncated := &SSHBanExecutor{
		Runner: truncatedRunner, Enabled: true, Fail2banClientPath: "/fake/fail2ban-client",
	}
	if _, _, err := truncated.Apply(context.Background(), plan.OpSSHBan, &plan.SSHBanArgs{
		Jail: "sshd", Address: "203.0.113.24", ExpectedBanned: false,
	}); err == nil || !strings.Contains(err.Error(), "verification bound") {
		t.Fatalf("truncated live status was accepted: %v", err)
	}
	if len(truncatedRunner.calls) != 1 {
		t.Fatalf("truncated status ran a mutation: %#v", truncatedRunner.calls)
	}

	noRunner := &scriptedRunner{}
	executor := &SSHBanExecutor{
		Runner: noRunner, Enabled: true, Fail2banClientPath: "/fake/fail2ban-client",
	}
	if _, _, err := executor.Apply(context.Background(), plan.OpSSHBan, &plan.SSHBanArgs{
		Jail: "sshd", Address: "203.0.113.24", ExpectedBanned: true,
	}); err == nil || !strings.Contains(err.Error(), "must show") {
		t.Fatalf("invalid reviewed state was accepted: %v", err)
	}
	if len(noRunner.calls) != 0 {
		t.Fatalf("invalid review state reached fail2ban: %#v", noRunner.calls)
	}
	if _, _, err := executor.Apply(context.Background(), plan.OpSSHBan, nil); err == nil {
		t.Fatal("nil SSH ban arguments were accepted")
	}
}

func TestSSHProtectionInstallsPinnedPackageAndVerifiesFixedProfile(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "jail.d", "rcc-sshd.local")
	runner := &scriptedRunner{results: []Result{
		{
			ExitCode: 0,
			Stdout: "Inst fail2ban (1.0.2-3ubuntu0.1 Ubuntu:24.04/noble-updates [all])\n" +
				"Inst python3-pyinotify (0.9.6-2ubuntu1 Ubuntu:24.04/noble [all])\n",
		},
		{ExitCode: 0, Stdout: "installed\n"},
		{ExitCode: 0, Stdout: "OK: configuration test is successful\n"},
		{ExitCode: 0, Stdout: "enabled\n"},
		{ExitCode: 0, Stdout: "started\n"},
		sshBanStatus(),
	}}
	versionCalls := 0
	serviceCalls := 0
	executor := &SSHBanExecutor{
		Runner:             runner,
		Enabled:            true,
		ProtectedAddresses: []string{"203.0.113.10"},
		Fail2banClientPath: "/fake/fail2ban-client",
		AptGetPath:         "/fake/apt-get",
		SystemctlPath:      "/fake/systemctl",
		ConfigPath:         configPath,
		InstalledVersion: func(context.Context) (string, error) {
			versionCalls++
			if versionCalls == 1 {
				return "", nil
			}
			return "1.0.2-3ubuntu0.1", nil
		},
		ServiceState: func(context.Context) (fail2banServiceState, error) {
			serviceCalls++
			if serviceCalls == 1 {
				return fail2banServiceState{}, nil
			}
			return fail2banServiceState{Loaded: true}, nil
		},
		Now: func() time.Time {
			return time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
		},
	}
	result, evidence, err := executor.EnableProtection(context.Background(), &plan.SSHProtectionArgs{
		Provider:           "fail2ban",
		Jail:               "sshd",
		Profile:            plan.SSHProtectionProfile,
		PackageVersion:     "1.0.2-3ubuntu0.1",
		ExpectedInstalled:  false,
		ExpectedActive:     false,
		ProtectedAddresses: []string{"203.0.113.10"},
	})
	if err != nil {
		t.Fatalf("enable failed: %v (%s)", err, result.Stdout)
	}
	if len(runner.calls) != 6 {
		t.Fatalf("calls = %#v", runner.calls)
	}
	if got := strings.Join(runner.calls[0], " "); !strings.Contains(
		got, "/fake/apt-get -s") || !strings.Contains(got, "fail2ban=1.0.2-3ubuntu0.1") {
		t.Fatalf("simulation did not pin the reviewed package: %s", got)
	}
	if got := strings.Join(runner.calls[2], " "); got != "/fake/fail2ban-client -t" {
		t.Fatalf("configuration test argv = %s", got)
	}
	if got := strings.Join(runner.calls[3], " "); got !=
		"/fake/systemctl enable fail2ban.service" {
		t.Fatalf("service activation argv = %s", got)
	}
	if got := strings.Join(runner.calls[4], " "); got !=
		"/fake/systemctl start fail2ban.service" {
		t.Fatalf("service start argv = %s", got)
	}
	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("profile was not written: %v", err)
	}
	content := string(raw)
	for _, required := range []string{
		"# RCC profile: rcc-ssh-baseline-v1",
		"[sshd]",
		"enabled = true",
		"backend = systemd",
		"bantime = 3600",
		"findtime = 600",
		"maxretry = 5",
		"ignoreip = 127.0.0.1/8 ::1 203.0.113.10",
	} {
		if !strings.Contains(content, required) {
			t.Fatalf("profile misses %q:\n%s", required, content)
		}
	}
	if evidence["active"] != "true" || evidence["installedByOperation"] != "true" ||
		!strings.HasPrefix(evidence["profileDigest"], "sha256:") {
		t.Fatalf("evidence = %#v", evidence)
	}
}

func TestSSHProtectionRefusesChangedProtectedAddressesBeforeAnyCommand(t *testing.T) {
	runner := &scriptedRunner{}
	executor := &SSHBanExecutor{
		Runner:             runner,
		Enabled:            true,
		ProtectedAddresses: []string{"203.0.113.10"},
	}
	_, _, err := executor.EnableProtection(context.Background(), &plan.SSHProtectionArgs{
		Provider:           "fail2ban",
		Jail:               "sshd",
		Profile:            plan.SSHProtectionProfile,
		PackageVersion:     "1.0.2-3ubuntu0.1",
		ProtectedAddresses: []string{"203.0.113.11"},
	})
	if err == nil || !strings.Contains(err.Error(), "changed after review") {
		t.Fatalf("changed protected addresses were accepted: %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("a refused setup reached a command: %#v", runner.calls)
	}
}

func TestSSHProtectionReconcilesManagedProfileWithoutStoppingActiveService(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "jail.d", "rcc-sshd.local")
	oldContent := sshprotection.Config([]string{"203.0.113.10"})
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, oldContent, 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &scriptedRunner{results: []Result{
		sshBanStatus(),
		{ExitCode: 0, Stdout: "OK\n"},
		{ExitCode: 0, Stdout: "reloaded\n"},
		sshBanStatus(),
	}}
	executor := &SSHBanExecutor{
		Runner:             runner,
		Enabled:            true,
		ProtectedAddresses: []string{"203.0.113.11"},
		Fail2banClientPath: "/fake/fail2ban-client",
		SystemctlPath:      "/fake/systemctl",
		ConfigPath:         configPath,
		InstalledVersion: func(context.Context) (string, error) {
			return "1.0.2-3ubuntu0.1", nil
		},
		ServiceState: func(context.Context) (fail2banServiceState, error) {
			return fail2banServiceState{Loaded: true, Active: true, Enabled: true}, nil
		},
	}
	_, evidence, err := executor.EnableProtection(context.Background(), &plan.SSHProtectionArgs{
		Provider:              "fail2ban",
		Jail:                  "sshd",
		Profile:               plan.SSHProtectionProfile,
		PackageVersion:        "1.0.2-3ubuntu0.1",
		ExpectedProfileDigest: sshprotection.Digest(oldContent),
		ExpectedInstalled:     true,
		ExpectedActive:        true,
		ProtectedAddresses:    []string{"203.0.113.11"},
	})
	if err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}
	if got := strings.Join(runner.calls[2], " "); got != "/fake/fail2ban-client reload" {
		t.Fatalf("active service was not reloaded: %s", got)
	}
	for _, call := range runner.calls {
		joined := strings.Join(call, " ")
		if strings.Contains(joined, "systemctl stop") ||
			strings.Contains(joined, "systemctl disable") ||
			strings.Contains(joined, "systemctl restart") {
			t.Fatalf("reconciliation disrupted the active service: %s", joined)
		}
	}
	updated, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(updated), "203.0.113.11") ||
		strings.Contains(string(updated), "203.0.113.10") {
		t.Fatalf("profile was not reconciled:\n%s", updated)
	}
	if evidence["profileChanged"] != "true" {
		t.Fatalf("evidence = %#v", evidence)
	}
}

func TestSSHProtectionFailureRestoresManagedProfileAndExistingService(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "jail.d", "rcc-sshd.local")
	oldContent := sshprotection.Config([]string{"203.0.113.10"})
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, oldContent, 0o640); err != nil {
		t.Fatal(err)
	}
	runner := &scriptedRunner{results: []Result{
		sshBanStatus(),
		{ExitCode: 0, Stdout: "OK\n"},
		{ExitCode: 0, Stdout: "reloaded\n"},
		{ExitCode: 0, Stdout: "unrecognised status\n"},
		{ExitCode: 0, Stdout: "rollback reload\n"},
	}}
	executor := &SSHBanExecutor{
		Runner:             runner,
		Enabled:            true,
		ProtectedAddresses: []string{"203.0.113.11"},
		Fail2banClientPath: "/fake/fail2ban-client",
		SystemctlPath:      "/fake/systemctl",
		ConfigPath:         configPath,
		InstalledVersion: func(context.Context) (string, error) {
			return "1.0.2-3ubuntu0.1", nil
		},
		ServiceState: func(context.Context) (fail2banServiceState, error) {
			return fail2banServiceState{Loaded: true, Active: true, Enabled: true}, nil
		},
	}
	_, evidence, err := executor.EnableProtection(context.Background(), &plan.SSHProtectionArgs{
		Provider:              "fail2ban",
		Jail:                  "sshd",
		Profile:               plan.SSHProtectionProfile,
		PackageVersion:        "1.0.2-3ubuntu0.1",
		ExpectedProfileDigest: sshprotection.Digest(oldContent),
		ExpectedInstalled:     true,
		ExpectedActive:        true,
		ProtectedAddresses:    []string{"203.0.113.11"},
	})
	if err == nil || !strings.Contains(err.Error(), "could not be verified") {
		t.Fatalf("unverified reconciliation succeeded: %v", err)
	}
	restored, readErr := os.ReadFile(configPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(restored) != string(oldContent) {
		t.Fatalf("previous profile was not restored:\n%s", restored)
	}
	if evidence["rollback"] != "restored" {
		t.Fatalf("rollback evidence = %#v", evidence)
	}
	for _, call := range runner.calls {
		joined := strings.Join(call, " ")
		if strings.Contains(joined, "systemctl stop") ||
			strings.Contains(joined, "systemctl disable") {
			t.Fatalf("rollback stopped a service that was active before: %s", joined)
		}
	}
}
