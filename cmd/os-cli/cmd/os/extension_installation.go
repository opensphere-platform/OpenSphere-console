package main

// CON-FR-007/020 · C_SCTL -> C_API/C_EXT · CON-RT-13: native CLI uses OS Shell.
import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

type installationIdempotencyContextKey struct{}

func requestIdempotencyKey(ctx context.Context) string {
	if key, ok := ctx.Value(installationIdempotencyContextKey{}).(string); ok && key != "" {
		return key
	}
	return operationID()
}

var catalogRevisionPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var descriptorPattern = regexp.MustCompile(`^extension\.[a-z0-9][a-z0-9-]{0,62}$`)
var installationOperationPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type installationReceipt struct {
	SchemaVersion string `json:"schemaVersion"`
	OperationID   string `json:"operationId"`
	ActionID      string `json:"actionId"`
	TargetRef     string `json:"targetRef"`
	State         string `json:"state"`
}

func readInstallationReceipt(raw []byte) (installationReceipt, error) {
	var receipt installationReceipt
	if json.Unmarshal(raw, &receipt) != nil || receipt.SchemaVersion != "1.0" || !installationOperationPattern.MatchString(receipt.OperationID) || receipt.ActionID != "console.extension.install" {
		return receipt, fmt.Errorf("설치 작업 응답의 계약을 확인하지 못했습니다. 재설치하지 말고 작업 상태를 확인하세요")
	}
	switch receipt.State {
	case "Planned", "Authorized", "Submitted", "Reconciling", "Applied", "Verified", "Failed", "Unknown", "RolledBack":
		return receipt, nil
	default:
		return receipt, fmt.Errorf("알 수 없는 설치 작업 상태: %s", receipt.State)
	}
}

func extensionCatalogAction(cfg Config, args []string, out io.Writer) error {
	if len(args) < 2 || strings.HasPrefix(args[1], "--") {
		return usageError("사용법: os extensions inspect|install <module-id> [--reason TEXT]")
	}
	action, target := args[0], strings.TrimSpace(args[1])
	reason := strings.TrimSpace(parseLongFlags(args[2:])["reason"])
	if action == "install" && (len(reason) < 8 || len([]rune(reason)) > 500) {
		return usageError("--reason은 8자 이상, 최대 500자의 설치 사유여야 합니다")
	}
	requestedImage := ""
	descriptorID := target
	if strings.ContainsAny(target, ":@/") {
		image, err := normalizeExtensionInstallImage(target)
		if err != nil {
			return err
		}
		if !strings.HasPrefix(image, defaultExtensionImagePrefix) {
			return usageError("공식 Registry에 등록된 OpenSphere 제품만 설치할 수 있습니다")
		}
		requestedImage = image
		name := strings.SplitN(strings.TrimPrefix(image, defaultExtensionImagePrefix), "@", 2)[0]
		name = strings.SplitN(name, ":", 2)[0]
		name = strings.TrimPrefix(strings.TrimPrefix(name, "opensphere-shell-"), "opensphere-plugin-")
		descriptorID = "extension." + name
	} else if !strings.HasPrefix(descriptorID, "extension.") {
		descriptorID = "extension." + descriptorID
	}
	if !descriptorPattern.MatchString(descriptorID) {
		return usageError("올바른 모듈 ID가 필요합니다 (예: cluster-manager)")
	}

	raw, err := ownerCommandData(cfg, "console.modules.catalog", map[string]any{}, "")
	if err != nil {
		return err
	}
	var catalog struct {
		SchemaVersion string `json:"schemaVersion"`
		Freshness     string `json:"freshness"`
		Data          struct {
			Revision string `json:"revision"`
			Items    []struct {
				DescriptorID string `json:"descriptorId"`
			} `json:"items"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &catalog) != nil || catalog.SchemaVersion != "1.0" || catalog.Freshness != "fresh" || !catalogRevisionPattern.MatchString(catalog.Data.Revision) {
		return fmt.Errorf("설치 목록의 현재 revision을 확인하지 못했습니다")
	}
	matches := 0
	for _, item := range catalog.Data.Items {
		if item.DescriptorID == descriptorID {
			matches++
		}
	}
	if matches != 1 {
		return fmt.Errorf("공식 설치 목록에서 %s를 유일하게 찾지 못했습니다", descriptorID)
	}
	payload := map[string]string{"descriptorId": descriptorID, "catalogRevision": catalog.Data.Revision}
	inspection, err := ownerCommandData(cfg, "console.modules.inspect", payload, "")
	if err != nil {
		return err
	}
	var inspected struct {
		Freshness string `json:"freshness"`
		Data      struct {
			Resolution string `json:"resolution"`
			Candidate  struct {
				DescriptorID    string `json:"descriptorId"`
				CatalogRevision string `json:"catalogRevision"`
				Image           string `json:"image"`
				Channel         string `json:"channel"`
			} `json:"candidate"`
		} `json:"data"`
	}
	if json.Unmarshal(inspection, &inspected) != nil || inspected.Freshness != "fresh" || inspected.Data.Resolution != "Eligible" || inspected.Data.Candidate.DescriptorID != descriptorID || inspected.Data.Candidate.CatalogRevision != catalog.Data.Revision {
		return fmt.Errorf("설치 검토 응답이 현재 선택과 일치하지 않습니다")
	}
	candidate := inspected.Data.Candidate
	at := strings.LastIndex(candidate.Image, "@")
	if at < 0 || !strings.HasPrefix(candidate.Image, defaultExtensionImagePrefix) || !catalogRevisionPattern.MatchString(candidate.Image[at+1:]) {
		return fmt.Errorf("검증된 불변 이미지가 필요합니다")
	}
	if requestedImage != "" && requestedImage != candidate.Image && requestedImage != candidate.Image[:at]+":"+candidate.Channel {
		return fmt.Errorf("요청한 이미지/채널과 현재 공식 후보가 다릅니다. 다른 버전으로 대체하지 않았습니다")
	}
	if action == "inspect" {
		return renderOutput(cfg, out, inspection)
	}
	payload["reason"] = reason
	receipt, err := ownerCommandData(cfg, "console.modules.install", payload, parseLongFlags(args[2:])["request-id"])
	if err != nil {
		return err
	}
	accepted, err := readInstallationReceipt(receipt)
	if err != nil {
		return err
	}
	if accepted.TargetRef != candidate.Image {
		return fmt.Errorf("설치 접수 응답의 대상이 검토한 후보와 다릅니다. 재설치하지 말고 작업 상태를 확인하세요")
	}
	return renderOutput(cfg, out, receipt)
}

func extensionOperation(cfg Config, args []string, out io.Writer) error {
	if len(args) < 2 || (args[0] != "get" && args[0] != "watch") || !installationOperationPattern.MatchString(args[1]) {
		return usageError("사용법: os extensions operation get|watch <operation-uuid> [--timeout 5m]")
	}
	deadline := time.Now().Add(parseTimeout(parseLongFlags(args[2:])["timeout"]))
	for {
		raw, err := ownerCommandData(cfg, "console.modules.operation", map[string]string{"operationId": args[1]}, "")
		if err != nil {
			return err
		}
		receipt, err := readInstallationReceipt(raw)
		if err != nil {
			return err
		}
		if receipt.OperationID != args[1] {
			return fmt.Errorf("모듈 설치 작업 응답이 요청과 일치하지 않습니다")
		}
		if args[0] == "get" || receipt.State == "Verified" {
			return renderOutput(cfg, out, raw)
		}
		switch receipt.State {
		case "Failed", "Unknown", "RolledBack":
			if err := renderOutput(cfg, out, raw); err != nil {
				return err
			}
			return &CLIError{Code: "InstallationNotVerified", Message: "설치 완료를 확인하지 못했습니다: " + receipt.State}
		case "Planned", "Authorized", "Submitted", "Reconciling", "Applied":
		default:
			return fmt.Errorf("알 수 없는 설치 작업 상태: %s", receipt.State)
		}
		if time.Now().After(deadline) {
			return &CLIError{Code: "OperationTimeout", Message: "설치가 계속 진행 중입니다. 같은 operation ID로 다시 조회하세요: " + args[1]}
		}
		sleepFn(2 * time.Second)
	}
}
