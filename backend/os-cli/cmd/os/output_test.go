package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var sampleOutput = []byte(`[{"name":"alpha","enabled":true},{"name":"beta","enabled":false},{"name":"gamma","enabled":true}]`)

func TestYAMLAndTableRendering(t *testing.T) {
	var yaml bytes.Buffer
	if err := renderOutput(&yaml, sampleOutput, outputOptions{Format: "yaml", Limit: -1}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(yaml.String(), `name: "alpha"`) || !strings.Contains(yaml.String(), "enabled: true") {
		t.Fatalf("unexpected YAML: %s", yaml.String())
	}
	var table bytes.Buffer
	if err := renderOutput(&table, sampleOutput, outputOptions{Format: "table", Limit: -1}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(table.String(), "ENABLED\tNAME") || !strings.Contains(table.String(), "true\talpha") {
		t.Fatalf("unexpected table: %s", table.String())
	}
}

func TestQueryFiltering(t *testing.T) {
	var out bytes.Buffer
	if err := renderOutput(&out, sampleOutput, outputOptions{Format: "json", Query: "[?enabled].name", Limit: -1}); err != nil {
		t.Fatal(err)
	}
	var got []string
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "alpha,gamma" {
		t.Fatalf("query result=%v", got)
	}
}

func TestLimitAndAllSlicing(t *testing.T) {
	tests := []struct {
		name string
		opts outputOptions
		want int
	}{{"limit", outputOptions{Format: "json", Limit: 1}, 1}, {"all", outputOptions{Format: "json", Limit: 1, All: true}, 3}}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			if err := renderOutput(&out, sampleOutput, tc.opts); err != nil {
				t.Fatal(err)
			}
			var got []any
			if json.Unmarshal(out.Bytes(), &got) != nil || len(got) != tc.want {
				t.Fatalf("rows=%d want=%d: %s", len(got), tc.want, out.String())
			}
		})
	}
}

func TestConfigGetSetRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("OS_CONFIG", path)
	var out bytes.Buffer
	if err := configCommand([]string{"set", "consoleUrl", "https://console.example.test"}, &out); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := configCommand([]string{"get", "consoleUrl"}, &out); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != "https://console.example.test" {
		t.Fatalf("get=%q", out.String())
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(string(b)), "secret") || strings.Contains(strings.ToLower(string(b)), "token") {
		t.Fatalf("config exposed a secret field: %s", b)
	}
	if err := configCommand([]string{"set", "pat", "secret"}, &bytes.Buffer{}); err == nil {
		t.Fatal("secret/unknown key must be rejected")
	}
}

func TestCompletionContainsCommandsAndFlags(t *testing.T) {
	for _, shell := range []string{"bash", "zsh", "powershell"} {
		var out bytes.Buffer
		if err := completion([]string{shell}, &out); err != nil {
			t.Fatal(err)
		}
		for _, expected := range []string{"config", "completion", "registry", "--query", "--output"} {
			if !strings.Contains(out.String(), expected) {
				t.Fatalf("%s completion missing %q: %s", shell, expected, out.String())
			}
		}
	}
}
