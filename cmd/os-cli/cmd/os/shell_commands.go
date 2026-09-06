package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// OS CLI consumes C_SCTL's command contract. It never dispatches to a module.
func shellCommands(cfg Config, args []string, in io.Reader, out io.Writer) error {
	if len(args) == 1 && args[0] == "commands" {
		raw, err := jsonBytesCall(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/os-shell/commands"), nil)
		if err != nil {
			return err
		}
		return renderOutput(cfg, out, raw)
	}
	if len(args) < 2 || args[0] != "execute" {
		return usageError("사용법: os shell commands | os shell execute <command> --id <module> --reason TEXT | --file PATH")
	}
	command := args[1]
	flags := parseLongFlags(args[2:])
	input := map[string]any{}
	if file := flags["file"]; file != "" {
		for _, key := range []string{"id", "reason", "confirm", "chart-version"} {
			if flags[key] != "" {
				return usageError("--file과 개별 입력 옵션은 함께 사용할 수 없습니다")
			}
		}
		reader := in
		var f *os.File
		if file != "-" {
			var err error
			f, err = os.Open(file)
			if err != nil {
				return err
			}
			defer f.Close()
			reader = f
		}
		raw, err := io.ReadAll(io.LimitReader(reader, (64<<10)+1))
		if err != nil {
			return err
		}
		if len(raw) > 64<<10 {
			return usageError("명령 입력이 64 KiB를 초과했습니다")
		}
		if json.Unmarshal(raw, &input) != nil || input == nil {
			return usageError("명령 입력은 JSON 객체여야 합니다")
		}
	} else {
		for flag, key := range map[string]string{"id": "id", "reason": "reason", "confirm": "confirm", "chart-version": "chartVersion"} {
			if value := flags[flag]; value != "" {
				input[key] = value
			}
		}
	}
	requestID := flags["request-id"]
	if requestID == "" {
		requestID = operationID()
	}
	if !installationOperationPattern.MatchString(requestID) {
		return usageError("--request-id는 UUID여야 합니다")
	}
	payload := map[string]any{"command": command, "arguments": input, "requestId": requestID}
	if review := flags["review-revision"]; review != "" {
		if !catalogRevisionPattern.MatchString(review) {
			return usageError("검토 revision 형식이 잘못됐습니다")
		}
		payload["reviewRevision"] = review
	}
	raw, err := jsonBytesCall(cfg, http.MethodPost, join(cfg.ConsoleURL, "/api/os-shell/commands"), payload)
	if err != nil {
		return fmt.Errorf("OS Shell 요청 %s: %w (결과가 불명확하면 상태를 조회하고 같은 request-id로 재시도)", requestID, err)
	}
	var receipt struct {
		Schema       string          `json:"schema"`
		ControlPlane string          `json:"controlPlane"`
		Command      string          `json:"command"`
		RequestID    string          `json:"requestId"`
		Data         json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &receipt) != nil || receipt.Schema != "opensphere.shell-command/v1" || receipt.ControlPlane != "OS-Shell" || receipt.Command != command || !strings.EqualFold(receipt.RequestID, requestID) || len(receipt.Data) == 0 {
		return fmt.Errorf("OS Shell 응답 계약 불일치; request-id=%s 상태를 확인하세요", requestID)
	}
	return renderOutput(cfg, out, raw)
}
