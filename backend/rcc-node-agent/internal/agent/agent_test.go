package agent

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"opensphere.io/rcc/node-agent/internal/config"
	"opensphere.io/rcc/node-agent/internal/protocol"
	"opensphere.io/rcc/node-agent/internal/snapshot"
)

type capturedDoer struct {
	req    *http.Request
	body   string
	status int
	err    error
}

func (d *capturedDoer) Do(req *http.Request) (*http.Response, error) {
	d.req = req
	if req.Body != nil {
		raw, _ := io.ReadAll(req.Body)
		d.body = string(raw)
	}
	if d.err != nil {
		return nil, d.err
	}
	status := d.status
	if status == 0 {
		status = http.StatusAccepted
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
		Header:     http.Header{},
	}, nil
}

func testConfig() *config.Config {
	endpoint, _ := url.Parse("https://rcc.cc2.opl.io.kr")
	return &config.Config{
		ControlCenterURL: endpoint,
		ControlCenterID:  "cc2",
		HostID:           "node-a",
		KeyID:            "cc2-node-a-2026a",
		Secret:           []byte("f1e2d3c4b5a697887766554433221100"),
		Interval:         time.Minute,
		RequestTimeout:   15 * time.Second,
	}
}

func testSnapshot() snapshot.Snapshot {
	snap := snapshot.Snapshot{
		ControlCenterID: "cc2",
		HostID:          "node-a",
		AgentVersion:    "0.1.0",
		CollectedAt:     "2026-03-26T04:05:06Z",
	}
	snap.Normalize()
	return snap
}

func fixedReporter(cfg *config.Config, doer Doer) *Reporter {
	r := NewReporter(cfg, doer)
	r.now = func() time.Time { return time.Unix(1774483200, 0).UTC() }
	r.nonce = func() (string, error) { return "0123456789abcdef0123456789abcdef", nil }
	return r
}

func TestSendSignsRequestAndBindsHost(t *testing.T) {
	cfg := testConfig()
	doer := &capturedDoer{}
	if _, err := fixedReporter(cfg, doer).Send(context.Background(), testSnapshot()); err != nil {
		t.Fatalf("send failed: %v", err)
	}

	req := doer.req
	if req.Method != http.MethodPost {
		t.Fatalf("method = %s", req.Method)
	}
	if req.URL.String() != "https://rcc.cc2.opl.io.kr/api/control-centers/cc2/hosts/node-a/heartbeat" {
		t.Fatalf("url = %s", req.URL.String())
	}
	if req.URL.RawQuery != "" {
		t.Fatalf("agent must never place data in a query string: %q", req.URL.RawQuery)
	}
	if req.Header.Get(protocol.HeaderControlCenter) != "cc2" || req.Header.Get(protocol.HeaderHost) != "node-a" {
		t.Fatalf("binding headers missing: %v", req.Header)
	}
	if req.Header.Get(protocol.HeaderKeyID) != "cc2-node-a-2026a" {
		t.Fatalf("key id header missing")
	}

	expected := protocol.Request{
		Method:          http.MethodPost,
		Path:            "/api/control-centers/cc2/hosts/node-a/heartbeat",
		KeyID:           cfg.KeyID,
		Timestamp:       req.Header.Get(protocol.HeaderTimestamp),
		Nonce:           req.Header.Get(protocol.HeaderNonce),
		ControlCenterID: "cc2",
		HostID:          "node-a",
		BodySHA256:      protocol.BodyDigest([]byte(doer.body)),
	}
	if !protocol.Verify(cfg.Secret, expected, req.Header.Get(protocol.HeaderSignature)) {
		t.Fatal("emitted signature does not verify against the sent body")
	}
}

func TestSendNeverEmitsBearerTokenOrSecret(t *testing.T) {
	cfg := testConfig()
	doer := &capturedDoer{}
	if _, err := fixedReporter(cfg, doer).Send(context.Background(), testSnapshot()); err != nil {
		t.Fatalf("send failed: %v", err)
	}
	if doer.req.Header.Get("authorization") != "" || doer.req.Header.Get("cookie") != "" {
		t.Fatal("agent must not present browser credentials")
	}
	secret := string(cfg.Secret)
	for name, values := range doer.req.Header {
		for _, v := range values {
			if strings.Contains(v, secret) {
				t.Fatalf("header %s leaked the signing key", name)
			}
		}
	}
	if strings.Contains(doer.req.URL.String(), secret) || strings.Contains(doer.body, secret) {
		t.Fatal("signing key must never appear in the URL or body")
	}
}

func TestSendRejectsOversizedPayload(t *testing.T) {
	snap := testSnapshot()
	for i := 0; i < snapshot.MaxFilesystems; i++ {
		snap.Filesystems = append(snap.Filesystems, snapshot.Filesystem{
			Device:     strings.Repeat("d", 128),
			MountPoint: strings.Repeat("m", 128),
			FSType:     strings.Repeat("f", 32),
		})
	}
	// Force past the protocol bound without relying on collector limits.
	for i := 0; i < 400; i++ {
		snap.Degraded = append(snap.Degraded, strings.Repeat("k", 200))
	}
	if _, err := fixedReporter(testConfig(), &capturedDoer{}).Send(context.Background(), snap); !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("expected payload bound to trip, got %v", err)
	}
}

func TestSendClassifiesRetryability(t *testing.T) {
	cases := map[int]bool{
		200: false, 202: false,
		401: false, 403: false, 404: false, 409: false, 413: false, 422: false,
		408: true, 429: true, 500: true, 502: true, 503: true,
	}
	for status, retryable := range cases {
		res, err := fixedReporter(testConfig(), &capturedDoer{status: status}).Send(context.Background(), testSnapshot())
		if status < 300 && err != nil {
			t.Fatalf("status %d should succeed: %v", status, err)
		}
		if status >= 300 && err == nil {
			t.Fatalf("status %d should error", status)
		}
		if res.Retryable != retryable {
			t.Fatalf("status %d retryable = %t, want %t", status, res.Retryable, retryable)
		}
	}
}

func TestSendMarksTransportErrorRetryable(t *testing.T) {
	res, err := fixedReporter(testConfig(), &capturedDoer{err: errors.New("dial tcp: timeout")}).Send(context.Background(), testSnapshot())
	if err == nil {
		t.Fatal("transport failure must surface")
	}
	if !res.Retryable {
		t.Fatal("transport failure must be retryable")
	}
}

func TestNewHTTPClientRefusesRedirects(t *testing.T) {
	client, err := NewHTTPClient(testConfig())
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	if client.CheckRedirect == nil {
		t.Fatal("redirect policy must be set")
	}
	if got := client.CheckRedirect(nil, nil); !errors.Is(got, ErrRedirectNotPermitted) {
		t.Fatalf("redirect policy = %v", got)
	}
	if client.Timeout != testConfig().RequestTimeout {
		t.Fatalf("timeout not applied: %v", client.Timeout)
	}
}

func TestBackoffGrowsAndSaturates(t *testing.T) {
	if BackoffFor(0) != 0 {
		t.Fatal("no failures means no backoff")
	}
	if BackoffFor(1) != 2*time.Second || BackoffFor(2) != 4*time.Second || BackoffFor(3) != 8*time.Second {
		t.Fatalf("backoff progression wrong: %v %v %v", BackoffFor(1), BackoffFor(2), BackoffFor(3))
	}
	if BackoffFor(50) != backoffMax || BackoffFor(9999) != backoffMax {
		t.Fatalf("backoff must saturate at %v", backoffMax)
	}
}

func TestJitterStaysWithinBand(t *testing.T) {
	for i := 0; i < 200; i++ {
		got := Jitter(10 * time.Second)
		if got < 8*time.Second || got > 12*time.Second {
			t.Fatalf("jitter out of band: %v", got)
		}
	}
	if Jitter(0) != 0 {
		t.Fatal("zero wait must stay zero")
	}
}

type stubCollector struct{ calls int }

func (s *stubCollector) Collect(context.Context) snapshot.Snapshot {
	s.calls++
	return testSnapshot()
}

type stubSender struct {
	calls int
	fail  bool
}

func (s *stubSender) Send(context.Context, snapshot.Snapshot) (Result, error) {
	s.calls++
	if s.fail {
		return Result{StatusCode: 503, Retryable: true}, errors.New("unavailable")
	}
	return Result{StatusCode: 202}, nil
}

func TestLoopStopsGracefullyOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	collector := &stubCollector{}
	sender := &stubSender{}
	waits := []time.Duration{}

	loop := &Loop{
		Collector: collector,
		Sender:    sender,
		Interval:  time.Minute,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		Jitter:    func(d time.Duration) time.Duration { return d },
		After: func(d time.Duration) <-chan time.Time {
			waits = append(waits, d)
			if len(waits) >= 3 {
				cancel()
				// Never fire, so the loop must exit through ctx.Done().
				return make(chan time.Time)
			}
			ch := make(chan time.Time, 1)
			ch <- time.Time{}
			return ch
		},
	}
	if err := loop.Run(ctx); err != nil {
		t.Fatalf("loop returned error: %v", err)
	}
	if collector.calls != 3 || sender.calls != 3 {
		t.Fatalf("expected 3 cycles, got collect=%d send=%d", collector.calls, sender.calls)
	}
	for _, w := range waits {
		if w != time.Minute {
			t.Fatalf("healthy loop must wait the configured interval, got %v", w)
		}
	}
}

func TestLoopBacksOffOnRepeatedFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	waits := []time.Duration{}
	loop := &Loop{
		Collector: &stubCollector{},
		Sender:    &stubSender{fail: true},
		Interval:  time.Second,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		Jitter:    func(d time.Duration) time.Duration { return d },
		After: func(d time.Duration) <-chan time.Time {
			waits = append(waits, d)
			if len(waits) >= 3 {
				cancel()
				return make(chan time.Time)
			}
			ch := make(chan time.Time, 1)
			ch <- time.Time{}
			return ch
		},
	}
	if err := loop.Run(ctx); err != nil {
		t.Fatalf("loop returned error: %v", err)
	}
	if waits[0] != 2*time.Second || waits[1] != 4*time.Second || waits[2] != 8*time.Second {
		t.Fatalf("backoff not applied: %v", waits)
	}
}

func TestHeartbeatPathMatchesProtocolContract(t *testing.T) {
	path := HeartbeatPath("cc2", "node-a")
	if path != "/api/control-centers/cc2/hosts/node-a/heartbeat" {
		t.Fatalf("heartbeat path drifted: %q", path)
	}
	if _, err := protocol.CanonicalString(protocol.Request{
		Method: "POST", Path: path, KeyID: "k1", Timestamp: "1", Nonce: strings.Repeat("a", 16),
		ControlCenterID: "cc2", HostID: "node-a", BodySHA256: protocol.BodyDigest(nil),
	}); err != nil {
		t.Fatalf("heartbeat path is not signable: %v", err)
	}
}
