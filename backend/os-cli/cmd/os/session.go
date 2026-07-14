package main

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func whoamiVisibility(c Config, o io.Writer) error {
	t, e := credentialToken(c)
	if e != nil {
		return e
	}
	x := signedTokenExpiry(t)
	f := url.Values{"token": {t}}.Encode()
	b, s, _, e := rawRequestCA(http.MethodPost, join(c.BFFURL, "/bff/token/introspect"), strings.NewReader(f), "application/x-www-form-urlencoded", t, "", c.CABundle)
	if e != nil {
		return e
	}
	if e = requireOK(b, s); e != nil {
		return e
	}
	var id struct {
		Active   bool     `json:"active"`
		Username string   `json:"username"`
		Groups   []string `json:"groups"`
	}
	if json.Unmarshal(b, &id) != nil || !id.Active {
		return errors.New("CLI 디바이스 또는 API token이 비활성·폐기 상태입니다")
	}
	if o == io.Discard {
		return nil
	}
	fp, k := deviceFingerprint(c)
	v := map[string]any{"username": id.Username, "groups": id.Groups, "profile": map[string]any{"name": activeProfileName(c), "kind": c.Kind}, "device": map[string]any{"label": c.DeviceLabel, "deviceId": c.DeviceID, "fingerprint": nullable(fp)}, "session": map[string]any{"expiresAt": expiry(x)}, "trusted": c.DeviceID != "" && k}
	h := fmt.Sprintf("사용자: %s\n그룹: %s\n프로필: %s (%s)\n디바이스: %s (%s)\n공개 키 지문: %s\n신뢰: %t\n세션 만료: %s\n", id.Username, strings.Join(id.Groups, ", "), activeProfileName(c), c.Kind, c.DeviceLabel, c.DeviceID, display(fp), c.DeviceID != "" && k, displayTime(x))
	return writeVisibility(o, v, h)
}
func sessionCommand(c Config, a []string, o io.Writer) error {
	if len(a) != 1 || (a[0] != "status" && a[0] != "refresh") {
		return cliError(exitUsage, "사용법: os session status | refresh", nil)
	}
	fp, k := deviceFingerprint(c)
	if a[0] == "status" && (c.DeviceID == "" || !k) {
		v := map[string]any{"profile": map[string]any{"name": activeProfileName(c), "kind": c.Kind}, "state": "no_device", "trustedDeviceKey": false, "freshSession": false, "expiresAt": nil, "message": "os login을 실행하세요"}
		return writeVisibility(o, v, fmt.Sprintf("프로필: %s (%s)\n상태: no_device\n신뢰된 디바이스 키: 없음\n조치: os login을 실행하세요\n", activeProfileName(c), c.Kind))
	}
	if !k {
		return cliError(exitAuth, "OS 보안 저장소에 신뢰된 디바이스 키가 없습니다; os login을 실행하세요", nil)
	}
	t, e := credentialToken(c)
	if e != nil {
		var q *exitError
		if errors.As(e, &q) && q.code == exitAuth {
			return cliError(exitAuth, "서버에서 CLI 디바이스 신뢰가 폐기되었습니다; os login으로 다시 등록하세요", e)
		}
		return e
	}
	x := signedTokenExpiry(t)
	v := map[string]any{"profile": map[string]any{"name": activeProfileName(c), "kind": c.Kind}, "state": "ok", "trustedDeviceKey": k, "freshSession": true, "expiresAt": expiry(x)}
	return writeVisibility(o, v, fmt.Sprintf("프로필: %s (%s)\n상태: ok\n신뢰된 디바이스 키: %t\n공개 키 지문: %s\n만료: %s\n", activeProfileName(c), c.Kind, k, display(fp), displayTime(x)))
}
func signedTokenExpiry(t string) time.Time {
	p := strings.Split(t, ".")
	if len(p) < 2 {
		return time.Time{}
	}
	b, e := base64.RawURLEncoding.DecodeString(p[1])
	if e != nil {
		return time.Time{}
	}
	var c struct {
		Exp json.Number `json:"exp"`
	}
	if json.Unmarshal(b, &c) != nil {
		return time.Time{}
	}
	n, e := c.Exp.Int64()
	if e != nil {
		return time.Time{}
	}
	return time.Unix(n, 0).UTC()
}
func deviceFingerprint(c Config) (string, bool) {
	if c.DeviceID == "" {
		return "", false
	}
	d, e := deviceKeyLoad(deviceCredentialID(c))
	if e != nil {
		return "", false
	}
	k, e := x509.ParseECPrivateKey(d)
	if e != nil {
		return "", false
	}
	p, e := x509.MarshalPKIXPublicKey(&k.PublicKey)
	if e != nil {
		return "", false
	}
	z := sha256.Sum256(p)
	r := hex.EncodeToString(z[:])
	q := []string{}
	for i := 0; i < len(r); i += 2 {
		q = append(q, r[i:i+2])
	}
	return strings.Join(q, ":"), true
}
func activeProfileName(c Config) string {
	if c.profileName != "" {
		return c.profileName
	}
	return "default"
}
func expiry(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.Format(time.RFC3339)
}
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func display(s string) string {
	if s == "" {
		return "없음"
	}
	return s
}
func displayTime(t time.Time) string {
	if t.IsZero() {
		return "알 수 없음"
	}
	return t.Format(time.RFC3339)
}
func writeVisibility(o io.Writer, v map[string]any, h string) error {
	if f, ok := o.(*formattedOutput); ok && !f.options.Explicit && f.options.Query == "" && f.options.Limit < 0 && !f.options.All {
		_, e := fmt.Fprint(f.Writer, h)
		return e
	}
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return pretty(o, b)
}
