package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testPlatformReleaseDocument(t *testing.T, channel, releaseHex, imageHex, revisionHex string) platformReleaseDocument {
	t.Helper()
	lock := platformReleaseLock{
		APIVersion:     "releases.opensphere.io/v1alpha1",
		Kind:           platformReleaseLockKind,
		Channel:        channel,
		ReleaseDigest:  "sha256:" + strings.Repeat(releaseHex, 64),
		Source:         "https://github.com/opensphere-platform/opensphere-platform",
		SourceRevision: strings.Repeat(revisionHex, 40),
		Components: map[string]platformReleaseComponent{
			"console": {
				Repository:     "opensphere-console",
				Image:          "ghcr.io/opensphere-platform/opensphere-console@sha256:" + strings.Repeat(imageHex, 64),
				SourceRevision: strings.Repeat(revisionHex, 40),
			},
		},
	}
	raw, err := json.Marshal(lock)
	if err != nil {
		t.Fatal(err)
	}
	document, err := parsePlatformReleaseDocument(raw)
	if err != nil {
		t.Fatal(err)
	}
	return document
}

func TestPlatformUpdateCheckComparesInstalledLockWithSignedChannelRelease(t *testing.T) {
	current := testPlatformReleaseDocument(t, "edge", "a", "a", "1")
	available := testPlatformReleaseDocument(t, "edge", "b", "b", "2")
	originalResolve, originalRead := resolvePlatformReleaseFn, readInstalledPlatformReleaseFn
	resolvePlatformReleaseFn = func(channel string, credentials *platformRegistryCredentials) (platformReleaseDocument, error) {
		if channel != "edge" || credentials != nil {
			t.Fatalf("unexpected resolve input: channel=%q credentials=%#v", channel, credentials)
		}
		return available, nil
	}
	readInstalledPlatformReleaseFn = func(context string) (platformReleaseDocument, error) {
		if context != "desktop-linux" {
			t.Fatalf("unexpected context %q", context)
		}
		return current, nil
	}
	defer func() {
		resolvePlatformReleaseFn, readInstalledPlatformReleaseFn = originalResolve, originalRead
	}()

	var out bytes.Buffer
	if err := platformUpdate(Config{Output: "json"}, []string{"update", "check", "--channel", "edge", "--context", "desktop-linux"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	var report platformUpdateReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.State != "UpdateAvailable" || !report.UpdateAvailable || report.AvailableReleaseDigest != available.Lock.ReleaseDigest {
		t.Fatalf("unexpected check report: %#v", report)
	}
	if len(report.ChangedComponents) != 1 || report.ChangedComponents[0] != "console" {
		t.Fatalf("changed components=%v", report.ChangedComponents)
	}
}

func TestPlatformUpdatePlanApplyIsTamperEvidentAndVerifiesClusterLock(t *testing.T) {
	planDirectory := t.TempDir()
	t.Setenv("OS_PLATFORM_UPDATE_PLAN_DIR", planDirectory)
	current := testPlatformReleaseDocument(t, "edge", "a", "a", "1")
	target := testPlatformReleaseDocument(t, "edge", "b", "b", "2")
	installed := current
	originalResolve, originalRead, originalApply := resolvePlatformReleaseFn, readInstalledPlatformReleaseFn, applyPlatformReleaseFn
	resolvePlatformReleaseFn = func(string, *platformRegistryCredentials) (platformReleaseDocument, error) {
		return target, nil
	}
	readInstalledPlatformReleaseFn = func(context string) (platformReleaseDocument, error) {
		if context != "desktop-linux" {
			t.Fatalf("unexpected context %q", context)
		}
		return installed, nil
	}
	applied := false
	applyPlatformReleaseFn = func(channel, context string, lock json.RawMessage, credentials *platformRegistryCredentials) (string, error) {
		if channel != "edge" || context != "desktop-linux" || credentials != nil {
			t.Fatalf("unexpected apply input: %q %q %#v", channel, context, credentials)
		}
		document, err := parsePlatformReleaseDocument(lock)
		if err != nil {
			return "", err
		}
		if document.Lock.ReleaseDigest != target.Lock.ReleaseDigest {
			t.Fatalf("wrong target lock: %s", document.Lock.ReleaseDigest)
		}
		applied = true
		installed = target
		return "[완료] release upgrade 트랜잭션 검증", nil
	}
	defer func() {
		resolvePlatformReleaseFn, readInstalledPlatformReleaseFn, applyPlatformReleaseFn = originalResolve, originalRead, originalApply
	}()

	var planOut bytes.Buffer
	if err := platformUpdate(Config{Output: "json"}, []string{"update", "plan", "--channel", "edge", "--context", "desktop-linux"}, strings.NewReader(""), &planOut); err != nil {
		t.Fatal(err)
	}
	var planned platformUpdateReport
	if err := json.Unmarshal(planOut.Bytes(), &planned); err != nil {
		t.Fatal(err)
	}
	if planned.State != "PlanCreated" || len(planned.PlanID) != 20 {
		t.Fatalf("unexpected plan report: %#v", planned)
	}
	planPath := filepath.Join(planDirectory, planned.PlanID+".json")
	raw, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatal(err)
	}
	var tampered map[string]any
	if err := json.Unmarshal(raw, &tampered); err != nil {
		t.Fatal(err)
	}
	tampered["targetReleaseDigest"] = "sha256:" + strings.Repeat("c", 64)
	tamperedRaw, _ := json.Marshal(tampered)
	if err := os.WriteFile(planPath, tamperedRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadPlatformUpdatePlan(planned.PlanID); err == nil || !strings.Contains(err.Error(), "digest 검증") {
		t.Fatalf("tampered plan must fail closed, got %v", err)
	}
	if err := os.WriteFile(planPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	var applyOut bytes.Buffer
	if err := platformUpdate(Config{Output: "json"}, []string{"update", "apply", planned.PlanID, "--context", "desktop-linux"}, strings.NewReader(""), &applyOut); err != nil {
		t.Fatal(err)
	}
	var result platformUpdateReport
	if err := json.Unmarshal(applyOut.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !applied || result.State != "Applied" || result.CurrentReleaseDigest != target.Lock.ReleaseDigest {
		t.Fatalf("unexpected apply result: applied=%v report=%#v", applied, result)
	}
}

func TestPlatformUpdateRejectsUnsafeOrIncompleteInputsBeforeExecution(t *testing.T) {
	if err := validateNativeCommandOptions([]string{"platform", "update", "check", "--channel", "nightly"}); err == nil {
		t.Fatal("unknown release channel must be rejected")
	}
	if err := validateNativeCommandOptions([]string{"platform", "update", "check", "--channel", "edge", "--context", "demo;whoami"}); err == nil {
		t.Fatal("shell control characters in context must be rejected")
	}
	for _, flags := range []map[string]string{
		{"registry-username": "opensphere-platform"},
		{"registry-token-stdin": "true"},
	} {
		if _, err := platformRegistryCredentialsFromInput(flags, strings.NewReader("token")); err == nil {
			t.Fatalf("incomplete registry credential flags must fail: %#v", flags)
		}
	}
	if _, err := platformRegistryCredentialsFromInput(
		map[string]string{"registry-username": "opensphere-platform", "registry-token-stdin": "true"},
		strings.NewReader("token with spaces"),
	); err == nil {
		t.Fatal("whitespace-bearing registry token must fail")
	}
	originalRead := readInstalledPlatformReleaseFn
	readInstalledPlatformReleaseFn = func(string) (platformReleaseDocument, error) {
		return platformReleaseDocument{}, errors.New("must not execute")
	}
	defer func() { readInstalledPlatformReleaseFn = originalRead }()
	if err := platformUpdate(Config{Output: "json"}, []string{"update", "check"}, strings.NewReader(""), &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "--channel") {
		t.Fatalf("explicit channel must be required before execution, got %v", err)
	}
}
