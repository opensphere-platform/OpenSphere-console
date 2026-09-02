//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

const windowsUpdateHelper = `param(
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$Staged,
  [Parameter(Mandatory=$true)][string]$Backup,
  [Parameter(Mandatory=$true)][string]$Result
)
$ErrorActionPreference = 'Stop'
$lastError = 'unknown update replacement error'
for ($attempt = 0; $attempt -lt 100; $attempt++) {
  try {
    if (Test-Path -LiteralPath $Backup) { Remove-Item -LiteralPath $Backup -Force }
    Move-Item -LiteralPath $Target -Destination $Backup -Force
    try {
      Move-Item -LiteralPath $Staged -Destination $Target -Force
    } catch {
      if (-not (Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $Backup)) {
        Move-Item -LiteralPath $Backup -Destination $Target -Force
      }
      throw
    }
    $success = @{ state = 'Succeeded'; target = $Target; backup = $Backup } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($Result, $success, [System.Text.UTF8Encoding]::new($false))
    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
    exit 0
  } catch {
    $lastError = $_.Exception.Message
    Start-Sleep -Milliseconds 100
  }
}
if (-not (Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $Backup)) {
  Move-Item -LiteralPath $Backup -Destination $Target -Force -ErrorAction SilentlyContinue
}
$failed = @{ state = 'Failed'; error = $lastError; target = $Target; staged = $Staged } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($Result, $failed, [System.Text.UTF8Encoding]::new($false))
exit 1
`

func installDownloadedUpdate(staged, target, backup string) (bool, error) {
	powershell, err := exec.LookPath("powershell.exe")
	if err != nil {
		return false, fmt.Errorf("Windows update helper를 실행할 powershell.exe를 찾지 못했습니다: %w", err)
	}
	helper, err := os.CreateTemp(filepath.Dir(target), ".os-update-helper-*.ps1")
	if err != nil {
		return false, err
	}
	helperPath := helper.Name()
	resultPath := target + ".update-result.json"
	_ = os.Remove(resultPath)
	if _, err := helper.WriteString(windowsUpdateHelper); err != nil {
		_ = helper.Close()
		_ = os.Remove(helperPath)
		return false, err
	}
	if err := helper.Close(); err != nil {
		_ = os.Remove(helperPath)
		return false, err
	}
	command := exec.Command(
		powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-File", helperPath,
		"-Target", target,
		"-Staged", staged,
		"-Backup", backup,
		"-Result", resultPath,
	)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := command.Start(); err != nil {
		_ = os.Remove(helperPath)
		return false, fmt.Errorf("Windows update helper 시작 실패: %w", err)
	}
	return true, nil
}
