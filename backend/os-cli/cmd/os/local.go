package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

var configKeys = map[string]func(*Config) *string{
	"profile":     func(c *Config) *string { return &c.Profile },
	"deviceId":    func(c *Config) *string { return &c.DeviceID },
	"deviceLabel": func(c *Config) *string { return &c.DeviceLabel },
	"registryUrl": func(c *Config) *string { return &c.RegistryURL },
	"apiUrl":      func(c *Config) *string { return &c.APIURL },
	"bffUrl":      func(c *Config) *string { return &c.BFFURL },
	"consoleUrl":  func(c *Config) *string { return &c.ConsoleURL },
	"caBundle":    func(c *Config) *string { return &c.CABundle },
}

func configCommand(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("사용법: os config get [key] | set <key> <value> | list")
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	switch args[0] {
	case "get":
		if len(args) == 1 {
			return printConfig(out, cfg)
		}
		if len(args) != 2 {
			return errors.New("사용법: os config get [key]")
		}
		field, ok := configKeys[args[1]]
		if !ok {
			return unknownConfigKey(args[1])
		}
		fmt.Fprintln(out, *field(&cfg))
		return nil
	case "list":
		if len(args) != 1 {
			return errors.New("사용법: os config list")
		}
		return printConfig(out, cfg)
	case "set":
		if len(args) != 3 {
			return errors.New("사용법: os config set <key> <value>")
		}
		field, ok := configKeys[args[1]]
		if !ok {
			return unknownConfigKey(args[1])
		}
		*field(&cfg) = args[2]
		if err := saveConfig(cfg); err != nil {
			return err
		}
		fmt.Fprintf(out, "%s=%s\n", args[1], args[2])
		return nil
	default:
		return fmt.Errorf("알 수 없는 config 하위명령: %s", args[0])
	}
}

func printConfig(out io.Writer, cfg Config) error {
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, string(b))
	return err
}

func unknownConfigKey(key string) error {
	return fmt.Errorf("알 수 없거나 비밀인 config key %q", key)
}

var topLevelCommands = []string{"login", "logout", "whoami", "device", "registry", "get", "role", "extensions", "setup", "config", "completion", "token", "auth-policy", "admin", "catalog", "backbone", "observability", "audit", "version", "help"}
var commonFlags = []string{"--help", "--output", "-o", "--query", "--limit", "--all", "--ca-bundle"}

func completion(args []string, out io.Writer) error {
	if len(args) != 1 {
		return errors.New("사용법: os completion bash|zsh|powershell")
	}
	commands, flags := strings.Join(topLevelCommands, " "), strings.Join(commonFlags, " ")
	switch args[0] {
	case "bash":
		fmt.Fprintf(out, "_os_complete() { COMPREPLY=( $(compgen -W %s -- \"${COMP_WORDS[COMP_CWORD]}\") ); }\ncomplete -F _os_complete os\n", strconv.Quote(commands+" "+flags))
	case "zsh":
		fmt.Fprintf(out, "#compdef os\n_arguments '*:command:(%s %s)'\n", commands, flags)
	case "powershell":
		fmt.Fprintf(out, "Register-ArgumentCompleter -Native -CommandName os -ScriptBlock { param($wordToComplete) '%s %s'.Split(' ') | Where-Object { $_ -like \"$wordToComplete*\" } }\n", commands, flags)
	default:
		return fmt.Errorf("지원하지 않는 shell %q; bash, zsh, powershell 중 하나를 사용하세요", args[0])
	}
	return nil
}
