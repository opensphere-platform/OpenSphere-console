// Package sshprotection owns the one Fail2ban profile RCC can express.
//
// Keeping the bytes in one package prevents the read-only collector and the
// executor from disagreeing about what "rcc-ssh-baseline-v1" means. A profile
// is current only when every byte, including the protected management
// addresses, matches this generator.
package sshprotection

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
)

const (
	Profile    = "rcc-ssh-baseline-v1"
	Drifted    = Profile + "-drift"
	External   = "external"
	ConfigPath = "/etc/fail2ban/jail.d/rcc-sshd.local"

	maxProfileBytes = 16 * 1024
)

var managedHeader = []byte(
	"# Managed by PolyON RCC. Do not edit in place.\n" +
		"# RCC profile: " + Profile + "\n",
)

// State is a bounded local profile inspection. Content is never reported in a
// snapshot; the executor keeps it only long enough to restore a failed update.
type State struct {
	Exists  bool
	Kind    string
	Digest  string
	Content []byte
	Mode    os.FileMode
}

// CanonicalAddresses validates, de-duplicates and sorts exact IP addresses.
func CanonicalAddresses(values []string) ([]string, error) {
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		parsed := net.ParseIP(value)
		if parsed == nil || parsed.String() != value {
			return nil, fmt.Errorf("protected address %q is not canonical", value)
		}
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Strings(out)
	return out, nil
}

// Config returns the complete immutable profile for the reviewed management
// addresses. Callers validate addresses before using the result.
func Config(addresses []string) []byte {
	ignore := append([]string{"127.0.0.1/8", "::1"}, addresses...)
	return []byte(
		string(managedHeader) +
			"[sshd]\n" +
			"enabled = true\n" +
			"backend = systemd\n" +
			"bantime = 3600\n" +
			"findtime = 600\n" +
			"maxretry = 5\n" +
			"ignoreip = " + strings.Join(ignore, " ") + "\n",
	)
}

// Digest names exact reviewed bytes without exposing them.
func Digest(content []byte) string {
	sum := sha256.Sum256(content)
	return fmt.Sprintf("sha256:%x", sum[:])
}

// Inspect classifies the fixed path without following a final symlink. A file
// carrying RCC's exact two-line ownership header may be reconciled; any other
// content is external policy and must never be overwritten.
func Inspect(path string, addresses []string) (State, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return State{}, nil
	}
	if err != nil {
		return State{}, fmt.Errorf("inspect RCC Fail2ban profile: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return State{Exists: true, Kind: External}, errors.New(
			"the RCC Fail2ban profile path is not a regular file")
	}
	if info.Size() > maxProfileBytes {
		return State{Exists: true, Kind: External}, errors.New(
			"the RCC Fail2ban profile exceeds the inspection bound")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return State{Exists: true, Kind: External}, fmt.Errorf(
			"read RCC Fail2ban profile: %w", err)
	}
	state := State{
		Exists:  true,
		Digest:  Digest(raw),
		Content: append([]byte(nil), raw...),
		Mode:    info.Mode().Perm(),
	}
	switch {
	case bytes.Equal(raw, Config(addresses)):
		state.Kind = Profile
	case bytes.HasPrefix(raw, managedHeader):
		state.Kind = Drifted
	default:
		state.Kind = External
	}
	return state, nil
}
