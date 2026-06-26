// Package webhook 은 PlatformConfig 원칙 0 admission webhook 이다.
//
// D-1 권위역전(arch-001 §7 step 3):
// PolyONInstall.spec.platform 제거 후 PlatformConfig 가 유일한 입력 권위.
//
// 두 가지 불변식 강제:
//  1. Singleton: cluster 당 이름 "opensphere" 하나만 허용.
//  2. organization.code 불변: 설정 후 변경 거부.
//     IGA(Syncope/Keycloak realm)·도메인·시크릿 prefix 가 code 에 종속.
package webhook

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	pcv1alpha1 "github.com/opensphere/platformconfig/apis/v1alpha1"
)

// singletonName 은 cluster 내 유일하게 허용되는 PlatformConfig 이름이다.
const singletonName = "opensphere"

// Validator 는 PlatformConfig ValidatingWebhook handler 다.
type Validator struct {
	Client  client.Client
	Decoder admission.Decoder
}

// Handle 은 admission.Handler 인터페이스를 구현한다.
func (v *Validator) Handle(ctx context.Context, req admission.Request) admission.Response {
	pc := &pcv1alpha1.PlatformConfig{}
	if err := v.Decoder.DecodeRaw(req.Object, pc); err != nil {
		return admission.Errored(http.StatusBadRequest, err)
	}

	switch req.Operation {
	case admissionv1.Create:
		if err := v.validateCreate(ctx, pc); err != nil {
			return admission.Denied(err.Error())
		}

	case admissionv1.Update:
		old := &pcv1alpha1.PlatformConfig{}
		if err := v.Decoder.DecodeRaw(req.OldObject, old); err != nil {
			return admission.Errored(http.StatusBadRequest, err)
		}
		if err := v.validateUpdate(old, pc); err != nil {
			return admission.Denied(err.Error())
		}
	}

	return admission.Allowed("")
}

func (v *Validator) validateCreate(ctx context.Context, pc *pcv1alpha1.PlatformConfig) error {
	if pc.Name != singletonName {
		return fmt.Errorf("PlatformConfig 이름은 %q 이어야 합니다 (singleton 강제, 원칙 0). 입력: %q",
			singletonName, pc.Name)
	}

	existing := &pcv1alpha1.PlatformConfigList{}
	if err := v.Client.List(ctx, existing); err == nil && len(existing.Items) > 0 {
		return fmt.Errorf("PlatformConfig 는 cluster 당 1개만 허용됩니다 (singleton · 원칙 0). 기존: %q",
			existing.Items[0].Name)
	}
	return nil
}

func (v *Validator) validateUpdate(old, new *pcv1alpha1.PlatformConfig) error {
	if old.Spec.Organization.Code != "" &&
		old.Spec.Organization.Code != new.Spec.Organization.Code {
		return fmt.Errorf(
			"organization.code 는 불변 필드입니다 (현재: %q → 변경 시도: %q). "+
				"변경이 필요하면 전체 재설치(opensphere-installer migrate)를 진행하세요.",
			old.Spec.Organization.Code, new.Spec.Organization.Code)
	}
	return nil
}

// RegisterRoutes 는 admission webhook 엔드포인트를 HTTP mux 에 등록한다.
// controller-runtime webhook.Server 와 독립적으로 사용할 때 호출한다.
func (v *Validator) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/validate-config-opensphere-io-v1alpha1-platformconfig", v.serveHTTP)
}

func (v *Validator) serveHTTP(w http.ResponseWriter, r *http.Request) {
	body := make([]byte, 0)
	buf := make([]byte, 4096)
	for {
		n, err := r.Body.Read(buf)
		body = append(body, buf[:n]...)
		if err != nil {
			break
		}
	}

	review := &admissionv1.AdmissionReview{}
	if err := json.Unmarshal(body, review); err != nil {
		http.Error(w, fmt.Sprintf("요청 파싱 실패: %v", err), http.StatusBadRequest)
		return
	}

	req := admission.Request{AdmissionRequest: *review.Request}
	resp := v.Handle(r.Context(), req)

	review.Response = &admissionv1.AdmissionResponse{
		UID:     review.Request.UID,
		Allowed: resp.Allowed,
		Result:  resp.Result,
	}
	if !resp.Allowed && review.Response.Result == nil {
		review.Response.Result = &metav1.Status{
			Message: "거부됨",
			Code:    http.StatusForbidden,
		}
	}

	out, _ := json.Marshal(review)
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}
