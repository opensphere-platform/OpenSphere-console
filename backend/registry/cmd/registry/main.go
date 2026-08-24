package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"

	"github.com/opensphere/registry/internal/registry"
)

var (
	appVersion     = env("APP_VERSION", "dev")
	sourceRevision = env("SOURCE_REVISION", "unknown")
	imageDigest    = env("IMAGE_DIGEST", "unknown")
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=5, stale-while-revalidate=25")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func main() {
	dyn, err := newDynamic()
	if err != nil {
		log.Fatalf("Kubernetes client initialization failed: %v", err)
	}
	store := registry.NewStore(dyn)
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if err := store.Refresh(ctx); err != nil {
		log.Printf("initial snapshot unavailable: %v", err)
	}
	go store.Run(ctx)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		snapshot, ok := store.Current()
		ready := ok && !snapshot.Stale
		status := http.StatusOK
		if !ready {
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]interface{}{"ready": ready, "stale": snapshot.Stale, "revision": snapshot.Revision, "sources": snapshot.Sources, "reason": store.LastError()})
	})
	mux.HandleFunc("GET /api/v1/registry", func(w http.ResponseWriter, _ *http.Request) {
		snapshot, ok := store.Current()
		if !ok {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "RegistryUnavailable", "message": "No valid Registry snapshot has been observed."})
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	})
	mux.HandleFunc("POST /api/v1/registry/resolve", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 8*1024)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		var request registry.ResolveRequest
		if err := decoder.Decode(&request); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "InvalidResolveRequest"})
			return
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "InvalidResolveRequest"})
			return
		}
		writeJSON(w, http.StatusOK, store.Resolve(request))
	})
	mux.HandleFunc("GET /v1/status", func(w http.ResponseWriter, _ *http.Request) {
		snapshot, ok := store.Current()
		writeJSON(w, http.StatusOK, map[string]interface{}{"service": "opensphere-registry", "product": "OpenSphere Registry & Catalog Service", "cbssCoreService": true, "version": appVersion, "sourceRevision": sourceRevision, "imageDigest": imageDigest, "ready": ok && !snapshot.Stale, "stale": snapshot.Stale, "revision": snapshot.Revision, "observedAt": snapshot.ObservedAt, "sources": snapshot.Sources, "rejected": snapshot.Rejected, "lastError": store.LastError()})
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		snapshot, ok := store.Current()
		ready := 0
		if ok && !snapshot.Stale {
			ready = 1
		}
		age := 0.0
		if t, err := time.Parse(time.RFC3339Nano, snapshot.ObservedAt); err == nil {
			age = time.Since(t).Seconds()
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = fmt.Fprintf(w, "# HELP opensphere_registry_ready Registry snapshot readiness.\n# TYPE opensphere_registry_ready gauge\nopensphere_registry_ready %d\n# HELP opensphere_registry_snapshot_age_seconds Age of the current atomic snapshot.\n# TYPE opensphere_registry_snapshot_age_seconds gauge\nopensphere_registry_snapshot_age_seconds %.3f\n# HELP opensphere_registry_plugins Published extension count.\n# TYPE opensphere_registry_plugins gauge\nopensphere_registry_plugins %d\n# HELP opensphere_registry_catalog_modules Foundation module descriptor count.\n# TYPE opensphere_registry_catalog_modules gauge\nopensphere_registry_catalog_modules %d\n# HELP opensphere_registry_rejected Rejected source item count.\n# TYPE opensphere_registry_rejected gauge\nopensphere_registry_rejected %d\n# HELP opensphere_registry_resolve_total Resolve requests.\n# TYPE opensphere_registry_resolve_total counter\nopensphere_registry_resolve_total %d\n", ready, age, len(snapshot.Plugins), len(snapshot.Catalog.ModuleDescriptors), len(snapshot.Rejected), store.ResolveCount())
	})
	server := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 * 1024}
	go func() {
		<-ctx.Done()
		shutdownCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_ = server.Shutdown(shutdownCtx)
	}()
	log.Printf("opensphere-registry %s source=%s listening :8080", appVersion, sourceRevision)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func newDynamic() (dynamic.Interface, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, err
	}
	qps := float32(20)
	if value := os.Getenv("KUBERNETES_CLIENT_QPS"); value != "" {
		if parsed, e := strconv.ParseFloat(value, 32); e == nil {
			qps = float32(parsed)
		}
	}
	cfg.QPS = qps
	cfg.Burst = 40
	cfg.Timeout = 10 * time.Second
	return dynamic.NewForConfig(cfg)
}
