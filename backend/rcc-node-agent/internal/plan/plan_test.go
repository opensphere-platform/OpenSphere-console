package plan

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)

func self() Identity { return Identity{ControlCenterID: "cc2", HostID: "node-a"} }

// digestFor computes the canonical digest the agent will demand, so fixtures
// stay valid as the canonical form evolves.
func digestFor(t *testing.T, doc map[string]any) (string, error) {
	t.Helper()
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var p Plan
	if err := json.Unmarshal(raw, &p); err != nil {
		return "", err
	}
	return p.CanonicalContentDigest()
}

// placeholderDigest marks a fixture whose digest should be computed for it. A
// case that sets its own digest, or that deliberately breaks the parameters, is
// left untouched so the rejection under test is the one that fires.
const placeholderDigest = "sha256:" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func signedPlan(t *testing.T, doc map[string]any) []byte {
	t.Helper()
	if doc["contentDigest"] == placeholderDigest {
		if digest, err := digestFor(t, doc); err == nil {
			doc["contentDigest"] = digest
		}
	}
	return encode(t, doc)
}

func validPlan() map[string]any {
	return map[string]any{
		"schemaVersion":   SchemaVersion,
		"operationId":     "2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f",
		"attempt":         1,
		"controlCenterId": "cc2",
		"hostId":          "node-a",
		"operation":       OpJournalQuery,
		"contentDigest":   placeholderDigest,
		"issuedAt":        now.Add(-time.Minute),
		"notBefore":       now.Add(-time.Minute),
		"expiresAt":       now.Add(10 * time.Minute),
		"leaseExpiresAt":  now.Add(5 * time.Minute),
		"journal":         map[string]any{"units": []string{"chronyd.service"}, "lines": 50},
	}
}

func encode(t *testing.T, doc map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

func TestValidPlanParses(t *testing.T) {
	p, err := Parse(signedPlan(t, validPlan()), self(), now)
	if err != nil {
		t.Fatalf("valid plan rejected: %v", err)
	}
	if p.Operation != OpJournalQuery || p.Journal == nil {
		t.Fatalf("unexpected parse result: %#v", p)
	}
}

func TestSSHBanPlansBindOneCanonicalAddressAndReviewedState(t *testing.T) {
	doc := validPlan()
	doc["operation"] = OpSSHBan
	delete(doc, "journal")
	doc["sshBan"] = map[string]any{
		"jail": "sshd", "address": "203.0.113.24", "expectedBanned": false,
	}
	p, err := Parse(signedPlan(t, doc), self(), now)
	if err != nil {
		t.Fatalf("valid SSH ban plan rejected: %v", err)
	}
	if p.SSHBan == nil || p.SSHBan.Address != "203.0.113.24" {
		t.Fatalf("unexpected plan: %#v", p)
	}

	for _, address := range []string{"203.0.113.0/24", "127.0.0.1", "2001:0db8::1", "not-an-ip"} {
		bad := validPlan()
		bad["operation"] = OpSSHBan
		delete(bad, "journal")
		bad["sshBan"] = map[string]any{
			"jail": "sshd", "address": address, "expectedBanned": false,
		}
		if _, err := Parse(signedPlan(t, bad), self(), now); err == nil {
			t.Fatalf("SSH ban target %q was accepted", address)
		}
	}
}

func TestSSHProtectionPlanBindsFixedProfileVersionAndProtectedAddresses(t *testing.T) {
	doc := validPlan()
	doc["operation"] = OpSSHProtectionEnable
	delete(doc, "journal")
	doc["sshProtection"] = map[string]any{
		"provider":              "fail2ban",
		"jail":                  "sshd",
		"profile":               SSHProtectionProfile,
		"packageVersion":        "1.0.2-3ubuntu0.1",
		"expectedProfileDigest": "",
		"expectedInstalled":     false,
		"expectedActive":        false,
		"protectedAddresses":    []string{"2001:db8::10", "203.0.113.10"},
	}
	p, err := Parse(signedPlan(t, doc), self(), now)
	if err != nil {
		t.Fatalf("valid SSH protection plan rejected: %v", err)
	}
	if p.SSHProtection == nil || p.SSHProtection.Profile != SSHProtectionProfile {
		t.Fatalf("unexpected plan: %#v", p)
	}

	for name, mutate := range map[string]func(map[string]any){
		"arbitrary profile": func(block map[string]any) { block["profile"] = "custom" },
		"unpinned version":  func(block map[string]any) { block["packageVersion"] = "latest" },
		"no protected address": func(block map[string]any) {
			block["protectedAddresses"] = []string{}
		},
		"unsorted addresses": func(block map[string]any) {
			block["protectedAddresses"] = []string{"203.0.113.10", "2001:db8::10"}
		},
		"malformed profile digest": func(block map[string]any) {
			block["expectedProfileDigest"] = "sha256:not-a-digest"
		},
	} {
		t.Run(name, func(t *testing.T) {
			bad := validPlan()
			bad["operation"] = OpSSHProtectionEnable
			delete(bad, "journal")
			block := map[string]any{
				"provider":              "fail2ban",
				"jail":                  "sshd",
				"profile":               SSHProtectionProfile,
				"packageVersion":        "1.0.2-3ubuntu0.1",
				"expectedProfileDigest": "",
				"expectedInstalled":     false,
				"expectedActive":        false,
				"protectedAddresses":    []string{"2001:db8::10", "203.0.113.10"},
			}
			mutate(block)
			bad["sshProtection"] = block
			if _, err := Parse(signedPlan(t, bad), self(), now); err == nil {
				t.Fatal("invalid SSH protection plan was accepted")
			}
		})
	}
}

// Each case is a distinct way a hostile or buggy control center could try to
// make the agent do something it must not.
func TestPlanRejections(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
		expect string
	}{
		{"wrong schema version", func(d map[string]any) { d["schemaVersion"] = "rcc.host.plan/v2" }, "unsupported plan schema"},
		{"unknown operation", func(d map[string]any) {
			d["operation"] = "shell.exec"
			delete(d, "journal")
			d["service"] = map[string]any{"unit": "x.service"}
		}, "unknown operation"},
		{"plan for another host", func(d map[string]any) { d["hostId"] = "node-b" }, "not this host"},
		{"plan for another control center", func(d map[string]any) { d["controlCenterId"] = "cc3" }, "not this host"},
		{"expired plan", func(d map[string]any) {
			// Inside the lifetime cap, but entirely in the past.
			d["issuedAt"] = now.Add(-2 * time.Hour)
			d["notBefore"] = now.Add(-2 * time.Hour)
			d["expiresAt"] = now.Add(-100 * time.Minute)
			d["leaseExpiresAt"] = now.Add(-110 * time.Minute)
		}, "expired"},
		{"not yet valid", func(d map[string]any) {
			// Inside the lifetime cap, but entirely in the future.
			d["notBefore"] = now.Add(2 * time.Hour)
			d["expiresAt"] = now.Add(2*time.Hour + 10*time.Minute)
			d["leaseExpiresAt"] = now.Add(2*time.Hour + 5*time.Minute)
		}, "not valid yet"},
		{"issued after it becomes valid", func(d map[string]any) { d["issuedAt"] = now.Add(time.Hour) }, "issued after it becomes valid"},
		{"lifetime too long", func(d map[string]any) {
			d["notBefore"] = now.Add(-time.Minute)
			d["expiresAt"] = now.Add(10 * time.Hour)
		}, "lifetime exceeds"},
		{"lease outlives the plan", func(d map[string]any) { d["leaseExpiresAt"] = now.Add(2 * time.Hour) }, "lease outlives"},
		{"lease expires before the plan starts", func(d map[string]any) { d["leaseExpiresAt"] = now.Add(-2 * time.Minute) }, "lease expires before"},
		{"attempt zero", func(d map[string]any) { d["attempt"] = 0 }, "attempt out of range"},
		{"malformed operation id", func(d map[string]any) { d["operationId"] = "not-a-uuid" }, "not a uuid"},
		{"malformed digest", func(d map[string]any) { d["contentDigest"] = "md5:abc" }, "contentDigest is malformed"},
		{"unknown field", func(d map[string]any) { d["extraPrivilege"] = true }, "unknown field"},
		{"two argument blocks", func(d map[string]any) { d["service"] = map[string]any{"unit": "a.service"} }, "exactly one argument block"},
		{"no argument block", func(d map[string]any) { delete(d, "journal") }, "exactly one argument block"},
		{"too many units", func(d map[string]any) {
			units := make([]string, MaxJournalUnits+1)
			for i := range units {
				units[i] = "a.service"
			}
			d["journal"] = map[string]any{"units": units}
		}, "at most"},
		{"unit name injection", func(d map[string]any) {
			d["journal"] = map[string]any{"units": []string{"a.service; rm -rf /"}}
		}, "not a valid systemd unit"},
		{"unit leading dash", func(d map[string]any) {
			d["journal"] = map[string]any{"units": []string{"-x.service"}}
		}, "not a valid systemd unit"},
		{"unit backslash", func(d map[string]any) {
			d["journal"] = map[string]any{"units": []string{"a\\b.service"}}
		}, "not a valid systemd unit"},
		{"unit colon", func(d map[string]any) {
			d["journal"] = map[string]any{"units": []string{"a:b.service"}}
		}, "not a valid systemd unit"},
		{"unit path traversal", func(d map[string]any) {
			d["journal"] = map[string]any{"units": []string{"../../etc/passwd.service"}}
		}, "not a valid systemd unit"},
		{"unit flag injection", func(d map[string]any) {
			d["journal"] = map[string]any{"units": []string{"--output=cat"}}
		}, "not a valid systemd unit"},
		{"bad priority", func(d map[string]any) {
			d["journal"] = map[string]any{"priority": "; reboot"}
		}, "not a journald priority"},
		{"bad since spec", func(d map[string]any) {
			d["journal"] = map[string]any{"since": "$(reboot)"}
		}, "not an accepted time specification"},
		{"lines over bound", func(d map[string]any) {
			d["journal"] = map[string]any{"lines": MaxJournalLines + 1}
		}, "lines must be"},
		{"bytes over bound", func(d map[string]any) {
			d["journal"] = map[string]any{"maxBytes": MaxJournalBytes + 1}
		}, "maxBytes must be"},
		{"restart of a non-service unit", func(d map[string]any) {
			d["operation"] = OpServiceRestart
			delete(d, "journal")
			d["service"] = map[string]any{"unit": "sshd.socket"}
		}, "only .service units"},
		{"reboot without confirmed drain", func(d map[string]any) {
			d["operation"] = OpHostReboot
			delete(d, "journal")
			d["reboot"] = map[string]any{"drainConfirmed": false, "deadlineSeconds": 300}
		}, "confirmed Kubernetes drain"},
		{"reboot deadline too short", func(d map[string]any) {
			d["operation"] = OpHostReboot
			delete(d, "journal")
			d["reboot"] = map[string]any{"drainConfirmed": true, "deadlineSeconds": 1}
		}, "deadline must be"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc := validPlan()
			tc.mutate(doc)
			_, err := Parse(signedPlan(t, doc), self(), now)
			if err == nil {
				t.Fatalf("expected rejection for %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.expect) {
				t.Fatalf("expected error containing %q, got %v", tc.expect, err)
			}
		})
	}
}

func TestOversizedPlanRejected(t *testing.T) {
	doc := validPlan()
	doc["journal"] = map[string]any{"cursor": strings.Repeat("a", 400)}
	raw := encode(t, doc)
	padded := append(raw, make([]byte, MaxPlanBytes)...)
	if _, err := Parse(padded, self(), now); err == nil {
		t.Fatal("oversized plan must be refused")
	}
}

func TestEmptyAndTrailingContentRejected(t *testing.T) {
	if _, err := Parse(nil, self(), now); err == nil {
		t.Fatal("empty plan must be refused")
	}
	doubled := append(encode(t, validPlan()), encode(t, validPlan())...)
	if _, err := Parse(doubled, self(), now); err == nil {
		t.Fatal("two documents in one body must be refused")
	}
}

func TestJournalDefaultsStayBounded(t *testing.T) {
	args := &JournalArgs{}
	if args.EffectiveLines() != DefaultJournalLines {
		t.Fatalf("default lines = %d", args.EffectiveLines())
	}
	if args.EffectiveMaxBytes() != MaxJournalBytes {
		t.Fatalf("default maxBytes = %d", args.EffectiveMaxBytes())
	}
	over := &JournalArgs{Lines: 1 << 20, MaxBytes: 1 << 30}
	if over.EffectiveLines() > MaxJournalLines || over.EffectiveMaxBytes() > MaxJournalBytes {
		t.Fatal("effective bounds must clamp")
	}
}

func TestReceiptValidation(t *testing.T) {
	good := Receipt{
		SchemaVersion:   ReceiptSchemaVersion,
		OperationID:     "2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f",
		Attempt:         1,
		ControlCenterID: "cc2",
		HostID:          "node-a",
		Operation:       OpJournalQuery,
		ContentDigest:   "sha256:" + strings.Repeat("b", 64),
		Outcome:         OutcomeSucceeded,
		StartedAt:       now.Add(-time.Second),
		FinishedAt:      now,
		Evidence:        map[string]string{"lines": "10"},
	}
	if err := good.Validate(); err != nil {
		t.Fatalf("valid receipt rejected: %v", err)
	}
	for name, mutate := range map[string]func(*Receipt){
		"bad schema":            func(r *Receipt) { r.SchemaVersion = "x" },
		"bad id":                func(r *Receipt) { r.OperationID = "nope" },
		"bad outcome":           func(r *Receipt) { r.Outcome = "maybe" },
		"bad digest":            func(r *Receipt) { r.ContentDigest = "x" },
		"bad attempt":           func(r *Receipt) { r.Attempt = 0 },
		"attempt over bound":    func(r *Receipt) { r.Attempt = MaxAttempt + 1 },
		"bad identity":          func(r *Receipt) { r.HostID = "NODE-A" },
		"unknown operation":     func(r *Receipt) { r.Operation = "shell.exec" },
		"missing timestamps":    func(r *Receipt) { r.StartedAt = time.Time{} },
		"finished before start": func(r *Receipt) { r.FinishedAt = r.StartedAt.Add(-time.Hour) },
		"oversized message":     func(r *Receipt) { r.Message = strings.Repeat("m", MaxReceiptMessage+1) },
		"oversized output":      func(r *Receipt) { r.Output = strings.Repeat("o", MaxReceiptOutput+1) },
		"control chars":         func(r *Receipt) { r.Message = "bad\x00value" },
		"too much evidence": func(r *Receipt) {
			r.Evidence = map[string]string{}
			for i := 0; i <= MaxEvidenceEntries; i++ {
				r.Evidence[fmt.Sprintf("k%d", i)] = "v"
			}
		},
		"oversized evidence key":   func(r *Receipt) { r.Evidence = map[string]string{strings.Repeat("k", MaxEvidenceKeyChars+1): "v"} },
		"oversized evidence value": func(r *Receipt) { r.Evidence = map[string]string{"k": strings.Repeat("v", MaxEvidenceValueChars+1)} },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := good
			mutate(&candidate)
			if err := candidate.Validate(); err == nil {
				t.Fatalf("%s must be refused", name)
			}
		})
	}
}

func TestTrailingContentIsRejectedInEveryForm(t *testing.T) {
	base := string(signedPlan(t, validPlan()))
	// decoder.More() does not see a trailing top-level value; only requiring
	// io.EOF from a second Decode does.
	for name, suffix := range map[string]string{
		"second object": `{"operation":"host.reboot"}`,
		"scalar":        `123`,
		"string":        `"extra"`,
		"array":         `[1,2]`,
		"null":          `null`,
		"garbage":       `not-json`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(base+suffix), self(), now); err == nil {
				t.Fatalf("trailing %s must be refused", name)
			}
		})
	}
	// Trailing whitespace alone is legitimate and must still parse.
	for _, ws := range []string{" ", "\n", "\t\r\n  "} {
		if _, err := Parse([]byte(base+ws), self(), now); err != nil {
			t.Fatalf("trailing whitespace must be accepted, got %v", err)
		}
	}
}

func TestContentDigestMustMatchTheParametersCarried(t *testing.T) {
	// A control center that swaps the unit after approval, keeping a
	// well-formed digest, must be refused.
	doc := validPlan()
	doc["operation"] = OpServiceRestart
	delete(doc, "journal")
	doc["service"] = map[string]any{"unit": "chronyd.service"}
	honest := signedPlan(t, doc)
	if _, err := Parse(honest, self(), now); err != nil {
		t.Fatalf("honest plan rejected: %v", err)
	}

	tampered := validPlan()
	tampered["operation"] = OpServiceRestart
	delete(tampered, "journal")
	tampered["service"] = map[string]any{"unit": "chronyd.service"}
	tampered["contentDigest"] = placeholderDigest // valid shape, wrong value
	if _, err := Parse(encode(t, tampered), self(), now); err == nil {
		t.Fatal("a plan whose digest does not match its parameters must be refused")
	}

	// Swapping the unit while keeping the honest digest must also fail.
	var swapped map[string]any
	if err := json.Unmarshal(honest, &swapped); err != nil {
		t.Fatal(err)
	}
	swapped["service"] = map[string]any{"unit": "sshd.service"}
	if _, err := Parse(encode(t, swapped), self(), now); err == nil {
		t.Fatal("substituting parameters under an approved digest must be refused")
	}
}

func TestCanonicalDigestIgnoresTransportOnlyFields(t *testing.T) {
	// maxBytes is added by the backend for transport and is not part of what an
	// approver reviewed, so it must not change the digest.
	a := validPlan()
	a["journal"] = map[string]any{"units": []string{"chronyd.service"}, "lines": 50, "maxBytes": 0}
	b := validPlan()
	b["journal"] = map[string]any{"units": []string{"chronyd.service"}, "lines": 50, "maxBytes": 4096}

	digestA, err := digestFor(t, a)
	if err != nil {
		t.Fatal(err)
	}
	digestB, err := digestFor(t, b)
	if err != nil {
		t.Fatal(err)
	}
	if digestA != digestB {
		t.Fatalf("maxBytes must not affect the approved digest: %s vs %s", digestA, digestB)
	}
}

func TestConservativeUnitGrammar(t *testing.T) {
	accepted := []string{
		"chronyd.service", "sshd.service", "getty@tty1.service",
		"my-app.service", "my_app.service", "a.b.c.service", "x1.socket",
	}
	for _, unit := range accepted {
		if !unitRe.MatchString(unit) {
			t.Errorf("%q should be a valid unit name", unit)
		}
	}
	rejected := []string{
		"-x.service",          // leading dash could be read as a flag
		"--all.service",       //
		"a\\b.service",        // backslash escape
		"a:b.service",         // colon
		"../../etc/x.service", // traversal
		"a/b.service",         // path separator
		".hidden.service",     // leading dot
		"a b.service",         // whitespace
		"a\tb.service",        //
		"chronyd.service\n",   // trailing newline
		"chronyd",             // no unit type
		"chronyd.exe",         // unknown unit type
		"@x.service",          // instance with no template
		"",                    //
	}
	for _, unit := range rejected {
		if unitRe.MatchString(unit) {
			t.Errorf("%q must be refused as a unit name", unit)
		}
	}
}
