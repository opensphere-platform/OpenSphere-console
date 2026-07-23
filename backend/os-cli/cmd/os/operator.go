package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

type CLIError struct {
	Status  int
	Code    string
	Message string
	Hint    string
}

func (e *CLIError) Error() string {
	message := strings.TrimSpace(e.Message)
	if message == "" {
		message = "Console API 요청이 실패했습니다"
	}
	if e.Status > 0 {
		message = fmt.Sprintf("HTTP %d: %s", e.Status, message)
	}
	if e.Hint != "" {
		message += "\n조치: " + e.Hint
	}
	return message
}

func withHint(err error, hint string) error {
	var cliErr *CLIError
	if errors.As(err, &cliErr) {
		copy := *cliErr
		copy.Hint = hint
		return &copy
	}
	return &CLIError{Message: err.Error(), Hint: hint}
}

func retiredResourceError(resource, replacement string) error {
	return &CLIError{
		Status:  http.StatusGone,
		Code:    "RetiredResource",
		Message: resource + "는 폐기된 CBS/Backbone 모델이므로 다시 활성화하지 않습니다.",
		Hint:    replacement + " 명령으로 현행 Platform Control 권위를 조회하세요.",
	}
}

func exitCode(err error) int {
	var usageErr *UsageError
	if errors.As(err, &usageErr) {
		return 2
	}
	var cliErr *CLIError
	if errors.As(err, &cliErr) {
		switch cliErr.Status {
		case http.StatusUnauthorized:
			return 3
		case http.StatusForbidden:
			return 4
		case http.StatusNotFound, http.StatusGone:
			return 5
		case http.StatusConflict:
			return 6
		case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
			return 7
		}
	}
	return 1
}

func extractGlobalOptions(args []string) ([]string, string, error) {
	output := "json"
	clean := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		value := ""
		switch {
		case arg == "-o" || arg == "--output":
			if i+1 >= len(args) {
				return nil, "", usageError("사용법: -o|--output table|json|yaml")
			}
			value = args[i+1]
			i++
		case strings.HasPrefix(arg, "-o="):
			value = strings.TrimPrefix(arg, "-o=")
		case strings.HasPrefix(arg, "--output="):
			value = strings.TrimPrefix(arg, "--output=")
		default:
			clean = append(clean, arg)
			continue
		}
		output = strings.ToLower(strings.TrimSpace(value))
		if output != "json" && output != "yaml" && output != "table" {
			return nil, "", usageErrorf("unknown output %q; table, json, yaml 중 하나를 사용하세요", value)
		}
	}
	return clean, output, nil
}

func renderOutput(cfg Config, out io.Writer, raw []byte) error {
	format := strings.ToLower(strings.TrimSpace(cfg.Output))
	if format == "" || format == "json" {
		return pretty(out, raw)
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return fmt.Errorf("출력 데이터가 JSON이 아닙니다: %w", err)
	}
	switch format {
	case "yaml":
		return writeYAML(out, value, 0)
	case "table":
		return writeTableForCommand(out, value, cfg.Command)
	default:
		return fmt.Errorf("unknown output %q", format)
	}
}

func writeYAML(out io.Writer, value any, indent int) error {
	pad := strings.Repeat("  ", indent)
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			child := typed[key]
			if isScalar(child) {
				if _, err := fmt.Fprintf(out, "%s%s: %s\n", pad, yamlString(key), yamlScalar(child)); err != nil {
					return err
				}
			} else {
				if _, err := fmt.Fprintf(out, "%s%s:\n", pad, yamlString(key)); err != nil {
					return err
				}
				if err := writeYAML(out, child, indent+1); err != nil {
					return err
				}
			}
		}
	case []any:
		if len(typed) == 0 {
			_, err := fmt.Fprintln(out, pad+"[]")
			return err
		}
		for _, child := range typed {
			if isScalar(child) {
				if _, err := fmt.Fprintf(out, "%s- %s\n", pad, yamlScalar(child)); err != nil {
					return err
				}
			} else {
				if _, err := fmt.Fprintln(out, pad+"-"); err != nil {
					return err
				}
				if err := writeYAML(out, child, indent+1); err != nil {
					return err
				}
			}
		}
	default:
		_, err := fmt.Fprintln(out, pad+yamlScalar(typed))
		return err
	}
	return nil
}

func isScalar(value any) bool {
	switch value.(type) {
	case nil, bool, float64, string:
		return true
	default:
		return false
	}
}

func yamlString(value string) string {
	b, _ := json.Marshal(value)
	return string(b)
}

func yamlScalar(value any) string {
	if text, ok := value.(string); ok {
		return yamlString(text)
	}
	b, _ := json.Marshal(value)
	return string(b)
}

func tableRows(value any) ([]map[string]any, bool) {
	switch typed := value.(type) {
	case []any:
		rows := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if row, ok := item.(map[string]any); ok {
				rows = append(rows, row)
			} else {
				rows = append(rows, map[string]any{"value": item})
			}
		}
		return rows, true
	case map[string]any:
		for _, key := range []string{"items", "entities", "checks", "changes", "events", "devices", "pats", "plans", "contracts", "plugins", "capabilities", "templates"} {
			if list, ok := typed[key].([]any); ok && len(list) > 0 {
				return tableRows(list)
			}
		}
		rows := make([]map[string]any, 0, len(typed))
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			rows = append(rows, map[string]any{"field": key, "value": typed[key]})
		}
		return rows, true
	default:
		return []map[string]any{{"value": value}}, true
	}
}

func writeTable(out io.Writer, value any) error {
	rows, _ := tableRows(value)
	return writeTableRows(out, rows)
}

func writeTableRows(out io.Writer, rows []map[string]any) error {
	if len(rows) == 0 {
		_, err := fmt.Fprintln(out, "(항목 없음)")
		return err
	}
	return writeTableRowsWithColumns(out, rows, tableColumns(rows))
}

func writeTableRowsWithColumns(out io.Writer, rows []map[string]any, keys []string) error {
	if len(rows) == 0 {
		_, err := fmt.Fprintln(out, "(항목 없음)")
		return err
	}
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	for index, key := range keys {
		if index > 0 {
			_, _ = fmt.Fprint(w, "\t")
		}
		_, _ = fmt.Fprint(w, strings.ToUpper(key))
	}
	_, _ = fmt.Fprintln(w)
	for _, row := range rows {
		for index, key := range keys {
			if index > 0 {
				_, _ = fmt.Fprint(w, "\t")
			}
			_, _ = fmt.Fprint(w, tableCell(row[key]))
		}
		_, _ = fmt.Fprintln(w)
	}
	return w.Flush()
}

type tableColumn struct {
	Name  string
	Paths []string
}

var commandTableColumns = map[string][]tableColumn{
	"catalog": {
		{Name: "name", Paths: []string{"metadata.name", "name"}},
		{Name: "kind", Paths: []string{"kind", "metadata.kind"}},
		{Name: "namespace", Paths: []string{"metadata.namespace", "namespace"}},
		{Name: "owner", Paths: []string{"spec.owner", "owner"}},
		{Name: "lifecycle", Paths: []string{"spec.lifecycle", "lifecycle"}},
		{Name: "system", Paths: []string{"spec.system", "system"}},
	},
	"device": {
		{Name: "label", Paths: []string{"label", "name"}},
		{Name: "id", Paths: []string{"id", "deviceId"}},
		{Name: "status", Paths: []string{"status", "state"}},
		{Name: "fingerprint", Paths: []string{"fingerprint"}},
		{Name: "lastUsedAt", Paths: []string{"lastUsedAt", "last_used_at"}},
		{Name: "revokedAt", Paths: []string{"revokedAt", "revoked_at"}},
	},
	"doctor": {
		{Name: "name", Paths: []string{"name"}},
		{Name: "status", Paths: []string{"status"}},
		{Name: "critical", Paths: []string{"critical"}},
		{Name: "httpStatus", Paths: []string{"httpStatus"}},
		{Name: "latencyMs", Paths: []string{"latencyMs"}},
		{Name: "message", Paths: []string{"message"}},
		{Name: "hint", Paths: []string{"hint"}},
	},
	"health": {
		{Name: "name", Paths: []string{"name"}},
		{Name: "status", Paths: []string{"status"}},
		{Name: "critical", Paths: []string{"critical"}},
		{Name: "httpStatus", Paths: []string{"httpStatus"}},
		{Name: "latencyMs", Paths: []string{"latencyMs"}},
		{Name: "message", Paths: []string{"message"}},
		{Name: "hint", Paths: []string{"hint"}},
	},
	"operation": {
		{Name: "requestId", Paths: []string{"requestId", "request_id", "id"}},
		{Name: "status", Paths: []string{"status", "state", "phase"}},
		{Name: "action", Paths: []string{"action", "operation"}},
		{Name: "target", Paths: []string{"target", "resource"}},
		{Name: "actor", Paths: []string{"actor.email", "actor.username", "actor", "createdBy"}},
		{Name: "createdAt", Paths: []string{"createdAt", "created_at"}},
		{Name: "updatedAt", Paths: []string{"updatedAt", "updated_at"}},
	},
	"events": {
		{Name: "time", Paths: []string{"time", "timestamp", "createdAt", "created_at"}},
		{Name: "action", Paths: []string{"action", "type", "event"}},
		{Name: "actor", Paths: []string{"actor.email", "actor.username", "actor", "user"}},
		{Name: "target", Paths: []string{"target", "resource"}},
		{Name: "status", Paths: []string{"status", "result"}},
		{Name: "message", Paths: []string{"message", "reason"}},
	},
	"audit": {
		{Name: "time", Paths: []string{"time", "timestamp", "createdAt", "created_at"}},
		{Name: "action", Paths: []string{"action", "type", "event"}},
		{Name: "actor", Paths: []string{"actor.email", "actor.username", "actor", "user"}},
		{Name: "target", Paths: []string{"target", "resource"}},
		{Name: "status", Paths: []string{"status", "result"}},
		{Name: "message", Paths: []string{"message", "reason"}},
	},
	"plan": {
		{Name: "id", Paths: []string{"id", "planId"}},
		{Name: "status", Paths: []string{"status"}},
		{Name: "consumerId", Paths: []string{"consumerId"}},
		{Name: "action", Paths: []string{"action"}},
		{Name: "target", Paths: []string{"target"}},
		{Name: "createdAt", Paths: []string{"createdAt"}},
	},
}

func writeTableForCommand(out io.Writer, value any, command string) error {
	top := strings.Fields(strings.ToLower(command))
	if len(top) == 0 {
		return writeTable(out, value)
	}
	columns := commandTableColumns[top[0]]
	if len(columns) == 0 {
		return writeTable(out, value)
	}
	rows, _ := tableRows(value)
	projected := make([]map[string]any, 0, len(rows))
	columnNames := make([]string, 0, len(columns))
	for _, column := range columns {
		columnNames = append(columnNames, column.Name)
	}
	for _, row := range rows {
		item := make(map[string]any, len(columns))
		for _, column := range columns {
			for _, path := range column.Paths {
				if cell, ok := nestedJSONValue(row, path); ok {
					item[column.Name] = cell
					break
				}
			}
		}
		projected = append(projected, item)
	}
	return writeTableRowsWithColumns(out, projected, columnNames)
}

func tableColumns(rows []map[string]any) []string {
	seen := map[string]bool{}
	for _, row := range rows {
		for key := range row {
			seen[key] = true
		}
	}
	priority := []string{"name", "id", "requestId", "request_id", "status", "state", "ready", "component", "action", "target", "message", "checkedAt", "created_at", "updated_at", "field", "value"}
	keys := make([]string, 0, len(seen))
	for _, key := range priority {
		if seen[key] {
			keys = append(keys, key)
			delete(seen, key)
		}
	}
	rest := make([]string, 0, len(seen))
	for key := range seen {
		rest = append(rest, key)
	}
	sort.Strings(rest)
	keys = append(keys, rest...)
	if len(keys) > 12 {
		keys = keys[:12]
	}
	return keys
}

func tableCell(value any) string {
	if value == nil {
		return "—"
	}
	if text, ok := value.(string); ok {
		return strings.ReplaceAll(strings.ReplaceAll(text, "\r", " "), "\n", " ")
	}
	b, _ := json.Marshal(value)
	return string(b)
}

func platformStatus(cfg Config, out io.Writer) error {
	return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/admin/platform-readiness/status"), nil, out)
}

func describe(cfg Config, args []string, out io.Writer) error {
	if len(args) == 0 {
		return usageError("사용법: os describe platform|supabase|storage|gitea|observability|contracts|extensions")
	}
	switch strings.ToLower(args[0]) {
	case "platform", "control", "platform-control":
		return platformStatus(cfg, out)
	case "supabase", "data", "identity", "postgres", "storage", "rustfs":
		return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/identity/supabase/status"), nil, out)
	case "gitea", "change", "change-control":
		return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/platform/gitea/status"), nil, out)
	case "observability", "his":
		return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/admin/observability/status"), nil, out)
	case "contract", "contracts", "consumercontract", "consumercontracts":
		return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/platform/contracts"), nil, out)
	case "extension", "extensions":
		return jsonCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/admin/plugins/registrations"), nil, out)
	default:
		return usageErrorf("알 수 없는 component %q; platform, supabase, storage, gitea, observability, contracts, extensions 중 하나를 사용하세요", args[0])
	}
}

type doctorCheck struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	LatencyMS  int64  `json:"latencyMs"`
	Critical   bool   `json:"critical"`
	Message    string `json:"message,omitempty"`
	Hint       string `json:"hint,omitempty"`
}

func doctor(cfg Config, args []string, out io.Writer) error {
	flags := parseLongFlags(args)
	strict := flags["strict"] == "true"
	token, err := credentialToken(cfg)
	if err != nil {
		return withHint(err, "os login --console "+cfg.ConsoleURL+" 로 디바이스 신뢰를 다시 등록하세요.")
	}
	checks := []struct {
		name, endpoint, hint string
		critical             bool
	}{
		{"CLI identity", join(cfg.IdentityURL, "/introspect"), "CLI 장치 신뢰 또는 Supabase 인증 상태를 확인하세요.", true},
		{"Console Registry", cfg.RegistryURL, "Nginx /api/v1/registry 라우팅과 Registry JSON 계약을 확인하세요.", true},
		{"Platform Control", join(cfg.ConsoleURL, "/api/admin/platform-readiness/status"), "Platform Readiness backend와 현재 Binding을 확인하세요.", true},
		{"Supabase Data & Identity", join(cfg.ConsoleURL, "/api/identity/supabase/status"), "Supabase Auth/PostgREST/Storage 및 Console Backend를 확인하세요.", true},
		{"Gitea Change Control", join(cfg.ConsoleURL, "/api/platform/gitea/status"), "Gitea credential, repository 정책, webhook 상태를 확인하세요.", true},
		{"HIS Observability", join(cfg.ConsoleURL, "/api/admin/observability/status"), "ObservabilityBinding이 없다면 NotConfigured가 정상이며, 임의 설치로 우회하지 마세요.", false},
		{"PlatformConfig API", join(cfg.APIURL, "/apis/config.opensphere.io/v1alpha1/platformconfigs"), "CRD가 없으면 os status를 현행 상태 권위로 사용하세요.", false},
		{"PlatformVersion API", join(cfg.APIURL, "/apis/platform.opensphere.io/v1alpha1/platformversions"), "CRD가 없으면 os status를 현행 상태 권위로 사용하세요.", false},
	}
	results := make([]doctorCheck, 0, len(checks))
	criticalFailed, optionalFailed := false, false
	for _, check := range checks {
		started := time.Now()
		body, status, contentType, requestErr := rawRequest(http.MethodGet, check.endpoint, nil, "", token)
		result := doctorCheck{Name: check.name, HTTPStatus: status, LatencyMS: time.Since(started).Milliseconds(), Critical: check.critical}
		if requestErr != nil {
			result.Status, result.Message, result.Hint = "Failed", requestErr.Error(), check.hint
		} else if status < 200 || status >= 300 {
			result.Status, result.Message, result.Hint = "Failed", responseMessage(body, status), check.hint
		} else if err := requireJSONResponse(contentType, check.name); err != nil {
			result.Status, result.Message, result.Hint = "Failed", err.Error(), check.hint
		} else {
			result.Status = "Passed"
			var document map[string]any
			if json.Unmarshal(body, &document) == nil {
				if ready, exists := document["ready"].(bool); exists && !ready {
					result.Status = "Attention"
					if check.critical {
						result.Status = "Failed"
					}
					result.Message = semanticStatusMessage(document)
					result.Hint = check.hint
				}
			}
		}
		if result.Status != "Passed" {
			if check.critical {
				criticalFailed = true
			} else {
				optionalFailed = true
			}
		}
		results = append(results, result)
	}
	overall := "Ready"
	if criticalFailed {
		overall = "Degraded"
	} else if optionalFailed {
		overall = "Attention"
	}
	payload, _ := json.Marshal(map[string]any{"overall": overall, "checkedAt": time.Now().UTC().Format(time.RFC3339), "checks": results})
	if err := renderOutput(cfg, out, payload); err != nil {
		return err
	}
	if strict && (criticalFailed || optionalFailed) {
		return &CLIError{Status: http.StatusServiceUnavailable, Code: "DoctorFailed", Message: "doctor --strict 검사에서 실패 항목이 발견되었습니다"}
	}
	return nil
}

func semanticStatusMessage(document map[string]any) string {
	for _, key := range []string{"reason", "message", "phase", "mode"} {
		if value, ok := document[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return "endpoint는 응답했지만 ready=false 상태입니다"
}

func responseMessage(body []byte, status int) string {
	var payload map[string]any
	if json.Unmarshal(body, &payload) == nil {
		for _, key := range []string{"message", "error", "msg"} {
			if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
	}
	return fmt.Sprintf("HTTP %d", status)
}

func events(cfg Config, args []string, out io.Writer) error {
	flags := parseLongFlags(args)
	body, err := jsonBytesCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/admin/plugins/events"), nil)
	if err != nil {
		return err
	}
	body, err = transformJSONList(body, flags)
	if err != nil {
		return err
	}
	return renderOutput(cfg, out, body)
}

func limitJSONList(raw []byte, limit int) []byte {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return raw
	}
	switch typed := value.(type) {
	case []any:
		if len(typed) > limit {
			typed = typed[:limit]
		}
		out, _ := json.Marshal(typed)
		return out
	case map[string]any:
		if items, ok := typed["items"].([]any); ok && len(items) > limit {
			typed["items"] = items[:limit]
			out, _ := json.Marshal(typed)
			return out
		}
	}
	return raw
}

func transformJSONList(raw []byte, flags map[string]string) ([]byte, error) {
	if len(flags) == 0 {
		return raw, nil
	}
	var document any
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, err
	}
	var list []any
	container, _ := document.(map[string]any)
	containerKey := ""
	switch typed := document.(type) {
	case []any:
		list = typed
	case map[string]any:
		for _, key := range []string{"items", "changes", "events", "contracts"} {
			if candidate, ok := typed[key].([]any); ok {
				list, containerKey = candidate, key
				break
			}
		}
	}
	if list == nil {
		return raw, nil
	}
	if expression := strings.TrimSpace(flags["filter"]); expression != "" {
		parts := strings.SplitN(expression, "=", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" {
			return nil, usageError("--filter는 key=value 형식이어야 합니다")
		}
		key, expected := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
		filtered := make([]any, 0, len(list))
		for _, item := range list {
			if value, found := nestedJSONValue(item, key); found && strings.EqualFold(fmt.Sprint(value), expected) {
				filtered = append(filtered, item)
			}
		}
		list = filtered
	}
	if key := strings.TrimSpace(flags["sort-by"]); key != "" {
		descending := flags["desc"] == "true"
		sort.SliceStable(list, func(left, right int) bool {
			leftValue, _ := nestedJSONValue(list[left], key)
			rightValue, _ := nestedJSONValue(list[right], key)
			comparison := strings.Compare(strings.ToLower(fmt.Sprint(leftValue)), strings.ToLower(fmt.Sprint(rightValue)))
			if descending {
				return comparison > 0
			}
			return comparison < 0
		})
	}
	if rawLimit := strings.TrimSpace(flags["limit"]); rawLimit != "" {
		limit, err := strconv.Atoi(rawLimit)
		if err != nil || limit < 1 || limit > 1000 {
			return nil, usageError("--limit은 1..1000 범위여야 합니다")
		}
		if len(list) > limit {
			list = list[:limit]
		}
	}
	if containerKey != "" {
		container[containerKey] = list
		document = container
	} else {
		document = list
	}
	return json.Marshal(document)
}

func nestedJSONValue(value any, path string) (any, bool) {
	current := value
	for _, part := range strings.Split(path, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[part]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

type ChangePlan struct {
	APIVersion   string         `json:"apiVersion"`
	Kind         string         `json:"kind"`
	ID           string         `json:"id"`
	Digest       string         `json:"digest"`
	CreatedAt    string         `json:"createdAt"`
	ConsoleURL   string         `json:"consoleUrl"`
	ConsumerID   string         `json:"consumerId"`
	Action       string         `json:"action"`
	Target       string         `json:"target"`
	Reason       string         `json:"reason"`
	DesiredState map[string]any `json:"desiredState"`
	RollbackOf   string         `json:"rollbackOf,omitempty"`
}

func planChange(cfg Config, args []string, out io.Writer) error {
	if len(args) > 0 {
		switch strings.ToLower(args[0]) {
		case "list":
			return listPlans(cfg, out)
		case "show":
			if len(args) != 2 {
				return usageError("사용법: os plan show <plan-id>")
			}
			plan, err := loadPlan(args[1])
			if err != nil {
				return err
			}
			raw, _ := json.Marshal(plan)
			return renderOutput(cfg, out, raw)
		case "delete":
			return deletePlan(cfg, args[1:], out)
		}
	}
	plan, path, err := createPlan(cfg, args, "", "")
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"planId": plan.ID, "digest": plan.Digest, "path": path, "plan": plan})
	return renderOutput(cfg, out, payload)
}

func createPlan(cfg Config, args []string, forcedAction, rollbackOf string) (ChangePlan, string, error) {
	flags := parseLongFlags(args)
	consumer := strings.TrimSpace(flags["consumer"])
	action := strings.ToLower(strings.TrimSpace(flags["action"]))
	if forcedAction != "" {
		action = forcedAction
	}
	if action == "" {
		action = "apply"
	}
	target := strings.TrimSpace(flags["target"])
	if target == "" {
		target = consumer
	}
	reason := strings.TrimSpace(flags["reason"])
	file := strings.TrimSpace(flags["file"])
	if !validConsumerID(consumer) || (action != "apply" && action != "configure" && action != "rollback") || target == "" || len(target) > 300 || strings.ContainsAny(target, "\r\n") || len(reason) < 8 || file == "" {
		return ChangePlan{}, "", usageError("사용법: os plan --consumer <id> --action apply|configure|rollback --target <대상> --file <desired.json> --reason <8자 이상 사유>")
	}
	desired, err := readDesiredState(file)
	if err != nil {
		return ChangePlan{}, "", err
	}
	if flags["offline"] != "true" {
		if err := validatePlanConsumer(cfg, consumer); err != nil {
			return ChangePlan{}, "", err
		}
	}
	plan := ChangePlan{
		APIVersion: "cli.opensphere.io/v1", Kind: "GovernedChangePlan", CreatedAt: time.Now().UTC().Format(time.RFC3339),
		ConsoleURL: cfg.ConsoleURL, ConsumerID: consumer, Action: action, Target: target, Reason: reason, DesiredState: desired, RollbackOf: rollbackOf,
	}
	digestInput := struct {
		ConsoleURL, ConsumerID, Action, Target, Reason, RollbackOf string
		DesiredState                                               map[string]any
	}{plan.ConsoleURL, plan.ConsumerID, plan.Action, plan.Target, plan.Reason, plan.RollbackOf, plan.DesiredState}
	canonical, _ := json.Marshal(digestInput)
	digest := sha256.Sum256(canonical)
	plan.Digest = "sha256:" + hex.EncodeToString(digest[:])
	plan.ID = hex.EncodeToString(digest[:10])
	directory, err := planDirectory()
	if err != nil {
		return ChangePlan{}, "", err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return ChangePlan{}, "", err
	}
	path := filepath.Join(directory, plan.ID+".json")
	encoded, _ := json.MarshalIndent(plan, "", "  ")
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		return ChangePlan{}, "", err
	}
	_ = os.Chmod(path, 0o600)
	return plan, path, nil
}

func validatePlanConsumer(cfg Config, consumer string) error {
	raw, err := jsonBytesCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/platform/contracts"), nil)
	if err != nil {
		return withHint(err, "오프라인에서 검증을 미루려면 --offline을 명시하세요. apply 시 서버가 다시 검증합니다.")
	}
	var payload struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("consumer contract 응답 파싱 실패: %w", err)
	}
	for _, item := range payload.Items {
		id, _ := item["consumer_id"].(string)
		if id == "" {
			id, _ = item["consumerId"].(string)
		}
		if id == consumer {
			if status, _ := item["status"].(string); status != "" && strings.EqualFold(status, "disabled") {
				return &CLIError{Status: http.StatusConflict, Code: "ConsumerDisabled", Message: "consumer contract가 비활성 상태입니다: " + consumer}
			}
			return nil
		}
	}
	return &CLIError{Status: http.StatusNotFound, Code: "ConsumerContractNotFound", Message: "등록된 consumer contract를 찾을 수 없습니다: " + consumer, Hint: "오프라인 plan만 필요하면 --offline을 명시하세요."}
}

func listPlans(cfg Config, out io.Writer) error {
	directory, err := planDirectory()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		entries = nil
	} else if err != nil {
		return err
	}
	items := make([]any, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		plan, loadErr := loadPlan(id)
		if loadErr != nil {
			items = append(items, map[string]any{"id": id, "status": "Invalid", "error": loadErr.Error()})
			continue
		}
		items = append(items, map[string]any{"id": plan.ID, "consumerId": plan.ConsumerID, "action": plan.Action, "target": plan.Target, "createdAt": plan.CreatedAt, "digest": plan.Digest, "status": "Valid"})
	}
	raw, _ := json.Marshal(map[string]any{"plans": items, "directory": directory})
	return renderOutput(cfg, out, raw)
}

func deletePlan(cfg Config, args []string, out io.Writer) error {
	if len(args) != 2 || parseLongFlags(args[1:])["yes"] != "true" {
		return usageError("사용법: os plan delete <plan-id> --yes")
	}
	id := strings.TrimSpace(args[0])
	if len(id) != 20 {
		return usageError("plan ID는 20자리 hex 값이어야 합니다")
	}
	if _, err := hex.DecodeString(id); err != nil {
		return usageError("plan ID는 20자리 hex 값이어야 합니다")
	}
	directory, err := planDirectory()
	if err != nil {
		return err
	}
	path := filepath.Join(directory, id+".json")
	if err := os.Remove(path); errors.Is(err, os.ErrNotExist) {
		return &CLIError{Status: http.StatusNotFound, Code: "PlanNotFound", Message: "plan을 찾을 수 없습니다: " + id}
	} else if err != nil {
		return err
	}
	raw, _ := json.Marshal(map[string]any{"deleted": true, "planId": id})
	return renderOutput(cfg, out, raw)
}

func validConsumerID(value string) bool {
	if len(value) < 2 || len(value) > 128 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '.' && r != '_' && r != '-' {
			return false
		}
	}
	return true
}

func readDesiredState(path string) (map[string]any, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("desired state 파일 읽기 실패: %w", err)
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 64*1024+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 64*1024 {
		return nil, errors.New("desired state는 64 KiB를 초과할 수 없습니다")
	}
	var desired map[string]any
	if err := json.Unmarshal(raw, &desired); err != nil || desired == nil {
		return nil, errors.New("desired state는 JSON object여야 합니다")
	}
	if path, found := secretLikePath(desired, "desiredState"); found {
		return nil, fmt.Errorf("%s에는 비밀 원문을 넣을 수 없습니다; Secret 이름/ref만 사용하세요", path)
	}
	return desired, nil
}

func secretLikePath(value any, at string) (string, bool) {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			lower := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "_", ""), "-", ""))
			secret := strings.Contains(lower, "password") || strings.Contains(lower, "token") || strings.Contains(lower, "credential") || strings.Contains(lower, "privatekey") || (strings.Contains(lower, "secret") && !strings.HasSuffix(lower, "secretref") && !strings.HasSuffix(lower, "secretname"))
			if secret {
				return at + "." + key, true
			}
			if path, found := secretLikePath(child, at+"."+key); found {
				return path, true
			}
		}
	case []any:
		for index, child := range typed {
			if path, found := secretLikePath(child, fmt.Sprintf("%s[%d]", at, index)); found {
				return path, true
			}
		}
	}
	return "", false
}

func planDirectory() (string, error) {
	if value := strings.TrimSpace(os.Getenv("OS_PLAN_DIR")); value != "" {
		return filepath.Abs(value)
	}
	path, err := configPath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(path), "plans"), nil
}

func loadPlan(reference string) (ChangePlan, error) {
	path := reference
	if !strings.ContainsAny(reference, `/\\`) && filepath.Ext(reference) == "" {
		if len(reference) != 20 {
			return ChangePlan{}, usageError("plan ID는 20자리 hex 값이어야 합니다")
		}
		if _, err := hex.DecodeString(reference); err != nil {
			return ChangePlan{}, usageError("plan ID는 20자리 hex 값이어야 합니다")
		}
		directory, err := planDirectory()
		if err != nil {
			return ChangePlan{}, err
		}
		path = filepath.Join(directory, reference+".json")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ChangePlan{}, fmt.Errorf("plan 읽기 실패: %w", err)
	}
	var plan ChangePlan
	if err := json.Unmarshal(raw, &plan); err != nil {
		return ChangePlan{}, fmt.Errorf("plan 파싱 실패: %w", err)
	}
	if plan.APIVersion != "cli.opensphere.io/v1" || plan.Kind != "GovernedChangePlan" || plan.ID == "" || plan.Digest == "" {
		return ChangePlan{}, errors.New("지원하지 않거나 손상된 plan 파일입니다")
	}
	digestInput := struct {
		ConsoleURL, ConsumerID, Action, Target, Reason, RollbackOf string
		DesiredState                                               map[string]any
	}{plan.ConsoleURL, plan.ConsumerID, plan.Action, plan.Target, plan.Reason, plan.RollbackOf, plan.DesiredState}
	canonical, _ := json.Marshal(digestInput)
	digest := sha256.Sum256(canonical)
	expected := "sha256:" + hex.EncodeToString(digest[:])
	if plan.Digest != expected || plan.ID != hex.EncodeToString(digest[:10]) {
		return ChangePlan{}, errors.New("plan digest 검증에 실패했습니다; 변경된 plan은 다시 생성하세요")
	}
	return plan, nil
}

func applyPlan(cfg Config, args []string, out io.Writer) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "--") {
		return usageError("사용법: os apply <plan-id|plan-file> [--wait] [--timeout 5m]")
	}
	plan, err := loadPlan(args[0])
	if err != nil {
		return err
	}
	if strings.TrimRight(plan.ConsoleURL, "/") != strings.TrimRight(cfg.ConsoleURL, "/") {
		return &CLIError{Status: http.StatusConflict, Code: "ContextMismatch", Message: "plan이 현재 Console context와 다릅니다", Hint: plan.ConsoleURL + " context에서 적용하거나 plan을 다시 생성하세요."}
	}
	payload := map[string]any{
		"consumerId": plan.ConsumerID, "action": plan.Action, "target": plan.Target, "reason": plan.Reason,
		"desiredState": plan.DesiredState, "idempotencyKey": "os-plan:" + strings.TrimPrefix(plan.Digest, "sha256:"),
	}
	if plan.RollbackOf != "" {
		payload["rollbackOf"] = plan.RollbackOf
	}
	raw, err := jsonBytesCall(cfg, http.MethodPost, join(cfg.ConsoleURL, "/api/platform/changes"), payload)
	if err != nil {
		return err
	}
	flags := parseLongFlags(args[1:])
	if flags["wait"] != "true" {
		return renderOutput(cfg, out, raw)
	}
	var response map[string]any
	if json.Unmarshal(raw, &response) != nil {
		return errors.New("변경 제출 응답을 해석할 수 없습니다")
	}
	requestID, _ := response["requestId"].(string)
	if requestID == "" {
		return errors.New("변경 제출 응답에 requestId가 없습니다")
	}
	operation, err := watchOperation(cfg, requestID, parseTimeout(flags["timeout"]))
	if err != nil {
		return err
	}
	combined, _ := json.Marshal(map[string]any{"submission": response, "operation": operation})
	return renderOutput(cfg, out, combined)
}

func jsonBytesCall(cfg Config, method, rawURL string, payload any) ([]byte, error) {
	var body io.Reader
	contentType := ""
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		body, contentType = bytes.NewReader(encoded), "application/json"
	}
	response, status, responseContentType, err := requestWithContentType(cfg, method, rawURL, body, contentType)
	if err != nil {
		return nil, err
	}
	if err := requireOK(response, status); err != nil {
		return nil, err
	}
	if status == http.StatusNoContent || len(bytes.TrimSpace(response)) == 0 {
		return []byte("{}"), nil
	}
	if err := requireJSONResponse(responseContentType, "Console API"); err != nil {
		return nil, err
	}
	var value any
	if err := json.Unmarshal(response, &value); err != nil {
		return nil, fmt.Errorf("Console API JSON이 올바르지 않습니다: %w", err)
	}
	return response, nil
}

func operations(cfg Config, args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "list" {
		changes, err := operationList(cfg)
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(changes)
		if len(args) > 1 {
			raw, err = transformJSONList(raw, parseLongFlags(args[1:]))
			if err != nil {
				return err
			}
		}
		return renderOutput(cfg, out, raw)
	}
	if len(args) < 2 {
		return usageError("사용법: os operation list|get|watch|approve <request-id>")
	}
	requestID := strings.TrimSpace(args[1])
	switch args[0] {
	case "get":
		operation, err := getOperation(cfg, requestID)
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(operation)
		return renderOutput(cfg, out, raw)
	case "watch":
		operation, err := watchOperation(cfg, requestID, parseTimeout(parseLongFlags(args[2:])["timeout"]))
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(operation)
		return renderOutput(cfg, out, raw)
	case "approve":
		reason := strings.TrimSpace(parseLongFlags(args[2:])["reason"])
		if len(reason) < 8 {
			return usageError("사용법: os operation approve <request-id> --reason <8자 이상 승인 사유>")
		}
		return jsonCall(cfg, http.MethodPost, join(cfg.ConsoleURL, "/api/platform/changes/"+requestID+"/approve"), map[string]string{"reason": reason}, out)
	default:
		return usageError("사용법: os operation list|get|watch|approve <request-id>")
	}
}

func operationList(cfg Config) ([]any, error) {
	raw, err := jsonBytesCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/platform/gitea/status"), nil)
	if err != nil {
		return nil, err
	}
	return decodeOperationList(raw)
}

func decodeOperationList(raw []byte) ([]any, error) {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	for _, key := range []string{"changes", "changeRequests", "operations"} {
		if list, ok := payload[key].([]any); ok {
			return list, nil
		}
	}
	return []any{}, nil
}

func operationIDFrom(value map[string]any) string {
	for _, key := range []string{"requestId", "request_id", "id"} {
		if id, ok := value[key].(string); ok {
			return id
		}
	}
	return ""
}

func getOperation(cfg Config, requestID string) (map[string]any, error) {
	changes, err := operationList(cfg)
	if err != nil {
		return nil, err
	}
	for _, item := range changes {
		if operation, ok := item.(map[string]any); ok && operationIDFrom(operation) == requestID {
			return operation, nil
		}
	}
	return nil, &CLIError{Status: http.StatusNotFound, Code: "OperationNotFound", Message: "operation을 찾을 수 없습니다: " + requestID}
}

func parseTimeout(raw string) time.Duration {
	if strings.TrimSpace(raw) == "" {
		return 5 * time.Minute
	}
	duration, err := time.ParseDuration(raw)
	if err != nil || duration < time.Second || duration > 24*time.Hour {
		return 5 * time.Minute
	}
	return duration
}

func watchOperation(cfg Config, requestID string, timeout time.Duration) (map[string]any, error) {
	token, err := credentialToken(cfg)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		raw, status, contentType, requestErr := rawRequest(http.MethodGet, join(cfg.ConsoleURL, "/api/platform/gitea/status"), nil, "", token)
		if requestErr != nil {
			return nil, requestErr
		}
		if err := requireOK(raw, status); err != nil {
			return nil, err
		}
		if err := requireJSONResponse(contentType, "Gitea Change Control"); err != nil {
			return nil, err
		}
		changes, err := decodeOperationList(raw)
		if err != nil {
			return nil, err
		}
		var operation map[string]any
		for _, item := range changes {
			if candidate, ok := item.(map[string]any); ok && operationIDFrom(candidate) == requestID {
				operation = candidate
				break
			}
		}
		if operation == nil {
			return nil, &CLIError{Status: http.StatusNotFound, Code: "OperationNotFound", Message: "operation을 찾을 수 없습니다: " + requestID}
		}
		operationStatus := ""
		for _, key := range []string{"status", "state", "phase"} {
			if value, ok := operation[key].(string); ok {
				operationStatus = strings.ToLower(value)
				break
			}
		}
		if terminalOperationStatus(operationStatus) {
			return operation, nil
		}
		if time.Now().After(deadline) {
			return nil, &CLIError{Status: http.StatusGatewayTimeout, Code: "OperationTimeout", Message: "operation 대기 시간이 초과되었습니다: " + requestID, Hint: "os operation get " + requestID + " 로 현재 상태를 다시 확인하세요."}
		}
		sleepFn(2 * time.Second)
	}
}

func terminalOperationStatus(status string) bool {
	switch strings.ToLower(status) {
	case "applied", "failed", "rejected", "cancelled", "canceled", "rolledback", "rolled_back", "superseded":
		return true
	default:
		return false
	}
}

func rollbackChange(cfg Config, args []string, out io.Writer) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "--") {
		return usageError("사용법: os rollback <request-id> --consumer <id> --target <대상> --file <desired.json> --reason <8자 이상 사유> (plan만 생성)")
	}
	requestID := strings.TrimSpace(args[0])
	if len(requestID) != 36 {
		return usageError("rollback 원본 request-id가 올바르지 않습니다")
	}
	plan, path, err := createPlan(cfg, args[1:], "rollback", requestID)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{
		"message": "rollback plan을 생성했습니다. 검토 후 os apply " + plan.ID + " 로 제출하세요.",
		"planId":  plan.ID, "digest": plan.Digest, "path": path, "rollbackOf": requestID, "plan": plan,
	})
	return renderOutput(cfg, out, payload)
}

func contexts(cfg Config, args []string, out io.Writer) error {
	action := "current"
	if len(args) > 0 {
		action = strings.ToLower(args[0])
	}
	switch action {
	case "current":
		payload, _ := json.Marshal(publicContext(cfg))
		return renderOutput(cfg, out, payload)
	case "list":
		directory, err := contextDirectory()
		if err != nil {
			return err
		}
		entries, err := os.ReadDir(directory)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		items := []any{publicContext(cfg)}
		seen := map[string]bool{cfg.Context: true}
		for _, entry := range entries {
			if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
				continue
			}
			name := strings.TrimSuffix(entry.Name(), ".json")
			if seen[name] || !validContextName(name) {
				continue
			}
			stored, loadErr := loadContext(name)
			if loadErr != nil {
				items = append(items, map[string]any{"name": name, "status": "Invalid", "error": loadErr.Error()})
				continue
			}
			item := publicContext(stored)
			item["active"] = false
			items = append(items, item)
			seen[name] = true
		}
		payload, _ := json.Marshal(items)
		return renderOutput(cfg, out, payload)
	case "save":
		if len(args) != 2 || !validContextName(args[1]) {
			return usageError("사용법: os context save <name>")
		}
		cfg.Context = args[1]
		if err := saveContext(cfg); err != nil {
			return err
		}
		contextCopy := publicContext(cfg)
		contextCopy["active"] = false
		payload, _ := json.Marshal(map[string]any{"saved": true, "activated": false, "context": contextCopy, "hint": "전환하려면 os context use " + args[1] + " 를 실행하세요."})
		return renderOutput(cfg, out, payload)
	case "use":
		if len(args) != 2 || !validContextName(args[1]) {
			return usageError("사용법: os context use <name>")
		}
		stored, err := loadContext(args[1])
		if err != nil {
			return err
		}
		stored.PAT = os.Getenv("OS_PAT")
		stored.Output = cfg.Output
		if err := saveConfig(stored); err != nil {
			return err
		}
		payload, _ := json.Marshal(map[string]any{"active": true, "context": publicContext(stored)})
		return renderOutput(stored, out, payload)
	case "delete":
		if len(args) < 2 || !validContextName(args[1]) || parseLongFlags(args[2:])["yes"] != "true" {
			return usageError("사용법: os context delete <name> --yes (로컬 context만 삭제; 서버 장치 신뢰는 유지)")
		}
		if args[1] == cfg.Context {
			return &CLIError{Status: http.StatusConflict, Code: "ActiveContext", Message: "현재 활성 context는 삭제할 수 없습니다", Hint: "다른 context로 전환한 뒤 다시 실행하세요."}
		}
		directory, err := contextDirectory()
		if err != nil {
			return err
		}
		if err := os.Remove(filepath.Join(directory, args[1]+".json")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		payload, _ := json.Marshal(map[string]any{"deleted": true, "name": args[1], "serverTrustChanged": false})
		return renderOutput(cfg, out, payload)
	default:
		return usageError("사용법: os context current|list|save <name>|use <name>|delete <name> --yes")
	}
}

func publicContext(cfg Config) map[string]any {
	return map[string]any{
		"name": cfg.Context, "active": true, "profile": cfg.Profile, "consoleUrl": cfg.ConsoleURL,
		"registryUrl": cfg.RegistryURL, "apiUrl": cfg.APIURL, "identityUrl": cfg.IdentityURL,
		"deviceId": cfg.DeviceID, "deviceLabel": cfg.DeviceLabel, "automationTokenPresent": strings.TrimSpace(cfg.PAT) != "",
	}
}

func validContextName(value string) bool {
	if len(value) < 1 || len(value) > 63 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return value[len(value)-1] != '-'
}

func contextDirectory() (string, error) {
	path, err := configPath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(path), "contexts"), nil
}

func saveContext(cfg Config) error {
	if !validContextName(cfg.Context) {
		return errors.New("context 이름이 올바르지 않습니다")
	}
	directory, err := contextDirectory()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	cfg.PAT = ""
	encoded, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(directory, cfg.Context+".json")
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func loadContext(name string) (Config, error) {
	if !validContextName(name) {
		return Config{}, errors.New("context 이름이 올바르지 않습니다")
	}
	directory, err := contextDirectory()
	if err != nil {
		return Config{}, err
	}
	raw, err := os.ReadFile(filepath.Join(directory, name+".json"))
	if err != nil {
		return Config{}, fmt.Errorf("context 읽기 실패: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return Config{}, fmt.Errorf("context 파싱 실패: %w", err)
	}
	if cfg.Context != name {
		return Config{}, errors.New("context 파일 이름과 내부 이름이 일치하지 않습니다")
	}
	for _, endpoint := range []string{cfg.ConsoleURL, cfg.RegistryURL, cfg.APIURL, cfg.IdentityURL} {
		if err := validateURL(endpoint); err != nil {
			return Config{}, err
		}
	}
	return cfg, nil
}

func supportBundle(cfg Config, args []string, out io.Writer) error {
	flags := parseLongFlags(args)
	path := strings.TrimSpace(flags["file"])
	if path == "" {
		return usageError("사용법: os support-bundle --file <bundle.json> [--force]")
	}
	if _, err := os.Stat(path); err == nil && flags["force"] != "true" {
		return &CLIError{Status: http.StatusConflict, Code: "FileExists", Message: "support bundle 파일이 이미 존재합니다", Hint: "다른 경로를 사용하거나 --force를 명시하세요."}
	}
	token, err := credentialToken(cfg)
	if err != nil {
		return err
	}
	endpoints := []struct{ name, url string }{
		{"identity", join(cfg.IdentityURL, "/introspect")},
		{"registry", cfg.RegistryURL},
		{"platform", join(cfg.ConsoleURL, "/api/admin/platform-readiness/status")},
		{"supabase", join(cfg.ConsoleURL, "/api/identity/supabase/status")},
		{"gitea", join(cfg.ConsoleURL, "/api/platform/gitea/status")},
		{"observability", join(cfg.ConsoleURL, "/api/admin/observability/status")},
	}
	evidence := map[string]any{}
	for _, endpoint := range endpoints {
		body, status, contentType, requestErr := rawRequest(http.MethodGet, endpoint.url, nil, "", token)
		if requestErr != nil {
			evidence[endpoint.name] = map[string]any{"ok": false, "error": requestErr.Error()}
			continue
		}
		entry := map[string]any{"ok": status >= 200 && status < 300, "httpStatus": status, "contentType": contentType}
		var document any
		if json.Unmarshal(body, &document) == nil {
			entry["body"] = redactSupportValue(document)
		} else {
			entry["error"] = "non-JSON response omitted"
		}
		evidence[endpoint.name] = entry
	}
	bundle := map[string]any{
		"apiVersion": "support.opensphere.io/v1", "kind": "CLISupportBundle", "generatedAt": time.Now().UTC().Format(time.RFC3339),
		"cliVersion": version, "context": publicContext(cfg), "evidence": evidence,
	}
	encoded, _ := json.MarshalIndent(bundle, "", "  ")
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(abs, append(encoded, '\n'), 0o600); err != nil {
		return err
	}
	_ = os.Chmod(abs, 0o600)
	digest := sha256.Sum256(encoded)
	payload, _ := json.Marshal(map[string]any{"written": true, "path": abs, "size": len(encoded) + 1, "sha256": hex.EncodeToString(digest[:])})
	return renderOutput(cfg, out, payload)
}

func redactSupportValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		redacted := make(map[string]any, len(typed))
		for key, child := range typed {
			lower := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "_", ""), "-", ""))
			if strings.Contains(lower, "token") || strings.Contains(lower, "authorization") || strings.Contains(lower, "password") || strings.Contains(lower, "privatekey") || (strings.Contains(lower, "secret") && !strings.HasSuffix(lower, "secretref") && !strings.HasSuffix(lower, "secretname")) {
				redacted[key] = "[REDACTED]"
			} else {
				redacted[key] = redactSupportValue(child)
			}
		}
		return redacted
	case []any:
		redacted := make([]any, len(typed))
		for index, child := range typed {
			redacted[index] = redactSupportValue(child)
		}
		return redacted
	default:
		return value
	}
}

func completion(args []string, out io.Writer) error {
	if len(args) != 1 {
		return usageError("사용법: os completion powershell|bash|zsh")
	}
	commands := strings.Join(completionCommandNames(), " ")
	switch strings.ToLower(args[0]) {
	case "powershell":
		_, err := fmt.Fprintf(out, "Register-ArgumentCompleter -Native -CommandName os -ScriptBlock { param($wordToComplete) '%s'.Split(' ') | Where-Object { $_ -like \"$wordToComplete*\" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) } }\n", commands)
		return err
	case "bash":
		_, err := fmt.Fprintf(out, "complete -W '%s' os\n", commands)
		return err
	case "zsh":
		_, err := fmt.Fprintf(out, "#compdef os\n_arguments '1:command:(%s)'\n", commands)
		return err
	default:
		return usageError("사용법: os completion powershell|bash|zsh")
	}
}
