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
	return validateToolManifestWithPFSSReleaseBinding(manifest, nil)
}

func validateToolManifestWithPFSSReleaseBinding(manifest ToolManifest, pfssBinding *pfssRegistryReleaseBinding) error {
	if strings.TrimSpace(manifest.Kind) == "" || len(manifest.Tools) == 0 {
		return commandContractError("CLI contribution manifest schema is invalid")
	}
	seenIDs := map[string]bool{}
	seenCommandPrefixes := map[string]bool{}
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
		prefix := normalizedCommandPrefix(tool.Command)
		if prefix == "" {
			return commandContractError("CLI contribution tool command prefix is required: " + tool.Command)
		}
		if seenCommandPrefixes[prefix] {
			return commandContractError("duplicate CLI contribution command prefix: " + prefix)
		}
		seenCommandPrefixes[prefix] = true
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
		if err := validatePostgresOwnerTool(tool); err != nil {
			return err
		}
	}
	if manifest.CapabilityID == "data.sql.postgres" || hasPostgresOwnerTools(manifest) {
		return validateFrozenPFSSManifest(manifest, pfssBinding)
	}
	return nil
}

func normalizedCommandPrefix(command string) string {
	words := strings.Fields(strings.ToLower(command))
	if len(words) > 0 && words[0] == "os" {
		words = words[1:]
	}
	if len(words) == 0 {
		return ""
	}
	prefix := make([]string, 0, len(words))
	for _, word := range words {
		if strings.HasPrefix(word, "--") || strings.HasPrefix(word, "<") || strings.HasPrefix(word, "(") {
			break
		}
		prefix = append(prefix, word)
	}
	return strings.Join(prefix, " ")
}

func isPostgresOwnerTool(tool Tool) bool {
	return tool.CapabilityID == "data.sql.postgres" ||
		(tool.SemanticIdentity != nil && tool.SemanticIdentity.CapabilityID == "data.sql.postgres")
}

func hasPostgresOwnerTools(manifest ToolManifest) bool {
	for _, tool := range manifest.Tools {
		if isPostgresOwnerTool(tool) {
			return true
		}
	}
	return false
}

// frozenPFSSPublishedTools is the release-bound v1 projection.  It is
// deliberately independent from an Owner-provided manifest: accepting a
// self-consistent extra route or lifecycle would turn this thin client into a
// second policy authority.  A new lifecycle requires an explicit CLI contract
// version and digest projection update.
type frozenPFSSPublishedTool struct {
	ID, ActionID, Command, Method, Path, Risk, Scope, Confirmation string
	PathParams                                                     []string
	ExplicitAction                                                 bool
}

var frozenPFSSPublishedTools = []frozenPFSSPublishedTool{
	{ID: "foundation.capabilities", ActionID: "capability.read", Command: "os foundation capabilities", Method: http.MethodGet, Path: "/api/foundation/oaa/postgres/capabilities", Risk: "R0"},
	{ID: "foundation.readiness", ActionID: "readiness.read", Command: "os foundation readiness", Method: http.MethodGet, Path: "/api/foundation/oaa/postgres/readiness", Risk: "R0"},
	{ID: "foundation.postgres.catalog", ActionID: "catalog.read", Command: "os foundation postgres catalog", Method: http.MethodGet, Path: "/api/foundation/oaa/postgres/catalog", Risk: "R0"},
	{ID: "foundation.postgres.plan.create", ActionID: "cluster.plan", Command: "os foundation postgres plan create", Method: http.MethodPost, Path: "/api/foundation/oaa/postgres/durable-plan", Risk: "R2", Scope: "write-plan"},
	{ID: "foundation.postgres.apply", ActionID: "cluster.create", Command: "os foundation postgres apply <planId>", Method: http.MethodPost, Path: "/api/foundation/oaa/postgres/durable-apply/{planId}", Risk: "R2", PathParams: []string{"planId"}, Confirmation: "exact-confirmation", ExplicitAction: true},
	{ID: "foundation.postgres.status", ActionID: "cluster.status", Command: "os foundation postgres status <namespace> <name>", Method: http.MethodGet, Path: "/api/foundation/oaa/postgres/claims/{namespace}/{name}", Risk: "R0", PathParams: []string{"namespace", "name"}},
	{ID: "foundation.operation.watch", ActionID: "operation.watch", Command: "os foundation operation watch <operationId>", Method: http.MethodGet, Path: "/api/foundation/oaa/operations/{operationId}", Risk: "R0", PathParams: []string{"operationId"}},
}

type pfssRegistryReleaseBinding struct {
	PluginID        string
	KeyID           string
	ManifestSHA256  string
	InstalledDigest string
	SourceRevision  string
}

// expectedPFSSRegistryReleaseBinding closes PFSS discovery over the verified
// installed Registry entry, rather than accepting release identity asserted by
// the fetched Owner manifest itself.
func expectedPFSSRegistryReleaseBinding(registry Registry, item RegistryItem, actualManifestSHA256 string) (*pfssRegistryReleaseBinding, error) {
	if item.ID != "foundation" || !item.Available || item.CLI == nil || item.CLI.Namespace != "foundation" ||
		!validLowerHex(item.ManifestSHA256, 64) || !validSHA256Digest(item.InstalledDigest) ||
		!validLowerHex(item.SourceRevision, 40) || strings.TrimSpace(item.KeyID) == "" ||
		item.ManifestSHA256 != actualManifestSHA256 {
		return nil, commandContractError("PFSS Registry release identity is missing, malformed, or does not match the fetched manifest")
	}
	if _, trusted := registry.TrustedKeys[item.KeyID]; !trusted {
		return nil, commandContractError("PFSS Registry release key is not trusted: " + item.KeyID)
	}
	return &pfssRegistryReleaseBinding{
		PluginID: item.ID, KeyID: item.KeyID, ManifestSHA256: item.ManifestSHA256,
		InstalledDigest: item.InstalledDigest, SourceRevision: item.SourceRevision,
	}, nil
}

func validateFrozenPFSSManifest(manifest ToolManifest, pfssBinding *pfssRegistryReleaseBinding) error {
	if manifest.Kind != "OpenSphereCLICommandManifest" || manifest.SchemaVersion != "v1" ||
		manifest.CapabilityID != "data.sql.postgres" || manifest.ContractVersion != "v1" ||
		!validLowerHex(manifest.SourceRevision, 40) {
		return commandContractError("PFSS Owner manifest is not the release-bound v1 projection")
	}
	if pfssBinding == nil || pfssBinding.PluginID != "foundation" || manifest.SourceRevision != pfssBinding.SourceRevision {
		return commandContractError("PFSS Owner manifest sourceRevision does not match the verified Foundation Registry release")
	}
	// The live Owner manifest does not yet publish descriptor/release digest
	// fields backed by Registry authority.  Reject self-claimed values instead
	// of treating them as release evidence; their introduction requires matching
	// verified Registry fields and an explicit contract projection update.
	if manifest.DescriptorDigest != "" || manifest.ReleaseDigest != "" {
		return commandContractError("PFSS Owner manifest supplies unverified descriptor/release digest fields")
	}
	if len(manifest.Tools) != len(frozenPFSSPublishedTools) {
		return commandContractError("PFSS Owner manifest must publish exactly the frozen v1 seven actions")
	}
	expected := make(map[string]frozenPFSSPublishedTool, len(frozenPFSSPublishedTools))
	for _, tool := range frozenPFSSPublishedTools {
		expected[tool.ActionID] = tool
	}
	for _, tool := range manifest.Tools {
		published, ok := expected[tool.ActionID]
		if !ok || tool.ID != published.ID || tool.Command != published.Command ||
			tool.Method != published.Method || tool.Path != published.Path || tool.Risk != published.Risk ||
			tool.Scope != published.Scope || tool.ExplicitAction != published.ExplicitAction ||
			!sameStringSlice(tool.PathParams, published.PathParams) || tool.RequestType != "Instance" ||
			tool.ContractVersion != "v1" || tool.SourceRevision != manifest.SourceRevision ||
			tool.CapabilityID != "data.sql.postgres" || tool.SemanticIdentity == nil ||
			tool.SemanticIdentity.ActionID != published.ActionID || tool.SemanticIdentity.CapabilityID != "data.sql.postgres" ||
			tool.SemanticIdentity.RequestType != "Instance" || tool.SemanticIdentity.ToolID != published.ID ||
			!matchesFrozenPFSSActionBinding(tool.ActionBinding, published) {
			return commandContractError("PFSS Owner tool does not match the release-bound v1 action tuple: " + tool.Command)
		}
		delete(expected, tool.ActionID)
	}
	if len(expected) != 0 {
		return commandContractError("PFSS Owner manifest omits a release-bound v1 action")
	}
	return nil
}

func matchesFrozenPFSSActionBinding(binding map[string]any, published frozenPFSSPublishedTool) bool {
	if binding == nil || len(binding) != 2+boolCount(len(published.PathParams) > 0)+boolCount(published.Confirmation != "") {
		return false
	}
	method, methodOK := actionBindingString(binding, "method")
	path, pathOK := actionBindingString(binding, "path")
	if !methodOK || !pathOK || method != published.Method || path != published.Path ||
		!sameStringSlice(actionBindingStringSlice(binding, "pathParams"), published.PathParams) {
		return false
	}
	confirmation, confirmationOK := actionBindingString(binding, "approval")
	return (published.Confirmation == "" && !confirmationOK) || (published.Confirmation != "" && confirmationOK && confirmation == published.Confirmation)
}

func boolCount(value bool) int {
	if value {
		return 1
	}
	return 0
}

func validLowerHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func validSHA256Digest(value string) bool {
	return strings.HasPrefix(value, "sha256:") && validLowerHex(strings.TrimPrefix(value, "sha256:"), 64)
}

// PFSS writes are only safe when the Owner supplies a closed schema. In
// particular, do not fall back to legacy arbitrary --key value forwarding for
// a plan or apply action, because that would turn the CLI into a second
// PostgreSQL policy surface.
func validatePostgresOwnerTool(tool Tool) error {
	if !isPostgresOwnerTool(tool) {
		return nil
	}
	identity := tool.SemanticIdentity
	if identity == nil || strings.TrimSpace(tool.ActionID) == "" || strings.TrimSpace(tool.CapabilityID) == "" ||
		identity.ActionID != tool.ActionID || identity.CapabilityID != tool.CapabilityID ||
		identity.RequestType != tool.RequestType || identity.ToolID != tool.ID {
		return commandContractError("PFSS owner semanticIdentity is incomplete or does not match its tool: " + tool.Command)
	}
	method, methodOK := actionBindingString(tool.ActionBinding, "method")
	path, pathOK := actionBindingString(tool.ActionBinding, "path")
	if !methodOK || !pathOK || !strings.EqualFold(method, tool.Method) || path != tool.Path ||
		!sameStringSlice(actionBindingStringSlice(tool.ActionBinding, "pathParams"), tool.PathParams) {
		return commandContractError("PFSS owner actionBinding does not match its command route: " + tool.Command)
	}
	if !strings.EqualFold(method, http.MethodGet) {
		if err := validateClosedPFSSInputSchema(tool.InputSchema, tool.Command+" inputSchema"); err != nil {
			return err
		}
	}
	return nil
}

func validateClosedPFSSInputSchema(schema *ToolInputSchema, location string) error {
	if schema == nil || schema.Type != "object" {
		return commandContractError("PFSS mutation requires a closed object inputSchema: " + location)
	}
	return validateClosedPFSSSchemaNode(schema, location)
}

func validateClosedPFSSSchemaNode(schema *ToolInputSchema, location string) error {
	if schema == nil {
		return commandContractError("PFSS inputSchema node is invalid: " + location)
	}
	switch schema.Type {
	case "object":
		if schema.AdditionalProperties == nil || *schema.AdditionalProperties {
			return commandContractError("PFSS inputSchema object must set additionalProperties:false: " + location)
		}
		for name, property := range schema.Properties {
			if err := validateClosedPFSSSchemaNode(property, location+"."+name); err != nil {
				return err
			}
		}
	case "array":
		if schema.Items != nil {
			return validateClosedPFSSSchemaNode(schema.Items, location+"[]")
		}
	}
	return nil
}

func actionBindingString(binding map[string]any, key string) (string, bool) {
	value, ok := binding[key]
	text, textOK := value.(string)
	text = strings.TrimSpace(text)
	return text, ok && textOK && text != ""
}

func actionBindingStringSlice(binding map[string]any, key string) []string {
	value, ok := binding[key]
	if !ok || value == nil {
		return nil
	}
	raw, ok := value.([]any)
	if !ok {
		return []string{"<invalid>"}
	}
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		text, ok := item.(string)
		if !ok || strings.TrimSpace(text) == "" {
			return []string{"<invalid>"}
		}
		result = append(result, text)
	}
	return result
}

func sameStringSlice(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
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

type ownerReceiptAction struct {
	SemanticIdentity ToolSemanticIdentity
	Method           string
	Path             string
	PathParams       []string
	Approval         string
}

func ownerReceiptActions(manifest ToolManifest, pfssBinding *pfssRegistryReleaseBinding) ([]ownerReceiptAction, error) {
	if err := validateFrozenPFSSManifest(manifest, pfssBinding); err != nil {
		return nil, err
	}
	// The only v1 receipt-bearing mutation is the frozen cluster.create tuple.
	// Do not derive this set from a manifest: a self-consistent unpublished
	// update/delete action must not become receipt-verifiable by injection.
	return []ownerReceiptAction{canonicalCreateReceiptAction()}, nil
}

func watchDynamicOperation(ctx context.Context, cfg Config, tool Tool, target string, flags map[string]string, out io.Writer) error {
	return watchDynamicOperationWithActions(ctx, cfg, tool, []ownerReceiptAction{canonicalCreateReceiptAction()}, target, flags, out)
}

func canonicalCreateReceiptAction() ownerReceiptAction {
	return ownerReceiptAction{
		SemanticIdentity: ToolSemanticIdentity{ActionID: "cluster.create", CapabilityID: "data.sql.postgres", RequestType: "Instance", ToolID: "foundation.postgres.apply"},
		Method:           http.MethodPost, Path: "/api/foundation/oaa/postgres/durable-apply/{planId}", PathParams: []string{"planId"}, Approval: "exact-confirmation",
	}
}

func watchDynamicOperationWithActions(ctx context.Context, cfg Config, tool Tool, receiptActions []ownerReceiptAction, target string, flags map[string]string, out io.Writer) error {
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
		completed, completionErr := canonicalOperationCompletedForActions(operation, receiptActions)
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
	return canonicalOperationCompletedForActions(operation, []ownerReceiptAction{canonicalCreateReceiptAction()})
}

func canonicalOperationCompletedForActions(operation map[string]any, receiptActions []ownerReceiptAction) (bool, error) {
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
	if err := validateCanonicalOperationReceiptForActions(operation, completion, receipt, receiptActions); err != nil {
		return false, err
	}
	return true, nil
}

func operationEvidenceIncomplete(operation map[string]any, message string) error {
	return &CLIError{Status: http.StatusConflict, Code: "OperationEvidenceIncomplete", Message: message, Details: map[string]any{"operation": operation}}
}

func validateCanonicalOperationReceipt(operation, completion map[string]any, value any) error {
	return validateCanonicalOperationReceiptForActions(operation, completion, value, []ownerReceiptAction{canonicalCreateReceiptAction()})
}

func validateCanonicalOperationReceiptForActions(operation, completion map[string]any, value any, receiptActions []ownerReceiptAction) error {
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
	semanticIdentity, semanticOK := receipt["semanticIdentity"].(map[string]any)
	actionBinding, bindingOK := receipt["actionBinding"].(map[string]any)
	if !semanticOK || !bindingOK || !matchesPublishedReceiptAction(semanticIdentity, actionBinding, receiptActions) {
		return operationEvidenceIncomplete(operation, "receipt semanticIdentity/actionBinding이 Owner-published governed action과 일치해야 합니다")
	}
	ownerRevision, ownerRevisionOK := nonEmptyString(receipt["ownerEvidenceRevision"])
	completionRevision, completionRevisionOK := nonEmptyString(completion["evidenceRevision"])
	if !ownerRevisionOK || !completionRevisionOK || ownerRevision != completionRevision {
		return operationEvidenceIncomplete(operation, "receipt.ownerEvidenceRevision이 completion.evidenceRevision과 일치해야 합니다")
	}
	if message := validateV1ReceiptEvidenceBinding(operation, receipt); message != "" {
		return operationEvidenceIncomplete(operation, message)
	}
	return nil
}

// A v1 receipt is evidence, not a bag of advisory strings.  The operation and
// receipt must each carry the same structured plan/action, actor, fencing and
// postcondition evidence so a terminal watch cannot silently drop a binding.
func validateV1ReceiptEvidenceBinding(operation, receipt map[string]any) string {
	for _, field := range []string{"planDigest", "actionDigest"} {
		operationValue, operationOK := nonEmptyString(operation[field])
		receiptValue, receiptOK := nonEmptyString(receipt[field])
		if !operationOK || !receiptOK || !validSHA256Digest(operationValue) || operationValue != receiptValue {
			return "receipt." + field + "가 operation과 일치하는 sha256 digest여야 합니다"
		}
	}
	for _, field := range []string{"actor", "fencing", "postcondition"} {
		operationValue, operationOK := operation[field].(map[string]any)
		receiptValue, receiptOK := receipt[field].(map[string]any)
		if !operationOK || !receiptOK || !validV1ReceiptEvidenceObject(field, operationValue) || !validV1ReceiptEvidenceObject(field, receiptValue) || !sameJSONValue(operationValue, receiptValue) {
			return "receipt." + field + "가 operation의 구조적 evidence binding과 일치해야 합니다"
		}
	}
	return ""
}

func validV1ReceiptEvidenceObject(field string, value map[string]any) bool {
	switch field {
	case "actor":
		_, idOK := nonEmptyString(value["id"])
		_, bindingOK := nonEmptyString(value["binding"])
		return idOK && bindingOK
	case "fencing":
		_, tokenOK := nonEmptyString(value["token"])
		return tokenOK
	case "postcondition":
		_, targetOK := nonEmptyString(value["targetUid"])
		_, versionOK := nonEmptyString(value["resourceVersion"])
		return targetOK && versionOK && positiveInteger(value["generation"])
	default:
		return false
	}
}

func positiveInteger(value any) bool {
	switch number := value.(type) {
	case int:
		return number > 0
	case int64:
		return number > 0
	case float64:
		return number > 0 && number == float64(int64(number))
	case json.Number:
		parsed, err := number.Int64()
		return err == nil && parsed > 0
	default:
		return false
	}
}

func sameJSONValue(left, right any) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftJSON) == string(rightJSON)
}

func matchesPublishedReceiptAction(identity, binding map[string]any, actions []ownerReceiptAction) bool {
	for _, action := range actions {
		if matchesString(identity, "capabilityId", action.SemanticIdentity.CapabilityID) &&
			matchesString(identity, "actionId", action.SemanticIdentity.ActionID) &&
			matchesString(identity, "requestType", action.SemanticIdentity.RequestType) &&
			matchesString(identity, "toolId", action.SemanticIdentity.ToolID) &&
			matchesString(binding, "method", action.Method) &&
			matchesString(binding, "path", action.Path) &&
			sameStringSlice(actionBindingStringSlice(binding, "pathParams"), action.PathParams) {
			approval, _ := actionBindingString(binding, "approval")
			if approval == action.Approval {
				return true
			}
		}
	}
	return false
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
