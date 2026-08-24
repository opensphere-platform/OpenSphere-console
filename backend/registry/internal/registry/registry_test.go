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
	reg.Object["status"] = map[string]interface{}{"phase": "Activated", "workload": map[string]interface{}{"phase": "Ready"}, "verification": map[string]interface{}{"manifest": "Verified", "signature": "Verified", "entryDigest": "Verified", "permissions": "Approved"}, "currentDigest": "sha256:" + string(bytes.Repeat([]byte{'a'}, 64)), "currentManifestSha256": string(bytes.Repeat([]byte{'b'}, 64)), "manifestUrl": "/api/plugins/postgres-r-1/plugins/ui-shell.manifest.json", "serving": map[string]interface{}{"phase": "Current", "artifactServiceId": "postgres-r-1", "revision": "1"}}
	cap := object("postgresql", map[string]interface{}{})
	offer := object("postgresql-stackgres", map[string]interface{}{"capabilityRef": "postgresql", "provider": "stackgres", "lifecycle": "Preview"})
	plan := object("postgresql-dev", map[string]interface{}{"capabilityRef": "postgresql", "offeringRef": "postgresql-stackgres", "provider": "stackgres", "postgresVersion": "18", "profile": "development", "lifecycle": "Available"})
	runtime := object("stackgres", map[string]interface{}{"provider": "stackgres", "versions": []interface{}{map[string]interface{}{"major": "18", "version": "18.4", "lifecycle": "Available", "image": "repo@sha256:" + string(bytes.Repeat([]byte{'c'}, 64))}}})
	return Input{Packages: list(pkg), Registrations: list(reg), Capabilities: list(cap), Offerings: list(offer), Plans: list(plan), Runtimes: list(runtime), Descriptors: list(), TrustedKeys: map[string]string{"key-1": "public"}, Navigation: map[string]map[string]interface{}{}, Sources: map[string]catalog.SourceStatus{}, ObservedAt: time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)}
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
	if a.Version != 3 || len(a.Plugins) != 1 || a.Schema == "" || len(a.Catalog.Plans) != 1 {
		t.Fatalf("contract missing: %#v", a)
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

func TestResolveBindsExactRevisionAndDigest(t *testing.T) {
	snapshot, _ := Build(fixtureInput())
	store := NewStore(nil)
	store.snapshot.Store(&snapshot)
	store.lastSuccess = time.Now()
	got := store.Resolve(ResolveRequest{Kind: "plan", ID: "postgresql-dev", TargetProfile: "development", Revision: snapshot.Revision})
	if got.Result != "Eligible" {
		t.Fatalf("unexpected: %#v", got)
	}
	encoded, _ := json.Marshal(got.Candidate)
	if !bytes.Contains(encoded, []byte("@sha256:")) {
		t.Fatalf("candidate is not exact digest: %s", encoded)
	}
	stale := store.Resolve(ResolveRequest{Kind: "plan", ID: "postgresql-dev", Revision: "sha256:old"})
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
	if len(next.Rejected) != 1 || next.Rejected[0].Code != "ReleaseCoordinatesPending" {
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
