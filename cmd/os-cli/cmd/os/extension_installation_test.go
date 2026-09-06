package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestExtensionOperationWatchesActualOwnerReceipt(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	count := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodGet || r.URL.Path != "/api/platform/operations/"+id {
			t.Errorf("unexpected old or mutating route: %s %s", r.Method, r.URL.Path)
		}
		count++
		state := "Reconciling"
		if count > 1 {
			state = "Verified"
		}
		fmt.Fprintf(w, `{"schemaVersion":"1.0","operationId":%q,"actionId":"console.extension.install","state":%q}`, id, state)
	}))
	defer server.Close()
	originalSleep := sleepFn
	sleepFn = func(time.Duration) {}
	defer func() { sleepFn = originalSleep }()
	cfg := defaults()
	cfg.testBearer = "test-token"
	cfg.ConsoleURL = server.URL
	var out bytes.Buffer
	if err := extensions(cfg, []string{"operation", "watch", id, "--timeout", "1s"}, &out); err != nil {
		t.Fatal(err)
	}
	if count != 2 || !strings.Contains(out.String(), "Verified") {
		t.Fatalf("watch did not observe current receipt: count=%d %s", count, out.String())
	}
}

func TestExtensionOperationRejectsUnknownStateOrDifferentJob(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	for _, body := range []string{
		`{"schemaVersion":"1.0","operationId":"` + id + `","actionId":"console.extension.install","state":"AlmostReady"}`,
		`{"schemaVersion":"1.0","operationId":"22222222-2222-4222-8222-222222222222","actionId":"console.extension.install","state":"Verified"}`,
	} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, body)
			}))
			defer server.Close()
			cfg := defaults()
			cfg.testBearer = "test-token"
			cfg.ConsoleURL = server.URL
			if err := extensions(cfg, []string{"operation", "get", id}, &bytes.Buffer{}); err == nil {
				t.Fatal("invalid receipt was accepted")
			}
		})
	}
}

func TestExtensionInstallWillNotSilentlySwitchRequestedChannel(t *testing.T) {
	installs := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/admin/extensions/catalog":
			fmt.Fprintf(w, `{"schemaVersion":"1.0","freshness":"fresh","data":{"revision":"sha256:%s","items":[{"descriptorId":"extension.cluster-manager"}]}}`, strings.Repeat("a", 64))
		case "/api/admin/extensions/inspect":
			fmt.Fprintf(w, `{"freshness":"fresh","data":{"resolution":"Eligible","candidate":{"descriptorId":"extension.cluster-manager","catalogRevision":"sha256:%s","channel":"edge","image":"ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:%s"}}}`, strings.Repeat("a", 64), strings.Repeat("b", 64))
		default:
			installs++
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	cfg := defaults()
	cfg.testBearer = "test-token"
	cfg.ConsoleURL = server.URL
	err := extensions(cfg, []string{"install", "opensphere-shell-cluster-manager:stable", "--reason", "explicit stable selection"}, &bytes.Buffer{})
	if err == nil || installs != 0 {
		t.Fatalf("requested channel was not respected: %v installs=%d", err, installs)
	}
}
