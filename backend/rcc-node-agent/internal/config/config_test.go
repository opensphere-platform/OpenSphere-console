package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"testing"
	"time"
)

type fakeInfo struct {
	mode fs.FileMode
	dir  bool
}

func (f fakeInfo) Name() string       { return "agent.key" }
func (f fakeInfo) Size() int64        { return 32 }
func (f fakeInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.dir }
func (f fakeInfo) Sys() any           { return nil }

const goodSecret = "5f2b8c1d4e7a0396b5c8d1e4f7a0b3c6"

func fakeFS(mode fs.FileMode, secret string) (statFunc, readFunc) {
	stat := func(path string) (os.FileInfo, error) {
		if path == "/etc/rcc-node-agent/agent.key" || path == "/etc/rcc-node-agent/ca.pem" {
			return fakeInfo{mode: mode}, nil
		}
		return nil, errors.New("no such file")
	}
	read := func(path string) ([]byte, error) {
		if path == "/etc/rcc-node-agent/agent.key" {
			return []byte(secret + "\n"), nil
		}
		return nil, errors.New("no such file")
	}
	return stat, read
}

func goodFile() File {
	return File{
		ControlCenterURL: "https://rcc.cc2.opl.io.kr",
		ControlCenterID:  "cc2",
		HostID:           "node-a",
		KeyID:            "cc2-node-a-2026a",
		SecretFile:       "/etc/rcc-node-agent/agent.key",
	}
}

func TestValidateAppliesDefaults(t *testing.T) {
	stat, read := fakeFS(0o600, goodSecret)
	cfg, err := Validate(goodFile(), stat, read)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Interval != DefaultInterval || cfg.RequestTimeout != DefaultRequestTimeout {
		t.Fatalf("defaults not applied: %v %v", cfg.Interval, cfg.RequestTimeout)
	}
	if !cfg.CollectSystemdUnits {
		t.Fatal("systemd unit collection should default on")
	}
	if string(cfg.Secret) != goodSecret {
		t.Fatalf("secret not trimmed: %q", cfg.Secret)
	}
}

func TestValidateClampsIntervals(t *testing.T) {
	stat, read := fakeFS(0o600, goodSecret)
	f := goodFile()
	f.IntervalSeconds = 1
	f.RequestTimeoutSeconds = 9999
	cfg, err := Validate(f, stat, read)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Interval != MinInterval {
		t.Fatalf("interval floor not applied: %v", cfg.Interval)
	}
	if cfg.RequestTimeout != MaxRequestTimeout {
		t.Fatalf("timeout ceiling not applied: %v", cfg.RequestTimeout)
	}
}

func TestValidateFailsClosed(t *testing.T) {
	cases := map[string]func(*File){
		"http endpoint":       func(f *File) { f.ControlCenterURL = "http://rcc.cc2.opl.io.kr" },
		"no scheme":           func(f *File) { f.ControlCenterURL = "rcc.cc2.opl.io.kr" },
		"embedded credential": func(f *File) { f.ControlCenterURL = "https://user:pass@rcc.cc2.opl.io.kr" },
		"query string":        func(f *File) { f.ControlCenterURL = "https://rcc.cc2.opl.io.kr/?token=abc" },
		"fragment":            func(f *File) { f.ControlCenterURL = "https://rcc.cc2.opl.io.kr/#x" },
		"missing host":        func(f *File) { f.ControlCenterURL = "https:///path" },
		"base path":           func(f *File) { f.ControlCenterURL = "https://rcc.cc2.opl.io.kr/base" },
		"nested base path":    func(f *File) { f.ControlCenterURL = "https://rcc.cc2.opl.io.kr/a/b/" },
		"api path":            func(f *File) { f.ControlCenterURL = "https://rcc.cc2.opl.io.kr/api" },
		"encoded path":        func(f *File) { f.ControlCenterURL = "https://rcc.cc2.opl.io.kr/%61pi" },
		"bad control center":  func(f *File) { f.ControlCenterID = "CC2" },
		"bad host id":         func(f *File) { f.HostID = "node_a" },
		"bad key id":          func(f *File) { f.KeyID = "key id" },
		"missing secret file": func(f *File) { f.SecretFile = "" },
		"unknown secret file": func(f *File) { f.SecretFile = "/etc/rcc-node-agent/missing.key" },
		"unknown ca file":     func(f *File) { f.CACertificateFile = "/etc/rcc-node-agent/missing.pem" },
	}
	stat, read := fakeFS(0o600, goodSecret)
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			f := goodFile()
			mutate(&f)
			if _, err := Validate(f, stat, read); err == nil {
				t.Fatalf("expected %s to be rejected", name)
			}
		})
	}
}

// The endpoint is concatenated with a path that was signed independently, so a
// configured base path would be requested and never signed. A bare host is the
// only shape where the request made and the request signed are the same one.
func TestValidateAcceptsOnlyAPathlessEndpoint(t *testing.T) {
	stat, read := fakeFS(0o600, goodSecret)
	for _, raw := range []string{"https://rcc.cc2.opl.io.kr", "https://rcc.cc2.opl.io.kr/", "https://rcc.cc2.opl.io.kr:8443/"} {
		f := goodFile()
		f.ControlCenterURL = raw
		cfg, err := Validate(f, stat, read)
		if err != nil {
			t.Fatalf("%s must be accepted: %v", raw, err)
		}
		if cfg.ControlCenterURL.Path != "" {
			t.Fatalf("%s left a path on the endpoint: %q", raw, cfg.ControlCenterURL.Path)
		}
		// What the reporter concatenates must be exactly the signed path.
		const signed = "/api/control-centers/cc2/hosts/node-a/heartbeat"
		if got := cfg.ControlCenterURL.String() + signed; got != "https://"+cfg.ControlCenterURL.Host+signed {
			t.Fatalf("requested URL diverges from the signed path: %q", got)
		}
	}
}

func TestValidateRejectsWorldReadableSecret(t *testing.T) {
	for _, mode := range []fs.FileMode{0o644, 0o640, 0o604, 0o666} {
		stat, read := fakeFS(mode, goodSecret)
		if _, err := Validate(goodFile(), stat, read); err == nil {
			t.Fatalf("mode %#o must be rejected", mode)
		}
	}
	stat, read := fakeFS(0o400, goodSecret)
	if _, err := Validate(goodFile(), stat, read); err != nil {
		t.Fatalf("mode 0400 should be accepted: %v", err)
	}
}

func TestValidateRejectsWeakSecret(t *testing.T) {
	stat, read := fakeFS(0o600, "tooshort")
	if _, err := Validate(goodFile(), stat, read); err == nil {
		t.Fatal("short secret must be rejected")
	}
	stat, read = fakeFS(0o600, strings.Repeat("x", MaxSecretBytes+10))
	if _, err := Validate(goodFile(), stat, read); err == nil {
		t.Fatal("oversized secret file must be rejected")
	}
}

func TestRedactedNeverContainsSecret(t *testing.T) {
	stat, read := fakeFS(0o600, goodSecret)
	cfg, err := Validate(goodFile(), stat, read)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	line := cfg.Redacted()
	if strings.Contains(line, goodSecret) {
		t.Fatalf("redacted config leaked the signing key: %s", line)
	}
	if !strings.Contains(line, "keyId=cc2-node-a-2026a") {
		t.Fatalf("redacted config should keep the key id: %s", line)
	}
}

func TestLoadRejectsUnknownFields(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/agent.json"
	if err := os.WriteFile(path, []byte(`{"controlCenterUrl":"https://x","insecureSkipVerify":true}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "parse config") {
		t.Fatalf("unknown fields must be rejected, got %v", err)
	}
}

func TestLoadRejectsMissingFile(t *testing.T) {
	if _, err := Load(t.TempDir() + "/absent.json"); err == nil {
		t.Fatal("missing configuration must fail closed")
	}
}

// ── Stage 3: package maintenance is opt-in twice over ───────────────────────

func boolPtr(value bool) *bool { return &value }

func TestPackageMaintenanceIsOffByDefault(t *testing.T) {
	stat, read := fakeFS(0o600, goodSecret)
	cfg, err := Validate(goodFile(), stat, read)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PackagesEnabled {
		t.Fatal("installing a build that can update packages must not make a host updatable")
	}
	if len(cfg.PackageAllowlist) != 0 {
		t.Fatalf("a new host updates nothing, got %v", cfg.PackageAllowlist)
	}
	// Reporting changes nothing, so a host can be observed without being managed.
	if !cfg.CollectPackages {
		t.Fatal("inventory collection should default on")
	}
}

func TestPackagesEnabledRequiresTheOperationChannel(t *testing.T) {
	// Package maintenance is a typed operation. Enabling it without the channel
	// that delivers operations would be a setting that silently does nothing,
	// which reads to whoever set it as "this host now patches itself".
	stat, read := fakeFS(0o600, goodSecret)
	f := goodFile()
	f.PackagesEnabled = boolPtr(true)
	f.OperationsEnabled = boolPtr(false)
	if _, err := Validate(f, stat, read); err == nil {
		t.Fatal("packagesEnabled without operationsEnabled must refuse to start")
	}

	f.OperationsEnabled = boolPtr(true)
	cfg, err := Validate(f, stat, read)
	if err != nil {
		t.Fatalf("both enabled should be accepted: %v", err)
	}
	if !cfg.PackagesEnabled {
		t.Fatal("packagesEnabled was not applied")
	}
}

func TestAMalformedPackageAllowlistEntryStopsTheAgent(t *testing.T) {
	// A silently dropped entry reads as "allowed" to whoever wrote it, so a
	// typo must be a refusal to start rather than a narrower allowlist nobody
	// notices.
	for _, entry := range []string{
		"curl; rm -rf /", "--allow-downgrades", "/usr/bin/curl", "../../etc/passwd",
		"CURL", "curl:amd64", "c", "curl=1.0", "http://evil.example/pkg.deb",
	} {
		stat, read := fakeFS(0o600, goodSecret)
		f := goodFile()
		f.OperationsEnabled = boolPtr(true)
		f.PackagesEnabled = boolPtr(true)
		f.PackageAllowlist = []string{entry}
		if _, err := Validate(f, stat, read); err == nil {
			t.Fatalf("allowlist entry %q must stop the agent", entry)
		}
	}
}

func TestAKernelImageCannotBeAllowlistedAsAPackage(t *testing.T) {
	stat, read := fakeFS(0o600, goodSecret)
	f := goodFile()
	f.OperationsEnabled = boolPtr(true)
	f.PackagesEnabled = boolPtr(true)
	f.PackageAllowlist = []string{"linux-image-6.8.0-51-generic"}
	if _, err := Validate(f, stat, read); err == nil {
		t.Fatal("kernels go through kernel.update, which carries its own review")
	}
}

func TestPackageAllowlistIsDeduplicatedAndBounded(t *testing.T) {
	stat, read := fakeFS(0o600, goodSecret)
	f := goodFile()
	f.OperationsEnabled = boolPtr(true)
	f.PackagesEnabled = boolPtr(true)
	f.PackageAllowlist = []string{"curl", "curl", " openssl ", ""}
	cfg, err := Validate(f, stat, read)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.PackageAllowlist) != 2 {
		t.Fatalf("expected curl and openssl once each, got %v", cfg.PackageAllowlist)
	}

	oversized := make([]string, 0, MaxPackageAllowlist+1)
	for i := 0; i <= MaxPackageAllowlist; i++ {
		oversized = append(oversized, fmt.Sprintf("pkg%da", i))
	}
	f.PackageAllowlist = oversized
	if _, err := Validate(f, stat, read); err == nil {
		t.Fatal("an unbounded allowlist must be refused")
	}
}

// ── Stage 4 authorities ─────────────────────────────────────────────────────

func stage4File() File {
	f := goodFile()
	f.OperationsEnabled = boolPtr(true)
	return f
}

func TestStage4InventoryDefaultsOnBecauseReportingChangesNothing(t *testing.T) {
	stat, read := fakeFS(0o600, goodSecret)
	cfg, err := Validate(goodFile(), stat, read)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cfg.CollectNetworkState || !cfg.CollectStorage || !cfg.CollectBoot {
		t.Fatal("Stage 4 inventory should default on")
	}
	// And every authority defaults off: installing a build that can reconfigure
	// a network must not by itself make a host reconfigurable.
	if cfg.NetworkEnabled || cfg.StorageEnabled || cfg.OSImageEnabled {
		t.Fatal("Stage 4 authorities must default off")
	}
}

func TestEveryStage4AuthorityRequiresTheOperationChannel(t *testing.T) {
	stat, read := fakeFS(0o600, goodSecret)
	cases := map[string]func(*File){
		"networkEnabled": func(f *File) {
			f.NetworkEnabled = boolPtr(true)
			f.NetworkAllowlist = []string{"lab-data"}
		},
		"storageEnabled": func(f *File) {
			f.StorageEnabled = boolPtr(true)
			f.StorageMountRoots = []string{"/srv"}
		},
		"osImageEnabled": func(f *File) {
			f.OSImageEnabled = boolPtr(true)
			f.OSImageAllowlist = []string{"registry.example.com/os@sha256:" + strings.Repeat("a", 64)}
		},
	}
	for name, apply := range cases {
		f := goodFile()
		f.OperationsEnabled = boolPtr(false)
		apply(&f)
		if _, err := Validate(f, stat, read); err == nil {
			t.Errorf("%s without operationsEnabled must refuse to start", name)
		}
		f.OperationsEnabled = boolPtr(true)
		if _, err := Validate(f, stat, read); err != nil {
			t.Errorf("%s with operationsEnabled must be accepted: %v", name, err)
		}
	}
}

func TestAnAuthorityWithNothingToActOnRefusesToStart(t *testing.T) {
	// An authority with an empty allowlist can act on nothing. Saying so at
	// start-up beats an operator discovering it when a reviewed and approved
	// operation is refused by the host.
	stat, read := fakeFS(0o600, goodSecret)
	for name, apply := range map[string]func(*File){
		"network": func(f *File) { f.NetworkEnabled = boolPtr(true) },
		"storage": func(f *File) { f.StorageEnabled = boolPtr(true) },
		"image":   func(f *File) { f.OSImageEnabled = boolPtr(true) },
	} {
		f := stage4File()
		apply(&f)
		if _, err := Validate(f, stat, read); err == nil {
			t.Errorf("%s authority with an empty allowlist must refuse to start", name)
		}
	}
}

func TestAMalformedStage4AllowlistEntryStopsTheAgent(t *testing.T) {
	// A silently dropped entry reads as "allowed" to whoever wrote it.
	stat, read := fakeFS(0o600, goodSecret)
	cases := map[string]func(*File){
		"a profile name with a shell fragment": func(f *File) {
			f.NetworkEnabled = boolPtr(true)
			f.NetworkAllowlist = []string{"lab; reboot"}
		},
		"a profile name starting with a dash": func(f *File) {
			f.NetworkEnabled = boolPtr(true)
			f.NetworkAllowlist = []string{"-delete"}
		},
		"a relative mount root": func(f *File) {
			f.StorageEnabled = boolPtr(true)
			f.StorageMountRoots = []string{"srv"}
		},
		"a protected mount root": func(f *File) {
			f.StorageEnabled = boolPtr(true)
			f.StorageMountRoots = []string{"/var"}
		},
		"a traversal in a mount root": func(f *File) {
			f.StorageEnabled = boolPtr(true)
			f.StorageMountRoots = []string{"/srv/../etc"}
		},
		"a protected grow target": func(f *File) {
			f.StorageEnabled = boolPtr(true)
			f.StorageGrowAllowlist = []string{"/"}
		},
		"a tag-only image reference": func(f *File) {
			f.OSImageEnabled = boolPtr(true)
			f.OSImageAllowlist = []string{"registry.example.com/os:v1"}
		},
		"a short digest": func(f *File) {
			f.OSImageEnabled = boolPtr(true)
			f.OSImageAllowlist = []string{"registry.example.com/os@sha256:abc"}
		},
	}
	for name, apply := range cases {
		f := stage4File()
		apply(&f)
		if _, err := Validate(f, stat, read); err == nil {
			t.Errorf("%s must stop the agent rather than being ignored", name)
		}
	}
}

func TestAMalformedEntryStopsTheAgentEvenBesideAGoodOne(t *testing.T) {
	// The cases above would also be caught by the empty-allowlist rule once a
	// bad entry was dropped. Here a valid entry remains, so only the refusal
	// itself can stop this: dropping the bad one silently would leave an
	// operator believing they had allowlisted two things.
	stat, read := fakeFS(0o600, goodSecret)
	cases := map[string]func(*File){
		"a network profile": func(f *File) {
			f.NetworkEnabled = boolPtr(true)
			f.NetworkAllowlist = []string{"lab-data", "lab; reboot"}
		},
		"a mount root": func(f *File) {
			f.StorageEnabled = boolPtr(true)
			f.StorageMountRoots = []string{"/srv", "/var"}
		},
		"a grow target": func(f *File) {
			f.StorageEnabled = boolPtr(true)
			f.StorageGrowAllowlist = []string{"/srv/data", "relative/path"}
		},
		"an image reference": func(f *File) {
			f.OSImageEnabled = boolPtr(true)
			f.OSImageAllowlist = []string{
				"registry.example.com/os@sha256:" + strings.Repeat("a", 64),
				"registry.example.com/os:latest",
			}
		},
	}
	for name, apply := range cases {
		f := stage4File()
		apply(&f)
		if _, err := Validate(f, stat, read); err == nil {
			t.Errorf("%s: a malformed entry beside a valid one must still stop the agent", name)
		}
	}
}

func TestStage4AllowlistsAreDeduplicatedAndBounded(t *testing.T) {
	stat, read := fakeFS(0o600, goodSecret)
	f := stage4File()
	f.NetworkEnabled = boolPtr(true)
	f.NetworkAllowlist = []string{"lab-data", "lab-data", " lab-data ", ""}
	cfg, err := Validate(f, stat, read)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cfg.NetworkAllowlist) != 1 || cfg.NetworkAllowlist[0] != "lab-data" {
		t.Fatalf("allowlist = %v, want a single deduplicated entry", cfg.NetworkAllowlist)
	}

	over := stage4File()
	over.OSImageEnabled = boolPtr(true)
	for i := 0; i <= MaxImageAllowlist; i++ {
		over.OSImageAllowlist = append(over.OSImageAllowlist,
			fmt.Sprintf("registry.example.com/os%d@sha256:%s", i, strings.Repeat("a", 64)))
	}
	if _, err := Validate(over, stat, read); err == nil {
		t.Fatal("an oversized image allowlist must refuse to start")
	}
}

func TestAnUnknownStage4FieldIsRefusedRatherThanIgnored(t *testing.T) {
	// The loader decodes with DisallowUnknownFields, so a typo in an authority
	// name cannot silently leave the authority off while looking enabled.
	dir := t.TempDir()
	path := dir + "/agent.json"
	body := `{"controlCenterUrl":"https://rcc.cc2.opl.io.kr","controlCenterId":"cc2",` +
		`"hostId":"node-a","keyId":"k","secretFile":"/etc/rcc-node-agent/agent.key",` +
		`"netwrokEnabled":true}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("a misspelled authority must be refused, not ignored")
	}
}

func TestSSHBanAuthorityIsOptInAndRequiresProtectedAddresses(t *testing.T) {
	stat, read := fakeFS(0o600, goodSecret)
	base := goodFile()
	cfg, err := Validate(base, stat, read)
	if err != nil {
		t.Fatalf("defaults rejected: %v", err)
	}
	if !cfg.CollectSSHBan || cfg.SSHBanEnabled {
		t.Fatalf("unsafe defaults: collect=%t enabled=%t", cfg.CollectSSHBan, cfg.SSHBanEnabled)
	}

	enabled := true
	base.OperationsEnabled = &enabled
	base.SSHBanEnabled = &enabled
	if _, err := Validate(base, stat, read); err == nil || !strings.Contains(err.Error(), "sshBanProtectedAddresses") {
		t.Fatalf("empty protected list was not refused: %v", err)
	}
	base.SSHBanProtectedAddresses = []string{"203.0.113.10", "2001:0db8::1", "203.0.113.10"}
	cfg, err = Validate(base, stat, read)
	if err != nil {
		t.Fatalf("valid SSH ban authority rejected: %v", err)
	}
	if got := strings.Join(cfg.SSHBanProtectedAddresses, ","); got != "203.0.113.10,2001:db8::1" {
		t.Fatalf("protected addresses = %q", got)
	}
}
