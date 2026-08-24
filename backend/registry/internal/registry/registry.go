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
	uipkgGVR      = schema.GroupVersionResource{Group: "plugins.opensphere.io", Version: "v1alpha1", Resource: "uipluginpackages"}
	uiregGVR      = schema.GroupVersionResource{Group: "plugins.opensphere.io", Version: "v1alpha1", Resource: "uipluginregistrations"}
	descriptorGVR = schema.GroupVersionResource{Group: "foundation.opensphere.io", Version: "v1alpha1", Resource: "foundationmoduledescriptors"}
	configMapGVR  = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}
	digestRE      = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	manifestRE    = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

const (
	registryNamespace   = "opensphere-console"
	trustConfigMap      = "dupa-trusted-keys"
	navigationConfigMap = "opensphere-extension-navigation-v1"
	navigationKey       = "navigation.json"
	freshnessTarget     = 30 * time.Second
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

type Response struct {
	Version      int                             `json:"version"`
	TrustedKeys  map[string]string               `json:"trustedKeys"`
	Capabilities []interface{}                   `json:"capabilities"`
	Plugins      []Plugin                        `json:"plugins"`
	Templates    []interface{}                   `json:"templates"`
	Schema       string                          `json:"schema"`
	Revision     string                          `json:"revision"`
	ObservedAt   string                          `json:"observedAt"`
	Stale        bool                            `json:"stale"`
	Sources      map[string]catalog.SourceStatus `json:"sources"`
	Extensions   ExtensionSummary                `json:"extensions"`
	Catalog      catalog.Projection              `json:"catalog"`
	Rejected     []catalog.Rejected              `json:"rejected"`
}

type Input struct {
	Packages, Registrations, Descriptors *unstructured.UnstructuredList
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

func catalogObjects(list *unstructured.UnstructuredList) []catalog.Object {
	items := make([]catalog.Object, 0, len(list.Items))
	for _, item := range list.Items {
		spec := nestedMap(item.Object, "spec")
		items = append(items, catalog.Object{ID: item.GetName(), Lifecycle: nestedString(item.Object, "spec", "lifecycle"), Spec: spec})
	}
	catalog.SortObjects(items)
	return items
}

func Build(input Input) (Response, error) {
	if input.Packages == nil || input.Registrations == nil || input.Descriptors == nil {
		return Response{}, errors.New("required Registry source is missing")
	}
	regs := map[string]unstructured.Unstructured{}
	for _, reg := range input.Registrations.Items {
		regs[reg.GetName()] = reg
	}
	plugins := []Plugin{}
	rejected := []catalog.Rejected{}
	seen := map[string]bool{}
	previous := map[string]Plugin{}
	for _, plugin := range input.PreviousPlugins {
		previous[plugin.ID] = plugin
	}
	for _, pkg := range input.Packages.Items {
		id := pkg.GetName()
		if seen[id] {
			rejected = append(rejected, catalog.Rejected{Kind: "extension", ID: id, Code: "DuplicateID", Message: "duplicate extension id"})
			continue
		}
		seen[id] = true
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
	p := catalog.EmptyProjection()
	p.ModuleDescriptors = catalogObjects(input.Descriptors)
	catalog.SortRejected(rejected)
	ids := make([]string, len(plugins))
	for i := range plugins {
		ids[i] = plugins[i].ID
	}
	response := Response{Version: 3, TrustedKeys: input.TrustedKeys, Capabilities: []interface{}{}, Plugins: plugins, Templates: []interface{}{}, Schema: catalog.Schema, ObservedAt: input.ObservedAt.UTC().Format(time.RFC3339Nano), Sources: input.Sources, Extensions: ExtensionSummary{Count: len(plugins), PublishedIDs: ids}, Catalog: p, Rejected: rejected}
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
		Version     int                `json:"version"`
		TrustedKeys map[string]string  `json:"trustedKeys"`
		Plugins     []Plugin           `json:"plugins"`
		Catalog     catalog.Projection `json:"catalog"`
		Rejected    []catalog.Rejected `json:"rejected"`
	}{response.Version, response.TrustedKeys, revisionPlugins, response.Catalog, response.Rejected}
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
	return Input{Packages: lists["extensions.packages"], Registrations: lists["extensions.registrations"], Descriptors: lists["catalog.descriptors"], TrustedKeys: keys, Navigation: navigation, Sources: statuses, ObservedAt: now}, nil
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
		for _, p := range snap.Plugins {
			if p.ID == req.ID {
				return ResolveResponse{Result: "Eligible", Revision: snap.Revision, Candidate: map[string]interface{}{"kind": "extension", "id": p.ID, "digest": p.InstalledDigest, "channel": p.RequestedChannel}}
			}
		}
	}
	return ResolveResponse{Result: "Ineligible", Revision: snap.Revision, BlockerCode: "CandidateNotFound", Message: "Requested catalog candidate does not exist"}
}
func (s *Store) ResolveCount() uint64 { return s.resolveTotal.Load() }
