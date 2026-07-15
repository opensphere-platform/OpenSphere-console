package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Profile     string `json:"profile"`
	Kind        string `json:"kind,omitempty"`
	PAT         string `json:"-"` // process-memory only: OS_PAT or one-time enrollment bootstrap
	IDToken     string `json:"-"` // process-memory only: never persist bearer credentials
	DeviceID    string `json:"deviceId,omitempty"`
	DeviceLabel string `json:"deviceLabel,omitempty"`
	RegistryURL string `json:"registryUrl"`
	APIURL      string `json:"apiUrl"`
	BFFURL      string `json:"bffUrl"`
	ConsoleURL  string `json:"consoleUrl"`
	CABundle    string `json:"caBundle,omitempty"`
	profileName string `json:"-"`
}

type ConfigFile struct {
	Config
	CurrentProfile string            `json:"currentProfile"`
	Profiles       map[string]Config `json:"profiles"`
}

func defaults() Config {
	console := env("OS_CONSOLE", "http://localhost:8090")
	return Config{
		Profile:     "admin",
		Kind:        "admin",
		PAT:         os.Getenv("OS_PAT"),
		IDToken:     os.Getenv("OS_ID_TOKEN"),
		RegistryURL: env("OS_REGISTRY", console+"/api/v1/registry"),
		APIURL:      env("OS_API", console+"/api/proxy"),
		BFFURL:      env("OS_BFF", console),
		ConsoleURL:  console,
		CABundle:    strings.TrimSpace(os.Getenv("OS_CACERT")),
	}
}

func env(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

func configPath() (string, error) {
	if p := strings.TrimSpace(os.Getenv("OS_CONFIG")); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".os", "config.json"), nil
}

func loadConfig() (Config, error) { return loadConfigFor("") }

func loadConfigFor(selected string) (Config, error) {
	cfg := defaults()
	p, err := configPath()
	if err != nil {
		return cfg, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		if selected == "" {
			selected = strings.TrimSpace(os.Getenv("OS_PROFILE"))
		}
		if selected == "" {
			selected = "default"
		}
		if !validProfileName(selected) {
			return cfg, fmt.Errorf("허용되지 않은 프로파일 이름 %q", selected)
		}
		cfg.profileName = selected
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	var file ConfigFile
	if err := json.Unmarshal(b, &file); err != nil {
		return cfg, fmt.Errorf("설정 파싱 실패: %w", err)
	}
	if len(file.Profiles) == 0 {
		if err := json.Unmarshal(b, &cfg); err != nil {
			return cfg, err
		}
		file.CurrentProfile = "default"
		file.Profiles = map[string]Config{"default": cfg}
	}
	if selected == "" {
		selected = strings.TrimSpace(os.Getenv("OS_PROFILE"))
	}
	if selected == "" {
		selected = file.CurrentProfile
	}
	if selected == "" {
		selected = "default"
	}
	if !validProfileName(selected) {
		return cfg, fmt.Errorf("허용되지 않은 프로파일 이름 %q", selected)
	}
	var ok bool
	cfg, ok = file.Profiles[selected]
	if !ok {
		return defaults(), fmt.Errorf("프로파일 %q을(를) 찾을 수 없습니다", selected)
	}
	cfg.profileName = selected
	if ca := strings.TrimSpace(os.Getenv("OS_CACERT")); ca != "" {
		cfg.CABundle = ca
	}
	// OS_PAT is a process-env override (like OS_CACERT) and must win for the
	// active profile; the profiles map never carries PAT (json:"-").
	if pat := strings.TrimSpace(os.Getenv("OS_PAT")); pat != "" {
		cfg.PAT = pat
	}
	if cfg.Profile == "" {
		cfg.Profile = "admin"
	}
	if cfg.Kind == "" {
		cfg.Kind = cfg.Profile
	}
	if cfg.Kind == "" {
		cfg.Kind = "admin"
	}
	// Legacy config could contain year-long PAT/idToken fields. They are deliberately
	// ignored rather than loaded back into memory; `os login` performs one-time device pairing.
	return cfg, nil
}

func saveConfig(cfg Config) error {
	if cfg.Kind == "" {
		cfg.Kind = cfg.Profile
	}
	if cfg.Kind == "" {
		cfg.Kind = "admin"
	}
	if cfg.Kind != "admin" && cfg.Kind != "workforce" {
		return fmt.Errorf("지원하지 않는 프로파일 kind %q", cfg.Kind)
	}
	if cfg.Kind == "admin" {
		cfg.Profile = "admin"
	}
	for _, raw := range []string{cfg.RegistryURL, cfg.APIURL, cfg.BFFURL, cfg.ConsoleURL} {
		if err := validateURL(raw); err != nil {
			return err
		}
	}
	p, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	defaultConfig := defaults()
	file := ConfigFile{}
	if existing, readErr := os.ReadFile(p); readErr == nil {
		if err := json.Unmarshal(existing, &file); err != nil {
			return fmt.Errorf("설정 파싱 실패: %w", err)
		}
		if len(file.Profiles) == 0 {
			var legacy Config
			if err := json.Unmarshal(existing, &legacy); err != nil {
				return err
			}
			file.Profiles = map[string]Config{"default": legacy}
			file.CurrentProfile = "default"
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	} else {
		file = ConfigFile{Config: defaultConfig, CurrentProfile: "default", Profiles: map[string]Config{"default": defaultConfig}}
	}
	name := cfg.profileName
	if name == "" {
		name = strings.TrimSpace(os.Getenv("OS_PROFILE"))
	}
	if name == "" {
		name = file.CurrentProfile
	}
	if name == "" {
		name = "default"
	}
	cfg.profileName = ""
	file.Profiles[name] = cfg
	if file.CurrentProfile == "" {
		file.CurrentProfile = "default"
	}
	file.Config = file.Profiles[file.CurrentProfile]
	b, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(p, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Chmod(p, 0o600)
}

func validProfileName(name string) bool {
	if name == "" {
		return false
	}
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			continue
		}
		return false
	}
	return true
}

func globalProfile(args []string) (string, []string, error) {
	cleaned := make([]string, 0, len(args))
	var profile string
	for i := 0; i < len(args); i++ {
		if args[i] != "--profile" {
			cleaned = append(cleaned, args[i])
			continue
		}
		if i+1 >= len(args) || strings.HasPrefix(args[i+1], "-") {
			return "", nil, errors.New("--profile에는 프로파일 이름이 필요합니다")
		}
		profile = strings.TrimSpace(args[i+1])
		if !validProfileName(profile) {
			return "", nil, fmt.Errorf("허용되지 않은 프로파일 이름 %q", profile)
		}
		i++
	}
	return profile, cleaned, nil
}
