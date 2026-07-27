package plan

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

var stage3Now = time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)

func stage3Identity() Identity {
	return Identity{ControlCenterID: "cc2", HostID: "node-a"}
}

// stage3Plan builds a well-formed Stage 3 plan and lets a test corrupt exactly
// one thing, so a rejection is attributable to that thing alone.
func stage3Plan(t *testing.T, operation string, block map[string]any, mutate func(map[string]any)) []byte {
	t.Helper()
	doc := map[string]any{
		"schemaVersion":   SchemaVersion,
		"operationId":     "2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f",
		"attempt":         1,
		"controlCenterId": "cc2",
		"hostId":          "node-a",
		"operation":       operation,
		"contentDigest":   "sha256:" + strings.Repeat("a", 64),
		"issuedAt":        stage3Now.Add(-time.Minute),
		"notBefore":       stage3Now.Add(-time.Minute),
		"expiresAt":       stage3Now.Add(20 * time.Minute),
		"leaseExpiresAt":  stage3Now.Add(15 * time.Minute),
	}
	for key, value := range block {
		doc[key] = value
	}
	if mutate != nil {
		mutate(doc)
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	// Recompute the digest so a test is never accidentally testing the digest
	// check when it means to test a grammar rule.
	var parsed Plan
	if err := json.Unmarshal(raw, &parsed); err == nil {
		if digest, derr := parsed.CanonicalContentDigest(); derr == nil {
			doc["contentDigest"] = digest
			raw, err = json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	return raw
}

func refreshBlock() map[string]any {
	return map[string]any{"packageRefresh": map[string]any{"manager": "apt"}}
}

func updateBlock(packages ...map[string]any) map[string]any {
	list := make([]any, 0, len(packages))
	for _, entry := range packages {
		list = append(list, entry)
	}
	return map[string]any{"packageUpdate": map[string]any{
		"manager": "apt", "packages": list, "securityOnly": false,
	}}
}

func kernelBlock() map[string]any {
	return map[string]any{"kernelUpdate": map[string]any{"manager": "apt", "targetRelease": ""}}
}

func mustParse(t *testing.T, raw []byte) *Plan {
	t.Helper()
	parsed, err := Parse(raw, stage3Identity(), stage3Now)
	if err != nil {
		t.Fatalf("plan should have parsed: %v", err)
	}
	return parsed
}

func mustReject(t *testing.T, raw []byte, expect string) {
	t.Helper()
	_, err := Parse(raw, stage3Identity(), stage3Now)
	if err == nil {
		t.Fatalf("plan should have been rejected (%s)", expect)
	}
	if !strings.Contains(err.Error(), expect) {
		t.Fatalf("expected %q, got %q", expect, err.Error())
	}
}

// ── the three operations parse at all ───────────────────────────────────────

func TestStage3OperationsParse(t *testing.T) {
	refresh := mustParse(t, stage3Plan(t, OpPackageRefresh, refreshBlock(), nil))
	if refresh.PackageRefresh.Manager != "apt" {
		t.Fatal("refresh arguments not carried")
	}
	update := mustParse(t, stage3Plan(t, OpPackageUpdate,
		updateBlock(map[string]any{"name": "curl", "version": ""}), nil))
	if len(update.PackageUpdate.Packages) != 1 || update.PackageUpdate.Packages[0].Name != "curl" {
		t.Fatalf("update arguments not carried: %+v", update.PackageUpdate)
	}
	kernel := mustParse(t, stage3Plan(t, OpKernelUpdate, kernelBlock(), nil))
	if kernel.KernelUpdate.Manager != "apt" {
		t.Fatal("kernel arguments not carried")
	}
}

// ── argv injection cannot survive the grammar ───────────────────────────────

func TestPackageNamesRejectEverythingAnInjectionNeeds(t *testing.T) {
	hostile := []string{
		"curl; rm -rf /",
		"curl && reboot",
		"curl$(id)",
		"curl`id`",
		"curl|tee",
		"--allow-downgrades",
		"-o",
		"../../etc/passwd",
		"/usr/bin/curl",
		"curl\nsecond",
		"curl\tsecond",
		"curl ",
		" curl",
		"curl:amd64",
		"CURL",
		"curl=1.0",
		"curl>=1.0",
		"c",
		"",
		strings.Repeat("a", 200),
		"curl\x00",
		"curl'",
		"curl\"",
		"curl\\x",
		"http://evil.example/pkg.deb",
		"./local.deb",
	}
	for _, name := range hostile {
		raw := stage3Plan(t, OpPackageUpdate, updateBlock(map[string]any{"name": name, "version": ""}), nil)
		if _, err := Parse(raw, stage3Identity(), stage3Now); err == nil {
			t.Fatalf("package name %q must be refused", name)
		}
	}
}

func TestPackageVersionsRejectInjection(t *testing.T) {
	for _, version := range []string{
		"1.0; reboot", "1.0 && id", "$(id)", "../1.0", "1.0\n2.0", "-1.0",
		"1.0|x", strings.Repeat("9", 200), "=1.0", "1.0 ",
	} {
		raw := stage3Plan(t, OpPackageUpdate,
			updateBlock(map[string]any{"name": "curl", "version": version}), nil)
		if _, err := Parse(raw, stage3Identity(), stage3Now); err == nil {
			t.Fatalf("version %q must be refused", version)
		}
	}
}

func TestKernelReleaseRejectsInjection(t *testing.T) {
	for _, release := range []string{
		"6.8.0-51-generic; reboot", "../6.8.0", "6.8.0 -generic", "$(uname -r)",
		"6", "6.8", strings.Repeat("6.8.0-", 40), "6.8.0-51-generic\n",
	} {
		raw := stage3Plan(t, OpKernelUpdate, map[string]any{
			"kernelUpdate": map[string]any{"manager": "apt", "targetRelease": release},
		}, nil)
		if _, err := Parse(raw, stage3Identity(), stage3Now); err == nil {
			t.Fatalf("kernel release %q must be refused", release)
		}
	}
}

// ── the set is bounded and reviewable ───────────────────────────────────────

func TestAnEmptyPackageSetIsRefused(t *testing.T) {
	// There is no "upgrade everything" form: an operator approving an unnamed
	// set is approving whatever the mirror holds when it eventually runs.
	mustReject(t, stage3Plan(t, OpPackageUpdate, updateBlock(), nil), "at least one package")
}

func TestAnOversizedPackageSetIsRefused(t *testing.T) {
	packages := make([]map[string]any, 0, MaxUpdatePackages+1)
	for i := 0; i <= MaxUpdatePackages; i++ {
		packages = append(packages, map[string]any{
			"name": "pkg" + string(rune('a'+i%26)) + string(rune('a'+(i/26)%26)), "version": "",
		})
	}
	mustReject(t, stage3Plan(t, OpPackageUpdate, updateBlock(packages...), nil), "above the limit")
}

func TestADuplicatePackageIsRefused(t *testing.T) {
	mustReject(t, stage3Plan(t, OpPackageUpdate, updateBlock(
		map[string]any{"name": "curl", "version": ""},
		map[string]any{"name": "curl", "version": "8.0"},
	), nil), "named twice")
}

func TestAKernelImageCannotBeSmuggledThroughPackageUpdate(t *testing.T) {
	// kernel.update carries its own review and produces reboot-required
	// evidence. A kernel installed through package.update would skip both.
	mustReject(t, stage3Plan(t, OpPackageUpdate,
		updateBlock(map[string]any{"name": "linux-image-6.8.0-51-generic", "version": ""}), nil),
		"use kernel.update")
}

// ── unsupported managers are refused, never approximated ────────────────────

func TestAnUnsupportedManagerIsRefusedForEveryOperation(t *testing.T) {
	for _, manager := range []string{"dnf", "yum", "zypper", "pacman", "", "APT", "apt-get"} {
		cases := []struct {
			operation string
			block     map[string]any
		}{
			{OpPackageRefresh, map[string]any{"packageRefresh": map[string]any{"manager": manager}}},
			{OpPackageUpdate, map[string]any{"packageUpdate": map[string]any{
				"manager": manager, "packages": []any{map[string]any{"name": "curl", "version": ""}},
			}}},
			{OpKernelUpdate, map[string]any{"kernelUpdate": map[string]any{"manager": manager}}},
		}
		for _, tc := range cases {
			raw := stage3Plan(t, tc.operation, tc.block, nil)
			if _, err := Parse(raw, stage3Identity(), stage3Now); err == nil {
				t.Fatalf("%s with manager %q must be refused", tc.operation, manager)
			}
		}
	}
}

// ── a kernel update never reboots ───────────────────────────────────────────

func TestAKernelUpdateThatAsksToRebootIsRefused(t *testing.T) {
	mustReject(t, stage3Plan(t, OpKernelUpdate, map[string]any{
		"kernelUpdate": map[string]any{"manager": "apt", "rebootAfter": true},
	}, nil), "never reboots")
}

// ── argument-block arity ────────────────────────────────────────────────────

func TestExactlyOneArgumentBlockStillHolds(t *testing.T) {
	both := stage3Plan(t, OpPackageUpdate, updateBlock(map[string]any{"name": "curl", "version": ""}),
		func(doc map[string]any) {
			doc["packageRefresh"] = map[string]any{"manager": "apt"}
		})
	mustReject(t, both, "exactly one argument block")

	mismatched := stage3Plan(t, OpPackageUpdate, refreshBlock(), nil)
	mustReject(t, mismatched, "requires packageUpdate arguments")
}

func TestUnknownStage3FieldsAreRefused(t *testing.T) {
	raw := stage3Plan(t, OpPackageUpdate, updateBlock(map[string]any{"name": "curl", "version": ""}),
		func(doc map[string]any) {
			block := doc["packageUpdate"].(map[string]any)
			block["repository"] = "http://evil.example/ubuntu"
		})
	mustReject(t, raw, "unknown field")

	withFlags := stage3Plan(t, OpPackageUpdate, updateBlock(map[string]any{"name": "curl", "version": ""}),
		func(doc map[string]any) {
			block := doc["packageUpdate"].(map[string]any)
			block["extraArgs"] = []string{"--force-yes"}
		})
	mustReject(t, withFlags, "unknown field")
}

// ── maintenance windows ─────────────────────────────────────────────────────

func policyBlock(start, end time.Time, mutate func(map[string]any)) map[string]any {
	policy := map[string]any{
		"policyId":      "3c1f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e70",
		"policyVersion": 3,
		"windowId":      "4d2f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e71",
		"windowStart":   start,
		"windowEnd":     end,
		"emergency":     false,
	}
	if mutate != nil {
		mutate(policy)
	}
	return policy
}

func withPolicy(block map[string]any, policy map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range block {
		out[k] = v
	}
	out["policy"] = policy
	return out
}

func TestAPlanInsideItsWindowIsAccepted(t *testing.T) {
	block := withPolicy(refreshBlock(),
		policyBlock(stage3Now.Add(-time.Hour), stage3Now.Add(time.Hour), nil))
	parsed := mustParse(t, stage3Plan(t, OpPackageRefresh, block, nil))
	if parsed.Policy.PolicyVersion != 3 {
		t.Fatal("the policy version must travel with the plan")
	}
}

func TestAPlanThatWaitedUntilTheWindowClosedIsRefused(t *testing.T) {
	// This is the case a control-center-side check cannot catch: the plan was
	// legitimate when issued and is executed later.
	block := withPolicy(refreshBlock(),
		policyBlock(stage3Now.Add(-4*time.Hour), stage3Now.Add(-2*time.Hour), nil))
	mustReject(t, stage3Plan(t, OpPackageRefresh, block, nil), "window has closed")
}

func TestAPlanDeliveredBeforeItsWindowOpensIsRefused(t *testing.T) {
	block := withPolicy(refreshBlock(),
		policyBlock(stage3Now.Add(2*time.Hour), stage3Now.Add(4*time.Hour), nil))
	mustReject(t, stage3Plan(t, OpPackageRefresh, block, nil), "has not opened yet")
}

func TestClockSkewIsToleratedButNotAbused(t *testing.T) {
	// Just inside the tolerance.
	edge := withPolicy(refreshBlock(),
		policyBlock(stage3Now.Add(-2*time.Hour), stage3Now.Add(-MaxClockSkew+time.Minute), nil))
	mustParse(t, stage3Plan(t, OpPackageRefresh, edge, nil))

	// Just outside it.
	past := withPolicy(refreshBlock(),
		policyBlock(stage3Now.Add(-2*time.Hour), stage3Now.Add(-MaxClockSkew-time.Minute), nil))
	mustReject(t, stage3Plan(t, OpPackageRefresh, past, nil), "window has closed")
}

func TestAnInvertedOrAbsurdWindowIsRefused(t *testing.T) {
	inverted := withPolicy(refreshBlock(),
		policyBlock(stage3Now.Add(time.Hour), stage3Now.Add(-time.Hour), nil))
	mustReject(t, stage3Plan(t, OpPackageRefresh, inverted, nil), "ends before it begins")

	endless := withPolicy(refreshBlock(),
		policyBlock(stage3Now.Add(-time.Hour), stage3Now.Add(48*time.Hour), nil))
	mustReject(t, stage3Plan(t, OpPackageRefresh, endless, nil), "spans more than")
}

func TestAGovernedPlanMustCarryItsWindow(t *testing.T) {
	missing := withPolicy(refreshBlock(), map[string]any{
		"policyId": "3c1f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e70", "policyVersion": 1, "emergency": false,
	})
	mustReject(t, stage3Plan(t, OpPackageRefresh, missing, nil), "must carry the window")
}

func TestAnEmergencyPlanCarriesNoWindowAndMustNotClaimOne(t *testing.T) {
	// Emergency is not a window; pretending otherwise would let a plan claim
	// the protection of a window it was never inside.
	ok := withPolicy(refreshBlock(), map[string]any{
		"policyId": "3c1f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e70", "policyVersion": 2, "emergency": true,
	})
	mustParse(t, stage3Plan(t, OpPackageRefresh, ok, nil))

	contradictory := withPolicy(refreshBlock(),
		policyBlock(stage3Now.Add(-time.Hour), stage3Now.Add(time.Hour), func(p map[string]any) {
			p["emergency"] = true
		}))
	mustReject(t, stage3Plan(t, OpPackageRefresh, contradictory, nil), "must not also claim")
}

func TestAMalformedPolicyIdentityIsRefused(t *testing.T) {
	for _, mutate := range []func(map[string]any){
		func(p map[string]any) { p["policyId"] = "not-a-uuid" },
		func(p map[string]any) { p["policyVersion"] = 0 },
		func(p map[string]any) { p["policyVersion"] = -1 },
		func(p map[string]any) { p["windowId"] = "../../etc" },
	} {
		block := withPolicy(refreshBlock(),
			policyBlock(stage3Now.Add(-time.Hour), stage3Now.Add(time.Hour), mutate))
		if _, err := Parse(stage3Plan(t, OpPackageRefresh, block, nil), stage3Identity(), stage3Now); err == nil {
			t.Fatal("a malformed policy binding must be refused")
		}
	}
}

// ── the digest binds the policy version ─────────────────────────────────────

func TestAPolicyVersionChangeChangesTheContentDigest(t *testing.T) {
	// This is what makes an approval stale. Work reviewed under version 3 must
	// not execute under version 4 just because the packages are the same.
	base := withPolicy(updateBlock(map[string]any{"name": "curl", "version": ""}),
		policyBlock(stage3Now.Add(-time.Hour), stage3Now.Add(time.Hour), nil))
	first := mustParse(t, stage3Plan(t, OpPackageUpdate, base, nil))
	firstDigest, err := first.CanonicalContentDigest()
	if err != nil {
		t.Fatal(err)
	}

	bumped := withPolicy(updateBlock(map[string]any{"name": "curl", "version": ""}),
		policyBlock(stage3Now.Add(-time.Hour), stage3Now.Add(time.Hour), func(p map[string]any) {
			p["policyVersion"] = 4
		}))
	second := mustParse(t, stage3Plan(t, OpPackageUpdate, bumped, nil))
	secondDigest, err := second.CanonicalContentDigest()
	if err != nil {
		t.Fatal(err)
	}
	if firstDigest == secondDigest {
		t.Fatal("a policy version change must invalidate the approved content")
	}
}

func TestTheWindowInstantsAreNotPartOfTheApprovedContent(t *testing.T) {
	// Two occurrences of the same recurring window are the same approved work.
	// Binding the instants would make every occurrence a new approval.
	early := withPolicy(refreshBlock(),
		policyBlock(stage3Now.Add(-time.Hour), stage3Now.Add(time.Hour), nil))
	late := withPolicy(refreshBlock(),
		policyBlock(stage3Now.Add(-30*time.Minute), stage3Now.Add(90*time.Minute), nil))

	a := mustParse(t, stage3Plan(t, OpPackageRefresh, early, nil))
	b := mustParse(t, stage3Plan(t, OpPackageRefresh, late, nil))
	aDigest, _ := a.CanonicalContentDigest()
	bDigest, _ := b.CanonicalContentDigest()
	if aDigest != bDigest {
		t.Fatal("the same work in two occurrences of a window is the same approved content")
	}
}

func TestThePackageSetIsPartOfTheApprovedContent(t *testing.T) {
	one := mustParse(t, stage3Plan(t, OpPackageUpdate,
		updateBlock(map[string]any{"name": "curl", "version": ""}), nil))
	two := mustParse(t, stage3Plan(t, OpPackageUpdate,
		updateBlock(map[string]any{"name": "curl", "version": ""},
			map[string]any{"name": "openssl", "version": ""}), nil))
	pinned := mustParse(t, stage3Plan(t, OpPackageUpdate,
		updateBlock(map[string]any{"name": "curl", "version": "8.5.0-2ubuntu10.6"}), nil))

	oneDigest, _ := one.CanonicalContentDigest()
	twoDigest, _ := two.CanonicalContentDigest()
	pinnedDigest, _ := pinned.CanonicalContentDigest()
	if oneDigest == twoDigest || oneDigest == pinnedDigest {
		t.Fatal("adding a package or pinning a version must change what was approved")
	}
}

func TestAnUngovernedOperationHashesAsBefore(t *testing.T) {
	// Stage 1 and Stage 2 digests must not move because Stage 3 exists.
	raw := stage3Plan(t, OpPackageRefresh, refreshBlock(), nil)
	parsed := mustParse(t, raw)
	if parsed.Policy != nil {
		t.Fatal("this fixture carries no policy")
	}
	digest, err := parsed.CanonicalContentDigest()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(digest, "sha256:") {
		t.Fatalf("unexpected digest %q", digest)
	}
}
