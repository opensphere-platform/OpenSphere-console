package registry

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/opensphere/registry/internal/catalog"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func list(items ...unstructured.Unstructured) *unstructured.UnstructuredList {
	return &unstructured.UnstructuredList{Items: items}
}
func object(name string, spec map[string]interface{}) unstructured.Unstructured {
	return unstructured.Unstructured{Object: map[string]interface{}{"metadata": map[string]interface{}{"name": name, "creationTimestamp": "2026-08-24T00:00:00Z"}, "spec": spec}}
}
func fixtureInput() Input {
	pkg := object("postgres", map[string]interface{}{"displayName": "PostgreSQL", "kind": "plugin", "hostRef": "foundation", "hostApiVersion": "1.0.0", "hostCompat": ">=1.0.0 <2.0.0", "image": map[string]interface{}{"digest": "sha256:" + string(bytes.Repeat([]byte{'a'}, 64))}, "manifest": map[string]interface{}{"sha256": string(bytes.Repeat([]byte{'b'}, 64)), "signaturePath": "/plugins/ui-shell.manifest.json.sig"}, "trust": map[string]interface{}{"keyId": "key-1"}, "contributions": map[string]interface{}{}})
	reg := object("postgres", map[string]interface{}{"desiredState": "Enabled", "approval": map[string]interface{}{"requestedBy": "admin", "reason": "test"}})
	reg.Object["status"] = map[string]interface{}{"phase": "Activated", "workload": map[string]interface{}{"phase": "Ready"}, "verification": map[string]interface{}{"manifest": "Verified", "signature": "Verified", "entryDigest": "Verified", "permissions": "Approved"}, "currentDigest": "sha256:" + string(bytes.Repeat([]byte{'a'}, 64)), "currentManifestSha256": string(bytes.Repeat([]byte{'b'}, 64)), "currentVersion": "202608240000", "currentRevision": "0123456789012345678901234567890123456789", "manifestUrl": "/api/plugins/postgres-r-1/plugins/ui-shell.manifest.json", "serving": map[string]interface{}{"phase": "Current", "artifactServiceId": "postgres-r-1", "revision": "1"}}
	descriptor := object("data", map[string]interface{}{"model": "data", "catalog": map[string]interface{}{"authority": "registry", "install": "optional"}})
	return Input{Packages: list(pkg), Registrations: list(reg), Descriptors: list(descriptor), ReleaseLock: ReleaseLock{ReleaseDigest: "sha256:" + string(bytes.Repeat([]byte{'e'}, 64)), Components: map[string]ReleaseComponent{"registry": {Repository: "opensphere-registry", Image: "ghcr.io/opensphere-platform/opensphere-registry@sha256:" + string(bytes.Repeat([]byte{'c'}, 64)), SourceRevision: "0123456789012345678901234567890123456789"}}}, ReleaseLockResourceVersion: "42", TrustedKeys: map[string]string{"key-1": "public"}, Navigation: map[string]map[string]interface{}{}, Sources: map[string]catalog.SourceStatus{}, ObservedAt: time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)}
}

func TestBuildIsDeterministicAndCompatible(t *testing.T) {
	a, err := Build(fixtureInput())
	if err != nil {
		t.Fatal(err)
	}
	b, err := Build(fixtureInput())
	if err != nil {
		t.Fatal(err)
	}
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if !bytes.Equal(ja, jb) || a.Revision != b.Revision {
		t.Fatal("same input must produce byte-identical response and revision")
	}
	if a.Version != 3 || len(a.Plugins) != 1 || a.Schema == "" || len(a.Catalog.ModuleDescriptors) != 1 {
		t.Fatalf("contract missing: %#v", a)
	}
	if a.Inventory.Coverage.Expected != 3 || a.Inventory.Coverage.Published != 2 || len(a.Inventory.Descriptors) != 2 {
		t.Fatalf("common descriptor coverage is not explicit: %#v", a.Inventory)
	}
}

func TestInventoryPublishesRequiredCoreServicesAndRejectsNonExactFoundationArtifact(t *testing.T) {
	got, err := Build(fixtureInput())
	if err != nil {
		t.Fatal(err)
	}
	if got.Inventory.Descriptors[0].ID != "cbss.opensphere-registry" || got.Inventory.Descriptors[0].Installation.Eligible {
		t.Fatalf("Registry core service classification is invalid: %#v", got.Inventory.Descriptors)
	}
	if got.Inventory.Descriptors[1].ID != "extension.postgres" {
		t.Fatalf("extension descriptor is missing: %#v", got.Inventory.Descriptors)
	}
	if len(got.Inventory.Coverage.Missing) != 1 || got.Inventory.Coverage.Missing[0].ID != "foundation.data" || got.Inventory.Coverage.Missing[0].Code != "DigestMissing" {
		t.Fatalf("non-exact Foundation artifact was not exposed as a coverage gap: %#v", got.Inventory.Coverage)
	}
	for _, rejected := range got.Rejected {
		if rejected.ID == "foundation.data" && rejected.Code == "DigestMissing" {
			return
		}
	}
	t.Fatal("DigestMissing rejection was not published")
}

func TestModuleDescriptorCannotPublishPfssRuntimeConfiguration(t *testing.T) {
	input := fixtureInput()
	input.Descriptors.Items[0] = object("data", map[string]interface{}{
		"model":           "data",
		"description":     map[string]interface{}{"summary": "Data services"},
		"catalog":         map[string]interface{}{"authority": "registry", "install": "optional", "fixed": false},
		"operator":        map[string]interface{}{"image": "ghcr.io/opensphere-platform/operator@sha256:" + string(bytes.Repeat([]byte{'c'}, 64))},
		"lifecycle":       "Available",
		"runtimeCatalog":  map[string]interface{}{"versions": []interface{}{"18"}},
		"plans":           []interface{}{map[string]interface{}{"name": "production"}},
		"postgresVersion": "18",
		"capacity":        "large",
		"replicas":        int64(3),
		"storage":         map[string]interface{}{"size": "1Ti"},
		"backup":          map[string]interface{}{"enabled": true},
	})
	got, err := Build(input)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(got.Catalog.ModuleDescriptors[0])
	for _, forbidden := range [][]byte{[]byte("lifecycle"), []byte("runtimeCatalog"), []byte("plans"), []byte("postgresVersion"), []byte("capacity"), []byte("replicas"), []byte("storage"), []byte("backup")} {
		if bytes.Contains(encoded, forbidden) {
			t.Fatalf("PFSS runtime field leaked into Registry descriptor: %s", encoded)
		}
	}
	if !bytes.Contains(encoded, []byte(`"authority":"registry"`)) || !bytes.Contains(encoded, []byte(`"image"`)) {
		t.Fatalf("installation identity/source fields were lost: %s", encoded)
	}
}

func TestRevisionIgnoresObservationTimestampChurn(t *testing.T) {
	input := fixtureInput()
	_ = unstructured.SetNestedField(input.Registrations.Items[0].Object, "2026-08-24T00:00:01Z", "status", "currentResolvedAt")
	_ = unstructured.SetNestedField(input.Registrations.Items[0].Object, "2026-08-24T00:00:02Z", "status", "channelCheckedAt")
	first, err := Build(input)
	if err != nil {
		t.Fatal(err)
	}
	_ = unstructured.SetNestedField(input.Registrations.Items[0].Object, "2026-08-24T00:01:01Z", "status", "currentResolvedAt")
	_ = unstructured.SetNestedField(input.Registrations.Items[0].Object, "2026-08-24T00:01:02Z", "status", "channelCheckedAt")
	second, err := Build(input)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != second.Revision {
		t.Fatalf("observation-only refresh changed semantic revision: %s -> %s", first.Revision, second.Revision)
	}
	if first.Plugins[0].ChannelCheckedAt == second.Plugins[0].ChannelCheckedAt {
		t.Fatal("observation evidence was not preserved in the public snapshot")
	}

	_ = unstructured.SetNestedField(input.Registrations.Items[0].Object, "UpdateAvailable", "status", "channelState")
	semanticChange, err := Build(input)
	if err != nil {
		t.Fatal(err)
	}
	if second.Revision == semanticChange.Revision {
		t.Fatal("meaningful candidate state change did not change semantic revision")
	}
}

func TestResolveBindsExtensionToExactRevisionAndDigest(t *testing.T) {
	snapshot, _ := Build(fixtureInput())
	store := NewStore(nil)
	store.snapshot.Store(&snapshot)
	store.lastSuccess = time.Now()
	got := store.Resolve(ResolveRequest{Kind: "extension", ID: "postgres", Revision: snapshot.Revision})
	if got.Result != "Eligible" {
		t.Fatalf("unexpected: %#v", got)
	}
	encoded, _ := json.Marshal(got.Candidate)
	if !bytes.Contains(encoded, []byte("sha256:")) {
		t.Fatalf("candidate is not exact digest: %s", encoded)
	}
	stale := store.Resolve(ResolveRequest{Kind: "extension", ID: "postgres", Revision: "sha256:old"})
	if stale.Result != "StaleRevision" {
		t.Fatalf("unexpected: %#v", stale)
	}
}
func TestInvalidExtensionDigestIsRejected(t *testing.T) {
	input := fixtureInput()
	_ = unstructured.SetNestedField(input.Registrations.Items[0].Object, "tag-only", "status", "currentDigest")
	got, _ := Build(input)
	if len(got.Plugins) != 0 || len(got.Rejected) == 0 {
		t.Fatalf("invalid candidate published: %#v", got)
	}
}

func TestPendingTargetPreservesLastKnownGoodAndNavigation(t *testing.T) {
	input := fixtureInput()
	current, err := Build(input)
	if err != nil {
		t.Fatal(err)
	}
	input.PreviousPlugins = current.Plugins
	input.Navigation = map[string]map[string]interface{}{
		"postgres": {"labelOverride": "Database", "icon": "data--base"},
	}
	_ = unstructured.SetNestedField(input.Packages.Items[0].Object, "sha256:"+string(bytes.Repeat([]byte{'d'}, 64)), "spec", "image", "digest")
	next, err := Build(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Plugins) != 1 || next.Plugins[0].InstalledDigest != current.Plugins[0].InstalledDigest {
		t.Fatalf("last-known-good was not preserved: %#v", next.Plugins)
	}
	if next.Plugins[0].Name != "Database" || next.Plugins[0].Icon != "data--base" {
		t.Fatalf("navigation preference was not projected: %#v", next.Plugins[0])
	}
	foundPending := false
	for _, rejected := range next.Rejected {
		foundPending = foundPending || rejected.Code == "ReleaseCoordinatesPending"
	}
	if !foundPending {
		t.Fatalf("pending target was not reported: %#v", next.Rejected)
	}
}

func TestTelemetryDescriptorIsProjectedFromVerifiedPackage(t *testing.T) {
	input := fixtureInput()
	_ = unstructured.SetNestedMap(input.Packages.Items[0].Object, map[string]interface{}{
		"observability": map[string]interface{}{"enabled": true, "metrics": true},
	}, "spec", "contributions")
	_ = unstructured.SetNestedMap(input.Packages.Items[0].Object, map[string]interface{}{
		"observability": map[string]interface{}{"metricsPath": "/metrics", "scrapeInterval": "15s"},
	}, "spec", "runtime")
	got, err := Build(input)
	if err != nil {
		t.Fatal(err)
	}
	descriptor, ok := got.Plugins[0].TelemetryDescriptor.(map[string]interface{})
	if !ok || descriptor["metricsPath"] != "/metrics" || descriptor["scrapeInterval"] != "15s" {
		t.Fatalf("telemetry descriptor missing: %#v", got.Plugins[0].TelemetryDescriptor)
	}
}
