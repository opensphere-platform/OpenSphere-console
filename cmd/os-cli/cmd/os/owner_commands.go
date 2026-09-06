package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
)

// Native convenience commands are consumers of the same OS Shell contract.
// Never retry an uncertain mutation with a new identity or dispatch to C_API.
func ownerCommandData(cfg Config, command string, args any, requestID string) ([]byte, error) {
	if requestID == "" {
		var id [16]byte
		if _, err := rand.Read(id[:]); err != nil {
			return nil, err
		}
		id[6] = (id[6] & 15) | 0x40
		id[8] = (id[8] & 63) | 0x80
		requestID = fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
	}
	if !installationOperationPattern.MatchString(requestID) {
		return nil, usageError("--request-id는 UUID여야 합니다")
	}
	raw, err := jsonBytesCall(cfg, http.MethodPost, join(cfg.ConsoleURL, "/api/os-shell/commands"), map[string]any{
		"command": command, "arguments": args, "requestId": requestID,
	})
	if err != nil {
		return nil, fmt.Errorf("OS Shell 요청 %s: %w; 결과가 불명확하면 상태를 조회하고 같은 --request-id를 사용하세요", requestID, err)
	}
	var receipt struct {
		Schema       string          `json:"schema"`
		ControlPlane string          `json:"controlPlane"`
		Command      string          `json:"command"`
		RequestID    string          `json:"requestId"`
		Owner        string          `json:"owner"`
		Data         json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &receipt) != nil || receipt.Schema != "opensphere.shell-command/v1" || receipt.ControlPlane != "OS-Shell" || receipt.Command != command || receipt.RequestID != requestID || receipt.Owner != "console" || len(receipt.Data) == 0 {
		return nil, fmt.Errorf("OS Shell 응답 계약 불일치; request-id=%s 상태를 확인하세요", requestID)
	}
	return receipt.Data, nil
}
