// Package registry 는 단일 데이터셋을 /api/v1/registry 3 표현으로 투영하고,
// 라이브 UIPluginPackage CR 을 plugin 표현으로 합산한다.
package registry

import (
	"context"

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

// Response 는 GET /api/v1/registry 단일 권위 응답이다(단일 데이터셋 → 3 표현).
type Response struct {
	Capabilities []catalog.Item `json:"capabilities"`
	Plugins      []catalog.Item `json:"plugins"`
	Templates    []catalog.Item `json:"templates"`
}

// LoadLivePlugins 는 클러스터의 UIPluginPackage CR 을 라이브로 읽어 plugin 항목으로 변환한다.
func LoadLivePlugins(ctx context.Context, dyn dynamic.Interface) ([]catalog.Item, error) {
	list, err := dyn.Resource(uipkgGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	items := make([]catalog.Item, 0, len(list.Items))
	for i := range list.Items {
		items = append(items, pluginFromUnstructured(list.Items[i]))
	}
	return items, nil
}

func pluginFromUnstructured(u unstructured.Unstructured) catalog.Item {
	name := u.GetName()
	display, _, _ := unstructured.NestedString(u.Object, "spec", "displayName")
	version, _, _ := unstructured.NestedString(u.Object, "spec", "version")
	desc, _, _ := unstructured.NestedString(u.Object, "spec", "description")
	repo, _, _ := unstructured.NestedString(u.Object, "spec", "image", "repository")
	digest, _, _ := unstructured.NestedString(u.Object, "spec", "image", "digest")
	if display == "" {
		display = name
	}
	return catalog.Item{
		Kind: catalog.KindPlugin, Name: name, DisplayName: display, Version: version,
		Image: repo, ImageDigest: digest, Description: desc, Source: "live",
	}
}

// Build 은 단일 데이터셋(items)을 게이트→정렬→3 표현으로 투영한다.
// rejected = ImageDigest 빈값으로 게시거부된 항목명(kind/name).
func Build(items []catalog.Item) (Response, []string) {
	kept, rejected := catalog.Gate(items)
	catalog.Sort(kept)
	resp := Response{
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
