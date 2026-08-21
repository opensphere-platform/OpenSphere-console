package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

const (
	agentContract       = "opensphere-web-shell-agent/v1"
	contextContract     = "opensphere-web-shell-context/v2"
	runtimeContract     = "opensphere-shell-runtime/v1"
	controlContract     = "opensphere-shell-control/v1"
	internalPTYAudience = "opensphere-shell-pty"
	cliAudience         = "opensphere-os-cli"
)

var (
	version      = "dev"
	osCLIVersion = "dev"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Args[1:]); err != nil {
		slog.Error("OS Shell runtime stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: opensphere-os-shell-runtime <agent|pty>")
	}
	binding, err := loadRuntimeBinding()
	if err != nil {
		return err
	}
	switch args[0] {
	case "agent":
		return runAgent(ctx, binding)
	case "pty":
		return runPTY(ctx, binding)
	default:
		return fmt.Errorf("unsupported runtime mode %q; KubeVirt and arbitrary adapters are not available", args[0])
	}
}
