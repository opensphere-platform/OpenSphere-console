//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

type dataBlob struct {
	cbData uint32
	pbData *byte
}

var (
	crypt32            = syscall.NewLazyDLL("crypt32.dll")
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	cryptProtectData   = crypt32.NewProc("CryptProtectData")
	cryptUnprotectData = crypt32.NewProc("CryptUnprotectData")
	localFree          = kernel32.NewProc("LocalFree")
)

const cryptProtectUIForbidden = 0x1

func blobFromBytes(value []byte) dataBlob {
	if len(value) == 0 {
		return dataBlob{}
	}
	return dataBlob{cbData: uint32(len(value)), pbData: &value[0]}
}

func bytesFromBlob(value dataBlob) []byte {
	if value.cbData == 0 || value.pbData == nil {
		return nil
	}
	return append([]byte(nil), unsafe.Slice(value.pbData, value.cbData)...)
}

func credentialPath(deviceID string) (string, error) {
	p, err := configPath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(p), "credentials", deviceID+".dpapi"), nil
}

func storePlatformCredential(deviceID string, plaintext []byte) error {
	in := blobFromBytes(plaintext)
	var out dataBlob
	ok, _, callErr := cryptProtectData.Call(
		uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0,
		cryptProtectUIForbidden, uintptr(unsafe.Pointer(&out)),
	)
	if ok == 0 {
		return fmt.Errorf("Windows DPAPI encryption failed: %w", callErr)
	}
	defer localFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	p, err := credentialPath(deviceID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	return os.WriteFile(p, bytesFromBlob(out), 0o600)
}

func loadPlatformCredential(deviceID string) ([]byte, error) {
	p, err := credentialPath(deviceID)
	if err != nil {
		return nil, err
	}
	ciphertext, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	in := blobFromBytes(ciphertext)
	var out dataBlob
	ok, _, callErr := cryptUnprotectData.Call(
		uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0,
		cryptProtectUIForbidden, uintptr(unsafe.Pointer(&out)),
	)
	if ok == 0 {
		return nil, fmt.Errorf("Windows DPAPI decryption failed: %w", callErr)
	}
	defer localFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return bytesFromBlob(out), nil
}

func deletePlatformCredential(deviceID string) error {
	p, err := credentialPath(deviceID)
	if err != nil {
		return err
	}
	err = os.Remove(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
