// backbone-rustfs-exporter — RustFS(1.0.0-beta.8)는 네이티브 Prometheus 엔드포인트가 없어
// S3 API(SigV4)로 버킷/오브젝트를 폴링해 사용량 메트릭(총량·버킷별·오브젝트수)을 노출한다. 의존성 0(node 내장).
// SigV4 서명은 dupa storage.js와 동일 알고리즘(AWS 공식 테스트벡터 검증).
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 9209;
const ENDPOINT = process.env.S3_ENDPOINT || 'http://backbone-rustfs.opensphere-backbone.svc.cluster.local:9000';
const REGION = process.env.S3_REGION || 'us-east-1';
const ACCESS = process.env.S3_ACCESS_KEY || '';
const SECRET = process.env.S3_SECRET_KEY || '';
const epUrl = new URL(/^https?:\/\//.test(ENDPOINT) ? ENDPOINT : 'http://' + ENDPOINT);

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s, 'utf8').digest();
const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function amz() { const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); return { amzdate: iso, datestamp: iso.slice(0, 8) }; }

function s3req(method, bucket, query) {
  return new Promise((resolve, reject) => {
    const { amzdate, datestamp } = amz();
    const host = epUrl.host;
    const canonicalUri = bucket ? '/' + enc(bucket) : '/';
    const q = query || {};
    const canonicalQuery = Object.keys(q).sort().map((k) => enc(k) + '=' + enc(q[k])).join('&');
    const payloadHash = sha256hex(Buffer.alloc(0));
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalReq = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${datestamp}/${REGION}/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(Buffer.from(canonicalReq))].join('\n');
    let k = hmac('AWS4' + SECRET, datestamp); k = hmac(k, REGION); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
    const sig = crypto.createHmac('sha256', k).update(sts, 'utf8').digest('hex');
    const headers = { Host: host, 'x-amz-date': amzdate, 'x-amz-content-sha256': payloadHash, Authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}` };
    const lib = epUrl.protocol === 'https:' ? https : http;
    const path = canonicalUri + (canonicalQuery ? '?' + canonicalQuery : '');
    const r = lib.request({ method, hostname: epUrl.hostname, port: epUrl.port, path, headers, timeout: 8000 }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); r.end();
  });
}

async function listBuckets() {
  const r = await s3req('GET', '', null);
  if (r.status !== 200) throw new Error('listBuckets HTTP ' + r.status);
  return (r.body.match(/<Name>([^<]*)<\/Name>/g) || []).map((m) => unxml(m.replace(/<\/?Name>/g, '')));
}
async function bucketStats(bucket) {
  let token = null, objects = 0, bytes = 0;
  for (let i = 0; i < 10000; i++) {
    const q = { 'list-type': '2', 'max-keys': '1000' }; if (token) q['continuation-token'] = token;
    const r = await s3req('GET', bucket, q);
    if (r.status !== 200) break;
    const sizes = r.body.match(/<Size>(\d+)<\/Size>/g) || [];
    objects += sizes.length;
    for (const s of sizes) bytes += Number(s.replace(/<\/?Size>/g, '')) || 0;
    const nt = r.body.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    if (/<IsTruncated>true<\/IsTruncated>/.test(r.body) && nt) token = unxml(nt[1]); else break;
  }
  return { objects, bytes };
}

const lbl = (b) => String(b).replace(/[\\"\n]/g, ''); // 라벨 안전(버킷명은 [a-z0-9.-]라 실질 무해)
async function collect() {
  const out = [];
  const t0 = Date.now();
  let up = 1, buckets = [];
  try { buckets = await listBuckets(); } catch { up = 0; }
  out.push('# HELP rustfs_up RustFS S3 reachable.', '# TYPE rustfs_up gauge', `rustfs_up ${up}`);
  if (up) {
    out.push('# HELP rustfs_buckets Number of buckets.', '# TYPE rustfs_buckets gauge', `rustfs_buckets ${buckets.length}`);
    out.push('# HELP rustfs_bucket_objects Objects per bucket.', '# TYPE rustfs_bucket_objects gauge');
    const byBytes = [];
    out.push('# HELP rustfs_bucket_bytes Bytes per bucket.', '# TYPE rustfs_bucket_bytes gauge');
    let totO = 0, totB = 0;
    for (const b of buckets) {
      let st = { objects: 0, bytes: 0 }; try { st = await bucketStats(b); } catch { /* skip */ }
      totO += st.objects; totB += st.bytes;
      out.push(`rustfs_bucket_objects{bucket="${lbl(b)}"} ${st.objects}`);
      byBytes.push(`rustfs_bucket_bytes{bucket="${lbl(b)}"} ${st.bytes}`);
    }
    out.push(...byBytes);
    out.push('# HELP rustfs_objects_total Total objects across all buckets.', '# TYPE rustfs_objects_total gauge', `rustfs_objects_total ${totO}`);
    out.push('# HELP rustfs_bytes_total Total bytes across all buckets.', '# TYPE rustfs_bytes_total gauge', `rustfs_bytes_total ${totB}`);
  }
  out.push('# HELP rustfs_scrape_duration_seconds Scrape duration.', '# TYPE rustfs_scrape_duration_seconds gauge', `rustfs_scrape_duration_seconds ${((Date.now() - t0) / 1000).toFixed(3)}`);
  return out.join('\n') + '\n';
}

http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    try { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); res.end(await collect()); }
    catch (e) { res.writeHead(500); res.end('# error ' + String((e && e.message) || e).slice(0, 100)); }
  } else if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); }
  else { res.writeHead(404); res.end(); }
}).listen(PORT, () => console.log(`backbone-rustfs-exporter :${PORT} → ${ENDPOINT}`));
