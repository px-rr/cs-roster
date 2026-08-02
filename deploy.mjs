import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = process.env.VERCEL_TOKEN || '';
const ROOT = __dirname;

const deployFiles = [
  'vercel.json',
  'package.json',
  'package-lock.json',
  'api/index.js',
  'api/photos/[name].js',
  'lib/core.js',
  'lib/seed-data.js',
  'public/index.html',
];

function apiRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.vercel.com',
      path: urlPath,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const files = [];
  for (const f of deployFiles) {
    const fullPath = path.join(ROOT, f);
    const data = fs.readFileSync(fullPath);
    const b64 = data.toString('base64');
    files.push({
      file: f,
      data: b64,
      encoding: 'base64',
    });
    console.log(`  ${f}: ${data.length} bytes`);
  }

  console.log(`\nDeploying ${files.length} files...`);
  const deployment = await apiRequest('POST', '/v13/deployments', {
    name: 'cs-roster',
    files,
    projectSettings: {
      framework: null,
      installCommand: 'npm install',
      outputDirectory: 'public',
    },
    target: 'production',
  });
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
