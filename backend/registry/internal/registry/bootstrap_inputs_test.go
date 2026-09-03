package registry

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

func inputClient(t *testing.T, failedResource string, status int) dynamic.Interface {
	t.Helper()
	lock, err := json.Marshal(fixtureInput().ReleaseLock)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fail := func(code int) {
			w.WriteHeader(code)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"apiVersion": "v1", "kind": "Status", "status": "Failure", "code": code, "reason": map[int]string{404: "NotFound", 403: "Forbidden", 503: "ServiceUnavailable"}[code]})
		}
		if strings.HasSuffix(r.URL.Path, "/"+failedResource) {
			fail(status)
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/uipluginpackages"), strings.HasSuffix(r.URL.Path, "/uipluginregistrations"), strings.HasSuffix(r.URL.Path, "/foundationmoduledescriptors"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"apiVersion": "v1", "kind": "List", "metadata": map[string]string{"resourceVersion": "1"}, "items": []interface{}{}})
		case strings.HasSuffix(r.URL.Path, "/configmaps/opensphere-extension-trusted-keys"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"apiVersion": "v1", "kind": "ConfigMap", "data": map[string]string{"trusted-keys.json": `{"trustedKeys":{"test-key":"public"}}`}})
		case strings.HasSuffix(r.URL.Path, "/configmaps/"+installationLockConfigMap):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]string{"resourceVersion": "1"}, "data": map[string]string{installationLockKey: string(lock)}})
		default:
			fail(404)
		}
	}))
	t.Cleanup(server.Close)
	client, err := dynamic.NewForConfig(&rest.Config{Host: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestLoadInputAbsentOptionalFoundationKeepsCoreDiscovery(t *testing.T) {
	input, err := LoadInput(context.Background(), inputClient(t, descriptorGVR.Resource, 404), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if input.Sources["catalog.descriptors"].Reason != "NotInstalled" || input.Sources["catalog.descriptors"].Ready {
		t.Fatal("absent optional module must be explicit, not claimed Ready")
	}
	if input.Descriptors == nil || len(input.Descriptors.Items) != 0 || len(input.TrustedKeys) != 1 {
		t.Fatal("canonical trust and empty optional catalog must be available")
	}
	snapshot, err := Build(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Inventory.Descriptors) == 0 {
		t.Fatal("core services must remain discoverable")
	}
}

func TestLoadInputSourceFailuresStillFailClosed(t *testing.T) {
	for _, tc := range []struct {
		name, resource string
		status         int
	}{
		{"optional-forbidden", descriptorGVR.Resource, 403},
		{"optional-unavailable", descriptorGVR.Resource, 503},
		{"required-not-found", uipkgGVR.Resource, 404},
		{"canonical-trust-missing", trustConfigMap, 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := LoadInput(context.Background(), inputClient(t, tc.resource, tc.status), time.Now()); err == nil {
				t.Fatal("source failure must fail closed")
			}
		})
	}
}
