package main

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

const (
	fixedSessionClass      = "operator-interactive"
	fixedRuntimeAdapterID  = "cbss.kubernetes-pod"
	fixedNetworkProfile    = "console-only"
	fixedPTYMaxProcesses   = uint64(256)
	fixedConsoleAPIURL     = "https://opensphere-shell-console-api.opensphere-console.svc.cluster.local:8445"
	defaultAgentListenAddr = ":8443"
	defaultPTYListenAddr   = "127.0.0.1:8081"
)

var opaqueIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$`)

type runtimeBinding struct {
	SessionID          string `json:"sessionId"`
	ActorID            string `json:"actorId"`
	Origin             string `json:"origin"`
	SessionClass       string `json:"sessionClass"`
	RuntimeAdapterID   string `json:"runtimeAdapterId"`
	NetworkProfile     string `json:"networkProfile"`
	RuntimeUID         string `json:"runtimeUid"`
	PermissionRevision string `json:"permissionRevision"`
	AssuranceLevel     string `json:"aal"`
	ReleaseEvidenceRef string `json:"releaseEvidenceRef"`
	Generation         int64  `json:"generation"`
	FencingEpoch       int64  `json:"fencingEpoch"`
}

func loadRuntimeBinding() (runtimeBinding, error) {
	if value := strings.TrimSpace(os.Getenv("OPENSPHERE_SHELL_MAX_PROCESSES")); value != strconv.FormatUint(fixedPTYMaxProcesses, 10) {
		return runtimeBinding{}, fmt.Errorf("OPENSPHERE_SHELL_MAX_PROCESSES must be the server-owned fixed value %d", fixedPTYMaxProcesses)
	}
	binding := runtimeBinding{
		SessionID:          strings.TrimSpace(os.Getenv("OPENSPHERE_SHELL_SESSION_ID")),
		ActorID:            strings.TrimSpace(os.Getenv("OPENSPHERE_SHELL_ACTOR_ID")),
		Origin:             strings.TrimSpace(os.Getenv("OPENSPHERE_SHELL_ORIGIN")),
		SessionClass:       strings.TrimSpace(os.Getenv("OPENSPHERE_SHELL_SESSION_CLASS")),
		RuntimeAdapterID:   strings.TrimSpace(os.Getenv("OPENSPHERE_SHELL_RUNTIME_ADAPTER_ID")),
		NetworkProfile:     strings.TrimSpace(os.Getenv("OPENSPHERE_SHELL_NETWORK_PROFILE")),
		RuntimeUID:         strings.TrimSpace(os.Getenv("OPENSPHERE_SHELL_RUNTIME_UID")),
		PermissionRevision: strings.TrimSpace(os.Getenv("OPENSPHERE_SHELL_PERMISSION_REVISION")),
		AssuranceLevel:     strings.TrimSpace(os.Getenv("OPENSPHERE_SHELL_AAL")),
		ReleaseEvidenceRef: strings.TrimSpace(os.Getenv("OPENSPHERE_SHELL_RELEASE_EVIDENCE_REF")),
	}
	var err error
	binding.Generation, err = positiveInt64Env("OPENSPHERE_SHELL_GENERATION")
	if err != nil {
		return binding, err
	}
	binding.FencingEpoch, err = positiveInt64Env("OPENSPHERE_SHELL_FENCING_EPOCH")
	if err != nil {
		return binding, err
	}
	if err := binding.validate(); err != nil {
		return binding, err
	}
	for _, forbidden := range []string{
		"OPENSPHERE_SHELL_RUNTIME_CLASS", "OPENSPHERE_SHELL_COMMAND", "OPENSPHERE_SHELL_PODSPEC",
		"OPENSPHERE_SHELL_VMISPEC", "OPENSPHERE_SHELL_KUBEVIRT", "KUBECONFIG",
	} {
		if strings.TrimSpace(os.Getenv(forbidden)) != "" {
			return binding, fmt.Errorf("%s is forbidden in the closed operator-interactive runtime", forbidden)
		}
	}
	return binding, nil
}

func (b runtimeBinding) validate() error {
	for name, value := range map[string]string{
		"sessionId": b.SessionID, "actorId": b.ActorID, "runtimeUid": b.RuntimeUID,
		"permissionRevision": b.PermissionRevision, "aal": b.AssuranceLevel,
		"releaseEvidenceRef": b.ReleaseEvidenceRef,
	} {
		if !opaqueIDPattern.MatchString(value) {
			return fmt.Errorf("invalid or missing server-owned %s", name)
		}
	}
	if b.SessionClass != fixedSessionClass {
		return fmt.Errorf("unsupported sessionClass %q", b.SessionClass)
	}
	if b.RuntimeAdapterID != fixedRuntimeAdapterID {
		return fmt.Errorf("unsupported runtimeAdapterId %q; KubeVirt is not implemented", b.RuntimeAdapterID)
	}
	if b.NetworkProfile != fixedNetworkProfile {
		return fmt.Errorf("unsupported networkProfile %q", b.NetworkProfile)
	}
	if b.Generation < 1 || b.FencingEpoch < 1 {
		return fmt.Errorf("generation and fencingEpoch must be positive")
	}
	origin, err := url.Parse(b.Origin)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return fmt.Errorf("origin must be an exact HTTPS origin")
	}
	return nil
}

func positiveInt64Env(name string) (int64, error) {
	value, err := strconv.ParseInt(strings.TrimSpace(os.Getenv(name)), 10, 64)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

func validatedHTTPSURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("runtime authority endpoint must use HTTPS")
	}
	return parsed, nil
}

func loadConsoleAPIURL() (string, error) {
	parsed, err := validatedHTTPSURL(os.Getenv("OPENSPHERE_SHELL_CONSOLE_API_URL"))
	if err != nil || parsed.String() != fixedConsoleAPIURL {
		return "", fmt.Errorf("OPENSPHERE_SHELL_CONSOLE_API_URL must be the closed CBSS Console API endpoint")
	}
	return parsed.String(), nil
}
