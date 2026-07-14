package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

var configKeys = map[string]func(*Config) *string{
	"profile":     func(c *Config) *string { return &c.Profile },
	"kind":        func(c *Config) *string { return &c.Kind },
	"deviceId":    func(c *Config) *string { return &c.DeviceID },
	"deviceLabel": func(c *Config) *string { return &c.DeviceLabel },
	"registryUrl": func(c *Config) *string { return &c.RegistryURL },
	"apiUrl":      func(c *Config) *string { return &c.APIURL },
	"bffUrl":      func(c *Config) *string { return &c.BFFURL },
	"consoleUrl":  func(c *Config) *string { return &c.ConsoleURL },
	"caBundle":    func(c *Config) *string { return &c.CABundle },
}

func configCommand(args []string, out io.Writer) error {
	return configCommandFor("", args, out)
}

func configCommandFor(selectedProfile string, args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("사용법: os config get [key] | set <key> <value> | list | profiles | use-profile <name>")
	}
	if args[0] == "profiles" {
		if len(args) != 1 {
			return errors.New("사용법: os config profiles")
		}
		file, err := readConfigFile()
		if err != nil {
			return err
		}
		names := make([]string, 0, len(file.Profiles))
		for name := range file.Profiles {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			marker := " "
			if name == file.CurrentProfile {
				marker = "*"
			}
			fmt.Fprintf(out, "%s %s\n", marker, name)
		}
		return nil
	}
	if args[0] == "use-profile" {
		if len(args) != 2 {
			return errors.New("사용법: os config use-profile <name>")
		}
		if !validProfileName(args[1]) {
			return fmt.Errorf("허용되지 않은 프로파일 이름 %q", args[1])
		}
		file, err := readConfigFile()
		if err != nil {
			return err
		}
		if _, ok := file.Profiles[args[1]]; !ok {
			return fmt.Errorf("프로파일 %q을(를) 찾을 수 없습니다", args[1])
		}
		file.CurrentProfile = args[1]
		return writeConfigFile(file, out)
	}
	cfg, err := loadConfigFor(selectedProfile)
	if err != nil {
		if args[0] != "set" || selectedProfile == "" {
			return err
		}
		cfg = defaults()
		cfg.profileName = selectedProfile
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

func readConfigFile() (ConfigFile, error) {
	p, err := configPath()
	if err != nil {
		return ConfigFile{}, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		cfg := defaults()
		return ConfigFile{Config: cfg, CurrentProfile: "default", Profiles: map[string]Config{"default": cfg}}, nil
	}
	if err != nil {
		return ConfigFile{}, err
	}
	var file ConfigFile
	if err := json.Unmarshal(b, &file); err != nil {
		return file, fmt.Errorf("설정 파싱 실패: %w", err)
	}
	if len(file.Profiles) == 0 {
		var legacy Config
		if err := json.Unmarshal(b, &legacy); err != nil {
			return file, err
		}
		file.CurrentProfile = "default"
		file.Profiles = map[string]Config{"default": legacy}
	}
	if file.CurrentProfile == "" {
		file.CurrentProfile = "default"
	}
	return file, nil
}

func writeConfigFile(file ConfigFile, out io.Writer) error {
	file.Config = file.Profiles[file.CurrentProfile]
	p, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(p, append(b, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Chmod(p, 0o600); err != nil {
		return err
	}
	fmt.Fprintf(out, "currentProfile=%s\n", file.CurrentProfile)
	return nil
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
var commonFlags = []string{"--help", "--output", "-o", "--query", "--limit", "--all", "--ca-bundle", "--profile"}

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
