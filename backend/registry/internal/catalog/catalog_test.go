package catalog

import "testing"

func TestEmptyProjectionPublishesArrays(t *testing.T) {
	p := EmptyProjection()
	if p.Capabilities == nil || p.Offerings == nil || p.Plans == nil || p.RuntimeCatalogs == nil || p.ModuleDescriptors == nil {
		t.Fatal("public catalog collections must be empty arrays, never null")
	}
}

func TestSortObjectsIsDeterministic(t *testing.T) {
	items := []Object{{ID: "z"}, {ID: "a"}}
	SortObjects(items)
	if items[0].ID != "a" || items[1].ID != "z" {
		t.Fatalf("unexpected order: %#v", items)
	}
}
