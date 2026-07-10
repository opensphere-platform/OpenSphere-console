// opensphere-registry — Registry 단일창구(ADR-0001).
// GET /api/v1/registry → {capabilities, plugins, templates} 단일 권위 응답.
// read-only(쓰기경로 0) · ImageDigest 빈값 게시거부 · 결정적 출력(console==cli byte-identical).
package main

import (
	"encoding/json"
	"log"
	"net/http"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"

	"github.com/opensphere/registry/internal/catalog"
	"github.com/opensphere/registry/internal/registry"
)

func main() {
	dyn, dynErr := newDynamic()
	if dynErr != nil {
		log.Printf("경고: in-cluster client 없음(%v) — 라이브 plugin 생략, seed 만 게시", dynErr)
	}

	mux := http.NewServeMux()
	handleRegistry := func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "registry 는 read-only(GET 전용) — ADR-0001", http.StatusMethodNotAllowed)
			return
		}
		// 단일 데이터셋 조립: seed capability/template + 라이브 plugin(UIPluginPackage).
		items := append(catalog.SeedCapabilities(), catalog.SeedTemplates()...)
		if dyn != nil {
			if live, err := registry.LoadLivePlugins(r.Context(), dyn); err != nil {
				log.Printf("라이브 plugin 로드 실패: %v (seed 응답만)", err)
			} else {
				items = append(items, live...)
			}
		}
		resp, rejected := registry.Build(items)
		if dyn != nil {
			if keys, err := registry.LoadTrustedKeys(r.Context(), dyn); err == nil {
				resp.TrustedKeys = keys
			} else {
				log.Printf("trusted key 로드 실패: %v", err)
			}
		}
		if len(rejected) > 0 {
			log.Printf("게시거부(ImageDigest 빈값): %v", rejected)
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		// 결정적(byte-identical): 고정 indent, HTML escape 끔.
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		enc.SetEscapeHTML(false)
		if err := enc.Encode(resp); err != nil {
			log.Printf("인코딩 실패: %v", err)
		}
	}
	mux.HandleFunc("/api/v1/registry", handleRegistry)
	// Legacy browser path is an alias only; the Registry service remains the sole authority.
	mux.HandleFunc("/registry/plugins.json", handleRegistry)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

	const addr = ":8080"
	log.Printf("opensphere-registry 단일창구 listening %s (GET /api/v1/registry · read-only)", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func newDynamic() (dynamic.Interface, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, err
	}
	return dynamic.NewForConfig(cfg)
}
