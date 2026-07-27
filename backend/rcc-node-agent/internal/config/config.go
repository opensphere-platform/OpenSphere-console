// Package config loads and validates the root-owned agent configuration.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"opensphere.io/rcc/node-agent/internal/guard"
)

const (
	// DefaultPath is the root-owned configuration file installed by packaging.
	DefaultPath = "/etc/rcc-node-agent/agent.json"

	MinInterval     = 15 * time.Second
	MaxInterval     = time.Hour
	DefaultInterval = 60 * time.Second

	MinRequestTimeout     = 3 * time.Second
	MaxRequestTimeout     = 60 * time.Second
	DefaultRequestTimeout = 15 * time.Second

	// MinSecretBytes matches the signing protocol floor.
	// Stage 2 operation polling. Faster than the snapshot interval so an
	// approved operation starts promptly, but still bounded.
	MinPollInterval     = 5 * time.Second
	MaxPollInterval     = 5 * time.Minute
	DefaultPollInterval = 20 * time.Second
	DefaultStateDir     = "/var/lib/rcc-node-agent"
	MaxRestartAllowlist = 64
	MaxPackageAllowlist = 128
	// Stage 4 allowlists. Each is small on purpose: these are lists a person
	// reads before granting an authority, not inventories.
	MaxNetworkAllowlist = 32
	MaxMountRoots       = 16
	MaxGrowAllowlist    = 32
	MaxImageAllowlist   = 32
	MaxSSHProtectedIPs  = 64

	MinSecretBytes = 32
	// MaxSecretBytes bounds the key file read.
	MaxSecretBytes = 512
)

var (
	dnsLabelRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	keyIDRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	// Deliberately excludes templates and non-service units: only a plain,
	// fully named .service may appear in a host restart allowlist.
	restartUnitRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.service$`)
	// Debian policy for a package name, matching the plan parser exactly. The
	// two must agree, or a host would accept configuration for a package the
	// control center can never name in a plan.
	packageNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]{1,127}$`)
	// Stage 4 grammars, matching the plan parser exactly for the same reason:
	// a host that allowlisted something the control center can never name in a
	// plan has granted an authority that does nothing, which reads as a
	// permission to whoever wrote it.
	connectionNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$`)
	mountPathRe      = regexp.MustCompile(`^(/[A-Za-z0-9_][A-Za-z0-9._-]{0,62}){1,8}$`)
	pinnedImageRe    = regexp.MustCompile(`^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]{1,5})?(/[a-z0-9]([a-z0-9._-]*[a-z0-9])?){1,6}@sha256:[0-9a-f]{64}$`)
)

// File is the on-disk JSON document. It never contains the shared secret.
type File struct {
	ControlCenterURL      string `json:"controlCenterUrl"`
	ControlCenterID       string `json:"controlCenterId"`
	HostID                string `json:"hostId"`
	KeyID                 string `json:"keyId"`
	SecretFile            string `json:"secretFile"`
	IntervalSeconds       int    `json:"intervalSeconds"`
	RequestTimeoutSeconds int    `json:"requestTimeoutSeconds"`
	CollectSystemdUnits   *bool  `json:"collectSystemdUnits"`
	CACertificateFile     string `json:"caCertificateFile"`

	// Stage 2: governed typed operations.  Operations stay disabled until the
	// host is explicitly opted in, so upgrading the binary alone never makes a
	// host executable.
	OperationsEnabled   *bool    `json:"operationsEnabled"`
	StateDir            string   `json:"stateDir"`
	PollIntervalSeconds int      `json:"pollIntervalSeconds"`
	RestartAllowlist    []string `json:"restartAllowlist"`
	PackagesEnabled     *bool    `json:"packagesEnabled"`
	PackageAllowlist    []string `json:"packageAllowlist"`
	CollectPackages     *bool    `json:"collectPackages"`

	// Stage 4: three separate authorities. They are separate because each needs
	// a different widening of the systemd sandbox and none implies another — a
	// host that may grow a filesystem has no business reconfiguring its network.
	NetworkEnabled       *bool    `json:"networkEnabled"`
	NetworkAllowlist     []string `json:"networkAllowlist"`
	StorageEnabled       *bool    `json:"storageEnabled"`
	StorageMountRoots    []string `json:"storageMountRoots"`
	StorageGrowAllowlist []string `json:"storageGrowAllowlist"`
	OSImageEnabled       *bool    `json:"osImageEnabled"`
	OSImageAllowlist     []string `json:"osImageAllowlist"`
	CollectNetworkState  *bool    `json:"collectNetworkState"`
	CollectStorage       *bool    `json:"collectStorage"`
	CollectBoot          *bool    `json:"collectBoot"`

	// SSH ban management is a separate, opt-in authority. Inventory is
	// read-only and defaults on; mutation stays off until the host declares
	// both the authority and the exact addresses that must never be banned.
	CollectSSHBan            *bool    `json:"collectSSHBan"`
	SSHBanEnabled            *bool    `json:"sshBanEnabled"`
	SSHBanProtectedAddresses []string `json:"sshBanProtectedAddresses"`
}

// Config is the validated runtime configuration.
type Config struct {
	ControlCenterURL    *url.URL
	ControlCenterID     string
	HostID              string
	KeyID               string
	Secret              []byte
	Interval            time.Duration
	RequestTimeout      time.Duration
	CollectSystemdUnits bool
	CACertificateFile   string

	OperationsEnabled bool
	StateDir          string
	PollInterval      time.Duration
	RestartAllowlist  []string

	// Stage 3. Both default to off: installing a build that can update
	// packages must not by itself make a host updatable.
	PackagesEnabled  bool
	PackageAllowlist []string
	// Inventory collection is separable from the ability to act on it, so a
	// host can report update state while remaining unmanaged. It defaults on
	// because reporting changes nothing.
	CollectPackages bool

	// Stage 4. All three authorities default to off for the same reason the
	// package authority does: installing a build that can reconfigure a network
	// must not by itself make a host reconfigurable.
	NetworkEnabled       bool
	NetworkAllowlist     []string
	StorageEnabled       bool
	StorageMountRoots    []string
	StorageGrowAllowlist []string
	OSImageEnabled       bool
	OSImageAllowlist     []string
	CollectNetworkState  bool
	CollectStorage       bool
	CollectBoot          bool

	CollectSSHBan            bool
	SSHBanEnabled            bool
	SSHBanProtectedAddresses []string
}

// Redacted renders the configuration for logging. The secret is never included.
func (c *Config) Redacted() string {
	return fmt.Sprintf(
		"controlCenterUrl=%s controlCenterId=%s hostId=%s keyId=%s interval=%s timeout=%s systemdUnits=%t",
		c.ControlCenterURL.String(), c.ControlCenterID, c.HostID, c.KeyID,
		c.Interval, c.RequestTimeout, c.CollectSystemdUnits,
	)
}

// Load reads, validates and returns the agent configuration, failing closed.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var file File
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	return Validate(file, os.Stat, os.ReadFile)
}

type statFunc func(string) (os.FileInfo, error)
type readFunc func(string) ([]byte, error)

// Validate applies every fail-closed rule with injectable filesystem access.
func Validate(file File, stat statFunc, read readFunc) (*Config, error) {
	endpoint, err := url.Parse(strings.TrimSpace(file.ControlCenterURL))
	if err != nil {
		return nil, fmt.Errorf("controlCenterUrl is not a valid URL: %w", err)
	}
	if endpoint.Scheme != "https" {
		return nil, fmt.Errorf("controlCenterUrl must use https, got %q", endpoint.Scheme)
	}
	if endpoint.Host == "" {
		return nil, fmt.Errorf("controlCenterUrl must include a host")
	}
	if endpoint.User != nil {
		return nil, fmt.Errorf("controlCenterUrl must not embed credentials")
	}
	if endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, fmt.Errorf("controlCenterUrl must not include a query or fragment")
	}
	// A base path would be sent but never signed. The signed path is built from
	// scratch by agent.HeartbeatPath and always begins at /api, so configuring
	// https://host/base makes the agent request /base/api/... while binding its
	// signature to /api/... — the request made and the request signed are not
	// the same. The backend happens to refuse a prefixed path today, so this
	// fails closed either way, but a binding that holds only because the peer
	// rejects the mismatch is not a binding. A bare host, with or without a
	// trailing slash, is the only accepted form.
	if strings.TrimRight(endpoint.Path, "/") != "" || endpoint.RawPath != "" || endpoint.Opaque != "" {
		return nil, fmt.Errorf("controlCenterUrl must not include a path, got %q", endpoint.Path)
	}
	endpoint.Path = ""

	if !dnsLabelRe.MatchString(file.ControlCenterID) {
		return nil, fmt.Errorf("controlCenterId %q is not a valid identifier", file.ControlCenterID)
	}
	if !dnsLabelRe.MatchString(file.HostID) {
		return nil, fmt.Errorf("hostId %q is not a valid identifier", file.HostID)
	}
	if !keyIDRe.MatchString(file.KeyID) {
		return nil, fmt.Errorf("keyId %q is not a valid identifier", file.KeyID)
	}

	secret, err := loadSecret(file.SecretFile, stat, read)
	if err != nil {
		return nil, err
	}

	cfg := &Config{
		ControlCenterURL:    endpoint,
		ControlCenterID:     file.ControlCenterID,
		HostID:              file.HostID,
		KeyID:               file.KeyID,
		Secret:              secret,
		Interval:            clampDuration(file.IntervalSeconds, DefaultInterval, MinInterval, MaxInterval),
		RequestTimeout:      clampDuration(file.RequestTimeoutSeconds, DefaultRequestTimeout, MinRequestTimeout, MaxRequestTimeout),
		CollectSystemdUnits: file.CollectSystemdUnits == nil || *file.CollectSystemdUnits,
		CACertificateFile:   strings.TrimSpace(file.CACertificateFile),
		// Typed operations are opt-in per host: installing a Stage 2 binary on a
		// Stage 1 host must not silently make it executable.
		OperationsEnabled: file.OperationsEnabled != nil && *file.OperationsEnabled,
		PackagesEnabled:   file.PackagesEnabled != nil && *file.PackagesEnabled,
		CollectPackages:   file.CollectPackages == nil || *file.CollectPackages,
		StateDir:          strings.TrimSpace(file.StateDir),
		PollInterval:      clampDuration(file.PollIntervalSeconds, DefaultPollInterval, MinPollInterval, MaxPollInterval),

		NetworkEnabled:      file.NetworkEnabled != nil && *file.NetworkEnabled,
		StorageEnabled:      file.StorageEnabled != nil && *file.StorageEnabled,
		OSImageEnabled:      file.OSImageEnabled != nil && *file.OSImageEnabled,
		CollectNetworkState: file.CollectNetworkState == nil || *file.CollectNetworkState,
		CollectStorage:      file.CollectStorage == nil || *file.CollectStorage,
		CollectBoot:         file.CollectBoot == nil || *file.CollectBoot,
		CollectSSHBan:       file.CollectSSHBan == nil || *file.CollectSSHBan,
		SSHBanEnabled:       file.SSHBanEnabled != nil && *file.SSHBanEnabled,
	}
	if cfg.StateDir == "" {
		cfg.StateDir = DefaultStateDir
	}
	if !filepath.IsAbs(cfg.StateDir) {
		return nil, fmt.Errorf("stateDir %q must be an absolute path", cfg.StateDir)
	}
	// The allowlist is the host's own statement of what may be restarted. An
	// entry that is not a plain .service name is rejected rather than ignored,
	// so a typo cannot silently widen or narrow the set.
	seen := map[string]bool{}
	for _, unit := range file.RestartAllowlist {
		unit = strings.TrimSpace(unit)
		if unit == "" {
			continue
		}
		if !restartUnitRe.MatchString(unit) {
			return nil, fmt.Errorf("restartAllowlist entry %q is not a plain .service unit name", unit)
		}
		if seen[unit] {
			continue
		}
		seen[unit] = true
		cfg.RestartAllowlist = append(cfg.RestartAllowlist, unit)
	}
	if len(cfg.RestartAllowlist) > MaxRestartAllowlist {
		return nil, fmt.Errorf("restartAllowlist holds %d units; the maximum is %d",
			len(cfg.RestartAllowlist), MaxRestartAllowlist)
	}

	// The package allowlist follows the same rule as the unit allowlist: a
	// malformed entry stops the agent rather than being dropped, because a
	// silently ignored entry reads as "allowed" to whoever wrote it.
	seenPackages := map[string]bool{}
	for _, name := range file.PackageAllowlist {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if !packageNameRe.MatchString(name) {
			return nil, fmt.Errorf("packageAllowlist entry %q is not a valid Debian package name", name)
		}
		if strings.HasPrefix(name, "linux-image-") {
			return nil, fmt.Errorf("packageAllowlist entry %q is a kernel image; kernel updates are a separate operation", name)
		}
		if seenPackages[name] {
			continue
		}
		seenPackages[name] = true
		cfg.PackageAllowlist = append(cfg.PackageAllowlist, name)
	}
	if len(cfg.PackageAllowlist) > MaxPackageAllowlist {
		return nil, fmt.Errorf("packageAllowlist holds %d packages; the maximum is %d",
			len(cfg.PackageAllowlist), MaxPackageAllowlist)
	}
	if cfg.PackagesEnabled && !cfg.OperationsEnabled {
		// Package maintenance is a typed operation; enabling it without the
		// operation channel would be a setting that silently does nothing.
		return nil, fmt.Errorf("packagesEnabled requires operationsEnabled")
	}
	if err := validateSSHBan(file, cfg); err != nil {
		return nil, err
	}
	if err := validateStage4(file, cfg); err != nil {
		return nil, err
	}
	if cfg.CACertificateFile != "" {
		if _, err := stat(cfg.CACertificateFile); err != nil {
			return nil, fmt.Errorf("caCertificateFile is unreadable: %w", err)
		}
	}
	return cfg, nil
}

func validateSSHBan(file File, cfg *Config) error {
	seen := map[string]bool{}
	for _, raw := range file.SSHBanProtectedAddresses {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		parsed := net.ParseIP(value)
		if parsed == nil {
			return fmt.Errorf("sshBanProtectedAddresses entry %q is not an exact IP address", value)
		}
		canonical := parsed.String()
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		cfg.SSHBanProtectedAddresses = append(cfg.SSHBanProtectedAddresses, canonical)
	}
	if len(cfg.SSHBanProtectedAddresses) > MaxSSHProtectedIPs {
		return fmt.Errorf("sshBanProtectedAddresses holds %d entries; the maximum is %d",
			len(cfg.SSHBanProtectedAddresses), MaxSSHProtectedIPs)
	}
	if !cfg.SSHBanEnabled {
		return nil
	}
	if !cfg.OperationsEnabled {
		return fmt.Errorf("sshBanEnabled requires operationsEnabled")
	}
	if !cfg.CollectSSHBan {
		return fmt.Errorf("sshBanEnabled requires collectSSHBan so live state can be checked before every change")
	}
	if len(cfg.SSHBanProtectedAddresses) == 0 {
		return fmt.Errorf("sshBanEnabled requires sshBanProtectedAddresses; the host must protect its management addresses")
	}
	return nil
}

// validateStage4 applies the same rule to all three new authorities that the
// package authority already follows.
//
// A malformed entry stops the agent rather than being dropped. A silently
// ignored allowlist entry reads as "allowed" to whoever wrote it, and the
// difference between the two only becomes visible when somebody requests the
// operation and it is refused — or, worse, when they request a neighbouring one
// and it is not.
func validateStage4(file File, cfg *Config) error {
	dedupe := func(values []string, limit int, field string, check func(string) error) ([]string, error) {
		out := []string{}
		seen := map[string]bool{}
		for _, raw := range values {
			value := strings.TrimSpace(raw)
			if value == "" {
				continue
			}
			if err := check(value); err != nil {
				return nil, fmt.Errorf("%s entry %q %s", field, value, err.Error())
			}
			if seen[value] {
				continue
			}
			seen[value] = true
			out = append(out, value)
		}
		if len(out) > limit {
			return nil, fmt.Errorf("%s holds %d entries; the maximum is %d", field, len(out), limit)
		}
		return out, nil
	}

	networkAllowlist, err := dedupe(file.NetworkAllowlist, MaxNetworkAllowlist, "networkAllowlist",
		func(value string) error {
			if !connectionNameRe.MatchString(value) {
				return errors.New("is not a valid NetworkManager connection profile name")
			}
			return nil
		})
	if err != nil {
		return err
	}
	cfg.NetworkAllowlist = networkAllowlist

	mountRoots, err := dedupe(file.StorageMountRoots, MaxMountRoots, "storageMountRoots",
		func(value string) error {
			if !mountPathRe.MatchString(value) {
				return errors.New("is not an accepted absolute path")
			}
			if protected, reason := guard.ProtectedMountPoint(value); protected {
				return errors.New("is protected (" + reason + ") and can never be a mount root")
			}
			return nil
		})
	if err != nil {
		return err
	}
	cfg.StorageMountRoots = mountRoots

	growAllowlist, err := dedupe(file.StorageGrowAllowlist, MaxGrowAllowlist, "storageGrowAllowlist",
		func(value string) error {
			if !mountPathRe.MatchString(value) {
				return errors.New("is not an accepted absolute path")
			}
			if protected, reason := guard.ProtectedMountPoint(value); protected {
				return errors.New("is protected (" + reason + ") and is never grown")
			}
			return nil
		})
	if err != nil {
		return err
	}
	cfg.StorageGrowAllowlist = growAllowlist

	imageAllowlist, err := dedupe(file.OSImageAllowlist, MaxImageAllowlist, "osImageAllowlist",
		func(value string) error {
			if !pinnedImageRe.MatchString(value) {
				return errors.New("is not a digest-pinned image reference")
			}
			return nil
		})
	if err != nil {
		return err
	}
	cfg.OSImageAllowlist = imageAllowlist

	// Each authority is a typed operation channel. Enabling one without the
	// operation channel is a setting that silently does nothing.
	for _, gate := range []struct {
		enabled bool
		name    string
	}{
		{cfg.NetworkEnabled, "networkEnabled"},
		{cfg.StorageEnabled, "storageEnabled"},
		{cfg.OSImageEnabled, "osImageEnabled"},
	} {
		if gate.enabled && !cfg.OperationsEnabled {
			return fmt.Errorf("%s requires operationsEnabled", gate.name)
		}
	}
	// An authority with an empty allowlist can act on nothing. Saying so at
	// start-up is better than an operator discovering it when a reviewed and
	// approved operation is refused by the host.
	if cfg.StorageEnabled && len(cfg.StorageMountRoots) == 0 && len(cfg.StorageGrowAllowlist) == 0 {
		return fmt.Errorf("storageEnabled requires storageMountRoots or storageGrowAllowlist; " +
			"neither is set, so this host could act on nothing")
	}
	if cfg.OSImageEnabled && len(cfg.OSImageAllowlist) == 0 {
		return fmt.Errorf("osImageEnabled requires osImageAllowlist; " +
			"with no allowlisted image this host could stage nothing")
	}
	if cfg.NetworkEnabled && len(cfg.NetworkAllowlist) == 0 {
		return fmt.Errorf("networkEnabled requires networkAllowlist; " +
			"with no allowlisted connection this host could reconfigure nothing")
	}
	return nil
}

func loadSecret(path string, stat statFunc, read readFunc) ([]byte, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("secretFile is required")
	}
	info, err := stat(path)
	if err != nil {
		return nil, fmt.Errorf("secretFile is unreadable: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("secretFile must be a regular file")
	}
	// The signing key must not be readable by group or other.
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return nil, fmt.Errorf("secretFile permissions %#o are too permissive, require 0600", perm)
	}
	raw, err := read(path)
	if err != nil {
		return nil, fmt.Errorf("secretFile is unreadable: %w", err)
	}
	if len(raw) > MaxSecretBytes {
		return nil, fmt.Errorf("secretFile exceeds %d bytes", MaxSecretBytes)
	}
	secret := []byte(strings.TrimSpace(string(raw)))
	if len(secret) < MinSecretBytes {
		return nil, fmt.Errorf("secretFile must contain at least %d bytes of key material", MinSecretBytes)
	}
	return secret, nil
}

func clampDuration(seconds int, fallback, min, max time.Duration) time.Duration {
	if seconds <= 0 {
		return fallback
	}
	d := time.Duration(seconds) * time.Second
	if d < min {
		return min
	}
	if d > max {
		return max
	}
	return d
}
