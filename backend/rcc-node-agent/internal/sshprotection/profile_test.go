package sshprotection

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInspectDistinguishesCurrentDriftedAndExternalProfiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rcc-sshd.local")
	addresses := []string{"203.0.113.10"}

	state, err := Inspect(path, addresses)
	if err != nil || state.Exists {
		t.Fatalf("absent state = %#v, %v", state, err)
	}
	if err := os.WriteFile(path, Config(addresses), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	state, err = Inspect(path, addresses)
	if err != nil || state.Kind != Profile || state.Digest == "" || state.Mode != 0o640 {
		t.Fatalf("current state = %#v, %v", state, err)
	}

	state, err = Inspect(path, []string{"203.0.113.11"})
	if err != nil || state.Kind != Drifted {
		t.Fatalf("drift state = %#v, %v", state, err)
	}
	if err := os.WriteFile(path, []byte("[sshd]\nenabled = true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	state, err = Inspect(path, addresses)
	if err != nil || state.Kind != External {
		t.Fatalf("external state = %#v, %v", state, err)
	}
}

func TestInspectRefusesFinalSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	path := filepath.Join(dir, "rcc-sshd.local")
	if err := os.WriteFile(target, Config([]string{"203.0.113.10"}), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	state, err := Inspect(path, []string{"203.0.113.10"})
	if err == nil || state.Kind != External {
		t.Fatalf("symlink state = %#v, %v", state, err)
	}
}
