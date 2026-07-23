package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

type updateManifest struct {
	Name      string          `json:"name"`
	Version   string          `json:"version"`
	Links     []updateLink    `json:"links"`
	Signature updateSignature `json:"signature"`
}

type updateSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

type updateLink struct {
	OS     string `json:"os"`
	Arch   string `json:"arch"`
	Href   string `json:"href"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type updateReport struct {
	CurrentVersion   string `json:"currentVersion"`
	AvailableVersion string `json:"availableVersion"`
	OS               string `json:"os"`
	Arch             string `json:"arch"`
	CurrentSHA256    string `json:"currentSha256"`
	AvailableSHA256  string `json:"availableSha256"`
	State            string `json:"state"`
	UpdateAvailable  bool   `json:"updateAvailable"`
	ManifestURL      string `json:"manifestUrl"`
	ArtifactURL      string `json:"artifactUrl"`
	InstalledPath    string `json:"installedPath"`
	BackupPath       string `json:"backupPath,omitempty"`
	Scheduled        bool   `json:"scheduled,omitempty"`
	Message          string `json:"message"`
}

var executablePathFn = os.Executable
var installDownloadedUpdateFn = installDownloadedUpdate

const localUpdateKeyID = "opensphere-cli-local-dev-v1"
const localUpdatePublicKey = "MCowBQYDK2VwAyEAq5OF9nQUWzq/tgc4cThcXpb0cjvKWiwFrmsqa36ArqI="

// Production builds pin these values with -ldflags. The matching private key
// exists only in the release workflow secret and is never copied into an image.
var updateProductionKeyID = ""
var updateProductionPublicKey = ""

func selfUpdate(cfg Config, args []string, out io.Writer) error {
	const usage = "사용법: os update [--check|--status] [--force]"
	allowed := map[string]bool{"--check": true, "--status": true, "--force": true}
	for _, arg := range args {
		if !allowed[arg] {
			return usageError(usage)
		}
	}
	checkOnly := hasArg(args, "--check")
	statusOnly := hasArg(args, "--status")
	force := hasArg(args, "--force")
	if checkOnly && statusOnly {
		return usageError("--check와 --status는 동시에 사용할 수 없습니다")
	}
	if statusOnly && force {
		return usageError("--status에는 --force를 사용할 수 없습니다")
	}
	target, err := executablePathFn()
	if err != nil {
		return fmt.Errorf("현재 CLI 실행 경로 확인 실패: %w", err)
	}
	if evaluated, evalErr := filepath.EvalSymlinks(target); evalErr == nil {
		target = evaluated
	}
	target, err = filepath.Abs(target)
	if err != nil {
		return err
	}
	if statusOnly {
		return selfUpdateStatus(cfg, target, out)
	}
	manifestURL := join(cfg.ConsoleURL, "/api/cli/index.json")
	manifest, link, artifactURL, err := loadUpdateManifest(manifestURL, cfg.ConsoleURL)
	if err != nil {
		return err
	}
	currentHash, _, err := fileSHA256(target)
	if err != nil {
		return fmt.Errorf("현재 CLI 무결성 확인 실패: %w", err)
	}
	comparison, err := compareReleaseVersions(manifest.Version, version)
	if err != nil {
		return err
	}
	report := updateReport{
		CurrentVersion: version, AvailableVersion: manifest.Version, OS: runtime.GOOS, Arch: runtime.GOARCH,
		CurrentSHA256: currentHash, AvailableSHA256: link.SHA256, ManifestURL: manifestURL,
		ArtifactURL: artifactURL, InstalledPath: target,
	}
	sameArtifact := strings.EqualFold(currentHash, link.SHA256)
	switch {
	case comparison < 0:
		report.State = "DowngradeBlocked"
		report.Message = "Console manifest 버전이 현재 CLI보다 낮아 downgrade를 차단했습니다."
	case comparison == 0 && sameArtifact:
		report.State = "Current"
		report.Message = "이미 최신 CLI이며 배포 artifact와 SHA-256도 일치합니다."
	case comparison == 0:
		report.State = "RepublishedVersion"
		report.UpdateAvailable = true
		report.Message = "동일 버전의 artifact SHA-256이 다릅니다. 버전 재게시 여부를 확인해야 합니다."
	default:
		report.State = "UpdateAvailable"
		report.UpdateAvailable = true
		report.Message = "검증 가능한 새 CLI 버전이 있습니다."
	}
	if checkOnly || !report.UpdateAvailable || report.State == "DowngradeBlocked" {
		payload, _ := json.Marshal(report)
		return renderOutput(cfg, out, payload)
	}
	if report.State == "RepublishedVersion" && !force {
		return &CLIError{
			Status: http.StatusConflict, Code: "RepublishedVersion",
			Message: "동일 버전의 배포 artifact가 현재 바이너리와 다릅니다",
			Hint:    "정상적인 재게시임을 확인한 경우에만 'os update --force'를 실행하세요. 권장 방식은 Console CLI 버전을 올려 다시 배포하는 것입니다.",
		}
	}
	staged, err := downloadUpdateArtifact(artifactURL, link, filepath.Dir(target))
	if err != nil {
		return err
	}
	backup := target + ".previous"
	scheduled, err := installDownloadedUpdateFn(staged, target, backup)
	if err != nil {
		_ = os.Remove(staged)
		return err
	}
	report.State = "Updated"
	report.Scheduled = scheduled
	report.BackupPath = backup
	if scheduled {
		report.State = "UpdateScheduled"
		report.Message = "현재 프로세스 종료 후 Windows helper가 검증된 바이너리로 교체합니다. 잠시 후 'os version'으로 확인하세요."
	} else {
		report.Message = "검증된 바이너리로 교체했습니다. 이전 바이너리는 backup 경로에 보관했습니다."
	}
	payload, _ := json.Marshal(report)
	return renderOutput(cfg, out, payload)
}

func selfUpdateStatus(cfg Config, target string, out io.Writer) error {
	resultPath := target + ".update-result.json"
	body, err := os.ReadFile(resultPath)
	if errors.Is(err, os.ErrNotExist) {
		body, _ = json.Marshal(map[string]any{"state": "NoResult", "message": "기록된 비동기 update 결과가 없습니다.", "path": resultPath})
		return renderOutput(cfg, out, body)
	}
	if err != nil {
		return err
	}
	var result map[string]any
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("update 결과 파일이 올바르지 않습니다: %w", err)
	}
	result["path"] = resultPath
	encoded, _ := json.Marshal(result)
	return renderOutput(cfg, out, encoded)
}

func loadUpdateManifest(manifestURL, consoleURL string) (updateManifest, updateLink, string, error) {
	var manifest updateManifest
	body, status, contentType, err := rawRequest(http.MethodGet, manifestURL, nil, "", "")
	if err != nil {
		return manifest, updateLink{}, "", err
	}
	if err := requireOK(body, status); err != nil {
		return manifest, updateLink{}, "", err
	}
	if err := requireJSONResponse(contentType, "CLI update manifest"); err != nil {
		return manifest, updateLink{}, "", err
	}
	if err := json.Unmarshal(body, &manifest); err != nil {
		return manifest, updateLink{}, "", fmt.Errorf("CLI update manifest JSON이 올바르지 않습니다: %w", err)
	}
	if manifest.Name != "os" {
		return manifest, updateLink{}, "", errors.New("CLI update manifest의 name이 os가 아닙니다")
	}
	if _, err := parseReleaseVersion(manifest.Version); err != nil {
		return manifest, updateLink{}, "", fmt.Errorf("CLI update manifest version이 올바르지 않습니다: %w", err)
	}
	if err := verifyUpdateManifestSignature(manifest, consoleURL); err != nil {
		return manifest, updateLink{}, "", err
	}
	var selected *updateLink
	for index := range manifest.Links {
		candidate := &manifest.Links[index]
		if candidate.OS == runtime.GOOS && candidate.Arch == runtime.GOARCH {
			if selected != nil {
				return manifest, updateLink{}, "", errors.New("현재 OS/아키텍처에 대한 update artifact가 중복 선언됐습니다")
			}
			selected = candidate
		}
	}
	if selected == nil {
		return manifest, updateLink{}, "", fmt.Errorf("현재 플랫폼용 update artifact가 없습니다: %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	if selected.Size < 1 || selected.Size > 100*1024*1024 {
		return manifest, updateLink{}, "", errors.New("update artifact 크기가 허용 범위를 벗어났습니다")
	}
	if len(selected.SHA256) != 64 {
		return manifest, updateLink{}, "", errors.New("update artifact SHA-256이 올바르지 않습니다")
	}
	if _, err := hex.DecodeString(selected.SHA256); err != nil {
		return manifest, updateLink{}, "", errors.New("update artifact SHA-256이 올바르지 않습니다")
	}
	artifactURL, err := resolveUpdateArtifactURL(consoleURL, selected.Href)
	if err != nil {
		return manifest, updateLink{}, "", err
	}
	return manifest, *selected, artifactURL, nil
}

func verifyUpdateManifestSignature(manifest updateManifest, consoleURL string) error {
	if manifest.Signature.Algorithm != "Ed25519" || manifest.Signature.KeyID == "" || manifest.Signature.Value == "" {
		return &CLIError{Status: http.StatusConflict, Code: "UnsignedUpdateManifest", Message: "CLI update manifest의 전자서명이 없거나 지원되지 않습니다"}
	}
	publicKeyBase64 := ""
	switch manifest.Signature.KeyID {
	case localUpdateKeyID:
		parsed, err := url.Parse(consoleURL)
		if err != nil || !isLoopbackUpdateHost(parsed.Hostname()) {
			return &CLIError{Status: http.StatusForbidden, Code: "DevelopmentUpdateKeyRejected", Message: "local 개발용 update 서명 키는 localhost Console에서만 사용할 수 있습니다"}
		}
		publicKeyBase64 = localUpdatePublicKey
	case updateProductionKeyID:
		if updateProductionKeyID == "" || updateProductionPublicKey == "" {
			return &CLIError{Status: http.StatusConflict, Code: "UnknownUpdateKey", Message: "CLI가 신뢰하지 않는 update 서명 키입니다"}
		}
		publicKeyBase64 = updateProductionPublicKey
	default:
		return &CLIError{Status: http.StatusConflict, Code: "UnknownUpdateKey", Message: "CLI가 신뢰하지 않는 update 서명 키입니다: " + manifest.Signature.KeyID}
	}
	der, err := base64.StdEncoding.DecodeString(publicKeyBase64)
	if err != nil {
		return errors.New("CLI에 고정된 update 공개 키가 올바르지 않습니다")
	}
	parsedKey, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return errors.New("CLI에 고정된 update 공개 키를 해석할 수 없습니다")
	}
	publicKey, ok := parsedKey.(ed25519.PublicKey)
	if !ok {
		return errors.New("CLI update 공개 키가 Ed25519 키가 아닙니다")
	}
	signature, err := base64.RawURLEncoding.DecodeString(manifest.Signature.Value)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return &CLIError{Status: http.StatusConflict, Code: "InvalidUpdateSignature", Message: "CLI update manifest 서명 형식이 올바르지 않습니다"}
	}
	payload, err := canonicalUpdateManifestPayload(manifest)
	if err != nil {
		return err
	}
	if !ed25519.Verify(publicKey, []byte(payload), signature) {
		return &CLIError{Status: http.StatusConflict, Code: "InvalidUpdateSignature", Message: "CLI update manifest 전자서명 검증에 실패했습니다"}
	}
	return nil
}

func canonicalUpdateManifestPayload(manifest updateManifest) (string, error) {
	clean := func(value, field string) (string, error) {
		if strings.ContainsAny(value, "\r\n\t") {
			return "", fmt.Errorf("update manifest %s에 허용되지 않는 제어 문자가 있습니다", field)
		}
		return value, nil
	}
	name, err := clean(manifest.Name, "name")
	if err != nil {
		return "", err
	}
	manifestVersion, err := clean(manifest.Version, "version")
	if err != nil {
		return "", err
	}
	links := append([]updateLink(nil), manifest.Links...)
	sort.Slice(links, func(left, right int) bool {
		return links[left].OS+"\x00"+links[left].Arch+"\x00"+links[left].Href < links[right].OS+"\x00"+links[right].Arch+"\x00"+links[right].Href
	})
	var payload strings.Builder
	fmt.Fprintf(&payload, "opensphere-cli-update-v1\nname=%s\nversion=%s\n", name, manifestVersion)
	for _, link := range links {
		linkOS, err := clean(link.OS, "link.os")
		if err != nil {
			return "", err
		}
		linkArch, err := clean(link.Arch, "link.arch")
		if err != nil {
			return "", err
		}
		linkHref, err := clean(link.Href, "link.href")
		if err != nil {
			return "", err
		}
		linkHash, err := clean(strings.ToLower(link.SHA256), "link.sha256")
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&payload, "link=%s\t%s\t%s\t%d\t%s\n", linkOS, linkArch, linkHref, link.Size, linkHash)
	}
	return payload.String(), nil
}

func isLoopbackUpdateHost(host string) bool {
	switch strings.ToLower(strings.TrimSpace(host)) {
	case "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}

func resolveUpdateArtifactURL(consoleURL, href string) (string, error) {
	base, err := url.Parse(strings.TrimRight(consoleURL, "/") + "/")
	if err != nil {
		return "", err
	}
	reference, err := url.Parse(href)
	if err != nil || reference.IsAbs() || reference.Host != "" || reference.User != nil || reference.RawQuery != "" || reference.Fragment != "" {
		return "", errors.New("update artifact href는 동일 Console의 상대 경로여야 합니다")
	}
	if !strings.HasPrefix(reference.Path, "/api/cli/") || strings.Contains(reference.Path, "..") {
		return "", errors.New("update artifact href는 /api/cli/ 아래여야 합니다")
	}
	resolved := base.ResolveReference(reference)
	if !strings.EqualFold(resolved.Scheme, base.Scheme) || !strings.EqualFold(resolved.Host, base.Host) {
		return "", errors.New("update artifact가 다른 origin을 가리킵니다")
	}
	if err := validateURL(resolved.String()); err != nil {
		return "", err
	}
	return resolved.String(), nil
}

func downloadUpdateArtifact(artifactURL string, link updateLink, directory string) (string, error) {
	if err := validateURL(artifactURL); err != nil {
		return "", err
	}
	request, err := http.NewRequest(http.MethodGet, artifactURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/octet-stream")
	request.Header.Set("X-OS-Correlation-ID", operationID())
	response, err := client().Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return "", requireOK(body, response.StatusCode)
	}
	mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaType == "text/html" {
		return "", errors.New("update artifact endpoint가 binary 대신 HTML을 반환했습니다")
	}
	if response.ContentLength >= 0 && response.ContentLength != link.Size {
		return "", fmt.Errorf("update artifact Content-Length 불일치: got %d, want %d", response.ContentLength, link.Size)
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	file, err := os.CreateTemp(directory, ".os-update-*"+suffix)
	if err != nil {
		return "", fmt.Errorf("CLI 설치 디렉터리에 update staging 파일을 만들 수 없습니다: %w", err)
	}
	staged := file.Name()
	cleanup := func() {
		_ = file.Close()
		_ = os.Remove(staged)
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, link.Size+1))
	if copyErr != nil {
		cleanup()
		return "", copyErr
	}
	if syncErr := file.Sync(); syncErr != nil {
		cleanup()
		return "", syncErr
	}
	if closeErr := file.Close(); closeErr != nil {
		_ = os.Remove(staged)
		return "", closeErr
	}
	if written != link.Size {
		_ = os.Remove(staged)
		return "", fmt.Errorf("update artifact 크기 불일치: got %d, want %d", written, link.Size)
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if !strings.EqualFold(actual, link.SHA256) {
		_ = os.Remove(staged)
		return "", &CLIError{Status: http.StatusConflict, Code: "DigestMismatch", Message: "update artifact SHA-256 검증에 실패했습니다"}
	}
	if err := os.Chmod(staged, 0o755); err != nil {
		_ = os.Remove(staged)
		return "", err
	}
	return staged, nil
}

func fileSHA256(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}

func parseReleaseVersion(value string) ([3]int, error) {
	var parsed [3]int
	value = strings.TrimPrefix(strings.TrimSpace(value), "v")
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return parsed, errors.New("버전은 major.minor.patch 형식이어야 합니다")
	}
	for index, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return parsed, errors.New("버전 숫자 형식이 올바르지 않습니다")
		}
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 || number > 1_000_000 {
			return parsed, errors.New("버전 숫자 형식이 올바르지 않습니다")
		}
		parsed[index] = number
	}
	return parsed, nil
}

func compareReleaseVersions(available, current string) (int, error) {
	left, err := parseReleaseVersion(available)
	if err != nil {
		return 0, err
	}
	right, err := parseReleaseVersion(current)
	if err != nil {
		return 0, fmt.Errorf("현재 CLI version %q을 비교할 수 없습니다: %w", current, err)
	}
	for index := range left {
		if left[index] > right[index] {
			return 1, nil
		}
		if left[index] < right[index] {
			return -1, nil
		}
	}
	return 0, nil
}
