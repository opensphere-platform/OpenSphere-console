//go:build !windows

package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"os/exec"
	"os/user"
	"runtime"
	"strings"
)

const credentialService = "io.opensphere.os.cli-device"

func credentialAccount(deviceID string) string {
	u, err := user.Current()
	if err != nil || u.Username == "" {
		return deviceID
	}
	return u.Username + ":" + deviceID
}

func storePlatformCredential(deviceID string, plaintext []byte) error {
	value := base64.RawStdEncoding.EncodeToString(plaintext)
	account := credentialAccount(deviceID)
	if runtime.GOOS == "darwin" {
		return exec.Command("security", "add-generic-password", "-U", "-s", credentialService, "-a", account, "-w", value).Run()
	}
	if _, err := exec.LookPath("secret-tool"); err != nil {
		return fmt.Errorf("Secret Service client(secret-tool)가 필요합니다: %w", err)
	}
	cmd := exec.Command("secret-tool", "store", "--label=OpenSphere CLI device", "service", credentialService, "account", account)
	cmd.Stdin = strings.NewReader(value)
	return cmd.Run()
}

func loadPlatformCredential(deviceID string) ([]byte, error) {
	account := credentialAccount(deviceID)
	var out []byte
	var err error
	if runtime.GOOS == "darwin" {
		out, err = exec.Command("security", "find-generic-password", "-s", credentialService, "-a", account, "-w").Output()
	} else {
		if _, lookErr := exec.LookPath("secret-tool"); lookErr != nil {
			return nil, fmt.Errorf("Secret Service client(secret-tool)가 필요합니다: %w", lookErr)
		}
		out, err = exec.Command("secret-tool", "lookup", "service", credentialService, "account", account).Output()
	}
	if err != nil {
		return nil, err
	}
	return base64.RawStdEncoding.DecodeString(string(bytes.TrimSpace(out)))
}

func deletePlatformCredential(deviceID string) error {
	account := credentialAccount(deviceID)
	if runtime.GOOS == "darwin" {
		_ = exec.Command("security", "delete-generic-password", "-s", credentialService, "-a", account).Run()
		return nil
	}
	if _, err := exec.LookPath("secret-tool"); err != nil {
		return nil
	}
	_ = exec.Command("secret-tool", "clear", "service", credentialService, "account", account).Run()
	return nil
}
