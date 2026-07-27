package agent

import (
	"context"
	"log/slog"
	"math"
	"math/rand"
	"time"

	"opensphere.io/rcc/node-agent/internal/snapshot"
)

const (
	backoffBase = 2 * time.Second
	backoffMax  = 5 * time.Minute
)

// BackoffFor returns the un-jittered retry delay for a consecutive-failure count.
func BackoffFor(consecutiveFailures int) time.Duration {
	if consecutiveFailures <= 0 {
		return 0
	}
	exp := math.Pow(2, float64(consecutiveFailures-1))
	delay := time.Duration(float64(backoffBase) * exp)
	if delay <= 0 || delay > backoffMax {
		return backoffMax
	}
	return delay
}

// Jitter spreads retries so a rebooted fleet does not synchronise.
func Jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	spread := float64(d) * 0.2
	return time.Duration(float64(d) - spread + rand.Float64()*2*spread)
}

// Collector produces one snapshot per tick.
type Collector interface {
	Collect(ctx context.Context) snapshot.Snapshot
}

// Sender delivers a snapshot to the control center.
type Sender interface {
	Send(ctx context.Context, snap snapshot.Snapshot) (Result, error)
}

// Loop is the supervised reporting cycle.
type Loop struct {
	Collector Collector
	Sender    Sender
	Interval  time.Duration
	Logger    *slog.Logger

	// Jitter is injectable so tests run deterministically.
	Jitter func(time.Duration) time.Duration
	// After is injectable so tests do not sleep.
	After func(time.Duration) <-chan time.Time
}

// Run reports until the context is cancelled, then returns for graceful shutdown.
func (l *Loop) Run(ctx context.Context) error {
	jitter := l.Jitter
	if jitter == nil {
		jitter = Jitter
	}
	after := l.After
	if after == nil {
		after = time.After
	}

	consecutiveFailures := 0
	for {
		snap := l.Collector.Collect(ctx)
		result, err := l.Sender.Send(ctx, snap)
		if err == nil {
			consecutiveFailures = 0
			l.Logger.Info("heartbeat delivered",
				"hostId", snap.HostID,
				"controlCenterId", snap.ControlCenterID,
				"status", result.StatusCode,
				"degraded", len(snap.Degraded))
		} else {
			consecutiveFailures++
			l.Logger.Warn("heartbeat failed",
				"hostId", snap.HostID,
				"controlCenterId", snap.ControlCenterID,
				"status", result.StatusCode,
				"retryable", result.Retryable,
				"consecutiveFailures", consecutiveFailures,
				"error", err.Error())
		}

		wait := l.Interval
		if consecutiveFailures > 0 {
			if backoff := BackoffFor(consecutiveFailures); backoff > wait {
				wait = backoff
			}
		}

		select {
		case <-ctx.Done():
			l.Logger.Info("agent shutting down")
			return nil
		case <-after(jitter(wait)):
		}
	}
}
