package main

import (
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
)

// UsageError marks invalid command syntax. It is deliberately typed so exit
// codes do not depend on localized error-message text.
type UsageError struct {
	Message string
}

func (e *UsageError) Error() string { return strings.TrimSpace(e.Message) }

func usageError(message string) error { return &UsageError{Message: message} }

func usageErrorf(format string, values ...any) error {
	return &UsageError{Message: fmt.Sprintf(format, values...)}
}

type commandDefinition struct {
	Name    string
	Summary string
	Usage   []string
	Options []string
}

type commandArity struct {
	Min int
	Max int
}

var commandDefinitions = []commandDefinition{
	{Name: "login", Summary: "브라우저 승인으로 관리자 장치 신뢰 등록", Usage: []string{"os login [--console URL] [--label DEVICE]"}, Options: []string{"--console URL", "--label DEVICE", "--registry URL", "--api URL", "--identity URL", "--web"}},
	{Name: "whoami", Summary: "현재 사용자·장치·역할 확인", Usage: []string{"os whoami"}},
	{Name: "logout", Summary: "서버 장치 신뢰와 로컬 보안 키 폐기", Usage: []string{"os logout"}},
	{Name: "status", Summary: "Platform Readiness 상태 조회", Usage: []string{"os status"}},
	{Name: "health", Summary: "doctor 호환 별칭", Usage: []string{"os health [--strict]"}, Options: []string{"--strict"}},
	{Name: "doctor", Summary: "인증·Registry·Supabase·Gitea·HIS·CRD 진단", Usage: []string{"os doctor [--strict]"}, Options: []string{"--strict"}},
	{Name: "describe", Summary: "플랫폼 구성요소 상세 조회", Usage: []string{"os describe platform|supabase|storage|gitea|observability|contracts|extensions"}},
	{Name: "events", Summary: "운영 이벤트 조회", Usage: []string{"os events [--filter key=value] [--sort-by key] [--desc] [--limit N]"}, Options: []string{"--filter key=value", "--sort-by key", "--desc", "--limit N"}},
	{Name: "device", Summary: "CLI 신뢰 장치 조회·폐기", Usage: []string{"os device list", "os device revoke <device-id> --reason <8자 이상 사유>"}, Options: []string{"--reason TEXT"}},
	{Name: "token", Summary: "최소권한 API token 조회·발급·폐기", Usage: []string{"os token list", "os token create --label NAME [--scope read|change|admin] [--ttl DURATION] --reason TEXT", "os token revoke <jti> --reason TEXT"}, Options: []string{"--label NAME", "--scope read|change|admin", "--ttl DURATION (5m~720h)", "--reason TEXT"}},
	{Name: "admin", Summary: "관리 사용자 수명주기 제어", Usage: []string{"os admin list", "os admin create --username ID --display-name NAME [--email ADDRESS] [--roles a,b] --reason TEXT", "os admin enable|disable|onboard <user-id> --reason TEXT"}, Options: []string{"--username ID", "--display-name NAME", "--email ADDRESS", "--roles a,b", "--reason TEXT"}},
	{Name: "registry", Summary: "Console Registry 조회", Usage: []string{"os registry [--kind capability|plugin|template]"}, Options: []string{"--kind TYPE"}},
	{Name: "catalog", Summary: "Catalog entity/API 조회", Usage: []string{"os catalog list|apis [--filter key=value] [--sort-by key] [--desc] [--limit N]"}, Options: []string{"--filter key=value", "--sort-by key", "--desc", "--limit N"}},
	{Name: "get", Summary: "Platform·Plugin 리소스 조회", Usage: []string{"os get <resource> [name]"}},
	{Name: "role", Summary: "역할 조회·부여·회수", Usage: []string{"os role list", "os role grant|revoke <user> <role> --reason TEXT"}, Options: []string{"--reason TEXT"}},
	{Name: "observability", Summary: "HIS 상태·target·PromQL 조회", Usage: []string{"os observability status|targets", "os observability query --expr PROMQL"}, Options: []string{"--expr PROMQL"}},
	{Name: "audit", Summary: "감사 이벤트 조회", Usage: []string{"os audit list"}},
	{Name: "extensions", Summary: "확장 패키지와 Binding 관리", Usage: []string{"os extensions install <repository:channel|@sha256:digest> --reason TEXT", "  기본 repository prefix: ghcr.io/opensphere-platform/", "os extensions inspect|activate|disable|uninstall|rollback|list ...", "os extensions bindings list|enable|disable ...", "os extensions registry status|login|logout ...", "os extensions revocations|revoke-image ..."}, Options: []string{"--reason TEXT", "--username NAME", "--token-stdin", "--replacement IMAGE"}},
	{Name: "plan", Summary: "검토 가능한 변경 plan 생성·조회·정리", Usage: []string{"os plan --consumer ID [--action apply|configure|rollback] [--target TARGET] --file desired.json --reason TEXT", "os plan list", "os plan show <plan-id>", "os plan delete <plan-id> --yes"}, Options: []string{"--consumer ID", "--action ACTION", "--target TARGET", "--file PATH", "--reason TEXT", "--offline", "--yes"}},
	{Name: "apply", Summary: "검증된 변경 plan 제출", Usage: []string{"os apply <plan-id|plan-file> [--wait] [--timeout 5m]"}, Options: []string{"--wait", "--timeout DURATION"}},
	{Name: "operation", Summary: "변경 operation 조회·감시·승인", Usage: []string{"os operation list [--filter key=value] [--sort-by key] [--desc] [--limit N]", "os operation get|watch <request-id> [--timeout DURATION]", "os operation approve <request-id> --reason TEXT"}, Options: []string{"--filter key=value", "--sort-by key", "--desc", "--limit N", "--timeout DURATION", "--reason TEXT"}},
	{Name: "rollback", Summary: "기존 요청의 rollback plan 생성", Usage: []string{"os rollback <request-id> --consumer ID [--target TARGET] --file desired.json --reason TEXT [--offline]"}, Options: []string{"--consumer ID", "--target TARGET", "--file PATH", "--reason TEXT", "--offline"}},
	{Name: "context", Summary: "로컬 Console context 사본·전환 관리", Usage: []string{"os context current|list", "os context save <name> (사본만 저장)", "os context use <name>", "os context delete <name> --yes"}, Options: []string{"--yes"}},
	{Name: "support-bundle", Summary: "비밀을 제거한 진단 bundle 생성", Usage: []string{"os support-bundle --file bundle.json [--force]"}, Options: []string{"--file PATH", "--force"}},
	{Name: "update", Summary: "동일 Console의 서명된 CLI release로 업데이트", Usage: []string{"os update [--check|--status] [--force]"}, Options: []string{"--check", "--status", "--force"}},
	{Name: "platform", Summary: "GHCR 채널의 서명된 Platform release 확인·계획·적용", Usage: []string{"os platform update check --channel edge|candidate|stable [--context NAME]", "os platform update plan --channel edge|candidate|stable [--context NAME]", "os platform update apply <plan-id> [--context NAME]"}, Options: []string{"--channel edge|candidate|stable", "--context NAME", "--registry-username GITHUB_LOGIN", "--registry-token-stdin"}},
	{Name: "completion", Summary: "shell completion 생성", Usage: []string{"os completion powershell|bash|zsh"}},
	{Name: "version", Summary: "CLI 버전 출력", Usage: []string{"os version"}},
	{Name: "backbone", Summary: "status/describe 호환 별칭", Usage: []string{"os backbone status", "os backbone detail --component supabase|storage|gitea"}, Options: []string{"--component NAME"}},
}

// A true value means the option consumes the next argument. Rules are keyed
// by the longest command/subcommand prefix and form the authoritative option
// allow-list for native commands.
var nativeOptionRules = map[string]map[string]bool{
	"login":                       {"console": true, "label": true, "registry": true, "api": true, "identity": true, "web": false},
	"whoami":                      {},
	"logout":                      {},
	"status":                      {},
	"health":                      {"strict": false},
	"doctor":                      {"strict": false},
	"describe":                    {},
	"events":                      listOptionRules(),
	"device":                      {},
	"device list":                 {},
	"device revoke":               {"reason": true},
	"token":                       {},
	"token list":                  {},
	"token create":                {"label": true, "scope": true, "ttl": true, "reason": true},
	"token revoke":                {"reason": true},
	"admin":                       {},
	"admin list":                  {},
	"admin create":                {"username": true, "display-name": true, "email": true, "roles": true, "reason": true},
	"admin enable":                {"reason": true},
	"admin disable":               {"reason": true},
	"admin onboard":               {"reason": true},
	"registry":                    {"kind": true},
	"catalog":                     {},
	"catalog list":                listOptionRules(),
	"catalog apis":                listOptionRules(),
	"get":                         {},
	"role":                        {},
	"role list":                   {},
	"role grant":                  {"reason": true},
	"role revoke":                 {"reason": true},
	"observability":               {},
	"observability status":        {},
	"observability targets":       {},
	"observability query":         {"expr": true},
	"audit":                       {},
	"audit list":                  {},
	"extensions":                  {},
	"extensions inspect":          {},
	"extensions install":          {"reason": true},
	"extensions activate":         {},
	"extensions disable":          {},
	"extensions uninstall":        {},
	"extensions rollback":         {},
	"extensions list":             {},
	"extensions bindings":         {},
	"extensions bindings list":    {},
	"extensions bindings enable":  {},
	"extensions bindings disable": {},
	"extensions registry":         {},
	"extensions registry status":  {},
	"extensions registry login":   {"username": true, "token-stdin": false, "reason": true},
	"extensions registry logout":  {"reason": true},
	"extensions revocations":      {},
	"extensions revoke-image":     {"replacement": true, "reason": true},
	"plan":                        {"consumer": true, "action": true, "target": true, "file": true, "reason": true, "offline": false},
	"plan list":                   {},
	"plan show":                   {},
	"plan delete":                 {"yes": false},
	"apply":                       {"wait": false, "timeout": true},
	"operation":                   {},
	"operation list":              listOptionRules(),
	"operation get":               {},
	"operation watch":             {"timeout": true},
	"operation approve":           {"reason": true},
	"rollback":                    {"consumer": true, "target": true, "file": true, "reason": true, "offline": false},
	"context":                     {},
	"context current":             {},
	"context list":                {},
	"context save":                {},
	"context use":                 {},
	"context delete":              {"yes": false},
	"support-bundle":              {"file": true, "force": false},
	"update":                      {"check": false, "status": false, "force": false},
	"platform":                    {},
	"platform update":             {},
	"platform update check":       {"channel": true, "context": true, "registry-username": true, "registry-token-stdin": false},
	"platform update plan":        {"channel": true, "context": true, "registry-username": true, "registry-token-stdin": false},
	"platform update apply":       {"context": true, "registry-username": true, "registry-token-stdin": false},
	"completion":                  {},
	"version":                     {},
	"backbone":                    {},
	"backbone status":             {},
	"backbone detail":             {"component": true},
}

var nativeArityRules = map[string]commandArity{
	"login": {0, 0}, "whoami": {0, 0}, "logout": {0, 0}, "status": {0, 0}, "health": {0, 0}, "doctor": {0, 0},
	"describe": {1, 1}, "events": {0, 0}, "registry": {0, 0}, "get": {1, 2}, "plan": {0, 0}, "plan list": {0, 0}, "plan show": {1, 1}, "plan delete": {1, 1}, "apply": {1, 1},
	"rollback": {1, 1}, "support-bundle": {0, 0}, "update": {0, 0}, "completion": {1, 1}, "version": {0, 0},
	"platform": {2, 2}, "platform update": {1, 1}, "platform update check": {0, 0}, "platform update plan": {0, 0}, "platform update apply": {1, 1},
	"device": {0, 1}, "device list": {0, 0}, "device revoke": {1, 1},
	"token": {1, 1}, "token list": {0, 0}, "token create": {0, 0}, "token revoke": {1, 1},
	"admin": {0, 1}, "admin list": {0, 0}, "admin create": {0, 0}, "admin enable": {1, 1}, "admin disable": {1, 1}, "admin onboard": {1, 1},
	"catalog": {0, 1}, "catalog list": {0, 0}, "catalog apis": {0, 0},
	"role": {1, 1}, "role list": {0, 0}, "role grant": {2, 2}, "role revoke": {2, 2},
	"observability": {0, 1}, "observability status": {0, 0}, "observability targets": {0, 0}, "observability query": {0, 0},
	"audit": {0, 1}, "audit list": {0, 0},
	"backbone": {0, 1}, "backbone status": {0, 0}, "backbone detail": {0, 0},
	"operation": {0, 1}, "operation list": {0, 0}, "operation get": {1, 1}, "operation watch": {1, 1}, "operation approve": {1, 1},
	"context": {0, 1}, "context current": {0, 0}, "context list": {0, 0}, "context save": {1, 1}, "context use": {1, 1}, "context delete": {1, 1},
	"extensions": {1, 1}, "extensions inspect": {1, 1}, "extensions install": {1, 1}, "extensions activate": {1, 1},
	"extensions disable": {1, 1}, "extensions uninstall": {1, 1}, "extensions rollback": {1, 1}, "extensions list": {0, 0},
	"extensions bindings": {0, 1}, "extensions bindings list": {0, 0}, "extensions bindings enable": {1, 1}, "extensions bindings disable": {1, 1},
	"extensions registry": {0, 1}, "extensions registry status": {0, 0}, "extensions registry login": {0, 0}, "extensions registry logout": {0, 0},
	"extensions revocations": {0, 0}, "extensions revoke-image": {1, 1},
}

func listOptionRules() map[string]bool {
	return map[string]bool{"filter": true, "sort-by": true, "desc": false, "limit": true}
}

func nativeCommandDefinition(name string) (commandDefinition, bool) {
	for _, definition := range commandDefinitions {
		if definition.Name == name {
			return definition, true
		}
	}
	return commandDefinition{}, false
}

func hasHelpFlag(args []string) bool {
	for _, arg := range args {
		if arg == "--help" || arg == "-h" {
			return true
		}
	}
	return false
}

func printCommandHelp(out io.Writer, args []string) error {
	if len(args) == 0 {
		printRootHelp(out)
		return nil
	}
	definition, ok := nativeCommandDefinition(strings.ToLower(args[0]))
	if !ok {
		return usageErrorf("알 수 없는 native 명령 %q; 'os help'로 명령 목록을 확인하세요", args[0])
	}
	fmt.Fprintf(out, "os %s — %s\n\n사용법:\n", definition.Name, definition.Summary)
	for _, usage := range definition.Usage {
		fmt.Fprintln(out, "  "+usage)
	}
	if len(definition.Options) > 0 {
		fmt.Fprintln(out, "\n옵션:")
		for _, option := range definition.Options {
			fmt.Fprintln(out, "  "+option)
		}
	}
	fmt.Fprintln(out, "\n공통 출력 옵션: -o|--output table|json|yaml")
	return nil
}

func printRootHelp(out io.Writer) {
	fmt.Fprintln(out, "os — OpenSphere Console native 관리자 CLI")
	fmt.Fprintln(out, "\n사용법: os <command> [arguments] [-o table|json|yaml]")
	fmt.Fprintln(out, "\n명령:")
	for _, definition := range commandDefinitions {
		fmt.Fprintf(out, "  %-16s %s\n", definition.Name, definition.Summary)
	}
	fmt.Fprintln(out, "\n'os <command> --help'로 명령별 사용법을 확인하세요.")
	fmt.Fprintln(out, "보안 모델: Supabase RBAC을 매 요청 확인하는 admin 디바이스 신뢰 + 15분 서명 세션")
	fmt.Fprintln(out, "확장 설치: os extensions install ... (승인 사유 필수)")
	fmt.Fprintln(out, "향후 workforce 자동화는 승인된 CLI Binding으로 관리자 장치와 분리합니다.")
	fmt.Fprintln(out, "설정 ~/.os/config.json(비밀 없음) · 보안키 Windows DPAPI/macOS Keychain/Linux Secret Service")
}

func completionCommandNames() []string {
	names := make([]string, 0, len(commandDefinitions)+1)
	for _, definition := range commandDefinitions {
		names = append(names, definition.Name)
	}
	names = append(names, "help")
	sort.Strings(names)
	return names
}

func validateNativeCommandOptions(args []string) error {
	if len(args) == 0 {
		return nil
	}
	if _, known := nativeCommandDefinition(strings.ToLower(args[0])); !known {
		return nil // Dynamic CLI Binding namespaces define their own options.
	}
	ruleKey, rules := nativeRuleFor(args)
	prefixLength := len(strings.Fields(ruleKey))
	positionals := 0
	seenOptions := map[string]bool{}
	for index := prefixLength; index < len(args); index++ {
		arg := args[index]
		if !strings.HasPrefix(arg, "-") {
			positionals++
			continue
		}
		if !strings.HasPrefix(arg, "--") || arg == "--" {
			return usageErrorf("알 수 없는 옵션 %q; 'os %s --help'로 허용 옵션을 확인하세요", arg, args[0])
		}
		nameValue := strings.TrimPrefix(arg, "--")
		name := nameValue
		inlineValue := ""
		hasInlineValue := false
		if parts := strings.SplitN(nameValue, "=", 2); len(parts) == 2 {
			name, inlineValue, hasInlineValue = parts[0], parts[1], true
		}
		requiresValue, allowed := rules[name]
		if !allowed {
			return usageErrorf("알 수 없는 옵션 --%s; 'os %s --help'로 허용 옵션을 확인하세요", name, args[0])
		}
		if seenOptions[name] {
			return usageErrorf("--%s 옵션을 두 번 지정할 수 없습니다", name)
		}
		seenOptions[name] = true
		if !requiresValue && hasInlineValue {
			return usageErrorf("--%s는 값을 받지 않는 boolean 옵션입니다", name)
		}
		if requiresValue {
			if hasInlineValue {
				if strings.TrimSpace(inlineValue) == "" {
					return usageErrorf("--%s 옵션 값이 필요합니다", name)
				}
				if err := validateNativeOptionValue(name, inlineValue); err != nil {
					return err
				}
				continue
			}
			if index+1 >= len(args) || strings.HasPrefix(args[index+1], "--") {
				return usageErrorf("--%s 옵션 값이 필요합니다", name)
			}
			if err := validateNativeOptionValue(name, args[index+1]); err != nil {
				return err
			}
			index++
		}
	}
	if arity, ok := nativeArityRules[ruleKey]; ok && (positionals < arity.Min || positionals > arity.Max) {
		definition, _ := nativeCommandDefinition(strings.ToLower(args[0]))
		return usageError("사용법: " + strings.Join(definition.Usage, " | "))
	}
	return nil
}

func validateNativeOptionValue(name, value string) error {
	switch name {
	case "limit":
		limit, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || limit < 1 || limit > 1000 {
			return usageError("--limit은 1..1000 범위여야 합니다")
		}
	case "timeout":
		duration, err := time.ParseDuration(strings.TrimSpace(value))
		if err != nil || duration < time.Second || duration > 24*time.Hour {
			return usageError("--timeout은 1초 이상 24시간 이하의 duration이어야 합니다(예: 30s, 5m)")
		}
	case "filter":
		parts := strings.SplitN(value, "=", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" {
			return usageError("--filter는 key=value 형식이어야 합니다")
		}
	case "kind":
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "capability", "plugin", "template":
		default:
			return usageError("--kind는 capability, plugin, template 중 하나여야 합니다")
		}
	case "channel":
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "edge", "candidate", "stable":
		default:
			return usageError("--channel은 edge, candidate, stable 중 하나여야 합니다")
		}
	case "context":
		value = strings.TrimSpace(value)
		if len(value) < 1 || len(value) > 253 {
			return usageError("--context는 1..253자 Kubernetes context여야 합니다")
		}
		for _, r := range value {
			if (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9') && !strings.ContainsRune("._:@/-", r) {
				return usageError("--context는 영문자·숫자와 ._:@/-만 사용할 수 있습니다")
			}
		}
	case "registry-username":
		value = strings.TrimSpace(value)
		if len(value) < 1 || len(value) > 39 {
			return usageError("--registry-username은 1..39자 GitHub 사용자명이어야 합니다")
		}
		for index, r := range value {
			if (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9') && (r != '-' || index == 0) {
				return usageError("--registry-username은 영문자·숫자로 시작하고 하이픈만 추가로 사용할 수 있습니다")
			}
		}
	}
	return nil
}

func nativeRuleFor(args []string) (string, map[string]bool) {
	max := len(args)
	if max > 3 {
		max = 3
	}
	for count := max; count >= 1; count-- {
		words := make([]string, 0, count)
		valid := true
		for _, arg := range args[:count] {
			if strings.HasPrefix(arg, "-") {
				valid = false
				break
			}
			words = append(words, strings.ToLower(arg))
		}
		if !valid {
			continue
		}
		if rules, ok := nativeOptionRules[strings.Join(words, " ")]; ok {
			return strings.Join(words, " "), rules
		}
	}
	key := strings.ToLower(args[0])
	return key, nativeOptionRules[key]
}
