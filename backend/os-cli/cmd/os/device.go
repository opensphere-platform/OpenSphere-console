package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type devicePublicJWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

func generateDeviceKey() ([]byte, devicePublicJWK, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, devicePublicJWK{}, err
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, devicePublicJWK{}, err
	}
	pad := func(value []byte) []byte {
		out := make([]byte, 32)
		copy(out[32-len(value):], value)
		return out
	}
	return der, devicePublicJWK{
		Kty: "EC", Crv: "P-256",
		X: base64.RawURLEncoding.EncodeToString(pad(key.X.Bytes())),
		Y: base64.RawURLEncoding.EncodeToString(pad(key.Y.Bytes())),
	}, nil
}

func signDeviceChallenge(privateDER []byte, deviceID, challengeID, nonce string) (string, error) {
	key, err := x509.ParseECPrivateKey(privateDER)
	if err != nil {
		return "", fmt.Errorf("디바이스 개인키 파싱 실패: %w", err)
	}
	message := fmt.Sprintf("opensphere-cli-session-v1\n%s\n%s\n%s", deviceID, challengeID, nonce)
	digest := sha256.Sum256([]byte(message))
	signature, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(signature), nil
}

func credentialToken(cfg Config) (string, error) {
	if cfg.Kind == "workforce" {
		return "", cliError(exitAuth, "workforce 프로파일 인증은 아직 지원되지 않습니다", nil)
	}
	if strings.TrimSpace(cfg.PAT) != "" {
		return strings.TrimSpace(cfg.PAT), nil
	}
	if cfg.DeviceID == "" {
		return "", errors.New("등록된 CLI 디바이스가 없습니다; os login을 실행하세요")
	}
	privateDER, err := deviceKeyLoad(deviceCredentialID(cfg))
	if err != nil {
		return "", fmt.Errorf("OS 보안 저장소에서 디바이스 키를 읽지 못했습니다: %w", err)
	}
	challengeBody, _ := json.Marshal(map[string]string{"deviceId": cfg.DeviceID})
	b, status, _, err := rawRequestCA(http.MethodPost, join(cfg.BFFURL, "/bff/cli/challenge"), bytes.NewReader(challengeBody), "application/json", "", "", cfg.CABundle)
	if err != nil {
		return "", err
	}
	if err := requireOK(b, status); err != nil {
		return "", err
	}
	var challenge struct {
		ChallengeID string `json:"challengeId"`
		Nonce       string `json:"nonce"`
	}
	if err := json.Unmarshal(b, &challenge); err != nil || challenge.ChallengeID == "" || challenge.Nonce == "" {
		return "", errors.New("CLI challenge 응답이 올바르지 않습니다")
	}
	signature, err := signDeviceChallenge(privateDER, cfg.DeviceID, challenge.ChallengeID, challenge.Nonce)
	if err != nil {
		return "", err
	}
	sessionBody, _ := json.Marshal(map[string]string{
		"deviceId": cfg.DeviceID, "challengeId": challenge.ChallengeID, "signature": signature,
	})
	b, status, _, err = rawRequestCA(http.MethodPost, join(cfg.BFFURL, "/bff/cli/session"), bytes.NewReader(sessionBody), "application/json", "", "", cfg.CABundle)
	if err != nil {
		return "", err
	}
	if err := requireOK(b, status); err != nil {
		return "", err
	}
	var session struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.Unmarshal(b, &session); err != nil || session.AccessToken == "" {
		return "", errors.New("CLI 단기 세션 응답이 올바르지 않습니다")
	}
	return session.AccessToken, nil
}

func deviceCredentialID(cfg Config) string {
	if cfg.profileName == "" || cfg.profileName == "default" {
		return cfg.DeviceID
	}
	return cfg.profileName + "--" + cfg.DeviceID
}
