// Package registry materializes the OpenSphere Registry & Catalog read model.
package registry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"

	"github.com/opensphere/registry/internal/catalog"
)

var (
	uipkgGVR               = schema.GroupVersionResource{Group: "plugins.opensphere.io", Version: "v1alpha1", Resource: "uipluginpackages"}
	uiregGVR               = schema.GroupVersionResource{Group: "plugins.opensphere.io", Version: "v1alpha1", Resource: "uipluginregistrations"}
	descriptorGVR          = schema.GroupVersionResource{Group: "foundation.opensphere.io", Version: "v1alpha1", Resource: "foundationmoduledescriptors"}
	configMapGVR           = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}
	digestRE               = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	manifestRE             = regexp.MustCompile(`^[a-f0-9]{64}$`)
	sourceRevisionRE       = regexp.MustCompile(`^[a-f0-9]{40}$`)
	compatibilityVersionRE = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	repositoryRE           = regexp.MustCompile(`^ghcr\.io/opensphere-platform/[a-z0-9][a-z0-9._-]*$`)
	extensionIDRE          = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
)

const (
	registryNamespace         = "opensphere-console"
	trustConfigMap            = "dupa-trusted-keys"
	navigationConfigMap       = "opensphere-extension-navigation-v1"
	navigationKey             = "navigation.json"
	installationLockConfigMap = "opensphere-installation-lock"
	installationLockKey       = "release.json"
	freshnessTarget           = 30 * time.Second
)

type CLIContribution struct {
	Namespace    string `json:"namespace"`
	ManifestPath string `json:"manifestPath"`
	APIBase      string `json:"apiBase"`
}

type Approval struct {
	Actor  string `json:"actor"`
	Reason string `json:"reason"`
	Time   string `json:"time"`
}

// Plugin preserves the browser and OSC v3 contract while moving ownership out of DUPA.
type Plugin struct {
	ID                         string                 `json:"id"`
	Name                       string                 `json:"name"`
	Manifest                   string                 `json:"manifest"`
	ManifestSHA256             string                 `json:"manifestSha256"`
	Signature                  string                 `json:"signature"`
	KeyID                      string                 `json:"keyId"`
	Kind                       string                 `json:"kind"`
	HostRef                    string                 `json:"hostRef"`
	HostAPIVersion             string                 `json:"hostApiVersion"`
	HostCompat                 string                 `json:"hostCompat"`
	Contributions              map[string]interface{} `json:"contributions"`
	TelemetryDescriptor        interface{}            `json:"telemetryDescriptor"`
	CLI                        *CLIContribution       `json:"cli,omitempty"`
	RequestedRef               string                 `json:"requestedRef"`
	RequestedChannel           string                 `json:"requestedChannel"`
	InstalledDigest            string                 `json:"installedDigest"`
	ResolvedAt                 string                 `json:"resolvedAt"`
	ArtifactVersion            string                 `json:"artifactVersion"`
	CompatibilityVersion       string                 `json:"compatibilityVersion"`
	BuildAuthority             string                 `json:"buildAuthority"`
	SourceRevision             string                 `json:"sourceRevision"`
	EvidenceRefs               []interface{}          `json:"evidenceRefs"`
	ArtifactServiceID          string                 `json:"artifactServiceId"`
	ReleaseRevision            string                 `json:"releaseRevision"`
	RetainedArtifactServiceIDs []interface{}          `json:"retainedArtifactServiceIds"`
	CurrentChannelDigest       string                 `json:"currentChannelDigest"`
	UpdateState                string                 `json:"updateState"`
	ChannelCheckedAt           string                 `json:"channelCheckedAt"`
	ChannelReason              string                 `json:"channelReason"`
	Approval                   Approval               `json:"approval"`
	Icon                       string                 `json:"icon"`
	Available                  bool                   `json:"available"`
	ServingMode                string                 `json:"servingMode,omitempty"`
	ServingReason              string                 `json:"servingReason,omitempty"`
}

type ExtensionSummary struct {
	Count        int      `json:"count"`
	PublishedIDs []string `json:"publishedIds"`
}

// ExtensionCandidate is a verified installable UIPluginPackage. Runtime state
// remains in Plugin, which requires an activated UIPluginRegistration.
type ExtensionCandidate struct {
	ID                     string        `json:"id"`
	DescriptorID           string        `json:"descriptorId"`
	Kind                   string        `json:"kind"`
	DisplayName            string        `json:"displayName"`
	Image                  string        `json:"image"`
	Digest                 string        `json:"digest"`
	Channel                string        `json:"channel"`
	SourceRevision         string        `json:"sourceRevision"`
	ManifestDigest         string        `json:"manifestDigest"`
	CompatibilityVersion   string        `json:"compatibilityVersion"`
	BuildAuthority         string        `json:"buildAuthority"`
	KeyID                  string        `json:"keyId"`
	EvidenceRefs           []interface{} `json:"evidenceRefs"`
	PackageResourceVersion string        `json:"packageResourceVersion"`
	PackageGeneration      int64         `json:"packageGeneration"`
	Capabilities           []string      `json:"capabilities"`
}

func localEdgeEvidenceRefs(image string) []string {
	return []string{
		"oci:" + image + "#p256-module-signature",
		"oci:" + image + "#local-edge-build-metadata",
	}
}

func hasExactLocalEdgeEvidence(values []interface{}, image string) bool {
	expected := localEdgeEvidenceRefs(image)
	if len(values) != len(expected) {
		return false
	}
	actual := map[string]bool{}
	for _, raw := range values {
		value, ok := raw.(string)
		if !ok || actual[value] {
			return false
		}
		actual[value] = true
	}
	for _, value := range expected {
		if !actual[value] {
			return false
		}
	}
	return true
}

type Response struct {
	Version               int                             `json:"version"`
	TrustedKeys           map[string]string               `json:"trustedKeys"`
	Capabilities          []interface{}                   `json:"capabilities"`
	Plugins               []Plugin                        `json:"plugins"`
	InstallableExtensions []ExtensionCandidate            `json:"installableExtensions"`
	Templates             []interface{}                   `json:"templates"`
	Schema                string                          `json:"schema"`
	Revision              string                          `json:"revision"`
	ObservedAt            string                          `json:"observedAt"`
	Stale                 bool                            `json:"stale"`
	Sources               map[string]catalog.SourceStatus `json:"sources"`
	Extensions            ExtensionSummary                `json:"extensions"`
	Catalog               catalog.Projection              `json:"catalog"`
	Inventory             catalog.Inventory               `json:"inventory"`
	Rejected              []catalog.Rejected              `json:"rejected"`
}

type ReleaseComponent struct {
	Repository     string `json:"repository"`
	Image          string `json:"image"`
	SourceRevision string `json:"sourceRevision"`
}

type ReleaseLock struct {
	Channel        string                      `json:"channel"`
	ReleaseDigest  string                      `json:"releaseDigest"`
	SourceRevision string                      `json:"sourceRevision"`
	Components     map[string]ReleaseComponent `json:"components"`
}

type Input struct {
	Packages, Registrations, Descriptors *unstructured.UnstructuredList
	ReleaseLock                          ReleaseLock
	ReleaseLockResourceVersion           string
	TrustedKeys                          map[string]string
	Navigation                           map[string]map[string]interface{}
	PreviousPlugins                      []Plugin
	Sources                              map[string]catalog.SourceStatus
	ObservedAt                           time.Time
}

func nestedString(o map[string]interface{}, fields ...string) string {
	v, _, _ := unstructured.NestedString(o, fields...)
	return v
}
func nestedMap(o map[string]interface{}, fields ...string) map[string]interface{} {
	v, _, _ := unstructured.NestedMap(o, fields...)
	if v == nil {
		return map[string]interface{}{}
	}
	return v
}
func nestedSlice(o map[string]interface{}, fields ...string) []interface{} {
	v, _, _ := unstructured.NestedSlice(o, fields...)
	if v == nil {
		return []interface{}{}
	}
	return v
}

func verifiedRegistration(reg *unstructured.Unstructured) bool {
	if reg == nil || nestedString(reg.Object, "spec", "desiredState") != "Enabled" {
		return false
	}
	return nestedString(reg.Object, "status", "phase") == "Activated" &&
		nestedString(reg.Object, "status", "workload", "phase") == "Ready" &&
		nestedString(reg.Object, "status", "verification", "manifest") == "Verified" &&
		nestedString(reg.Object, "status", "verification", "signature") == "Verified" &&
		nestedString(reg.Object, "status", "verification", "entryDigest") == "Verified" &&
		nestedString(reg.Object, "status", "verification", "permissions") == "Approved"
}

func releaseServiceID(id, digest, manifestDigest string) string {
	sum := sha256.Sum256([]byte(id + "\n" + digest + "\n" + manifestDigest))
	token := hex.EncodeToString(sum[:])[:20]
	maxPrefix := 63 - len("-r-") - len(token)
	prefix := strings.TrimRight(id[:min(len(id), maxPrefix)], "-")
	return prefix + "-r-" + token
}

func telemetryDescriptor(pkg unstructured.Unstructured) interface{} {
	if enabled, _, _ := unstructured.NestedBool(pkg.Object, "spec", "contributions", "observability", "enabled"); !enabled {
		return nil
	}
	if metrics, _, _ := unstructured.NestedBool(pkg.Object, "spec", "contributions", "observability", "metrics"); !metrics {
		return nil
	}
	metricsPath := nestedString(pkg.Object, "spec", "runtime", "observability", "metricsPath")
	if metricsPath == "" {
		return nil
	}
	interval := nestedString(pkg.Object, "spec", "runtime", "observability", "scrapeInterval")
	if interval == "" {
		interval = "30s"
	}
	return map[string]interface{}{
		"consumer": "opensphere-console", "workload": pkg.GetName(), "namespace": registryNamespace,
		"metricsPath": metricsPath, "scrapeInterval": interval, "capabilities": []string{"metrics"},
	}
}

func packageMatchesCurrentRegistration(pkg, reg unstructured.Unstructured) bool {
	return nestedString(pkg.Object, "spec", "image", "digest") == nestedString(reg.Object, "status", "currentDigest") &&
		nestedString(pkg.Object, "spec", "manifest", "sha256") == nestedString(reg.Object, "status", "currentManifestSha256")
}

func requestedRepository(ref string) string {
	value := strings.TrimSpace(ref)
	if at := strings.IndexByte(value, '@'); at >= 0 {
		value = value[:at]
	} else if colon := strings.LastIndexByte(value, ':'); colon > strings.LastIndexByte(value, '/') {
		value = value[:colon]
	}
	if !repositoryRE.MatchString(value) {
		return ""
	}
	return value
}

func canonicalExtensionRepository(kind, id string) string {
	if !extensionIDRE.MatchString(id) {
		return ""
	}
	switch kind {
	case "plugin":
		return "ghcr.io/opensphere-platform/opensphere-plugin-" + id
	case "subShell":
		if strings.HasPrefix(id, "shell-") {
			return "ghcr.io/opensphere-platform/opensphere-" + id
		}
		return "ghcr.io/opensphere-platform/opensphere-shell-" + id
	default:
		return ""
	}
}

func extensionCapabilitiesFromMap(contributions map[string]interface{}) []string {
	values := []string{}
	for key, value := range contributions {
		enabled := value != nil
		if object, ok := value.(map[string]interface{}); ok {
			if explicit, exists := object["enabled"].(bool); exists {
				enabled = explicit
			}
		}
		if enabled {
			values = append(values, key)
		}
	}
	sort.Strings(values)
	return values
}

func installableExtensionFromPackage(pkg unstructured.Unstructured, trustedKeys map[string]string) (ExtensionCandidate, *catalog.Rejected) {
	id := pkg.GetName()
	kind := nestedString(pkg.Object, "spec", "kind")
	repository := nestedString(pkg.Object, "spec", "image", "repository")
	digest := nestedString(pkg.Object, "spec", "image", "digest")
	requestedRef := nestedString(pkg.Object, "spec", "resolution", "requestedRef")
	channel := nestedString(pkg.Object, "spec", "resolution", "requestedChannel")
	sourceRevision := nestedString(pkg.Object, "spec", "resolution", "revision")
	compatibilityVersion := nestedString(pkg.Object, "spec", "resolution", "compatibilityVersion")
	buildAuthority := nestedString(pkg.Object, "spec", "resolution", "buildAuthority")
	resolvedDigest := nestedString(pkg.Object, "spec", "resolution", "resolvedDigest")
	signatureIdentity := nestedString(pkg.Object, "spec", "resolution", "signatureIdentity")
	manifest := nestedString(pkg.Object, "spec", "manifest", "sha256")
	keyID := nestedString(pkg.Object, "spec", "trust", "keyId")
	evidenceRefs := nestedSlice(pkg.Object, "spec", "resolution", "evidenceRefs")
	reject := func(code, message string) (ExtensionCandidate, *catalog.Rejected) {
		return ExtensionCandidate{}, &catalog.Rejected{Kind: "extension", ID: "extension." + id, Code: code, Message: message}
	}
	if !extensionIDRE.MatchString(id) || canonicalExtensionRepository(kind, id) == "" || repository != canonicalExtensionRepository(kind, id) {
		return reject("ExecutionIdentityInvalid", "installable package lacks its canonical OpenSphere repository identity")
	}
	if !digestRE.MatchString(digest) || resolvedDigest != digest || requestedRepository(requestedRef) != repository {
		return reject("ExecutionIdentityInvalid", "installable package lacks a consistent exact-digest resolution")
	}
	if channel != "edge" {
		return reject("ChannelUnsupported", "installable package is not in the local edge catalog")
	}
	if !manifestRE.MatchString(manifest) || !sourceRevisionRE.MatchString(sourceRevision) || !compatibilityVersionRE.MatchString(compatibilityVersion) {
		return reject("SupplyChainIdentityInvalid", "installable package lacks manifest, source, or compatibility identity")
	}
	if keyID == "" || signatureIdentity != keyID {
		return reject("SignatureIdentityInvalid", "installable package signature identity does not match its trust declaration")
	}
	if _, ok := trustedKeys[keyID]; !ok {
		return reject("UnknownTrustKey", "installable package signing key is not trusted")
	}
	image := repository + "@" + digest
	if buildAuthority != "localhost" {
		return reject("EdgeBuildAuthorityInvalid", "local edge package was not produced by the localhost build authority")
	}
	if !hasExactLocalEdgeEvidence(evidenceRefs, image) {
		return reject("LocalEdgeEvidenceInvalid", "local edge evidence is not bound to the exact image and local edge policy")
	}
	if pkg.GetResourceVersion() == "" || pkg.GetGeneration() < 1 {
		return reject("PackageVersionMissing", "installable package lacks Kubernetes resource version evidence")
	}
	return ExtensionCandidate{
		ID: id, DescriptorID: "extension." + id, Kind: kind,
		DisplayName: nestedString(pkg.Object, "spec", "displayName"),
		Image:       image, Digest: digest, Channel: channel,
		SourceRevision: sourceRevision, ManifestDigest: "sha256:" + manifest,
		CompatibilityVersion: compatibilityVersion, BuildAuthority: buildAuthority, KeyID: keyID, EvidenceRefs: evidenceRefs,
		PackageResourceVersion: pkg.GetResourceVersion(), PackageGeneration: pkg.GetGeneration(),
		Capabilities: extensionCapabilitiesFromMap(nestedMap(pkg.Object, "spec", "contributions")),
	}, nil
}

func exactExtensionImage(plugin Plugin) string {
	repository := requestedRepository(plugin.RequestedRef)
	if repository == "" || repository != canonicalExtensionRepository(plugin.Kind, plugin.ID) || !digestRE.MatchString(plugin.InstalledDigest) {
		return ""
	}
	return repository + "@" + plugin.InstalledDigest
}

func pluginFrom(pkg, reg unstructured.Unstructured, nav map[string]interface{}, prior *Plugin) (Plugin, *catalog.Rejected) {
	id := pkg.GetName()
	digest := nestedString(reg.Object, "status", "currentDigest")
	manifestDigest := nestedString(reg.Object, "status", "currentManifestSha256")
	keyID := nestedString(pkg.Object, "spec", "trust", "keyId")
	if !digestRE.MatchString(digest) {
		return Plugin{}, &catalog.Rejected{Kind: "extension", ID: id, Code: "InvalidDigest", Message: "verified exact image digest is missing"}
	}
	if !manifestRE.MatchString(manifestDigest) {
		return Plugin{}, &catalog.Rejected{Kind: "extension", ID: id, Code: "InvalidManifestDigest", Message: "verified manifest digest is missing"}
	}
	if keyID == "" {
		return Plugin{}, &catalog.Rejected{Kind: "extension", ID: id, Code: "MissingTrustKey", Message: "signature key identity is missing"}
	}

	manifestURL := nestedString(reg.Object, "status", "manifestUrl")
	signatureName := path.Base(nestedString(pkg.Object, "spec", "manifest", "signaturePath"))
	if signatureName == "." || signatureName == "" {
		signatureName = "ui-shell.manifest.json.sig"
	}
	signatureURL := strings.TrimSuffix(path.Dir(manifestURL), "/") + "/" + signatureName
	contributions := nestedMap(pkg.Object, "spec", "contributions")
	apiBase := nestedString(pkg.Object, "spec", "contributions", "api", "basePath")
	var cli *CLIContribution
	if enabled, _, _ := unstructured.NestedBool(pkg.Object, "spec", "contributions", "cli", "enabled"); enabled {
		cli = &CLIContribution{Namespace: nestedString(pkg.Object, "spec", "cli", "namespace"), ManifestPath: nestedString(pkg.Object, "spec", "cli", "manifestPath"), APIBase: apiBase}
		if cli.Namespace == "" {
			cli.Namespace = nestedString(pkg.Object, "spec", "contributions", "cli", "namespace")
		}
		if cli.ManifestPath == "" {
			cli.ManifestPath = nestedString(pkg.Object, "spec", "contributions", "cli", "manifestPath")
		}
	}
	name := nestedString(pkg.Object, "spec", "displayName")
	icon := nestedString(pkg.Object, "spec", "nav", "icon")
	if label, ok := nav["labelOverride"].(string); ok && strings.TrimSpace(label) != "" {
		name = label
	}
	if override, ok := nav["icon"].(string); ok {
		icon = override
	}
	servingPhase := nestedString(reg.Object, "status", "serving", "phase")
	plugin := Plugin{
		ID: id, Name: name, Manifest: manifestURL, ManifestSHA256: manifestDigest, Signature: signatureURL,
		KeyID: keyID, Kind: nestedString(pkg.Object, "spec", "kind"), HostRef: nestedString(pkg.Object, "spec", "hostRef"),
		HostAPIVersion: nestedString(pkg.Object, "spec", "hostApiVersion"), HostCompat: nestedString(pkg.Object, "spec", "hostCompat"),
		Contributions: contributions, TelemetryDescriptor: telemetryDescriptor(pkg), CLI: cli,
		RequestedRef: nestedString(reg.Object, "status", "currentRequestedRef"), RequestedChannel: nestedString(reg.Object, "status", "currentRequestedChannel"),
		InstalledDigest: digest, ResolvedAt: nestedString(reg.Object, "status", "currentResolvedAt"), ArtifactVersion: nestedString(reg.Object, "status", "currentVersion"),
		CompatibilityVersion: nestedString(reg.Object, "status", "currentCompatibilityVersion"), BuildAuthority: nestedString(reg.Object, "status", "currentBuildAuthority"),
		SourceRevision: nestedString(reg.Object, "status", "currentRevision"), EvidenceRefs: nestedSlice(reg.Object, "status", "currentEvidenceRefs"),
		ArtifactServiceID: nestedString(reg.Object, "status", "serving", "artifactServiceId"), ReleaseRevision: nestedString(reg.Object, "status", "serving", "revision"),
		RetainedArtifactServiceIDs: []interface{}{}, CurrentChannelDigest: nestedString(reg.Object, "status", "currentChannelDigest"),
		UpdateState: nestedString(reg.Object, "status", "channelState"), ChannelCheckedAt: nestedString(reg.Object, "status", "channelCheckedAt"),
		ChannelReason: nestedString(reg.Object, "status", "channelReason"), Approval: Approval{Actor: nestedString(reg.Object, "spec", "approval", "requestedBy"), Reason: nestedString(reg.Object, "spec", "approval", "reason"), Time: reg.GetCreationTimestamp().UTC().Format(time.RFC3339)},
		Icon: icon, Available: true,
	}
	if exactExtensionImage(plugin) == "" {
		return Plugin{}, &catalog.Rejected{Kind: "extension", ID: id, Code: "ExecutionIdentityInvalid", Message: "verified extension lacks its canonical exact-digest execution identity"}
	}
	if !sourceRevisionRE.MatchString(plugin.SourceRevision) {
		return Plugin{}, &catalog.Rejected{Kind: "extension", ID: id, Code: "SourceRevisionInvalid", Message: "verified extension lacks a full governed source revision"}
	}
	if !compatibilityVersionRE.MatchString(plugin.CompatibilityVersion) {
		return Plugin{}, &catalog.Rejected{Kind: "extension", ID: id, Code: "CompatibilityVersionInvalid", Message: "verified extension lacks a plain semantic compatibility version"}
	}
	if len(plugin.EvidenceRefs) < 2 {
		return Plugin{}, &catalog.Rejected{Kind: "extension", ID: id, Code: "SupplyChainEvidenceMissing", Message: "verified extension lacks provenance and SBOM evidence references"}
	}
	if prior != nil && prior.ArtifactServiceID != "" && prior.ArtifactServiceID != plugin.ArtifactServiceID {
		plugin.RetainedArtifactServiceIDs = []interface{}{prior.ArtifactServiceID}
	} else {
		previousDigest := nestedString(reg.Object, "status", "previousDigest")
		previousManifest := nestedString(reg.Object, "status", "previousManifestSha256")
		if digestRE.MatchString(previousDigest) && manifestRE.MatchString(previousManifest) {
			previousService := releaseServiceID(id, previousDigest, previousManifest)
			if previousService != plugin.ArtifactServiceID {
				plugin.RetainedArtifactServiceIDs = []interface{}{previousService}
			}
		}
	}
	if servingPhase == "LastKnownGood" {
		plugin.ServingMode = servingPhase
		plugin.ServingReason = nestedString(reg.Object, "status", "serving", "reason")
	}
	return plugin, nil
}

func descriptorSpec(item unstructured.Unstructured) map[string]interface{} {
	// FoundationModuleDescriptor is an installation descriptor, not a PFSS
	// runtime configuration envelope. Project only the fields owned by the
	// Registry contract so a permissive source CRD cannot accidentally publish
	// version/profile/capacity/replica/storage/backup or lifecycle state.
	out := map[string]interface{}{}
	if value := nestedString(item.Object, "spec", "model"); value != "" {
		out["model"] = value
	}
	if value := nestedMap(item.Object, "spec", "description"); len(value) > 0 {
		out["description"] = map[string]interface{}{"summary": nestedString(value, "summary")}
	}
	if value := nestedMap(item.Object, "spec", "catalog"); len(value) > 0 {
		projected := map[string]interface{}{}
		if authority := nestedString(value, "authority"); authority != "" {
			projected["authority"] = authority
		}
		if install := nestedString(value, "install"); install != "" {
			projected["install"] = install
		}
		if fixed, ok, _ := unstructured.NestedBool(value, "fixed"); ok {
			projected["fixed"] = fixed
		}
		out["catalog"] = projected
	}
	if value := nestedMap(item.Object, "spec", "operator"); len(value) > 0 {
		projected := map[string]interface{}{}
		if image := nestedString(value, "image"); image != "" {
			projected["image"] = image
		}
		if chartRef := nestedMap(value, "chartRef"); len(chartRef) > 0 {
			projected["chartRef"] = chartRef
		}
		if capability := nestedSlice(value, "capability"); len(capability) > 0 {
			projected["capability"] = capability
		}
		out["operator"] = projected
	}
	if value := nestedMap(item.Object, "spec", "relations"); len(value) > 0 {
		projected := map[string]interface{}{}
		if consumed := nestedSlice(value, "consumed"); consumed != nil {
			projected["consumed"] = consumed
		}
		if consumers := nestedSlice(value, "consumers"); consumers != nil {
			projected["consumers"] = consumers
		}
		out["relations"] = projected
	}
	return out
}

func catalogObjects(list *unstructured.UnstructuredList) []catalog.Object {
	items := make([]catalog.Object, 0, len(list.Items))
	for _, item := range list.Items {
		items = append(items, catalog.Object{ID: item.GetName(), Spec: descriptorSpec(item)})
	}
	catalog.SortObjects(items)
	return items
}

type coreServiceMetadata struct {
	ID, DisplayName, Domain, OwnerID, LifecycleAPI string
	Capabilities                                   []string
}

var coreServices = map[string]coreServiceMetadata{
	"console":                {"cbss.opensphere-console", "OpenSphere Console", "console", "cbss.console", "/api/health", []string{"main-shell", "administration"}},
	"consoleApi":             {"cbss.opensphere-console-api", "OpenSphere Console API", "control", "cbss.console-api", "/healthz", []string{"identity", "policy-gate", "durable-operation", "owner-admission"}},
	"extensionController":    {"cbss.opensphere-extension-controller", "OpenSphere Extension Controller", "extensions", "cbss.extensions", "/healthz", []string{"extension-reconcile", "signature-verification", "workload-lifecycle"}},
	"registry":               {"cbss.opensphere-registry", "OpenSphere Registry & Catalog Service", "catalog", "cbss.registry", "/api/v1/registry", []string{"discovery", "normalization", "revision", "resolve"}},
	"osaaGateway":            {"cbss.opensphere-osaa-gateway", "OSAA Gateway", "agent", "cbss.osaa", "/api/osaa/health", []string{"dialogue", "tool-routing"}},
	"osdst":                  {"cbss.opensphere-osdst", "OpenSphere Dialogue State Tracker", "agent", "cbss.osdst", "/api/osdst/v1/status", []string{"dialogue-state", "typed-projection", "deterministic-rendering"}},
	"osaaGovernedAdapter":    {"cbss.opensphere-osaa-governed-adapter", "OSAA Governed Adapter", "agent", "cbss.osaa", "/api/osaa/health", []string{"governed-execution"}},
	"notificationDispatcher": {"cbss.opensphere-notification-dispatcher", "Notification Dispatcher", "operations", "cbss.notifications", "/api/health", []string{"notification-delivery"}},
	"gitea":                  {"cbss.opensphere-gitea", "CBSS Gitea", "source-control", "cbss.gitea", "/api/health", []string{"desired-state", "approval-evidence"}},
	"supabasePostgres":       {"cbss.opensphere-supabase-postgres", "CBSS Supabase PostgreSQL", "console-data", "cbss.supabase", "/api/health", []string{"console-data"}},
	"supabaseAuth":           {"cbss.opensphere-supabase-auth", "CBSS Supabase Auth", "identity", "cbss.supabase", "/api/identity/session", []string{"administrator-identity", "session"}},
	"supabaseRest":           {"cbss.opensphere-supabase-rest", "CBSS Supabase REST", "console-data", "cbss.supabase", "/api/health", []string{"console-data-api"}},
	"supabaseStorage":        {"cbss.opensphere-supabase-storage", "CBSS Supabase Storage", "console-data", "cbss.supabase", "/api/health", []string{"console-object-storage"}},
	"giteaPostgres":          {"cbss.opensphere-gitea-postgres", "CBSS Gitea PostgreSQL", "source-control", "cbss.gitea", "/api/health", []string{"gitea-data"}},
	"recovery":               {"cbss.opensphere-recovery", "OpenSphere Recovery", "recovery", "cbss.recovery", "/api/admin/recovery/status", []string{"backup", "restore", "recovery-evidence"}},
	"beszelHub":              {"cbss.opensphere-beszel-hub", "Beszel Hub", "monitoring", "cbss.monitoring", "/api/monitoring/baseline/v1/data-health", []string{"node-telemetry", "alerts"}},
	"beszelAgent":            {"cbss.opensphere-beszel-agent", "Beszel Agent", "monitoring", "cbss.monitoring", "/api/monitoring/baseline/v1/nodes", []string{"node-observation"}},
	"beszelBootstrap":        {"cbss.opensphere-beszel-bootstrap", "Beszel Bootstrap", "monitoring", "cbss.monitoring", "/api/monitoring/baseline/v1/data-health", []string{"reader-bootstrap", "agent-enrollment"}},
}

func imageDigest(image string) string {
	parts := strings.Split(image, "@")
	if len(parts) != 2 || !digestRE.MatchString(parts[1]) {
		return ""
	}
	return parts[1]
}

func observedGeneration(resourceVersion string) int64 {
	value, _ := strconv.ParseInt(resourceVersion, 10, 64)
	return value
}

func extensionCapabilities(plugin Plugin) []string {
	return extensionCapabilitiesFromMap(plugin.Contributions)
}

func buildInventory(input Input, candidates []ExtensionCandidate, candidateRejections []catalog.Rejected, rejected *[]catalog.Rejected) catalog.Inventory {
	descriptors := []catalog.Descriptor{}
	missing := []catalog.CoverageGap{}
	rejectedByClass := map[string]int{"coreService": 0, "extension": 0, "installableModule": 0}
	expectedByClass := map[string]int{
		"coreService":       len(input.ReleaseLock.Components),
		"extension":         len(input.Packages.Items),
		"installableModule": len(input.Descriptors.Items),
	}

	for componentName, component := range input.ReleaseLock.Components {
		metadata, ok := coreServices[componentName]
		if !ok {
			id := "core." + componentName
			*rejected = append(*rejected, catalog.Rejected{Kind: "coreService", ID: id, Code: "DescriptorMissing", Message: "release component has no Registry metadata adapter"})
			missing = append(missing, catalog.CoverageGap{ID: id, Class: "coreService", Code: "DescriptorMissing", Message: "release component has no Registry metadata adapter"})
			rejectedByClass["coreService"]++
			continue
		}
		digest := imageDigest(component.Image)
		if digest == "" || component.SourceRevision == "" {
			code := "ReleaseEvidenceMissing"
			if digest == "" {
				code = "DigestMissing"
			}
			*rejected = append(*rejected, catalog.Rejected{Kind: "coreService", ID: metadata.ID, Code: code, Message: "canonical release component lacks exact release evidence"})
			missing = append(missing, catalog.CoverageGap{ID: metadata.ID, Class: "coreService", Code: code, Message: "canonical release component lacks exact release evidence"})
			rejectedByClass["coreService"]++
			continue
		}
		descriptors = append(descriptors, catalog.Descriptor{
			ID: metadata.ID, Class: "coreService", DisplayName: metadata.DisplayName, Domain: metadata.Domain,
			Owner:        catalog.Owner{ID: metadata.OwnerID, LifecycleAPI: metadata.LifecycleAPI},
			Source:       catalog.Source{Kind: "OpenSphereReleaseLock", Name: componentName},
			Release:      catalog.Release{Version: component.SourceRevision, ImageDigest: digest},
			Capabilities: append([]string(nil), metadata.Capabilities...),
			Installation: catalog.Installation{Mode: "built-in", Eligible: false},
			Evidence:     catalog.Evidence{ObservedGeneration: observedGeneration(input.ReleaseLockResourceVersion), SourceRevision: component.SourceRevision},
		})
	}

	for _, candidate := range candidates {
		descriptors = append(descriptors, catalog.Descriptor{
			ID: candidate.DescriptorID, Class: "extension", DisplayName: candidate.DisplayName, Domain: "console-extension",
			Owner:        catalog.Owner{ID: "opensphere-console", LifecycleAPI: "/api/admin/extensions/registrations/" + candidate.ID},
			Source:       catalog.Source{Kind: "UIPluginPackage", Name: candidate.ID},
			Release:      catalog.Release{Version: candidate.CompatibilityVersion, ImageDigest: candidate.Digest},
			Capabilities: candidate.Capabilities, Installation: catalog.Installation{Mode: "extension-controller", Eligible: true},
			Evidence: catalog.Evidence{ObservedGeneration: candidate.PackageGeneration, SourceRevision: candidate.SourceRevision},
		})
	}
	for _, rejection := range candidateRejections {
		rejectedByClass["extension"]++
		missing = append(missing, catalog.CoverageGap{
			ID: rejection.ID, Class: "extension", Code: rejection.Code, Message: rejection.Message,
		})
	}

	for _, item := range input.Descriptors.Items {
		id := "foundation." + item.GetName()
		digest := imageDigest(nestedString(item.Object, "spec", "operator", "image"))
		if digest == "" {
			*rejected = append(*rejected, catalog.Rejected{Kind: "installableModule", ID: id, Code: "DigestMissing", Message: "Foundation descriptor does not identify one exact-digest installable artifact"})
			missing = append(missing, catalog.CoverageGap{ID: id, Class: "installableModule", Code: "DigestMissing", Message: "Foundation descriptor does not identify one exact-digest installable artifact"})
			rejectedByClass["installableModule"]++
			continue
		}
		capabilities := []string{}
		for _, value := range nestedSlice(item.Object, "spec", "operator", "capability") {
			if capability, ok := value.(string); ok {
				capabilities = append(capabilities, capability)
			}
		}
		sort.Strings(capabilities)
		mode := nestedString(item.Object, "spec", "catalog", "install")
		if mode == "" {
			mode = "optional"
		}
		descriptors = append(descriptors, catalog.Descriptor{
			ID: id, Class: "installableModule", DisplayName: item.GetName(), Domain: "foundation",
			Owner:   catalog.Owner{ID: "pfss.foundation", LifecycleAPI: "/api/foundation/modules/" + item.GetName()},
			Source:  catalog.Source{Kind: "FoundationModuleDescriptor", Name: item.GetName()},
			Release: catalog.Release{Version: item.GetResourceVersion(), ImageDigest: digest}, Capabilities: capabilities,
			Installation: catalog.Installation{Mode: mode, Eligible: true},
			Evidence:     catalog.Evidence{ObservedGeneration: item.GetGeneration(), SourceRevision: item.GetResourceVersion()},
		})
	}

	catalog.SortDescriptors(descriptors)
	identityCount := map[string]int{}
	for _, descriptor := range descriptors {
		identityCount[descriptor.ID]++
	}
	unique := make([]catalog.Descriptor, 0, len(descriptors))
	for _, descriptor := range descriptors {
		if identityCount[descriptor.ID] > 1 {
			*rejected = append(*rejected, catalog.Rejected{Kind: descriptor.Class, ID: descriptor.ID, Code: "DuplicateIdentity", Message: "descriptor identity collides across Registry sources"})
			missing = append(missing, catalog.CoverageGap{ID: descriptor.ID, Class: descriptor.Class, Code: "DuplicateIdentity", Message: "descriptor identity collides across Registry sources"})
			rejectedByClass[descriptor.Class]++
			continue
		}
		unique = append(unique, descriptor)
	}
	sort.SliceStable(missing, func(i, j int) bool {
		if missing[i].ID != missing[j].ID {
			return missing[i].ID < missing[j].ID
		}
		return missing[i].Code < missing[j].Code
	})
	publishedByClass := map[string]int{"coreService": 0, "extension": 0, "installableModule": 0}
	for _, descriptor := range unique {
		publishedByClass[descriptor.Class]++
	}
	byClass := map[string]catalog.ClassCoverage{}
	for _, class := range []string{"coreService", "extension", "installableModule"} {
		byClass[class] = catalog.ClassCoverage{Expected: expectedByClass[class], Published: publishedByClass[class], Rejected: rejectedByClass[class], Missing: expectedByClass[class] - publishedByClass[class]}
	}
	return catalog.Inventory{Descriptors: unique, Coverage: catalog.Coverage{Expected: expectedByClass["coreService"] + expectedByClass["extension"] + expectedByClass["installableModule"], Published: len(unique), Rejected: rejectedByClass["coreService"] + rejectedByClass["extension"] + rejectedByClass["installableModule"], Missing: missing, ByClass: byClass}}
}

func Build(input Input) (Response, error) {
	if input.Packages == nil || input.Registrations == nil || input.Descriptors == nil {
		return Response{}, errors.New("required Registry source is missing")
	}
	if len(input.ReleaseLock.Components) == 0 {
		return Response{}, errors.New("canonical release inventory is missing")
	}
	regs := map[string]unstructured.Unstructured{}
	for _, reg := range input.Registrations.Items {
		regs[reg.GetName()] = reg
	}
	plugins := []Plugin{}
	candidates := []ExtensionCandidate{}
	rejected := []catalog.Rejected{}
	candidateRejections := []catalog.Rejected{}
	seen := map[string]bool{}
	previous := map[string]Plugin{}
	for _, plugin := range input.PreviousPlugins {
		previous[plugin.ID] = plugin
	}
	for _, pkg := range input.Packages.Items {
		id := pkg.GetName()
		if seen[id] {
			rejection := catalog.Rejected{Kind: "extension", ID: "extension." + id, Code: "DuplicateID", Message: "duplicate extension id"}
			rejected = append(rejected, rejection)
			candidateRejections = append(candidateRejections, rejection)
			continue
		}
		seen[id] = true
		candidate, candidateRejection := installableExtensionFromPackage(pkg, input.TrustedKeys)
		if candidateRejection != nil {
			rejected = append(rejected, *candidateRejection)
			candidateRejections = append(candidateRejections, *candidateRejection)
		} else {
			candidates = append(candidates, candidate)
		}
		reg, ok := regs[id]
		if !ok || !verifiedRegistration(&reg) {
			continue
		}
		prior, hasPrior := previous[id]
		if !packageMatchesCurrentRegistration(pkg, reg) {
			if hasPrior && prior.InstalledDigest == nestedString(reg.Object, "status", "currentDigest") && prior.ManifestSHA256 == nestedString(reg.Object, "status", "currentManifestSha256") {
				if label, ok := input.Navigation[id]["labelOverride"].(string); ok && strings.TrimSpace(label) != "" {
					prior.Name = label
				}
				if icon, ok := input.Navigation[id]["icon"].(string); ok {
					prior.Icon = icon
				}
				plugins = append(plugins, prior)
				rejected = append(rejected, catalog.Rejected{Kind: "extension", ID: id, Code: "ReleaseCoordinatesPending", Message: "target package is not the activated release; last-known-good remains published"})
				continue
			}
			rejected = append(rejected, catalog.Rejected{Kind: "extension", ID: id, Code: "ReleaseCoordinatesMismatch", Message: "package and activated registration coordinates differ"})
			continue
		}
		var priorPlugin *Plugin
		if hasPrior {
			priorPlugin = &prior
		}
		plugin, reason := pluginFrom(pkg, reg, input.Navigation[id], priorPlugin)
		if reason != nil {
			rejected = append(rejected, *reason)
			continue
		}
		if _, ok := input.TrustedKeys[plugin.KeyID]; !ok {
			rejected = append(rejected, catalog.Rejected{Kind: "extension", ID: id, Code: "UnknownTrustKey", Message: "signature key is not trusted"})
			continue
		}
		plugins = append(plugins, plugin)
	}
	sort.SliceStable(plugins, func(i, j int) bool { return plugins[i].ID < plugins[j].ID })
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].ID < candidates[j].ID })
	p := catalog.EmptyProjection()
	p.ModuleDescriptors = catalogObjects(input.Descriptors)
	inventory := buildInventory(input, candidates, candidateRejections, &rejected)
	catalog.SortRejected(rejected)
	ids := make([]string, len(plugins))
	for i := range plugins {
		ids[i] = plugins[i].ID
	}
	response := Response{Version: 3, TrustedKeys: input.TrustedKeys, Capabilities: []interface{}{}, Plugins: plugins, InstallableExtensions: candidates, Templates: []interface{}{}, Schema: catalog.Schema, ObservedAt: input.ObservedAt.UTC().Format(time.RFC3339Nano), Sources: input.Sources, Extensions: ExtensionSummary{Count: len(plugins), PublishedIDs: ids}, Catalog: p, Inventory: inventory, Rejected: rejected}
	// Revision identifies the semantic snapshot consumed by Console, OSC, OSAA
	// and OSCE. Observation timestamps remain in the response as evidence, but
	// must not invalidate a plan when the exact candidates and policy are
	// unchanged. The extension controller refreshes channelCheckedAt frequently.
	revisionPlugins := append([]Plugin(nil), plugins...)
	for i := range revisionPlugins {
		revisionPlugins[i].ResolvedAt = ""
		revisionPlugins[i].ChannelCheckedAt = ""
	}
	content := struct {
		Version     int                  `json:"version"`
		TrustedKeys map[string]string    `json:"trustedKeys"`
		Plugins     []Plugin             `json:"plugins"`
		Candidates  []ExtensionCandidate `json:"installableExtensions"`
		Catalog     catalog.Projection   `json:"catalog"`
		Inventory   catalog.Inventory    `json:"inventory"`
		Rejected    []catalog.Rejected   `json:"rejected"`
	}{response.Version, response.TrustedKeys, revisionPlugins, response.InstallableExtensions, response.Catalog, response.Inventory, response.Rejected}
	encoded, err := json.Marshal(content)
	if err != nil {
		return Response{}, err
	}
	sum := sha256.Sum256(encoded)
	response.Revision = "sha256:" + hex.EncodeToString(sum[:])
	return response, nil
}

type Source struct {
	Name      string
	GVR       schema.GroupVersionResource
	Namespace string
	Required  bool
}

var sources = []Source{
	{"extensions.packages", uipkgGVR, registryNamespace, true}, {"extensions.registrations", uiregGVR, registryNamespace, true},
	{"catalog.descriptors", descriptorGVR, "", true},
}

func resource(dyn dynamic.Interface, source Source) dynamic.ResourceInterface {
	if source.Namespace != "" {
		return dyn.Resource(source.GVR).Namespace(source.Namespace)
	}
	return dyn.Resource(source.GVR)
}

func LoadInput(ctx context.Context, dyn dynamic.Interface, now time.Time) (Input, error) {
	lists := map[string]*unstructured.UnstructuredList{}
	statuses := map[string]catalog.SourceStatus{}
	for _, source := range sources {
		list, err := resource(dyn, source).List(ctx, metav1.ListOptions{})
		if err != nil {
			statuses[source.Name] = catalog.SourceStatus{Ready: false, Reason: "SourceUnavailable"}
			if source.Required {
				return Input{}, fmt.Errorf("%s: %w", source.Name, err)
			}
			continue
		}
		lists[source.Name] = list
		statuses[source.Name] = catalog.SourceStatus{Ready: true, Count: len(list.Items), ResourceVersion: list.GetResourceVersion()}
	}
	keys, err := loadTrustedKeys(ctx, dyn)
	if err != nil {
		return Input{}, fmt.Errorf("trust.keys: %w", err)
	}
	statuses["trust.keys"] = catalog.SourceStatus{Ready: true, Count: len(keys)}
	navigation, err := loadNavigation(ctx, dyn)
	if err != nil {
		return Input{}, fmt.Errorf("extensions.navigation: %w", err)
	}
	statuses["extensions.navigation"] = catalog.SourceStatus{Ready: true, Count: len(navigation)}
	releaseLock, resourceVersion, err := loadReleaseLock(ctx, dyn)
	if err != nil {
		return Input{}, fmt.Errorf("release.inventory: %w", err)
	}
	statuses["release.inventory"] = catalog.SourceStatus{Ready: true, Count: len(releaseLock.Components), ResourceVersion: resourceVersion}
	return Input{Packages: lists["extensions.packages"], Registrations: lists["extensions.registrations"], Descriptors: lists["catalog.descriptors"], ReleaseLock: releaseLock, ReleaseLockResourceVersion: resourceVersion, TrustedKeys: keys, Navigation: navigation, Sources: statuses, ObservedAt: now}, nil
}

func loadReleaseLock(ctx context.Context, dyn dynamic.Interface) (ReleaseLock, string, error) {
	cm, err := dyn.Resource(configMapGVR).Namespace(registryNamespace).Get(ctx, installationLockConfigMap, metav1.GetOptions{})
	if err != nil {
		return ReleaseLock{}, "", err
	}
	raw, _, _ := unstructured.NestedString(cm.Object, "data", installationLockKey)
	var lock ReleaseLock
	if err := json.Unmarshal([]byte(raw), &lock); err != nil {
		return ReleaseLock{}, "", errors.New("release lock payload is invalid")
	}
	if !digestRE.MatchString(lock.ReleaseDigest) || len(lock.Components) == 0 {
		return ReleaseLock{}, "", errors.New("release lock lacks canonical release evidence")
	}
	return lock, cm.GetResourceVersion(), nil
}

func loadTrustedKeys(ctx context.Context, dyn dynamic.Interface) (map[string]string, error) {
	cm, err := dyn.Resource(configMapGVR).Namespace(registryNamespace).Get(ctx, trustConfigMap, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	raw, _, _ := unstructured.NestedString(cm.Object, "data", "trusted-keys.json")
	var payload struct {
		TrustedKeys map[string]string `json:"trustedKeys"`
	}
	if json.Unmarshal([]byte(raw), &payload) != nil || len(payload.TrustedKeys) == 0 {
		return nil, errors.New("trusted key payload is invalid")
	}
	return payload.TrustedKeys, nil
}

func loadNavigation(ctx context.Context, dyn dynamic.Interface) (map[string]map[string]interface{}, error) {
	cm, err := dyn.Resource(configMapGVR).Namespace(registryNamespace).Get(ctx, navigationConfigMap, metav1.GetOptions{})
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return map[string]map[string]interface{}{}, nil
		}
		return nil, err
	}
	raw, _, _ := unstructured.NestedString(cm.Object, "data", navigationKey)
	if strings.TrimSpace(raw) == "" {
		return map[string]map[string]interface{}{}, nil
	}
	out := map[string]map[string]interface{}{}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, err
	}
	return out, nil
}

type Store struct {
	dyn          dynamic.Interface
	now          func() time.Time
	snapshot     atomic.Pointer[Response]
	mu           sync.Mutex
	lastSuccess  time.Time
	lastError    string
	resolveTotal atomic.Uint64
}

func NewStore(dyn dynamic.Interface) *Store { return &Store{dyn: dyn, now: time.Now} }
func (s *Store) Refresh(ctx context.Context) error {
	input, err := LoadInput(ctx, s.dyn, s.now())
	if err == nil {
		var next Response
		if prior := s.snapshot.Load(); prior != nil {
			input.PreviousPlugins = append([]Plugin(nil), prior.Plugins...)
		}
		next, err = Build(input)
		if err == nil {
			s.snapshot.Store(&next)
			s.mu.Lock()
			s.lastSuccess = s.now()
			s.lastError = ""
			s.mu.Unlock()
			return nil
		}
	}
	s.mu.Lock()
	s.lastError = "SourceUnavailable"
	s.mu.Unlock()
	return err
}
func (s *Store) Current() (Response, bool) {
	p := s.snapshot.Load()
	if p == nil {
		return Response{}, false
	}
	out := *p
	out.Stale = s.Stale()
	return out, true
}
func (s *Store) Stale() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastSuccess.IsZero() || s.lastError != "" || s.now().Sub(s.lastSuccess) > freshnessTarget
}
func (s *Store) LastError() string { s.mu.Lock(); defer s.mu.Unlock(); return s.lastError }
func (s *Store) Run(ctx context.Context) {
	_ = s.Refresh(ctx)
	changes := make(chan struct{}, 1)
	for _, source := range sources {
		go s.watch(ctx, source, changes)
	}
	go s.watchConfigMap(ctx, registryNamespace, trustConfigMap, changes)
	go s.watchConfigMap(ctx, registryNamespace, navigationConfigMap, changes)
	go s.watchConfigMap(ctx, registryNamespace, installationLockConfigMap, changes)
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-changes:
			time.Sleep(150 * time.Millisecond)
			_ = s.Refresh(ctx)
		case <-ticker.C:
			_ = s.Refresh(ctx)
		}
	}
}
func (s *Store) watch(ctx context.Context, source Source, changes chan<- struct{}) {
	for {
		if ctx.Err() != nil {
			return
		}
		w, err := resource(s.dyn, source).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			time.Sleep(time.Second)
			continue
		}
		s.consumeWatch(ctx, w, changes)
		time.Sleep(200 * time.Millisecond)
	}
}
func (s *Store) watchConfigMap(ctx context.Context, namespace, name string, changes chan<- struct{}) {
	for {
		if ctx.Err() != nil {
			return
		}
		w, err := s.dyn.Resource(configMapGVR).Namespace(namespace).Watch(ctx, metav1.ListOptions{FieldSelector: "metadata.name=" + name})
		if err != nil {
			time.Sleep(time.Second)
			continue
		}
		s.consumeWatch(ctx, w, changes)
		time.Sleep(200 * time.Millisecond)
	}
}
func (s *Store) consumeWatch(ctx context.Context, w watch.Interface, changes chan<- struct{}) {
	defer w.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-w.ResultChan():
			if !ok {
				return
			}
			select {
			case changes <- struct{}{}:
			default:
			}
		}
	}
}

type ResolveRequest struct {
	Kind         string `json:"kind"`
	ID           string `json:"id"`
	Architecture string `json:"architecture"`
	Channel      string `json:"channel"`
	Revision     string `json:"revision"`
}
type ResolveResponse struct {
	Result      string      `json:"result"`
	Revision    string      `json:"revision"`
	Candidate   interface{} `json:"candidate,omitempty"`
	BlockerCode string      `json:"blockerCode,omitempty"`
	Message     string      `json:"message,omitempty"`
}

func (s *Store) Resolve(req ResolveRequest) ResolveResponse {
	s.resolveTotal.Add(1)
	snap, ok := s.Current()
	if !ok {
		return ResolveResponse{Result: "Unavailable", BlockerCode: "RegistryUnavailable", Message: "Registry snapshot is unavailable"}
	}
	if snap.Stale {
		return ResolveResponse{Result: "Unavailable", Revision: snap.Revision, BlockerCode: "RegistryStale", Message: "Registry sources are stale"}
	}
	if req.Revision != snap.Revision {
		return ResolveResponse{Result: "StaleRevision", Revision: snap.Revision, BlockerCode: "CatalogRevisionChanged", Message: "Catalog revision changed; create a new plan"}
	}
	if req.Architecture != "" && req.Architecture != "linux/amd64" {
		return ResolveResponse{Result: "Ineligible", Revision: snap.Revision, BlockerCode: "ArchitectureUnsupported", Message: "Only linux/amd64 is published in the local edge catalog"}
	}
	if req.Channel != "" && req.Channel != "edge" {
		return ResolveResponse{Result: "Ineligible", Revision: snap.Revision, BlockerCode: "ChannelUnsupported", Message: "Requested channel is not published in this catalog"}
	}
	switch req.Kind {
	case "extension":
		for _, p := range snap.InstallableExtensions {
			if p.ID == req.ID || p.DescriptorID == req.ID {
				return ResolveResponse{Result: "Eligible", Revision: snap.Revision, Candidate: map[string]interface{}{
					"kind": "extension", "descriptorId": p.DescriptorID, "id": p.ID,
					"image": p.Image, "digest": p.Digest, "channel": p.Channel,
					"catalogRevision": snap.Revision, "descriptorRevision": snap.Revision,
					"executionRevision": p.Image, "sourceRevision": p.SourceRevision, "buildAuthority": p.BuildAuthority,
					"manifestDigest": p.ManifestDigest, "compatibilityVersion": p.CompatibilityVersion,
					"keyId": p.KeyID, "evidenceRefs": p.EvidenceRefs,
					"packageResourceVersion": p.PackageResourceVersion, "packageGeneration": p.PackageGeneration,
					"verification": map[string]string{
						"catalog": "Verified", "manifest": "Verified", "signature": "Verified", "permissions": "Approved",
						"provenance": "LocalEdgeSigned", "sbom": "NotRequiredLocalEdge",
					},
				}}
			}
		}
	case "installableModule":
		for _, descriptor := range snap.Inventory.Descriptors {
			if descriptor.Class == "installableModule" && descriptor.ID == req.ID && descriptor.Installation.Eligible {
				return ResolveResponse{Result: "Eligible", Revision: snap.Revision, Candidate: map[string]interface{}{"kind": descriptor.Class, "descriptorId": descriptor.ID, "digest": descriptor.Release.ImageDigest, "catalogRevision": snap.Revision}}
			}
		}
	}
	return ResolveResponse{Result: "Ineligible", Revision: snap.Revision, BlockerCode: "CandidateNotFound", Message: "Requested catalog candidate does not exist"}
}
func (s *Store) ResolveCount() uint64 { return s.resolveTotal.Load() }
