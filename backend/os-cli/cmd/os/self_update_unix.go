//go:build !windows

package main

import (
	"fmt"
	"os"
)

func installDownloadedUpdate(staged, target, backup string) (bool, error) {
	_ = os.Remove(backup)
	if err := os.Rename(target, backup); err != nil {
		return false, fmt.Errorf("현재 CLI backup 생성 실패: %w", err)
	}
	if err := os.Rename(staged, target); err != nil {
		_ = os.Rename(backup, target)
		return false, fmt.Errorf("CLI 교체 실패(기존 바이너리 복원 시도 완료): %w", err)
	}
	return false, nil
}
