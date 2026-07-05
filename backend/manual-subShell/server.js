const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PLUGINS = process.env.PLUGINS_DIR || '/app/plugins';

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.sig': 'text/plain; charset=utf-8',
};

function serveFrom(root, rel, res) {
  const normalized = path.normalize('/' + rel).replace(/^(\.\.[/\\])+/, '');
  const fp = path.join(root, normalized);
  if (!fp.startsWith(root)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(fp)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(fp).pipe(res);
  });
}

http.createServer((req, res) => {
  const p = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (p === '/healthz') {
    res.writeHead(200);
    return res.end('ok');
  }
  if (p === '/plugins' || p === '/plugins/') {
    const files = fs.existsSync(PLUGINS) ? fs.readdirSync(PLUGINS).filter((f) => !f.startsWith('.')) : [];
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ plugins: files }));
  }
  if (p.startsWith('/plugins/')) return serveFrom(PLUGINS, p.slice('/plugins/'.length), res);
  res.writeHead(404);
  res.end('not found');
}).listen(PORT, () => {
  console.log(`manual subShell on :${PORT}`);
});
