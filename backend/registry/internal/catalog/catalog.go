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

type Owner struct {
	ID           string `json:"id"`
	LifecycleAPI string `json:"lifecycleApi,omitempty"`
}

type Source struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type Release struct {
	ArtifactVersion      string `json:"artifactVersion,omitempty"`
	CompatibilityVersion string `json:"compatibilityVersion,omitempty"`
	Channel              string `json:"channel,omitempty"`
	Version              string `json:"version,omitempty"`
	ImageDigest          string `json:"imageDigest,omitempty"`
}

type Installation struct {
	Mode     string `json:"mode"`
	Eligible bool   `json:"eligible"`
}

type Evidence struct {
	ObservedGeneration int64  `json:"observedGeneration"`
	SourceRevision     string `json:"sourceRevision"`
}

// Descriptor is the only cross-consumer Registry read model. It deliberately
// excludes instance, capacity, credential and runtime lifecycle state.
type Descriptor struct {
	ID           string       `json:"id"`
	Class        string       `json:"class"`
	DisplayName  string       `json:"displayName"`
	Domain       string       `json:"domain"`
	Owner        Owner        `json:"owner"`
	Source       Source       `json:"source"`
	Release      Release      `json:"release"`
	Capabilities []string     `json:"capabilities"`
	Installation Installation `json:"installation"`
	Evidence     Evidence     `json:"evidence"`
}

type ClassCoverage struct {
	Expected  int `json:"expected"`
	Published int `json:"published"`
	Rejected  int `json:"rejected"`
	Missing   int `json:"missing"`
}

type CoverageGap struct {
	ID      string `json:"id"`
	Class   string `json:"class"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Coverage struct {
	Expected  int                      `json:"expected"`
	Published int                      `json:"published"`
	Rejected  int                      `json:"rejected"`
	Missing   []CoverageGap            `json:"missing"`
	ByClass   map[string]ClassCoverage `json:"byClass"`
}

type Inventory struct {
	Descriptors []Descriptor `json:"descriptors"`
	Coverage    Coverage     `json:"coverage"`
}

// Object is the stable, metadata-free projection of a Catalog CR.
type Object struct {
	ID   string                 `json:"id"`
	Spec map[string]interface{} `json:"spec"`
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

func SortDescriptors(items []Descriptor) {
	sort.SliceStable(items, func(i, j int) bool { return items[i].ID < items[j].ID })
}
