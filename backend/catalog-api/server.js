// opensphere-catalog-api — mainShell의 네이티브 카탈로그/API 엔진 (B/E).
//
// catalog/apis는 mainShell CORE 고유기능이므로 그 B/E도 네이티브여야 한다(외부 RHDH 의존 폐기).
// OpenSphere의 자기 API = K8s CRD(*.opensphere.io)를 kind=API로, 배포 워크로드를 kind=Component로
// Backstage 카탈로그 엔티티 형태로 투영한다. zero-dep(node 내장 http/https만), SA 토큰으로 K8s read.
// 셸 nginx가 /api/rhdh/ → 이 백엔드 /api/ 로 프록시(F/E 무변경) → CORE Catalog/APIs 페이지에 실데이터.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const CA = fs.readFileSync(`${SA}/ca.crt`);
const KHOST = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
const KPORT = process.env.KUBERNETES_SERVICE_PORT || 443;
const COMP_NS = (process.env.COMPONENT_NAMESPACES || 'opensphere-console,opensphere-console-data,opensphere-console-change').split(',');

function k8s(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: KHOST, port: KPORT, path, method: 'GET', ca: CA,
        headers: { Authorization: `Bearer ${fs.readFileSync(`${SA}/token`, 'utf8').trim()}`, Accept: 'application/json' } },
      (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => {
        try { const j = JSON.parse(Buffer.concat(c).toString('utf8')); j.code && j.code >= 400 ? reject(new Error(`${path} ${j.code}`)) : resolve(j); }
        catch (e) { reject(e); } }); });
    req.on('error', reject); req.end();
  });
}

// OpenSphere CRD → kind=API 엔티티 (자기 API 인벤토리)
async function apiEntities() {
  const out = [];
  const crds = await k8s('/apis/apiextensions.k8s.io/v1/customresourcedefinitions');
  for (const crd of crds.items || []) {
    const g = crd.spec.group || '';
    if (!/(^|\.)opensphere\.io$/.test(g)) continue; // OpenSphere 소유 API만
    const v = (crd.spec.versions || []).find((x) => x.served) || crd.spec.versions?.[0] || {};
    const kind = crd.spec.names.kind;
    out.push({
      kind: 'API',
      metadata: { name: kind, namespace: 'default', uid: crd.metadata.uid,
        description: `${kind} — ${g}/${v.name} (OpenSphere CRD, scope=${crd.spec.scope})` },
      spec: { type: 'kubernetes-crd', owner: g.split('.')[0], lifecycle: 'production', system: g,
        definition: v.schema?.openAPIV3Schema ? JSON.stringify(v.schema.openAPIV3Schema, null, 2) : '' },
    });
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

// 배포 워크로드 → kind=Component 엔티티
async function componentEntities() {
  const out = [];
  for (const ns of COMP_NS) {
    let deps;
    try { deps = await k8s(`/apis/apps/v1/namespaces/${ns}/deployments`); } catch { continue; }
    for (const d of deps.items || []) {
      out.push({
        kind: 'Component',
        metadata: { name: d.metadata.name, namespace: ns, uid: d.metadata.uid,
          description: `Deployment · ${ns} (replicas ${d.status?.availableReplicas ?? 0}/${d.spec?.replicas ?? 0})` },
        spec: { type: 'service', owner: 'platform', lifecycle: 'production', system: ns },
      });
    }
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

async function entities(filter) {
  if (/kind=api/i.test(filter || '')) return apiEntities();
  const [a, c] = await Promise.all([apiEntities(), componentEntities()]);
  return [...a, ...c];
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  try {
    if (u.pathname === '/healthz') return res.end('{"ok":true}');
    if (u.pathname === '/api/catalog/entities') {
      const list = await entities(u.searchParams.get('filter'));
      const limit = Number(u.searchParams.get('limit') || 0);
      return res.end(JSON.stringify(limit ? list.slice(0, limit) : list));
    }
    // runtime resources(rhdh kubernetes 백엔드 대응) — 미구현, 빈 결과로 graceful
    if (u.pathname.startsWith('/api/kubernetes/services/')) return res.end('{"items":[]}');
    res.statusCode = 404; res.end('{"error":"not found"}');
  } catch (e) {
    res.statusCode = 502; res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
});
server.listen(8080, () => console.log('opensphere-catalog-api listening :8080 (native mainShell B/E)'));
