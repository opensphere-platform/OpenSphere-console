package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

var version = "0.3.0"

const (
	exitSuccess = 0
	exitUsage   = 2
	exitAuth    = 3
	exitNetwork = 4
	exitServer  = 5
)

// exitError carries a stable process status while preserving command messages.
type exitError struct {
	code          int
	message       string
	correlationID string
	cause         error
}

func (e *exitError) Error() string { return e.message }
func (e *exitError) Unwrap() error { return e.cause }

func cliError(code int, message string, cause error) error {
	return &exitError{code: code, message: message, cause: cause}
}

func run(args []string, in io.Reader, out, errOut io.Writer) error {
	selectedProfile, cleanedArgs, err := globalProfile(args)
	if err != nil {
		return cliError(exitUsage, err.Error(), err)
	}
	args = cleanedArgs
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		printHelp(out)
		return nil
	}
	if args[0] == "help" {
		if len(args) == 1 {
			printHelp(out)
			return nil
		}
		if len(args) != 2 || !printCommandHelp(out, args[1]) {
			return cliError(exitUsage, fmt.Sprintf("unknown command %q; run os help", strings.Join(args[1:], " ")), nil)
		}
		return nil
	}
	if len(args) >= 2 && (hasArg(args[1:], "--help") || hasArg(args[1:], "-h")) && printCommandHelp(out, args[0]) {
		return nil
	}
	if args[0] == "version" || args[0] == "--version" {
		fmt.Fprintf(out, "os %s\n", version)
		return nil
	}
	if args[0] == "login" {
		return login(selectedProfile, args[1:], in, out, errOut)
	}
	if args[0] == "setup" {
		return setup(selectedProfile, args[1:], out)
	}
	if args[0] == "config" {
		return configCommandFor(selectedProfile, args[1:], out)
	}
	if args[0] == "completion" {
		return completion(args[1:], out)
	}
	caBundle, cleanedArgs, err := globalCABundle(args)
	if err != nil {
		return cliError(exitUsage, err.Error(), err)
	}
	args = cleanedArgs
	output, cleanedArgs, err := parseOutputOptions(args)
	if err != nil {
		return cliError(exitUsage, err.Error(), err)
	}
	args = cleanedArgs
	out = &formattedOutput{Writer: out, options: output}
	if len(args) == 0 {
		return cliError(exitUsage, "명령이 필요합니다; os help를 실행하세요", nil)
	}
	cfg, err := loadConfigFor(selectedProfile)
	if err != nil {
		return err
	}
	if caBundle != "" {
		cfg.CABundle = caBundle
	}
	switch args[0] {
	case "whoami":
		return whoami(cfg, out)
	case "session":
		return sessionCommand(cfg, args[1:], out)
	case "logout":
		return logout(cfg, out)
	case "device":
		return devices(cfg, args[1:], out)
	case "registry":
		return registry(cfg, args[1:], out)
	case "get":
		return getResource(cfg, args[1:], out)
	case "role":
		return role(cfg, args[1:], out)
	case "extensions":
		return extensions(cfg, args[1:], out)
	default:
		return dynamic(cfg, args, out, errOut)
	}
}

func main() {
	if code := execute(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); code != exitSuccess {
		os.Exit(code)
	}
}
