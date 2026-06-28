// dupa-registry-controller (DUPA Admin Control PoC, 계획서 §9 + 검토 §B.1/§B.5)
// 한 Node.js 서비스가 3역할:
//   ① reconcile : UIPluginRegistration desiredState → workload apply/delete + 검증 + registry 생성
//   ② Control API: /api/admin/plugins/* (Admin UI가 호출, kubectl 없이 상태 전이)
//   ③ registry  : /registry/plugins.json (셸 Extension Host가 읽는 산출물, 즉시 반영)
// 신뢰 루트는 UIPluginPackage(관리자 승인값). controller는 digest를 '계산해 비교'만 하고
// registry에는 승인값을 '전사'한다(§B.5). 이중 검증: 여기(설치 시점) + 셸(로드 시점).
// 의존성 0 (node 내장 http/crypto/fs).
const http = require('http');
const { createHash, createPublicKey, verify } = require('crypto');

const PORT = process.env.PORT || 8080;
const NS = process.env.NAMESPACE || 'opensphere-system';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const API = 'https://kubernetes.default.svc';
const GROUP = 'plugins.opensphere.io';
const V = 'v1alpha1';
// 셸(브라우저)이 플러그인 manifest/번들에 접근하는 경로 prefix (nginx 프록시 기준)
const SHELL_API_PREFIX = '/api/plugins';

const token = () => require('fs').readFileSync(`${SA}/token`, 'utf8').trim();
// NODE_EXTRA_CA_CERTS는 deployment env로 주입 (Node fetch는 시작 시점에 읽음)

const audit = []; // { time, actor, action, target, result, reason }
function logAudit(actor, action, target, result, reason) {
  const e = { time: new Date().toISOString(), actor: actor || 'system', action, target, result, reason: reason || '' };
  audit.unshift(e);
  if (audit.length > 200) audit.pop();
  console.log(`[audit] ${e.actor} ${action} ${target} -> ${result}${reason ? ' (' + reason + ')' : ''}`);
}

// ── K8s REST 헬퍼 ─────────────────────────────────────────────
async function k8s(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : null };
}
const crd = (plural) => `/apis/${GROUP}/${V}/namespaces/${NS}/${plural}`;
const listPackages = () => k8s('GET', crd('uipluginpackages'));
const listRegs = () => k8s('GET', crd('uipluginregistrations'));
// ADR-UI-003 §3.1: scope=main-shell-* 라벨 = shell-pinned core 표면(패키징은 plugin이나 분류는 core) → 제거/비활성 불가.
const isCorePkg = (pkg) => (pkg?.metadata?.labels?.['opensphere.io/scope'] || '').startsWith('main-shell');
const getPackage = (n) => k8s('GET', `${crd('uipluginpackages')}/${n}`);
const getReg = (n) => k8s('GET', `${crd('uipluginregistrations')}/${n}`);
// CLIDownload (console.opensphere.io, cluster-scoped) — headless 비-UI 콘솔 바인딩. UIPluginPackage(UI 게스트)와 별개 kind.
// 컨트롤러는 plugins를 reconcile(워크로드+서명)하지만, binding은 '선언'이라 reconcile 없이 admin에 '인식'시키기 위해 list만.
const CONSOLE_GROUP = 'console.opensphere.io';
const listCliDownloads = () => k8s('GET', `/apis/${CONSOLE_GROUP}/${V}/clidownloads`);
async function setStatus(name, status) {
  return k8s('PATCH', `${crd('uipluginregistrations')}/${name}/status`,
    { status: { ...status, lastTransitionTime: new Date().toISOString() } });
}

// ── 워크로드(기능 컨테이너) apply/delete ──────────────────────
// 워크로드를 UIPluginPackage 소유로 표시 → 패키지 삭제 시 K8s GC가 Deployment/Service를 자동 회수(cascade).
// 이전엔 ownerReference 부재로 workload가 고아가 돼 spine-up이 명시 삭제로 우회했음(감사 후속③ 구조개선).
// owner·dependent 동일 namespace(opensphere-system)라 native GC 적용 — finalizer 불요. controller:true=유일 제어소유자.
function ownerRef(pkg) {
  return {
    apiVersion: `${GROUP}/${V}`, kind: 'UIPluginPackage',
    name: pkg.metadata.name, uid: pkg.metadata.uid,
    controller: true, blockOwnerDeletion: true,
  };
}
function deploymentManifest(pkg) {
  const name = pkg.metadata.name;
  const _d = pkg.spec.image.digest || '';
  const img = _d.startsWith('sha256:') ? `${pkg.spec.image.repository}@${_d}` : `${pkg.spec.image.repository}:${_d || 'latest'}`;
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace: NS, labels: { app: name, 'opensphere.io/dupa-plugin': name }, ownerReferences: [ownerRef(pkg)] },
    spec: {
      replicas: 1, selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          imagePullSecrets: [{ name: 'ghcr-pull' }],
          containers: [{
            name: 'plugin', image: img, ports: [{ containerPort: 8080 }],
            // K8s API를 호출하는 기능 컨테이너(예: platform-status)의 TLS 검증용 — 기본 제공
            env: [{ name: 'NODE_EXTRA_CA_CERTS', value: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt' }],
            readinessProbe: { httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 1 },
            resources: { requests: { cpu: '20m', memory: '32Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
          }],
        },
      },
    },
  };
}
function serviceManifest(pkg) {
  const name = pkg.metadata.name;
  return {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name, namespace: NS, labels: { 'opensphere.io/dupa-plugin': name }, ownerReferences: [ownerRef(pkg)] },
    spec: { selector: { app: name }, ports: [{ port: 8080, targetPort: 8080 }] },
  };
}
async function applyWorkload(pkg) {
  const name = pkg.metadata.name;
  for (const [plural, man] of [['deployments', deploymentManifest(pkg)], ['services', serviceManifest(pkg)]]) {
    const base = `/apis/apps/v1/namespaces/${NS}/deployments`;
    const path = plural === 'deployments' ? base : `/api/v1/namespaces/${NS}/services`;
    const exists = await k8s('GET', `${path}/${name}`);
    if (exists.ok) await k8s('PATCH', `${path}/${name}`, man);
    else await k8s('POST', path, man);
  }
}
async function deleteWorkload(name) {
  await k8s('DELETE', `/apis/apps/v1/namespaces/${NS}/deployments/${name}`);
  await k8s('DELETE', `/api/v1/namespaces/${NS}/services/${name}`);
}
async function workloadReady(name) {
  const d = await k8s('GET', `/apis/apps/v1/namespaces/${NS}/deployments/${name}`);
  return d.ok && (d.json.status?.availableReplicas ?? 0) >= 1;
}

// ── 검증 (controller 설치 시점 — 셸 로드 시점과 동일 규칙, 이중 검증 §B.1) ──
async function verifyPlugin(pkg) {
  const name = pkg.metadata.name;
  const svc = `http://${name}.${NS}.svc.cluster.local:8080`;
  // manifest reachable
  const mRes = await fetch(`${svc}/plugins/ui-shell.manifest.json`);
  if (!mRes.ok) return { ok: false, reason: 'ManifestUnreachable' };
  const mText = await mRes.text();
  // ① manifest digest: 계산해서 승인값(CR)과 '비교' (§B.5)
  if (sha256(mText) !== pkg.spec.manifest.sha256) return { ok: false, reason: 'DigestMismatch' };
  const manifest = JSON.parse(mText);
  // ② 서명: trustedKeys[keyId]로 검증 (TrustedKeys CM에서 SPKI 조회)
  const spki = (await loadTrustedKeys())[pkg.spec.trust.keyId];
  if (!spki) return { ok: false, reason: 'UntrustedKey' };
  const sRes = await fetch(`${svc}${'/plugins/' + (pkg.spec.manifest.signaturePath || '/plugins/ui-shell.manifest.json.sig').split('/').pop()}`);
  if (!sRes.ok) return { ok: false, reason: 'SignatureUnreachable' };
  if (!verifyP256(spki, (await sRes.text()).trim(), mText)) return { ok: false, reason: 'SignatureInvalid' };
  // ③ shellCompat / ④ permissions (정적 검사)
  if (manifest.shellCompat !== pkg.spec.shellCompat) return { ok: false, reason: 'ShellCompatDrift' };
  // ⑤ entry digest
  const eRes = await fetch(`${svc}/plugins/${manifest.entry}`);
  if (!eRes.ok) return { ok: false, reason: 'EntryUnreachable' };
  if (sha256(await eRes.text()) !== manifest.entrySha256) return { ok: false, reason: 'EntryDigestMismatch' };
  return { ok: true, manifest };
}

let _trustedKeys = null;
async function loadTrustedKeys() {
  if (_trustedKeys) return _trustedKeys;
  const cm = await k8s('GET', `/api/v1/namespaces/${NS}/configmaps/dupa-trusted-keys`);
  _trustedKeys = cm.ok ? JSON.parse(cm.json.data['trusted-keys.json']).trustedKeys : {};
  return _trustedKeys;
}
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
function verifyP256(spkiB64, sigB64, text) {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' });
    return verify('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}

// ── reconcile: registration desiredState → 실제 상태 ──────────
let runtimeRegistry = { version: 2, trustedKeys: {}, plugins: [] };
async function reconcile() {
  const [pkgs, regs] = await Promise.all([listPackages(), listRegs()]);
  if (!pkgs.ok || !regs.ok) return;
  const pkgByName = Object.fromEntries(pkgs.json.items.map((p) => [p.metadata.name, p]));
  _trustedKeys = null; // 매 reconcile마다 신뢰키 재로드
  const trustedKeys = await loadTrustedKeys();
  const published = [];

  for (const reg of regs.json.items) {
    const name = reg.metadata.name;
    const pkg = pkgByName[reg.spec.packageRef.name];
    const desired = reg.spec.desiredState;
    if (!pkg) { await setStatus(name, { phase: 'Failed', reason: 'PackageNotFound' }); continue; }

    try {
      if (desired === 'Uninstalled') {
        // 워크로드 회수 + registration CR도 삭제 → Installed 탭에서 사라짐(계획서 §10.4).
        // 이력은 audit에 남으므로 정보 손실 없음. (CR을 Removed로 남기면 목록에 잔류해
        // "uninstall이 안 된 것처럼" 보이는 UX 문제가 있었음)
        await deleteWorkload(pkg.metadata.name);
        await k8s('DELETE', `${crd('uipluginregistrations')}/${name}`);
        continue;
      }
      if (desired === 'Disabled') {
        // workload 유지, registry에서만 제외 (메뉴/route 소멸)
        await setStatus(name, { phase: 'Disabled', reason: '' });
        continue;
      }
      // Enabled
      await setStatus(name, { phase: 'Installing', reason: '' });
      await applyWorkload(pkg);
      // ready 대기 (짧게)
      let ready = false;
      for (let i = 0; i < 30 && !ready; i++) { ready = await workloadReady(pkg.metadata.name); if (!ready) await sleep(2000); }
      if (!ready) { await setStatus(name, { phase: 'Failed', reason: 'WorkloadNotReady' }); continue; }

      const v = await verifyPlugin(pkg);
      if (!v.ok) { await setStatus(name, { phase: 'Failed', reason: v.reason }); continue; }

      // 통과 — registry에 '승인값 전사'(§B.5): manifestSha256/keyId는 controller 계산값이 아니라 CR값
      const manifestUrl = `${SHELL_API_PREFIX}/${pkg.metadata.name}/plugins/ui-shell.manifest.json`;
      const sigUrl = `${SHELL_API_PREFIX}/${pkg.metadata.name}/plugins/${(pkg.spec.manifest.signaturePath || 'ui-shell.manifest.json.sig').split('/').pop()}`;
      published.push({
        id: pkg.metadata.name,
        manifest: manifestUrl,
        manifestSha256: pkg.spec.manifest.sha256,
        signature: sigUrl,
        keyId: pkg.spec.trust.keyId,
        // 관리자 지정 1단 아이콘(Carbon 토큰명). 서명 무관 오버라이드(CR spec.nav.icon) — 셸이 토큰→아이콘 매핑.
        icon: pkg.spec.nav?.icon || '',
      });
      await setStatus(name, { phase: 'Enabled', reason: '', manifestUrl });
    } catch (e) {
      await setStatus(name, { phase: 'Failed', reason: String(e).slice(0, 120) });
    }
  }
  runtimeRegistry = { version: 2, trustedKeys, plugins: published };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── K8s Warning 이벤트를 콘솔 알림 소스로 (ADR-UI-002 §D2 — 클러스터 event 평면, OKD 렌즈) ──
// 플랫폼 ns(opensphere-*)의 Warning만 audit bus에 합류. dedup(uid). observability operand 불요(K8s 네이티브).
const seenEvents = new Set();
async function pollK8sEvents() {
  const r = await k8s('GET', '/api/v1/events?fieldSelector=type=Warning&limit=100');
  if (!r.ok) return;
  for (const ev of r.json.items || []) {
    const ns = ev.metadata?.namespace || '';
    if (!ns.startsWith('opensphere')) continue; // 플랫폼 ns만(노이즈 억제)
    const uid = ev.metadata?.uid;
    if (!uid || seenEvents.has(uid)) continue;
    seenEvents.add(uid);
    const o = ev.involvedObject || {};
    logAudit('k8s', ev.reason || 'Event', `${o.kind || '?'}/${o.name || '?'}`, 'warning', (ev.message || '').slice(0, 160));
  }
  if (seenEvents.size > 2000) seenEvents.clear(); // 메모리 가드
}

// ── Control API + registry 서빙 ───────────────────────────────
async function readBody(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString(); return s ? JSON.parse(s) : {};
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

async function ensureRegistration(pkgName, desiredState, actor, reason) {
  const existing = await getReg(pkgName);
  const body = {
    apiVersion: `${GROUP}/${V}`, kind: 'UIPluginRegistration',
    metadata: { name: pkgName, namespace: NS },
    spec: { packageRef: { name: pkgName }, desiredState,
      installPolicy: { createWorkload: true, createProxyRoute: true, exposeInNavigation: true },
      approval: { requestedBy: actor || 'unknown', reason: reason || '' } },
  };
  if (existing.ok) return k8s('PATCH', `${crd('uipluginregistrations')}/${pkgName}`, { spec: { desiredState, approval: body.spec.approval } });
  return k8s('POST', crd('uipluginregistrations'), body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const actor = req.headers['x-opensphere-user'] || 'anonymous';
  try {
    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (p === '/registry/plugins.json') return json(res, 200, runtimeRegistry);

    if (p === '/api/admin/plugins/catalog') {
      const pkgs = await listPackages();
      return json(res, 200, { items: (pkgs.json?.items || []).map((x) => ({ name: x.metadata.name, core: isCorePkg(x), scope: x.metadata.labels?.['opensphere.io/scope'] || null, ...x.spec })) });
    }
    if (p === '/api/admin/plugins/registrations') {
      const regs = await listRegs();
      return json(res, 200, { items: (regs.json?.items || []).map((x) => ({ name: x.metadata.name, desiredState: x.spec.desiredState, status: x.status || {}, approval: x.spec.approval })) });
    }
    if (p === '/api/admin/plugins/events') return json(res, 200, { items: audit });

    // ── Bindings (headless 비-UI 확장): CLIDownload 등. UI plugins와 분리된 관리 채널(binding≠plugin) ──
    if (p === '/api/admin/bindings') {
      const cds = await listCliDownloads();
      const items = (cds.json?.items || []).map((x) => ({ kind: 'CLIDownload', name: x.metadata.name, ...x.spec, enabled: x.spec.enabled !== false }));
      return json(res, 200, { items });
    }
    // binding enable/disable = spec.enabled 소프트 토글(선언·서빙 유지, 콘솔 노출만). plugin Disable과 동형.
    const bm = p.match(/^\/api\/admin\/bindings\/([a-z0-9-]+)\/(enable|disable)$/);
    if (bm && req.method === 'POST') {
      const [, name, action] = bm;
      const r = await k8s('PATCH', `/apis/${CONSOLE_GROUP}/${V}/clidownloads/${name}`, { spec: { enabled: action === 'enable' } });
      if (!r.ok) { logAudit(actor, action, 'binding/' + name, 'error', `HTTP ${r.status}`); return json(res, r.status, { error: r.json }); }
      logAudit(actor, action, 'binding/' + name, 'accepted', '');
      return json(res, 202, { accepted: true, name, enabled: action === 'enable' });
    }

    // ── P1 발행 백본(ADR-UI-003/UI-002 §D3): subShell 백엔드 → 콘솔 알림 소스(audit bus) 발행.
    // 콘솔 알림 NotificationService가 /api/admin/plugins/events 폴링으로 수집. source는 attribution.
    // ⚠️ 인증은 컨트롤 API 전체와 동급(X-OpenSphere-* 헤더) — 강화(SA TokenReview/NetworkPolicy)는 후속.
    if (p === '/api/admin/events' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const source = b.source || req.headers['x-opensphere-source'] || actor;
      logAudit(source, b.action || 'event', b.target || b.title || '', b.result || b.severity || 'info', b.reason || b.detail || '');
      return json(res, 202, { accepted: true, source });
    }

    const m = p.match(/^\/api\/admin\/plugins\/registrations\/([a-z0-9-]+)\/(install|enable|disable|uninstall)$/);
    if (m && req.method === 'POST') {
      const [, id, action] = m;
      // §3.1 강제: shell-pinned core 표면은 제거/비활성 불가(보안 경계 — UI 억제보다 본질).
      if (action === 'disable' || action === 'uninstall') {
        const pkgC = await k8s('GET', `${crd('uipluginpackages')}/${id}`);
        if (pkgC.ok && isCorePkg(pkgC.json)) {
          logAudit(actor, action, id, 'denied', 'core surface(shell-pinned) 제거/비활성 불가 (ADR-UI-003 §3.1)');
          return json(res, 409, { error: 'core surface — not removable', core: true });
        }
      }
      const body = await readBody(req).catch(() => ({}));
      const desired = action === 'install' || action === 'enable' ? 'Enabled' : action === 'disable' ? 'Disabled' : 'Uninstalled';
      const r = await ensureRegistration(id, desired, actor, body.reason);
      if (!r.ok) { logAudit(actor, action, id, 'error', `HTTP ${r.status}`); return json(res, r.status, { error: r.json }); }
      logAudit(actor, action, id, 'accepted', '');
      reconcile().catch((e) => console.error('reconcile error', e)); // 비동기 조정
      return json(res, 202, { accepted: true, id, desiredState: desired });
    }

    // 1단 아이콘 지정 — UIPluginPackage spec.nav.icon 패치(서명 무관 오버라이드). 패치 후 reconcile로 registry 즉시 반영.
    const im = p.match(/^\/api\/admin\/plugins\/packages\/([a-z0-9-]+)\/icon$/);
    if (im && req.method === 'POST') {
      const [, id] = im;
      const body = await readBody(req).catch(() => ({}));
      const icon = String(body.icon || '').slice(0, 64);
      const r = await k8s('PATCH', `${crd('uipluginpackages')}/${id}`, { spec: { nav: { icon } } });
      if (!r.ok) { logAudit(actor, 'set-icon', id, 'error', `HTTP ${r.status}`); return json(res, r.status, { error: r.json }); }
      logAudit(actor, 'set-icon', id, 'accepted', icon);
      reconcile().catch((e) => console.error('reconcile error', e));
      return json(res, 202, { accepted: true, id, icon });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`dupa-registry-controller listening :${PORT} (ns=${NS})`);
  const loop = () => Promise.all([reconcile(), pollK8sEvents()]).catch((e) => console.error('loop error', e)).finally(() => setTimeout(loop, 15000));
  loop();
});
