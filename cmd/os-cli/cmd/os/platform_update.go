package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	platformUpdatePlanAPIVersion = "cli.opensphere.io/v1alpha1"
	platformUpdatePlanKind       = "OpenSpherePlatformUpdatePlan"
	platformReleaseLockKind      = "OpenSphereReleaseLock"
	platformLockLimit            = 4 * 1024 * 1024
)

type platformReleaseComponent struct {
	Repository                  string `json:"repository"`
	Image                       string `json:"image"`
	SourceRevision              string `json:"sourceRevision"`
	RegistryCredentialsRequired bool   `json:"registryCredentialsRequired,omitempty"`
}

type platformReleaseLock struct {
	APIVersion     string                              `json:"apiVersion"`
	Kind           string                              `json:"kind"`
	Channel        string                              `json:"channel"`
	ReleaseDigest  string                              `json:"releaseDigest"`
	Source         string                              `json:"source"`
	SourceRevision string                              `json:"sourceRevision"`
	Components     map[string]platformReleaseComponent `json:"components"`
}

type platformReleaseDocument struct {
	Lock platformReleaseLock
	Raw  json.RawMessage
}

type platformUpdatePlan struct {
	APIVersion            string          `json:"apiVersion"`
	Kind                  string          `json:"kind"`
	ID                    string          `json:"id"`
	CreatedAt             string          `json:"createdAt"`
	Channel               string          `json:"channel"`
	Context               string          `json:"context,omitempty"`
	CurrentReleaseDigest  string          `json:"currentReleaseDigest"`
	CurrentSourceRevision string          `json:"currentSourceRevision"`
	TargetReleaseDigest   string          `json:"targetReleaseDigest"`
	TargetSourceRevision  string          `json:"targetSourceRevision"`
	ChangedComponents     []string        `json:"changedComponents"`
	TargetLock            json.RawMessage `json:"targetLock"`
	Digest                string          `json:"digest"`
}

type platformUpdateReport struct {
	State                   string   `json:"state"`
	Channel                 string   `json:"channel"`
	Context                 string   `json:"context,omitempty"`
	CurrentReleaseDigest    string   `json:"currentReleaseDigest"`
	AvailableReleaseDigest  string   `json:"availableReleaseDigest"`
	CurrentSourceRevision   string   `json:"currentSourceRevision"`
	AvailableSourceRevision string   `json:"availableSourceRevision"`
	UpdateAvailable         bool     `json:"updateAvailable"`
	ChangedComponents       []string `json:"changedComponents"`
	PlanID                  string   `json:"planId,omitempty"`
	PlanPath                string   `json:"planPath,omitempty"`
	Message                 string   `json:"message"`
	Transcript              string   `json:"transcript,omitempty"`
	RequestID               string   `json:"requestId,omitempty"`
	PullRequest             int      `json:"pullRequest,omitempty"`
}

var (
	platformUpdatePlanDirectoryFn = platformUpdatePlanDirectory
	readConsolePlatformReleaseFn  = readConsolePlatformRelease
	requestPlatformReleaseFn      = requestPlatformRelease
)

func platformUpdate(cfg Config, args []string, in io.Reader, out io.Writer) error {
	if len(args) < 2 || strings.ToLower(args[0]) != "update" {
		return usageError("사용법: os platform update check|plan|apply ...")
	}
	action := strings.ToLower(strings.TrimSpace(args[1]))
	flags := parseLongFlags(args[2:])
	switch action {
	case "check":
		return checkPlatformUpdate(cfg, flags, out)
	case "plan":
		return planPlatformUpdate(cfg, flags, out)
	case "apply":
		positionals := nonFlagArgs(args[2:])
		if len(positionals) != 1 {
			return usageError("사용법: os platform update apply <plan-id> --reason TEXT")
		}
		return applyPlatformUpdatePlan(cfg, positionals[0], flags, out)
	default:
		return usageErrorf("알 수 없는 platform update 작업 %q; check, plan, apply 중 하나를 사용하세요", action)
	}
}

func targetPlatformRelease(flags map[string]string) (platformReleaseDocument, error) {
	lockPath := strings.TrimSpace(flags["lock"])
	if lockPath == "" {
		return platformReleaseDocument{}, usageError("--lock <OpenSphereReleaseLock.json>을 명시해야 합니다")
	}
	target, err := readPlatformReleaseDocument(lockPath)
	if err != nil {
		return platformReleaseDocument{}, fmt.Errorf("target release lock 검증 실패: %w", err)
	}
	channel := strings.ToLower(strings.TrimSpace(flags["channel"]))
	if channel != "" && target.Lock.Channel != channel {
		return platformReleaseDocument{}, usageErrorf("release lock channel %q가 --channel %q와 다릅니다", target.Lock.Channel, channel)
	}
	return target, nil
}

func checkPlatformUpdate(cfg Config, flags map[string]string, out io.Writer) error {
	target, err := targetPlatformRelease(flags)
	if err != nil {
		return err
	}
	current, err := readConsolePlatformReleaseFn(cfg)
	if err != nil {
		return err
	}
	report := newPlatformUpdateReport(current.Lock, target.Lock, "")
	return renderPlatformUpdateReport(cfg, out, report)
}

func planPlatformUpdate(cfg Config, flags map[string]string, out io.Writer) error {
	target, err := targetPlatformRelease(flags)
	if err != nil {
		return err
	}
	current, err := readConsolePlatformReleaseFn(cfg)
	if err != nil {
		return err
	}
	report := newPlatformUpdateReport(current.Lock, target.Lock, "")
	if !report.UpdateAvailable {
		return renderPlatformUpdateReport(cfg, out, report)
	}
	plan := platformUpdatePlan{
		APIVersion:            platformUpdatePlanAPIVersion,
		Kind:                  platformUpdatePlanKind,
		CreatedAt:             time.Now().UTC().Format(time.RFC3339),
		Channel:               target.Lock.Channel,
		CurrentReleaseDigest:  current.Lock.ReleaseDigest,
		CurrentSourceRevision: current.Lock.SourceRevision,
		TargetReleaseDigest:   target.Lock.ReleaseDigest,
		TargetSourceRevision:  target.Lock.SourceRevision,
		ChangedComponents:     append([]string(nil), report.ChangedComponents...),
		TargetLock:            append(json.RawMessage(nil), target.Raw...),
	}
	if err := signPlatformUpdatePlan(&plan); err != nil {
		return err
	}
	path, err := savePlatformUpdatePlan(plan)
	if err != nil {
		return err
	}
	report.State = "PlanCreated"
	report.PlanID = plan.ID
	report.PlanPath = path
	report.Message = "검증된 Platform update plan을 생성했습니다. 적용 전 대상 digest와 변경 구성요소를 검토하세요."
	return renderPlatformUpdateReport(cfg, out, report)
}

func applyPlatformUpdatePlan(cfg Config, id string, flags map[string]string, out io.Writer) error {
	reason := strings.TrimSpace(flags["reason"])
	if len(reason) < 8 {
		return usageError("--reason에는 8자 이상의 운영 승인 사유가 필요합니다")
	}
	plan, err := loadPlatformUpdatePlan(id)
	if err != nil {
		return err
	}
	current, err := readConsolePlatformReleaseFn(cfg)
	if err != nil {
		return err
	}
	target, err := parsePlatformReleaseDocument(plan.TargetLock)
	if err != nil {
		return fmt.Errorf("plan target release lock 검증 실패: %w", err)
	}
	if target.Lock.Channel != plan.Channel ||
		target.Lock.ReleaseDigest != plan.TargetReleaseDigest ||
		target.Lock.SourceRevision != plan.TargetSourceRevision {
		return errors.New("platform update plan metadata와 target release lock이 일치하지 않습니다; plan을 다시 생성하세요")
	}
	if current.Lock.ReleaseDigest == plan.TargetReleaseDigest {
		report := newPlatformUpdateReport(current.Lock, target.Lock, "")
		report.State = "Current"
		report.Message = "요청한 Platform release가 이미 설치되어 있습니다."
		return renderPlatformUpdateReport(cfg, out, report)
	}
	if current.Lock.ReleaseDigest != plan.CurrentReleaseDigest {
		return fmt.Errorf("platform update plan이 오래되었습니다: 현재 cluster digest는 %s, plan 기준은 %s입니다; check와 plan을 다시 실행하세요", current.Lock.ReleaseDigest, plan.CurrentReleaseDigest)
	}
	requested, err := requestPlatformReleaseFn(cfg, plan, target, reason)
	if err != nil {
		return err
	}
	report := newPlatformUpdateReport(current.Lock, target.Lock, "")
	report.State = "Requested"
	report.ChangedComponents = append([]string(nil), plan.ChangedComponents...)
	report.Message = "Console 변경 요청을 생성했습니다. 요청자와 다른 관리자가 Gitea PR을 승인하면 전용 executor가 공급망 검증·upgrade·실패 시 rollback을 수행합니다."
	report.RequestID = requested.RequestID
	report.PullRequest = requested.PullRequest.Number
	return renderPlatformUpdateReport(cfg, out, report)
}

func newPlatformUpdateReport(current, available platformReleaseLock, context string) platformUpdateReport {
	changed := changedPlatformComponents(current, available)
	updateAvailable := current.ReleaseDigest != available.ReleaseDigest
	state := "Current"
	message := "현재 설치된 Platform release가 선택한 GHCR 채널의 최신 서명 release와 일치합니다."
	if updateAvailable {
		state = "UpdateAvailable"
		message = "선택한 GHCR 채널에 새로운 서명 Platform release가 있습니다. 적용하려면 먼저 plan을 생성하세요."
	}
	return platformUpdateReport{
		State:                   state,
		Channel:                 available.Channel,
		Context:                 context,
		CurrentReleaseDigest:    current.ReleaseDigest,
		AvailableReleaseDigest:  available.ReleaseDigest,
		CurrentSourceRevision:   current.SourceRevision,
		AvailableSourceRevision: available.SourceRevision,
		UpdateAvailable:         updateAvailable,
		ChangedComponents:       changed,
		Message:                 message,
	}
}

func changedPlatformComponents(current, target platformReleaseLock) []string {
	names := make(map[string]struct{}, len(current.Components)+len(target.Components))
	for name := range current.Components {
		names[name] = struct{}{}
	}
	for name := range target.Components {
		names[name] = struct{}{}
	}
	changed := make([]string, 0, len(names))
	for name := range names {
		if current.Components[name].Image != target.Components[name].Image {
			changed = append(changed, name)
		}
	}
	sort.Strings(changed)
	return changed
}

func renderPlatformUpdateReport(cfg Config, out io.Writer, report platformUpdateReport) error {
	raw, err := json.Marshal(report)
	if err != nil {
		return err
	}
	return renderOutput(cfg, out, raw)
}

func readConsolePlatformRelease(cfg Config) (platformReleaseDocument, error) {
	raw, status, err := request(cfg, http.MethodGet, join(cfg.ConsoleURL, "/api/platform/releases/status"), nil, "")
	if err != nil {
		return platformReleaseDocument{}, fmt.Errorf("Console Platform Release 상태 조회 실패: %w", err)
	}
	if status != http.StatusOK {
		return platformReleaseDocument{}, platformAPIError(status, raw)
	}
	var response struct {
		Current struct {
			Channel        string                              `json:"channel"`
			ReleaseDigest  string                              `json:"releaseDigest"`
			SourceRevision string                              `json:"sourceRevision"`
			Components     map[string]platformReleaseComponent `json:"components"`
		} `json:"current"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return platformReleaseDocument{}, fmt.Errorf("Console Platform Release 응답 파싱 실패: %w", err)
	}
	lock := platformReleaseLock{
		APIVersion:     "release.opensphere.io/v1alpha1",
		Kind:           platformReleaseLockKind,
		Channel:        response.Current.Channel,
		ReleaseDigest:  response.Current.ReleaseDigest,
		Source:         "https://github.com/opensphere-platform/OpenSphere-console",
		SourceRevision: response.Current.SourceRevision,
		Components:     response.Current.Components,
	}
	encoded, err := json.Marshal(lock)
	if err != nil {
		return platformReleaseDocument{}, err
	}
	return parsePlatformReleaseDocument(encoded)
}

type platformReleaseRequest struct {
	RequestID   string `json:"requestId"`
	PullRequest struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
	} `json:"pullRequest"`
}

func requestPlatformRelease(cfg Config, plan platformUpdatePlan, target platformReleaseDocument, reason string) (platformReleaseRequest, error) {
	payload, err := json.Marshal(map[string]any{
		"consumerId": "platform-release",
		"action":     "apply",
		"target":     "opensphere-platform",
		"reason":     reason,
		"desiredState": map[string]any{
			"contract":              "opensphere.platform.release/v1",
			"previousReleaseDigest": plan.CurrentReleaseDigest,
			"targetLock":            json.RawMessage(target.Raw),
		},
	})
	if err != nil {
		return platformReleaseRequest{}, err
	}
	raw, status, requestErr := request(cfg, http.MethodPost, join(cfg.ConsoleURL, "/api/platform/changes"), bytes.NewReader(payload), "application/json")
	if requestErr != nil {
		return platformReleaseRequest{}, fmt.Errorf("Console Platform Release 요청 실패: %w", requestErr)
	}
	if status != http.StatusAccepted {
		return platformReleaseRequest{}, platformAPIError(status, raw)
	}
	var response platformReleaseRequest
	if err := json.Unmarshal(raw, &response); err != nil || response.RequestID == "" {
		return platformReleaseRequest{}, errors.New("Console Platform Release 요청 응답이 올바르지 않습니다")
	}
	return response, nil
}

func platformAPIError(status int, raw []byte) error {
	var body struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(raw, &body)
	message := strings.TrimSpace(body.Error)
	if message == "" {
		message = strings.TrimSpace(string(raw))
	}
	if len(message) > 500 {
		message = message[:500]
	}
	if message == "" {
		message = http.StatusText(status)
	}
	if status == http.StatusPreconditionRequired {
		return fmt.Errorf("HTTP %d: %s; 최근 AAL2 확인 후 Console의 Platform Release 화면에서 요청하거나 CLI step-up을 완료하세요", status, message)
	}
	return fmt.Errorf("HTTP %d: %s", status, message)
}

func readPlatformReleaseDocument(path string) (platformReleaseDocument, error) {
	file, err := os.Open(path)
	if err != nil {
		return platformReleaseDocument{}, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, platformLockLimit+1))
	if err != nil {
		return platformReleaseDocument{}, err
	}
	if len(raw) > platformLockLimit {
		return platformReleaseDocument{}, errors.New("release lock은 4 MiB를 초과할 수 없습니다")
	}
	return parsePlatformReleaseDocument(raw)
}

func parsePlatformReleaseDocument(raw []byte) (platformReleaseDocument, error) {
	raw = bytes.TrimSpace(raw)
	var lock platformReleaseLock
	if err := json.Unmarshal(raw, &lock); err != nil {
		return platformReleaseDocument{}, fmt.Errorf("release lock JSON 파싱 실패: %w", err)
	}
	if lock.Kind != platformReleaseLockKind || lock.APIVersion == "" {
		return platformReleaseDocument{}, errors.New("지원하지 않거나 손상된 OpenSphere release lock입니다")
	}
	if !validPlatformDigest(lock.ReleaseDigest) {
		return platformReleaseDocument{}, errors.New("release lock digest가 유효한 sha256 값이 아닙니다")
	}
	if lock.Channel != "edge" {
		return platformReleaseDocument{}, errors.New("release lock channel이 유효하지 않습니다")
	}
	if len(lock.SourceRevision) != 40 {
		return platformReleaseDocument{}, errors.New("release lock source revision이 유효하지 않습니다")
	}
	if _, err := hex.DecodeString(lock.SourceRevision); err != nil {
		return platformReleaseDocument{}, errors.New("release lock source revision이 유효하지 않습니다")
	}
	if len(lock.Components) == 0 {
		return platformReleaseDocument{}, errors.New("release lock에 component가 없습니다")
	}
	for name, component := range lock.Components {
		if strings.TrimSpace(name) == "" || !strings.Contains(component.Image, "@sha256:") || !validPlatformDigest("sha256:"+strings.SplitN(component.Image, "@sha256:", 2)[1]) {
			return platformReleaseDocument{}, fmt.Errorf("component %q image가 digest-pinned 형식이 아닙니다", name)
		}
	}
	return platformReleaseDocument{Lock: lock, Raw: append(json.RawMessage(nil), raw...)}, nil
}

func validPlatformDigest(value string) bool {
	if !strings.HasPrefix(value, "sha256:") || len(value) != len("sha256:")+64 {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}

func signPlatformUpdatePlan(plan *platformUpdatePlan) error {
	plan.ID, plan.Digest = "", ""
	raw, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(raw)
	plan.Digest = "sha256:" + hex.EncodeToString(digest[:])
	plan.ID = hex.EncodeToString(digest[:10])
	return nil
}

func savePlatformUpdatePlan(plan platformUpdatePlan) (string, error) {
	directory, err := platformUpdatePlanDirectoryFn()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	_ = os.Chmod(directory, 0o700)
	path := filepath.Join(directory, plan.ID+".json")
	raw, err := json.MarshalIndent(plan, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o600); err != nil {
		return "", err
	}
	_ = os.Chmod(path, 0o600)
	return path, nil
}

func loadPlatformUpdatePlan(id string) (platformUpdatePlan, error) {
	if len(id) != 20 {
		return platformUpdatePlan{}, usageError("platform update plan ID는 20자리 hex 값이어야 합니다")
	}
	if _, err := hex.DecodeString(id); err != nil {
		return platformUpdatePlan{}, usageError("platform update plan ID는 20자리 hex 값이어야 합니다")
	}
	directory, err := platformUpdatePlanDirectoryFn()
	if err != nil {
		return platformUpdatePlan{}, err
	}
	raw, err := os.ReadFile(filepath.Join(directory, id+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return platformUpdatePlan{}, fmt.Errorf("platform update plan을 찾을 수 없습니다: %s", id)
	}
	if err != nil {
		return platformUpdatePlan{}, err
	}
	var plan platformUpdatePlan
	if err := json.Unmarshal(raw, &plan); err != nil {
		return platformUpdatePlan{}, fmt.Errorf("platform update plan 파싱 실패: %w", err)
	}
	savedID, savedDigest := plan.ID, plan.Digest
	if plan.APIVersion != platformUpdatePlanAPIVersion || plan.Kind != platformUpdatePlanKind || savedID != id {
		return platformUpdatePlan{}, errors.New("지원하지 않거나 손상된 platform update plan입니다")
	}
	if plan.Channel != "edge" {
		return platformUpdatePlan{}, errors.New("platform update plan channel이 유효하지 않습니다")
	}
	if plan.Context != "" {
		if err := validateNativeOptionValue("context", plan.Context); err != nil {
			return platformUpdatePlan{}, fmt.Errorf("platform update plan context가 유효하지 않습니다: %w", err)
		}
	}
	if !validPlatformDigest(plan.CurrentReleaseDigest) || !validPlatformDigest(plan.TargetReleaseDigest) {
		return platformUpdatePlan{}, errors.New("platform update plan release digest가 유효하지 않습니다")
	}
	if err := signPlatformUpdatePlan(&plan); err != nil {
		return platformUpdatePlan{}, err
	}
	if plan.ID != savedID || plan.Digest != savedDigest {
		return platformUpdatePlan{}, errors.New("platform update plan digest 검증에 실패했습니다; plan을 다시 생성하세요")
	}
	target, err := parsePlatformReleaseDocument(plan.TargetLock)
	if err != nil {
		return platformUpdatePlan{}, fmt.Errorf("platform update plan의 target lock이 유효하지 않습니다: %w", err)
	}
	if target.Lock.Channel != plan.Channel ||
		target.Lock.ReleaseDigest != plan.TargetReleaseDigest ||
		target.Lock.SourceRevision != plan.TargetSourceRevision {
		return platformUpdatePlan{}, errors.New("platform update plan metadata와 target release lock이 일치하지 않습니다")
	}
	return plan, nil
}

func platformUpdatePlanDirectory() (string, error) {
	if value := strings.TrimSpace(os.Getenv("OS_PLATFORM_UPDATE_PLAN_DIR")); value != "" {
		return filepath.Abs(value)
	}
	path, err := configPath()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(path), "platform-update-plans"), nil
}

func displayPlatformContext(context string) string {
	if context == "" {
		return "current-context"
	}
	return context
}

func limitPlatformTranscript(value string) string {
	const limit = 32 * 1024
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[len(value)-limit:]
}
