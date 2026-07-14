package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

func outputIsJSON(args []string) bool {
	for i, arg := range args {
		if arg == "--output=json" || arg == "-o=json" {
			return true
		}
		if (arg == "--output" || arg == "-o") && i+1 < len(args) && strings.EqualFold(args[i+1], "json") {
			return true
		}
	}
	return false
}

func exitDetails(err error) (int, string) {
	var typed *exitError
	if errors.As(err, &typed) {
		return typed.code, typed.correlationID
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "등록된 cli 디바이스가 없습니다") || strings.Contains(message, "인증 또는 세션") {
		return exitAuth, ""
	}
	// Command validation errors which predate exitError remain usage errors.
	return exitUsage, ""
}

func execute(args []string, in io.Reader, out, errOut io.Writer) int {
	err := run(args, in, out, errOut)
	if err == nil {
		return exitSuccess
	}
	code, correlationID := exitDetails(err)
	if outputIsJSON(args) {
		payload := map[string]any{"error": err.Error(), "code": code, "correlationId": correlationID}
		_ = json.NewEncoder(errOut).Encode(payload)
	} else {
		fmt.Fprintln(errOut, "오류:", err)
	}
	return code
}
