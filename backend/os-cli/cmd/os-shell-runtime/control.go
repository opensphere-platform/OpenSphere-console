package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const projectedBootstrapTokenPath = "/var/run/secrets/tokens/opensphere-shell-runtime-bootstrap"

var (
	bootstrapTokenPath = projectedBootstrapTokenPath
	controlHTTPClient  = &http.Client{
		Timeout:       5 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
	now               = time.Now
	registrationSleep = sleepContext
)

type controlHTTPError struct {
	status int
	code   string
}

func (failure *controlHTTPError) Error() string {
	if failure.code == "" {
		return fmt.Sprintf("control API rejected request with status %d", failure.status)
	}
	return fmt.Sprintf("control API rejected request with status %d: %s", failure.status, failure.code)
}

type controlResponseError struct{ err error }

func (failure *controlResponseError) Error() string { return failure.err.Error() }
func (failure *controlResponseError) Unwrap() error { return failure.err }

type controlClient struct {
	registrationURL         *url.URL
	controlURL              *url.URL
	runtimeCredential       []byte
	runtimeCredentialExpiry time.Time
}

func newControlClient() (*controlClient, error) {
	registrationURL, err := validatedHTTPSURL(os.Getenv("OPENSPHERE_SHELL_REGISTRATION_URL"))
	if err != nil {
		return nil, fmt.Errorf("registration URL: %w", err)
	}
	if registrationURL.Path != "/internal/runtime/register" {
		return nil, fmt.Errorf("registration URL must end at /internal/runtime/register")
	}
	controlURL, err := validatedHTTPSURL(os.Getenv("OPENSPHERE_SHELL_CONTROL_URL"))
	if err != nil {
		return nil, fmt.Errorf("control URL: %w", err)
	}
	if controlURL.Path != "/api/os-shell/runtime" {
		return nil, fmt.Errorf("control URL must end at /api/os-shell/runtime")
	}
	return &controlClient{registrationURL: registrationURL, controlURL: controlURL}, nil
}

func (client *controlClient) register(ctx context.Context, binding runtimeBinding, identity *signingIdentity) error {
	bootstrap, err := readProjectedBootstrapToken()
	if err != nil {
		return err
	}
	defer wipe(bootstrap)
	randomCredential := make([]byte, 48)
	if _, err := rand.Read(randomCredential); err != nil {
		return fmt.Errorf("generate runtime credential: %w", err)
	}
	runtimeCredential := []byte(base64.RawURLEncoding.EncodeToString(randomCredential))
	wipe(randomCredential)
	registered := false
	defer func() {
		if !registered {
			wipe(runtimeCredential)
		}
	}()
	digest := sha256.Sum256(runtimeCredential)
	runtimeCredentialHash := "sha256:" + hex.EncodeToString(digest[:])
	request := registrationRequest{
		Contract: runtimeContract, Binding: binding, KeyID: identity.keyID,
		PublicKeyPEM: string(identity.publicPEM), TLSCertificateSHA256: identity.tlsCertificateSHA256,
		RuntimeCredentialHash: runtimeCredentialHash,
		RuntimeVersion:        version, AttachEndpoint: "wss://opensphere-shell-runtime:8443/v1/runtime/attach",
	}
	var response registrationResponse
	registrationContext, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for attempt := 0; ; attempt++ {
		response = registrationResponse{}
		err = postJSON(registrationContext, client.registrationURL.String(), bootstrap, request, &response)
		if err == nil {
			break
		}
		if !retryableRegistrationError(err) {
			return fmt.Errorf("runtime registration failed: %w", err)
		}
		if err := registrationSleep(registrationContext, registrationRetryDelay(attempt)); err != nil {
			return fmt.Errorf("runtime registration did not become ready: %w", err)
		}
	}
	if response.Contract != runtimeContract || response.Binding != binding || response.RuntimeCredentialHash != runtimeCredentialHash {
		return errors.New("runtime registration returned a mismatched binding")
	}
	expiresAt, err := time.Parse(time.RFC3339, response.RuntimeCredentialExpiry)
	if err != nil || !expiresAt.After(now().UTC()) || expiresAt.After(now().UTC().Add(61*time.Minute)) {
		return errors.New("runtime registration returned an invalid credential lifetime")
	}
	client.runtimeCredential = runtimeCredential
	client.runtimeCredentialExpiry = expiresAt
	registered = true
	return nil
}

func retryableRegistrationError(err error) bool {
	var httpFailure *controlHTTPError
	if errors.As(err, &httpFailure) {
		return httpFailure.status == http.StatusConflict && httpFailure.code == "RuntimeRegistrationNotReady"
	}
	var responseFailure *controlResponseError
	if errors.As(err, &responseFailure) {
		return true
	}
	var transportFailure *url.Error
	return errors.As(err, &transportFailure)
}

func registrationRetryDelay(attempt int) time.Duration {
	if attempt > 5 {
		attempt = 5
	}
	base := 100 * time.Millisecond * time.Duration(1<<attempt)
	var random [1]byte
	if _, err := rand.Read(random[:]); err != nil {
		return base
	}
	return base + time.Duration(random[0])*base/(2*255)
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (client *controlClient) credential(ctx context.Context, contextJWS string) (credentialResponse, error) {
	var response credentialResponse
	if err := client.ensureCurrent(); err != nil {
		return response, err
	}
	target := *client.controlURL
	target.Path += "/credential"
	err := postJSON(ctx, target.String(), client.runtimeCredential, credentialRequest{
		Contract: controlContract, Operation: "credential", ContextJWS: contextJWS,
	}, &response)
	if err != nil {
		return response, err
	}
	if response.Contract != controlContract || strings.TrimSpace(response.AccessToken) == "" {
		return response, errors.New("control API returned an invalid credential response")
	}
	expiresAt, err := time.Parse(time.RFC3339, response.TokenExpiresAt)
	if err != nil || !expiresAt.After(now().UTC()) || expiresAt.After(now().UTC().Add(5*time.Minute)) {
		return response, errors.New("control API returned an invalid short credential lifetime")
	}
	return response, nil
}

func (client *controlClient) authorizeAttach(ctx context.Context, binding runtimeBinding, attach ptyFrame) error {
	if err := client.ensureCurrent(); err != nil {
		return err
	}
	attachJSON, err := json.Marshal(attach)
	if err != nil {
		return err
	}
	defer wipe(attachJSON)
	target := *client.controlURL
	target.Path += "/attach-authorize"
	var response attachAuthorizeResponse
	if err := postJSON(ctx, target.String(), client.runtimeCredential, attachAuthorizeRequest{
		Contract: controlContract, Binding: binding, Attach: attachJSON,
	}, &response); err != nil {
		return err
	}
	if response.Contract != controlContract || !response.Authorized || response.State != "Active" {
		return errors.New("attach is not authorized for the current runtime binding")
	}
	return nil
}

func (client *controlClient) revalidate(ctx context.Context, binding runtimeBinding) error {
	if err := client.ensureCurrent(); err != nil {
		return err
	}
	target := *client.controlURL
	target.Path += "/revalidate"
	var response attachAuthorizeResponse
	if err := postJSON(ctx, target.String(), client.runtimeCredential, map[string]any{
		"contract": controlContract, "binding": binding,
	}, &response); err != nil {
		return err
	}
	if response.Contract != controlContract || !response.Authorized || response.State != "Active" {
		return errors.New("runtime authorization was revoked")
	}
	return nil
}

func (client *controlClient) ensureCurrent() error {
	if len(client.runtimeCredential) == 0 || !client.runtimeCredentialExpiry.After(now().UTC().Add(5*time.Second)) {
		return errors.New("runtime credential is missing or expired")
	}
	return nil
}

func (client *controlClient) close() {
	wipe(client.runtimeCredential)
	client.runtimeCredential = nil
}

func readProjectedBootstrapToken() ([]byte, error) {
	cleanPath := filepath.Clean(bootstrapTokenPath)
	resolvedPath, err := filepath.EvalSymlinks(cleanPath)
	if err != nil {
		return nil, fmt.Errorf("projected runtime bootstrap token unavailable: %w", err)
	}
	root := filepath.Dir(cleanPath)
	relative, err := filepath.Rel(root, resolvedPath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return nil, errors.New("projected runtime bootstrap token escapes its projected volume")
	}
	info, err := os.Stat(resolvedPath)
	if err != nil {
		return nil, fmt.Errorf("projected runtime bootstrap token unavailable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 || info.Size() < 32 || info.Size() > 16<<10 {
		return nil, errors.New("projected runtime bootstrap token has unsafe metadata")
	}
	raw, err := os.ReadFile(resolvedPath)
	if err != nil {
		return nil, err
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) < 32 || bytes.IndexAny(raw, "\r\n\x00") >= 0 {
		wipe(raw)
		return nil, errors.New("projected runtime bootstrap token is malformed")
	}
	return raw, nil
}

func postJSON(ctx context.Context, target string, bearer []byte, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	defer wipe(body)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	if len(bearer) > 0 {
		request.Header.Set("Authorization", "Bearer "+string(bearer))
	}
	response, err := controlHTTPClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxControlMessage+1))
	if err != nil {
		return &controlResponseError{err: err}
	}
	defer wipe(responseBody)
	if len(responseBody) > maxControlMessage {
		return errors.New("control API response is too large")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(responseBody, &failure)
		return &controlHTTPError{status: response.StatusCode, code: strings.TrimSpace(failure.Error)}
	}
	if contentType := strings.ToLower(response.Header.Get("Content-Type")); contentType != "" && !strings.HasPrefix(contentType, "application/json") {
		return errors.New("control API response content type is not JSON")
	}
	if err := json.Unmarshal(responseBody, output); err != nil {
		return &controlResponseError{err: errors.New("control API response is not valid JSON")}
	}
	return nil
}

func wipe(value []byte) {
	for index := range value {
		value[index] = 0
	}
	// Keep the loop observable to the optimizer without logging material.
	if len(value) > 0 {
		_ = subtle.ConstantTimeByteEq(value[0], 0)
	}
}
