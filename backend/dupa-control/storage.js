// storage.js — Backbone RustFS(S3) 접근. docs/BACKBONE-ARCHITECTURE.md §1.3(a)/§3.2.
// BackboneClaim reconciler의 objectStore 할당(버킷 생성 + 테넌트 Secret 발급 + finalizer GC)에 사용.
// 의존성 0 — node 내장 http/https/crypto만으로 AWS SigV4(서명 v4) 구현(aws-sdk 미도입; controller.js 의존성 0 원칙).
// dev: 인스턴스 키(backbone-rustfs) 재사용 + 버킷으로 격리(provision-backbone-tenant.sh와 동일 모델). 운영은 스코프 키로 격상.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

let cfg = null; // { url:URL, region, accessKey, secretKey }
let enabled = false;

// S3 버킷 명명 규칙(BackboneClaim CRD pattern과 동일) — SSRF/경로 주입 차단.
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function init({ endpoint, region, accessKey, secretKey }) {
  let ep = String(endpoint || '').trim();
  if (!/^https?:\/\//.test(ep)) ep = 'http://' + ep; // 인스턴스 Secret endpoint는 scheme 없을 수 있음
  cfg = { url: new URL(ep), region: region || 'us-east-1', accessKey, secretKey };
  enabled = !!(accessKey && secretKey);
  return enabled;
}
const isEnabled = () => enabled;
const accessKey = () => (cfg ? cfg.accessKey : '');
const secretKey = () => (cfg ? cfg.secretKey : '');
const endpoint = () => (cfg ? cfg.url.origin : '');

// ── SigV4 보조 ──────────────────────────────────────────────
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest();
// RFC3986 인코딩(AWS canonical 규칙) — encodeURIComponent + 추가 문자.
const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split('/').map(enc).join('/'); // '/'는 보존, 세그먼트만 인코딩
function amzDates() {
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // 2026-06-30T12:34:56.789Z → 20260630T123456Z
  return { amzdate: iso, datestamp: iso.slice(0, 8) };
}
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// path-style S3 요청(서명 후 전송). bucket 필수, key/query/body는 선택.
async function s3req(method, bucket, key, query, body) {
  if (!enabled) throw new Error('s3 not connected');
  body = body || Buffer.alloc(0);
  const { amzdate, datestamp } = amzDates();
  const host = cfg.url.host; // host:port
  let canonicalUri = '/' + enc(bucket);
  if (key) canonicalUri += '/' + encPath(key);
  const q = query || {};
  const canonicalQuery = Object.keys(q).sort().map((k) => enc(k) + '=' + enc(q[k])).join('&');
  const payloadHash = sha256hex(body);
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalReq = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${datestamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(Buffer.from(canonicalReq))].join('\n');
  let k = hmac('AWS4' + cfg.secretKey, datestamp);
  k = hmac(k, cfg.region); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign, 'utf8').digest('hex');
  const headers = {
    Host: host, 'x-amz-date': amzdate, 'x-amz-content-sha256': payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (body.length) headers['content-length'] = String(body.length);
  const lib = cfg.url.protocol === 'https:' ? https : http;
  const path = canonicalUri + (canonicalQuery ? '?' + canonicalQuery : '');
  return new Promise((resolve, reject) => {
    const r = lib.request({ method, hostname: cfg.url.hostname, port: cfg.url.port, path, headers, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('s3 timeout')));
    if (body.length) r.write(body);
    r.end();
  });
}

// 버킷 생성(멱등) — us-east-1은 LocationConstraint 본문 불요. 이미 소유(409)는 OK.
async function ensureBucket(bucket) {
  if (!BUCKET_RE.test(bucket || '')) throw new Error('invalid bucket name');
  const r = await s3req('PUT', bucket, '', null, null);
  if (r.status === 200 || r.status === 409) return;
  throw new Error(`ensureBucket HTTP ${r.status}: ${r.body.slice(0, 160)}`);
}

// 버킷 내 키 열거(ListObjectsV2, 페이지네이션) — GC용. XML에서 <Key> 추출.
async function listKeys(bucket) {
  const keys = [];
  let token = null;
  for (let i = 0; i < 1000; i++) { // 안전 상한(무한 루프 방지)
    const q = { 'list-type': '2', 'max-keys': '1000' };
    if (token) q['continuation-token'] = token;
    const r = await s3req('GET', bucket, '', q, null);
    if (r.status !== 200) break;
    for (const m of r.body.match(/<Key>([^<]*)<\/Key>/g) || []) keys.push(unxml(m.replace(/<\/?Key>/g, '')));
    const nt = r.body.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    if (/<IsTruncated>true<\/IsTruncated>/.test(r.body) && nt) token = unxml(nt[1]);
    else break;
  }
  return keys;
}

// 버킷 비우고 삭제(finalizer GC) — PG dropTenant 대칭. 실패는 로그만(graceful).
async function emptyAndDeleteBucket(bucket) {
  if (!BUCKET_RE.test(bucket || '')) return;
  try {
    for (const key of await listKeys(bucket)) {
      try { await s3req('DELETE', bucket, key, null, null); } catch (e) { console.error('[s3] del obj', bucket, String(e).slice(0, 80)); }
    }
    const r = await s3req('DELETE', bucket, '', null, null);
    if (![200, 204, 404].includes(r.status)) console.error(`[s3] deleteBucket ${bucket} HTTP ${r.status}: ${r.body.slice(0, 120)}`);
  } catch (e) {
    console.error('[s3] emptyAndDeleteBucket', bucket, String(e).slice(0, 120));
  }
}

module.exports = { init, isEnabled, accessKey, secretKey, endpoint, ensureBucket, listKeys, emptyAndDeleteBucket };
