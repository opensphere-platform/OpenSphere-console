// Package registry 는 단일 데이터셋을 /api/v1/registry 3 표현으로 투영하고,
// 라이브 UIPluginPackage CR 을 plugin 표현으로 합산한다.
package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"github.com/opensphere/registry/internal/catalog"
)

// uipkgGVR = UIPluginPackage (dupa 플러그인 단일창구).
var uipkgGVR = schema.GroupVersionResource{
	Group: "plugins.opensphere.io", Version: "v1alpha1", Resource: "uipluginpackages",
}
var uiregGVR = schema.GroupVersionResource{
	Group: "plugins.opensphere.io", Version: "v1alpha1", Resource: "uipluginregistrations",
}
var configMapGVR = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}

const registryNamespace = "opensphere-system"

// Response 는 GET /api/v1/registry 단일 권위 응답이다(단일 데이터셋 → 3 표현).
type Response struct {
	Version      int               `json:"version"`
	TrustedKeys  map[string]string `json:"trustedKeys,omitempty"`
	Capabilities []catalog.Item    `json:"capabilities"`
	Plugins      []catalog.Item    `json:"plugins"`
	Templates    []catalog.Item    `json:"templates"`
}

// LoadLivePlugins 는 클러스터의 UIPluginPackage CR 을 라이브로 읽어 plugin 항목으로 변환한다.
func LoadLivePlugins(ctx context.Context, dyn dynamic.Interface) ([]catalog.Item, error) {
	list, err := dyn.Resource(uipkgGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	regs, regErr := dyn.Resource(uiregGVR).List(ctx, metav1.ListOptions{})
	if regErr != nil {
		return nil, regErr
	}
	regByName := make(map[string]unstructured.Unstructured, len(regs.Items))
	for i := range regs.Items {
		packageName, _, _ := unstructured.NestedString(regs.Items[i].Object, "spec", "packageRef", "name")
		if packageName == "" {
			packageName = regs.Items[i].GetName()
		}
		regByName[packageName] = regs.Items[i]
	}
	items := make([]catalog.Item, 0, len(list.Items))
	for i := range list.Items {
		items = append(items, pluginFromUnstructured(list.Items[i], regByName[list.Items[i].GetName()]))
	}
	return items, nil
}

func LoadTrustedKeys(ctx context.Context, dyn dynamic.Interface) (map[string]string, error) {
	cm, err := dyn.Resource(configMapGVR).Namespace(registryNamespace).Get(ctx, "dupa-trusted-keys", metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	var payload struct {
		TrustedKeys map[string]string `json:"trustedKeys"`
	}
	data, ok := cm.Object["data"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("trusted key ConfigMap data missing")
	}
	raw, ok := data["trusted-keys.json"].(string)
	if !ok {
		return nil, fmt.Errorf("trusted-keys.json missing")
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, err
	}
	return payload.TrustedKeys, nil
}

func pluginFromUnstructured(u unstructured.Unstructured, reg unstructured.Unstructured) catalog.Item {
	name := u.GetName()
	display, _, _ := unstructured.NestedString(u.Object, "spec", "displayName")
	version, _, _ := unstructured.NestedString(u.Object, "spec", "version")
	desc, _, _ := unstructured.NestedString(u.Object, "spec", "description")
	repo, _, _ := unstructured.NestedString(u.Object, "spec", "image", "repository")
	digest, _, _ := unstructured.NestedString(u.Object, "spec", "image", "digest")
	componentKind, _, _ := unstructured.NestedString(u.Object, "spec", "kind")
	hostRef, _, _ := unstructured.NestedString(u.Object, "spec", "hostRef")
	hostApiVersion, _, _ := unstructured.NestedString(u.Object, "spec", "hostApiVersion")
	hostCompat, _, _ := unstructured.NestedString(u.Object, "spec", "hostCompat")
	contributions, _, _ := unstructured.NestedMap(u.Object, "spec", "contributions")
	manifestPath, _, _ := unstructured.NestedString(u.Object, "spec", "manifest", "path")
	manifestSHA256, _, _ := unstructured.NestedString(u.Object, "spec", "manifest", "sha256")
	signaturePath, _, _ := unstructured.NestedString(u.Object, "spec", "manifest", "signaturePath")
	keyID, _, _ := unstructured.NestedString(u.Object, "spec", "trust", "keyId")
	icon, _, _ := unstructured.NestedString(u.Object, "spec", "nav", "icon")
	if manifestPath == "" {
		manifestPath = "/plugins/ui-shell.manifest.json"
	}
	if signaturePath == "" {
		signaturePath = "/plugins/ui-shell.manifest.json.sig"
	}
	available := false
	phase := ""
	var observedGeneration int64
	var integrations map[string]interface{}
	if reg.Object != nil {
		desired, _, _ := unstructured.NestedString(reg.Object, "spec", "desiredState")
		phase, _, _ = unstructured.NestedString(reg.Object, "status", "phase")
		observedGeneration, _, _ = unstructured.NestedInt64(reg.Object, "status", "observedGeneration")
		integrations, _, _ = unstructured.NestedMap(reg.Object, "status", "integrations")
		available = desired == "Enabled" && (phase == "Ready" || phase == "Activated") && observedGeneration >= reg.GetGeneration()
	}
	base := os.Getenv("SHELL_API_PREFIX")
	if base == "" {
		base = "/api/plugins"
	}
	manifestURL := fmt.Sprintf("%s/%s%s", base, name, manifestPath)
	signatureURL := fmt.Sprintf("%s/%s%s", base, name, signaturePath)
	if display == "" {
		display = name
	}
	it := catalog.Item{
		Kind: catalog.KindPlugin, ID: name, Name: name, DisplayName: display, Version: version,
		Image: repo, ImageDigest: digest, Description: desc, Source: "live",
		ComponentKind: componentKind, HostRef: hostRef, HostApiVersion: hostApiVersion, HostCompat: hostCompat, Contributions: contributions,
		Manifest: manifestURL, ManifestSHA256: manifestSHA256, Signature: signatureURL, KeyID: keyID, Icon: icon, Available: available,
		Phase: phase, ObservedGeneration: observedGeneration, Integrations: integrations,
	}
	// cli:contribute 광고 — spec.cli 선언 시 os CLI가 소비할 좌표 투영(console==cli, 2026-07-06).
	// apiBase는 spec.api.basePath(프록시 prefix)에서 도출 — os가 <console><apiBase><manifestPath>로 디스패치.
	if ns, ok, _ := unstructured.NestedString(u.Object, "spec", "cli", "namespace"); ok && ns != "" {
		mp, _, _ := unstructured.NestedString(u.Object, "spec", "cli", "manifestPath")
		apiBase, _, _ := unstructured.NestedString(u.Object, "spec", "api", "basePath")
		if mp == "" {
			mp = "/cli/manifest"
		}
		it.CLI = &catalog.CLIContribution{Namespace: ns, ManifestPath: mp, APIBase: apiBase}
	}
	return it
}

// Build 은 단일 데이터셋(items)을 게이트→정렬→3 표현으로 투영한다.
// rejected = ImageDigest 빈값으로 게시거부된 항목명(kind/name).
func Build(items []catalog.Item) (Response, []string) {
	kept, rejected := catalog.Gate(items)
	catalog.Sort(kept)
	resp := Response{
		Version:      3,
		Capabilities: []catalog.Item{},
		Plugins:      []catalog.Item{},
		Templates:    []catalog.Item{},
	}
	for _, it := range kept {
		switch it.Kind {
		case catalog.KindCapability:
			resp.Capabilities = append(resp.Capabilities, it)
		case catalog.KindPlugin:
			resp.Plugins = append(resp.Plugins, it)
		case catalog.KindTemplate:
			resp.Templates = append(resp.Templates, it)
		}
	}
	return resp, rejected
}
