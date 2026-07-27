// Command rcc-node-agent reports a bounded, read-only Linux host snapshot to
// the PolyON Region Control Center over outbound-only signed HTTPS.
//
// Stage 1 has no command execution surface: the agent exposes no listener, no
// shell, no terminal and no mutation capability of any kind.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"opensphere.io/rcc/node-agent/internal/agent"
	"opensphere.io/rcc/node-agent/internal/collect"
	"opensphere.io/rcc/node-agent/internal/config"
	"opensphere.io/rcc/node-agent/internal/execute"
	"opensphere.io/rcc/node-agent/internal/plan"
	"opensphere.io/rcc/node-agent/internal/state"
)

// Version is stamped at build time with -ldflags "-X main.Version=...".
var Version = "0.1.0-dev"

func main() {
	configPath := flag.String("config", config.DefaultPath, "path to the root-owned agent configuration file")
	showVersion := flag.Bool("version", false, "print the agent version and exit")
	checkOnly := flag.Bool("check", false, "validate configuration, print one redacted snapshot, and exit")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if *showVersion {
		fmt.Println(Version)
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		logger.Error("configuration rejected", "error", err.Error())
		os.Exit(2)
	}
	logger.Info("agent configured", "config", cfg.Redacted(), "version", Version)

	collector := collect.New(cfg.ControlCenterID, cfg.HostID, Version, cfg.CollectSystemdUnits)
	// Advisory only: the console shows this so an operator knows what may be
	// requested. The agent still enforces the allowlist when a plan arrives.
	collector.OperationsEnabled = cfg.OperationsEnabled
	collector.RestartAllowlist = cfg.RestartAllowlist
	collector.PackagesEnabled = cfg.PackagesEnabled
	collector.PackageAllowlist = cfg.PackageAllowlist
	collector.CollectPackages = cfg.CollectPackages
	collector.NetworkEnabled = cfg.NetworkEnabled
	collector.NetworkAllowlist = cfg.NetworkAllowlist
	collector.StorageEnabled = cfg.StorageEnabled
	collector.MountRoots = cfg.StorageMountRoots
	collector.GrowAllowlist = cfg.StorageGrowAllowlist
	collector.OSImageEnabled = cfg.OSImageEnabled
	collector.ImageAllowlist = cfg.OSImageAllowlist
	collector.CollectNetworkState = cfg.CollectNetworkState
	collector.CollectStorage = cfg.CollectStorage
	collector.CollectBoot = cfg.CollectBoot
	collector.CollectSSHBan = cfg.CollectSSHBan
	collector.SSHBanEnabled = cfg.SSHBanEnabled
	collector.SSHProtectedIPs = cfg.SSHBanProtectedAddresses

	if *checkOnly {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(collector.Collect(ctx)); err != nil {
			logger.Error("snapshot encode failed", "error", err.Error())
			os.Exit(1)
		}
		return
	}

	client, err := agent.NewHTTPClient(cfg)
	if err != nil {
		logger.Error("http client rejected", "error", err.Error())
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Stage 2 typed operations are opt-in per host. When disabled the agent
	// behaves exactly as in Stage 1: it reports snapshots and never polls for
	// work, so no operation can reach it.
	if cfg.OperationsEnabled {
		runner, err := buildOperationRunner(cfg, client, logger)
		if err != nil {
			logger.Error("operations disabled: state is unusable", "error", err.Error())
			os.Exit(2)
		}
		// Close out anything interrupted by a crash or reboot before accepting
		// new work, so a half-finished attempt is never confused for a new one.
		// The poll loop then re-reconciles on every tick, which is what turns a
		// reboot that never happened into a terminal failure at its deadline.
		if err := runner.RecoverPending(ctx); err != nil {
			logger.Error("operation recovery failed", "error", err.Error())
			os.Exit(2)
		}
		go pollOperations(ctx, runner, cfg.PollInterval, logger)
		logger.Info("typed operations enabled",
			"stateDir", cfg.StateDir,
			"pollInterval", cfg.PollInterval.String(),
			"restartAllowlist", len(cfg.RestartAllowlist),
			"packagesEnabled", cfg.PackagesEnabled,
			"packageAllowlist", len(cfg.PackageAllowlist),
			"networkEnabled", cfg.NetworkEnabled,
			"storageEnabled", cfg.StorageEnabled,
			"osImageEnabled", cfg.OSImageEnabled,
			"sshBanEnabled", cfg.SSHBanEnabled,
			"sshProtectedAddresses", len(cfg.SSHBanProtectedAddresses))
	} else {
		logger.Info("typed operations disabled; host reports snapshots only")
	}

	loop := &agent.Loop{
		Collector: collector,
		Sender:    agent.NewReporter(cfg, client),
		Interval:  cfg.Interval,
		Logger:    logger,
	}
	if err := loop.Run(ctx); err != nil {
		logger.Error("agent terminated", "error", err.Error())
		os.Exit(1)
	}
}

func buildOperationRunner(cfg *config.Config, client *http.Client, logger *slog.Logger) (*agent.OperationRunner, error) {
	store, err := state.Open(cfg.StateDir, time.Now)
	if err != nil {
		return nil, err
	}
	reporter := agent.NewReporter(cfg, client)
	return &agent.OperationRunner{
		Source: agent.NewPlanSource(cfg, client, Version),
		Store:  store,
		Executor: &execute.Executor{
			Runner:           execute.ExecRunner{},
			Rebooter:         execute.SystemctlRebooter{},
			RestartAllowlist: cfg.RestartAllowlist,
			BootID:           execute.LiveBootID("/proc"),
			Now:              time.Now,
		},
		Packages: &execute.PackageExecutor{
			Runner:           execute.ExecRunner{},
			PackageAllowlist: cfg.PackageAllowlist,
			Enabled:          cfg.PackagesEnabled,
			Now:              time.Now,
		},
		Network: &execute.NetworkExecutor{
			Runner:    execute.ExecRunner{},
			Enabled:   cfg.NetworkEnabled,
			Allowlist: cfg.NetworkAllowlist,
			// The confirmation that decides whether a network change is kept is
			// a real request to this host's own control center. Anything weaker
			// — a ping to a gateway, a local interface check — would confirm
			// that the host is on *a* network, not that it is on the one that
			// governs it.
			Confirm:  reporter.Reachable,
			ProcRoot: "/proc",
			Now:      time.Now,
		},
		Storage: &execute.StorageExecutor{
			Runner:        execute.ExecRunner{},
			Enabled:       cfg.StorageEnabled,
			MountRoots:    cfg.StorageMountRoots,
			GrowAllowlist: cfg.StorageGrowAllowlist,
			Now:           time.Now,
		},
		OSImage: &execute.OSImageExecutor{
			Runner:    execute.ExecRunner{},
			Enabled:   cfg.OSImageEnabled,
			Allowlist: cfg.OSImageAllowlist,
			Now:       time.Now,
		},
		SSHBan: &execute.SSHBanExecutor{
			Runner:             execute.ExecRunner{},
			Enabled:            cfg.SSHBanEnabled,
			ProtectedAddresses: cfg.SSHBanProtectedAddresses,
			Now:                time.Now,
		},
		Identity: plan.Identity{ControlCenterID: cfg.ControlCenterID, HostID: cfg.HostID},
		Logger:   logger,
		Now:      time.Now,
	}, nil
}

// pollOperations drives the operation loop until the context is cancelled.
//
// After doing work it polls again immediately, so a queue of approved
// operations drains without waiting a full interval each time.
func pollOperations(ctx context.Context, runner *agent.OperationRunner, interval time.Duration, logger *slog.Logger) {
	for {
		worked, err := runner.PollOnce(ctx)
		if err != nil && ctx.Err() == nil {
			logger.Warn("operation poll failed", "error", err.Error())
		}
		if worked && ctx.Err() == nil {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}
