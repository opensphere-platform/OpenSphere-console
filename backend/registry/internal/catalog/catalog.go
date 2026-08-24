// Package catalog defines the public, read-only Registry & Catalog projection.
package catalog

import "sort"

const Schema = "opensphere.registry-catalog/v1"

type Rejected struct {
	Kind    string `json:"kind"`
	ID      string `json:"id"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type SourceStatus struct {
	Ready           bool   `json:"ready"`
	Count           int    `json:"count"`
	ResourceVersion string `json:"resourceVersion,omitempty"`
	Reason          string `json:"reason,omitempty"`
}

// Object is the stable, metadata-free projection of a Catalog CR.
type Object struct {
	ID        string                 `json:"id"`
	Lifecycle string                 `json:"lifecycle,omitempty"`
	Spec      map[string]interface{} `json:"spec"`
}

type Projection struct {
	ModuleDescriptors []Object `json:"moduleDescriptors"`
}

func EmptyProjection() Projection {
	return Projection{ModuleDescriptors: []Object{}}
}

func SortObjects(items []Object) {
	sort.SliceStable(items, func(i, j int) bool { return items[i].ID < items[j].ID })
}

func SortRejected(items []Rejected) {
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Kind != items[j].Kind {
			return items[i].Kind < items[j].Kind
		}
		if items[i].ID != items[j].ID {
			return items[i].ID < items[j].ID
		}
		return items[i].Code < items[j].Code
	})
}
