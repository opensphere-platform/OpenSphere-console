//go:build darwin && cgo

package main

import (
	"bytes"
	"fmt"
	"testing"
	"time"
)

func TestDarwinKeychainStoresRawPrivateMaterial(t *testing.T) {
	deviceID := fmt.Sprintf("keychain-test-%d", time.Now().UnixNano())
	secret := []byte{0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff}
	defer func() { _ = deletePlatformCredential(deviceID) }()

	if err := storePlatformCredential(deviceID, secret); err != nil {
		t.Fatalf("store in Security.framework Keychain: %v", err)
	}
	loaded, err := loadPlatformCredential(deviceID)
	if err != nil {
		t.Fatalf("load from Security.framework Keychain: %v", err)
	}
	if !bytes.Equal(loaded, secret) {
		t.Fatalf("Keychain value changed: got %x want %x", loaded, secret)
	}
	if err := deletePlatformCredential(deviceID); err != nil {
		t.Fatalf("delete from Security.framework Keychain: %v", err)
	}
}
