'use strict';

const fs = require('node:fs');
const https = require('node:https');

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

function apiError(status, body) { const error = new Error(`Kubernetes API returned ${status}`); error.status = status; error.body = body; return error; }

function createKubernetesClient({
  host = process.env.KUBERNETES_SERVICE_HOST, port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || '443',
  token = fs.readFileSync(`${SA}/token`, 'utf8').trim(), ca = fs.readFileSync(`${SA}/ca.crt`), request = https.request,
} = {}) {
  if (!host || !token) throw new Error('reconciler Kubernetes service account is unavailable');
  async function call(method, path, body) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = request({ host, port, method, path, ca, rejectUnauthorized: true, servername: 'kubernetes.default.svc',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, (res) => {
        const chunks = []; let length = 0;
        res.on('data', (chunk) => { length += chunk.length; if (length <= 1024 * 1024) chunks.push(chunk); });
        res.on('end', () => {
          if (length > 1024 * 1024) return reject(new Error('Kubernetes API response too large'));
          let value = {}; try { value = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch { return reject(new Error('Kubernetes API returned invalid JSON')); }
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(apiError(res.statusCode, value));
          resolve(value);
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('Kubernetes API timeout'))); req.on('error', reject);
      if (payload) req.end(payload); else req.end();
    });
  }
  return Object.freeze({
    tokenReview: (bootstrap) => call('POST', '/apis/authentication.k8s.io/v1/tokenreviews', { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenReview', spec: { token: bootstrap, audiences: ['opensphere-shell-runtime-bootstrap'] } }),
    listPods: (namespace, limit = 1) => call('GET', `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?limit=${Math.max(1, Math.min(10, Number(limit) || 1))}`),
    getPod: (namespace, name) => call('GET', `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`),
    createPod: (namespace, pod) => call('POST', `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`, pod),
    deletePod: async (namespace, name, uid) => {
      try { return await call('DELETE', `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`, { apiVersion: 'v1', kind: 'DeleteOptions', gracePeriodSeconds: 0, preconditions: { uid } }); }
      catch (error) { if (error.status === 404) return null; throw error; }
    },
  });
}

function validatedRuntimeIdentity(review, { namespace, serviceAccount }) {
  const status = review?.status;
  const user = status?.user;
  const expected = `system:serviceaccount:${namespace}:${serviceAccount}`;
  const audiences = Array.isArray(status?.audiences) ? status.audiences : [];
  const extra = user?.extra || {};
  const podNames = extra['authentication.kubernetes.io/pod-name'];
  const podUids = extra['authentication.kubernetes.io/pod-uid'];
  if (status?.authenticated !== true || user?.username !== expected
      || audiences.length !== 1 || audiences[0] !== 'opensphere-shell-runtime-bootstrap'
      || !Array.isArray(podNames) || podNames.length !== 1 || !Array.isArray(podUids) || podUids.length !== 1) {
    throw Object.assign(new Error('projected runtime identity rejected'), { status: 401 });
  }
  return Object.freeze({ podName: podNames[0], podUid: podUids[0], username: user.username });
}

module.exports = { createKubernetesClient, validatedRuntimeIdentity };
