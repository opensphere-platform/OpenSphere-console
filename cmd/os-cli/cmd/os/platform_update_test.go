package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testPlatformReleaseDocument(t *testing.T, channel, releaseHex, imageHex, revisionHex string) platformReleaseDocument {
	t.Helper()
	lock := platformReleaseLock{
		APIVersion:     "release.opensphere.io/v1alpha1",
		Kind:           platformReleaseLockKind,
		Channel:        channel,
		ReleaseDigest:  "sha256:" + strings.Repeat(releaseHex, 64),
		Source:         "https://github.com/opensphere-platform/OpenSphere-console",
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

func writePlatformReleaseLock(t *testing.T, document platformReleaseDocument) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "release-lock.json")
	if err := os.WriteFile(path, append(document.Raw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestPlatformUpdateCheckUsesConsoleStateAndReviewedReleaseLock(t *testing.T) {
	current := testPlatformReleaseDocument(t, "edge", "a", "a", "1")
	available := testPlatformReleaseDocument(t, "edge", "b", "b", "2")
	lockPath := writePlatformReleaseLock(t, available)
	originalRead := readConsolePlatformReleaseFn
	readConsolePlatformReleaseFn = func(cfg Config) (platformReleaseDocument, error) {
		if cfg.ConsoleURL != "https://console.example" {
			t.Fatalf("unexpected Console URL %q", cfg.ConsoleURL)
		}
		return current, nil
	}
	defer func() { readConsolePlatformReleaseFn = originalRead }()

	var out bytes.Buffer
	if err := platformUpdate(
		Config{Output: "json", ConsoleURL: "https://console.example"},
		[]string{"update", "check", "--lock", lockPath, "--channel", "edge"},
		strings.NewReader(""),
		&out,
	); err != nil {
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

func TestPlatformUpdatePlanApplyIsTamperEvidentAndCreatesConsoleRequest(t *testing.T) {
	planDirectory := t.TempDir()
	t.Setenv("OS_PLATFORM_UPDATE_PLAN_DIR", planDirectory)
	current := testPlatformReleaseDocument(t, "edge", "a", "a", "1")
	target := testPlatformReleaseDocument(t, "edge", "b", "b", "2")
	lockPath := writePlatformReleaseLock(t, target)
	originalRead, originalRequest := readConsolePlatformReleaseFn, requestPlatformReleaseFn
	readConsolePlatformReleaseFn = func(Config) (platformReleaseDocument, error) { return current, nil }
	requested := false
	requestPlatformReleaseFn = func(_ Config, plan platformUpdatePlan, release platformReleaseDocument, reason string) (platformReleaseRequest, error) {
		if plan.CurrentReleaseDigest != current.Lock.ReleaseDigest || release.Lock.ReleaseDigest != target.Lock.ReleaseDigest {
			t.Fatalf("request did not retain the reviewed transition")
		}
		if reason != "approved platform upgrade" {
			t.Fatalf("unexpected reason %q", reason)
		}
		requested = true
		var response platformReleaseRequest
		response.RequestID = "123e4567-e89b-42d3-a456-426614174000"
		response.PullRequest.Number = 42
		return response, nil
	}
	defer func() {
		readConsolePlatformReleaseFn, requestPlatformReleaseFn = originalRead, originalRequest
	}()

	var planOut bytes.Buffer
	if err := platformUpdate(
		Config{Output: "json"},
		[]string{"update", "plan", "--lock", lockPath},
		strings.NewReader(""),
		&planOut,
	); err != nil {
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
	if err := platformUpdate(
		Config{Output: "json"},
		[]string{"update", "apply", planned.PlanID, "--reason", "approved platform upgrade"},
		strings.NewReader(""),
		&applyOut,
	); err != nil {
		t.Fatal(err)
	}
	var result platformUpdateReport
	if err := json.Unmarshal(applyOut.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !requested || result.State != "Requested" || result.RequestID == "" || result.PullRequest != 42 {
		t.Fatalf("unexpected request result: requested=%v report=%#v", requested, result)
	}
}

func TestPlatformUpdateRejectsUnsafeOrIncompleteInputsBeforeConsoleRequest(t *testing.T) {
	target := testPlatformReleaseDocument(t, "edge", "b", "b", "2")
	lockPath := writePlatformReleaseLock(t, target)
	if err := platformUpdate(
		Config{Output: "json"},
		[]string{"update", "check"},
		strings.NewReader(""),
		&bytes.Buffer{},
	); err == nil || !strings.Contains(err.Error(), "--lock") {
		t.Fatalf("explicit release lock must be required before a Console read, got %v", err)
	}
	if err := platformUpdate(
		Config{Output: "json"},
		[]string{"update", "check", "--lock", lockPath, "--channel", "ga"},
		strings.NewReader(""),
		&bytes.Buffer{},
	); err == nil || !strings.Contains(err.Error(), "다릅니다") {
		t.Fatalf("channel/lock mismatch must fail closed, got %v", err)
	}
	if err := platformUpdate(
		Config{Output: "json"},
		[]string{"update", "apply", strings.Repeat("a", 20)},
		strings.NewReader(""),
		&bytes.Buffer{},
	); err == nil || !strings.Contains(err.Error(), "--reason") {
		t.Fatalf("apply must require a durable reason, got %v", err)
	}
}
