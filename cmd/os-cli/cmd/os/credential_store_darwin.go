//go:build darwin && cgo

package main

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <stdlib.h>
#include <string.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>

static CFStringRef opensphere_cf_string(const char *value) {
	return CFStringCreateWithCString(kCFAllocatorDefault, value, kCFStringEncodingUTF8);
}

static CFDictionaryRef opensphere_keychain_query(CFStringRef service, CFStringRef account) {
	const void *keys[] = { kSecClass, kSecAttrService, kSecAttrAccount };
	const void *values[] = { kSecClassGenericPassword, service, account };
	return CFDictionaryCreate(kCFAllocatorDefault, keys, values, 3,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
}

static int opensphere_store_keychain(const char *service_value, const char *account_value,
	const unsigned char *secret, size_t secret_length) {
	CFStringRef service = opensphere_cf_string(service_value);
	CFStringRef account = opensphere_cf_string(account_value);
	CFDataRef secret_data = CFDataCreate(kCFAllocatorDefault, secret, (CFIndex)secret_length);
	if (service == NULL || account == NULL || secret_data == NULL) {
		if (service != NULL) CFRelease(service);
		if (account != NULL) CFRelease(account);
		if (secret_data != NULL) CFRelease(secret_data);
		return (int)errSecAllocate;
	}

	CFDictionaryRef query = opensphere_keychain_query(service, account);
	SecItemDelete(query); // Replacing an existing device key is intentional.
	const void *keys[] = { kSecClass, kSecAttrService, kSecAttrAccount, kSecValueData };
	const void *values[] = { kSecClassGenericPassword, service, account, secret_data };
	CFDictionaryRef item = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 4,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	OSStatus status = item == NULL ? errSecAllocate : SecItemAdd(item, NULL);
	if (item != NULL) CFRelease(item);
	CFRelease(query);
	CFRelease(secret_data);
	CFRelease(account);
	CFRelease(service);
	return (int)status;
}

static int opensphere_load_keychain(const char *service_value, const char *account_value,
	unsigned char **secret, size_t *secret_length) {
	*secret = NULL;
	*secret_length = 0;
	CFStringRef service = opensphere_cf_string(service_value);
	CFStringRef account = opensphere_cf_string(account_value);
	if (service == NULL || account == NULL) {
		if (service != NULL) CFRelease(service);
		if (account != NULL) CFRelease(account);
		return (int)errSecAllocate;
	}
	CFDictionaryRef query = opensphere_keychain_query(service, account);
	const void *return_key[] = { kSecReturnData, kSecMatchLimit };
	const void *return_value[] = { kCFBooleanTrue, kSecMatchLimitOne };
	CFMutableDictionaryRef request = CFDictionaryCreateMutableCopy(kCFAllocatorDefault, 0, query);
	CFDictionarySetValue(request, return_key[0], return_value[0]);
	CFDictionarySetValue(request, return_key[1], return_value[1]);
	CFTypeRef result = NULL;
	OSStatus status = SecItemCopyMatching(request, &result);
	if (status == errSecSuccess) {
		if (result == NULL || CFGetTypeID(result) != CFDataGetTypeID()) {
			status = errSecInternalComponent;
		} else {
			CFDataRef data = (CFDataRef)result;
			CFIndex length = CFDataGetLength(data);
			unsigned char *copy = malloc((size_t)(length > 0 ? length : 1));
			if (copy == NULL) {
				status = errSecAllocate;
			} else {
				if (length > 0) memcpy(copy, CFDataGetBytePtr(data), (size_t)length);
				*secret = copy;
				*secret_length = (size_t)length;
			}
		}
	}
	if (result != NULL) CFRelease(result);
	CFRelease(request);
	CFRelease(query);
	CFRelease(account);
	CFRelease(service);
	return (int)status;
}

static int opensphere_delete_keychain(const char *service_value, const char *account_value) {
	CFStringRef service = opensphere_cf_string(service_value);
	CFStringRef account = opensphere_cf_string(account_value);
	if (service == NULL || account == NULL) {
		if (service != NULL) CFRelease(service);
		if (account != NULL) CFRelease(account);
		return (int)errSecAllocate;
	}
	CFDictionaryRef query = opensphere_keychain_query(service, account);
	OSStatus status = SecItemDelete(query);
	CFRelease(query);
	CFRelease(account);
	CFRelease(service);
	return (int)status;
}
*/
import "C"

import (
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"os/user"
	"unsafe"
)

const credentialService = "io.opensphere.os.cli-device"

func credentialAccount(deviceID string) string {
	u, err := user.Current()
	if err != nil || u.Username == "" {
		return deviceID
	}
	return u.Username + ":" + deviceID
}

func keychainStatusError(operation string, status C.int) error {
	return fmt.Errorf("macOS Keychain %s failed (OSStatus %d)", operation, int(status))
}

func keychainArguments(deviceID string) (*C.char, *C.char) {
	return C.CString(credentialService), C.CString(credentialAccount(deviceID))
}

// storePlatformCredential sends the private key bytes directly to SecItemAdd.
// No process argument, environment variable, shell expansion, or temporary file
// contains the device private key.
func storePlatformCredential(deviceID string, plaintext []byte) error {
	service, account := keychainArguments(deviceID)
	defer C.free(unsafe.Pointer(service))
	defer C.free(unsafe.Pointer(account))
	var secret *C.uchar
	if len(plaintext) > 0 {
		secret = (*C.uchar)(unsafe.Pointer(&plaintext[0]))
	}
	if status := C.opensphere_store_keychain(service, account, secret, C.size_t(len(plaintext))); status != C.errSecSuccess {
		return keychainStatusError("store", status)
	}
	return nil
}

func loadPlatformCredential(deviceID string) ([]byte, error) {
	service, account := keychainArguments(deviceID)
	defer C.free(unsafe.Pointer(service))
	defer C.free(unsafe.Pointer(account))
	var secret *C.uchar
	var length C.size_t
	if status := C.opensphere_load_keychain(service, account, &secret, &length); status != C.errSecSuccess {
		return nil, keychainStatusError("load", status)
	}
	defer C.free(unsafe.Pointer(secret))
	value := C.GoBytes(unsafe.Pointer(secret), C.int(length))

	// Releases before this change stored raw DER as base64 through /usr/bin/security.
	// Preserve existing enrolled devices and replace the legacy form on successful read.
	if _, err := x509.ParseECPrivateKey(value); err == nil {
		return value, nil
	}
	legacy, err := base64.RawStdEncoding.DecodeString(string(value))
	if err != nil {
		return value, nil
	}
	if _, err := x509.ParseECPrivateKey(legacy); err != nil {
		return value, nil
	}
	if err := storePlatformCredential(deviceID, legacy); err != nil {
		return nil, fmt.Errorf("legacy Keychain credential migration failed: %w", err)
	}
	return legacy, nil
}

func deletePlatformCredential(deviceID string) error {
	service, account := keychainArguments(deviceID)
	defer C.free(unsafe.Pointer(service))
	defer C.free(unsafe.Pointer(account))
	status := C.opensphere_delete_keychain(service, account)
	if status == C.errSecSuccess || status == C.errSecItemNotFound {
		return nil
	}
	return keychainStatusError("delete", status)
}
