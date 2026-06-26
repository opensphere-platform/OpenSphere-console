// opensphere-platformconfig admission webhook — standalone 서버.
// 원칙0 강제: PlatformConfig singleton(name "opensphere", cluster당 1개) + organization.code 불변.
// (arch-001: 최종적으로 webhook 로직은 operator repo에 동거 가능 — 본 cmd는 독립 배포/검증용.)
package main

import (
	"crypto/tls"
	"log"
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlconfig "sigs.k8s.io/controller-runtime/pkg/client/config"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	pcv1alpha1 "github.com/opensphere/platformconfig/apis/v1alpha1"
	pcwebhook "github.com/opensphere/platformconfig/webhook"
)

func main() {
	scheme := runtime.NewScheme()
	if err := pcv1alpha1.AddToScheme(scheme); err != nil {
		log.Fatalf("scheme(platformconfig): %v", err)
	}
	if err := admissionv1.AddToScheme(scheme); err != nil {
		log.Fatalf("scheme(admission): %v", err)
	}

	cfg, err := ctrlconfig.GetConfig()
	if err != nil {
		log.Fatalf("kube config: %v", err)
	}
	cl, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		log.Fatalf("kube client: %v", err)
	}

	v := &pcwebhook.Validator{Client: cl, Decoder: *admission.NewDecoder(scheme)}
	mux := http.NewServeMux()
	v.RegisterRoutes(mux)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

	srv := &http.Server{Addr: ":8443", Handler: mux, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	log.Println("platformconfig admission webhook listening :8443 (원칙0: singleton + org.code 불변)")
	if err := srv.ListenAndServeTLS("/certs/tls.crt", "/certs/tls.key"); err != nil {
		log.Fatal(err)
	}
}
