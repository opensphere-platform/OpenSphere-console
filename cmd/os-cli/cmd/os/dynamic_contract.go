package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

const (
	executionClassConsoleAPI   = "console-api"
	executionClassLocalHost    = "local-host"
	executionClassExternalTool = "external-tool"
)

type AttestedExecutionContext struct {
	Profile            string
	Authority          string
	AttestationID      string
	ActorID            string
	SessionID          string
	SessionClass       string
	RuntimeAdapterID   string
	RuntimeUID         string
	Origin             string
	Audience           string
	PermissionRevision string
	AssuranceLevel     string
	ReleaseEvidenceRef string
	Generation         int64
	FencingEpoch       int64
	KeyID              string
}

// attestedExecutionContextProvider is intentionally an in-process seam. It is
// not populated from argv, environment variables, or the user config file.
// A future delegated credential agent adapter must verify the attestation
// before returning a context here.
var attestedExecutionContextProvider = readAttestedExecutionContextFromAgent

var nativeExecutionClasses = map[string]string{
	"shell":          executionClassConsoleAPI,
	"login":          executionClassLocalHost,
	"whoami":         executionClassConsoleAPI,
	"logout":         executionClassLocalHost,
	"status":         executionClassConsoleAPI,
	"health":         executionClassConsoleAPI,
	"doctor":         executionClassConsoleAPI,
	"describe":       executionClassConsoleAPI,
	"events":         executionClassConsoleAPI,
	"device":         executionClassConsoleAPI,
	"token":          executionClassConsoleAPI,
	"admin":          executionClassConsoleAPI,
	"registry":       executionClassConsoleAPI,
	"catalog":        executionClassConsoleAPI,
	"get":            executionClassConsoleAPI,
	"role":           executionClassConsoleAPI,
	"observability":  executionClassConsoleAPI,
	"audit":          executionClassConsoleAPI,
	"extensions":     executionClassConsoleAPI,
	"plan":           executionClassLocalHost,
	"apply":          executionClassLocalHost,
	"operation":      executionClassConsoleAPI,
	"rollback":       executionClassLocalHost,
	"context":        executionClassLocalHost,
	"support-bundle": executionClassLocalHost,
	"update":         executionClassLocalHost,
	"platform":       executionClassExternalTool,
	"completion":     executionClassConsoleAPI,
	"version":        executionClassConsoleAPI,
	"backbone":       executionClassConsoleAPI,
}

type MissingInput struct {
	Path     string `json:"path"`
	Option   string `json:"option,omitempty"`
	Type     string `json:"type,omitempty"`
	Secret   bool   `json:"secret"`
	FileOnly bool   `json:"fileOnly,omitempty"`
	Enum     []any  `json:"enum,omitempty"`
}

type MissingInputAction struct {
	ID           string   `json:"id"`
	Kind         string   `json:"kind"`
	Command      string   `json:"command"`
	InputMode    string   `json:"inputMode"`
	MissingPaths []string `json:"missingPaths"`
}

type MissingInputsError struct {
	ToolID        string
	Command       string
	SupportsFile  bool
	MissingInputs []MissingInput
	NextActions   []MissingInputAction
	ActionBinding map[string]any
}

func (e *MissingInputsError) Error() string {
	paths := make([]string, 0, len(e.MissingInputs))
	for _, input := range e.MissingInputs {
		paths = append(paths, input.Path)
	}
	return "필수 입력이 누락되었습니다: " + strings.Join(paths, ", ")
}

func missingInputActions(tool Tool) []MissingInputAction {
	missingPaths := []string{}
	inputMode := "options"
	if tool.SupportsFile {
		inputMode = "file-or-options"
	}
	return []MissingInputAction{{
		ID: "provide-required-inputs", Kind: "provide-inputs", Command: tool.Command,
		InputMode: inputMode, MissingPaths: missingPaths,
	}}
}

func populateMissingInputActionPaths(missing *MissingInputsError) {
	paths := make([]string, 0, len(missing.MissingInputs))
	for _, input := range missing.MissingInputs {
		paths = append(paths, input.Path)
	}
	for i := range missing.NextActions {
		missing.NextActions[i].MissingPaths = append([]string(nil), paths...)
	}
}

func collectMissingInputs(payload map[string]any, schema *ToolInputSchema, field string) []MissingInput {
	if schema == nil {
		return nil
	}
	missing := []MissingInput{}
	for _, required := range schema.Required {
		value, found := payload[required]
		if found && value != nil && strings.TrimSpace(fmt.Sprint(value)) != "" {
			continue
		}
		property := schema.Properties[required]
		input := MissingInput{Path: field + "." + required}
		if property != nil {
			input.Type = property.Type
			input.Secret = property.Secret
			input.Enum = append([]any(nil), property.Enum...)
		}
		optionPath := strings.TrimPrefix(input.Path, "request.")
		if strings.Contains(optionPath, "[") || input.Secret {
			input.FileOnly = true
		} else {
			input.Option = "--" + camelPathToKebab(optionPath)
		}
		missing = append(missing, input)
	}
	keys := make([]string, 0, len(schema.Properties))
	for key := range schema.Properties {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		property := schema.Properties[key]
		value, found := payload[key]
		if !found || value == nil || property == nil {
			continue
		}
		switch property.Type {
		case "object":
			if object, ok := value.(map[string]any); ok {
				missing = append(missing, collectMissingInputs(object, property, field+"."+key)...)
			}
		case "array":
			items, ok := value.([]any)
			if !ok || property.Items == nil || property.Items.Type != "object" {
				continue
			}
			for index, item := range items {
				if object, ok := item.(map[string]any); ok {
					itemPath := fmt.Sprintf("%s.%s[%d]", field, key, index)
					missing = append(missing, collectMissingInputs(object, property.Items, itemPath)...)
				}
			}
		}
	}
	return missing
}

func camelPathToKebab(path string) string {
	parts := strings.Split(path, ".")
	for i, part := range parts {
		var out strings.Builder
		for index, r := range part {
			if index > 0 && r >= 'A' && r <= 'Z' {
				out.WriteByte('-')
			}
			out.WriteRune(r)
		}
		parts[i] = strings.ToLower(out.String())
	}
	return strings.Join(parts, ".")
}

func validateToolManifest(manifest ToolManifest) error {
	if strings.TrimSpace(manifest.Kind) == "" || len(manifest.Tools) == 0 {
		return commandContractError("CLI contribution manifest schema is invalid")
	}
	seenIDs := map[string]bool{}
	for _, tool := range manifest.Tools {
		if strings.TrimSpace(tool.Command) == "" || (strings.TrimSpace(tool.Path) == "" && len(tool.Components) == 0 && len(tool.Operations) == 0) {
			return commandContractError("CLI contribution tool command/path is required")
		}
		if tool.ID != "" {
			if seenIDs[tool.ID] {
				return commandContractError("duplicate CLI contribution tool id: " + tool.ID)
			}
			seenIDs[tool.ID] = true
		}
		if tool.ExecutionClass != "" && !validExecutionClass(tool.ExecutionClass) {
			return commandContractError("unknown executionClass: " + tool.ExecutionClass)
		}
		webShellAvailable, availabilityDeclared, availabilityErr := declaredWebShellAvailability(tool)
		if availabilityErr != nil {
			return availabilityErr
		}
		if availabilityDeclared && webShellAvailable && tool.ExecutionClass != executionClassConsoleAPI {
			return commandContractError("Web Shell availability requires executionClass console-api: " + tool.Command)
		}
		if tool.ActionBinding != nil {
			if len(tool.ActionBinding) == 0 {
				return commandContractError("actionBinding must not be empty: " + tool.Command)
			}
			for _, key := range []string{"id", "action", "capability", "operation"} {
				if value, found := tool.ActionBinding[key]; found {
					if text, ok := value.(string); !ok || strings.TrimSpace(text) == "" {
						return commandContractError("actionBinding." + key + " must be a non-empty string: " + tool.Command)
					}
				}
			}
		}
		if isDynamicOperationWatch(tool) && !strings.EqualFold(strings.TrimSpace(tool.Method), http.MethodGet) {
			return commandContractError("operation watch tool must use GET: " + tool.Command)
		}
	}
	return nil
}

func declaredWebShellAvailability(tool Tool) (bool, bool, error) {
	var value *bool
	if tool.Availability != nil && tool.Availability.WebShell != nil {
		value = tool.Availability.WebShell
	}
	if tool.WebShell != nil && tool.WebShell.Available != nil {
		if value != nil && *value != *tool.WebShell.Available {
			return false, false, commandContractError("conflicting Web Shell availability: " + tool.Command)
		}
		value = tool.WebShell.Available
	}
	if value == nil {
		return false, false, nil
	}
	return *value, true, nil
}

func commandContractError(message string) error {
	return &CLIError{Code: "CommandContractInvalid", Message: message}
}

func validExecutionClass(value string) bool {
	switch value {
	case executionClassConsoleAPI, executionClassLocalHost, executionClassExternalTool:
		return true
	default:
		return false
	}
}

func resolveAttestedExecutionContext(ctx context.Context) (*AttestedExecutionContext, error) {
	attested, err := attestedExecutionContextProvider(ctx)
	if err != nil {
		return nil, &CLIError{Code: "ExecutionContextUnavailable", Message: "검증된 실행 context를 읽을 수 없습니다"}
	}
	if attested == nil {
		return nil, nil
	}
	if attested.Profile != "web-shell" ||
		attested.Authority != "delegated-credential-agent" ||
		attested.SessionClass != "operator-interactive" ||
		attested.RuntimeAdapterID != "cbss.kubernetes-pod" ||
		attested.Audience != "opensphere-os-cli" ||
		strings.TrimSpace(attested.AttestationID) == "" ||
		strings.TrimSpace(attested.ActorID) == "" ||
		strings.TrimSpace(attested.SessionID) == "" ||
		strings.TrimSpace(attested.RuntimeUID) == "" ||
		strings.TrimSpace(attested.Origin) == "" ||
		strings.TrimSpace(attested.PermissionRevision) == "" ||
		strings.TrimSpace(attested.AssuranceLevel) == "" ||
		strings.TrimSpace(attested.ReleaseEvidenceRef) == "" ||
		strings.TrimSpace(attested.KeyID) == "" ||
		attested.Generation < 1 || attested.FencingEpoch < 1 {
		return nil, &CLIError{Code: "InvalidExecutionContext", Message: "검증되지 않은 Web Shell 실행 context입니다"}
	}
	return attested, nil
}

func enforceNativeExecutionPolicy(ctx context.Context, command string) error {
	class, ok := nativeExecutionClasses[strings.ToLower(command)]
	if !ok {
		return commandContractError("native command executionClass is not declared: " + command)
	}
	return enforceExecutionPolicy(ctx, command, class, nil)
}

func enforceDynamicExecutionPolicy(ctx context.Context, tool Tool) error {
	var available *bool
	if value, declared, err := declaredWebShellAvailability(tool); err != nil {
		return err
	} else if declared {
		available = &value
	}
	return enforceExecutionPolicy(ctx, tool.Command, tool.ExecutionClass, available)
}

func enforceExecutionPolicy(ctx context.Context, command, class string, webShellAvailable *bool) error {
	attested, err := resolveAttestedExecutionContext(ctx)
	if err != nil || attested == nil {
		return err
	}
	if class != executionClassConsoleAPI || (webShellAvailable != nil && !*webShellAvailable) {
		reason := "executionClass가 console-api가 아닙니다"
		if class == "" {
			reason = "Owner manifest에 executionClass가 없습니다"
		} else if webShellAvailable != nil && !*webShellAvailable {
			reason = "Owner manifest가 Web Shell에서 사용할 수 없다고 선언했습니다"
		}
		return &CLIError{
			Code: "UnsupportedInWebShell", Message: "Web Shell에서 지원하지 않는 명령입니다: " + command,
			Hint: reason,
		}
	}
	return nil
}

func printDynamicCommandHelp(out io.Writer, namespace string, args []string, manifest ToolManifest) error {
	commandWords := nonFlagArgs(args)
	if len(commandWords) == 0 {
		fmt.Fprintf(out, "os %s — dynamic Owner API commands\n\n사용법:\n", namespace)
		tools := append([]Tool(nil), manifest.Tools...)
		sort.Slice(tools, func(i, j int) bool { return tools[i].Command < tools[j].Command })
		for _, tool := range tools {
			fmt.Fprintf(out, "  %-52s %s\n", tool.Command, tool.Description)
		}
		return nil
	}
	var selected *Tool
	selectedLength := -1
	for i := range manifest.Tools {
		prefix := toolCommandPrefix(manifest.Tools[i].Command, namespace)
		if len(prefix) <= len(commandWords) && len(prefix) > selectedLength && strings.Join(prefix, " ") == strings.Join(commandWords[:len(prefix)], " ") {
			selected = &manifest.Tools[i]
			selectedLength = len(prefix)
		}
	}
	if selected == nil {
		return usageErrorf("dynamic 명령 도움말을 찾을 수 없습니다: os %s %s", namespace, strings.Join(commandWords, " "))
	}
	fmt.Fprintf(out, "%s — %s\n\n사용법:\n  %s\n", selected.Command, selected.Description, selected.Command)
	if selected.ExecutionClass != "" {
		fmt.Fprintf(out, "\n실행 class: %s\n", selected.ExecutionClass)
	}
	if selected.InputSchema != nil && len(selected.InputSchema.Properties) > 0 {
		fmt.Fprintln(out, "\n입력:")
		printDynamicSchemaHelp(out, selected.InputSchema, "", map[string]bool{})
	}
	if selected.SupportsFile {
		fmt.Fprintln(out, "  --file PATH|-  같은 schema의 JSON object 입력")
	}
	return nil
}

func printDynamicSchemaHelp(out io.Writer, schema *ToolInputSchema, prefix string, inheritedRequired map[string]bool) {
	required := map[string]bool{}
	for _, key := range schema.Required {
		required[key] = true
	}
	keys := make([]string, 0, len(schema.Properties))
	for key := range schema.Properties {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		property := schema.Properties[key]
		path := key
		if prefix != "" {
			path = prefix + "." + key
		}
		requirement := "optional"
		if required[key] || inheritedRequired[path] {
			requirement = "required"
		}
		if property.Type == "object" {
			printDynamicSchemaHelp(out, property, path, inheritedRequired)
			continue
		}
		fmt.Fprintf(out, "  --%-32s %-10s %s\n", camelPathToKebab(path), property.Type, requirement)
	}
}

func copyStringMap(source map[string]string) map[string]string {
	copy := make(map[string]string, len(source))
	for key, value := range source {
		copy[key] = value
	}
	return copy
}

func isDynamicOperationWatch(tool Tool) bool {
	if strings.HasSuffix(strings.ToLower(strings.TrimSpace(tool.ID)), ".operation.watch") {
		return true
	}
	words := toolCommandPrefix(tool.Command, "")
	return len(words) > 0 && strings.EqualFold(words[len(words)-1], "watch")
}

func dynamicPollDuration(raw string, fallback, minimum, maximum time.Duration, option string) (time.Duration, error) {
	if strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	duration, err := time.ParseDuration(raw)
	if err != nil || duration < minimum || duration > maximum {
		return 0, usageErrorf("--%s는 %s..%s 범위의 duration이어야 합니다", option, minimum, maximum)
	}
	return duration, nil
}

func watchDynamicOperation(ctx context.Context, cfg Config, tool Tool, target string, flags map[string]string, out io.Writer) error {
	interval, err := dynamicPollDuration(flags["interval"], 2*time.Second, 10*time.Millisecond, 5*time.Minute, "interval")
	if err != nil {
		return err
	}
	timeout, err := dynamicPollDuration(flags["timeout"], 5*time.Minute, 10*time.Millisecond, 24*time.Hour, "timeout")
	if err != nil {
		return err
	}
	token, err := credentialToken(cfg)
	if err != nil {
		return err
	}
	pollContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		response, status, contentType, _, requestErr := rawRequestWithRetryAfterContext(pollContext, http.MethodGet, target, nil, "", token)
		if requestErr != nil {
			if pollContext.Err() != nil {
				return dynamicPollContextError(ctx, tool, timeout)
			}
			return requestErr
		}
		if status == http.StatusNotFound {
			return &CLIError{Status: status, Code: "OperationNotFound", Message: "operation을 찾을 수 없습니다", Details: map[string]any{"toolId": tool.ID}}
		}
		if err := requireOK(response, status); err != nil {
			return err
		}
		if err := requireJSONResponse(contentType, "Owner operation watch"); err != nil {
			return err
		}
		var operation map[string]any
		if err := json.Unmarshal(response, &operation); err != nil {
			return commandContractError("Owner operation watch response is not a JSON object")
		}
		if stale, present := operation["stale"].(bool); present && stale {
			return &CLIError{Status: http.StatusConflict, Code: "OperationEvidenceStale", Message: "operation 증거가 stale 상태입니다", Details: map[string]any{"operation": operation}}
		}
		state := dynamicOperationState(operation)
		if state == "unknown" {
			return &CLIError{Status: http.StatusConflict, Code: "OperationStateUnknown", Message: "operation 상태를 확인할 수 없습니다", Details: map[string]any{"operation": operation}}
		}
		if dynamicOperationFailed(state) {
			return &CLIError{Status: http.StatusConflict, Code: "OperationFailed", Message: "operation이 실패 terminal state에 도달했습니다: " + state, Details: map[string]any{"operation": operation}}
		}
		completed, completionErr := canonicalOperationCompleted(operation)
		if completionErr != nil {
			return completionErr
		}
		if completed {
			return renderOutput(cfg, out, response)
		}
		timer := time.NewTimer(interval)
		select {
		case <-pollContext.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return dynamicPollContextError(ctx, tool, timeout)
		case <-timer.C:
		}
	}
}

func dynamicPollContextError(parent context.Context, tool Tool, timeout time.Duration) error {
	if parent.Err() != nil {
		return &CLIError{Code: "OperationCanceled", Message: "operation watch가 취소되었습니다", Details: map[string]any{"toolId": tool.ID}}
	}
	return &CLIError{Status: http.StatusGatewayTimeout, Code: "OperationTimeout", Message: "operation watch timeout을 초과했습니다", Hint: timeout.String(), Details: map[string]any{"toolId": tool.ID}}
}

func dynamicOperationState(operation map[string]any) string {
	for _, key := range []string{"stage", "status", "state", "phase", "operationPhase"} {
		if value, ok := operation[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.ToLower(strings.TrimSpace(value))
		}
	}
	return ""
}

func dynamicOperationFailed(state string) bool {
	switch state {
	case "failed", "rejected", "cancelled", "canceled", "superseded", "error", "timedout", "timed_out":
		return true
	default:
		return false
	}
}

func canonicalOperationCompleted(operation map[string]any) (bool, error) {
	value, found := operation["completion"]
	if !found || value == nil {
		return false, nil
	}
	completion, ok := value.(map[string]any)
	if !ok {
		return false, operationEvidenceIncomplete(operation, "completion은 object여야 합니다")
	}
	stale, staleDeclared := completion["stale"].(bool)
	if staleDeclared && stale {
		return false, &CLIError{Status: http.StatusConflict, Code: "OperationEvidenceStale", Message: "operation completion receipt가 stale 상태입니다", Details: map[string]any{"operation": operation}}
	}
	terminalValue, terminalPresent := completion["terminal"]
	terminal, terminalDeclared := terminalValue.(bool)
	if !terminalPresent || !terminalDeclared {
		return false, operationEvidenceIncomplete(operation, "completion.terminal은 boolean이어야 합니다")
	}
	if !terminal {
		return false, nil
	}
	success, successDeclared := completion["success"].(bool)
	if successDeclared && !success {
		return false, &CLIError{Status: http.StatusConflict, Code: "OperationFailed", Message: "operation completion이 실패를 선언했습니다", Details: map[string]any{"operation": operation}}
	}
	verified, verifiedDeclared := completion["verified"].(bool)
	receipt, receiptDeclared := completion["receipt"]
	if !successDeclared || !success || !verifiedDeclared || !verified || !staleDeclared || stale || !receiptDeclared {
		return false, operationEvidenceIncomplete(operation, "terminal completion의 success/verified/stale/receipt 증거가 불완전합니다")
	}
	if err := validateCanonicalOperationReceipt(operation, completion, receipt); err != nil {
		return false, err
	}
	return true, nil
}

func operationEvidenceIncomplete(operation map[string]any, message string) error {
	return &CLIError{Status: http.StatusConflict, Code: "OperationEvidenceIncomplete", Message: message, Details: map[string]any{"operation": operation}}
}

func validateCanonicalOperationReceipt(operation, completion map[string]any, value any) error {
	receipt, ok := value.(map[string]any)
	if !ok || len(receipt) == 0 {
		return operationEvidenceIncomplete(operation, "completion.receipt는 non-empty object여야 합니다")
	}
	operationID, operationIDOK := nonEmptyString(operation["operationId"])
	receiptOperationID, receiptOperationIDOK := nonEmptyString(receipt["operationId"])
	if !operationIDOK || !receiptOperationIDOK || operationID != receiptOperationID {
		return operationEvidenceIncomplete(operation, "receipt.operationId가 상위 operationId와 일치해야 합니다")
	}
	if _, ok := nonEmptyString(receipt["verifierId"]); !ok {
		return operationEvidenceIncomplete(operation, "receipt.verifierId가 필요합니다")
	}
	verificationState, verificationStateOK := nonEmptyString(receipt["verificationState"])
	if !verificationStateOK || verificationState != "succeeded" {
		return operationEvidenceIncomplete(operation, "receipt.verificationState는 succeeded여야 합니다")
	}
	verifiedAt, verifiedAtOK := nonEmptyString(receipt["verifiedAt"])
	if !verifiedAtOK {
		return operationEvidenceIncomplete(operation, "receipt.verifiedAt이 필요합니다")
	}
	if _, err := time.Parse(time.RFC3339Nano, verifiedAt); err != nil {
		return operationEvidenceIncomplete(operation, "receipt.verifiedAt은 유효한 ISO timestamp여야 합니다")
	}
	semanticIdentity, ok := receipt["semanticIdentity"].(map[string]any)
	if !ok ||
		!matchesString(semanticIdentity, "capabilityId", "data.sql.postgres") ||
		!matchesString(semanticIdentity, "actionId", "cluster.create") ||
		!matchesString(semanticIdentity, "toolId", "foundation.postgres.apply") {
		return operationEvidenceIncomplete(operation, "receipt.semanticIdentity가 canonical PostgreSQL apply identity와 일치해야 합니다")
	}
	actionBinding, ok := receipt["actionBinding"].(map[string]any)
	if !ok ||
		!matchesString(actionBinding, "method", http.MethodPost) ||
		!matchesString(actionBinding, "path", "/api/foundation/osaa/postgres/durable-apply/{planId}") {
		return operationEvidenceIncomplete(operation, "receipt.actionBinding이 canonical durable apply binding과 일치해야 합니다")
	}
	ownerRevision, ownerRevisionOK := nonEmptyString(receipt["ownerEvidenceRevision"])
	completionRevision, completionRevisionOK := nonEmptyString(completion["evidenceRevision"])
	if !ownerRevisionOK || !completionRevisionOK || ownerRevision != completionRevision {
		return operationEvidenceIncomplete(operation, "receipt.ownerEvidenceRevision이 completion.evidenceRevision과 일치해야 합니다")
	}
	return nil
}

func nonEmptyString(value any) (string, bool) {
	text, ok := value.(string)
	text = strings.TrimSpace(text)
	return text, ok && text != ""
}

func matchesString(object map[string]any, key, expected string) bool {
	value, ok := nonEmptyString(object[key])
	return ok && value == expected
}

func missingInputsFromError(err error) *MissingInputsError {
	var missing *MissingInputsError
	if errors.As(err, &missing) {
		populateMissingInputActionPaths(missing)
		return missing
	}
	return nil
}
