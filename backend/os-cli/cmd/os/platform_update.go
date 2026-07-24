package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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

type platformRegistryCredentials struct {
	Username string
	Token    string
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
}

var (
	resolvePlatformReleaseFn       = resolvePlatformRelease
	readInstalledPlatformReleaseFn = readInstalledPlatformRelease
	applyPlatformReleaseFn         = applyPlatformRelease
	platformUpdatePlanDirectoryFn  = platformUpdatePlanDirectory
)

func platformUpdate(cfg Config, args []string, in io.Reader, out io.Writer) error {
	if len(args) < 2 || strings.ToLower(args[0]) != "update" {
		return usageError("사용법: os platform update check|plan|apply ...")
	}
	action := strings.ToLower(strings.TrimSpace(args[1]))
	flags := parseLongFlags(args[2:])
	credentials, err := platformRegistryCredentialsFromInput(flags, in)
	if err != nil {
		return err
	}
	switch action {
	case "check":
		return checkPlatformUpdate(cfg, flags, credentials, out)
	case "plan":
		return planPlatformUpdate(cfg, flags, credentials, out)
	case "apply":
		positionals := nonFlagArgs(args[2:])
		if len(positionals) != 1 {
			return usageError("사용법: os platform update apply <plan-id> [--context NAME]")
		}
		return applyPlatformUpdatePlan(cfg, positionals[0], flags, credentials, out)
	default:
		return usageErrorf("알 수 없는 platform update 작업 %q; check, plan, apply 중 하나를 사용하세요", action)
	}
}

func platformRegistryCredentialsFromInput(flags map[string]string, in io.Reader) (*platformRegistryCredentials, error) {
	username := strings.TrimSpace(flags["registry-username"])
	fromStdin := flags["registry-token-stdin"] == "true"
	if username == "" && !fromStdin {
		return nil, nil
	}
	if username == "" || !fromStdin {
		return nil, usageError("--registry-username과 --registry-token-stdin은 함께 지정해야 합니다")
	}
	raw, err := io.ReadAll(io.LimitReader(in, 4097))
	if err != nil {
		return nil, fmt.Errorf("registry token 읽기 실패: %w", err)
	}
	if len(raw) > 4096 {
		return nil, usageError("registry token은 4 KiB를 초과할 수 없습니다")
	}
	token := strings.TrimSpace(string(raw))
	if token == "" || strings.ContainsAny(token, " \t\r\n") {
		return nil, usageError("registry token은 비어 있거나 공백을 포함할 수 없습니다")
	}
	return &platformRegistryCredentials{Username: username, Token: token}, nil
}

func checkPlatformUpdate(cfg Config, flags map[string]string, credentials *platformRegistryCredentials, out io.Writer) error {
	channel, context, err := platformUpdateTarget(flags)
	if err != nil {
		return err
	}
	current, err := readInstalledPlatformReleaseFn(context)
	if err != nil {
		return err
	}
	available, err := resolvePlatformReleaseFn(channel, credentials)
	if err != nil {
		return err
	}
	if available.Lock.Channel != channel {
		return fmt.Errorf("해석된 release channel %q가 요청한 channel %q와 다릅니다", available.Lock.Channel, channel)
	}
	report := newPlatformUpdateReport(current.Lock, available.Lock, context)
	return renderPlatformUpdateReport(cfg, out, report)
}

func planPlatformUpdate(cfg Config, flags map[string]string, credentials *platformRegistryCredentials, out io.Writer) error {
	channel, context, err := platformUpdateTarget(flags)
	if err != nil {
		return err
	}
	current, err := readInstalledPlatformReleaseFn(context)
	if err != nil {
		return err
	}
	available, err := resolvePlatformReleaseFn(channel, credentials)
	if err != nil {
		return err
	}
	if available.Lock.Channel != channel {
		return fmt.Errorf("해석된 release channel %q가 요청한 channel %q와 다릅니다", available.Lock.Channel, channel)
	}
	report := newPlatformUpdateReport(current.Lock, available.Lock, context)
	if !report.UpdateAvailable {
		return renderPlatformUpdateReport(cfg, out, report)
	}
	plan := platformUpdatePlan{
		APIVersion:            platformUpdatePlanAPIVersion,
		Kind:                  platformUpdatePlanKind,
		CreatedAt:             time.Now().UTC().Format(time.RFC3339),
		Channel:               channel,
		Context:               context,
		CurrentReleaseDigest:  current.Lock.ReleaseDigest,
		CurrentSourceRevision: current.Lock.SourceRevision,
		TargetReleaseDigest:   available.Lock.ReleaseDigest,
		TargetSourceRevision:  available.Lock.SourceRevision,
		ChangedComponents:     append([]string(nil), report.ChangedComponents...),
		TargetLock:            append(json.RawMessage(nil), available.Raw...),
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

func applyPlatformUpdatePlan(cfg Config, id string, flags map[string]string, credentials *platformRegistryCredentials, out io.Writer) error {
	plan, err := loadPlatformUpdatePlan(id)
	if err != nil {
		return err
	}
	requestedContext := strings.TrimSpace(flags["context"])
	if requestedContext != "" && requestedContext != plan.Context {
		return usageErrorf("plan은 Kubernetes context %q용입니다; 다른 context에는 plan을 다시 생성하세요", displayPlatformContext(plan.Context))
	}
	current, err := readInstalledPlatformReleaseFn(plan.Context)
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
		report := newPlatformUpdateReport(current.Lock, target.Lock, plan.Context)
		report.State = "Current"
		report.Message = "요청한 Platform release가 이미 설치되어 있습니다."
		return renderPlatformUpdateReport(cfg, out, report)
	}
	if current.Lock.ReleaseDigest != plan.CurrentReleaseDigest {
		return fmt.Errorf("platform update plan이 오래되었습니다: 현재 cluster digest는 %s, plan 기준은 %s입니다; check와 plan을 다시 실행하세요", current.Lock.ReleaseDigest, plan.CurrentReleaseDigest)
	}
	transcript, err := applyPlatformReleaseFn(plan.Channel, plan.Context, plan.TargetLock, credentials)
	if err != nil {
		return err
	}
	installed, err := readInstalledPlatformReleaseFn(plan.Context)
	if err != nil {
		return fmt.Errorf("upgrade 후 cluster release lock 확인 실패: %w", err)
	}
	if installed.Lock.ReleaseDigest != plan.TargetReleaseDigest {
		return fmt.Errorf("upgrade 검증 실패: cluster digest %s가 target %s와 다릅니다", installed.Lock.ReleaseDigest, plan.TargetReleaseDigest)
	}
	report := newPlatformUpdateReport(installed.Lock, target.Lock, plan.Context)
	report.State = "Applied"
	report.ChangedComponents = append([]string(nil), plan.ChangedComponents...)
	report.Message = "서명된 Platform release 적용과 설치 잠금 검증을 완료했습니다. Setup이 설치한 새 Console-native CLI는 새 shell에서 'os version'과 'os update --check'로 확인하세요."
	report.Transcript = limitPlatformTranscript(transcript)
	return renderPlatformUpdateReport(cfg, out, report)
}

func platformUpdateTarget(flags map[string]string) (string, string, error) {
	channel := strings.ToLower(strings.TrimSpace(flags["channel"]))
	if channel == "" {
		return "", "", usageError("--channel edge|candidate|stable을 명시해야 합니다")
	}
	switch channel {
	case "edge", "candidate", "stable":
	default:
		return "", "", usageError("--channel은 edge, candidate, stable 중 하나여야 합니다")
	}
	return channel, strings.TrimSpace(flags["context"]), nil
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

func resolvePlatformRelease(channel string, credentials *platformRegistryCredentials) (platformReleaseDocument, error) {
	work, err := os.MkdirTemp("", "opensphere-platform-resolve-")
	if err != nil {
		return platformReleaseDocument{}, err
	}
	defer os.RemoveAll(work)
	lockPath := filepath.Join(work, channel+"-release-lock.json")
	args := []string{"resolve", "--release", channel, "--lock", lockPath}
	stdin := platformRegistryArgs(&args, credentials)
	if _, err := runPlatformCommand("opensphere-setup", args, stdin); err != nil {
		return platformReleaseDocument{}, fmt.Errorf("GHCR %s 채널 release 해석 실패: %w", channel, err)
	}
	return readPlatformReleaseDocument(lockPath)
}

func readInstalledPlatformRelease(context string) (platformReleaseDocument, error) {
	args := make([]string, 0, 10)
	if context != "" {
		args = append(args, "--context", context)
	}
	args = append(args, "-n", "opensphere-console", "get", "configmap", "opensphere-installation-lock", "-o", "json")
	raw, err := runPlatformCommand("kubectl", args, nil)
	if err != nil {
		return platformReleaseDocument{}, fmt.Errorf("cluster 설치 잠금 조회 실패(context=%s): %w", displayPlatformContext(context), err)
	}
	var configMap struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal(raw, &configMap); err != nil {
		return platformReleaseDocument{}, fmt.Errorf("cluster 설치 잠금 ConfigMap 파싱 실패: %w", err)
	}
	lock := strings.TrimSpace(configMap.Data["release.json"])
	if lock == "" {
		return platformReleaseDocument{}, errors.New("opensphere-installation-lock ConfigMap에 release.json이 없습니다")
	}
	return parsePlatformReleaseDocument([]byte(lock))
}

func applyPlatformRelease(channel, context string, targetLock json.RawMessage, credentials *platformRegistryCredentials) (string, error) {
	work, err := os.MkdirTemp("", "opensphere-platform-apply-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	lockPath := filepath.Join(work, channel+"-release-lock.json")
	if err := os.WriteFile(lockPath, append(append([]byte(nil), targetLock...), '\n'), 0o600); err != nil {
		return "", err
	}
	_ = os.Chmod(lockPath, 0o600)
	args := []string{"upgrade", "--release", channel, "--lock", lockPath}
	if context != "" {
		args = append(args, "--context", context)
	}
	stdin := platformRegistryArgs(&args, credentials)
	output, err := runPlatformCommand("opensphere-setup", args, stdin)
	if err != nil {
		return "", fmt.Errorf("Platform upgrade 트랜잭션 실패: %w", err)
	}
	return string(output), nil
}

func platformRegistryArgs(args *[]string, credentials *platformRegistryCredentials) []byte {
	if credentials == nil {
		return nil
	}
	*args = append(*args, "--registry-username", credentials.Username, "--registry-token-stdin")
	return []byte(credentials.Token + "\n")
}

func runPlatformCommand(name string, args []string, stdin []byte) ([]byte, error) {
	path, err := findPlatformCommand(name)
	if err != nil {
		return nil, err
	}
	var command *exec.Cmd
	extension := strings.ToLower(filepath.Ext(path))
	if runtime.GOOS == "windows" && (extension == ".cmd" || extension == ".bat") {
		command = exec.Command(env("ComSpec", "cmd.exe"), append([]string{"/d", "/s", "/c", path}, args...)...)
	} else {
		command = exec.Command(path, args...)
	}
	if stdin != nil {
		command.Stdin = bytes.NewReader(stdin)
	}
	output, commandErr := command.CombinedOutput()
	if commandErr != nil {
		detail := limitPlatformTranscript(string(output))
		if detail == "" {
			detail = commandErr.Error()
		}
		return nil, fmt.Errorf("%s 실행 실패: %s", name, detail)
	}
	return output, nil
}

func findPlatformCommand(name string) (string, error) {
	candidates := []string{name}
	if runtime.GOOS == "windows" {
		candidates = []string{name + ".exe", name + ".cmd", name + ".bat", name}
	}
	for _, candidate := range candidates {
		if path, err := exec.LookPath(candidate); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("%s를 PATH에서 찾을 수 없습니다; OpenSphere Setup CLI와 kubectl을 먼저 설치하세요", name)
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
	if lock.Channel != "edge" && lock.Channel != "candidate" && lock.Channel != "stable" {
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
	if plan.Channel != "edge" && plan.Channel != "candidate" && plan.Channel != "stable" {
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
