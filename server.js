// ============================================================
// Local dev server for CS Roster (Node.js built-ins + libsql)
// Run: node server.js   -> http://localhost:3000
// ============================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

const core = require('./lib/core');

async function start() {
  await core.connect();
  await core.initSchema();
  await core.seedIfEmpty();
  await core.seedIfEmpty();

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.webp': 'image/webp'
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // API
    if (p === '/api' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 25 * 1024 * 1024) req.destroy(); });
      req.on('end', async () => {
        let params;
        try { params = JSON.parse(body || '{}'); } catch { return sendJson(res, { success: false, error: 'Invalid JSON body' }, 400); }
        try { const result = await core.routeAction(params.action || '', params); sendJson(res, result); }
        catch (err) { console.error('[api error]', err); sendJson(res, { success: false, error: String(err && err.message || err) }, 500); }
      });
      return;
    }

    // Photos (served from DB)
    if (p.startsWith('/photos/')) {
      const match = /^emp_(\d+)\.jpg$/.exec(path.basename(p));
      if (!match) { res.writeHead(404); res.end('Not found'); return; }
      const photo = await core.readPhoto(match[1]);
      if (!photo) { res.writeHead(404); res.end('Not found'); return; }
      const buf = Buffer.from(photo.data, 'base64');
      res.writeHead(200, { 'Content-Type': photo.mime || 'image/jpeg' });
      res.end(buf);
      return;
    }

    // Static
    let filePath = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC_DIR, 'index.html');
    fs.readFile(filePath, (err, content) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
      res.end(content);
    });
  });

  function sendJson(res, obj, status) {
    res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  server.listen(PORT, () => {
    console.log('CS Roster server running:');
    console.log('  http://localhost:' + PORT);
    console.log('  API: http://localhost:' + PORT + '/api');
  });
}

start().catch(err => { console.error('Fatal startup error:', err); process.exit(1); });
